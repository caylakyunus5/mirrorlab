/**
 * MirrorLab — Cloudflare Browser Rendering ile derin analiz (ücretsiz: günde 10 dakika Chrome)
 * ============================================================================================
 * Bu modül Worker içinden `env.BROWSER` bağlayıcısıyla Cloudflare'in headless Chrome'unu
 * kullanır ve MirrorLab'ın yerel motorunun (engine.js) hafif bir sürümünü çalıştırır:
 *   - ağ kaydı (istek/yanıt, durum, boyut, süre)
 *   - XHR/fetch API çağrıları
 *   - render edilmiş DOM sayaçları + çatı tespiti
 *   - tasarım token'ları (renk, font, köşe, gölge)
 *   - bölüm haritası
 *   - ekran görüntüsü (data URL olarak, boyut sınırlı)
 *
 * Ücretsiz katman: Workers Free → günde 10 dakika tarayıcı süresi, 3 eşzamanlı tarayıcı.
 * Bir analiz tipik olarak 6-15 sn sürer → `light=1` ile günde ~40-60 analiz.
 */

import puppeteer from "@cloudflare/puppeteer";

const MAX_NETWORK = 250;
const MAX_API = 30;
const MAX_BODY = 4000;              // API gövde önizlemesi (karakter)
const MAX_SHOT_BYTES = 1_400_000;   // data URL üst sınırı (~1.4 MB)

