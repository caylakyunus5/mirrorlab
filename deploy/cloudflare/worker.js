/**
 * MirrorLab Edge — Cloudflare Worker (ücretsiz plan)
 * ==================================================
 * Sunucu barındırmadan, tamamen Cloudflare'in ücretsiz katmanında çalışan
 * "kenarda klonlama" katmanı:
 *
 *   GET /api/health                 → durum + sürüm + sınırlar
 *   GET /api/render?u=&proxy=1      → hedef sayfayı çeker, HTMLRewriter ile yeniden yazar
 *                                     (varlıklar /api/asset üzerinden proxy'lenir, linkler mutlaklaşır)
 *   GET /api/asset?u=&r=            → alt kaynak proxy'si; CSS içindeki url()/@import yeniden yazılır
 *   GET /api/analyze?url=           → hızlı statik analiz (başlık, meta, sayımlar, varlıklar, çatı izleri)
 *   GET /api/export?url=&mode=      → tek dosya: mode=absolute (hafif) | inline (base64 gömme, sınırlı)
 *   diğer tüm yollar                → statik arayüz (static/ klasöründen, ASSETS bağlayıcısı)
 *
 * Ücretsiz plan sınırları: 100.000 istek/gün, istek başına 10 ms CPU, 50 alt istek.
 * Bu Worker CPU'yu ağır kullanmaz: HTML/CSS yeniden yazımı platformun yerel
 * HTMLRewriter motorunda yapılır (JS çalıştırmaz, akış hâlinde çalışır).
 *
 * Not: Headless Chrome gerektiren "Tarayıcı Analizi" (ağ kaydı, API gövdeleri,
 * ekran görüntüleri) bu Worker'da çalışmaz — onun için ya Cloudflare Browser
 * Rendering API'si (ücretsiz: günde 10 dk, uzak CDP) ya da kandaki tarayıcı
 * motoru (engine.js) kullanılır. Bkz. deploy/cloudflare/README.md
 */

import { deepAnalyze } from "./analyze-browser.js";
import puppeteer from "@cloudflare/puppeteer";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 MirrorLab-Edge/1.0";

const ASSET_PATH = "/api/asset";
const MAX_BYTES = 6 * 1024 * 1024;        // tek varlık üst sınırı
const INLINE_BUDGET = 14;                 // inline modda en fazla kaç varlık gömülür (50 alt istek sınırı)
const RATE_LIMIT_PER_HOUR = 60;           // IP başına (izolat belleğinde, en iyi çaba)

const SKIP_PREFIX = ["data:", "javascript:", "mailto:", "tel:", "#", "about:", "blob:", "sms:"];

/* ------------------------------------------------------------------ */
/* yardımcılar                                                         */
/* ------------------------------------------------------------------ */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "content-disposition, content-length, x-ml-final-url, x-ml-status",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function shouldSkip(raw) {
  if (!raw) return true;
  const v = String(raw).trim().toLowerCase();
  return SKIP_PREFIX.some((p) => v.startsWith(p));
}

function absUrl(base, raw) {
  try { return new URL(raw, base).toString(); } catch { return raw; }
}

function isHttp(u) {
  return typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));
}

/** SSRF koruması: yerel/özel adresleri reddet */
function safeHost(target) {
  let h;
  try { h = new URL(target).hostname.toLowerCase(); } catch { return false; }
  if (["localhost", "localhost.localdomain", "metadata.google.internal"].includes(h)) return false;
  if (h.endsWith(".local") || h.endsWith(".internal")) return false;
  // IPv4 özel/rezerve aralıklar
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;          // link-local / bulut metadata
    if (a >= 224) return false;
  }
  if (h === "[::1]" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
  return true;
}

/** Basit kayan pencere hız sınırı (izolat belleğinde; kalıcı değildir) */
const HITS = new Map();
function rateOk(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= RATE_LIMIT_PER_HOUR) { HITS.set(ip, arr); return false; }
  arr.push(now);
  if (HITS.size > 3000) HITS.clear();
  HITS.set(ip, arr);
  return true;
}

function proxyUrl(target, page) {
  return `${ASSET_PATH}?u=${encodeURIComponent(target)}${page ? `&r=${encodeURIComponent(page)}` : ""}`;
}

