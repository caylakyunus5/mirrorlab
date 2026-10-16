# ☁️ Cloudflare ile MirrorLab — ücretsiz mimari

Bu klasör, MirrorLab'ın **sunucu barındırmadan, Cloudflare'in ücretsiz katmanında** çalışan
parçalarını içerir. Worker'ın kendisi burada: `worker.js` — HTML/CSS/JS yeniden yazımını
Cloudflare'in yerel **HTMLRewriter** motoruyla yapar (JS çalıştırmaz, CPU'yu yormaz).

## Kısa hüküm: ne nerede çalışır?

| Yetenek | Ücretsiz Cloudflare'de | Nasıl |
|---|---|---|
| Arayüz (statik) | ✅ | Worker + `assets` bağlayıcısı (sınırsız bant genişliği) |
| Klon önizleme + varlık proxy'si + link yeniden yazımı | ✅ | `worker.js` → `/api/render`, `/api/asset` |
| Hızlı statik analiz (meta, sayımlar, varlıklar, çatı izleri) | ✅ | `worker.js` → `/api/analyze` |
| Tek dosya dışa aktarma (mutlak URL / base64 gömme) | ✅ (sınırlı) | `worker.js` → `/api/export` (istek başına 50 alt istek) |
| **Ağ kaydı, API gövdeleri, ekran görüntüleri** | ✅ **günde 10 dk** | Worker içinde **`/api/deep`** → Browser Rendering (`[browser]` bağlayıcısı) |
| Tam site aynası (ZIP, çok sayfa) | ⚠️ sınırlı | Worker'da yapılmaz → GitHub Actions / VM / kendi makinen |
| Kalıcı arşiv | ✅ 10 GB | R2 (ücretsiz kotada) |
| Docker imajının tamamı Cloudflare'de | ❌ ücretsiz değil | Containers **$5/ay** (Workers Paid) |

> Kısa cevap: **Cloudflare bu işin "ön kapısı + kenar klonlayıcısı" olarak mükemmel, ama tek başına
> tüm uygulamayı ücretsiz barındırmaz.** Chrome gerektiren derin analiz için ücretsiz 10 dk/gün var;
> tam ayna (ZIP) ve kalıcı arşiv için ya kendi makinen (Tunnel ile) ya GitHub Actions gerekir.

---

## 1) Edge katmanını yayına al (~2 dakika)

```bash
cd mirrorlab
npm install -D wrangler        # wrangler 4.x
npx wrangler login             # tarayıcıda Cloudflare hesabınızı onaylayın
npx wrangler deploy --config deploy/cloudflare/wrangler.toml
```

Çıktı: `https://mirrorlab-edge.<hesap>.workers.dev`

* `static/index.html` arayüzü **aynı Worker'dan** servis edilir (`[assets]` bağlayıcısı).
* Arayüzdeki Önizleme + Statik Analiz + Tek Dosya sekmeleri **anında çalışır** — sunucu yok.
* "🔬 Tarayıcı Analizi" sekmesi bu katmanda devre dışıdır (Chrome yok) → 2. adıma bakın.
* Kendi alan adınız varsa (Cloudflare'e bağlı zone): `npx wrangler deploy` sonrası
  Workers > Settings > Domains & Routes üzerinden ücretsiz bağlayabilirsiniz.

**Yerel test (yaptım, çalışıyor):**

```bash
npx wrangler dev --config deploy/cloudflare/wrangler.toml --port 8787
curl "http://127.0.0.1:8787/api/analyze?url=https://example.com"
```

Ücretsiz katman limitleri: **100.000 istek/gün**, istek başına **10 ms CPU**, **50 alt istek**.

---

## 0) Canlı kurulum (15 Ekim 2026)

* Motor + arayüz: **https://mirrorlab-edge.yunusnavi.workers.dev** (hesap: Caylakyunus5@gmail.com,
  workers.dev alt alanı: `yunusnavi`)
* Ölçülen: `/api/deep` tailwindcss.com → 7 sn / 91 istek / 9 API / 12 bölüm / ekran görüntüsü;
  Wikipedia (arayüzden) → 5.6 sn / 15.548 DOM düğümü / 13 bölüm / 260 görsel.
* Yayınlama: `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy --config deploy/cloudflare/wrangler.toml`
* **1042 tuzağı:** deploy'dan sonraki ilk dakikada kenar ağı yeni sürümü dağıtmadığı için 404/1042
  gelebilir; Worker loglarına (`wrangler tail`) istek düşmüyorsa sorun Worker'da değil dağıtımdadır.