/** Sayfa içinde çalışan çıkarım betiği (tasarım + yapı) */
function extractorScript() {
  return function () {
    const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    cv.canvas.width = 1; cv.canvas.height = 1;
    const px = (c) => {
      try {
        cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c;
        cv.fillRect(0, 0, 1, 1);
        const d = cv.getImageData(0, 0, 1, 1).data;
        return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      } catch (e) { return null; }
    };
    const bump = (m, k, sel) => {
      if (!k || k === "none" || k === "normal" || k === "auto") return;
      m[k] = m[k] || { value: k, count: 0, samples: [] };
      m[k].count++;
      if (m[k].samples.length < 2 && sel) m[k].samples.push(sel);
    };
    const top = (m, n) => Object.values(m).sort((a, b) => b.count - a.count).slice(0, n);

    const color = {}, font = {}, radius = {}, shadow = {}, size = {}, space = {};
    const comps = {};
    const nodes = Array.from(document.querySelectorAll("body *")).slice(0, 2000);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const cs = getComputedStyle(el);
      const sel = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
        (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") bump(color, px(cs.backgroundColor) || cs.backgroundColor, sel);
      if (cs.color) bump(color, px(cs.color) || cs.color, sel);
      if (cs.fontFamily) bump(font, cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(), sel);
      bump(radius, cs.borderRadius, sel);
      if (cs.boxShadow && cs.boxShadow !== "none") bump(shadow, cs.boxShadow.replace(/\s+/g, " ").slice(0, 120), sel);
      bump(size, cs.fontSize, sel);
      const pad = cs.padding.split(" ").filter((p) => /px/.test(p) && p !== "0px");
      if (pad.length) bump(space, pad.join(" "), sel);
      const snap = (name) => {
        if (comps[name]) return;
        comps[name] = {
          selector: sel, text: (el.innerText || "").slice(0, 60),
          background: px(cs.backgroundColor) || cs.backgroundColor, color: px(cs.color) || cs.color,
          fontFamily: cs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(),
          fontSize: cs.fontSize, fontWeight: cs.fontWeight, padding: cs.padding,
          borderRadius: cs.borderRadius, border: `${cs.borderWidth} ${cs.borderStyle} ${px(cs.borderColor) || cs.borderColor}`,
          boxShadow: cs.boxShadow.slice(0, 90), transition: cs.transition.slice(0, 70),
        };
      };
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) snap("form");
      else if (el.tagName === "A" && el.innerText.trim()) snap("link");
      else if (el.tagName === "H1") snap("heading");
      else if (el.tagName === "NAV" || el.getAttribute("role") === "navigation") snap("nav");
    }

    // bölüm haritası: sayfanın çoğunu kaplayan kapsayıcının bölüm-benzeri çocukları
    const docH = Math.max(document.documentElement.scrollHeight, 1);
    const depthOf = (el) => { let d = 0, n = el; while (n && n !== document.body) { n = n.parentElement; d++; } return d; };
    let best = null, bestScore = -1;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.height < docH * 0.3 || r.width < 300) continue;
      const kids = Array.from(el.children).filter((k) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(k.tagName) && k.getBoundingClientRect().height > 120);
      if (kids.length < 2) continue;
      const score = kids.length * 3 + depthOf(el) - (r.height / docH) * 2;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    const sections = (best ? Array.from(best.children) : []).filter((k) => k.getBoundingClientRect().height > 120)
      .slice(0, 20).map((el, i) => {
        const r = el.getBoundingClientRect();
        const h = el.querySelector("h1,h2,h3");
        return {
          i, tag: el.tagName.toLowerCase(),
          cls: typeof el.className === "string" ? el.className.slice(0, 80) : "",
          h: Math.round(r.height),
          heading: h ? h.innerText.replace(/\s+/g, " ").slice(0, 100) : "",
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 140),
          imgs: el.querySelectorAll("img").length, links: el.querySelectorAll("a").length,
          buttons: el.querySelectorAll("button,[role=button]").length,
        };
      });

    const F = [];
    const add = (name, ev) => F.push({ name, evidence: String(ev).slice(0, 80) });
    if (window.__NEXT_DATA__) add("Next.js", "__NEXT_DATA__");
    else if (window.__NUXT__) add("Nuxt", "__NUXT__");
    else if (window.React) add("React", "window.React");
    if (window.Vue || document.querySelector("[data-v-app]")) add("Vue.js", "window.Vue");
    if (window.angular || document.querySelector("[ng-version]")) add("Angular", "ng-version");
    if (window.jQuery) add("jQuery " + window.jQuery.fn.jquery, "window.jQuery");
    if (window.dataLayer) add("Google Tag Manager", "dataLayer");
    if (window.gtag) add("Google Analytics 4", "gtag");
    if (window.fbq) add("Meta Pixel", "fbq");
    if (window.Stripe) add("Stripe.js", "window.Stripe");
    if (window.bootstrap) add("Bootstrap JS", "window.bootstrap");
    const cls = document.documentElement.className || "";
    if (/\bsvelte-|__sveltekit/.test(cls) || window.__sveltekit_) add("SvelteKit", "svelte izleri");
    if (document.querySelector("link[href*='tailwind'],style[data-tailwind]") || /(^|\s)(md:|lg:|hover:)/.test(document.body.innerHTML.slice(0, 4000))) add("Tailwind CSS (olası)", "utility sınıfları");

    const govdeMetni = (document.body ? document.body.innerText : "").slice(0, 600);
    const botKoruma = /just a moment|attention required|checking your browser|bir dakika|verify you are human|captcha/i
      .test((document.title || "") + " " + govdeMetni);
    return {
      title: document.title,
      lang: document.documentElement.lang || "",
      blockedChallenge: botKoruma,
      textSample: govdeMetni.slice(0, 300),
      counts: {
        nodes: document.querySelectorAll("*").length,
        scripts: document.querySelectorAll("script").length,
        stylesheets: document.querySelectorAll("link[rel=stylesheet]").length,
        images: document.querySelectorAll("img").length,
        links: document.querySelectorAll("a[href]").length,
        iframes: document.querySelectorAll("iframe").length,
        forms: document.querySelectorAll("form").length,
        docHeight: Math.round(docH),
      },
      meta: (() => {
        const m = {};
        document.querySelectorAll("meta[name],meta[property]").forEach((x) => {
          const k = (x.getAttribute("name") || x.getAttribute("property") || "").toLowerCase();
          if (k && ["description", "keywords", "generator", "og:title", "og:image", "og:description", "twitter:card"].includes(k))
            m[k] = (x.getAttribute("content") || "").slice(0, 240);
        });
        return m;
      })(),
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 20)
        .map((h) => ({ level: +h.tagName[1], text: h.innerText.replace(/\s+/g, " ").slice(0, 120) })).filter((h) => h.text),
      design: {
        colors: top(color, 12), fonts: top(font, 6), radii: top(radius, 6),
        shadows: top(shadow, 4), fontSizes: top(size, 8), spacings: top(space, 8),
        components: comps,
      },
      sections, frameworks: F, htmlBytes: document.documentElement.outerHTML.length,
    };
  };
}

