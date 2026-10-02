const environment = process.env.NODE_ENV || 'development';
const envFile = environment === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: envFile });
const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { Queue, Worker } = require('bullmq');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

// 1. Initialize Express
const app = express();
const port = process.env.PORT || 3000;
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

// 2. Initialize Firebase Admin
// Make sure to download your service account JSON and set its path in .env
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');
  }
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('Firebase Admin initialized.');
} catch (error) {
  console.error('Failed to initialize Firebase Admin. Check serviceAccountKey.json path and .env variables.', error.message);
}

// Initialize in-memory cache for frequently accessed collections to save bandwidth
let cachedClients = {};
let cachedMemories = {};

const initCache = () => {
  if (!getApps().length) return;
  const db = getDatabase();
  console.log('Starting in-memory cache sync for clients and memories...');
  
  db.ref('clients').on('value', (snap) => {
    cachedClients = snap.val() || {};
  });
  
  db.ref('memories').on('value', (snap) => {
    cachedMemories = snap.val() || {};
  });
};

initCache();

// 3. Initialize BullMQ and Redis Connection
const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  // password: process.env.REDIS_PASSWORD || '',
};

// Create the Job Queue
const taskQueue = new Queue('task-categorization-queue', { connection: redisOptions });
const feedbackQueue = new Queue('feedback-queue', { connection: redisOptions });

