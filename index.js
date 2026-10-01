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

// 2. Initialize Firebase Admin
// Make sure to download your service account JSON and set its path in .env
try {
  const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('Firebase Admin initialized.');
} catch (error) {
  console.error('Failed to initialize Firebase Admin. Check serviceAccountKey.json path and .env variables.', error.message);
}

// 3. Initialize BullMQ and Redis Connection
const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  // password: process.env.REDIS_PASSWORD || '',
};

// Create the Job Queue
const taskQueue = new Queue('task-categorization-queue', { connection: redisOptions });

// Create the Worker (This processes the jobs)
const worker = new Worker('task-categorization-queue', async (job) => {
  console.log(`Processing job ${job.id} for task: ${job.data.taskId}`);

  const { taskId, title, body } = job.data;
  const db = getDatabase();

  try {
    // Step 1. Fetch cached clients and memories
    const [clientsSnapshot, memoriesSnapshot] = await Promise.all([
      db.ref('clients').once('value'),
      db.ref('memories').once('value')
    ]);

    const clientsData = clientsSnapshot.val() || {};
    const memoriesData = memoriesSnapshot.val() || {};

    // Format clients for the prompt
    const clientsList = Object.keys(clientsData).map(id => {
      return { id, name: clientsData[id].name };
    });
    const memoriesList = Object.values(memoriesData);

    // Step 2. Call DeepSeek API with prompt + clients + memories
    const systemPrompt = `Bir görev yönetim sistemi için yapay zeka asistanısın. Görevin, kullanıcının girdiği görevi kategorize etmek ve veritabanımızdaki doğru müşteriyle eşleştirmektir. Uygulama dili Türkçedir, bu yüzden tüm metinleri Türkçe üretmelisin.
    
    ÖNEMLİ KURALLAR (Geçmiş Düzeltmeler / Memories):
    ${JSON.stringify(memoriesList)}
    
    Mevcut müşteri listesi (JSON array):
    ${JSON.stringify(clientsList)}
    
    Görev Başlığı: "${title}"
    Görev Açıklaması: "${body}"
    
    Lütfen SADECE aşağıdaki yapıda geçerli bir JSON objesi döndür (markdown veya ek metin olmasın):
    {
      "category": "String (Örn. Donanım, Teslimat, Destek, Yazılım, Satış vb.)",
      "urgency": "String (Düşük, Orta, Yüksek)",
      "matchedClientId": "String (Görev metniyle eşleşen en uygun müşterinin 'id' değeri. Eşleşme yoksa null kullanın)",
      "clientName": "String (Eğer eşleştiyse müşterinin adı, eşleşmediyse görev metninden çıkardığın yeni müşteri adı)",
      "standardisedTitle": "String (Görev için temiz, profesyonel bir Türkçe başlık)",
      "summary": "String (Görevin 1 cümlelik Türkçe özeti)"
    }`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [{ role: 'system', content: systemPrompt }],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.statusText}`);
    }

    const aiData = await response.json();
    const aiContent = aiData.choices[0].message.content;

    // Parse the JSON (handle possible markdown formatting returned by AI)
    const cleanJsonStr = aiContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const structuredData = JSON.parse(cleanJsonStr);

    // Step 3. Update Firebase RTDB with new category, client info, and assign task to client
    let clientId = structuredData.matchedClientId;
    let clientName = structuredData.clientName;

    // If no client matched, create a new one dynamically
    if (!clientId || clientId === 'null' || clientId === '') {
      const newClientRef = db.ref('clients').push();
      clientId = newClientRef.key;
      if (!clientName) clientName = 'Bilinmeyen Müşteri';
      await newClientRef.set({ name: clientName, createdAt: Date.now() });
      console.log(`Created new client: ${clientName} (${clientId})`);
    }

    // Update the original task
    await db.ref(`tasks/${taskId}`).update({
      category: structuredData.category || 'Kategorisiz',
      urgency: structuredData.urgency || 'Orta',
      clientId: clientId,
      clientName: clientName,
      standardisedTitle: structuredData.standardisedTitle || title,
      summary: structuredData.summary || '',
      processed: true
    });

    // Track task under the specific client's node (Client Task History)
    await db.ref(`clients/${clientId}/tasks/${taskId}`).set({
      timestamp: Date.now(),
      title: structuredData.standardisedTitle || title,
      category: structuredData.category || 'Kategorisiz'
    });

    console.log(`Successfully processed and updated task ${taskId}`);
    return { status: 'success', structuredData };
  } catch (error) {
    console.error(`Error processing job ${job.id}:`, error);
    throw error; // Throwing error tells BullMQ to retry the job
  }
}, {
  connection: redisOptions,
  concurrency: 2 // Process maximum 2 tasks concurrently to avoid hitting rate limits
});

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error:`, err);
});

// 4. Setup Bull Board (Dashboard UI for BullMQ)
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
  queues: [new BullMQAdapter(taskQueue)],
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

    // Check if task is already processed to avoid infinite loops
    if (task && !task.processed) {
      console.log(`New unprocessed task detected: ${taskId}`);

      // Enqueue the task safely
      await taskQueue.add('categorize-task', {
        taskId,
        title: task.title,
        body: task.body
      }, {
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
    const [tasksSnap, clientsSnap, memSnap] = await Promise.all([
      db.ref('tasks').orderByChild('processed').equalTo(true).limitToLast(100).once('value'),
      db.ref('clients').once('value'),
      db.ref('memories').once('value')
    ]);
    
    const tasks = tasksSnap.val() || {};
    const clients = clientsSnap.val() || {};
    const memories = memSnap.val() || {};
    
    // Sort tasks newest first
    const tasksArray = Object.keys(tasks).map(k => ({ id: k, ...tasks[k] })).reverse();
    const memoriesArray = Object.keys(memories).map(k => ({ id: k, ...memories[k] }));
    
    res.render('dashboard', { tasks: tasksArray, clients, memories: memoriesArray });
  } catch(e) {
    res.send('Error loading dashboard: ' + e.message);
  }
});

// Start the Express Server
app.listen(port, () => {
  console.log(`KDU Automation App running on port ${port}`);
  console.log(`BullMQ Dashboard available at: http://localhost:${port}/admin/queues`);
  console.log(`Admin Dashboard available at: http://localhost:${port}/dashboard`);
});
