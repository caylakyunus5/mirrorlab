# 🧩 MirrorLab — Sıfır Backend Chrome & Edge Eklentisi

Bu paket, MirrorLab'i **hiçbir sunucuya, Cloudflare'e, Python'a veya Node.js'e ihtiyaç duymadan**, doğrudan kendi tarayıcınızda ve kendi bilgisayarınızda **%100 yerel** çalıştırmanızı sağlar.

---

## 🎯 Neden Eklenti? (Sıfır Backend Sırrı)
Normal bir web tarayıcısında başka bir sitenin kodlarını veya dosyalarını çekerken **CORS (Cross-Origin Resource Sharing)** güvenlik duvarına takılırsınız. Bu yüzden normalde araya bir Python veya Cloudflare Worker proxy sunucusu koymak gerekir.

**Tarayıcı eklentilerinde ise CORS engeli yoktur!** Eklenti kuralları sayesinde:
1. İstekler doğrudan sizin bilgisayarınızın ağ kartından ve gerçek IP'nizden hedefe gider.
2. Sıfır sunucu maliyeti, sıfır kota, sınırsız indirme hızı.
3. Web siteleri, Phaser / WebGL / WASM HTML5 oyunları doğrudan bilgisayarınıza indirilir ve ZIP'lenir.

---

## 🚀 15 Saniyede Kurulum (Chrome, Edge, Brave, Opera)

1. Tarayıcınızda adres satırına şunu yazın ve Enter'a basın:
   - Chrome / Brave: `chrome://extensions`
   - Edge: `edge://extensions`
2. Sağ üst köşedeki **"Geliştirici modu" (Developer mode)** anahtarını açın.
3. Sol üstte beliren **"Paketlenmemiş öge yükle" (Load unpacked)** butonuna tıklayın.
4. Bu klasörü (`mirrorlab/deploy/extension`) seçin.
5. Hazır! Tarayıcınızın uzantılar menüsünden **MirrorLab** simgesine tıklayarak veya `chrome-extension://.../index.html` adresine giderek dilediğiniz gibi kullanabilirsiniz.

---

## 🎁 Dahili Yetenekler
- **🎮 Oyun & Medya Çıkarıcı:** Poki, CrazyGames, Famobi, GameDistribution iframe'lerini ayıklar ve tam ekran klonlar.
- **🛡️ Site-Lock / Ad SDK Bypass:** Çevrimdışı ortamda oyunların donmasını engelleyen reklam stub'ları ve domain hileleri otomatik eklenir.
- **⚡ Tek Tıkla Başlatıcılar:** İndirilen ZIP içine `oyna.bat` (Windows) ve `oyna.sh` (Mac/Linux) gömülür. Çift tıklayarak çevrimdışı oynanabilir.
- **🎨 React JSX & Tailwind CSS:** DOM Denetleyicisi seçilen bileşenleri tek tıkla React JSX ve Tailwind sınıflarına dönüştürür.
- **🔍 Gizli API & Secret Scanner:** Kaynak kodlardaki Firebase, AWS S3, Stripe, JWT ve iç ağ IP'lerini otomatik listeler.
