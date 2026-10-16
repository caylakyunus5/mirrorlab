---
title: MirrorLab
emoji: 🧪
colorFrom: indigo
colorTo: cyan
sdk: docker
app_port: 8000
pinned: false
license: mit
short_description: Site tersine mühendislik stüdyosu — ağ, API, tasarım sistemi, ekran görüntüleri
---

> ⚠️ **Temmuz 2026 notu:** Hugging Face'te Gradio ve **Docker Space açmak artık ücretli plan (PRO $9/ay)
> gerektiriyor**; ücretsiz hesapla yalnızca "Static" Space açılabiliyor. Bu dosya, ücretsiz dönemde
> kullanılan kurulum akışını belgelemek için tutuluyor. Ücretsiz bir yayın için Cloudflare yolunu
> kullanın: `deploy/cloudflare/README.md`.

# 🧪 MirrorLab

Kamuya açık bir web sitesini **gerçek headless Chrome'da** açıp analiz eden yerel araç:
ağ trafiği, API çağrıları, render edilmiş DOM, tasarım token'ları, ekran görüntüleri, site aynası (ZIP).

## Bu Space nasıl çalışır?

* Kapsayıcı aynı anda hem Python sunucusunu (arayüz + proxy + aynalayıcı) hem de
  Node/Puppeteer tarayıcı motorunu çalıştırır.
* Ücretsiz CPU Basic donanımı: **2 vCPU / 16 GB RAM** — Chrome burada rahat çalışır.
* Space **48 saat hareketsizlikte uyur**; ilk ziyarette ~30-60 sn'de uyanır.
* Depolama kalıcı değildir: arşivler ve ekran görüntüleri Space yeniden başladığında silinir.
  İndirilen ZIP'ler bu yüzden hemen kaydedilmelidir.

## Kurulum (Space sahibi için)

1. huggingface.co → **New Space** → SDK: **Docker** → boş şablon.
2. Bu repodaki dosyaları Space deposuna gönderin (Dockerfile, engine.js, server.py, static/, package.json).
3. Bu dosyayı Space'in kök `README.md`'si olarak kullanın (üstteki frontmatter zorunlu).
4. (İsteğe bağlı) Space ayarlarından ortam değişkenleri:
   `MIRRORLAB_RATE_LIMIT=20`, `MIRRORLAB_ENGINE_CONCURRENCY=1`, `MIRRORLAB_MAX_PAGES=40`
5. İlk derleme 5-10 dk sürer (Chrome imaja gömülür), sonra hazır.

## Etik kullanım

Araç, kamuya açık sayfaları **inceleme, öğrenme ve arşivleme** için klonlar. Klonlanan tasarım,
metin ve kodların telif hakkı sahiplerine aittir. `robots.txt`'e uyulur; kimlik avı/taklit amaçlı
kullanım yasaktır. Space herkese açık olduğundan, kötüye kullanımı önlemek için hız sınırı açıktır.
