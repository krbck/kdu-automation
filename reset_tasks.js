require('dotenv').config();
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = getDatabase();

(async () => {
  console.log('Firebase bağlanıyor ve tüm görevler sıfırlanıyor...');
  try {
    const snap = await db.ref('tasks').once('value');
    const tasks = snap.val();
    
    if (!tasks) {
      console.log('Hiç görev bulunamadı.');
      process.exit(0);
    }

    const updates = {};
    let count = 0;
    
    for (const taskId in tasks) {
      if (tasks[taskId].processed || tasks[taskId].status) {
        updates[`${taskId}/processed`] = null; // İşlendi bayrağını kaldır
        updates[`${taskId}/status`] = null;    // Bekleme veya arşiv durumunu kaldır
        updates[`${taskId}/learnedRule`] = null; // AI kuralını sıfırla
        count++;
      }
    }
    
    if (count > 0) {
      await db.ref('tasks').update(updates);
      console.log(`Başarılı! Toplam ${count} görevin durumu sıfırlandı. Memory (Kurallar) KORUNDU.`);
    } else {
      console.log('Zaten hepsi sıfırlanmış durumda.');
    }
    
    console.log('Şimdi "node index.js" komutunu çalıştırırsanız hepsi baştan yeni kurallarla işlenecektir!');
  } catch (err) {
    console.error('Hata oluştu:', err);
  }
  process.exit(0);
})();
