  /* ═══════════════ REA DERİNLİĞİ (Paket 2) ═══════════════════════════════════
     Dört ek analiz katmanı:
       1) Teknoloji & sürüm envanteri — HTML/varlık URL'leri/başlıklardan kanıtlı tespit
       2) Güvenlik başlıkları raporu — /api/hdr ile ham yanıt başlıkları
       3) API şema taslağı — yakalanan uç noktalardan OpenAPI 3.1 YAML taslağı
       4) Orijinal kaynak ağacı — source map taraması (tam çıktı Tam Ayna ZIP'inde)
     ═══════════════════════════════════════════════════════════════════════ */

  const DERIN_RENK = { iyi: "#7dfa9b", orta: "#ffd479", kotu: "#ff6b5e", notr: "#a87200" };

  function dk(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* /api/raw üzerinden sınırlı boyutta metin indir */
  async function derinHam(u, sinirMb) {
    const sinir = (sinirMb || 2) * 1048576;
    try {
      const r = await fetch(apiUrl("/api/raw?u=" + encodeURIComponent(u)));
      if (!r.ok) return { ok: false, metin: "", status: r.status };
      const b = await r.arrayBuffer();
      const dilim = b.byteLength > sinir ? b.slice(0, sinir) : b;
      return { ok: true, metin: new TextDecoder().decode(dilim), kesik: b.byteLength > sinir, status: r.status };
    } catch (e) { return { ok: false, metin: "", status: 0 }; }
  }

  /* Ham yanıt başlıkları (/api/hdr) */
  async function derinBasliklar(u) {
    try {
      const r = await fetch(apiUrl("/api/hdr?u=" + encodeURIComponent(u)));
      const j = await r.json();
      return j && j.ok ? j : { ok: false, hata: (j && j.error) || ("HTTP " + r.status), headers: {} };
    } catch (e) {
      return { ok: false, hata: "motorun /api/hdr uç noktasına ulaşılamadı (yayındaki motor eskiyse güncellenmesi gerekir)", headers: {} };
    }
  }

  /* ── 1) TEKNOLOJİ & SÜRÜM ENVANTERİ ───────────────────────────────────── */
  /* Her kural: kanıt metni + sürüm çıkarımı. Gevşek eşleşme yok; kanıt zorunlu. */
  function derinTeknoloji(ctx) {
    const H = ctx.html || "", U = (ctx.urlMetni || ""), M = ctx.basliklar || {};
    const bulunan = [];
    const ekle = (ad, surum, kanit, tur) => {
      if (bulunan.some(x => x.ad.toLowerCase() === ad.toLowerCase())) return;
      bulunan.push({ ad, surum: surum || "", kanit: String(kanit).slice(0, 90), tur: tur || "HTML" });
    };
    const surumAl = (kaynak, re) => { const m = kaynak.match(re); return m && m[1] ? m[1] : ""; };

    /* çatılar */
    if (/\/_next\/static\/|__NEXT_DATA__/.test(H + U)) {
      let s = surumAl(H, /"buildId"\s*:\s*"([^"]+)"/) ? "" : "";
      s = surumAl(H, /"next"\s*:\s*"(\d+[\d.]*)"/) || surumAl(U, /\/_next\/(?:static|image)[^\s"']{0,60}?@(\d+\.\d+(?:\.\d+)?)/) || s;
      ekle("Next.js", s, "__NEXT_DATA__ / /_next/static/");
    }
    if (/__NUXT__|\/_nuxt\//.test(H + U)) ekle("Nuxt", surumAl(U, /\/_nuxt\/(?:v)?(\d+[\d.]*)/), "__NUXT__ / /_nuxt/");
    const reReact = /react(?:-dom)?[@/](\d+\.\d+(?:\.\d+)?)|react(?:-dom)?[@/]v?(\d+\.\d+(?:\.\d+)?)/i;
    const mReact = U.match(reReact);
    if (mReact || /data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__|react\.production\.min\.js/.test(H + U))
      ekle("React", (mReact && (mReact[1] || mReact[2])) || "", mReact ? "varlık URL'i" : "data-reactroot / React runtime");
    const mVue = U.match(/vue(?:@|\.)(\d+\.\d+(?:\.\d+)?)/i);
    if (mVue || /data-v-app|__VUE__|v-app/.test(H + U)) ekle("Vue.js", mVue ? mVue[1] : "", mVue ? "varlık URL'i" : "data-v-app");
    const mNg = (H + U).match(/ng-version="(\d+\.\d+\.\d+)"|angular[@/](\d+\.\d+\.\d+)/i);
    if (mNg) ekle("Angular", mNg[1] || mNg[2] || "", "ng-version / varlık URL'i");
    if (/svelte/i.test(U) || /__svelte/.test(H)) ekle("Svelte", surumAl(U, /svelte[@/](\d+\.\d+(?:\.\d+)?)/i), "varlık URL'i / __svelte");
    const mJq = (H + U).match(/jquery[.-](\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js|jQuery\s+v?(\d+\.\d+(?:\.\d+)?)/i);
    const jqDosya = /jquery(?:\.min)?\.js|\/jquery(?:-|\/)/i.test(U + " " + H);
    if (mJq) ekle("jQuery", mJq[1] || mJq[2] || "", "jquery betik dosyası (sürüm damgalı)");
    else if (jqDosya) ekle("jQuery", "", "jquery betik dosyası (sürüm damgası yok)");
    const mBs = (H + U).match(/bootstrap[@/](\d+\.\d+(?:\.\d+)?)|Bootstrap\s+v(\d+\.\d+(?:\.\d+)?)/i);
    if (mBs || /bootstrap\.min\.(?:css|js)/i.test(U)) ekle("Bootstrap", (mBs && (mBs[1] || mBs[2])) || "", "bootstrap dosyası / sürüm damgası");
    if (/--tw-|tailwind/i.test(ctx.cssMetni || "") || /tailwind/i.test(U)) ekle("Tailwind CSS", surumAl(U, /tailwind(?:css)?[@/](\d+\.\d+(?:\.\d+)?)/i), "--tw-* değişkenleri / dosya adı");
    if (/font-awesome|fa-solid-900|fontawesome/i.test(H + U)) ekle("Font Awesome", surumAl(H + U, /font-?awesome[@/]?(\d+\.\d+(?:\.\d+)?)/i), "fa-* simge dosyaları");

    /* yaygın JS kütüphaneleri (kanıt: varlık URL'indeki sürüm damgası ya da imza) */
    const kutuphane = [
      ["Chart.js", /chart(?:\.js)?[@/](?:js[@/])?(\d+\.\d+(?:\.\d+)?)|chart\.umd(?:\.min)?\.js|new\s+Chart\s*\(/i],
      ["D3.js", /(?:^|[/@])d3(?:\.v)?[@/]?(\d+(?:\.\d+)*)\.[\w.-]*\.js|d3\.v(\d)\.min\.js|d3\.select\s*\(/i],
      ["Three.js", /three[@/](\d+\.\d+(?:\.\d+)?)|three(?:\.module)?(?:\.min)?\.js/i],
      ["Lodash", /lodash[@/](\d+\.\d+(?:\.\d+)?)|lodash(?:\.min)?\.js|_\.[a-z]+\(/i],
      ["GSAP", /gsap[@/](\d+\.\d+(?:\.\d+)?)|gsap(?:\.min)?\.js|TweenMax/i],
      ["Swiper", /swiper[@/](\d+\.\d+(?:\.\d+)?)|swiper-bundle/i],
      ["Slick (karusel)", /slick(?:\.min)?\.(?:js|css)|slick-carousel/i],
      ["Leaflet", /leaflet[@/](\d+\.\d+(?:\.\d+)?)|leaflet(?:\.min)?\.(?:js|css)|L\.map\s*\(/i],
      ["Alpine.js", /alpinejs[@/](\d+\.\d+(?:\.\d+)?)|alpine(?:\.min)?\.js|x-data=/i],
      ["HTMX", /htmx(?:[@/]|\.min\.js)|hx-get=/i],
      ["Socket.IO", /socket\.io[@/](\d+\.\d+(?:\.\d+)?)|socket\.io(?:\.min)?\.js/i],
      ["Google Maps JS API", /maps\.googleapis\.com\/maps\/api\/js(?:[^"'<>]*?[?&]v=(weekly|quarter|[\d.]+))?/i],
      ["Google reCAPTCHA", /google\.com\/recaptcha|grecaptcha|recaptcha\/api\.js/i],
      ["hCaptcha", /hcaptcha\.com\/1\/api\.js|h-captcha/i],
      ["Video.js / HLS", /video(?:\.min)?\.js|hls\.js|dash\.all\.min\.js/i],
      ["PDF.js", /pdf(?:\.min)?\.js|pdfjs-dist/i],
      ["Sentry (izleme)", /sentry[.-]|@sentry\//i],
      ["Phaser (Oyun Motoru)", /phaser[@/](\d+[\d.]*)|phaser(?:\.min)?\.js|Phaser\.Game/i],
      ["Pixi.js (2D WebGL)", /pixi(?:\.js)?[@/](\d+[\d.]*)|pixi(?:\.min)?\.js|PIXI\.Application/i],
      ["Unity WebGL", /createUnityInstance|UnityLoader|\.unityweb/i],
      ["Godot Engine (HTML5)", /godot(?:\.min)?\.js|engine\.wasm|\.pck/i],
      ["Construct (Oyun Motoru)", /c2runtime\.js|c3runtime\.js/i],
      ["Cocos2d (Oyun Motoru)", /cocos2d-js|cc\.game/i],
      ["Hls.js (Video Akışı)", /hls(?:\.min)?\.js|Hls\.isSupported/i],
      ["Video.js", /video(?:\.min)?\.js|vjs-tech|videojs\(/i],
    ];
    const htt = H + "\n" + U;
    for (const [ad, re] of kutuphane) {
      const m = htt.match(re);
      if (!m) continue;
      const surum = (m.slice(1).find(x => x) || "").replace(/^js$/, "");
      const kanit = U && U.indexOf(m[0]) > -1 ? "varlık URL'i" : "HTML imzası";
      ekle(ad, surum, kanit + " · " + String(m[0]).slice(0, 60), kanit === "varlık URL'i" ? "varlık URL'i" : "HTML");
    }

    /* içerik yönetim sistemleri */
    const mWp = H.match(/<meta name="generator" content="WordPress ([\d.]+)"/i);
    if (mWp) ekle("WordPress", mWp[1], "generator meta");
    else if (/\/wp-content\/|\/wp-includes\//.test(H + U)) ekle("WordPress", surumAl(H, /ver=(\d+\.\d+(?:\.\d+)?)/), "wp-content/wp-includes yolları");
    const mDr = H.match(/<meta name="Generator" content="Drupal ([\d.]+)/i);
    if (mDr || /\/sites\/(?:all|default)\/(?:files|modules)/.test(H)) ekle("Drupal", mDr ? mDr[1] : "", mDr ? "generator meta" : "sites/default yolları");
    if (/cdn\.shopify\.com|Shopify\.theme/.test(H)) ekle("Shopify", surumAl(H, /Shopify\.theme\s*=\s*\{[^}]*"name"\s*:\s*"([^"]+)"/), "Shopify.theme / cdn.shopify.com");
    if (/Magento_|mage\/cookies|\/static\/version/.test(H + U)) ekle("Magento", "", "Magento_* sınıfları");
    const mGh = M["x-generator"] || "";
    if (mGh) ekle("Sunucu jeneratörü", mGh, "x-generator başlığı", "başlık");
    const mGen = H.match(/<meta name="generator" content="([^"]{2,60})"/i);
    if (mGen && !/WordPress|Drupal/i.test(mGen[1])) ekle("Jeneratör (meta)", mGen[1], "generator meta");

    /* altyapı / CDN / sunucu */
    if (M["cf-ray"] || /cdn-cgi\/|__cf_bm/.test(H)) ekle("Cloudflare", "", "cf-ray başlığı / cdn-cgi", "başlık");
    if (M["x-vercel-id"] || M["x-vercel-cache"]) ekle("Vercel", "", "x-vercel-* başlıkları", "başlık");
    if (/x-amz-cf-id/.test(Object.keys(M).join(","))) ekle("AWS CloudFront", "", "x-amz-cf-id", "başlık");
    if (M["server"]) { const s = String(M["server"]); if (/nginx|apache|cloudflare|litespeed|iis|caddy|gunicorn|envoy/i.test(s)) ekle("Sunucu yazılımı", s, "server başlığı", "başlık"); }
    const mPhp = (M["x-powered-by"] || "");
    if (mPhp) ekle("Altyapı (x-powered-by)", mPhp, "x-powered-by başlığı", "başlık");

    /* analitik / pazarlama betikleri */
    const mGa = (H + U).match(/googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]+|UA-[\d-]+|AW-[\d]+)/i);
    if (mGa) ekle("Google Analytics 4 / Ads", mGa[1], "gtag yükleme kimliği");
    const mGtm = (H + U).match(/googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]+)/i);
    if (mGtm) ekle("Google Tag Manager", mGtm[1], "gtm.js kapsayıcı kimliği");
    if (/connect\.facebook\.net|fbq\(\s*['"]init/i.test(H)) ekle("Meta Pixel", surumAl(H, /fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,})/), "fbq init / connect.facebook.net");
    if (/static\.hotjar\.com|hj\(\s*['"]/i.test(H)) ekle("Hotjar", "", "static.hotjar.com");
    if (/clarity\.ms|clarity\(/i.test(H)) ekle("Microsoft Clarity", surumAl(H, /clarity\.ms\/tag\/([a-z0-9]+)/i), "clarity.ms");
    if (/sentry[.-]|@sentry\//i.test(H + U)) ekle("Sentry", surumAl(U, /@sentry\/(?:browser|core)[@/](\d+\.\d+\.\d+)/i), "Sentry yükleyicisi");
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(H + U)) ekle("Google Fonts", "", "fonts.googleapis.com");
    if (/unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(U)) ekle("Genel CDN", "", "unpkg / jsdelivr / cdnjs yolları", "varlık URL'i");

    return bulunan.sort((a, b) => (b.surum ? 1 : 0) - (a.surum ? 1 : 0) || a.ad.localeCompare(b.ad, "tr"));
  }

  /* ── 2) GÜVENLİK BAŞLIKLARI RAPORU ───────────────────────────────────── */
  function derinGuvenlikDegerlendir(h, status) {
    const bulgular = [];
    const g = (k) => String((h && (h[k] || h[k.toLowerCase()])) || "").trim();
    const varMi = (k) => !!g(k);
    const ekle = (ad, durum, aciklama) => bulgular.push({ ad, durum, aciklama });

    const hsts = g("strict-transport-security");
    if (hsts) {
      const yas = parseInt((hsts.match(/max-age=(\d+)/i) || [])[1] || "0", 10);
      ekle("HSTS (strict-transport-security)", yas >= 15552000 ? "iyi" : "orta", yas >= 15552000 ? "max-age " + yas + " sn (≥180 gün)" : "max-age " + (yas || 0) + " sn — 15552000 (180 gün) altı zayıf sayılır" + (/includeSubDomains/i.test(hsts) ? " · includeSubDomains var" : ""));
    } else ekle("HSTS (strict-transport-security)", "kotu", "yok — HTTP'ye düşürme saldırısına karşı koruma yok");

    const csp = g("content-security-policy");
    if (csp) {
      const unsafe = /unsafe-inline|unsafe-eval/i.test(csp);
      ekle("CSP (content-security-policy)", unsafe ? "orta" : "iyi", unsafe ? "var ama 'unsafe-inline'/'unsafe-eval' içeriyor -> XSS koruması zayıf" : "tanımlı, tehlikeli anahtar sözcük görünmüyor");
    } else ekle("CSP (content-security-policy)", "kotu", "yok — içerik enjeksiyonuna karşı tarayıcı düzeyinde koruma yok");

    const xcto = g("x-content-type-options");
    ekle("x-content-type-options", /nosniff/i.test(xcto) ? "iyi" : "kotu", /nosniff/i.test(xcto) ? "nosniff" : "nosniff yok — MIME sniffing riski");

    const xfo = g("x-frame-options"), cspFa = /frame-ancestors/i.test(csp);
    ekle("Clickjacking koruması (x-frame-options / frame-ancestors)", (xfo || cspFa) ? "iyi" : "kotu", xfo ? "x-frame-options: " + xfo : (cspFa ? "CSP frame-ancestors ile sınırlanmış" : "ikisi de yok"));

    const ref = g("referrer-policy");
    ekle("referrer-policy", ref ? "iyi" : "orta", ref || "yok — varsayılan politika kullanılır");

    const perm = g("permissions-policy") || g("feature-policy");
    ekle("permissions-policy", perm ? "iyi" : "orta", perm ? perm.slice(0, 70) : "yok — kamera/mikrofon/konum izinleri kısıtlanmamış");

    const coop = g("cross-origin-opener-policy"), coep = g("cross-origin-embedder-policy");
    ekle("cross-origin izolasyon (COOP/COEP)", (coop && coep) ? "iyi" : (coop || coep) ? "orta" : "notr", (coop || "-") + " / " + (coep || "-"));

    const ck = g("set-cookie");
    if (ck) {
      const bayrak = ["Secure", "HttpOnly", "SameSite"].filter(b => new RegExp(b + "\\b", "i").test(ck));
      ekle("Çerez bayrakları", bayrak.length === 3 ? "iyi" : bayrak.length >= 1 ? "orta" : "kotu", "görülen bayraklar: " + (bayrak.join(", ") || "yok") + " (yalnızca bu yanıttaki ilk çerez)");
    } else ekle("Çerez bayrakları", "notr", "bu yanıtta set-cookie yok");

    ekle("Sürüm ifşası (server / x-powered-by)", (varMi("server") || varMi("x-powered-by")) ? "orta" : "iyi", [g("server"), g("x-powered-by")].filter(Boolean).join(" · ") || "sürüm bilgisi sızdırılmıyor");

    const asgari = bulgular.filter(b => b.durum === "iyi").length;
    const olculebilir = bulgular.filter(b => b.durum !== "notr").length;
    return { bulgular, skor: olculebilir ? Math.round(100 * asgari / olculebilir) : 0, status };
  }

  /* ── 3) API ŞEMA TASLAĞI (OpenAPI 3.1) ───────────────────────────────── */
  function derinSemayaCevir(sekil) {
    if (Array.isArray(sekil)) return { type: "array", items: sekil.length ? derinSemayaCevir(sekil[0]) : {} };
    if (sekil && typeof sekil === "object") {
      const p = {};
      Object.keys(sekil).slice(0, 40).forEach(k => { p[k] = derinSemayaCevir(sekil[k]); });
      return { type: "object", properties: p };
    }
    if (sekil === "string") return { type: "string" };
    if (sekil === "number") return { type: "number" };
    if (sekil === "boolean") return { type: "boolean" };
    if (sekil === "object") return { type: "object", nullable: true };
    return {};
  }

  function derinYol(u) {
    try {
      const o = new URL(u);
      let p = o.pathname.replace(/\/+/g, "/");
      p = p.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/{id}")
           .replace(/\/\d+(?=\/|$)/g, "/{id}");
      return { yol: p || "/", params: o.searchParams };
    } catch (e) { return { yol: "/", params: new URLSearchParams() }; }
  }

  /* YAML skaları: güvenli düz metin değilse JSON kaçışlı tırnaklı yazılır
     (JSON dizeleri YAML'ın da geçerli alt kümesidir). */
  function derinSkalar(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    if (!s.length) return '""';
    const duz = /^[A-Za-z0-9_.\/-]+$/.test(s) &&
      !/^(true|false|yes|no|null|on|off|y|n)$/i.test(s) &&
      !/^[-+]?\d+(\.\d+)?$/.test(s);
    return duz ? s : JSON.stringify(s);
  }
  function derinAnahtar(k) {
    const s = String(k);
    if (/^\d+$/.test(s)) return JSON.stringify(s);        // HTTP durum kodları metin kalmalı
    return /^[A-Za-z0-9_.-]+$/.test(s) ? s : JSON.stringify(s);
  }

  /* Nesne/diziyi YAML satırlarına çevir (girinti tek yerde hesaplanır) */
  function derinYamlSatirlar(deger, girinti) {
    const pad = "  ".repeat(girinti);
    const out = [];
    if (Array.isArray(deger)) {
      if (!deger.length) return [pad + "[]"];
      for (const x of deger) {
        if (x !== null && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length) {
          const alt = derinYamlSatirlar(x, girinti + 1);
          alt[0] = pad + "- " + alt[0].slice(pad.length + 2);
          out.push(...alt);
        } else if (Array.isArray(x)) {
          out.push(pad + "- " + derinAkis(x));
        } else out.push(pad + "- " + derinSkalar(x));
      }
      return out;
    }
    if (deger !== null && typeof deger === "object") {
      const ks = Object.keys(deger);
      if (!ks.length) return [pad + "{}"];
      for (const k of ks) {
        const v = deger[k];
        const anahtar = pad + derinAnahtar(k) + ":";
        if (v !== null && typeof v === "object") {
          const ic = derinYamlSatirlar(v, girinti + 1);
          if (ic.length === 1 && (ic[0].slice(pad.length + 2).trim() === "{}" || ic[0].slice(pad.length + 2).trim() === "[]"))
            out.push(anahtar + " " + ic[0].slice(pad.length + 2).trim());
          else out.push(anahtar, ...ic);
        } else out.push(anahtar + " " + derinSkalar(v));
      }
      return out;
    }
    return [pad + derinSkalar(deger)];
  }

  /* Yalnızca skalar içeren diziler tek satır akış biçiminde yazılır */
  function derinAkis(dizi) {
    return "[" + dizi.map(x => (x !== null && typeof x === "object" ? derinAkis(Array.isArray(x) ? x : Object.values(x)) : derinSkalar(x))).join(", ") + "]";
  }

  function derinYaml(deger) { return derinYamlSatirlar(deger, 0).join("\n"); }

  /* Yakalanan uç noktalardan OpenAPI 3.1 taslağı üret */
  function derinOpenApi(d) {
    const api = (d.api || []).filter(x => x && x.url);
    let kok = "";
    try { kok = new URL(d.finalUrl || d.url || state.url).origin; } catch (e) {}
    const paths = {};
    const graphql = [];
    for (const a of api) {
      let yollar = [];
      try { yollar = [new URL(a.url)]; } catch (e) { continue; }
      const { yol, params } = derinYol(a.url);
      if (/graphql/i.test(yol)) { if (!graphql.includes(yol)) graphql.push(yol); }
      const m = (a.method || "GET").toLowerCase();
      const op = {
        summary: (a.mime || "yanıt") + " · HTTP " + (a.status || "?"),
        responses: {
          [String(a.status || 200)]: {
            description: (a.status >= 400 ? "Hata yanıtı" : "Başarılı yanıt") + (a.mime ? " (" + a.mime + ")" : ""),
            ...(a.jsonShape ? { content: { "application/json": { schema: derinSemayaCevir(a.jsonShape) } } } : {}),
          },
        },
      };
      const parametreler = [];
      for (const [k, v] of params.entries()) parametreler.push({ name: k, in: "query", required: false, schema: { type: "string" }, example: v.slice(0, 60) });
      if (parametreler.length) op.parameters = parametreler;
      paths[yol] = paths[yol] || {};
      if (!paths[yol][m]) paths[yol][m] = op;
    }
    const belge = {
      openapi: "3.1.0",
      info: {
        title: (d.title || "site") + " · API taslağı (MirrorLab)",
        version: "tasarım-0.1",
        description: "Bu belge tarayıcıda gözlemlenen ağ trafiğinden OTOMATİK üretilmiş bir taslaktır. " +
          "Şema gövde örneklerinden çıkarıldı; alan türleri kesin değildir, istek gövdeleri/başlıkları " +
          "gözlemlenmediği için eksiktir. Resmî API dokümantasyonu yerine geçmez.",
      },
      servers: kok ? [{ url: kok }] : [],
      paths,
    };
    return { yaml: "# " + belge.info.description.replace(/\s+/g, " ") + "\n" +
      "# Üretim: MirrorLab " + new Date().toLocaleString("tr-TR") + "\n" +
      derinYaml(belge, 0).replace(/^\n/, ""), ucSayi: Object.keys(paths).length, graphql, kok, apiSayi: api.length };
  }

  /* ── 4) ORİJİNAL KAYNAK AĞACI (source map taraması) ──────────────────── */
  async function derinKaynakTara(d, log) {
    const betikler = [];
    for (const n of (d.network || [])) {
      if (!n || !n.url) continue;
      const tip = (n.type || "").toLowerCase(), mime = (n.mime || "").toLowerCase();
      if (tip === "script" || /javascript|ecmascript/.test(mime) || /\.m?js(\?|$)/i.test(n.url)) betikler.push(n.url);
    }
    const benzersiz = [...new Set(betikler)].slice(0, 8);
    const sonuc = { incelenen: benzersiz.length, harita: [], dosyaSayi: 0, bayt: 0 };
    for (const u of benzersiz) {
      const r = await derinHam(u, 4);
      if (!r.ok || !r.metin) continue;
      const i = r.metin.lastIndexOf("sourceMappingURL=");
      if (i < 0) continue;
      let mu = r.metin.slice(i + 17, i + 300).split(/[\s'"`]/)[0];
      if (!mu || /^data:/i.test(mu)) continue;
      try { mu = new URL(mu, u).href; } catch (e) { continue; }
      const mr = await derinHam(mu, 8);
      if (!mr.ok || !mr.metin) continue;
      let map = null;
      try { map = JSON.parse(mr.metin); } catch (e) { continue; }
      const srcs = map.sources || [], ic = map.sourcesContent || [];
      sonuc.harita.push({
        betik: u.split("/").pop().slice(0, 46), haritaUrl: mu,
        dosya: srcs.length, icerikli: ic.filter(x => typeof x === "string").length,
        ornekler: srcs.slice(0, 4).map(s => String(s).replace(/^[a-z]+:\/\/[^/]*\//i, "").slice(0, 60)),
      });
      for (const c of ic) if (typeof c === "string") { sonuc.dosyaSayi++; sonuc.bayt += c.length; }
      if (log) log("  :: " + mu.split("/").pop() + " -> " + srcs.length + " kaynak (" + ic.filter(x => typeof x === "string").length + " içerikli)");
    }
    return sonuc;
  }

  /* ── 5) GÖMÜLÜ OYUN & MEDYA ÇIKARICI ─────────────────────────────────── */
  function derinMedyaOyunTara(ctx) {
    const H = ctx.html || "", U = ctx.urlMetni || "", sayfaUrl = ctx.url || "";
    const bulunan = [];
    const gorulen = new Set();
    const ekle = (item) => {
      const anahtar = (item.safUrl || item.url || "").trim();
      if (!anahtar || gorulen.has(anahtar)) return;
      gorulen.add(anahtar);
      bulunan.push(item);
    };

    /* 1) GameDistribution (Kizi, Agame vb.) */
    const gdIds = new Set();
    const gdRe = /html5\.gamedistribution\.com\/([a-zA-Z0-9_-]{24,40})/gi;
    let mGd;
    while ((mGd = gdRe.exec(H + " " + U)) !== null) {
      if (mGd[1] && mGd[1] !== "rvvASMiM") gdIds.add(mGd[1]);
    }
    for (const gid of gdIds) {
      ekle({
        tur: "oyun",
        saglayici: "GameDistribution",
        ad: "GameDistribution HTML5 Oyunu (" + gid.slice(0, 8) + "…)",
        url: "https://html5.gamedistribution.com/" + gid + "/",
        safUrl: "https://html5.gamedistribution.com/rvvASMiM/" + gid + "/index.html",
        motor: "Phaser / HTML5 Canvas / WebGL",
        not: "Kizi / Portal arayüzü atlandı; saf Amazon S3 oyun motoru URL'si çözüldü.",
        oneri: "Portal yerine doğrudan bu bağlantıyı kopyalayarak reklamsız ve tam ekran arşivleyebilirsiniz."
      });
    }

    /* 2) GamePix */
    const gpRe = /https?:\/\/(?:games\.)?gamepix\.com\/play\/([a-zA-Z0-9_-]+)/gi;
    let mGp;
    while ((mGp = gpRe.exec(H + " " + U)) !== null) {
      ekle({
        tur: "oyun",
        saglayici: "GamePix",
        ad: "GamePix Oyunu (" + mGp[1] + ")",
        url: mGp[0],
        safUrl: mGp[0],
        motor: "HTML5 / Canvas",
        not: "GamePix doğrudan oynatıcı bağlantısı.",
        oneri: "Doğrudan oynanabilir bağımsız oyun sayfası."
      });
    }

    /* 3) Poki GDN */
    const pokiRe = /https?:\/\/[a-zA-Z0-9.-]*poki-gdn\.com\/[^\s"'<>]+/gi;
    let mPoki;
    while ((mPoki = pokiRe.exec(H + " " + U)) !== null) {
      ekle({
        tur: "oyun",
        saglayici: "Poki GDN",
        ad: "Poki HTML5 Oyunu",
        url: mPoki[0],
        safUrl: mPoki[0],
        motor: "HTML5 / WebGL",
        not: "Poki içerik dağıtım ağı (GDN) oyun adresi."
      });
    }

    /* 4) Famobi */
    const famobiRe = /https?:\/\/play\.famobi\.com\/[^\s"'<>]+/gi;
    let mFam;
    while ((mFam = famobiRe.exec(H + " " + U)) !== null) {
      ekle({
        tur: "oyun",
        saglayici: "Famobi",
        ad: "Famobi HTML5 Oyunu",
        url: mFam[0],
        safUrl: mFam[0],
        motor: "HTML5 / Canvas",
        not: "Famobi doğrudan oyun oynatıcı adresi."
      });
    }

    /* 5) CrazyGames */
    const crazyRe = /https?:\/\/[a-zA-Z0-9.-]*crazygames\.com\/(?:game|gameframe)\/[^\s"'<>]+/gi;
    let mCrz;
    while ((mCrz = crazyRe.exec(H + " " + U)) !== null) {
      ekle({
        tur: "oyun",
        saglayici: "CrazyGames",
        ad: "CrazyGames Oyun Çerçevesi",
        url: mCrz[0],
        safUrl: mCrz[0],
        motor: "HTML5 / WebGL",
        not: "CrazyGames gömülü oyun bağlantısı."
      });
    }

    /* 6) HTML içindeki <iframe src="..."> ve script string'lerindeki çerçeveler */
    const ifRe = /<iframe[^>]*src=\\?["']([^"'\\]+)\\?["']/gi;
    let mIf;
    while ((mIf = ifRe.exec(H)) !== null) {
      const isrc = mIf[1];
      if (/youtu\.?be|youtube\.com/i.test(isrc)) {
        ekle({
          tur: "video",
          saglayici: "YouTube",
          ad: "YouTube Gömülü Video",
          url: isrc,
          safUrl: isrc,
          motor: "YouTube Video Oynatıcı",
          not: "Gömülü iframe oynatıcısı."
        });
      } else if (/vimeo\.com/i.test(isrc)) {
        ekle({
          tur: "video",
          saglayici: "Vimeo",
          ad: "Vimeo Gömülü Video",
          url: isrc,
          safUrl: isrc,
          motor: "Vimeo Video Oynatıcı",
          not: "Gömülü iframe oynatıcısı."
        });
      } else if (/game|play|html5|unity|wasm|canvas/i.test(isrc)) {
        try {
          const absIframe = new URL(isrc, sayfaUrl || (typeof location !== "undefined" ? location.href : "https://kizi.com")).href;
          ekle({
            tur: "oyun",
            saglayici: "Gömülü Oyun Çerçevesi",
            ad: "HTML5 Oyun Iframe'i",
            url: absIframe,
            safUrl: absIframe,
            motor: "Iframe / WebGL / Canvas",
            not: "Sayfa içinden tespit edilen harici oyun çerçevesi."
          });
        } catch (e) {}
      }
    }

    /* 7) Video / Audio dosyaları ve akışları (.m3u8, .mpd, .mp4, .webm) */
    const m3u8Re = /https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/gi;
    let mM3;
    while ((mM3 = m3u8Re.exec(H + " " + U)) !== null) {
      ekle({
        tur: "video",
        saglayici: "HLS Canlı Akış",
        ad: "HLS Video Akışı (.m3u8)",
        url: mM3[0],
        safUrl: mM3[0],
        motor: "Hls.js / Canlı Video Akışı",
        not: "Dinamik video akış parçaları (m3u8 oynatma listesi)."
      });
    }

    const mp4Re = /https?:\/\/[^\s"'<>]+\.(?:mp4|webm|ogv)(?:\?[^\s"'<>]*)?/gi;
    let mMp4;
    while ((mMp4 = mp4Re.exec(H + " " + U)) !== null) {
      ekle({
        tur: "video",
        saglayici: "Doğrudan Medya",
        ad: "Video Dosyası (" + mMp4[0].split("/").pop().split("?")[0].slice(0, 35) + ")",
        url: mMp4[0],
        safUrl: mMp4[0],
        motor: "HTML5 Video",
        not: "Doğrudan indirilebilir video varlığı."
      });
    }

    /* 8) WebAssembly & Unity & Godot veri paketleri */
    const wasmRe = /https?:\/\/[^\s"'<>]+\.(?:wasm|data|pck|unityweb)(?:\?[^\s"'<>]*)?/gi;
    let mWasm;
    while ((mWasm = wasmRe.exec(H + " " + U)) !== null) {
      ekle({
        tur: "oyun",
        saglayici: "Oyun Motoru Paketi",
        ad: "İkili Oyun Verisi (" + mWasm[0].split("/").pop().split("?")[0] + ")",
        url: mWasm[0],
        safUrl: mWasm[0],
        motor: "WebAssembly / Unity / Godot",
        not: "Oyun motorunun çalışma zamanında indirdiği ikili kod/veri dosyası."
      });
    }

    return bulunan;
  }
  if (typeof window !== "undefined") {
    window.derinMedyaOyunTara = derinMedyaOyunTara;
    window.klonlaOyun = function(hedefUrl) {
      if (!hedefUrl) return;
      const uInput = document.getElementById("url");
      if (uInput) uInput.value = hedefUrl;
      if (window.state) window.state.url = hedefUrl;
      const tabs = document.querySelectorAll("#tabs .tab");
      if (tabs && tabs[8]) tabs[8].click();
      const cScope = document.getElementById("cScope");
      if (cScope) cScope.value = "media";
      const cIframes = document.getElementById("cIframes");
      if (cIframes) cIframes.checked = true;
      const log = document.getElementById("crawlLog");
      if (log) log.textContent = "ℹ Oyun URL'si seçildi: " + hedefUrl + "\n'Ayna kopyasını oluştur' butonuna basarak doğrudan bu oyunu klonlayabilirsiniz.\n";
      const panel = document.getElementById("crawlPanel");
      if (panel) panel.style.display = "block";
    };
  }

  /* ── KART: dördünü birlikte çiz ──────────────────────────────────────── */
  async function renderDerin(d) {
    const kutu = $("#engineBody");
    if (!kutu) return;
    const onceki = $("#derinKart"); if (onceki) onceki.remove();
    const eski = $("#derinKartYukleniyor");
    if (eski) eski.remove();
    const yerTutucu = '<div class="card" id="derinKartYukleniyor"><h3>:: Tersine mühendislik paketi (REA derinliği)</h3>' +
      '<div class="sub">Teknoloji envanteri, güvenlik başlıkları, API şema taslağı ve orijinal kaynak ağacı hazırlanıyor…</div></div>';
    const fitKart = $("#fitCard");
    if (fitKart) fitKart.insertAdjacentHTML("afterend", yerTutucu); else kutu.insertAdjacentHTML("afterbegin", yerTutucu);

    const sayfaUrl = d.finalUrl || d.url || state.url;
    let kaynak = "";
    try { kaynak = new URL(sayfaUrl).origin; } catch (e) { kaynak = sayfaUrl; }

    /* paralel: ham HTML + başlıklar */
    const [hamR, basR] = await Promise.all([derinHam(sayfaUrl, 2), derinBasliklar(sayfaUrl)]);
    const html = hamR.metin || "";
    const cssler = (d.network || []).filter(n => /\.css(\?|$)/i.test(n.url || "") || /css/.test(n.mime || "")).slice(0, 3).map(n => n.url);
    let cssMetni = "";
    for (const c of cssler) { const r = await derinHam(c, 1); cssMetni += r.metin.slice(0, 200000); }
    const urlMetni = (d.network || []).map(n => n.url || "").join("\n");

    const teknoloji = derinTeknoloji({ html, urlMetni, basliklar: basR.headers || {}, cssMetni });
    const guvenlik = basR.ok ? derinGuvenlikDegerlendir(basR.headers, basR.status) : null;
    const oa = derinOpenApi(d);
    const medyaOyun = derinMedyaOyunTara({ html, urlMetni, url: sayfaUrl });

    const nokta = (durum) => durum === "iyi" ? "✓" : durum === "orta" ? "!" : durum === "kotu" ? "x" : "•";
    const renk = (durum) => durum === "iyi" ? DERIN_RENK.iyi : durum === "orta" ? DERIN_RENK.orta : durum === "kotu" ? DERIN_RENK.kotu : DERIN_RENK.notr;

    let h = '<div class="card" id="derinKart" style="border-left:4px solid #ffd479">' +
      '<div class="row" style="align-items:center"><h3 style="margin:0">:: Tersine mühendislik paketi (REA derinliği)</h3><div class="spacer"></div>' +
      '<span class="hint">' + (medyaOyun.length ? '5' : '4') + ' katman · kanıtlı</span></div>' +
      '<div class="sub">Teknoloji sürümleri, güvenlik duruşu, gömülü oyun/medya, API şeması ve kaynak kod — hepsi gözlemlenen kanıtlardan çıkarılır.</div>';

    /* 0) gömülü oyun ve medya çıkarıcı (varsa en üstte) */
    if (medyaOyun.length) {
      h += '<details open style="margin-top:12px;border:1px solid #00d26a;border-radius:10px;padding:8px 12px;background:rgba(0,210,106,0.04)">' +
        '<summary style="cursor:pointer;font-weight:700;color:#7dfa9b;font-size:14px">🎮 Gömülü Oyun & Medya Çıkarıcı <span class="hint" style="color:#7dfa9b">(' + medyaOyun.length + ' içerik tespit edildi)</span></summary>' +
        '<div class="sub" style="margin-top:6px">Bu sayfada harici sunuculardan yüklenen oyunlar veya video akışları bulundu. Oyun portalları (Kizi, Poki vb.) oyunları harici çerçevelerde oynatır; tüm siteyi klonlamak yerine <b>doğrudan oyun adresini klonlamak</b> reklamsız ve tam ekran çalışmasını sağlar.</div>' +
        '<div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">';
      medyaOyun.forEach((m) => {
        const hedefUrl = m.safUrl || m.url;
        h += '<div style="background:#0d0902;border:1px solid #332200;border-radius:8px;padding:10px">' +
          '<div class="row" style="align-items:center;flex-wrap:wrap;gap:8px">' +
            '<span class="badge ok">' + (m.tur === 'oyun' ? '🎮 Oyun' : '🎬 Medya') + '</span>' +
            '<b>' + dk(m.ad) + '</b>' +
            '<span class="hint mono">' + dk(m.saglayici) + ' · ' + dk(m.motor) + '</span>' +
            '<div class="spacer"></div>' +
            '<button class="btn primary sm" onclick="window.klonlaOyun && window.klonlaOyun(\'' + dk(hedefUrl) + '\')">🎯 Bu Oyunu Doğrudan Klonla</button>' +
            '<a class="btn sm" href="' + dk(hedefUrl) + '" target="_blank" rel="noopener">↗ Saf Oyunu Aç</a>' +
          '</div>' +
          '<div class="mono hint" style="margin-top:6px;word-break:break-all;font-size:11px">' + dk(hedefUrl) + '</div>' +
          '<div class="sub" style="margin-top:4px;font-size:12px">' + dk(m.not) + ' ' + (m.oneri ? '<b>' + dk(m.oneri) + '</b>' : '') + '</div>' +
        '</div>';
      });
      h += '</div></details>';
    }

    /* 1) teknoloji */
    h += '<details open style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">[] Teknoloji ve sürüm envanteri <span class="hint">' + teknoloji.length + ' bulgu</span></summary>' +
      (teknoloji.length
        ? '<div class="scroll"><table><tr><th style="width:190px">teknoloji</th><th style="width:90px">sürüm</th><th>kanıt</th></tr>' +
          teknoloji.map(t => '<tr><td><b>' + dk(t.ad) + '</b></td><td>' + (t.surum ? '<code class="k">' + dk(t.surum) + '</code>' : '<span class="hint">—</span>') + '</td><td class="hint">' + dk(t.kanit) + (t.tur ? ' · ' + dk(t.tur) : '') + '</td></tr>').join("") +
          '</table></div>'
        : '<div class="sub">Kaynak HTML/varlıklarda tanınan bir çatı imzası bulunamadı.</div>') +
      '</details>';

    /* 2) güvenlik başlıkları */
    h += '<details open style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">[] Güvenlik başlıkları raporu ' +
      (guvenlik ? '<span class="hint">' + guvenlik.skor + '/100</span>' : '<span class="hint">alınamadı</span>') + '</summary>';
    if (guvenlik) {
      h += '<div class="scroll"><table><tr><th style="width:280px">denetim</th><th style="width:46px">durum</th><th>ayrıntı</th></tr>' +
        guvenlik.bulgular.map(b => '<tr><td>' + dk(b.ad) + '</td><td style="color:' + renk(b.durum) + ';font-size:16px">' + nokta(b.durum) + '</td><td class="hint">' + dk(b.aciklama) + '</td></tr>').join("") +
        '</table></div>';
      const eksik = guvenlik.bulgular.filter(b => b.durum === "kotu").map(b => b.ad);
      h += '<div class="sub" style="margin-top:8px">' + (eksik.length
        ? 'Öncelikli eksikler: <b>' + dk(eksik.join(", ")) + '</b>'
        : 'Kritik eksik görünmüyor.') + '</div>';
      h += '<div class="sub">Ham başlıklar <code class="k">/api/hdr</code> ile hedefin kendi yanıtından okundu' + (basR.status ? ' (HTTP ' + basR.status + ')' : '') + '.</div>';
    } else h += '<div class="sub">' + dk((basR && basR.hata) || "hedef yanıt vermedi") + '</div>';
    h += '</details>';

    /* 3) API taslağı */
    h += '<details open style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">[] API şema taslağı (OpenAPI 3.1) <span class="hint">' + oa.ucSayi + ' yol · ' + oa.apiSayi + ' çağrı</span></summary>';
    if (oa.ucSayi) {
      h += '<div class="row" style="margin:10px 0"><button class="btn" id="oaIndir">▼ openapi.yaml indir</button>' +
        '<button class="btn" id="oaKopya">[=] YAML kopyala</button>' +
        (oa.graphql.length ? '<span class="hint">GraphQL uç noktası: ' + dk(oa.graphql.join(", ")) + '</span>' : '') +
        '<div class="spacer"></div><span class="hint">taslak · gövde örneklerinden türetildi</span></div>' +
        '<pre class="scroll" id="oaYaml" style="max-height:320px;white-space:pre;font-size:12px;line-height:1.45;padding:12px;background:#0d0902;border-radius:10px;overflow:auto">' + dk(oa.yaml) + '</pre>';
    } else {
      h += '<div class="sub">Bu sayfada XHR/fetch çağrısı yakalanmadı (ya da hepsi varlık isteğiydi). Tam Ayna sırasında sayfalarda gezinirken yeniden dene.</div>';
    }
    h += '</details>';

    /* 4) kaynak ağacı */
    h += '<details open style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">:: Orijinal kaynak ağacı (source map) <span class="hint" id="derinKaynakOzet">taranmadı</span></summary>' +
      '<div class="sub">JS paketlerinin source map dosyaları okunur; <code class="k">sourcesContent</code> içerenler ZIP içine <code class="k">_kaynak/…</code> klasörü olarak eklenir.</div>' +
      '<div class="row" style="margin:10px 0"><button class="btn" id="derinKaynakBtn">:: source map tara</button><div class="spacer"></div><span class="hint">en çok 8 betik · 8 MB/harita</span></div>' +
      '<div id="derinKaynakSonuc"></div></details>';

    h += '<div class="sub" style="margin-top:10px">Kanıt: ham HTML (<code class="k">/api/raw</code>) · yanıt başlıkları (<code class="k">/api/hdr</code>) · tarayıcı ağ kaydı. Sürümler yalnızca sayfada görünen damgalardan okunur; kesin sürüm için resmî kaynağa bakın.</div>';
    h += '</div>';

    const yer = $("#derinKartYukleniyor");
    if (yer) yer.outerHTML = h; else {
      const fk2 = $("#fitCard");
      if (fk2) fk2.insertAdjacentHTML("afterend", h); else kutu.insertAdjacentHTML("afterbegin", h);
    }

    const oi = $("#oaIndir");
    if (oi) oi.onclick = () => {
      const blob = new Blob([oa.yaml], { type: "text/yaml" });
      const a2 = document.createElement("a");
      a2.href = URL.createObjectURL(blob); a2.download = "openapi.yaml";
      document.body.appendChild(a2); a2.click(); a2.remove();
      oi.textContent = "✓ indirildi";
    };
    const ok2 = $("#oaKopya");
    if (ok2) ok2.onclick = async () => {
      try { await navigator.clipboard.writeText(oa.yaml); ok2.textContent = "✓ kopyalandı"; } catch (e) { ok2.textContent = "kopyalanamadı"; }
    };
    const kb = $("#derinKaynakBtn");
    if (kb) kb.onclick = async () => {
      kb.disabled = true; kb.textContent = "taranıyor…";
      const out = $("#derinKaynakSonuc"), oz = $("#derinKaynakOzet");
      const satirlar = [];
      const logYaz = (m) => { satirlar.push(m); if (out) out.innerHTML = '<pre class="scroll" style="max-height:200px;font-size:12px;padding:10px;background:#0d0902;border-radius:10px">' + dk(satirlar.join("\n")) + '</pre>'; };
      try {
        const r = await derinKaynakTara(d, logYaz);
        if (oz) oz.textContent = r.harita.length ? r.dosyaSayi + " orijinal dosya / " + (r.bayt / 1048576).toFixed(2) + " MB" : "source map yok";
        if (state.derinOzet) state.derinOzet.kaynakDosya = r.dosyaSayi;
        let h2 = "";
        if (r.harita.length) {
          h2 = '<table><tr><th>betik</th><th style="width:80px">kaynak</th><th style="width:90px">içerikli</th><th>örnek yollar</th></tr>' +
            r.harita.map(x => '<tr><td class="hint">' + dk(x.betik) + '</td><td>' + x.dosya + '</td><td style="color:' + DERIN_RENK.iyi + '">' + x.icerikli + '</td><td class="hint">' + dk(x.ornekler.join(" · ")) + '</td></tr>').join("") + '</table>';
          h2 += '<div class="sub" style="margin-top:8px">Bu site <b>üretim sürümünde source map yayınlıyor</b> — Tam Ayna ile kopyaladığınızda orijinal kaynaklar ZIP içindeki <code class="k">_kaynak/</code> klasörüne eklenir. Toplam potansiyel: <b>' + r.dosyaSayi + ' dosya / ' + (r.bayt / 1048576).toFixed(2) + ' MB</b>.</div>';
        } else {
          h2 = '<div class="sub">İncelenen ' + r.incelenen + ' betikte kullanılabilir source map bulunamadı (üretimde kapatılmış olabilir).</div>';
        }
        if (out) out.innerHTML = h2 + (satirlar.length ? '<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">tarama günlüğü</summary><pre class="scroll" style="max-height:160px;font-size:12px;padding:10px;background:#0d0902;border-radius:10px">' + dk(satirlar.join("\n")) + '</pre></details>' : "");
      } catch (e) {
        if (out) out.innerHTML = '<div class="sub">Tarama hatası: ' + dk(e.message) + '</div>';
      }
      kb.disabled = false; kb.textContent = ":: yeniden tara";
    };
    state.derinOzet = {
      teknoloji: teknoloji.slice(0, 12),
      guvenlik: guvenlik ? { skor: guvenlik.skor, eksikler: guvenlik.bulgular.filter(b => b.durum === "kotu").map(b => b.ad) } : null,
      apiYol: oa.ucSayi, graphql: oa.graphql, kaynakDosya: 0,
    };
    if (typeof gecmisEkle === "function") {
      try { gecmisEkle(raporOzetiTopla(d.finalUrl || d.url || state.url)); } catch (e) {}
    }
    return { teknoloji, guvenlik, oa };
  }