## 1½) Derin analiz zaten Worker'da: `/api/deep`

`wrangler.toml` içinde `[browser] binding = "BROWSER"` tanımlı olduğu için, arayüzdeki
"🔬 Tarayıcıda İncele" düğmesi bu katmanda otomatik olarak **`/api/deep`** rotasını kullanır:
Cloudflare'in headless Chrome'u sayfayı açar; ağ kaydı, API gövdeleri ve şeması, render edilmiş
sayaçlar + çatı tespiti, tasarım token'ları (renk/font/köşe/gölge + bileşen örnekleri),
bölüm haritası ve **data-URL ekran görüntüsü** döner (yanıt 1.4 MB ile sınırlı).

**Yerel ölçümler (wrangler dev, gerçek tarayıcı):**

| Sayfa | Süre | Ağ isteği | API çağrısı | Bölüm | Ekran görüntüsü |
|---|---|---|---|---|---|
| tailwindcss.com (`light=1`) | **2.6 sn** | 91 | 10 | 12 | 117 KB JPEG |
| tr.wikipedia.org (`light=1`) | **3.0 sn** | 54 | — | 13 | — |

Yani ücretsiz 600 sn/gün kota ile **~150-200 analiz/gün** yapılabilir. Kota dolduğunda Cloudflare
429 döner; yanıt `limits` alanında bunu açıkça söyler. `light=0` daha uzun ve daha çok kota harcar.

> Yerel geliştirmede (`npx wrangler dev`) tarayıcı bağlayıcısı yerel Chrome ile de çalıştı — deploy
> etmeden test edebilirsiniz. Üretimde Cloudflare'in tarayıcı havuzu kullanılır.

## 2) Alternatif: kendi makinenizden uzak tarayıcı (yerel engine.js + CDP)

Cloudflare'in ücretsiz planı **günde 10 dakika** tarayıcı süresi verir (3 eşzamanlı tarayıcı).
Artık **CDP (Chrome DevTools Protocol) uç noktası** sunduğu için, kendi Chrome'unu *indirmeden*
`engine.js`'i bu uzak tarayıcıya bağlayabilirsin — yani analiz makinenden tetiklenir,
tarayıcı Cloudflare'de çalışır.

### a) API token ve uç nokta

1. Cloudflare panosu → **My Profile → API Tokens → Create Token**
   → şablon: **Browser Rendering – Edit**
