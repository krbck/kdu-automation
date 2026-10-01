require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { Queue, Worker } = require('bullmq');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

// 1. Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// 2. Initialize Firebase Admin
// Make sure to download your service account JSON and set its path in .env
try {
  const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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
  const db = admin.database();
  
  try {
    // Step 1. Fetch cached clients
    const clientsSnapshot = await db.ref('clients').once('value');
    const clientsData = clientsSnapshot.val() || {};
    
    // Format clients for the prompt
    const clientsList = Object.keys(clientsData).map(id => {
      return { id, name: clientsData[id].name };
    });

    // Step 2. Call DeepSeek API with prompt + clients
    const systemPrompt = `You are an AI assistant for a task management system. Your job is to categorize a user task and match it to a specific client from our database.
    Here is the list of existing clients (JSON array):
    ${JSON.stringify(clientsList)}
    
    Task Title: "${title}"
    Task Description: "${body}"
    
    Respond ONLY with a valid JSON object (no markdown, no extra text) with the following structure:
    {
      "category": "String (e.g. Hardware, Delivery, Support, Software, Sales)",
      "urgency": "String (Low, Medium, High)",
      "matchedClientId": "String (The exact 'id' from the clients list that best matches the task text. If none match, use null)",
      "standardisedTitle": "String (A clean, professional title for the task)",
      "summary": "String (A short 1-sentence summary of the task)"
    }`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
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

    // Step 3. Update Firebase RTDB with new category and clientId
    await db.ref(\`tasks/${taskId}\`).update({
      category: structuredData.category || 'Uncategorized',
      urgency: structuredData.urgency || 'Medium',
      clientId: structuredData.matchedClientId || null,
      standardisedTitle: structuredData.standardisedTitle || title,
      summary: structuredData.summary || '',
      processed: true
    });

    console.log(\`Successfully processed and updated task ${taskId}\`);
    return { status: 'success', structuredData };
  } catch (error) {
    console.error(\`Error processing job ${job.id}:\`, error);
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
  if (!admin.apps.length) return;
  const db = admin.database();
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

// Start the Express Server
app.listen(port, () => {
  console.log(`KDU Automation App running on port ${port}`);
  console.log(`BullMQ Dashboard available at: http://localhost:${port}/admin/queues`);
});