export async function deepAnalyze(env, target, opts = {}) {
  const light = !!opts.light;
  const mobile = !!opts.mobile;
  const t0 = Date.now();
  const out = {
    ok: false, engine: "cloudflare-browser-rendering", url: target,
    finalUrl: "", title: "", network: [], api: [], screenshots: {},
    design: {}, sections: [], frameworks: [], counts: {}, meta: {}, headings: [],
    elapsedMs: 0, limits: [
      "Cloudflare Browser Rendering ücretsiz katmanı: günde 10 dakika tarayıcı süresi.",
      "Derin analiz uç noktası (`/api/deep`) yerel motorun (engine.js) hafif sürümüdür: kaynak haritası, akış sondası ve mobil görünüm yok.",
      "Ekran görüntüleri data URL olarak döner ve ~1.4 MB ile sınırlıdır; kalıcı saklama için R2 bağlayın.",
    ],
  };

  let browser = null;
  try {
    browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60_000 });
    const page = await browser.newPage();
    await page.setViewport(mobile
      ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { width: 1440, height: 900, deviceScaleFactor: 1 });

    const reqMeta = new Map();
    let seq = 0;
    const apiList = [];
    let bodyBudget = 0;

    page.on("request", (req) => {
      seq++;
      reqMeta.set(req, { seq, method: req.method(), url: req.url(), type: req.resourceType(), start: Date.now() });
    });
    page.on("response", async (res) => {
      const req = res.request();
      const m = reqMeta.get(req) || { seq: seq++, method: req.method(), url: req.url(), type: req.resourceType(), start: Date.now() };
      const h = res.headers() || {};
      const entry = {
        seq: m.seq, method: m.method, url: m.url.slice(0, 400), type: m.type,
        status: res.status(),
        mime: (h["content-type"] || "").split(";")[0],
        size: parseInt(h["content-length"] || "0", 10) || 0,
        ms: Date.now() - (m.start || Date.now()),
      };
      const isApi = ["xhr", "fetch"].includes(m.type);
      entry.api = isApi;
      if (out.network.length < MAX_NETWORK) out.network.push(entry);

      if (isApi && apiList.length < MAX_API && bodyBudget < 60_000) {
        try {
          const txt = await res.text();
          bodyBudget += txt.length;
          let shape = null;
          try {
            const j = JSON.parse(txt);
            const walk = (o, d = 0) => {
              if (d > 2 || o === null) return typeof o;
              if (Array.isArray(o)) return [o.length ? walk(o[0], d + 1) : "?"];
              if (typeof o === "object") {
                const r = {};
                Object.keys(o).slice(0, 12).forEach((k) => { r[k] = walk(o[k], d + 1); });
                return r;
              }
              return typeof o;
            };
            shape = walk(j);
          } catch (e) { shape = null; }
          apiList.push({
            method: m.method, url: m.url.slice(0, 300), status: res.status(),
            mime: entry.mime, jsonShape: shape,
            bodyPreview: txt.slice(0, MAX_BODY),
          });
        } catch (e) { /* gövde okunamadı */ }
      }
    });

    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }); } catch (e) {}
    if (!light) {
      await page.evaluate(async () => {
        await new Promise((res) => {
          let y = 0;
          const step = () => {
            window.scrollBy(0, 900); y += 900;
            if (y < Math.min(document.body.scrollHeight, 9000)) setTimeout(step, 60);
            else { window.scrollTo(0, 0); setTimeout(res, 300); }
          };
          step();
        });
      });
      try { await page.waitForNetworkIdle({ idleTime: 600, timeout: 4000 }); } catch (e) {}
    }

    out.finalUrl = page.url();
    const data = await page.evaluate(extractorScript());
    Object.assign(out, {
      title: data.title, counts: data.counts, meta: data.meta,
      blockedChallenge: !!data.blockedChallenge, textSample: data.textSample || "",
      headings: data.headings, design: data.design, sections: data.sections,
      frameworks: data.frameworks, renderedBytes: data.htmlBytes,
    });

    // ekran görüntüsü (hafif mod: yalnızca görünüm alanı, jpeg)
    try {
      const shot = await page.screenshot({
        type: "jpeg", quality: light ? 55 : 65,
        fullPage: false, encoding: "base64",
      });
      const b64 = typeof shot === "string" ? shot : bufToBase64(shot);
      if (b64.length < MAX_SHOT_BYTES) {
        out.screenshots.viewport = `data:image/jpeg;base64,${b64}`;
        out.screenshots.viewportBytes = b64.length;
      } else {
        out.limits.push("Ekran görüntüsü boyut sınırını aştı, atlandı.");
      }
      if (!light && data.counts.docHeight < 8000) {
        const full = await page.screenshot({ type: "jpeg", quality: 50, fullPage: true, encoding: "base64" });
        const fb = typeof full === "string" ? full : bufToBase64(full);
        if (fb.length < MAX_SHOT_BYTES) {
          out.screenshots.full = `data:image/jpeg;base64,${fb}`;
          out.screenshots.fullBytes = fb.length;
        }
      }
    } catch (e) {
      out.limits.push("Ekran görüntüsü alınamadı: " + String(e.message).slice(0, 90));
    }

    out.api = apiList;
    out.ok = true;
    out.limits.push(`Bu analiz Cloudflare tarayıcı süresinden ~${Math.max(1, Math.round((Date.now() - t0) / 1000))} sn harcadı (ücretsiz kota: 600 sn/gün).`);
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    out.elapsedMs = Date.now() - t0;
  }
  return out;
}

function bufToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
}