// Create the Worker Logic
const processJob = async (job) => {
  console.log(`Processing job ${job.id} for task: ${job.data.taskId}`);

  const { taskId, title, body, userFeedback } = job.data;
  const db = getDatabase();

  try {
    // Step 1. Use cached clients and memories instead of fetching from RTDB on every job
    const clientsData = cachedClients;
    const memoriesData = cachedMemories;

    const clientsList = Object.keys(clientsData).map(id => ({ 
      id, 
      name: clientsData[id].name,
      aliases: clientsData[id].aliases || []
    }));
    const memoriesList = Object.values(memoriesData);

    // Step 2. Call DeepSeek API with prompt
    let systemPrompt = `Bir görev yönetim sistemi için yapay zeka asistanısın. Görevin, kullanıcının girdiği görevi kategorize etmek ve veritabanımızdaki doğru müşteriyle eşleştirmektir. Uygulama dili Türkçedir.`;

    if (userFeedback) {
      systemPrompt += `\n\nDİKKAT! Kullanıcı senin bir önceki kararını beğenmedi ve şu geri bildirimi verdi: "${userFeedback}". 
      Lütfen bu geri bildirimi dikkate alarak görevi YENİDEN değerlendir. 
      Ek olarak, gelecekte benzer bir hatayı tekrar etmemek için kendine bir kural çıkar ve bunu 'learnedRule' alanında (tek cümleyle) belirt.`;
    }

    systemPrompt += `
    ÖNEMLİ KURALLAR (Geçmiş Düzeltmeler / Memories):
    ${JSON.stringify(memoriesList)}
    
    Mevcut müşteri listesi (JSON array):
    ${JSON.stringify(clientsList)}
    
    EŞ ANLAMLI (ALIAS) MANTIĞI:
    Müşteri listesindeki "aliases" (diğer isimler) dizisine dikkat et. Eğer görevdeki firma adı, bir müşterinin "aliases" listesinde varsa, KESİNLİKLE yeni kayıt oluşturma. "matchedClientId" olarak o müşterinin ID'sini kullan.
    
    ŞUBE (BRANCH) MANTIĞI:
    Eğer görevdeki müşteri, mevcut müşteri listesinde var olan bir ana firmanın farklı bir şubesiyse (Örn: Ana firma "K.KAYA", gelen firma "K.KAYA ATAŞEHİR"), yeni bir kayıt oluşturmalısın (matchedClientId: null). Ancak, bu yeni şubenin ana firmaya bağlı olduğunu belirtmek için ana firmanın ID'sini "parentId" olarak döndürmelisin. Tamamen yeni ve bağımsız bir firmaysa "parentId": null olmalıdır.
    
    Görev Başlığı: "${title}"
    Görev Açıklaması: "${body}"
    
    Lütfen SADECE aşağıdaki yapıda geçerli bir JSON objesi döndür:
    {
      "category": "String (Örn. Donanım, Teslimat, Destek, Yazılım, Satış vb.)",
      "urgency": "String (Düşük, Orta, Yüksek)",
      "matchedClientId": "String (Eşleşme yoksa null)",
      "clientName": "String (Eşleştiyse adı, yoksa yeni isim)",
      "parentId": "String (Eğer yeni bir şubeyse ana firmanın ID'si, yoksa null)",
      "standardisedTitle": "String",
      "summary": "String"
      ${userFeedback ? ',"learnedRule": "String (Bu hatadan öğrendiğin kural)"' : ''}
    }`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: systemPrompt }],
        temperature: 0.1
      })
    });

    if (!response.ok) throw new Error(`DeepSeek API error: ${response.statusText}`);

    const aiData = await response.json();
    const aiContent = aiData.choices[0].message.content;
    const cleanJsonStr = aiContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const structuredData = JSON.parse(cleanJsonStr);

    // Step 3. Update Firebase RTDB
    let clientId = structuredData.matchedClientId;
    let clientName = structuredData.clientName;

    // AI'ın döndürdüğü clientId gerçekten veritabanımızda var mı kontrol et (Halüsinasyon koruması)
    if (clientId && clientId !== 'null' && clientId !== '') {
      if (!clientsData[clientId]) {
        console.log(`Uyarı: Yapay zeka olmayan bir clientId döndürdü (${clientId}). Yeni müşteri oluşturulacak.`);
        clientId = null; // Yoksa null yap ki aşağıda yeni kayıt oluşsun
      }
    }

    if (!clientId || clientId === 'null' || clientId === '') {
      const newClientRef = db.ref('clients').push();
      clientId = newClientRef.key;
      if (!clientName) clientName = 'Bilinmeyen Müşteri';
      
      const newClientData = { name: clientName, createdAt: Date.now() };
      
      if (structuredData.parentId && structuredData.parentId !== 'null' && structuredData.parentId !== '') {
        // AI halüsinasyon koruması: parentId gerçekten mevcut mu?
        if (clientsData[structuredData.parentId]) {
          newClientData.parentId = structuredData.parentId;
        } else {
          console.log(`Uyarı: Yapay zeka olmayan bir parentId döndürdü (${structuredData.parentId}). parentId eklenmeyecek.`);
        }
      }
      
      await newClientRef.set(newClientData);
    }

    if (userFeedback) {
      // It's a re-process, send to awaiting approval
      await db.ref(`tasks/${taskId}`).update({
        category: structuredData.category || 'Kategorisiz',
        urgency: structuredData.urgency || 'Orta',
        clientId: clientId,
        clientName: clientName,
        standardisedTitle: structuredData.standardisedTitle || title,
        summary: structuredData.summary || '',
        learnedRule: structuredData.learnedRule || '',
        status: 'awaiting_approval'
      });
      console.log(`Task ${taskId} re-processed and awaiting approval!`);
    } else {
      // Normal process
      await db.ref(`tasks/${taskId}`).update({
        category: structuredData.category || 'Kategorisiz',
        urgency: structuredData.urgency || 'Orta',
        clientId: clientId,
        clientName: clientName,
        standardisedTitle: structuredData.standardisedTitle || title,
        summary: structuredData.summary || '',
        processed: true,
        status: null
      });

      await db.ref(`clients/${clientId}/tasks/${taskId}`).set({
        timestamp: Date.now(),
        title: structuredData.standardisedTitle || title,
        category: structuredData.category || 'Kategorisiz'
      });
      console.log(`Successfully processed task ${taskId}`);
    }
    return { status: 'success', structuredData };
  } catch (error) {
    console.error(`Error processing job ${job.id}:`, error);
    throw error; // Throwing error tells BullMQ to retry the job
  }
};

const worker = new Worker('task-categorization-queue', processJob, {
  connection: redisOptions,
  concurrency: 2
});

