require('dotenv').config();
const { Queue } = require('bullmq');

const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

const taskQueue = new Queue('task-categorization-queue', { connection: redisOptions });
const feedbackQueue = new Queue('feedback-queue', { connection: redisOptions });

(async () => {
  console.log('Kuyruklar temizleniyor (Obliterate)... Lütfen bekleyin...');
  
  try {
    await taskQueue.obliterate({ force: true });
    console.log('✅ task-categorization-queue tamamen temizlendi.');
  } catch (e) {
    console.log('task-categorization-queue temizlenirken hata (veya zaten boş):', e.message);
  }

  try {
    await feedbackQueue.obliterate({ force: true });
    console.log('✅ feedback-queue tamamen temizlendi.');
  } catch (e) {
    console.log('feedback-queue temizlenirken hata (veya zaten boş):', e.message);
  }

  console.log('Tüm kuyruklar sıfırlandı. Şimdi uygulamayı temiz bir şekilde başlatabilirsiniz.');
  process.exit(0);
})();
