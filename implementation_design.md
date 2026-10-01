# React Native Implementation Design: AI Feedback Loop (Memories)

Bu doküman, KDU React Native uygulamasını geliştirecek olan Agent için bir rehber niteliğindedir. Node.js backend'inde kurduğumuz yapay zeka tabanlı "Continuous Learning" (Sürekli Öğrenme) mekanizmasının önyüz entegrasyonu için yapılması gerekenleri detaylandırır.

## 1. Mevcut Backend Yapısı (Ne İnşa Ettik?)
- Node.js webhook'u, yeni açılan görevleri (`tasks`) okur ve DeepSeek AI kullanarak kategorize eder, bir müşteriye (`clientId`, `clientName`) atar, başlığını profesyonelleştirir (`standardisedTitle`) ve özetini (`summary`) çıkartır.
- İşlenen görevler `tasks` node'una geri yazılır ve `processed: true` olarak işaretlenir.
- Müşterilerin görev geçmişi `clients/<clientId>/tasks/<taskId>` altında tutulmaktadır.
- Ayrıca AI, karar alırken `memories` node'undaki geçmiş düzeltmeleri "Kural" olarak okumaktadır.

## 2. React Native Tarafında Yapılması Gerekenler

### A. Yeni Görev Detayları ve Görüntüleme
- `tasks` objesine yeni eklenen şu alanların UI'da (örneğin Home veya CompletedTask listelerinde) gösterilmesi sağlanmalıdır:
  - `category` (Örn: Donanım, Yazılım) -> Bir rozet (badge) olarak gösterilebilir.
  - `clientName` -> Görevin hangi müşteriye atandığı kartın üzerinde belirgin olmalıdır.
  - `standardisedTitle` -> Kullanıcının girdiği dağınık başlık yerine yapay zekanın düzelttiği bu temiz başlık ana başlık olarak kullanılmalıdır.
  - `summary` -> Görev detayına girildiğinde veya liste elemanının altında kısa açıklama olarak gösterilmelidir.

### B. Müşteri Profili (Client Task History)
- "Müşteriler" (Clients) sekmesinde bir müşteriye tıklandığında, o müşterinin profiline gidilmeli.
- Bu profilde, Firebase'deki `clients/<clientId>/tasks` yolu dinlenerek (onValue), o müşterinin bugüne kadar açtırdığı tüm görevler liste halinde (tarih sırasına göre) gösterilmelidir.

### C. AI Düzeltme (Feedback) Akışı ve "Onay Bekleyenler"
- Görev detay ekranına (veya Completed tabındaki liste elemanlarına) bir **"AI'ı Düzelt (Feedback)"** butonu eklenmelidir.
- Bu butona tıklandığında açılan bir Modal veya sayfada kullanıcı şu bilgileri girmelidir:
  - "Olması Gereken Kategori" (Örn: Yazılım)
  - "Olması Gereken Müşteri"
  - "Neden?" (Açıklama / Kural: "Yazıcı kelimesi geçiyorsa Donanımdır")
- Bu form submit edildiğinde, Firebase'e şu şekilde bir **Memory (Hafıza)** kaydı atılmalıdır:
  ```javascript
  // firebase.database().ref('memories').push()
  {
    rule: "Eğer görev açıklamasında 'Yazıcı' geçiyorsa, kategori her zaman 'Donanım' olmalıdır.",
    correctedCategory: "Donanım",
    createdAt: Date.now(),
    createdBy: "Admin" // veya mevcut kullanıcının id'si
  }
  ```
- **Opsiyonel "Onay Bekleyenler (Awaiting Approval)" Tabı:**
  - Eğer AI'ın yaptığı her kategorizasyonun otomatik canlıya geçmesi istenmiyorsa, Node.js tarafında görevler `processed: true` yerine `status: 'awaiting_approval'` olarak işaretlenebilir.
  - React Native tarafında yeni bir sekme (Tab) açılarak sadece `status === 'awaiting_approval'` olan görevler listelenir.
  - Kullanıcı bu ekranda görevleri tek tek inceleyip "Onaylıyorum" diyebilir veya yukarıdaki form ile düzeltme yapabilir.

## 3. Özet İş Akışı (React Native Agent İçin)
1. **Model & Tipler:** `Task` interface'ini genişlet (category, clientName, standardisedTitle, summary).
2. **UI Güncellemesi:** Görev kartlarında bu yeni alanları göster.
3. **Müşteri Geçmişi:** `Clients.tsx` ekranından detay sayfasına geçiş yapıp `clients/{id}/tasks` verisini listele.
4. **Feedback Modalı:** Kullanıcının hatalı AI atamalarını düzeltebileceği ve bu düzeltmeleri `memories` node'una pushlayacağı formu tasarla.