const feedbackWorker = new Worker('feedback-queue', processJob, {
  connection: redisOptions,
  concurrency: 2
});

[worker, feedbackWorker].forEach(w => {
  w.on('completed', (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });
  w.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed with error:`, err);
  });
});

// 4. Setup Bull Board (Dashboard UI for BullMQ)
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
  queues: [new BullMQAdapter(taskQueue), new BullMQAdapter(feedbackQueue)],
  serverAdapter: serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

// 5. Firebase Listener (Event-driven scraping)
const setupFirebaseListener = () => {
  if (!getApps().length) return;
  const db = getDatabase();
  const tasksRef = db.ref('tasks');

  console.log('Starting Firebase RTDB listener for new tasks...');

  // Example: Listening for newly added tasks
  // To avoid fetching all historical data at once initially, we can filter by time
  // OR just process them but rely on BullMQ to queue them safely.
  tasksRef.on('child_added', async (snapshot) => {
    const task = snapshot.val();
    const taskId = snapshot.key;

    // Check if task is already processed, archived, or awaiting approval to avoid infinite loops
    if (task && !task.processed && task.status !== 'archived' && task.status !== 'awaiting_approval') {
      console.log(`New unprocessed task detected: ${taskId}`);

      // Enqueue the task safely, using jobId to prevent duplicates!
      await taskQueue.add('categorize-task', {
        taskId,
        title: task.title,
        body: task.body
      }, {
        jobId: taskId, // This is crucial: it prevents the same task from being queued multiple times
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });
    }
  });
};

setupFirebaseListener();

// 6. Web Dashboard Route
app.get('/dashboard', async (req, res) => {
  if (!getApps().length) return res.send('Firebase not initialized');
  const db = getDatabase();

  try {
    const [tasksSnap, awaitingSnap] = await Promise.all([
      db.ref('tasks').orderByChild('processed').equalTo(true).limitToLast(100).once('value'),
      db.ref('tasks').orderByChild('status').equalTo('awaiting_approval').once('value')
    ]);

    const tasks = tasksSnap.val() || {};
    const awaitingTasks = awaitingSnap.val() || {};
    const clients = cachedClients;
    const memories = cachedMemories;

    const tasksArray = Object.keys(tasks).map(k => ({ id: k, ...tasks[k] })).reverse();
    const awaitingArray = Object.keys(awaitingTasks).map(k => ({ id: k, ...awaitingTasks[k] })).reverse();
    const memoriesArray = Object.keys(memories).map(k => ({ id: k, ...memories[k] }));

    res.render('dashboard', { tasks: tasksArray, awaitingTasks: awaitingArray, clients, memories: memoriesArray });
  } catch (e) {
    res.send('Error loading dashboard: ' + e.message);
  }
});

// 7. Handle Feedback (Send back to AI)
app.post('/dashboard/feedback', async (req, res) => {
  const { taskId, userFeedback, originalTitle, originalBody, expectedCategory, expectedUrgency } = req.body;
  if (!taskId || !userFeedback) return res.redirect('/dashboard');

  try {
    const db = getDatabase();

    const combinedFeedback = `Kullanıcı Notu: ${userFeedback}\nBeklenen Kategori: ${expectedCategory}\nBeklenen Aciliyet: ${expectedUrgency}`;

    // Send feedback directly to the independent feedback queue
    await feedbackQueue.add('categorize-task', {
      taskId, title: originalTitle, body: originalBody, userFeedback: combinedFeedback
    }, { attempts: 1 });

    // Mark as reprocessing so UI updates
    await db.ref(`tasks/${taskId}`).update({ status: 'reprocessing', processed: null });
  } catch (error) { console.error('Feedback error:', error); }

  res.redirect('/dashboard');
});

// 8. Handle Approval (User approves AI's learned rule)
app.post('/dashboard/approve', async (req, res) => {
  const { taskId, rule, category, clientId } = req.body;
  try {
    const db = getDatabase();

    if (rule && rule.trim() !== '') {
      await db.ref('memories').push({ rule, correctedCategory: category, createdAt: Date.now(), createdBy: 'Admin' });
    }

    await db.ref(`tasks/${taskId}`).update({ status: null, processed: true, learnedRule: null });

    if (clientId) {
      const taskSnap = await db.ref(`tasks/${taskId}`).once('value');
      const task = taskSnap.val();
      if (task) {
        await db.ref(`clients/${clientId}/tasks/${taskId}`).set({ timestamp: Date.now(), title: task.standardisedTitle || task.title, category: task.category });
      }
    }
  } catch (error) { console.error('Approval error:', error); }

  res.redirect('/dashboard');
});

// 8b. Handle Reject (User rejects AI's learned rule)
app.post('/dashboard/reject', async (req, res) => {
  const { taskId, clientId } = req.body;
  try {
    const db = getDatabase();
    
    // Just mark as processed without saving the rule to memories
    await db.ref(`tasks/${taskId}`).update({ status: null, processed: true, learnedRule: null });
    
    // Still ensure it goes to client's history
    if (clientId) {
      const taskSnap = await db.ref(`tasks/${taskId}`).once('value');
      const task = taskSnap.val();
      if (task) {
        await db.ref(`clients/${clientId}/tasks/${taskId}`).set({
          timestamp: Date.now(),
          title: task.standardisedTitle || task.title,
          category: task.category || 'Kategorisiz'
        });
      }
    }
  } catch (error) { console.error('Reject error:', error); }
  
  res.redirect('/dashboard');
});

// 9. Delete Memory
app.post('/dashboard/memory/delete', async (req, res) => {
  const { memoryId } = req.body;
  if (memoryId) await getDatabase().ref(`memories/${memoryId}`).remove();
  res.redirect('/dashboard');
});

// 9b. Edit Memory
app.post('/dashboard/memory/edit', async (req, res) => {
  const { memoryId, rule, category } = req.body;
  if (memoryId && rule) {
    await getDatabase().ref(`memories/${memoryId}`).update({
      rule,
      correctedCategory: category,
      updatedAt: Date.now()
    });
  }
  res.redirect('/dashboard');
});

// 10. Archive Task (Hide from processed list)
app.post('/dashboard/task/archive', async (req, res) => {
  const { taskId } = req.body;
  if (taskId) {
    await getDatabase().ref(`tasks/${taskId}`).update({ processed: null, status: 'archived' });
  }
  res.redirect('/dashboard');
});

// 11. Add Alias to Client
app.post('/dashboard/client/alias', async (req, res) => {
  const { clientId, aliasName } = req.body;
  if (clientId && aliasName) {
    try {
      const db = getDatabase();
      const clientRef = db.ref(`clients/${clientId}`);
      const snap = await clientRef.once('value');
      const clientData = snap.val();
      if (clientData) {
        const currentAliases = clientData.aliases || [];
        if (!currentAliases.includes(aliasName.trim())) {
          currentAliases.push(aliasName.trim());
          await clientRef.update({ aliases: currentAliases });
        }
      }
    } catch (err) { console.error('Alias ekleme hatası:', err); }
  }
  res.redirect('/dashboard');
});

// 12. Delete Alias from Client
app.post('/dashboard/client/alias/delete', async (req, res) => {
  const { clientId, aliasName } = req.body;
  if (clientId && aliasName) {
    try {
      const db = getDatabase();
      const clientRef = db.ref(`clients/${clientId}`);
      const snap = await clientRef.once('value');
      const clientData = snap.val();
      if (clientData && clientData.aliases) {
        const currentAliases = clientData.aliases;
        const index = currentAliases.indexOf(aliasName);
        if (index > -1) {
          currentAliases.splice(index, 1);
          await clientRef.update({ aliases: currentAliases });
        }
      }
    } catch (err) { console.error('Alias silme hatası:', err); }
  }
  res.redirect('/dashboard');
});

// Start the Express Server
app.listen(port, () => {
  console.log(`KDU Automation App running on port ${port}`);
  console.log(`BullMQ Dashboard available at: http://localhost:${port}/admin/queues`);
  console.log(`Admin Dashboard available at: http://localhost:${port}/dashboard`);
});