/** CSS içindeki url() ve @import'ları proxy'ye çevir */
function rewriteCssText(text, baseUrl) {
  let out = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, val) => {
    const v = val.trim();
    if (shouldSkip(v)) return m;
    return `url(${q}${proxyUrl(absUrl(baseUrl, v), baseUrl)}${q})`;
  });
  out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, val) => {
    const v = val.trim();
    if (shouldSkip(v)) return m;
    return `@import ${q}${proxyUrl(absUrl(baseUrl, v), baseUrl)}${q}`;
  });
  return out;
}

function rewriteSrcset(value, baseUrl) {
  return String(value).split(",").map((part) => {
    const item = part.trim();
    if (!item) return "";
    const [u, ...desc] = item.split(/\s+/);
    return [shouldSkip(u) ? u : proxyUrl(absUrl(baseUrl, u), baseUrl), ...desc].join(" ");
  }).filter(Boolean).join(", ");
}

function cleanHeaders(src, extra = {}) {
  const out = new Headers();
  const keep = ["content-type", "content-length", "cache-control", "last-modified", "etag"];
  for (const k of keep) {
    const v = src.get(k);
    if (v) out.set(k, v);
  }
  // İçerik kodlamasını bizim tarafımızda çözdük; gövdeyi olduğu gibi iletirken
  // content-encoding iletmemek gerekir.
  out.set("access-control-allow-origin", "*");
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  return out;
}

async function fetchUpstream(target, referer, asText = false) {
  const res = await fetch(target, {
    headers: {
      "user-agent": UA,
      accept: asText ? "text/html,application/xhtml+xml,text/css,*/*" : "*/*",
      "accept-language": "tr-TR,tr;q=0.9,en;q=0.8",
      ...(referer ? { referer } : {}),
    },
    redirect: "follow",
  });
  return res;
}

/* ------------------------------------------------------------------ */
/* önizleme yeniden yazıcı (HTMLRewriter)                              */
/* ------------------------------------------------------------------ */

const RELAY_SCRIPT = `
<script>
(function(){
  function relay(href){ try{ parent.postMessage({ml:'nav', href:href, page:location.href}, '*'); }catch(e){} }
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if(!a) return;
    var h = a.getAttribute('href') || '';
    if(h.charAt(0) === '#' || h.indexOf('javascript:') === 0) return;
    e.preventDefault(); e.stopPropagation(); relay(a.href || h);
  }, true);
  document.addEventListener('submit', function(e){ e.preventDefault(); relay('form:' + (e.target.action||'')); }, true);
})();
</script>`;

