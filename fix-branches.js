const environment = process.env.NODE_ENV || 'development';
const envFile = environment === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: envFile });

const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

// Dry Run (Test Modu) bayrağı. 
// Başlangıçta "true" olarak ayarladık ki sadece ekrana yazsın, hemen veritabanını değiştirmesin.
// Sonuçları konsolda inceleyip doğru bulduğunuzda bu değeri "false" yapıp scripti tekrar çalıştırın.
const DRY_RUN = false;

try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json');
  }
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://fir-database-92cb5-default-rtdb.europe-west1.firebasedatabase.app"
  });
  console.log('Firebase Admin başlatıldı.');
} catch (error) {
  console.error('Firebase Admin başlatılamadı. JSON yolu ve .env ayarlarını kontrol edin.', error.message);
  process.exit(1);
}

const db = getDatabase();

async function fixBranches() {
  try {
    console.log('Mevcut müşteriler veritabanından çekiliyor...');
    const ref = db.ref('clients');
    const snapshot = await ref.once('value');
    const data = snapshot.val();

    if (!data) {
      console.log('Veritabanında hiç müşteri bulunamadı.');
      process.exit(0);
    }

    // Sadece adı olan geçerli müşterileri listeye alıyoruz
    const clientsList = Object.keys(data)
      .filter(id => data[id] && data[id].name)
      .map(id => ({
        id,
        name: data[id].name,
        parentId: data[id].parentId || null
      }));

    console.log(`Toplam ${clientsList.length} müşteri bulundu. Yapay zekaya analiz için gönderiliyor... (Bu işlem birkaç saniye sürebilir)`);

    const systemPrompt = `Sen bir veri analisti asistanısın. Görevin, verilen müşteri (firma) listesindeki şube (branch) ve ana firma (parent) ilişkilerini tespit etmektir.
Aynı firmanın farklı lokasyonlardaki şubeleri veya alt uzantıları varsa (Örn: "K.KAYA" ve "K.KAYA ATAŞEHİR"), ana firmayı (K.KAYA) bulmalı ve şubeleri ona bağlamalısın.

Kurallar:
1. SADECE ana firma ve şube ilişkisi olanları döndür. Tamamen bağımsız, ilişkisiz firmaları atla.
2. Sadece valid bir JSON formatında bir array döndür.
3. Array içindeki her obje şu yapıda olmalı: { "branchId": "şubenin_idsi", "parentId": "ana_firmanın_idsi" }
4. Açıklama metni veya markdown (\`\`\`json) KESİNLİKLE kullanma. Doğrudan ve sadece JSON Array döndür.

Mevcut Müşteri Listesi:
${JSON.stringify(clientsList, null, 2)}`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: systemPrompt }],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API Hatası: ${response.status} ${response.statusText}`);
    }

    const aiData = await response.json();
    const aiContent = aiData.choices[0].message.content;
    const cleanJsonStr = aiContent.replace(/```json/g, '').replace(/```/g, '').trim();

    let matches = [];
    try {
      matches = JSON.parse(cleanJsonStr);
    } catch (parseError) {
      console.error("Yapay zekadan dönen veri JSON formatına çevrilemedi:\n", cleanJsonStr);
      process.exit(1);
    }

    console.log(`\nYapay zeka ${matches.length} adet şube-ana firma ilişkisi tespit etti.`);

    if (matches.length === 0) {
      console.log("Herhangi bir ilişki bulunamadı. İşlem tamamlandı.");
      process.exit(0);
    }

    console.log("\n--- TESPİT EDİLEN İLİŞKİLER ---");
    const updates = {};

    matches.forEach(match => {
      const branch = clientsList.find(c => c.id === match.branchId);
      const parent = clientsList.find(c => c.id === match.parentId);

      if (branch && parent) {
        console.log(`[ŞUBE]: ${branch.name}  --->  [BAĞLANACAĞI ANA FİRMA]: ${parent.name}`);

        // Eğer daha önceden bu parentId atanmamışsa güncellenecekler listesine ekle
        if (data[match.branchId].parentId !== match.parentId) {
          updates[`${match.branchId}/parentId`] = match.parentId;
        }
      } else {
        console.log(`Uyarı: Hatalı ID eşleşmesi yapıldı. Yapay zeka halüsinasyonu olabilir. BranchId: ${match.branchId}, ParentId: ${match.parentId}`);
      }
    });

    if (DRY_RUN) {
      console.log("\n=======================================================");
      console.log("⚠️ TEST MODU (DRY_RUN) AKTİF: Veritabanına hiçbir şey YAZILMADI.");
      console.log("Yukarıdaki eşleşmelerin doğru olduğunu düşünüyorsanız,");
      console.log("fix-branches.js dosyasının içindeki 'const DRY_RUN = true;'");
      console.log("satırını 'false' olarak değiştirip scripti tekrar çalıştırın.");
      console.log("=======================================================");
    } else {
      const updateKeys = Object.keys(updates);
      if (updateKeys.length > 0) {
        console.log(`\nVeritabanı kalıcı olarak güncelleniyor (${updateKeys.length} adet kayıt)...`);
        await ref.update(updates);
        console.log("✅ İşlem başarıyla tamamlandı! Şubeler ana firmalarına bağlandı.");
      } else {
        console.log("\nVeritabanında güncellenecek yeni bir kayıt bulunamadı (Zaten hepsi bu şekilde bağlı).");
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('\nHata oluştu:', error);
    process.exit(1);
  }
}

fixBranches();
