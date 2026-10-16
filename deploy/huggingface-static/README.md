---
title: MirrorLab
emoji: 🧪
colorFrom: indigo
colorTo: blue
sdk: static
pinned: false
license: mit
short_description: Site tersine mühendislik stüdyosu — arayüz
---

# 🧪 MirrorLab — tarayıcı kabuğu

Bu Space **statiktir** (ücretsiz hesapla açılabilen tek tür). Arayüzün tamamı burada çalışır;
klonlama/analiz işini yapan **arka uç** ayrı bir yerde koşar ve bu sayfa ona bağlanır.

Neden böyle? Hugging Face, Temmuz 2026'dan beri **Docker ve Gradio Space'leri ücretli plana**
(PRO $9/ay) bağladı. Ücretsiz hesapla yalnızca "Static" Space açılabiliyor. Bu yüzden MirrorLab'ı
iki parçaya ayırdık: arayüz (burası, bedava ve kalıcı) + motor (kart istemeyen Cloudflare ya da
kendi makinen).

## Nasıl kullanılır?

1. Sayfanın sağ üstündeki **⚙︎ Arka uç** düğmesine bas.
2. Arka uç adresini gir:
   * `https://mirrorlab-edge.<hesabın>.workers.dev` → Cloudflare Worker (kurulum: `./deploy/cloudflare/publish.sh`)
   * `http://localhost:8000` → kendi bilgisayarında `python3 server.py` (tarayıcılar localhost'u
     güvenli sayar, HTTPS sayfadan bile çağrılabilir)
   * `https://<rastgele>.trycloudflare.com` → `./deploy/tunnel.sh` ile açtığın genel tünel
3. **Bağlan** → sağlık kontrolü yapılır, "motor: cloudflare-worker" yazısını görürsen hazır.

Adres `?api=https://...` olarak da verilebilir; tarayıcıda saklanır.

## Hangi arka uç ne yapar?

| | Cloudflare Worker (edge) | Kendi makinen (`tunnel.sh`) |
|---|---|---|
| Klon önizleme, statik analiz, tek dosya export | ✅ | ✅ |
| Derin tarayıcı analizi (`/api/deep`, günde 10 dk Chrome) | ✅ | ✅ (Chrome yerel) |
| Tam site aynalama → ZIP | ❌ (Worker sınırları) | ✅ |

## Etik kullanım

Araç kamuya açık sayfaları **inceleme, öğrenme ve arşivleme** için klonlar. Tasarımın, metnin ve
kodun telif hakkı sahiplerine aittir; `robots.txt`'e uyulur. Kimlik avı/taklit amaçlı kullanım yasaktır.