function buildRewriter(targetUrl, opts) {
  const strip = !!opts.stripScripts;
  const proxy = opts.proxy !== false;
  const assetOf = (u) => {
    const a = absUrl(targetUrl, u);
    if (!isHttp(a)) return u;
    return proxy ? proxyUrl(a, targetUrl) : a;
  };

  let rw = new HTMLRewriter()
    .on("base", { element: (el) => el.remove() })
    .on("link", {
      element: (el) => {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        const href = el.getAttribute("href");
        el.removeAttribute("integrity");
        el.removeAttribute("nonce");
        el.removeAttribute("crossorigin");
        if (!href || shouldSkip(href)) return;
        if (rel.includes("stylesheet") || rel.includes("icon") || rel.includes("preload") ||
            rel.includes("manifest") || rel.includes("apple-touch")) {
          el.setAttribute("href", assetOf(href));
        } else {
          el.setAttribute("href", absUrl(targetUrl, href));   // canonical, alternate...
        }
      },
    })
    .on("img, source, video, audio, embed, track, input[type=image]", {
      element: (el) => {
        el.removeAttribute("integrity");
        for (const attr of ["src", "data-src", "data-lazy-src", "poster"]) {
          const v = el.getAttribute(attr);
          if (v && !shouldSkip(v)) el.setAttribute(attr, assetOf(v));
        }
        for (const attr of ["srcset", "data-srcset"]) {
          const v = el.getAttribute(attr);
          if (v) el.setAttribute(attr, rewriteSrcset(v, targetUrl));
        }
      },
    })
    .on("script", {
      element: (el) => {
        el.removeAttribute("integrity");
        el.removeAttribute("nonce");
        el.removeAttribute("crossorigin");
        const v = el.getAttribute("src");
        if (v && !shouldSkip(v)) el.setAttribute("src", assetOf(v));
      },
    })
    .on("iframe", {
      element: (el) => {
        el.removeAttribute("integrity");
        const v = el.getAttribute("src");
        if (v && !shouldSkip(v)) el.setAttribute("src", proxy ? proxyUrl(absUrl(targetUrl, v), targetUrl) : absUrl(targetUrl, v));
      },
    })
    .on("a", {
      element: (el) => {
        const href = el.getAttribute("href");
        if (!href || shouldSkip(href)) return;
        const abs = absUrl(targetUrl, href);
        // Aynı origin içindeki bağlantılar klonu aynı Worker üzerinden gezsin
        try {
          const same = new URL(abs).origin === new URL(targetUrl).origin;
          el.setAttribute("href", same && proxy
            ? `/api/render?u=${encodeURIComponent(abs)}&proxy=1${strip ? "&strip_scripts=1" : ""}`
            : abs);
        } catch { el.setAttribute("href", abs); }
      },
    })
    .on("form", {
      element: (el) => {
        const a = el.getAttribute("action");
        if (a && !shouldSkip(a)) el.setAttribute("action", absUrl(targetUrl, a));
      },
    })
    .on("[style]", {
      element: (el) => {
        const s = el.getAttribute("style");
        if (s && s.includes("url(")) el.setAttribute("style", rewriteCssText(s, targetUrl));
      },
    })
    .on("style", {
      text: (chunk) => {
        const t = chunk.text;
        if (t && t.includes("url(")) chunk.replace(rewriteCssText(t, targetUrl), { html: true });
        else if (t && t.includes("@import")) chunk.replace(rewriteCssText(t, targetUrl), { html: true });
      },
    });

  if (strip) {
    rw = rw.on("script", { element: (el) => el.remove() });
  } else {
    rw = rw.on("body", { element: (el) => { el.append(RELAY_SCRIPT, { html: true }); } });
  }
  return rw;
}

/* ------------------------------------------------------------------ */
/* uç noktalar                                                         */
/* ------------------------------------------------------------------ */

const RENDER_MAX = 2_000_000;   // 2 MB HTML üst sınırı

/* JS çalıştırılmış sayfa: Browser Rendering ile açar, render edilmiş DOM'u döndürür.
   Tarayıcı içi ayna motorunun "SPA modu" bunu kullanır (kota: ~3-5 sn/sayfa). */
async function handleRendered(url, env) {
  const target = url.searchParams.get("url") || url.searchParams.get("u") || "";
  if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
  if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);
  if (!env || !env.BROWSER) return json({ ok: false, error: "Browser Rendering bağlayıcısı yok" }, 503);
  let browser = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: "networkidle2", timeout: 25000 });
    const finalUrl = page.url();
    let html = await page.content();
    const kesildi = html.length > RENDER_MAX;
    if (kesildi) html = html.slice(0, RENDER_MAX);
    return new Response(html, {
      status: 200,
      headers: { ...CORS, "content-type": "text/html; charset=utf-8",
        "x-ml-final-url": finalUrl, "x-ml-truncated": kesildi ? "1" : "0", "cache-control": "no-store" },
    });
  } catch (e) {
    return json({ ok: false, error: "render hatası: " + ((e && e.message) || e) }, 502);
  } finally { if (browser) { try { await browser.close(); } catch (e) {} } }
}

/* Ham proxy: hedefi olduğu gibi döndürür (HTML yeniden yazılmaz).
   Tarayıcıdaki ayna motoru sayfaları/varlıkları bununla indirir. */
async function handleRaw(url) {
  const target = url.searchParams.get("u") || "";
  if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
  if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);
  const res = await fetchUpstream(target, null, false);
  const h = new Headers(CORS);
  h.set("content-type", res.headers.get("content-type") || "application/octet-stream");
  h.set("x-ml-final-url", res.url || target);
  h.set("x-ml-status", String(res.status));
  h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

/* Yanıt başlıkları raporu: hedefin ham yanıt başlıklarını JSON olarak döndürür.
   Güvenlik değerlendirmesi tarayıcıda yapılır; burada yalnızca ham veri taşınır.
   (Paket 2 · REA derinliği — güvenlik başlıkları raporu) */
