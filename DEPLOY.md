# 🚀 MirrorLab'ı ücretsiz yayınlama rehberi

Bu uygulama **statik bir site değil**: Python sunucusu + headless Chrome çalıştırıyor.
Yani GitHub Pages / Netlify / Vercel gibi statik barındırmalar tek başına yetmez —
**konteyner (Docker) çalıştırabilen** bir ücretsiz katmana ihtiyaç var.

Aşağıdaki beş yol da gerçekten ücretsiz. Hangisini seçeceğiniz üç soruya bağlı:
*kredi kartı verebilir misiniz?*, *7/24 açık kalmalı mı?*, *ne kadar trafik bekliyorsunuz?*

---

## 0) ŞU AN CANLI (15 Ekim 2026 · hepsi test edildi)

| Katman | Adres | Ne yapar |
|---|---|---|
| **Motor + arayüz (Cloudflare Worker)** | **https://mirrorlab-edge.yunusnavi.workers.dev** | Klon önizleme, statik analiz, tek dosya export, **`/api/deep` gerçek headless Chrome** (günde 10 dk ücretsiz) |
| **Arayüz (Surge)** | **https://mirrorlab-yunusnavi.surge.sh** | Aynı arayüz, motor varsayılan olarak gömülü → hiçbir ayar gerekmez |
| **Arayüz (HF statik Space)** | https://yunus2441-mirrorlab.static.hf.space | Aynı arayüz, yedek/alternatif adres |

**Doğrulanan ölçümler (canlı, senin hesabında):**

| Test | Sonuç |
|---|---|
| `/api/deep` → tailwindcss.com | **7 sn** · 91 ağ isteği · 9 API çağrısı · 12 bölüm · 12 renk · JPEG ekran görüntüsü |
| `/api/deep` → tr.wikipedia.org (arayüzden, tıklamayla) | **5.6 sn** · 54 ağ isteği · **15.548 DOM düğümü** · 13 bölüm · 260 görsel · tasarım token'ları |
| `/api/render` (klon önizleme) | 200 · 0.17 sn |
| `/api/analyze` (HTMLRewriter, tarayıcısız) | 200 |
| `/api/export` (tek dosya) | 200 |
| SSRF koruması (`127.0.0.1`) | 403 |

### Öğrenilen tuzaklar (tekrar düşmemek için)

1. **Deploy'dan hemen sonra 10-60 sn boyunca `error code: 1042` (HTTP 404)** gelebilir; bu,
   Cloudflare kenar ağının yeni Worker'ı henüz dağıtmamış olmasıdır. Worker'ın kendisi sağlıklıdır,
   biraz bekleyince düzelir. (Loglarda istek hiç görünmez — teşhis işareti budur.)
2. **`$("#tabs .tab")[i]` hatası:** `querySelector` tekil düğüm döndürür, `[i]` → `undefined`
   → `TypeError: Cannot read properties of undefined (reading 'click')`. Bu yüzden "Tarayıcıda İncele"
   düğmesi hiç çalışmıyordu. `tabClick(i)` yardımcısıyla düzeltildi (5 çağrı).
3. **Statik arayüz kabuğu (hf-shell.js) `<head>` içinde, uygulama `<script>`'inden ÖNCE** yüklenmeli;
   aksi hâlde arayüzün ilk `/api/health` isteği yanlış adrese gider.
4. Surge'de `/favicon.ico` 404'ü konsolda hata gösterir → `favicon.svg` + `<link rel="icon">` eklendi.

### 🆕 Tarayıcı içi tam ayna (edge modu) — 15 Ekim 2026

Cloudflare Worker'ın ücretsiz sınırları (50 alt istek / 10 ms CPU) yüzünden tam site
kopyalama sunucuda yapılamıyordu. Çözüm: **iş tarayıcıya taşındı.** "Tam Ayna" sekmesi artık
edge modunda da çalışır:

* Sayfalar/varlıklar Worker'daki **`/api/raw`** ham proxy'sinden indirilir (SSRF korumalı),
* bağlantılar istemcide yerelleştirilir (`<link>`, `<script>`, `<img>`, `srcset`, `style`,
  CSS `url()`/`@import`, sayfa arası linkler — ikinci geçişle),
* ZIP **tarayıcıda** üretilir (bağımlılıksız STORE yazıcı, CRC32 doğru),
* ZIP köküne bir `index.html` giriş noktası eklenir.

**Kanıtlanan testler (canlı, çevrimdışı açılarak doğrulandı):**

