const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require('./serviceAccountKey.json');

const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://fir-database-92cb5-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = getDatabase(app);

async function fixMissingNames(nodePath) {
  console.log(`${nodePath} taranıyor...`);
  const ref = db.ref(nodePath);
  const snapshot = await ref.once('value');
  const data = snapshot.val();
  if (!data) {
    console.log(`${nodePath} boş, geçiliyor.`);
    return;
  }
  let updateCount = 0;
  const updates = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && typeof value.name === 'undefined') {
      updates[`${key}/name`] = "";
      updateCount++;
    }
  }
  if (updateCount > 0) {
    await ref.update(updates);
    console.log(`✅ ${nodePath} node'unda ${updateCount} kayıt düzeltildi.`);
  } else {
    console.log(`✅ ${nodePath} node'u zaten temiz, sorunlu kayıt bulunamadı.`);
  }
}

async function run() {
  try {
    await fixMissingNames('clients');
    await fixMissingNames('products');
    
    console.log("Veri temizleme işlemi tamamlandı!");
    process.exit(0);
  } catch (err) {
    console.error("Hata oluştu:", err);
    process.exit(1);
  }
}
run();