const HDR_MAX = 60;
async function handleHdr(url) {
  const target = url.searchParams.get("u") || url.searchParams.get("url") || "";
  if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
  if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);
  let res;
  try {
    res = await fetchUpstream(target, null, false);   // HEAD'i reddeden siteler için GET kullanılır
  } catch (e) {
    return json({ ok: false, error: "istek başarısız: " + ((e && e.message) || e) }, 502);
  }
  const out = {};
  let i = 0;
  for (const [k, v] of res.headers) { if (i++ >= HDR_MAX) break; out[k.toLowerCase()] = String(v).slice(0, 500); }
  try { if (res.body) await res.body.cancel(); } catch (e) {}
  return json({ ok: true, status: res.status, finalUrl: res.url || target, headers: out });
}

async function handleRender(url) {
  const target = url.searchParams.get("u") || "";
  if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
  if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);

  const opts = {
    proxy: url.searchParams.get("proxy") !== "0",
    stripScripts: ["1", "true"].includes(url.searchParams.get("strip_scripts")),
  };

  const res = await fetchUpstream(target, null, true);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct && !ct.includes("html") && !ct.includes("text/plain") && !ct.includes("xml")) {
    return new Response(res.body, { status: res.status, headers: { ...cleanHeaders(res.headers), ...CORS } });
  }
  const finalUrl = res.url || target;   // yönlendirme sonrası gerçek adres
  const rewritten = buildRewriter(finalUrl, opts).transform(
    new Response(res.body, { headers: { "content-type": "text/html; charset=utf-8" } })
  );
  const out = new Response(rewritten.body, {
    status: res.status,
    headers: {
      ...CORS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-mirrorlab-source": finalUrl.slice(0, 200),
      "x-mirrorlab-engine": "cloudflare-worker-htmlrewriter",
    },
  });
  return out;
}

async function handleAsset(url) {
  const target = url.searchParams.get("u") || "";
  const referer = url.searchParams.get("r") || undefined;
  if (!isHttp(target)) return new Response("geçersiz adres", { status: 400 });
  if (!safeHost(target)) return new Response("yerel/özel adresler reddedildi", { status: 403 });

  const res = await fetchUpstream(target, referer, false);
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("text/css")) {
    const text = await res.text();
    const base = res.url || target;
    return new Response(rewriteCssText(text, base), {
      status: res.status,
      headers: cleanHeaders(res.headers, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }),
    });
  }
  if (ct.includes("javascript") || ct.includes("ecmascript")) {
    let text = await res.text();
    const base = res.url || target;
    // Göreli modül/dinamik import yollarını mutlaklaştır
    text = text.replace(/(\bfrom\s*|\bimport\s*\(?\s*|new\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]{1,300})\2/g,
      (m, pre, q, spec) => `${pre}${q}${absUrl(base, spec)}${q}`);
    return new Response(text, {
      status: res.status,
      headers: cleanHeaders(res.headers, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300" }),
    });
  }
  return new Response(res.body, {
    status: res.status,
    headers: cleanHeaders(res.headers, { "cache-control": "public, max-age=600" }),
  });
}