| Hedef | Sonuç |
|---|---|
| info.cern.ch (6 sayfa) | 8 dosya · 17 KB · **ağ kapalıyken** açıldı, yerel linkle gezinildi ✅ |
| www.debian.org (3 sayfa) | **52 dosya · 5.4 MB** · CSS/JS/PNG/SVG/JPG/EOT/WOFF2/WOFF/TTF · çevrimdışı: 4 stil dosyası etkin, **16/16 görsel** yüklendi ✅ |
| tr.wikipedia.org (3 sayfa) | 11 dosya · 2.4 MB · robots.txt `/w/` yolunu yasakladığı için CSS/JS atlandı — **artık sebebi loglarda yazıyor** ✅ |

Not: `robots.txt` kutusu işaretliyken yasaklı yollar atlanır ve atlama sebepleri arayüzde
görünür ("robots yasağı", "varlık sınırı", "site dışı", "indirilemedi"). Kutuyu kaldırırsanız
CSS/JS de iner (sorumluluk kullanıcıda).

### 🧭 "Tam kopyalamaya uygun mu?" kararı (15 Ekim 2026)

Tarayıcı Analizi bölümünün **en üstünde** artık bir karar kartı var. Analiz verisinden +
`robots.txt`'ten hesaplanır ve şu seviyelerden birini verir:

| Seviye | Anlamı |
|---|---|
| ✅ **Tam kopyalamaya UYGUN** (75-100) | Sunucudan dolu HTML, robots engeli yok, varlık yükü makul |
| ⚠️ **KISMEN uygun** (40-74) | Kopyalanır ama eksikler var (robots varlık dizinini kapatıyor, SPA, ağır sayfa) |
| ⛔ **Kopyalamaya UYGUN DEĞİL** (0-39) | Bot koruması ya da robots ana dizini kapalı → boş/eksik kopya beklenmeli |

Değerlendirilen ölçütler: **bot koruması** (Cloudflare/captcha izleri), **robots.txt**
(ana dizin ve varlık dizinleri: `/assets/`, `/w/`, `/_next/`, `/wp-content/` …),
**istemci tarafı render** (React/Next/Vue tespiti + küçük DOM), **varlık yoğunluğu**
(istek/görsel sayısı), **iframe/form/API** sinyalleri ve bağlantı sayısından sayfa tahmini.
Karttan doğrudan **♾️ Sınırsız kopyala** veya **▶ Sınırlı kopyala** başlatılabilir.

**Canlı testler (doğrulandı):**

| Site | Karar | Neden |
|---|---|---|
| example.com | ✅ 100/100 | robots yok, hafif sayfa |
| developer.mozilla.org | ✅ 100/100 | 3 robots kuralı tarandı, varlık dizinleri açık |
| www.debian.org | ✅ 100/100 | hafif, robots yok |
| tr.wikipedia.org/wiki/Türkiye | ⚠️ 68/100 | robots `/w/` dizinini yasaklıyor → CSS/JS eksik kalır (açıkça yazılıyor) |

**Bu özellikte bulunan iki hata:**
1. **robots.txt eşleştirici yanlış pozitif üretiyordu:** `*` joker içeren bir kuralın
   (`/files/*` gibi) "öneki" boş kalıp **her yolu yasaklı** sayıyordu (MDN "uygun değil"
   görünüyordu). Eşleştirici düzgün RegExp'e çevrildi (`*` → `.*`, sonda `$` çapası);
   9 birim test satırının tamamı geçiyor.
2. **Blok yorumu tuzağı:** yorum içindeki `/*/files/` örneğindeki `*/` dizisi yorumu erken
   kapatıp tüm arayüz JS'ini çökertti (`node --check` yakaladı). Arayüz bu sırada
   **hiçbir düğmeye tepki vermiyordu**. Ders: JS yorumlarında yıldız-eğik çizgi dizisi
   yazmayın; her yamadan sonra `node --check` çalıştırın.
3. Ayrıca **geçici 429/5xx** ("Unable to create new browser: Rate limit exceeded") artık
   **otomatik yeniden deniyor** (3 denemeye kadar, 9 sn ve 20 sn beklemeli) — ücretsiz
   katmanda tarayıcı başlatma dalgalanmaları kullanıcıya hata olarak yansımıyor.

### ♾️ Sınırsız kopyalama (15 Ekim 2026)

Tam Ayna sekmesine **"♾️ Sınırsız kopyala"** düğmesi eklendi: sayfa, varlık ve boyut
sınırı yoktur. Ayrıca **"⏹ Durdur"** düğmesi çalışan kopyalamayı keser ve o ana kadar
toplanan içerikle ZIP'i yine üretir.

