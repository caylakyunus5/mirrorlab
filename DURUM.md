# 📌 MirrorLab — durum (16 Ekim 2026)

## Canlı yüzeyler (hepsi ücretsiz, kart istemez)

| Yüzey | Adres | Durum |
|---|---|---|
| Arayüz + motor (Surge) | https://mirrorlab-yunusnavi.surge.sh | ✅ **Paket 1-4 tamam** · FOSFOR teması yayında |
| Arayüz (GitHub Pages) | **https://caylakyunus5.github.io/mirrorlab/** | ✅ **Yeni ana yüzey** — FOSFOR teması · depodaki `docs/` klasöründen yayınlanıyor |
| Depo (açık kaynak) | **https://github.com/caylakyunus5/mirrorlab** | ✅ Public · MIT · 53 dosya · 9 ekran görüntüsü · sır yok |
| Motor (Cloudflare Worker) | https://mirrorlab-edge.yunusnavi.workers.dev | ✅ **`5b7be69f-3d14-487b-95d3-adeafbdca9de`** — `/api/hdr` canlı (güvenlik başlıkları raporu artık bulutta da çalışıyor) |

Kod her zaman `static/index.html`'e gömülür; yayın tek komut:
`SURGE_LOGIN=… SURGE_TOKEN=… bash deploy/yayinla.sh`

## Tamamlanan paketler

| Paket | İçerik | Doğrulama |
|---|---|---|
| **1 — Kopya kalitesi** | DEFLATE ZIP (metin %25-70 küçülür) · SPA/render modu (`#cRender` → `/api/rendered`) · sitemap sayfa seçici | ✅ debian 5,36 MB → 4,01 MB ZIP (`testzip` OK) · TodoMVC'de ham 640 B ↔ render 3 288 B (React DOM içeride) · MDN 67 324 sayfa listelendi, 2'si seçilip kopyalandı |
| **2 — REA derinliği** | Teknoloji/sürüm envanteri (19 kütüphane kuralı) · güvenlik başlıkları raporu (`/api/hdr`) · OpenAPI 3.1 taslağı · source map → orijinal kaynak ağacı | ✅ test sayfasında Chart.js 4.4.1 algılandı, **74 orijinal kaynak dosyası** ZIP içinde `_kaynak/chart.umd/src/helpers/helpers.core.ts` olarak çıktı · birim testler 20/20 (YAML gerçek ayrıştırıcıyla doğrulandı) |
| **3 — Kullanım kolaylığı** | Analiz geçmişi (30 kayıt) · sunucusuz paylaşılabilir rapor (`#rapor=…`) · yarıda kalan kopyayı sürdürme · öğe denetçisi | ✅ durdurulan kopya yeniden açılışta hatırlandı, "kaldığı yerden devam" ile 60 sayfaya tamamlandı · rapor bağlantısı ikinci sayfada kart olarak açıldı · denetçi `html > body > h1`, 660×35 kutu ve `font-size:30px` gösterdi · birim testler 8/8 |
| **4 — İzleme ve fark** | Anlık görüntü + fark (metin/başlık/varlık/renk/font) · izleme listesi + bildirim · tasarım token geçmişi | ✅ sayfa değiştirildiğinde **%67 fark**, "3 yeni cümle · 1 kalkmış cümle"; izleme listesi ve "süresi gelenleri kontrol et" çalıştı · birim testler 15/15 |

Canlı denetim (Surge): `derinKart ×5`, `snapBtn ×2`, `izlemePanel ×3`, `renderMirrorFit ×3`, `pauseCrawl ×3`, `denetciBtn ×2` — hepsi yerinde.

## Yol boyunca bulunup düzeltilen gerçek hatalar

1. **TDZ çökmesi** — `tohumlar` değişkeni kendi bildiriminden önce kullanılıyordu; **her kopyalamayı** "Cannot access 'tohumlar' before initialization" ile kırıyordu. Bildirim yukarı taşındı.
2. **Karar kartı canlıdan kayıp** — `renderMirrorFit` çağrılıyor ama tanımı `index.html`'e hiç girmemişti; modüller artık `deploy/embed.sh` ile sistematik gömülüyor (söz dizimi `node --check` ile denetleniyor).
3. **`sourceMappingURL=` dilimi 1 karakter kayıyordu** → harita yolu `ain.js.map` gibi bozuk çıkıyordu.
4. **robots.txt yanlış alan adına uygulanıyordu** — CDN'den gelen dosyalar seed sitenin kurallarıyla engelleniyordu; artık yalnızca `host === seedHost` iken denetleniyor.
5. **Yayın sırası hatası** — ters sırada çalıştırılınca eski `index.html` yayınlanmıştı; `deploy/yayinla.sh` bunu tek komutta doğru yapıyor.

## 16 Ekim — ek tur: iki gerçek hata daha bulundu ve düzeltildi

Bu turda canlı arayüzde iki ciddi hata yakalandı (ikisi de kullanıcı akışını kırıyordu):

1. **`#nTech` çökmesi** — `renderAnalysis()` var olmayan bir rozete yazıyordu (`$("#nTech").textContent`), bu yüzden **statik analiz paneli hiç çizilmiyordu** ve ekranda "⚠ Cannot set properties of null" hatası çıkıyordu. Rozet sekmeye geri eklendi + atama null'a karşı dayanıklı yapıldı.
2. **`derinGuvenlikDeğerlendir` ↔ `derinGuvenlikDegerlendir`** — çağrı Türkçe `ğ` ile, tanım ASCII ile yazılmıştı → `ReferenceError` → **REA derinlik kartı hiç görünmüyordu**. Ad ASCII'ye sabitlendi.

