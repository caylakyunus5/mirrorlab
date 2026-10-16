#!/usr/bin/env node
/**
 * MirrorLab Analysis Engine (REA-style)
 * -------------------------------------
 * Gerçek headless Chrome ile bir sayfayı açar ve "kanıt paketi" üretir:
 *   - render edilmiş DOM (JS çalıştıktan sonraki hâli)
 *   - tam sayfa + bölüm + mobil ekran görüntüleri
 *   - tüm ağ trafiği (istek/yanıt, başlıklar, boyut, süre, başlatıcı)
 *   - XHR/fetch API çağrıları ve örnek yanıt gövdeleri
 *   - çalışma zamanı çatı tespiti, global değişkenler, script bundle'ları
 *   - render edilmiş elementlerden çıkarılan tasarım sistemi (renk/font/boşluk/köşe/gölge)
 *   - açılışta hata/uyarı günlükleri
 *
 * Kullanım:  node engine.js <config.json>
 *   config: {url, outDir, jobId, probe, maxWaitMs, blockMedia, mobile:true}
 * Sonuç:    config.outFile içine JSON yazılır.
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const cfgPath = process.argv[2];
if (!cfgPath) { console.error("config yolu gerekli"); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const OUT = cfg.outDir || path.join(__dirname, "output");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const JOB = cfg.jobId || String(Date.now());
// Uzak tarayıcı (CDP): Cloudflare Browser Rendering, Browserless, kendi Chrome'unuz...
//   MIRRORLAB_BROWSER_WS=wss://api.cloudflare.com/client/v4/accounts/<ID>/browser-run/devtools/browser?keep_alive=60000
//   MIRRORLAB_BROWSER_TOKEN=<Browser Rendering - Edit izinli API token>
const REMOTE_WS = process.env.MIRRORLAB_BROWSER_WS || cfg.browserWs || "";
const REMOTE_TOKEN = process.env.MIRRORLAB_BROWSER_TOKEN || cfg.browserToken || "";
const MAX_WAIT = cfg.maxWaitMs || 45000;
const BUDGET = cfg.maxTotalMs || 75000;          // toplam analiz bütçesi
const t0 = Date.now();
const timeLeft = () => BUDGET - (Date.now() - t0);
const UA = cfg.userAgent ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const result = {
  ok: false, url: cfg.url, finalUrl: "", jobId: JOB,
  startedAt: new Date().toISOString(), elapsedMs: 0,
  screenshots: {}, sections: [], network: [], api: [], console: [],
  pageErrors: [], frameworks: [], globals: {}, scripts: [], resources: {},
  design: { colors: [], fonts: [], radii: [], shadows: [], spacings: [], components: {} },
  seo: {}, headings: [], forms: [], storage: {}, workerUrls: [],
  blockedChallenge: false, limits: [], evidence: {},
};

function log(...a) { console.error("[engine]", ...a); }

(async () => {
  let browser;
  try {
    const LOWMEM = process.env.MIRRORLAB_LOWMEM === "1";
    const baseArgs = [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled", "--disable-gpu",
      "--lang=tr-TR,tr", "--window-size=1440,900",
    ];
    if (LOWMEM) {
      // 512 MB'lık ücretsiz planlar için: renderer sayısını en aza indir
      baseArgs.push("--single-process", "--no-zygote",
                    "--disable-features=IsolateOrigins,site-per-process,BackForwardCache",
                    "--js-flags=--max-old-space-size=256", "--renderer-process-limit=1");
      result.limits.push("Düşük bellek modu etkin (MIRRORLAB_LOWMEM=1): mobil görüntü ve ağır işler kısıtlandı.");
    } else {
      baseArgs.push("--disable-features=IsolateOrigins,site-per-process");
    }
    if (REMOTE_WS) {
      // Yerel Chrome indirmeye gerek yok: uzak tarayıcıya CDP ile bağlan
      log("uzak tarayıcıya bağlanılıyor:", REMOTE_WS.slice(0, 90));
      browser = await puppeteer.connect({
        browserWSEndpoint: REMOTE_WS,
        headers: REMOTE_TOKEN ? { Authorization: `Bearer ${REMOTE_TOKEN}` } : undefined,
        defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      });
      result.remoteBrowser = {
        endpoint: REMOTE_WS.replace(/accounts\/[^/]+/, "accounts/***"),
        note: "Uzak tarayıcı (CDP). Cloudflare Browser Rendering ücretsiz planda günde 10 dk tarayıcı süresi verir.",
      };
      result.limits.push("Uzak tarayıcı kullanıldı (CDP): ücretsiz katmanda günde 10 dakika sınırı vardır — "
        + "büyük sayfalarda 'mobile' ve 'probe' seçeneklerini kapatmak süreyi korur.");
    } else {
      browser = await puppeteer.launch({
        headless: true,
        args: baseArgs,
        defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      });
    }

    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8" });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.__ML_START__ = performance.now();
    });

    /* ---------------- ağ yakalama ---------------- */
    const reqMeta = new Map();          // request -> meta
    const bodyBudget = { n: 0, bytes: 0 };
    const apiList = [];
    let seq = 0;

    page.on("request", (req) => {
      seq += 1;
      const rtype = req.resourceType();
      reqMeta.set(req, {
        seq, method: req.method(), url: req.url(), type: rtype,
        start: Date.now(), headers: safeHeaders(req.headers()),
        postData: req.postData() ? req.postData().slice(0, 4000) : undefined,
        initiator: (() => { try { const i = req.initiator(); return i && i.type; } catch (e) { return undefined; } })(),
        redirectChain: req.redirectChain ? req.redirectChain().length : 0,
      });
      if (cfg.blockMedia && (rtype === "media" || rtype === "font")) {
        try { req.abort(); } catch (e) {}
      }
    });

    page.on("response", async (res) => {
      const req = res.request();
      const m = reqMeta.get(req) || { seq: seq++, method: req.method(), url: req.url(), type: req.resourceType(), start: Date.now() };
      const h = safeHeaders(res.headers());
      const cl = parseInt(h["content-length"] || "0", 10) || 0;
      let size = cl;
      const entry = {
        seq: m.seq, method: m.method, url: m.url, type: m.type,
        status: res.status(), statusText: res.statusText(),
        mime: (h["content-type"] || "").split(";")[0],
        size, ms: Date.now() - (m.start || Date.now()),
        fromCache: !!res.fromCache(), headers: pickHeaders(h),
        initiator: m.initiator, postData: m.postData,
        redirects: m.redirectChain || 0,
      };
      const isApi = ["xhr", "fetch"].includes(m.type) ||
        /json|graphql/i.test(entry.mime) ||
        (["document", "script"].includes(m.type) && false);
      entry.api = isApi;
      if (isApi && bodyBudget.n < 60 && bodyBudget.bytes < 3_000_000 && size < 400_000) {
        try {
          const txt = await res.text();
          bodyBudget.n += 1; bodyBudget.bytes += txt.length;
          entry.bodyPreview = txt.slice(0, 12000);
          entry.bodyTruncated = txt.length > 12000;
          apiList.push({
            method: entry.method, url: entry.url, status: entry.status, mime: entry.mime,
            size, kind: guessApiKind(entry.url, txt),
            jsonShape: shape(txt),
            bodyPreview: txt.slice(0, 6000),
          });
        } catch (e) { /* gövde okunamadı */ }
      }
      result.network.push(entry);
    });

    page.on("console", (msg) => {
      const loc = msg.location() || {};
      result.console.push({ type: msg.type(), text: msg.text().slice(0, 600), url: loc.url, line: loc.lineNumber });
    });
    page.on("pageerror", (err) => {
      result.pageErrors.push({ message: String(err && err.message || err).slice(0, 600), stack: String(err && err.stack || "").slice(0, 900) });
    });
    page.on("workercreated", (w) => result.workerUrls.push(w.url()));

    /* ---------------- sayfayı aç ---------------- */
    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: MAX_WAIT });
    try { await page.waitForNetworkIdle({ idleTime: 700, timeout: 12000 }); } catch (e) {}

    // tembel yükleme tetikle: aşağı kaydır, sonra başa dön
    await autoScroll(page, LOWMEM);
    try { await page.waitForNetworkIdle({ idleTime: 600, timeout: 4000 }); } catch (e) {}

    result.finalUrl = page.url();
    const title = await page.title();
    result.blockedChallenge = /just a moment|attention required|checking your browser|bir dakika/i.test(title + " " + (await safeText(page, "body")).slice(0, 400));

    /* ---------------- ekran görüntüleri ---------------- */
    const vpName = `shot-${JOB}-viewport.png`;
    await page.screenshot({ path: path.join(SHOTS, vpName) });
    result.screenshots.viewport = vpName;

    let fullName = null;
    try {
      const dims = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
      fullName = `shot-${JOB}-full.png`;
      if (dims.h > 16000) {
        result.limits.push(`Sayfa çok uzun (${dims.h}px): tam sayfa görüntüsü ilk 16000px ile sınırlandı.`);
        await page.screenshot({ path: path.join(SHOTS, fullName), clip: { x: 0, y: 0, width: Math.min(dims.w, 1440), height: 16000 } });
      } else {
        await page.screenshot({ path: path.join(SHOTS, fullName), fullPage: true });
      }
      result.screenshots.full = fullName;
    } catch (e) {
      result.limits.push("Tam sayfa ekran görüntüsü alınamadı: " + String(e.message).slice(0, 120));
      fullName = null;
    }

    // mobil görünüm
    if (cfg.mobile !== false && !LOWMEM && timeLeft() > 15000) {
      const mob = await browser.newPage();
      await mob.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
      await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      try {
        await mob.goto(result.finalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(2500);
        const mName = `shot-${JOB}-mobile.png`;
        await mob.screenshot({ path: path.join(SHOTS, mName), fullPage: false });
        result.screenshots.mobile = mName;
        result.isMobileLayout = await mob.evaluate(() => document.body.scrollWidth);
      } catch (e) {
        result.limits.push("Mobil görüntü alınamadı: " + e.message.slice(0, 100));
      }
      await mob.close();
    }

    /* ---------------- bölüm tespiti + bölüm görüntüleri ---------------- */
    const sections = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const cands = [];
      /* ana içerik konteynerini bul: sayfanın çoğunu kaplayan ve
         en çok "bölüm benzeri" çocuğa sahip eleman */
      const docH = Math.max(document.documentElement.scrollHeight, 1);
      const depthOf = (el) => { let d = 0, n = el; while (n && n !== document.body) { n = n.parentElement; d++; } return d; };
      const tallKids = (el, min) => Array.from(el.children).filter((k) =>
        !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(k.tagName) && k.getBoundingClientRect().height > min);
      /* sayfanın çoğunu kaplayan, en çok "bölüm benzeri" çocuğa sahip konteyneri bul */
      let best = null, bestScore = -1;
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.height < docH * 0.3 || r.width < 300) continue;
        const tall = tallKids(el, 120);
        if (tall.length < 2) continue;
        const score = tall.length * 3 + depthOf(el) - (r.height / docH) * 2 - (r.height > docH * 1.5 ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = el; }
      }
      const cands0 = best ? tallKids(best, 120) : [];
      /* semantik bölümler: hiçbir adayın atası/torunu olmayanlar */
      const semantic = Array.from(document.querySelectorAll("section, header, footer, article, [role=region]"))
        .filter((e) => e.getBoundingClientRect().height > 120);
      for (const se of semantic) {
        if (cands0.some((c) => c === se || c.contains(se) || se.contains(c))) continue;
        cands0.push(se);
      }
      const containers = [best || document.body];
      const ordered = cands0.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const pathFor = (el) => {
        const parts = [];
        let n = el, guard = 0;
        while (n && n !== document.documentElement && guard < 12) {
          const parent = n.parentElement;
          if (!parent) break;
          const idx = Array.from(parent.children).indexOf(n) + 1;
          parts.unshift(n.tagName.toLowerCase() + ":nth-child(" + idx + ")");
          n = parent; guard++;
        }
        return parts.join(" > ");
      };
      for (const root of containers) {
        const feed = root === (best || document.body) && ordered.length ? ordered : Array.from(root.children);
        for (const el of feed) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
          const r = el.getBoundingClientRect();
          if (r.height < 40 || r.width < 200) continue;
          cands.push(el);
        }
      }
      const arr = cands.slice(0, 60);
      arr.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
        const h = el.querySelector("h1,h2,h3");
        out.push({
          i, tag: el.tagName.toLowerCase(),
          id: el.id || "", cls: (el.className && String(el.className).slice(0, 120)) || "",
          role: el.getAttribute("role") || "",
          selectorPath: pathFor(el),
          rect: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
          bg: cs.backgroundColor, color: cs.color,
          display: cs.display, position: cs.position,
          textLen: txt.length, text: txt.slice(0, 220),
          heading: h ? h.innerText.slice(0, 120) : "",
          imgs: el.querySelectorAll("img").length,
          links: el.querySelectorAll("a").length,
          buttons: el.querySelectorAll("button,a.btn,[role=button]").length,
          forms: el.querySelectorAll("form,input,select,textarea").length,
          hasNav: !!el.querySelector("nav") || /nav|menu|header/i.test(el.className + " " + el.id),
          fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
          fontSize: cs.fontSize, padding: cs.padding,
        });
      });
      return out;
    });

    // öne çıkan ilk 8 bölümün görüntüsü
    let shotCount = 0;
    for (const s of sections) {
      if (shotCount >= 5 || timeLeft() < 12000) break;
      if (s.rect.h < 120 || s.rect.h > 4000 || !s.selectorPath) continue;
      const name = `shot-${JOB}-sec${String(s.i).padStart(2, "0")}.png`;
      try {
        const el = await page.$(s.selectorPath);
        if (!el) continue;
        await el.screenshot({ path: path.join(SHOTS, name) });
        s.shot = name;
        shotCount += 1;
      } catch (e) { /* öğe görüntülenemiyor */ }
    }
    result.limits.push(`Bölüm tespiti: ${sections.length} aday bulundu, ${shotCount} tanesi görüntülendi.`);
    result.sections = sections;
    if (sections.length) result.limits.push("Bölüm sınıflandırması sezgiseldir (DOM'un doğrudan çocukları + rol/class ipuçları); elle doğrulama gerekir.");

    /* ---------------- render edilmiş DOM ---------------- */
    try {
    result.renderedHtml = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script").forEach((s) => {
        if (!s.src) s.remove();
      });
      return "<!DOCTYPE html>\n" + clone.outerHTML;
    });
    if (result.renderedHtml.length > 3_000_000) {
      result.renderedHtml = result.renderedHtml.slice(0, 3_000_000) + "\n<!-- MirrorLab: 3 MB sınırında kısaltıldı -->";
      result.limits.push("Render edilmiş HTML 3 MB ile sınırlandı.");
    }
    result.renderedBytes = result.renderedHtml.length;
    } catch (e) {
      result.limits.push("Render edilmiş DOM alınamadı: " + String(e.message).slice(0, 120));
      result.renderedHtml = "";
    }

    /* ---------------- tasarım sistemi + içerik çıkarımı (tekrar denemeli) ---------------- */
    let evald = null;
    for (let attempt = 0; attempt < 2 && !evald; attempt++) {
    try {
      evald = await page.evaluate(() => {
      const inc = (map, k, sel) => {
        if (!k || k === "none" || k === "normal" || k === "auto" || k === "0px") return;
        if (!map[k]) map[k] = { value: k, count: 0, samples: [] };
        map[k].count += 1;
        if (map[k].samples.length < 3 && sel) map[k].samples.push(sel);
      };
      const color = {}, font = {}, radius = {}, shadow = {}, spacing = {}, size = {}, weight = {};
      /* --- renk normalizasyonu: rgb/rgba/hex/lab/lch/oklab/oklch/color() → #rrggbb(aa) --- */
      const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
      const g = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
      const hex2 = (v) => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, "0");
      const srgbHex = (r, gg, b, a) => {
        let h = "#" + hex2(g(r)) + hex2(g(gg)) + hex2(g(b));
        if (a !== undefined && a < 1) h += hex2(a);
        return h;
      };
      const labToXyz = (L, a, b) => {
        const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
        const f = (t) => (t > 6 / 29 ? t * t * t : (t - 4 / 29) * 3 * (6 / 29) * (6 / 29));
        return [0.95047 * f(fx), f(fy), 1.08883 * f(fz)];
      };
      const xyzToSrgb = (x, y, z) => [
        x * 3.2406 + y * -1.5372 + z * -0.4986,
        x * -0.9689 + y * 1.8758 + z * 0.0415,
        x * 0.0557 + y * -0.2040 + z * 1.0570,
      ];
      const oklabToSrgb = (L, a, b) => {
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
        const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
        return [
          l * 4.0767416621 + m * -3.3077115913 + s * 0.2309699292,
          l * -1.2684380046 + m * 2.6097574011 + s * -0.3413193965,
          l * -0.0041960863 + m * -0.7034186147 + s * 1.7076147010,
        ];
      };
      const num = (t) => t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
      /* Kesin yöntem: rengi canvas'a boyayıp pikseli oku (lab/oklab/color() dahil) */
      const _cx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      _cx.canvas.width = 1; _cx.canvas.height = 1;
      const pixelColor = (c) => {
        try {
          _cx.clearRect(0, 0, 1, 1);
          _cx.fillStyle = "#000000";
          _cx.fillStyle = c;
          if (String(_cx.fillStyle) === "#000000" && !/black|rgb\(0,\s*0,\s*0\)|#000\b|oklab\(0 0 0|lab\(0 /i.test(c)) {
            /* atanamadı ya da gerçekten siyah; piksel kontrolüyle doğrula */
          }
          _cx.fillRect(0, 0, 1, 1);
          const d = _cx.getImageData(0, 0, 1, 1).data;
          const h = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
          const a = d[3] / 255;
          return a < 0.999 ? h + Math.round(a * 255).toString(16).padStart(2, "0") : h;
        } catch (e) { return null; }
      };
      const _colorCache = new Map();
      const normColor = (c) => {
        try {
          if (!c) return c;
          if (_colorCache.has(c)) return _colorCache.get(c);
          const px = pixelColor(c);
          if (px && /^#[0-9a-f]{6,8}$/.test(px)) { _colorCache.set(c, px); return px; }
          const low = c.toLowerCase().trim();
          if (low === "transparent" || low === "rgba(0, 0, 0, 0)") return low;
          let m = low.match(/^#([0-9a-f]{3,8})$/i);
          if (m) {
            let h = m[1];
            if (h.length === 3) h = h.split("").map((x) => x + x).join("");
            if (h.length === 6) h += "ff";
            if (h.length === 4) h = h.slice(0, 3).split("").map((x) => x + x).join("") + h[3] + h[3];
            return "#" + h;
          }
          m = low.match(/^rgba?\(([^)]+)\)$/);
          if (m) {
            const p = m[1].split(/[\s,\/]+/).filter((x) => x.length).map((x) => x.trim());
            const r = num(p[0]) / (p[0].endsWith("%") ? 1 : 255);
            const gg = num(p[1]) / (p[1].endsWith("%") ? 1 : 255);
            const b = num(p[2]) / (p[2].endsWith("%") ? 1 : 255);
            const a = p[3] === undefined ? 1 : num(p[3]);
            return srgbHex(r, gg, b, a);
          }
          m = low.match(/^(oklab|lab)\(([^)]+)\)$/);
          if (m) {
            const parts = m[2].split(/[\s,\/]+/).filter((x) => x.length).map((x) => x.trim());
            let L = parseFloat(parts[0]);
            if (parts[0].endsWith("%")) L = parseFloat(parts[0]);
            const A = parseFloat(parts[1]), B = parseFloat(parts[2]);
            const a = parts[3] === undefined ? 1 : (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
            const rgbLin = m[1] === "oklab" ? oklabToSrgb(parts[0].endsWith("%") ? L / 100 : L, A, B)
                                           : xyzToSrgb(...labToXyz(L, A, B));
            return srgbHex(clamp(rgbLin[0], 0, 1), clamp(rgbLin[1], 0, 1), clamp(rgbLin[2], 0, 1), a);
          }
          m = low.match(/^(oklch|lch)\(([^)]+)\)$/);
          if (m) {
            const parts = m[2].split(/[\s,\/]+/).filter((x) => x.length).map((x) => x.trim());
            const L = parts[0].endsWith("%") ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
            const C = parseFloat(parts[1]);
            const H = parseFloat(parts[2]) * Math.PI / 180;
            const a = parts[3] === undefined ? 1 : parseFloat(parts[3]);
            const A = C * Math.cos(H), B = C * Math.sin(H);
            const rgbLin = m[1] === "oklch" ? oklabToSrgb(L, A, B) : xyzToSrgb(...labToXyz(L, A, B));
            return srgbHex(clamp(rgbLin[0], 0, 1), clamp(rgbLin[1], 0, 1), clamp(rgbLin[2], 0, 1), a);
          }
          m = low.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
          if (m) return srgbHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : parseFloat(m[4]));
          return c;
        } catch (e) { return c; }
      };
      const comp = {};
      const nodes = Array.from(document.querySelectorAll("body *")).slice(0, 2500);
      const norm = (v) => v.replace(/\s+/g, " ");
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        const sel = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
          (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
        if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent")
          inc(color, normColor(cs.backgroundColor), sel);
        if (cs.color) inc(color, normColor(cs.color), sel);
        if (cs.fontFamily) inc(font, cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(), sel);
        inc(radius, cs.borderRadius, sel);
        if (cs.boxShadow && cs.boxShadow !== "none") inc(shadow, norm(cs.boxShadow), sel);
        inc(size, cs.fontSize, sel);
        inc(weight, cs.fontWeight, sel);
        const pad = cs.padding.split(" ");
        const pb = pad.filter((p) => /px/.test(p) && p !== "0px");
        if (pb.length) inc(spacing, pb.join(" "), sel);
        // bileşen örnekleri
        if (!comp.button && (el.tagName === "BUTTON" || (el.tagName === "A" && /btn|button|cta/i.test(el.className || "")))) {
          comp.button = snapshot(el, cs, sel);
        }
        if (!comp.input && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) comp.input = snapshot(el, cs, sel);
        if (!comp.link && el.tagName === "A" && el.innerText.trim()) comp.link = snapshot(el, cs, sel);
        if (!comp.heading && /^H1$/.test(el.tagName)) comp.heading = snapshot(el, cs, sel);
        if (!comp.nav && (el.tagName === "NAV" || el.getAttribute("role") === "navigation")) comp.nav = snapshot(el, cs, sel);
        if (!comp.card && /card|tile|panel|box/i.test(el.className || "") && r.width > 150 && r.height > 100) comp.card = snapshot(el, cs, sel);
      }
      function snapshot(el, cs, sel) {
        return {
          selector: sel, tag: el.tagName.toLowerCase(),
          text: (el.innerText || "").slice(0, 80),
          background: normColor(cs.backgroundColor), color: normColor(cs.color),
          borderColor: normColor(cs.borderColor),
          fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
          fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
          padding: cs.padding, margin: cs.margin, borderRadius: cs.borderRadius,
          border: cs.borderWidth + " " + cs.borderStyle + " " + cs.borderColor,
          boxShadow: cs.boxShadow, display: cs.display, gap: cs.gap,
          transition: cs.transition.slice(0, 90), letterSpacing: cs.letterSpacing,
          textTransform: cs.textTransform,
        };
      }

      // font dosyaları (gerçekten kullanılanlar)
      const usedFonts = Array.from(document.fonts || []).map((f) => ({
        family: f.family, weight: f.weight, style: f.style,
        status: f.status, url: f.origin || (f._url || ""),
      }));

      // SEO / meta
      const meta = {};
      document.querySelectorAll("meta").forEach((m) => {
        const k = (m.getAttribute("name") || m.getAttribute("property") || "").toLowerCase();
        if (k) meta[k] = m.getAttribute("content");
      });

      // içerik: başlıklar, formlar, linkler
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .slice(0, 60).map((h) => ({ level: +h.tagName[1], text: h.innerText.replace(/\s+/g, " ").trim().slice(0, 160) }))
        .filter((h) => h.text);
      const forms = Array.from(document.querySelectorAll("form")).slice(0, 10).map((f) => ({
        action: f.getAttribute("action") || "", method: (f.getAttribute("method") || "get").toUpperCase(),
        inputs: Array.from(f.querySelectorAll("input,select,textarea,button")).slice(0, 20).map((i) => ({
          tag: i.tagName.toLowerCase(), type: i.getAttribute("type") || "", name: i.getAttribute("name") || "",
          placeholder: (i.getAttribute("placeholder") || "").slice(0, 60), required: i.hasAttribute("required"),
          label: (i.labels && i.labels[0]) ? i.labels[0].innerText.slice(0, 60) : "",
        })),
      }));
      const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 400).map((a) => ({
        href: a.href, text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
        internal: a.host === location.host, inNav: !!a.closest("nav,header,[role=navigation]"),
      }));
      const images = Array.from(document.querySelectorAll("img")).slice(0, 300).map((i) => ({
        src: i.currentSrc || i.src, alt: i.alt || "", w: i.naturalWidth, h: i.naturalHeight,
        loaded: i.complete && i.naturalWidth > 0, lazy: i.loading === "lazy",
        displayed: Math.round(i.getBoundingClientRect().width),
      }));
      const videos = Array.from(document.querySelectorAll("video,iframe[src*='youtu'],iframe[src*='vimeo']"))
        .slice(0, 30).map((v) => ({ tag: v.tagName.toLowerCase(), src: v.currentSrc || v.src || "", title: v.title || "" }));

      // erişilebilirlik hızlı taraması
      const imgsNoAlt = Array.from(document.querySelectorAll("img:not([alt])")).length;
      const emptyBtns = Array.from(document.querySelectorAll("button")).filter((b) => !b.innerText.trim() && !b.getAttribute("aria-label")).length;
      const unlabeled = Array.from(document.querySelectorAll("input")).filter((i) =>
        !["hidden", "submit", "button"].includes(i.type) && !i.labels?.length && !i.getAttribute("aria-label")).length;

      // localStorage / sessionStorage anahtarları (değerler gizlenir)
      const ls = []; try { for (let i = 0; i < localStorage.length; i++) ls.push(localStorage.key(i)); } catch (e) {}

      return {
        colors: topify(color, 14), fonts: topify(font, 8), radii: topify(radius, 8),
        shadows: topify(shadow, 6), spacings: topify(spacing, 10),
        fontSizes: topify(size, 10), fontWeights: topify(weight, 6),
        components: comp, usedFonts, meta, headings, forms, links, images, videos,
        a11y: { imgsNoAlt, emptyBtns, unlabeled, lang: document.documentElement.lang || "" },
        storageKeys: ls,
        counts: {
          nodes: document.querySelectorAll("*").length,
          scripts: document.querySelectorAll("script").length,
          stylesheets: document.querySelectorAll("link[rel=stylesheet]").length,
          inlineStyles: document.querySelectorAll("style").length,
          images: document.querySelectorAll("img").length,
          iframes: document.querySelectorAll("iframe").length,
          links: document.querySelectorAll("a[href]").length,
        },
        frameworks: detectFrameworks(),
      };

      function topify(map, n) {
        return Object.values(map).sort((a, b) => b.count - a.count).slice(0, n);
      }
      function detectFrameworks() {
        const F = [];
        const add = (name, ev) => F.push({ name, evidence: String(ev).slice(0, 90) });
        if (window.React || document.querySelector("[data-reactroot]") || document.querySelector("#__next, #root > *")) {
          if (window.__NEXT_DATA__) add("Next.js", "__NEXT_DATA__ globali");
          else if (window.__NUXT__) add("Nuxt", "__NUXT__ globali");
          else if (document.querySelector(".gatsby-focus-wrapper")) add("Gatsby", "gatsby wrapper");
          else add("React", window.React ? "window.React" : "React DOM işaretleri");
        }
        if (window.Vue || document.querySelector("[data-v-app]")) add("Vue.js", "window.Vue / data-v-app");
        if (window.Svelte || document.querySelector("[class*='svelte-']")) add("Svelte", "svelte sınıfları");
        if (window.angular || document.querySelector("[ng-version]")) add("Angular", "ng-version / window.angular");
        if (window.jQuery) add("jQuery " + window.jQuery.fn.jquery, "window.jQuery sürümü");
        if (window.__NUXT__) add("Nuxt", "__NUXT__");
        if (window.__NEXT_DATA__) add("Next.js", "__NEXT_DATA__");
        if (window.Shopify || window.ShopifyAnalytics) add("Shopify", "window.Shopify");
        if (window.wp || document.body.innerHTML.includes("wp-content")) add("WordPress", "wp-content yolları");
        if (window.__sveltekit_ || window.__SVELTEKIT_DATA__) add("SvelteKit", "__sveltekit__");
        if (window.dataLayer) add("Google Tag Manager / dataLayer", "window.dataLayer var");
        if (window.gtag) add("Google Analytics 4", "window.gtag");
        if (window.fbq) add("Meta Pixel", "window.fbq");
        if (window.Stripe) add("Stripe.js", "window.Stripe");
        if (window.__remixContext) add("Remix", "__remixContext");
        if (window.__APOLLO_STATE__) add("Apollo GraphQL", "__APOLLO_STATE__");
        if (window.tailwind || document.querySelector("[class*='md:'], [class*='lg:']")) add("Tailwind CSS (olası)", "duyarlı sınıf kalıpları");
        if (window.bootstrap) add("Bootstrap JS", "window.bootstrap");
        return F;
      }
      });
    } catch (e) {
      result.limits.push("Tasarım taraması denemesi " + (attempt + 1) + " başarısız: " + String(e.message).slice(0, 110));
      await sleep(1200);
    }
    }
    if (!evald) {
      evald = { colors: [], fonts: [], radii: [], shadows: [], spacings: [], fontSizes: [],
                fontWeights: [], components: {}, usedFonts: [], meta: {}, headings: [], forms: [],
                links: [], images: [], videos: [], a11y: {}, storageKeys: [],
                counts: {}, frameworks: [] };
    }
    result.design.colors = evald.colors;
    result.design.fonts = evald.fonts;
    result.design.radii = evald.radii;
    result.design.shadows = evald.shadows;
    result.design.spacings = evald.spacings;
    result.design.fontSizes = evald.fontSizes;
    result.design.components = evald.components;
    result.design.usedFonts = evald.usedFonts;
    result.seo = {
      title, ...evald.meta,
      canonical: await page.evaluate(() => (document.querySelector("link[rel=canonical]") || {}).href || ""),
      h1: evald.headings.filter((h) => h.level === 1).map((h) => h.text),
    };
    result.headings = evald.headings;
    result.forms = evald.forms;
    result.links = evald.links;
    result.images = evald.images;
    result.videos = evald.videos;
    result.a11y = evald.a11y;
    result.storageKeys = evald.storageKeys;
    result.domCounts = evald.counts;
    result.frameworks = evald.frameworks;
    result.api = dedupeApi(apiList);

    /* ---------------- script bundle'ları + source map ----------------
       REA'nın "modules, imports, source maps" yaklaşımı: bundle'ları listeler,
       source map varsa okunabilir kaynak dosya listesini çıkarır. */
    const scriptUrls = evald.meta && (await page.evaluate(() =>
      Array.from(document.querySelectorAll("script[src]")).map((s) => s.src))) || [];
    result.scripts = [];
    const bigScripts = result.network.filter((n) => n.type === "script" && n.status < 400)
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .filter((n, i) => n.size > 8000 || i < 12)
      .slice(0, 25);
    for (const s of bigScripts.slice(0, 10)) {
      if (timeLeft() < 8000) break;
      const sm = s.url.replace(/#.*$/, "") + ".map";
      let hasMap = false, mapSources = 0, mapBytes = 0, sourceNames = [];
      try {
        const r = await fetch(sm, { headers: { "User-Agent": UA } });
        if (r.ok) {
          const j = await r.json();
          hasMap = true;
          sourceNames = (j.sources || []).slice(0, 40);
          mapSources = (j.sources || []).length;
          mapBytes = (j.sourcesContent || []).reduce((a, c) => a + (c ? c.length : 0), 0);
        }
      } catch (e) {}
      result.scripts.push({
        url: s.url, size: s.size || null, status: s.status,
        minified: s.url.includes(".min.") || /\.min\.js/.test(s.url),
        sourceMap: hasMap ? { url: sm, sources: mapSources, sourceBytes: mapBytes, sample: sourceNames } : null,
      });
    }
    if (scriptUrls.length) result.scriptTagCount = scriptUrls.length;

    /* ---------------- etkileşim sondası (opsiyonel) ---------------- */
    result.flows = [];
    if (cfg.probe) {
      const cur = result.finalUrl.replace(/#.*$/, "");
      const linkPool = evald.links.filter((l) => l.internal && l.href &&
        !/^(javascript|mailto|tel|#)/i.test(l.href) &&
        !/\.(png|jpe?g|svg|pdf|zip|mp4|css|js)$/i.test(l.href) && l.text);
      linkPool.sort((a, b) => (b.inNav ? 1 : 0) - (a.inNav ? 1 : 0));
      const navLinks = dedupeByHref(linkPool, cur).slice(0, Number(cfg.probeCount) || 3);
      for (const l of navLinks) {
        if (timeLeft() < 12000) break;
        const f = { from: result.finalUrl, to: l.href, label: l.text, requests: [], finalUrl: "", ms: 0 };
        const t = Date.now();
        const p2 = await browser.newPage();
        await p2.setUserAgent(UA);
        const seen = [];
        p2.on("request", (r) => {
          const ty = r.resourceType();
          if (["xhr", "fetch", "document"].includes(ty)) seen.push({ method: r.method(), url: r.url(), type: ty });
        });
        try {
          await p2.goto(l.href, { waitUntil: "domcontentloaded", timeout: 25000 });
          await sleep(2200);
          f.finalUrl = p2.url();
          f.title = await p2.title();
          f.requests = seen.slice(0, 25);
        } catch (e) {
          f.error = e.message.slice(0, 140);
        }
        f.ms = Date.now() - t;
        await p2.close();
        result.flows.push(f);
      }
      if (result.flows.length) result.limits.push("Etkileşim sondası yalnızca gezinme bağlantılarını dener; oturum/giriş gerektiren akışlar kapsam dışıdır.");
    }

    /* ---------------- rapor alanları ---------------- */
    result.evidence = {
      "render edilmiş DOM": `document.documentElement (${Math.round(result.renderedBytes / 1024)} KB)`,
      "ağ kaydı": `${result.network.length} istek / ${result.api.length} API çağrısı`,
      "tasarım token'ları": `${result.design.colors.length} renk, ${result.design.fonts.length} font, ${result.design.radii.length} köşe yarıçapı`,
      "ekran görüntüsü": Object.keys(result.screenshots).length + " görünüm + " + result.sections.filter((s) => s.shot).length + " bölüm",
      "çatı tespiti": result.frameworks.map((f) => f.name).join(", ") || "tespit edilemedi",
    };
    if (result.frameworks.length === 0) result.limits.push("Çatı tespiti bulgu vermedi: site minify edilmiş/özel bir yığın kullanıyor olabilir.");
    if (result.api.length === 0) result.limits.push("XHR/fetch API çağrısı yakalanmadı (sayfa tamamen sunucu tarafı render edilmiş olabilir).");
    result.limits.push("API gövdeleri yalnızca ilk 12 KB önizleme olarak saklanır; oturum belirteçleri gövdede olabilir, paylaşırken dikkat edin.");
    result.limits.push("Sunucu tarafı kod (PHP/Python/DB) istemciye gelmediği için çıkarılamaz; bu analiz davranış, ağ ve arayüz seviyesindedir.");

    result.ok = true;
    result.elapsedMs = Date.now() - t0;
  } catch (e) {
    result.error = e.message;
    result.limits.push("Motor hatası: " + e.message.slice(0, 200));
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}   // uzak bağlantıda bu, oturumu serbest bırakır
    try {
      fs.writeFileSync(cfg.outFile, JSON.stringify(result));
      console.log(JSON.stringify({ ok: result.ok, out: cfg.outFile, error: result.error || null }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: "yazma hatası: " + e.message }));
    }
    process.exit(result.ok ? 0 : 1);
  }
})();