/** Hızlı statik analiz — HTMLRewriter ile akış hâlinde sayaç tutar */
async function handleAnalyze(url) {
  const target = url.searchParams.get("url") || url.searchParams.get("u") || "";
  if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
  if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);

  const t0 = Date.now();
  const res = await fetchUpstream(target, null, true);
  const ct = res.headers.get("content-type") || "";
  const stats = {
    title: "", meta: {}, lang: "", scripts: 0, stylesheets: 0, images: 0, links: 0,
    iframes: 0, headings: [], assets: [], tech: [], forms: 0, inlineStyleBytes: 0,
  };
  const seenAssets = new Set();
  const addAsset = (type, u) => {
    if (!u || !isHttp(u) || seenAssets.has(u) || stats.assets.length > 120) return;
    seenAssets.add(u);
    stats.assets.push({ type, url: u });
  };

  const html = await new HTMLRewriter()
    .on("title", { text: (c) => { stats.title += c.text; } })
    .on("html", { element: (el) => { stats.lang = el.getAttribute("lang") || ""; } })
    .on("meta", {
      element: (el) => {
        const k = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
        if (k) stats.meta[k] = (el.getAttribute("content") || "").slice(0, 300);
      },
    })
    .on("script", {
      element: (el) => {
        stats.scripts++;
        addAsset("js", el.getAttribute("src") ? absUrl(target, el.getAttribute("src")) : "");
        const inner = el.getAttribute("src") || "";
        if (/googletagmanager/.test(inner)) stats.tech.push("Google Tag Manager");
        if (/gtag|google-analytics/.test(inner)) stats.tech.push("Google Analytics");
        if (/jquery/i.test(inner)) stats.tech.push("jQuery");
        if (/bootstrap/i.test(inner)) stats.tech.push("Bootstrap");
        if (/react/i.test(inner)) stats.tech.push("React");
        if (/vue/i.test(inner)) stats.tech.push("Vue.js");
      },
    })
    .on("link", {
      element: (el) => {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        const h = el.getAttribute("href");
        if (rel.includes("stylesheet")) { stats.stylesheets++; addAsset("css", h ? absUrl(target, h) : ""); }
        else if (rel.includes("icon")) addAsset("img", h ? absUrl(target, h) : "");
        if (/font-awesome|fontawesome/.test(h || "")) stats.tech.push("Font Awesome");
        if (/tailwind/.test(h || "")) stats.tech.push("Tailwind CSS");
        if (/bootstrap/.test(h || "")) stats.tech.push("Bootstrap");
      },
    })
    .on("img", {
      element: (el) => {
        stats.images++;
        const s = el.getAttribute("src") || el.getAttribute("data-src");
        if (s) addAsset("img", absUrl(target, s));
      },
    })
    .on("a", { element: () => { stats.links++; } })
    .on("iframe", {
      element: (el) => {
        stats.iframes++;
        const s = el.getAttribute("src");
        if (s) addAsset("iframe", absUrl(target, s));
      },
    })
    .on("video, audio", {
      element: (el) => {
        const s = el.getAttribute("src");
        if (s) addAsset("media", absUrl(target, s));
      },
    })
    .on("source", {
      element: (el) => {
        const s = el.getAttribute("src");
        if (s) addAsset("media", absUrl(target, s));
      },
    })
    .on("form", { element: () => { stats.forms++; } })
    .on("style", { text: (c) => { stats.inlineStyleBytes += c.text.length; } })
    .on("h1, h2, h3", {
      element: (el) => {
        const lvl = Number(el.tagName[1]);
        if (stats.headings.length < 25) stats.headings.push({ level: lvl, text: (el.textContent || "").slice(0, 120) });
      },
    })
    .transform(new Response(res.body, { headers: { "content-type": "text/html" } }))
    .text();

  stats.inlineStyleBytes = stats.inlineStyleBytes;
  const gen = (html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i) || [])[1];
  if (gen) stats.tech.push("Generator: " + gen);
  if (/wp-content\/|wp-includes\/|wp-json/.test(html)) stats.tech.push("WordPress");
  if (/cdn\.shopify\.com|myshopify\.com|shopify\.theme|Shopify\.theme/i.test(html)) stats.tech.push("Shopify");
  if (/__NEXT_DATA__|\/_next\/static/.test(html)) stats.tech.push("Next.js");
  if (/\/_nuxt\/|__NUXT__/.test(html)) stats.tech.push("Nuxt");
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html)) stats.tech.push("Google Fonts");
  if (/googletagmanager\.com\/gtm\.js/.test(html)) stats.tech.push("Google Tag Manager");
  if (/cloudflareinsights|\/cdn-cgi\//.test(html)) stats.tech.push("Cloudflare");
  if (/__NUXT__/.test(html)) stats.tech.push("Nuxt");
  stats.htmlBytes = html.length;

  return json({
    ok: true,
    engine: "cloudflare-worker-htmlrewriter",
    url: target,
    final_url: res.url || target,
    status: res.status,
    elapsed_ms: Date.now() - t0,
    content_type: ct,
    meta: stats.meta,
    title: stats.title.trim().slice(0, 200),
    lang: stats.lang,
    counts: {
      html_bytes: stats.htmlBytes, scripts: stats.scripts, stylesheets: stats.stylesheets,
      images: stats.images, links: stats.links, iframes: stats.iframes, forms: stats.forms,
      assets_total: stats.assets.length, inline_style_bytes: stats.inlineStyleBytes,
    },
    headings: stats.headings,
    assets: stats.assets,
    tech: [...new Set(stats.tech)],
    limits: [
      "Bu katman Cloudflare Worker'da çalışır: sunucu yok, ücretsiz plan 100.000 istek/gün.",
      "Ağ kaydı, API gövdeleri ve ekran görüntüleri için tarayıcı motoru gerekir (Browser Rendering veya engine.js).",
      "İstek başına 50 alt istek sınırı vardır; çok varlıklı sayfalarda tüm varlıklar listelenmez.",
    ],
  });
}