**Tekrarını önlemek için** `deploy/embed.sh` artık iki denetim daha yapıyor: (a) `node --check` söz dizimi, (b) **çağrı/tanım denetimi** — Türkçe karakterli bir çağrının ASCII'ye katlanmış hâli bir tanımla eşleşiyorsa gömme iptal edilir.

**Canlı doğrulama (Surge):** karar kartı + REA kartı birlikte geliyor; teknoloji envanteri `Chart.js 4.4.1 · Cloudflare · nginx`, **güvenlik raporu 0/100** (Surge statik barındırma HSTS/CSP göndermiyor — doğru sonuç), API taslağı 1 yol. `/api/hdr` curl testi: `200`, 20+ başlık.

## 16 Ekim — GitHub + Pages turu (tamamlandı)

* **Açık kaynak depo açıldı ve yüklendi:** https://github.com/caylakyunus5/mirrorlab (public, MIT, açıklama + 10 konu etiketi).
* **GitHub Pages açıldı ve test edildi:** https://caylakyunus5.github.io/mirrorlab/ — arayüz + Cloudflare motoru
  birlikte çalışıyor (karar kartı, REA kartı, güvenlik raporu, geçmiş paneli canlıda doğrulandı).
* **Otomatik yayın iş akışı:** `.github/workflows/pages.yml` — `static/**` değişince modülleri gömüp `docs/`
  klasörünü günceller ve yayına alır (workflow_dispatch ile koşusu test edildi: success).
* **Yayın zinciri güncellendi:** `bash deploy/yayinla.sh` artık sırayla göm → kabuk üret → Surge → `docs/`
  üretir; HF adımı **varsayılan kapalı** (`HF_YAYIN=1` ile açılır) çünkü HF yüzeyi kullanımdan kaldırıldı.
* **İki gerçek hata daha düzeltildi:** `#nTech` çökmesi (statik analiz paneli hiç çizilmiyordu) ve
  `derinGuvenlikDeğerlendir`/`Degerlendir` ad uyuşmazlığı (REA kartı hiç görünmüyordu). `deploy/embed.sh`
  artık bu sınıfı yakalayan bir **çağrı/tanım denetimi** yapıyor.

## 16 Ekim — arayüz yeniden tasarımı (tamamlandı)

Arayüz baştan tasarlandı: 6 farklı konsept (`fosfor` · `raster` · `teknik resim` · `metro` · `gazete` · `kilim`)
gerçek verilerle statik örnek olarak üretildi ve kullanıcıya seçtirildi. **Seçim: FOSFOR — CRT amber terminal (1990'lar anaçatı ekranı).**

* **Tema zamanının çoğu:** kullanıcı seçimi beklenirken tasarım dili netleşti — amber monokrom, tarama çizgileri +
  vinyet (CRT), tek tip terminal tipografisi, ters-video aktif sekme, `█▓░` blok karakterli ilerleme çubuğu.
* **Uygulandı:** tüm renk/ölçü/radius katmanı fosfor paletine çevrildi; **kart yuvarlaklığı ve gradyanlar kaldırıldı**;
  mavi/mor/yeşil vurgular amber tonlarına katlandı; JS'in ürettiği kartlar, tablolar, loglar ve raporlar da aynı
  paleti kullanıyor (motor modülleri `static/_*.src.js` içinde 243 glif + 126 renk değişimi).
* **Emoji → terminal glifi:** 32 emoji glifi (🔬 🎨 📸 ♾️ 🗺️ …) `::` `~` `*` `[∞]` `#` gibi metin gliflerine çevrildi;
  böylece hiçbir platformda renkli emoji kutusu görünmüyor (istenen "yapay zekâ arayüzü gibi durmasın" maddesi).
* **F1–F10 alt barı gerçek oldu:** önce yalnızca *görünen* tuş şeridiydi, sonra işlev bağlandı —
  F1 yardım · F2 incele · F3 tarayıcı analizi (REA) · F4 tam ayna · F5 klonu yenile · F6 sitemap ·
  F7 geçmiş · F8 rapor · F9 durdur · F10 temizle. Klavye F1–F10 tuşları ile ekrandaki şerit aynı işlemleri yapar.
* **Fonksiyonel kimlikler korundu:** 10 sekme, 100+ `id`, tüm panel/kart yapıları aynen duruyor; yalnızca görsel katman
  ve iki küçük ekleme (`#saat` durum saati, `.fkey` düğmeleri) geldi. `deploy/embed.sh` söz dizimi + çağrı/tanım
  denetimi temiz.
* **Doğrulama (yerel sunucu, gerçek Chrome):** statik analiz + REA derinliği + karar kartı + tek dosya + ağ tablosu
  çalışıyor; karar kartı `[✓] TAM KOPYALAMAYA UYGUN 100/100`, REA kartı 4 katman, 6 bölüm, 22 DOM düğümü,
  konsol hatası **yok**. F1–F10 kısayolları tek tek denendi.

## Sıradaki adımlar

1. **İsteğe bağlı:** depoya yıldız/issue açıp geri bildirim toplamak; README'ye İngilizce özet eklemek.
2. **İsteğe bağlı:** kendi alan adı (Cloudflare Pages/Workers custom domain) — şu anki ücretsiz adresler yeterli.
3. **Yerel motor (Python + Chrome) ile tam deneyim:** `./run.sh` — bulut motorunda tarayıcı kotası olduğu için
   ağır işler (çok sayfalı analiz, video'lu siteler) yerelde daha rahat çalışır.
4. **Bilinen sınır:** HF yüzeyi artık güncellenmiyor (kullanıcı kararı) — eski sürüm orada kalabilir.