* **Doğrudan diske akıtma:** Chrome/Edge'de ZIP, `showSaveFilePicker` ile parça parça
  diske yazılır → **bellek sınırı yok** (GB'larca site kopyalanabilir).
* **Bellek modu:** disk akışı yoksa ZIP bellekte üretilir; sekme çökmemesi için
  yalnızca ~1,7 GB teknik tavan vardır ve logda bildirilir.
* **Tek gerçek tavan ZIP32 dosya biçiminden gelir:** 65.535 dosya / 4 GB.
* `/api/raw` proxy'si hız sınırına **tabi değildir** (100 hızlı istek testinde 0 adet 429).
* robots.txt kutusu sınırsız modda da geçerlidir; kapatmak kullanıcının tercihidir.

**Ölçümler (canlı, 15 Ekim 2026):**

| Test | Sonuç |
|---|---|
| info.cern.ch · sınırsız · 75 sn sonra durduruldu | **123 sayfa · 515 KB · 125 girdi · bütünlük OK** · ZIP diske akıtıldı ✅ |
| example.com · sınırsız · disk akışı | 4.082 bayt · 4 girdi · **bütünlük OK** ✅ |
| example.com · sınırsız · bellek modu | ZIP indirildi · 4 girdi · bütünlük OK ✅ |
| Aynı site eskiden (6 sayfa sınırıyla) | 6 sayfa — yani sınırsız mod **20×+ daha fazla** kopyaladı |

**Yol boyunca bulunan hata:** disk akışı yazıcısında yerel başlıktan sonra dosya **adı**
yazılmıyordu (`lh` + `data`, `nb` eksik) → ZIP bozuk çıkıyordu. Birim testiyle (izole ZIP
yazıcısı → Python `zipfile` doğrulaması) yakalanıp düzeltildi. **Ders: ZIP yazıcısını
her zaman bağımsız birim testinden geçir.**

### Surge ile yeniden yayınlama

```bash
export SURGE_LOGIN="<e-posta>" SURGE_TOKEN="<token>"
./deploy/surge.sh                 # → mirrorlab-yunusnavi.surge.sh (motor gömülü)
./deploy/surge.sh baska-ad        # → baska-ad.surge.sh
```

### Worker'ı güncelleme

```bash
export CLOUDFLARE_API_TOKEN="<token>" CLOUDFLARE_ACCOUNT_ID="<hesap-id>"
npx wrangler deploy --config deploy/cloudflare/wrangler.toml
```

## 1) Hızlı karar tablosu

| Yol | RAM / CPU | Chrome çalışır? | Kalıcı disk | Kart gerekir? | Uyku | Sizin için ideal |
|---|---|---|---|---|---|---|
| **Hugging Face Spaces** (Docker) | **2 vCPU / 16 GB** | ✅ rahat | ❌ (50 GB geçici) | ❌ **hayır** | 48 saat hareketsizlikte | *Kart vermeden, bugün yayına almak* |
| **Google Cloud Run** | 1 vCPU / 1–2 GB (ayarlanır) | ✅ | ❌ | ⚠️ evet (ücretsiz kotada ödeme yok) | 0'a iner (scale-to-zero) | *Profesyonel görünüm + otomatik ölçek* |
| **Render** (ücretsiz plan) | 512 MB / 0.1 CPU | ⚠️ sıkışık (LOWMEM) veya kapatın | ❌ | ❌ hayır | 15 dk sonra uyur | *Basit kurulum, hafif kullanım* |
| **Oracle Cloud Always Free** (ARM VM) | **4 OCPU / 24 GB** | ✅ rahat | ✅ 200 GB | ⚠️ evet (doğrulama) | Asla | *7/24 açık, tam kontrol, kalıcı arşiv* |
| **GitHub Actions + Pages** | 2 vCPU / 7 GB (iş süresince) | ✅ | ❌ (artifact 14 gün) | ❌ hayır | Sadece iş çalışırken | *Hiç sunucu tutmak istemiyorum* |
| **Cloudflare (hibrit)** | Worker 10 ms CPU/istek + **Chrome günde 10 dk** | ✅ (10 dk/gün) | ✅ R2 10 GB | ❌ hayır | Uyumaz | *Kenar klonlama + kendi makinen Tunnel ile* |

**Önerim (sıralı):**

1. **Hemen ve kart vermeden yayına almak** → **Cloudflare** (Worker + Browser Rendering + Tunnel). Uyumaz, kart istemez, 100k istek/gün ve **günde 10 dk ücretsiz Chrome** verir. Ayrıntı: [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md)
2. **"Gerçek bir site gibi" davranmasını istiyorum** → **Cloud Run**; ücretsiz kota (ayda 2M istek, 180.000 vCPU-sn) tipik kullanımda yetiyor, uyumaz, kendi alan adınızı bağlayabilirsiniz ([1](https://whichdevtool.com/tools/google-cloud-run/)).
3. **Kalıcı arşiv + 7/24 açık + sınırsız trafik** → **Oracle Always Free ARM VM** (4 OCPU / 24 GB / 200 GB disk / 10 TB çıkış) ([2](https://cloudpricecheck.com/free-tier/oracle)).
4. **Hiç barındırma istemiyorum** → **GitHub Actions** iş akışı: URL girin, ZIP artifact olarak iner.
5. **Uyumayan, sunucusuz bir "ön kapı" + kenarda klonlama istiyorum** → **Cloudflare Worker** (aşağıdaki F yolu).

---

## 5½) Yol F — Cloudflare (önerilen hibrit kurulum)

Cloudflare bu işte iki rolde çok iyi: **kenarda klonlama** (Worker + HTMLRewriter) ve **ücretsiz headless Chrome**
(Browser Rendering: günde 10 dk, CDP uç noktası). Tam kurulum: **[deploy/cloudflare/README.md](deploy/cloudflare/README.md)**

```bash
# 1) Kenar katmanı: arayüz + önizleme + proxy + statik analiz + tek dosya (sunucu yok, uyumaz)
npx wrangler login
npx wrangler deploy --config deploy/cloudflare/wrangler.toml
#   → https://mirrorlab-edge.<hesap>.workers.dev

# 2) Ücretsiz derin analiz: kendi Chrome'unu indirmeden Cloudflare'in tarayıcısına bağlan
PUPPETEER_SKIP_DOWNLOAD=1 npm install puppeteer
export CF_ACCOUNT_ID="<hesap-id>" CF_API_TOKEN="<Browser Rendering - Edit>"
./deploy/cloudflare/run-remote-engine.sh https://ornek.com analiz.json

# 3) (İsteğe bağlı) Tüm özellikli sürümü kendi makinen/Oracle VM'de çalıştırıp ücretsiz HTTPS ile yayınla
cloudflared tunnel login && cloudflared tunnel --url http://localhost:8000
```

Ne kazanırsınız: site **7/24 uyumaz**, neredeyse sıfır maliyet, DDoS koruması, isteğe bağlı
e-posta ile şifre koruması (Zero Trust Access). Ne kaybedersiniz: Worker'da tam ayna (ZIP) yapılmaz —
onun için Actions ya da VM gerekir. Ücretsiz tarayıcı süresi 10 dk/gün ile sınırlıdır
(`mobile=0&probe=0` ile analiz başına ~4-8 sn → günde ~75-150 analiz).

**Doğrulanan ölçümler (bu depoda test edildi):** `/api/analyze` 186 script/60 varlık, `/api/deep`
2.6-3.0 sn'de ağ kaydı + API gövdeleri + tasarım token'ları + ekran görüntüsü, `/api/export`
2.7 MB base64 gömülü HTML, Tunnel üzerinden arayüz/analiz/ZIP aynalama ve SSRF koruması (403).

**Kullanım şartları:** Cloudflare'in eski "Section 2.8 – HTML dışı içerik proxy'lenemez" kısıtı
**Temmuz 2026'da kaldırıldı** ([blog](https://blog.cloudflare.com/updated-tos/)); yine de
"hizmete makul olmayan yük bindirmeme" (2.2) ve telif/robots sorumluluğu kullanıcıya aittir.

---

## 2) Yol A — Hugging Face Spaces ⚠️ ARTIK ÜCRETLİ

> **Temmuz 2026 değişikliği:** HF'de "Static Spaces are free for everyone. Gradio and Docker Spaces
> run on compute and require a paid plan" — yani **Docker Space açmak PRO ($9/ay) gerektiriyor**.
> Ücretsiz hesapla yalnızca statik Space açılabilir. Bu yüzden bu yol ücretsiz değildir; dosyalar
> tarihsel referans olarak duruyor (`deploy/huggingface-README.md`).

Eski (ücretsiz dönem) akış aşağıdaki gibiydi.

```bash
# 1) Spaces → New Space → SDK: Docker → boş şablon oluşturun
# 2) Bu depoyu Space deposuna gönderin:
git clone https://huggingface.co/spaces/<kullanici>/<space-adi>
cd <space-adi>
cp -r /yol/mirrorlab/{Dockerfile,engine.js,server.py,package.json,static} .
cp -r /yol/mirrorlab/{package-lock.json,requirements.txt} . 2>/dev/null
cp /yol/mirrorlab/deploy/huggingface-README.md README.md     # frontmatter zorunlu
git add -A && git commit -m "MirrorLab" && git push
```

* Space ayarlarında (Settings → Variables): `MIRRORLAB_RATE_LIMIT=20`, `MIRRORLAB_ENGINE_CONCURRENCY=1`
* İlk derleme 5–10 dk (Chrome imaja gömülür), sonra `https://<kullanici>-<space>.hf.space` hazır.
* Uykudan uyanma ~30–60 sn: uyanmasını istemiyorsanız `keepalive.yml` iş akışını kullanın.

## 3) Yol B — Google Cloud Run

Avantaj: uyumaz, otomatik ölçeklenir, özel alan adı + ücretsiz HTTPS, dürüst faturalama.
Dezavantaj: faturalandırma hesabı (kart) açmanız gerekir — **kotada kalırsanız fatura 0 ₺**.

```bash
gcloud auth login
gcloud projects create mirrorlab-$(date +%s) --name="MirrorLab"
gcloud config set project <PROJE_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
./deploy/cloudrun.sh          # betiğin içinde tüm ayarlar var
```

Betiğin ayarları: `PORT=8080`, `--memory 1Gi`, `--cpu 1`, `--concurrency 4`, `--min-instances 0`, `--max-instances 3`, `--timeout 300`.
**Kota koruması:** Billing → Budgets & alerts ile 1 $ bütçe uyarısı kurun; `max-instances 3` gereğinden fazla açılmayı engeller.

## 4) Yol C — Render (ücretsiz plan, en kolay)

1. Render panosu → **New > Blueprint** → GitHub deposunu bağlayın (depoda `render.yaml` var).
2. Ayarlar hazır gelir; 512 MB RAM için `MIRRORLAB_LOWMEM=1` işaretlidir.
3. Chrome yine de bellek yetmezse **`MIRRORLAB_ENGINE=off`** yapın: uygulama çalışmaya devam eder
   (önizleme, statik analiz, tek dosya, tam ayna ZIP) — yalnızca "Tarayıcı Analizi" sekmesi kapanır.

Not: ücretsiz servis 15 dk hareketsizlikte uyur ve ayda **750 instance-saat** sınırı vardır ([3](https://agentdeals.dev/vendor/render)).

## 5) Yol D — Oracle Cloud Always Free (7/24 tam güç)

En cömert ücretsiz kaynak: **4 ARM OCPU / 24 GB RAM / 200 GB disk / 10 TB çıkış** ([2](https://cloudpricecheck.com/free-tier/oracle)).
Kart doğrulaması ister; "Always Free" kaynakları süresiz ücretsizdir.

```bash
# VM (Ubuntu 24.04 ARM) içinde:
sudo apt update && sudo apt install -y python3 nodejs npm git caddy
git clone <depo> /opt/mirrorlab && cd /opt/mirrorlab
npm install puppeteer && npx puppeteer browsers install chrome
sudo apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2t64 fonts-liberation libxshmfence1
sudo useradd -r -s /usr/sbin/nologin mirrorlab && sudo chown -R mirrorlab:mirrorlab /opt/mirrorlab
sudo cp deploy/mirrorlab.service /etc/systemd/system/ && sudo systemctl enable --now mirrorlab
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # alan adınızı yazın → otomatik HTTPS
sudo systemctl reload caddy
```

Alan adı istemiyorsanız **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:8000`) ile
ücretsiz HTTPS'li geçici adres alabilirsiniz.

## 6) Yol E — Sunucusuz: GitHub Actions + Pages (hiç barındırma yok)

Sunucu yok, uyku yok, kota derdi yok — "iş" olarak çalışır:

1. Depoyu GitHub'a atın (`.github/`, `Dockerfile`, `engine.js`, `server.py` dahil).
2. Actions → **"Site aynala (sunucusuz)"** → Run workflow → adres + sayfa sınırı girin.
3. İş bitince **artifact** olarak `mirror.zip` (+ isterseniz `analysis.json` kanıt paketi ve özet) iner.

Artifact'lar 14 gün saklanır (değiştirilebilir). Public repolarda Actions dakikaları ücretsizdir.
Arayüzü statik olarak yayınlamak isterseniz: `static/index.html`'i GitHub Pages'te barındırıp,
içindeki `fetch("/api/...")` çağrılarını kendi backend adresinize yönlendirmeniz gerekir (sunucu CORS'a açıktır).

---

## 7) Ortam değişkenleri (tüm yollarda aynı)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `8000` | Dinlenecek port (Cloud Run: `8080`, HF: `8000`) |
| `MIRRORLAB_ENGINE` | `auto` | `auto` · `on` (zorla) · `off` (tarayıcı motoru kapanır, gerisi çalışır) |
| `MIRRORLAB_ENGINE_CONCURRENCY` | `1` | Aynı anda kaç headless Chrome (RAM'in izin verdiği kadar) |
| `MIRRORLAB_RATE_LIMIT` | `40` | **IP başına saatlik** analiz/aynalama; `0` = sınırsız (özel kullanım) |
| `MIRRORLAB_LOWMEM` | `0` | `1`: `--single-process`, mobil görüntü kapalı, kaydırma kısıtlı → 512 MB planlar için |
| `MIRRORLAB_MAX_PAGES` | `60` | Aynalamada üst sınır (kaynak koruması) |
| `MIRRORLAB_MAX_ASSETS` | `400` | Varlık üst sınırı |
| `MIRRORLAB_MAX_MB` | `80` | Aynalama toplam boyut tavanı |

Herkese açık bir kurulum için önerilen: `MIRRORLAB_RATE_LIMIT=20–40`, `MIRRORLAB_ENGINE_CONCURRENCY=1`.

## 8) Genel bir sunucuya koymadan önce: güvenlik kontrol listesi

- [x] **SSRF koruması** kodda açık: `localhost`, özel/loopback/link-local IP'ler ve bulut metadata adresleri reddedilir.
- [x] `robots.txt`'e uyum (kapatılabilir ama açık kalsın).
- [x] İstek hız sınırı + eşzamanlılık kilidi + boyut tavanları (kaynak tüketimi koruması).
- [x] Klon iframe'i `sandbox` içinde; form gönderimi/popup engelli.
- [ ] **Loglama/sorumluluk:** kötüye kullanım (kimlik avı klonu) şikâyeti gelirse kaynağı gösterebilin; erişim loglarını saklayın.
- [ ] **Kullanım şartları sayfası:** arayüzdeki etik not yeterli olmayabilir; siz de "yalnızca izinli/inceleme amaçlı" metni ekleyin.
- [ ] **Alan adı + gizlilik:** kişisel veri işlemiyorsunuz ama ziyaretçi IP'si loglanır — kısa bir gizlilik notu ekleyin.
- [ ] **Kaynak bütçesi:** ücretsiz planlarda `max-instances` ve `RATE_LIMIT` değerlerini düşük tutun.

## 9) Alan adı ve HTTPS

| Yol | Ücretsiz adres | Kendi alan adı |
|---|---|---|
| HF Spaces | `*.hf.space` | Desteklenmez (yol gösterilebilir) |
| Cloud Run | `*.run.app` | ✅ Domain mapping (ücretsiz sertifika) |
| Render | `*.onrender.com` | ✅ 2 özel alan adı |
| Oracle VM | IP adresi | ✅ Caddy + Let's Encrypt otomatik |
| GitHub Pages | `*.github.io` | ✅ |

Ücretsiz alan adı: **Cloudflare** üzerinden alınan `.com` dışı uzantılar ~1 $/yıl; tamamen ücretsiz için
`eu.org` gibi ücretsiz alt alan adı servisleri veya DuckDNS (`*.duckdns.org`) kullanılabilir.

## 10) Bu depodaki dağıtım dosyaları

```
Dockerfile                     # tek konteyner: Python + Node + Chrome
deploy/cloudflare/             # Worker (edge klonlayıcı) + wrangler.toml + uzak-tarayıcı betiği
docker-compose.yml             # kendi sunucunuz / ev bilgisayarınız
render.yaml                    # Render Blueprint (ücretsiz plan)
deploy/cloudrun.sh             # Cloud Run dağıtımı (kota korumalı)
deploy/huggingface-README.md   # HF Space için frontmatter'lı README
deploy/Caddyfile               # kendi sunucunuzda otomatik HTTPS
deploy/mirrorlab.service       # systemd servisi
.github/workflows/serverless-mirror.yml  # sunucusuz aynalama (artifact)
.github/workflows/docker-ghcr.yml        # imajı GHCR'e derle
.github/workflows/keepalive.yml          # (opsiyonel) uykuyu engelle
```

---

### Tek cümlelik cevap

**Bugün, kart vermeden yayına almak istiyorsan: Cloudflare** (Worker + Browser Rendering + Tunnel).
Uyumayan ve profesyonel bir adres istiyorsan: Cloud Run. Sunucu yönetmeden klon üretmek istiyorsan: GitHub Actions.

### Render kotası dolduysa (750 instance-saat/ay)

1. Render ücretsiz kotası **ayın 1'inde sıfırlanır** — 1 Kasım'da `render.yaml` ile yeniden deploy edin.
2. O güne kadar Cloudflare yolunu kullanın (yukarıdaki F yolu): Worker uyumaz, kart istemez.
3. Kullanılmayan Render servislerini silin ki boşuna saat harcamasın.

### 🧬 Paket 2 — REA derinliği (16 Ekim 2026)

Tarayıcı analizinin altına dört katmanlı **"Tersine mühendislik paketi (REA derinliği)"** kartı eklendi
(`static/_mirror_derin.src.js` → `renderDerin`). Hepsi gözlemlenen kanıttan çalışır; tahmin üretmez.

| Katman | Ne yapar | Veri kaynağı |
|---|---|---|
| 🧩 Teknoloji ve sürüm envanteri | Çatı, CMS, kütüphane, CDN, analitik araçlarını **sürümüyle** listeler | ham HTML (`/api/raw`), varlık URL'leri, yanıt başlıkları |
| 🛡️ Güvenlik başlıkları raporu | HSTS, CSP, nosniff, clickjacking, referrer/permissions policy, COOP/COEP, çerez bayrakları + puan | `/api/hdr` (hedefin ham yanıt başlıkları) |
| 🧾 API şema taslağı | Gözlemlenen XHR/fetch çağrılarından **OpenAPI 3.1 YAML** taslağı + indir/kopyala | `/api/deep` ağ kaydı (`jsonShape`), yol normalizasyonu (`/42` → `/{id}`) |
| 🧬 Orijinal kaynak ağacı | JS paketlerindeki `sourceMappingURL` izlenir; `sourcesContent`'ten **orijinal kaynaklar** çıkarılır | `/api/raw` (JS + `.map`) |

**Tam Ayna ile bütünleşme:** kopyalama sırasında her JS dosyası taranır; bulunan haritalar indirilip
orijinal kaynaklar ZIP'e `_kaynak/<js-yolu>/<kaynak-yolu>` olarak eklenir (+ `_kaynak/OKUBENI.txt`).
Tavanlar: 20 harita, 600 dosya, 30 MB, harita başına 8 MB (`KAYNAK_MAX_*`).

**Canlı kanıt (16 Ekim 2026):** `kaynak-test.html` (chart.js@4.4.1 CDN'den) →
teknoloji kartı `Chart.js 4.4.1`; API taslağı 1 yol; kaynak taraması **74 orijinal dosya / 0,56 MB**;
Tam Ayna ZIP'i 79 girdi, `_kaynak/…/src/helpers/helpers.core.ts` gerçek TypeScript kaynağı (12 KB),
`testzip()` OK, yol kaçışı yok. Birim testler: 20/20 (YAML gerçek ayrıştırıcıyla da doğrulandı).

**Bu pakette bulunan iki hata (ikisi de düzeltildi):**
1. **`sourceMappingURL=` dilimi bir karakter kayıyordu** → harita yolu `ain.js.map` gibi bozuk çıkıyordu.
2. **robots.txt kuralı yanlış alan adına uygulanıyordu:** CDN'den (başka sunucu) gelen dosyalar seed
   sitenin kurallarıyla engelleniyordu. robots.txt **alan adı başına** geçerlidir; artık yalnızca
   `o.host === seedHost` iken denetlenir.

**Yeni uç nokta:** `GET /api/hdr?u=<adres>` → `{ok, status, finalUrl, headers}` (ham yanıt başlıkları,
en çok 60 başlık, 500 karakter/başlık). Hız sınırına tabi değil (ucuz istek).

**Yayın akışı (tek komut):** `bash deploy/yayinla.sh` → `embed.sh` (modülleri `index.html`'e gömer)
→ `build.sh` (HF kabuğu) → Surge → HF. Sıra önemlidir: **önce göm, sonra üret, sonra yayınla.**

### 🧰 Paket 3 — kullanım kolaylığı (16 Ekim 2026)

`static/_kolaylik.src.js` — dört özellik, hepsi tarayıcıda (localStorage), sunucuya veri gitmez:

| Özellik | Nasıl çalışır | Arayüz |
|---|---|---|
| 🕘 Analiz geçmişi | Son 30 analiz (adres, uygunluk puanı, teknoloji, güvenlik, API/kaynak sayısı) `mirrorlab_gecmis_v1` anahtarında | Analiz sekmesi → "🕘 Analiz geçmişi" → tablo + "↻ yeniden analiz" |
| 🔗 Paylaşılabilir rapor | Özet JSON'u base64url ile **bağlantının kendisine** gömülür (`#rapor=…`); açan kişi sonuçları sunucusuz görür | "🔗 Rapor bağlantısı" → pano + güvenli yedek panel |
| ⏸/▶ Yarıda kalan kopya | Kuyruk + ayarlar `mirrorlab_oturum_v1` anahtarına yazılır; durdurulan kopya yeniden açılışta hatırlanır | Ayna sekmesi → "⏸ Duraklat" düğmesi + açılışta "kaldığı yerden devam et" kartı |
| 🧪 Öğe denetçisi | Klonun çevrimdışı kopyası `srcdoc` iframe'e yüklenir; tıkla → etiket, sınıf, kutu modeli, hesaplanmış stiller, HTML parçası | Önizleme → "🧪 Öğe denetçisi" |

**Canlı kanıt (16 Ekim 2026):** boş geçmiş mesajı ve 2 kayıtlı tablo; durdurulan kopya (2 sayfa, 30 adres
sırada) yeniden açılışta hatırlandı ve "kaldığı yerden devam" ile **60 sayfaya kadar tamamlandı**;
paylaşılan rapor bağlantısı ikinci bir tarayıcı sayfasında kart olarak açıldı (Chart.js 4.4.1 + uygunluk
55/100); öğe denetçisi klonda `html > body > h1` seçicisini, 660×35 kutusunu ve `font-size:30px`
değerini gösterdi. Birim testler: 8/8.

**Not (dürüst sınır):** durdurulmuş kopyada yalnızca **kuyruk ve ayarlar** saklanır; indirilen dosya
içerikleri tarayıcı belleğinde olduğu için devam ederken sayfalar **yeniden indirilir**.

### 👁 Paket 4 — izleme ve fark (16 Ekim 2026)

`static/_izleme.src.js`:

| Özellik | Nasıl çalışır |
|---|---|
| 📸 Anlık görüntü | Sayfa `/api/raw` ile çekilir; başlık, açıklama, metin (14 KB), h1-h3 listesi, varlık listesi (host+yol) ve renk/font token'ları kaydedilir. Adres başına 6 görüntü, en çok 40 adres |
| 🔍 Fark | İki görüntü **cümle kümesi** olarak karşılaştırılır: eklenen/kalkan metin, yeni/kalkan başlık, varlık, renk ve font + metin farkı yüzdesi |
| 👁 İzleme listesi | Adres "izlemeye alınır"; sayfa **açıkken** süresi gelenler (24 saat) kontrol edilir, değişiklik olursa uygulama içi bildirim + (izin verilmişse) tarayıcı bildirimi |
| 🎨 Tasarım token geçmişi | İzleme tablosunda her adresin renk paleti noktalarla gösterilir; fark kartı renk/font eklenmesini ve kalkmasını listeler |

**Canlı kanıt (16 Ekim 2026):** referans alındıktan sonra "değişiklik yok %0"; hedef sayfaya iki cümle ve
bir fuşya renk eklendiğinde **"değişiklik: %67"** ve "3 yeni cümle · 1 kalkmış cümle"; izleme listesi
👁 işareti ve %67 özetiyle güncellendi; "süresi gelenleri şimdi kontrol et" akışı çalıştı. Birim testler: 15/15.

**Dürüst sınır:** MirrorLab tamamen istemci tarafı olduğu için periyodik kontroller **yalnızca sayfa
açıkken** yapılır; sunucu tarafı zamanlayıcı (Cron) bu sürümde yok. Bildirim için tarayıcı izni gerekir.

### 🧭 Yayın betikleri

- `bash deploy/embed.sh` — motor + modülleri (`_edge_mirror`, `_mirror_fit`, `_mirror_derin`, `_kolaylik`, `_izleme`) `static/index.html` içine gömer, söz dizimini `node --check` ile doğrular.
- `bash deploy/yayinla.sh` — göm → HF kabuğunu üret → Surge → HF (Surge token'ı ortam değişkeninden okunur).
- Sıra önemli: **önce göm, sonra üret, sonra yayınla.** (Ara bir testte ters sıra yüzünden eski `index.html` yayınlandı; betik artık bunu tek komutta doğru yapıyor.)