/** Tek dosya dışa aktarma: absolute (hafif) veya inline (base64, sınırlı bütçe) */
async function handleExport(url) {
  const target = url.searchParams.get("url") || url.searchParams.get("u") || "";
  if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
  if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);
  const mode = url.searchParams.get("mode") === "inline" ? "inline" : "absolute";
  const strip = ["1", "true"].includes(url.searchParams.get("strip_scripts"));

  const res = await fetchUpstream(target, null, true);
  const finalUrl = res.url || target;
  const rawHtml = await res.text();

  if (mode === "absolute") {
    const out = await new HTMLRewriter()
      .on("base", { element: (el) => el.remove() })
      .on("[src]", { element: (el) => { const v = el.getAttribute("src"); if (v && !shouldSkip(v)) el.setAttribute("src", absUrl(finalUrl, v)); } })
      .on("[href]", { element: (el) => { const v = el.getAttribute("href"); if (v && !shouldSkip(v)) el.setAttribute("href", absUrl(finalUrl, v)); } })
      .on("style", { text: (c) => c.replace(c.text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (m, q, v) => (shouldSkip(v) ? m : `url(${q}${absUrl(finalUrl, v.trim())}${q})`)), { html: true }) })
      .transform(new Response(rawHtml, { headers: { "content-type": "text/html" } }))
      .text();
    const host = new URL(finalUrl).hostname.replace(/[^\w.-]/g, "_");
    return new Response(out, {
      headers: {
        ...CORS,
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${host}-mirror.html"`,
      },
    });
  }

  // --- inline: toplanan ilk N varlığı data-URI olarak göm ---
  const candidates = [];
  {
    const collect = new HTMLRewriter()
      .on("script[src], img[src], link[rel=stylesheet]", {
        element: (el) => {
          const v = el.getAttribute("src") || el.getAttribute("href");
          if (v && !shouldSkip(v)) candidates.push({ tag: el.tagName, attr: el.getAttribute("src") ? "src" : "href", abs: absUrl(finalUrl, v) });
        },
      });
    await collect.transform(new Response(rawHtml, { headers: { "content-type": "text/html" } })).text();
  }
  const picked = candidates.slice(0, INLINE_BUDGET);
  const map = new Map();
  let bytes = 0;
  for (const c of picked) {
    if (bytes > 4 * 1024 * 1024) break;
    try {
      const r = await fetchUpstream(c.abs, finalUrl, false);
      const buf = await r.arrayBuffer();
      bytes += buf.byteLength;
      // base64 (parça parça: büyük dizilerde yığın taşmasını önler)
      const u8 = new Uint8Array(buf);
      let s = "";
      for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      const ct = r.headers.get("content-type") || "application/octet-stream";
      map.set(c.abs, `data:${ct.split(";")[0]};base64,${btoa(s)}`);
    } catch { /* atlanır */ }
  }

  const out = await new HTMLRewriter()
    .on("script[src], img[src], link[rel=stylesheet]", {
      element: (el) => {
        const attr = el.getAttribute("src") ? "src" : "href";
        const abs = absUrl(finalUrl, el.getAttribute(attr));
        const data = map.get(abs);
        if (data) el.setAttribute(attr, data);
        else el.setAttribute(attr, abs);
        if (attr === "src" && el.tagName === "SCRIPT" && strip) el.remove();
      },
    })
    .transform(new Response(rawHtml, { headers: { "content-type": "text/html" } }))
    .text();
  const host = new URL(finalUrl).hostname.replace(/[^\w.-]/g, "_");
  return new Response(out, {
    headers: {
      ...CORS,
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${host}-inline.html"`,
    },
  });
}