2. **Account ID**: panoda Workers bölümünde sağ kenarda yazar (veya URL'deki `accounts/<ID>`).
3. WebSocket uç noktası:

```
wss://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-run/devtools/browser?keep_alive=60000
```

### b) Çalıştırma (Chrome indirmeye gerek yok)

```bash
# puppeteer'ı Chrome olmadan kur (~10 MB, 400 MB değil)
PUPPETEER_SKIP_DOWNLOAD=1 npm install puppeteer
# ya da depodaki yardımcı betik:
export CF_ACCOUNT_ID="<hesap-id>"
export CF_API_TOKEN="<browser-rendering-token>"
./deploy/cloudflare/run-remote-engine.sh https://ornek.com analiz.json

# elle:
export MIRRORLAB_BROWSER_WS="wss://api.cloudflare.com/client/v4/accounts/<ID>/browser-run/devtools/browser?keep_alive=60000"
export MIRRORLAB_BROWSER_TOKEN="<token>"
node engine.js cfg.json              # veya: python3 server.py --engine https://ornek.com analiz.json
```

`server.py` bu ortam değişkenlerini çocuk sürece aktarır; arayüzde "🔬 Tarayıcıda İncele"
düğmesi de çalışır (`/api/env` uzak tarayıcıyı "hazır" olarak görür).

### c) Ücretsiz 10 dakika ne kadar yeter?

| Analiz türü | Tarayıcı süresi (yaklaşık) | Günde |
|---|---|---|
| `probe` açık + mobil görüntü | ~15-25 sn | ~25-40 analiz |
| `probe` kapalı, mobil kapalı | ~4-8 sn | ~75-150 analiz |

> Büyük sayfalarda `mobile=0&probe=0` kullanın: hiçbir yetenek kaybı olmadan süreyi ~3 kat azaltır.
> Süre dolduğunda Cloudflare 429 döner; `engine.js` bunu `limits` alanında raporlar.

---

## 3) Tam sürümü ücretsiz HTTPS ile yayınla: Cloudflare Tunnel

Bilgisayarınızda (veya Oracle Always Free VM'de) **tüm özelliklerle** çalışan MirrorLab'ı,
port açmadan, HTTPS'li bir adresle yayınlamanın ücretsiz yolu:

```bash
# sunucu tarafı
python3 server.py                       # http://localhost:8000

# aynı makinede, başka bir terminalde
cloudflared tunnel login                # tarayıcıdan zone seçin (alan adı gerekir)
cloudflared tunnel create mirrorlab
cloudflared tunnel route dns mirrorlab mirrorlab.ornek.com
cloudflared tunnel run --url http://localhost:8000 mirrorlab
```

* Alan adı yoksa: `cloudflared tunnel --url http://localhost:8000` → geçici `*.trycloudflare.com` adresi.
* **Şifre koruması** (ücretsiz): Cloudflare Zero Trust → Access → Application ekleyin; kural olarak
  e-posta OTP'si koyun. Böylece aracınız herkese açık olmaz (kendi kullanımınız için ideal).
* Bu yolda hız sınırı/`MIRRORLAB_ENGINE` ayarlarını kendi `.env`'inizde yönetirsiniz.

---

## 4) $5/ay Workers Paid ne kazandırır? (isteğe bağlı)

| Kazanç | Ayrıntı |
|---|---|
| **Containers** | Tüm MirrorLab Docker imajını Cloudflare'de çalıştırır (25 GiB-saat RAM + 375 vCPU-dk dahil) |
| Browser Rendering | 10 saat/ay (ücretsiz 5 saat yerine), 10 eşzamanlı tarayıcı |
| Workers limitleri | 30 sn CPU/istek, 10.000 alt istek/istek → **ağır tarama ve ZIP Worker'da mümkün olur** |
| Kalıcı durum | D1 (5 GB), KV, Durable Objects, R2 |

Yani "hepsi Cloudflare'de olsun" diyorsanız toplam maliyet **$5/ay**; tamamen ücretsiz kalmak istiyorsanız
1+2+3. adımlar yeterlidir.

---

## 5) Sınırlar ve dikkat edilecekler

* **CPU sınırı (ücretsiz): 10 ms/istek.** Bu yüzden `worker.js` HTML ayrıştırması için
  platformun yerel `HTMLRewriter`'ını kullanıyor; JS ile regex tabanlı ağır işler CPU'yu aşabilir.
  (Katmanlı CSS yeniden yazımı için `text()` işleyicileri kullanıldı — gövdeyi tamamen belleğe almaz.)
* **50 alt istek sınırı:** Tek dosya `inline` modu bu yüzden en fazla ~14 varlığı gömer; sınırsız gömme
  için VM/Actions yolunu kullanın.
* **Tam ayna (ZIP) Worker'da yapılmaz** — çok sayfa + çok varlık, alt istek ve CPU sınırlarını aşar.
* **İzolat belleğindeki hız sınırı** kalıcı/global değildir (her izolat kendi sayacını tutar).
  Kalıcı sınır için panodan WAF > Rate limiting kuralı veya KV tabanlı sayaç ekleyin.
* **Kullanım şartları:** Eski **Section 2.8** ("HTML dışı içerik proxy'lemek yasak") kısıtı
  **Temmuz 2026'da kaldırıldı** ([Cloudflare blog](https://blog.cloudflare.com/updated-tos/)). Yine de
  "hizmete makul olmayan yük bindirmeme" (2.2) ve **telif/robots sorumluluğu** kullanıcıya aittir:
  bu araç yalnızca sahibi olduğunuz/izin verilen sitelerde, makul hacimde kullanılmalıdır.
* Worker'ın kaynak kodu 3 MB (free) sınırının çok altında; `static/index.html` varlıklarla birlikte
  deploy edilir (ayrı Pages projesine de koyabilirsiniz).
* Headless Chrome'a ihtiyaç duyan "ağ kaydı / ekran görüntüsü" özellikleri Worker'da **kasten yoktur** —
  yanlış beklenti oluşmasın diye `/api/health` yanıtı bunu açıkça yazar.

## 6) Dosyalar

```
deploy/cloudflare/
├── worker.js              # HTMLRewriter tabanlı edge klonlayıcı + proxy + analiz + export
├── wrangler.toml          # deploy ayarları (assets = ../../static, /api/* → Worker)
├── run-remote-engine.sh   # engine.js'i Cloudflare Browser Rendering'e bağlayarak çalıştırır
└── README.md              # bu dosya
```