/* ------------------------- yardımcılar ------------------------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function dedupeByHref(list, current) {
  const seen = new Set([current.replace(/#.*$/, ""), current.replace(/#.*$/, "") + "/"]);
  const out = [];
  for (const l of list) {
    const k = l.href.replace(/#.*$/, "").replace(/\/$/, "");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

function safeHeaders(h) { const o = {}; for (const k in h) { try { o[k] = String(h[k]).slice(0, 500); } catch (e) {} } return o; }

function pickHeaders(h) {
  const keep = ["content-type", "content-length", "server", "cache-control", "etag",
    "last-modified", "content-encoding", "x-powered-by", "cf-cache-status", "x-vercel-id",
    "access-control-allow-origin", "set-cookie", "content-security-policy", "x-frame-options",
    "strict-transport-security", "vary", "location", "x-cache", "x-amz-cf-id"];
  const o = {};
  keep.forEach((k) => { if (h[k] !== undefined) o[k] = k === "set-cookie" ? "(gizlendi)" : String(h[k]).slice(0, 300); });
  return o;
}

function guessApiKind(url, txt) {
  if (/graphql/i.test(url) || /"query"|"operationName"/.test(txt.slice(0, 400))) return "GraphQL";
  if (/\.json($|\?)/i.test(url)) return "JSON dosyası";
  if (/api|rest|v\d/i.test(url)) return "REST";
  return "Veri";
}

function shape(txt) {
  try {
    const j = JSON.parse(txt);
    const keys = (o, d = 0) => {
      if (d > 2 || !o || typeof o !== "object") return typeof o === "object" ? (Array.isArray(o) ? "array" : typeof o) : typeof o;
      if (Array.isArray(o)) return [o.length ? keys(o[0], d + 1) : "?"];
      const out = {};
      Object.keys(o).slice(0, 14).forEach((k) => { out[k] = keys(o[k], d + 1); });
      return out;
    };
    return keys(j);
  } catch (e) { return null; }
}

function dedupeApi(list) {
  const seen = new Map();
  for (const a of list) {
    const k = a.method + " " + a.url;
    if (!seen.has(k)) seen.set(k, { ...a, hits: 1 });
    else seen.get(k).hits += 1;
  }
  return Array.from(seen.values()).sort((a, b) => b.hits - a.hits).slice(0, 60);
}

async function autoScroll(page, lowmem) {
  const cap = lowmem ? 6000 : 12000;
  await page.evaluate(async (maxH) => {
    await new Promise((resolve) => {
      let total = 0;
      const step = () => {
        window.scrollBy(0, 1000);
        total += 1000;
        if (total < Math.min(document.body.scrollHeight, maxH)) setTimeout(step, 70);
        else { window.scrollTo(0, 0); setTimeout(resolve, 400); }
      };
      step();
    });
  }, cap);
}

async function safeText(page, sel) {
  try { return await page.$eval(sel, (e) => e.innerText || ""); } catch (e) { return ""; }
}