/* ------------------------------------------------------------------ */
/* ana yönlendirici                                                    */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Tarayıcıdan (ör. huggingface.co statik Space'ten) gelen istekler için CORS
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const ip = request.headers.get("cf-connecting-ip") || "?";

    try {
      if (path === "/api/health") {
        return json({
          ok: true, engine: "cloudflare-worker", time: new Date().toISOString(),
          rate_limit_per_hour: RATE_LIMIT_PER_HOUR,
          endpoints: ["/api/render", "/api/asset", "/api/analyze", "/api/export",
        "/api/raw", "/api/hdr", "/api/rendered", "/api/deep", "/api/health"],
          deep_analyze: "Browser Rendering ile /api/deep (ücretsiz: günde 10 dk Chrome) — ağ kaydı, API gövdeleri, tasarım, ekran görüntüsü",
        });
      }
      if (path === "/api/render") {
        if (!rateOk(ip)) return json({ ok: false, error: "hız sınırı aşıldı (saatlik)" }, 429);
        return await handleRender(url);
      }
      if (path === "/api/raw") return await handleRaw(url);
      if (path === "/api/hdr") return await handleHdr(url);
      if (path === "/api/rendered") {
        if (!rateOk(ip)) return json({ ok: false, error: "hız sınırı aşıldı (saatlik)" }, 429);
        return await handleRendered(url, env);
      }
      if (path === "/api/asset") return await handleAsset(url);
      if (path === "/api/deep") {
        // Browser Rendering ile derin analiz (ücretsiz: günde 10 dk Chrome)
        if (!rateOk(ip)) return json({ ok: false, error: "hız sınırı aşıldı (saatlik)" }, 429);
        const target = url.searchParams.get("url") || url.searchParams.get("u") || "";
        if (!isHttp(target)) return json({ ok: false, error: "geçersiz adres" }, 400);
        if (!safeHost(target)) return json({ ok: false, error: "yerel/özel adresler reddedildi" }, 403);
        if (!env || !env.BROWSER) {
          return json({
            ok: false,
            error: "Browser Rendering bağlayıcısı tanımlı değil. wrangler.toml içindeki [browser] bölümünü ekleyip yeniden deploy edin.",
          }, 503);
        }
        // Ücretsiz katmanda eşzamanlı tarayıcı sayısı düşük: global kilitle sıraya al
        const now = Date.now();
        if (globalThis.__mlBusy && now - globalThis.__mlBusy < 45_000) {
          return json({ ok: false, error: "Şu anda başka bir derin analiz çalışıyor (ücretsiz katmanda 1 eşzamanlı tarayıcı). Lütfen ~30 sn sonra tekrar deneyin." }, 429);
        }
        globalThis.__mlBusy = now;
        try {
          const res = await deepAnalyze(env, target, {
            light: url.searchParams.get("light") !== "0",
            mobile: ["1", "true"].includes(url.searchParams.get("mobile")),
          });
          return json(res, res.ok ? 200 : 502);
        } finally {
          globalThis.__mlBusy = 0;
        }
      }
      if (path === "/api/analyze") {
        if (!rateOk(ip)) return json({ ok: false, error: "hız sınırı aşıldı (saatlik)" }, 429);
        return await handleAnalyze(url);
      }
      if (path === "/api/export") {
        if (!rateOk(ip)) return json({ ok: false, error: "hız sınırı aşıldı (saatlik)" }, 429);
        return await handleExport(url);
      }
      if (path === "/api/crawl" || path === "/api/crawl/status" || path === "/api/crawl/file") {
        return json({
          ok: false,
          error: "Tam site aynası (ZIP) bu katmanda çalışmaz: çok sayfa + çok varlık, ücretsiz Worker sınırlarını " +
                 "(50 alt istek, 10 ms CPU) aşar. Şu yollardan biriyle yapın: GitHub Actions iş akışı, " +
                 "Cloudflare Tunnel ile kendi makinenizde tam sürüm, ya da 1 Kasım'da Render ücretsiz kotası.",
        }, 501);
      }

      // Arayüz ve diğer statik dosyalar
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      return json({ ok: false, error: "bilinmeyen yol" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
  },
};
