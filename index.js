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
  
  // TODO: Step 1. Fetch cached clients
  // TODO: Step 2. Call DeepSeek API with prompt + clients
  // TODO: Step 3. Update Firebase RTDB with new category and clientId
  
  // Simulated processing delay
  await new Promise((resolve) => setTimeout(resolve, 2000));
  
  console.log(`Finished processing job ${job.id}`);
  return { status: 'success', matchedClient: 'example_client' };
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
