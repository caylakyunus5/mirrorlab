  /* ═══════════════ TARAYICI İÇİ TAM AYNA (edge modu) ═══════════════
     Cloudflare Worker'ın ücretsiz sınırları (50 alt istek / 10 ms CPU) yüzünden
     "tam site kopyalama" sunucuda yapılamıyor; iş TARAYICIYA taşındı:
     sayfalar/varlıklar /api/raw ham proxy'sinden indirilir, bağlantılar
     yerelleştirilir, ZIP burada üretilir.

     [∞] SINIRSIZ MOD: sayfa/varlık/boyut sınırı YOKTUR. ZIP, tarayıcı
     desteği varsa doğrudan DİSKE akıtılır (File System Access API) — böylece
     bellek sınırı da yoktur. Disk akışı yoksa bellekte üretilir ve bellek
     taşmasını önlemek için yalnızca teknik bir tavan uygulanır (logda bildirilir).

     Tek gerçek tavan ZIP32 dosya biçiminden gelir: 65.535 dosya / 4 GB.
     ═══════════════════════════════════════════════════════════════ */

  /* ---- ZIP yazıcı (STORE + DEFLATE), bağımlılıksız ----
     Metin dosyaları (HTML/CSS/JS/SVG/JSON) deflate ile sıkıştırılır; sıkıştırma
     tarayıcının yerleşik CompressionStream("deflate-raw") API'siyle yapılır —
     harici kütüphane yok. JPEG/PNG/WOFF gibi zaten sıkışmış biçimler STORE kalır. */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function joinBytes(list) {
    let n = 0; for (const a of list) n += a.length;
    const out = new Uint8Array(n); let p = 0;
    for (const a of list) { out.set(a, p); p += a.length; }
    return out;
  }
  const U16 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255]);
  const U32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  function localHeader(nb, crc, method, csize, usize) {
    return new Uint8Array([...U32(0x04034b50), ...U16(20), ...U16(0x0800), ...U16(method), ...U16(0), ...U16(0),
      ...U32(crc), ...U32(csize), ...U32(usize), ...U16(nb.length), ...U16(0)]);
  }
  function centralHeader(nb, crc, method, csize, usize, off) {
    return new Uint8Array([...U32(0x02014b50), ...U16(20), ...U16(20), ...U16(0x0800), ...U16(method), ...U16(0), ...U16(0),
      ...U32(crc), ...U32(csize), ...U32(usize), ...U16(nb.length), ...U16(0), ...U16(0), ...U16(0), ...U16(0),
      ...U32(0), ...U32(off)]);
  }
  function eocd(count, cenLen, cenOff) {
    return new Uint8Array([...U32(0x06054b50), ...U16(0), ...U16(0), ...U16(count), ...U16(count), ...U32(cenLen), ...U32(cenOff), ...U16(0)]);
  }
  const TEXT_EXT = /\.(html?|css|js|mjs|cjs|json|txt|xml|svg|map|webmanifest|csv|md|ico|woff2?|m3u8|mpd)$/i;
  async function deflateRaw(u8) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const cs = new CompressionStream("deflate-raw");
      const w = cs.writable.getWriter();
      w.write(u8); w.close();
      const out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
      return out && out.length ? out : null;
    } catch (e) { return null; }
  }
  /* bir girdiyi kodla: sıkıştırmaya değiyorsa DEFLATE (yöntem 8), yoksa STORE (0) */
  async function encodeEntry(name, data) {
    const crc = crc32(data);
    let method = 0, payload = data;
    if (data.length > 200 && TEXT_EXT.test(name)) {
      const c = await deflateRaw(data);
      if (c && c.length < data.length * 0.97) { method = 8; payload = c; }
    }
    return { crc, method, payload, csize: payload.length, usize: data.length };
  }
  async function zipStore(files) {
    const recs = [], cen = [];
    let off = 0;
    for (const f of files) {
      const nb = new TextEncoder().encode(f.name), e = await encodeEntry(f.name, f.data);
      const lh = localHeader(nb, e.crc, e.method, e.csize, e.usize);
      recs.push(lh, nb, e.payload);
      cen.push(joinBytes([centralHeader(nb, e.crc, e.method, e.csize, e.usize, off), nb]));
      off += lh.length + nb.length + e.payload.length;
    }
    const cenStart = off, cenBytes = joinBytes(cen);
    return joinBytes([...recs, cenBytes, eocd(files.length, cenBytes.length, cenStart)]);
  }

  /* ---- ZIP32 teknik tavanları (dosya biçiminden gelir) ---- */
  const ZIP_MAX_FILES = 65000;              // 65.535 sınırı
  const ZIP_MAX_BYTES = 3.6 * 1024 * 1024 * 1024;   // 4 GB sınırı (pay bırakıldı)
  const MEM_WARN = 800 * 1024 * 1024;       // bellek modunda uyarı eşiği
  const MEM_STOP = 1700 * 1024 * 1024;      // bellek modunda zorunlu bitiş (sekme çökmesin)

  /* ---- yardımcılar ---- */
  function rawUrl(u) { return apiUrl("/api/raw?u=" + encodeURIComponent(u)); }
  function apiUrl(p) { const b = (window.MIRRORLAB_API || (window.MIRRORLAB_DEFAULT_API || "")).replace(/\/+$/, ""); return b + p; }
  /* ═══ SOURCE MAP -> ORİJİNAL KAYNAK AĞACI (REA derinliği) ═══════════════════
     JS dosyalarının sonundaki sourceMappingURL bağlantısı izlenir; harita
     dosyasındaki sourcesContent alanından ORİJİNAL kaynak kodlar çıkarılıp
     ZIP'e "_kaynak/<js-dosyası>/<yol>" olarak eklenir. Site haritaları
     yayınlamıyorsa sessizce atlanır. Telif: içerik sahibine aittir. */
  const KAYNAK_MAX_DOSYA = 600;
  const KAYNAK_MAX_BAYT = 30 * 1048576;
  const KAYNAK_MAP_MAX = 8 * 1048576;
  const KAYNAK_MAP_SAYI = 20;

  /* JS metninden sourceMappingURL değerini çek (yorum biçiminden bağımsız) */
  function sourceMapAdresi(txt) {
    const i = txt.lastIndexOf("sourceMappingURL=");
    if (i < 0) return null;
    let v = txt.slice(i + 17, i + 320);
    v = v.split(/[\s'"`]/)[0];
    if (!v || /^data:/i.test(v)) return null;
    return v;
  }

  /* Haritadaki kaynak yolunu ZIP içi güvenli yola çevir */
  function kaynakYolu(p, i) {
    let s = String(p || ("bilinmeyen-" + i)).trim();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");   // webpack:// , http:// …
    s = s.replace(/^(?:\.{1,2}\/|~?\/)+/, "");               // baştaki ./ ../ / kalıntıları
    if (!s || /\.\./.test(s)) s = "kaynaklar/" + s.replace(/\.\.\//g, "").replace(/^\.\//, "");
    return s.replace(/^\/+/, "") || ("bilinmeyen-" + i);
  }

  /* Haritaları indir, orijinal kaynakları ZIP'e ekle */
  async function kaynakTopla(links, sink, files, log) {
    const ozet = { harita: 0, dosya: 0, toplam: 0, hata: 0 };
    if (!links || !links.length) { log("  • source map bağlantısı bulunamadı (site kaynak haritası yayınlamıyor)"); return ozet; }
    log(":: source map taraması: " + links.length + " JS dosyasında kaynak haritası bağlantısı var");
    const gorulen = new Set();
    for (const L of links) {
      if (ozet.dosya >= KAYNAK_MAX_DOSYA || ozet.toplam >= KAYNAK_MAX_BAYT) break;
      let r;
      try { r = await rawFetch(L.abs); } catch (e) { ozet.hata++; continue; }
      if (!r.ok || !r.bytes.length || r.bytes.length > KAYNAK_MAP_MAX) { ozet.hata++; continue; }
      let map = null;
      try { map = JSON.parse(new TextDecoder().decode(r.bytes)); } catch (e) { ozet.hata++; continue; }
      const srcs = map.sources || [], icerik = map.sourcesContent || [];
      if (!srcs.length || !icerik.length) continue;
      ozet.harita++;
      const kok = L.outName.replace(/\.[a-z0-9]+$/i, "");
      let eklenen = 0;
      for (let i = 0; i < srcs.length; i++) {
        if (ozet.dosya >= KAYNAK_MAX_DOSYA || ozet.toplam >= KAYNAK_MAX_BAYT) break;
        const c = icerik[i];
        if (typeof c !== "string") continue;
        const ad = "_kaynak/" + kok + "/" + kaynakYolu(srcs[i], i);
        if (gorulen.has(ad)) continue;
        gorulen.add(ad);
        const data = new TextEncoder().encode(c);
        if (sink) await sink.put(ad, data); else files.push({ name: ad, data, src: L.abs });
        ozet.dosya++; ozet.toplam += data.length; eklenen++;
      }
      log("  :: " + L.outName.split("/").pop() + " -> " + eklenen + " orijinal kaynak dosyası");
    }
    if (ozet.dosya) {
      const not = "MirrorLab · orijinal kaynak ağacı (source map)\n\n" +
        "Kaynak site, JS paketlerinin source map dosyalarını herkese açık yayınlıyor.\n" +
        "Bu klasördeki dosyalar o haritaların sourcesContent alanından çıkarılmış\n" +
        "ORİJİNAL kaynak kodlardır (paketlenmemiş hâli).\n\n" +
        "Harita: " + ozet.harita + " · dosya: " + ozet.dosya + " · boyut: " + (ozet.toplam / 1048576).toFixed(2) + " MB\n" +
        "Telif hakkı sahibine aittir; inceleme/öğrenme amaçlıdır.\n";
      const nb = new TextEncoder().encode(not);
      if (sink) await sink.put("_kaynak/OKUBENI.txt", nb); else files.push({ name: "_kaynak/OKUBENI.txt", data: nb, src: links[0].abs });
      log("✓ Kaynak ağacı: " + ozet.dosya + " orijinal dosya (" + (ozet.toplam / 1048576).toFixed(2) + " MB, " + ozet.harita + " harita)");
    } else {
      log("  • source map içeriği boş (haritalar sourcesContent taşımıyor)");
    }
    return ozet;
  }

  async function rawFetch(u, timeoutMs) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), timeoutMs || 25000);
    try {
      const r = await fetch(rawUrl(u), { signal: ctl.signal });
      const buf = await r.arrayBuffer();
      return {
        ok: r.ok, status: r.status, bytes: new Uint8Array(buf),
        ctype: (r.headers.get("content-type") || "").toLowerCase(),
        finalUrl: r.headers.get("x-ml-final-url") || u,
      };
    } catch (e) { return { ok: false, status: 0, bytes: new Uint8Array(0), ctype: "", finalUrl: u, error: String(e) }; }
    finally { clearTimeout(tm); }
  }
  const EXT = {
    "text/html": ".html", "text/css": ".css", "application/javascript": ".js", "text/javascript": ".js",
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico", "image/avif": ".avif",
    "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "application/font-woff2": ".woff2",
    "application/json": ".json", "text/plain": ".txt", "application/pdf": ".pdf", "video/mp4": ".mp4",
    "video/webm": ".webm", "video/ogg": ".ogv", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
    "application/wasm": ".wasm", "application/octet-stream": ".bin",
    "application/vnd.apple.mpegurl": ".m3u8", "application/x-mpegurl": ".m3u8",
  };
  const extFor = (ct) => EXT[String(ct || "").split(";")[0].trim()] || ".bin";
  const hasExt = (p) => /\.[a-z0-9]{1,6}$/i.test(p.split("/").pop() || "");
  function absUrl(raw, base) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || /^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(s)) return null;
    try { return new URL(s, base).href; } catch (e) { return null; }
  }
  function relPath(fromFile, toFile) {
    const a = fromFile.split("/").slice(0, -1), b = toFile.split("/");
    while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
    return "../".repeat(a.length) + b.join("/");
  }
  function parseRobots(txt) {
    const out = []; let on = false;
    for (const line of String(txt).split(/\r?\n/)) {
      const l = line.replace(/#.*$/, "").trim(); if (!l) continue;
      const i = l.indexOf(":"); if (i < 0) continue;
      const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
      if (k === "user-agent") on = (v === "*");
      else if (on && (k === "disallow" || k === "allow") && v) out.push({ allow: k === "allow", p: v });
    }
    return out;
  }
  /* robots.txt deseni -> RegExp (joker ve sonda $ çapa desteklenir)
     Not: yorum içinde yıldız-eğik çizgi dizisi kullanmayın; blok yorumunu erken kapatır.
     Eski basit önek mantığı yanlış pozitif üretiyordu: joker içeren bir kuralın öneki
     boş kalıp HER yolu yasaklı sayıyordu (ör. MDN robots.txt). */
  function robotsToRe(pat) {
    let p = String(pat).trim(), end = false;
    if (p.endsWith("$")) { end = true; p = p.slice(0, -1); }
    const rx = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try { return new RegExp("^" + rx + (end ? "$" : "")); } catch (e) { return null; }
  }
  function robotsBlocked(rules, path) {
    let blocked = false, best = -1;
    for (const r of rules) {
      const pat = String(r.p || "").trim();
      const len = pat.length;
      if (!pat) {                       // "Disallow:" (boş) -> her şeye izin
        if (!r.allow && best <= 0) { best = 0; blocked = false; }
        continue;
      }
      const re = robotsToRe(pat);
      if (!re) continue;
      if (re.test(path)) {
        if (len >= best) { best = len; blocked = !r.allow; }
      }
    }
    return blocked;
  }

  function rewriteCssUrls(css, base, mapFn) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const abs = absUrl(u, base); if (!abs) return m;
      const to = mapFn(abs); return to ? 'url("' + to + '")' : m;
    }).replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      const abs = absUrl(u, base); if (!abs) return m;
      const to = mapFn(abs); return to ? '@import "' + to + '"' : m;
    });
  }

  /* ---- [r] SPA modu: JS çalıştırılmış sayfayı çek ---- */
  const RENDER_PAGE_LIMIT = 25;      // tek seferde en fazla kaç sayfa render edilir (kota koruması)
  async function renderedFetch(u) {
    try {
      const r = await fetch(apiUrl("/api/rendered?url=" + encodeURIComponent(u)));
      if (!r.ok) return { ok: false, status: r.status, bytes: new Uint8Array(0), ctype: "", finalUrl: u };
      const txt = await r.text();
      return { ok: true, status: 200, bytes: new TextEncoder().encode(txt), ctype: "text/html",
               finalUrl: r.headers.get("x-ml-final-url") || u, rendered: true };
    } catch (e) { return { ok: false, status: 0, bytes: new Uint8Array(0), ctype: "", finalUrl: u, error: String(e) }; }
  }

  /* ---- # sitemap.xml listesi (sitemap index destekli) ---- */
  async function sitemapListe(origin) {
    const out = [], gorulen = new Set();
    const oku = async (u, derinlik) => {
      if (derinlik > 2 || gorulen.has(u) || gorulen.size > 25) return;
      gorulen.add(u);
      const r = await rawFetch(u);
      if (!r.ok) return;
      const t = new TextDecoder().decode(r.bytes);
      const locs = [...t.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(x => x[1]);
      const dizinMi = /<sitemapindex/i.test(t);
      for (const l of locs) {
        if (dizinMi) await oku(l, derinlik + 1);
        else if (/^https?:/i.test(l)) out.push(l);
      }
    };
    const kok = origin.replace(/\/$/, "");
    await oku(kok + "/sitemap.xml", 0);
    if (!out.length) {                       // robots.txt içindeki "Sitemap:" satırları
      const rb = await rawFetch(kok + "/robots.txt");
      if (rb.ok) {
        for (const sat of new TextDecoder().decode(rb.bytes).split(/\r?\n/)) {
          const mm = sat.match(/^\s*sitemap:\s*(\S+)/i);
          if (mm) await oku(mm[1], 0);
        }
      }
    }
    return [...new Set(out)];
  }

  /* sitemap paneli: listele -> seç -> kopyala */
  async function sitemapPanel() {
    const hedef = state.url || normUrl(($("#url") && $("#url").value) || "");
    let host = "";
    try { host = new URL(hedef).origin; } catch (e) { showErr("Önce bir adres girin."); return; }
    state.url = hedef;
    const panel = $("#smapPanel"); if (!panel) return;
    panel.style.display = "block";
    panel.innerHTML = '<div class="sub"># sitemap.xml okunuyor…</div>';
    const urls = await sitemapListe(host);
    if (!urls.length) {
      panel.innerHTML = '<div class="sub">Bu sitede okunabilir bir sitemap.xml bulunamadı (robots.txt içinde de yok).</div>';
      return;
    }
    const goster = urls.slice(0, 400);
    panel.innerHTML =
      '<div class="row" style="margin-bottom:10px;flex-wrap:wrap"><b># ' + urls.length + ' sayfa bulundu</b>' +
      '<div class="spacer"></div>' +
      '<button class="btn sm" id="smapAll">Tümünü seç</button>' +
      '<button class="btn sm" id="smapNone">Hiçbiri</button>' +
      '<button class="btn primary sm" id="smapGo">Seçilenleri kopyala</button></div>' +
      (urls.length > 400 ? '<div class="hint">İlk 400 tanesi listelendi; "Tümünü seç" hepsini kuyruğa alır.</div>' : '') +
      '<div style="max-height:250px;overflow:auto;border:1px solid #5e4000;border-radius:10px;padding:8px">' +
      goster.map((u, i) => '<label style="display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer">' +
        '<input type="checkbox" data-u="' + esc(u) + '"' + (i < 12 ? ' checked' : '') + '>' +
        '<span class="mono" style="font-size:12px">' + esc(u.replace(host, "") || "/") + '</span></label>').join("") +
      '</div>';
    $("#smapAll").onclick = () => panel.querySelectorAll("input[data-u]").forEach(x => x.checked = true);
    $("#smapNone").onclick = () => panel.querySelectorAll("input[data-u]").forEach(x => x.checked = false);
    $("#smapGo").onclick = () => {
      const secili = [...panel.querySelectorAll("input[data-u]")].filter(x => x.checked).map(x => x.getAttribute("data-u"));
      if (!secili.length) { showErr("Hiç sayfa seçilmedi."); return; }
      state.mirrorSeeds = secili;
      panel.style.display = "none";
      const unl = !!($("#cUnl") && $("#cUnl").checked) || false;
      mirrorStart(unl);
    };
  }

  /* ---- sınırsız mod: ZIP'i doğrudan diske akıtan hedef ---- */
  async function openDiskSink(name, log) {
    if (!window.showSaveFilePicker) return { sink: null, reason: "tarayıcı disk akışını desteklemiyor" };
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "ZIP arşivi", accept: { "application/zip": [".zip"] } }],
      });
      const w = await h.createWritable();
      const enc = new TextEncoder();
      const sink = {
        w, enc, off: 0, cen: [], count: 0, bytes: 0, ham: 0, name,
        async put(entryName, data) {
          const nb = enc.encode(entryName);
          if (sink.count + 1 > ZIP_MAX_FILES) throw new Error("ZIP32 dosya sınırı (65.535)");
          if (sink.off + data.length + nb.length > ZIP_MAX_BYTES) throw new Error("ZIP32 boyut sınırı (4 GB)");
          const e = await encodeEntry(entryName, data);
          const lh = localHeader(nb, e.crc, e.method, e.csize, e.usize);
          await w.write(lh); await w.write(nb); await w.write(e.payload);   // sıra: başlık + AD + veri
          sink.cen.push({ nb, crc: e.crc, method: e.method, csize: e.csize, usize: e.usize, off: sink.off });
          sink.off += lh.length + nb.length + e.payload.length;
          sink.count++; sink.bytes += e.csize; sink.ham += e.usize;
        },
        async close() {
          let cenLen = 0;
          for (const c of sink.cen) cenLen += 46 + c.nb.length;      // merkezi dizin girdisi boyutu
          for (const c of sink.cen) {
            await w.write(centralHeader(c.nb, c.crc, c.method, c.csize, c.usize, c.off));
            await w.write(c.nb);
          }
          await w.write(eocd(sink.count, cenLen, sink.off));
          await w.close();
        },
      };
      return { sink, reason: null };
    } catch (e) {
      return { sink: null, reason: (e && e.name === "AbortError") ? "kullanıcı kaydı iptal etti" : ("disk akışı açılamadı: " + (e && e.message)) };
    }
  }

  /* ---- ana kopyalama işi ---- */
  async function mirrorEdge(unlimited) {
    const UNL = !!unlimited;
    const seed = state.url || normUrl(($("#url") && $("#url").value) || "");
    if (!seed) { showErr("Önce bir adres girin."); return; }
    state.url = seed;

    const cPages = $("#cPages"), cAssets = $("#cAssets"), cMb = $("#cMb");
    const tohumlar = (state.mirrorSeeds && state.mirrorSeeds.length) ? state.mirrorSeeds.slice() : null;
    const devamKuyruk = (state.devamKuyruk && state.devamKuyruk.length) ? state.devamKuyruk.slice() : null;
    const maxPages  = UNL ? Infinity : Math.max(tohumlar ? tohumlar.length : 0, devamKuyruk ? devamKuyruk.length : 0, Math.max(1, +cPages.value || 20));
    const maxAssets = UNL ? Infinity : Math.max(0, +cAssets.value || 250);
    const maxBytes  = UNL ? Infinity : Math.max(1, +cMb.value || 60) * 1048576;
    const scopeVal = ($("#cScope") && $("#cScope").value) || "media";
    const sameHost = scopeVal === "1";
    const mediaScope = scopeVal === "media" || scopeVal === "0";
    const iframesOn = $("#cIframes") ? $("#cIframes").checked : true;
    const robotsOn = $("#cRobots").checked, cssAssets = $("#cCssAssets").checked;
    const renderModu = !!($("#cRender") && $("#cRender").checked);
    const seedHost = new URL(seed).host;

    state.mirrorStop = false;
    state.mirrorPause = false;
    const pauseBtn = $("#pauseCrawl"); if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.textContent = "⏸ Duraklat"; }
    const LOG = [];
    const log = (m) => { LOG.push(m); const el = $("#crawlLog"); if (el) { el.textContent = LOG.slice(-600).join("\n"); el.scrollTop = el.scrollHeight; } };
    const setStat = (s) => { const el = $("#kStatus"); if (el) el.textContent = s; };

    let pages = 0, assets = 0, bytes = 0, skipped = 0;
    const paths = new Map();      // mutlak URL -> yerel dosya yolu
    const fileBy = new Map();     // yerel yol -> kayıt (isim çakışması denetimi)
    const files = [];             // bellek modunda tutulanlar (HTML + küçük dosyalar)
    const htmlRecs = [];          // ikinci geçiş için HTML sayfaları (bellekte)
    const mapLinks = [];          // source map bağlantıları (orijinal kaynak ağacı)

    /* ZIP hedefi: sınırsız modda önce diske akıtmayı dene */
    let sink = null;
    const zipName = seedHost.replace(/[^\w.-]/g, "_") + "-ayna.zip";
    if (UNL) {
      const r = await openDiskSink(zipName, log);
      sink = r.sink;
      log(sink ? "[D] SINIRSIZ MOD: ZIP doğrudan diske akıtılıyor -> " + zipName + " (bellek sınırı yok)"
               : "ℹ SINIRSIZ MOD (bellek): " + (r.reason || "") + " — sayfa/varlık/boyut sınırı yok, yalnızca sekme çökmemesi için teknik tavan (~1,7 GB) var.");
    }

    $("#crawlPanel").style.display = "block"; $("#crawlLog").textContent = "";
    $("#dlZip").disabled = true;
    const stopBtn = $("#stopCrawl"); if (stopBtn) { stopBtn.disabled = false; }
    setStat(UNL ? "[∞] sınırsız kopyalanıyor…" : "tarayıcıda kopyalanıyor…");
    log("▶ " + (UNL ? "Sınırsız ayna" : "Ayna") + ": " + seed);
    log("  Kapsam: " + (scopeVal === "media" ? "Akıllı (site içi + CDN/Gömülü Medya/Oyun)" : (sameHost ? "yalnızca " + seedHost : "tüm alan adları")) +
        " · Gömülü çerçeveler/oyunlar: " + (iframesOn ? "dahil" : "hariç") +
        " · robots.txt: " + (robotsOn ? "uyuluyor" : "yok sayılıyor (sorumluluk kullanıcıda)"));

    function claimPath(u, kind) {
      if (paths.has(u)) return paths.get(u);
      const o = new URL(u);
      let p = o.host + o.pathname;
      if (p.endsWith("/")) p += "index.html";
      else if (kind === "page" && !hasExt(p)) p += ".html";
      p = p.replace(/^\/+/, "").replace(/\.\.+/g, ".");
      let cand = p, n = 1;
      while (fileBy.has(cand) && fileBy.get(cand).src !== u) { cand = p.replace(/(\.[^./]+)$/, "-" + (n++) + "$1"); }
      paths.set(u, cand);
      return cand;
    }
    function bump() {
      $("#kPages").textContent = pages + (UNL ? " / ∞" : " / " + maxPages);
      $("#kAssets").textContent = assets + (UNL ? " / ∞" : "");
      $("#kBytes").innerHTML = (bytes / 1048576).toFixed(2) + " <small>MB</small>";
      if (UNL) {
        const pct = Math.min(99, Math.round(100 * (1 - Math.exp(-(pages * 40 + assets) / 4000))));
        $("#crawlBar").style.width = pct + "%";
      } else {
        $("#crawlBar").style.width = Math.min(99, Math.round(100 * Math.max(pages / maxPages, Math.min(0.99, assets / Math.max(1, maxAssets))))) + "%";
      }
    }
    function addFile(u, name, data) {
      const rec = { name, data, src: u }; files.push(rec); fileBy.set(name, rec); bytes += data.length;
      return rec;
    }

    // robots
    let robots = [];
    if (robotsOn) {
      try {
        const r = await rawFetch(new URL("/robots.txt", seed).href);
        if (r.ok) { robots = parseRobots(new TextDecoder().decode(r.bytes)); log("  robots.txt okundu (" + robots.length + " kural)"); }
      } catch (e) { log("  robots.txt alınamadı, devam ediliyor"); }
    }

    /* varlık indirici */
    const fetchAsset = async (abs, referer, isIframe = false) => {
      if (paths.has(abs)) return paths.get(abs);
      if (assets >= maxAssets) { skipped++; return null; }
      if (bytes >= maxBytes) { skipped++; return null; }
      if (sink && sink.count + 1 >= ZIP_MAX_FILES) { skipped++; return null; }
      const o = new URL(abs);
      const isCdnOrMedia = /cdn|static|assets|media|img|images|game|html5|storage|aws|gamedistribution|gamepix|poki|famobi|crazygames|unity|phaser|cdnjs|jsdelivr|unpkg/i.test(o.host) ||
                           /\.(wasm|data|pck|unityweb|m3u8|mpd|mp4|webm|ogg|wav|json|png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(o.pathname);
      if (sameHost && o.host !== seedHost && o.host !== new URL(referer || seed).host && !(mediaScope && isCdnOrMedia)) { skipped++; return null; }
      /* robots.txt ALAN ADI BAŞINA geçerlidir: başka sunuculardan (CDN) gelen
         dosyalara buranın kuralları uygulanmaz. */
      if (robotsOn && robots.length && o.host === seedHost && robotsBlocked(robots, o.pathname)) { skipped++; return null; }
      const r = await rawFetch(abs);
      if (!r.ok || r.bytes.length > 32 * 1048576) {
        skipped++;
        if (skipped <= 15) log("  ! atlandı (HTTP " + r.status + "): " + o.pathname.slice(0, 55));
        return null;
      }
      assets++;
      let name = claimPath(abs, isIframe ? "page" : "asset");
      if (!hasExt(name)) name = name + (isIframe ? ".html" : extFor(r.ctype));
      let data = r.bytes;

      /* Gömülü iframe / HTML5 oyun çerçevesi: içindeki varlıkları da indir ve yerelleştir */
      if (isIframe || (r.ctype && r.ctype.includes("text/html") && abs !== seed)) {
        const ifBase = r.finalUrl || abs;
        let ifHtml = new TextDecoder().decode(data);
        const ifDoc = new DOMParser().parseFromString(ifHtml, "text/html");
        const ifItems = [];
        const ifPush = (el, attr, val) => { const a = absUrl(val, ifBase); if (a) ifItems.push({ el, attr, abs: a }); };
        ifDoc.querySelectorAll("link[href]").forEach(el => {
          const rel = (el.getAttribute("rel") || "").toLowerCase();
          if (/stylesheet|icon|apple-touch|preload|prefetch|manifest/.test(rel)) ifPush(el, "href", el.getAttribute("href"));
        });
        ifDoc.querySelectorAll("script[src]").forEach(el => ifPush(el, "src", el.getAttribute("src")));
        ifDoc.querySelectorAll("img[src]").forEach(el => ifPush(el, "src", el.getAttribute("src")));
        ifDoc.querySelectorAll("source[src]").forEach(el => ifPush(el, "src", el.getAttribute("src")));
        ifDoc.querySelectorAll("video[src],audio[src]").forEach(el => ifPush(el, "src", el.getAttribute("src")));

        // GameDistribution / gömülü oyun motoru çözücü (rvvASMiM vb.)
        const nestedGameMatch = ifHtml.match(/gameSrc\s*=\s*["']([^"']+)["']/i) ||
                                ifHtml.match(/(\/\/[^"'\s]*gamedistribution\.com\/rvvASMiM\/[^\s"']+)/i);
        if (nestedGameMatch && nestedGameMatch[1]) {
          const gameUrl = absUrl(nestedGameMatch[1], ifBase);
          if (gameUrl) {
            log("    🎮 Gömülü Oyun Motoru: " + gameUrl.slice(0, 55));
            const localGame = await fetchAsset(gameUrl, ifBase, true);
            if (localGame) {
              ifHtml = ifHtml.replace(nestedGameMatch[0], 'gameSrc = "' + relPath(name, localGame) + '"');
            }
          }
        }

        for (const it of ifItems) {
          if (bytes >= maxBytes || stopNow()) break;
          const local = await fetchAsset(it.abs, ifBase);
          if (local) it.el.setAttribute(it.attr, relPath(name, local));
        }

        if (cssAssets) {
          for (const el of ifDoc.querySelectorAll("style")) {
            const t = el.textContent || "";
            if (!/url\(|@import/i.test(t)) continue;
            const nested = [];
            const first = rewriteCssUrls(t, ifBase, (nu) => { nested.push(nu); return null; });
            for (const nu of nested) await fetchAsset(nu, ifBase);
            el.textContent = rewriteCssUrls(first, ifBase, (nu) => { const p2 = paths.get(nu); return p2 ? relPath(name, p2) : null; });
          }
        }

        const ifDoctype = /<!doctype/i.test(ifHtml.slice(0, 200)) ? "<!DOCTYPE html>\n" : "";
        data = new TextEncoder().encode(ifDoctype + ifDoc.documentElement.outerHTML);
        fileBy.set(name, { name, data, src: abs }); paths.set(abs, name);
        bytes += data.length; bump();
        if (sink) { await sink.put(name, data); }
        else files.push({ name, data, src: abs });
        log("  🎮 Gömülü Çerçeve/Oyun: " + name + " (" + (data.length / 1024).toFixed(0) + " KB)");
        return name;
      }

      if (cssAssets && r.ctype.includes("css")) {
        const base = r.finalUrl || abs;
        let css = new TextDecoder().decode(data);
        const nested = [];
        css = rewriteCssUrls(css, base, (nu) => { nested.push(nu); return null; });
        for (const nu of nested) await fetchAsset(nu, base);
        css = rewriteCssUrls(css, base, (nu) => { const t = paths.get(nu); return t ? relPath(name, t) : null; });
        data = new TextEncoder().encode(css);
        fileBy.set(name, { name, data, src: abs }); paths.set(abs, name);
        bytes += data.length; bump();
        if (sink) { await sink.put(name, data); }
        else files.push({ name, data, src: abs });
        log("  ~ " + name + " (" + (data.length / 1024).toFixed(0) + " KB)");
        return name;
      }
      /* source map bağlantısı var mı? -> orijinal kaynak ağacı için işaretle */
      if (/(javascript|ecmascript)/.test(r.ctype) || /\.(js|mjs|cjs)(\?|$)/i.test(abs)) {
        try {
          const dilim = data.length > 8 * 1048576 ? data.subarray(data.length - 8 * 1048576) : data;
          const mu = sourceMapAdresi(new TextDecoder().decode(dilim));
          if (mu && mapLinks.length < KAYNAK_MAP_SAYI) {
            const mau = absUrl(mu, r.finalUrl || abs);
            if (mau && !mapLinks.some(x => x.abs === mau)) mapLinks.push({ abs: mau, outName: name });
          }
        } catch (e) {}
      }
      paths.set(abs, name);
      if (sink) {                       // sınırsız mod: diske yaz, bellekte tutma
        await sink.put(name, data);
        fileBy.set(name, { name, data: null, src: abs, streamed: true });
      } else {
        addFile(abs, name, data);
      }
      bump();
      if (assets <= 400 || assets % 25 === 0) log("  ▼ " + name + " (" + (data.length / 1024).toFixed(0) + " KB)");
      return name;
    };

    /* gezinme (sitemap seçimi varsa kuyruk onlarla başlar) */
    const queue = tohumlar ? tohumlar.slice() : (devamKuyruk && devamKuyruk.length ? devamKuyruk.slice() : [seed]);
    const queued = new Set(queue);
    if (tohumlar) log("  # sitemap seçimi: " + tohumlar.length + " sayfa kuyruğa alındı");
    if (devamKuyruk && !tohumlar) log("⏸ Kaldığı yerden sürdürülüyor: " + devamKuyruk.length + " adres sırada (dosyalar yeniden indirilir)");
    state.devamKuyruk = null;
    let renderKalan = renderModu ? RENDER_PAGE_LIMIT : 0;
    if (renderModu) log("  [r] SPA modu açık: sayfalar JS çalıştırıldıktan sonra kaydedilecek (en çok " + RENDER_PAGE_LIMIT + " sayfa, tarayıcı kotası harcar)");
    const stopNow = () => state.mirrorStop;
    while (queue.length && pages < maxPages && bytes < maxBytes && !stopNow()) {
      while (state.mirrorPause && !stopNow()) { setStat("⏸ duraklatıldı"); await new Promise(s => setTimeout(s, 400)); }
      if (stopNow()) break;
      const url = queue.shift();
      let r = null;
      if (renderKalan > 0) {
        r = await renderedFetch(url);
        if (r.ok) { renderKalan--; if (renderKalan === RENDER_PAGE_LIMIT - 1) log("  [r] ilk sayfa JS sonrası hâliyle alındı"); }
        else { log("  ! render başarısız (" + r.status + "), ham HTML'e dönülüyor"); r = await rawFetch(url); }
      } else {
        r = await rawFetch(url);
      }
      if (!r.ok) { log("  x atlandı (" + r.status + "): " + url.slice(0, 70)); continue; }
      const base = r.finalUrl || url;
      const html = new TextDecoder().decode(r.bytes);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const pageName = claimPath(base, "page");
      paths.set(base, pageName); paths.set(url, pageName);
      pages++;
      log("  » " + pageName + " (" + (r.bytes.length / 1024).toFixed(0) + " KB)" + (UNL ? "  · kuyruk: " + queue.length : ""));
      const pageDir = pageName;

      /* 1) varlıkları topla */
      const items = [];
      const push = (el, attr, val, isIfr = false) => {
        const abs = absUrl(val, base);
        if (abs) items.push({ el, attr, abs, isIframe: isIfr });
      };
      doc.querySelectorAll("link[href]").forEach(el => {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        if (/stylesheet|icon|apple-touch|preload|prefetch|manifest/.test(rel)) push(el, "href", el.getAttribute("href"));
      });
      doc.querySelectorAll("script[src]").forEach(el => push(el, "src", el.getAttribute("src")));
      doc.querySelectorAll("img[src]").forEach(el => push(el, "src", el.getAttribute("src")));
      doc.querySelectorAll("source[src]").forEach(el => push(el, "src", el.getAttribute("src")));
      doc.querySelectorAll("video[poster]").forEach(el => push(el, "poster", el.getAttribute("poster")));
      doc.querySelectorAll("video[src],audio[src]").forEach(el => push(el, "src", el.getAttribute("src")));
      doc.querySelectorAll("object[data]").forEach(el => push(el, "data", el.getAttribute("data")));
      doc.querySelectorAll("embed[src]").forEach(el => push(el, "src", el.getAttribute("src")));
      if (iframesOn) {
        doc.querySelectorAll("iframe[src]").forEach(el => push(el, "src", el.getAttribute("src"), true));
        // Script içinde oluşturulan iframe string'lerini de tara (Kizi / GameDistribution game_embed_code)
        const rawScriptIframes = html.match(/<iframe[^>]*src=\\?["']([^"'\\]+)\\?["'][^>]*>/gi) || [];
        for (const sm of rawScriptIframes) {
          const uMatch = sm.match(/src=\\?["']([^"'\\]+)\\?["']/i);
          if (uMatch && uMatch[1]) {
            const iframeAbs = absUrl(uMatch[1], base);
            if (iframeAbs && !paths.has(iframeAbs)) {
              await fetchAsset(iframeAbs, base, true);
            }
          }
        }
      }
      for (const it of items) {
        if (bytes >= maxBytes || stopNow()) break;
        const local = await fetchAsset(it.abs, base, it.isIframe);
        if (local) it.el.setAttribute(it.attr, relPath(pageDir, local));
        else {
          const oo = new URL(it.abs);
          const sebep = (robotsOn && robots.length && oo.host === seedHost && robotsBlocked(robots, oo.pathname)) ? "robots.txt yasağı"
                      : (assets >= maxAssets ? "varlık sınırı" : "site dışı ya da indirilemedi");
          if (sebep === "robots.txt yasağı" && items.indexOf(it) < 5) log("  ! " + oo.pathname.slice(0, 44) + " -> " + sebep);
        }
      }
      for (const el of doc.querySelectorAll("[srcset]")) {
        const parts = [];
        for (const chunk of String(el.getAttribute("srcset")).split(",")) {
          const seg = chunk.trim(); if (!seg) continue;
          const sp = seg.split(/\s+/); const abs = absUrl(sp[0], base);
          const local = abs ? await fetchAsset(abs, base) : null;
          parts.push((local ? relPath(pageDir, local) : sp[0]) + (sp[1] ? " " + sp[1] : ""));
        }
        el.setAttribute("srcset", parts.join(", "));
      }
      if (cssAssets) {
        for (const el of doc.querySelectorAll("style")) {
          const t = el.textContent || "";
          if (!/url\(|@import/i.test(t)) continue;
          const nested = [];
          const first = rewriteCssUrls(t, base, (nu) => { nested.push(nu); return null; });
          for (const nu of nested) await fetchAsset(nu, base);
          el.textContent = rewriteCssUrls(first, base, (nu) => { const p2 = paths.get(nu); return p2 ? relPath(pageDir, p2) : null; });
        }
        for (const el of doc.querySelectorAll("[style]")) {
          const t = el.getAttribute("style") || "";
          if (!/url\(/i.test(t)) continue;
          const nested = [];
          const first = rewriteCssUrls(t, base, (nu) => { nested.push(nu); return null; });
          for (const nu of nested) await fetchAsset(nu, base);
          el.setAttribute("style", rewriteCssUrls(first, base, (nu) => { const p2 = paths.get(nu); return p2 ? relPath(pageDir, p2) : null; }));
        }
      }

      /* 2) site içi bağlantılar */
      for (const a of doc.querySelectorAll("a[href]")) {
        const abs = absUrl(a.getAttribute("href"), base);
        if (!abs) continue;
        const o = new URL(abs);
        if (sameHost && o.host !== seedHost) continue;
        if (/\.(zip|exe|dmg|apk|iso|torrent|jpg|jpeg|png|gif|svg|mp4|mp3|pdf)$/i.test(o.pathname)) {
          const local = paths.get(abs);
          if (local) a.setAttribute("href", relPath(pageDir, local));
          continue;
        }
        const local = paths.get(abs);
        if (local) { a.setAttribute("href", relPath(pageDir, local)); continue; }
        if (!queued.has(abs) && (UNL || queued.size < maxPages * 4)) { queued.add(abs); queue.push(abs); }
      }

      /* 3) sayfayı belleğe al (ikinci geçişte yerelleştirilecek) */
      const doctype = /<!doctype/i.test(html.slice(0, 200)) ? "<!DOCTYPE html>\n" : "";
      const out = new TextEncoder().encode(doctype + doc.documentElement.outerHTML);
      const rec = { name: pageName, data: out, src: base };
      htmlRecs.push(rec); fileBy.set(pageName, rec); bytes += out.length;
      bump();
      if (!sink && bytes > MEM_STOP) {
        log("! Bellek tavanına ulaşıldı (~1,7 GB) — kopya burada bitiriliyor. Daha büyük siteler için Chrome/Edge kullanın (diske akıtma açılır) ya da kapsamı daraltın.");
        break;
      }
      if (!sink && bytes > MEM_WARN && !state.__memWarned) {
        state.__memWarned = true;
        log("ℹ Bellek modu: ~800 MB aşıldı. Tarayıcı sekmesi yavaşlayabilir; sınırsız modda ZIP doğrudan diske akıtılırsa bu sınır olmaz.");
      }
      if (typeof oturumKaydet === "function" && (pages % 2 === 0 || stopNow())) {
        try { oturumKaydet({ seed, pages, assets, kuyruk: [...queue],
          ayar: { pages: cPages.value, assets: cAssets.value, mb: cMb.value, scope: $("#cScope").value, robots: robotsOn, render: renderModu } }); } catch (e) {}
      }
      await new Promise(s => setTimeout(s, 0));
    }
    if (stopNow()) log("⏹ Kullanıcı durdurdu — toplanan içerikle ZIP hazırlanıyor…");

    /* 3½) İKİNCİ GEÇİŞ: sayfa bağlantılarını yerelleştir */
    log("& Bağlantılar yerelleştiriliyor…");
    const relink = (rec) => {
      let doc;
      try { doc = new DOMParser().parseFromString(new TextDecoder().decode(rec.data), "text/html"); } catch (e) { return rec.data; }
      const self = rec.name, home = rec.src || seed;
      const fixEl = (el, attr) => {
        const v = el.getAttribute(attr); if (!v) return;
        const a = absUrl(v, home); if (!a) return;
        const to = paths.get(a);
        if (to && to !== self) el.setAttribute(attr, relPath(self, to));
      };
      ["href", "src", "poster", "data"].forEach(at => doc.querySelectorAll("[" + at + "]").forEach(el => fixEl(el, at)));
      doc.querySelectorAll("[srcset]").forEach(el => {
        const parts = String(el.getAttribute("srcset")).split(",").map(c => {
          const s = c.trim(); if (!s) return s; const sp = s.split(/\s+/);
          const a = absUrl(sp[0], home); const to = a && paths.get(a);
          return (to ? relPath(self, to) : sp[0]) + (sp[1] ? " " + sp[1] : "");
        });
        el.setAttribute("srcset", parts.join(", "));
      });
      /* Game & Ad SDK Shim: çevrimdışı donmaları ve domain kilitlerini aşar */
      const shim = doc.createElement("script");
      shim.setAttribute("data-mirrorlab", "game-shim");
      shim.textContent = "/* MirrorLab Game & Ad SDK Shim */\n" +
        "window.PokiSDK=window.PokiSDK||{init:()=>Promise.resolve(),initWithVideoHB:()=>Promise.resolve(),commercialBreak:()=>Promise.resolve(),rewardedBreak:()=>Promise.resolve(true),displayAd:()=>{},destroyAd:()=>{},gameLoadingStart:()=>{},gameLoadingFinished:()=>{},gameplayStart:()=>{},gameplayStop:()=>{},happyTime:()=>{},setDebug:()=>{}};\n" +
        "window.CrazyGames=window.CrazyGames||{SDK:{ad:{requestAd:(t,cb)=>{if(cb&&cb.adFinished)cb.adFinished();},hasAdblock:()=>Promise.resolve(false)},game:{gameplayStart:()=>{},gameplayStop:()=>{},happytime:()=>{},loadingStart:()=>{},loadingStop:()=>{}},user:{isUserAccountAvailable:false,getUser:()=>Promise.resolve(null)},init:()=>Promise.resolve()}};\n" +
        "window.gdsdk=window.gdsdk||{showAd:()=>Promise.resolve(),preloadAd:()=>Promise.resolve(),play:()=>{}};\n" +
        "window.GD_OPTIONS=window.GD_OPTIONS||{onEvent:()=>{}};\n" +
        "window.famobi=window.famobi||{hasFeature:()=>false,showAd:(cb)=>{if(cb)cb();},rewardedAd:(cb)=>{if(cb)cb(true);}};\n" +
        "window.adsbygoogle=window.adsbygoogle||[];\n";
      if (doc.head) doc.head.insertBefore(shim, doc.head.firstChild);
      else if (doc.documentElement) doc.documentElement.insertBefore(shim, doc.documentElement.firstChild);
      return new TextEncoder().encode((/<!doctype/i.test(new TextDecoder().decode(rec.data).slice(0, 200)) ? "<!DOCTYPE html>\n" : "") + doc.documentElement.outerHTML);
    };
    for (const rec of htmlRecs) rec.data = relink(rec);

    /* 3½-b) SOURCE MAP -> ORİJİNAL KAYNAK AĞACI (REA derinliği) */
    let kaynakOzet = { harita: 0, dosya: 0, toplam: 0 };
    try { kaynakOzet = await kaynakTopla(mapLinks, sink, files, log); }
    catch (e) { log("  ! kaynak ağacı çıkarılamadı: " + e.message); }

    /* 3¾) Giriş index.html */
    const seedLocal = paths.get(seed) || [...paths.entries()].filter(([k]) => k.startsWith("http")).slice(-1)[0]?.[1] || "index.html";
    const giris = "<!DOCTYPE html>\n<html lang=\"tr\"><head><meta charset=\"utf-8\">" +
      "<meta http-equiv=\"refresh\" content=\"0;url=" + seedLocal + "\">" +
      "<title>MirrorLab ayna kopyası</title></head><body style=\"font:15px system-ui;padding:24px;background:#0d0902;color:#ffd8a0\">" +
      "<h2>:: MirrorLab ayna kopyası</h2><p>Kaynak: <code>" + seed.replace(/</g, "&lt;") + "</code></p>" +
      "<p><a style=\"color:#ffd479\" href=\"" + seedLocal + "\">▶ Kopyalanan sayfayı aç</a> (" + seedLocal + ")</p>" +
      "<p style=\"color:#a87200;font-size:13px\">Sayfa: " + pages + " · Varlık: " + assets + " · " +
      (bytes / 1048576).toFixed(2) + " MB · " + new Date().toLocaleString("tr-TR") + (UNL ? " · sınırsız mod" : "") + "</p>" +
      "<p style=\"color:#a87200;font-size:12px\">İçerik telif hakkı sahibine aittir; inceleme/arşiv amaçlıdır.</p></body></html>";
    const girisBytes = new TextEncoder().encode(giris);

    const readme = "MirrorLab ayna kopyası" + (UNL ? " (sınırsız mod)" : "") + "\n" +
      "Kaynak: " + seed + "\nTarih: " + new Date().toISOString() + "\n" +
      "Sayfa: " + pages + " · Varlık: " + assets + " · Boyut: " + (bytes / 1048576).toFixed(2) + " MB\n" +
      "Atlanan: " + skipped + " (HTTP hatası / robots / kapsam)\n" +
      (kaynakOzet.dosya ? "Orijinal kaynak (source map): " + kaynakOzet.dosya + " dosya / " + (kaynakOzet.toplam / 1048576).toFixed(2) + " MB\n" : "") +
      (UNL ? "Sınır: yok (ZIP32 teknik tavanı: 65.535 dosya / 4 GB)\n" : "") +
      "\n🚀 TEK TIKLA BAŞLATMA:\n" +
      "  Windows: Arşivi klasöre çıkarıp 'oyna.bat' dosyasına çift tıklayın.\n" +
      "  Mac / Linux: Terminalde 'bash oyna.sh' çalıştırın veya çift tıklayın.\n" +
      "  (Otomatik yerel web sunucusu açılır ve tarayıcınızda oyunu başlatır)\n" +
      "\nManuel Gezinme: index.html dosyasını açın.\n" +
      "\nNot: Klonlanan içerik telif hakkı sahibine aittir; yalnızca inceleme/arşiv/öğrenme amaçlıdır.\n";
    const readmeBytes = new TextEncoder().encode(readme);

    const oynaBat = "@echo off\r\n" +
      "title MirrorLab Cevrimdisi Baslatici\r\n" +
      "echo ======================================================\r\n" +
      "echo   MirrorLab Yerel Cevrimdisi Sunucu Baslatiliyor...\r\n" +
      "echo ======================================================\r\n" +
      "cd /d \"%~dp0\"\r\n" +
      "where python >nul 2>nul\r\n" +
      "if %errorlevel% equ 0 (\r\n" +
      "  echo Python bulundu: http://localhost:8080 aciliyor...\r\n" +
      "  start \"\" http://localhost:8080\r\n" +
      "  python -m http.server 8080\r\n" +
      "  goto son\r\n" +
      ")\r\n" +
      "where py >nul 2>nul\r\n" +
      "if %errorlevel% equ 0 (\r\n" +
      "  echo Python Launcher: http://localhost:8080 aciliyor...\r\n" +
      "  start \"\" http://localhost:8080\r\n" +
      "  py -m http.server 8080\r\n" +
      "  goto son\r\n" +
      ")\r\n" +
      "where npx >nul 2>nul\r\n" +
      "if %errorlevel% equ 0 (\r\n" +
      "  echo Node.js bulundu: http://localhost:8080 aciliyor...\r\n" +
      "  start \"\" http://localhost:8080\r\n" +
      "  npx --yes serve -p 8080 .\r\n" +
      "  goto son\r\n" +
      ")\r\n" +
      "echo [UYARI] Python veya Node.js bulunamadi, index.html dogrudan aciliyor...\r\n" +
      "start \"\" index.html\r\n" +
      ":son\r\n" +
      "pause\r\n";

    const oynaSh = "#!/usr/bin/env bash\n" +
      "cd \"$(dirname \"$0\")\"\n" +
      "echo \"======================================================\"\n" +
      "echo \"  MirrorLab Çevrimdışı Sunucu Başlatılıyor...\"\n" +
      "echo \"======================================================\"\n" +
      "PORT=8080\n" +
      "open_url() {\n" +
      "  sleep 1\n" +
      "  if command -v xdg-open >/dev/null 2>&1; then xdg-open \"http://localhost:$PORT\";\n" +
      "  elif command -v open >/dev/null 2>&1; then open \"http://localhost:$PORT\"; fi\n" +
      "}\n" +
      "if command -v python3 >/dev/null 2>&1; then\n" +
      "  echo \"Python 3: http://localhost:$PORT\"\n" +
      "  open_url &\n" +
      "  python3 -m http.server \"$PORT\"\n" +
      "elif command -v python >/dev/null 2>&1; then\n" +
      "  echo \"Python: http://localhost:$PORT\"\n" +
      "  open_url &\n" +
      "  python -m http.server \"$PORT\"\n" +
      "elif command -v npx >/dev/null 2>&1; then\n" +
      "  echo \"Node.js: http://localhost:$PORT\"\n" +
      "  open_url &\n" +
      "  npx --yes serve -p \"$PORT\" .\n" +
      "else\n" +
      "  echo \"[UYARI] Python veya Node.js bulunamadı. index.html açılıyor...\"\n" +
      "  if command -v xdg-open >/dev/null 2>&1; then xdg-open index.html; elif command -v open >/dev/null 2>&1; then open index.html; fi\n" +
      "fi\n";

    const oynaBatBytes = new TextEncoder().encode(oynaBat);
    const oynaShBytes = new TextEncoder().encode(oynaSh);

    /* 4) ZIP */
    log("[] ZIP yazılıyor (" + (pages + assets + 4 + (kaynakOzet.dosya || 0)) + " dosya)…" + (kaynakOzet.dosya ? " · :: " + kaynakOzet.dosya + " orijinal kaynak" : ""));
    setStat("ZIP paketleniyor…");
    let toplamBayt = 0, indirmeUrl = null;
    if (sink) {
      await sink.put("index.html", girisBytes);
      await sink.put("README.txt", readmeBytes);
      await sink.put("oyna.bat", oynaBatBytes);
      await sink.put("oyna.sh", oynaShBytes);
      for (const rec of htmlRecs) await sink.put(rec.name, rec.data);
      toplamBayt = sink.bytes;
      await sink.close();
      log("✓ Diske yazıldı: " + zipName + " (" + (toplamBayt / 1048576).toFixed(2) + " MB, " + sink.count + " dosya)");
      const linkTxt = $("#zipLink");
      if (linkTxt) { linkTxt.textContent = "✓ " + zipName + " kaydedildi (" + (toplamBayt / 1048576).toFixed(2) + " MB)"; linkTxt.removeAttribute("href"); linkTxt.removeAttribute("download"); }
      const dl = $("#dlZip"); if (dl) { dl.disabled = true; dl.textContent = "✓ diske kaydedildi"; }
    } else {
      const all = [{ name: "index.html", data: girisBytes }, { name: "README.txt", data: readmeBytes },
        { name: "oyna.bat", data: oynaBatBytes }, { name: "oyna.sh", data: oynaShBytes },
        ...files.filter(f => !f.streamed).map(f => ({ name: f.name, data: f.data })),
        ...htmlRecs.map(f => ({ name: f.name, data: f.data }))];
      const zip = await zipStore(all);
      toplamBayt = zip.length;
      indirmeUrl = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      state.mirrorUrl = indirmeUrl; state.mirrorName = zipName;
      const link = $("#zipLink");
      if (link) { link.href = indirmeUrl; link.textContent = "ZIP (" + (zip.length / 1048576).toFixed(2) + " MB) — indir"; link.setAttribute("download", zipName); link.removeAttribute("target"); }
      const dl = $("#dlZip");
      if (dl) { dl.disabled = false; dl.textContent = "▼ ZIP'i indir"; dl.onclick = () => { const a = document.createElement("a"); a.href = indirmeUrl; a.download = zipName; document.body.appendChild(a); a.click(); a.remove(); }; }
      try { const a = document.createElement("a"); a.href = indirmeUrl; a.download = zipName; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {}
    }

    state.mirrorSeeds = null;
    const sBtn = $("#surgeDeployBtn");
    if (sBtn) {
      sBtn.disabled = false;
      sBtn.onclick = () => {
        let clean = "ayna-kopya";
        try { clean = new URL(seed).hostname.replace(/[^a-z0-9]/g, ""); } catch(e){}
        const cmd = "npx surge . " + clean + ".surge.sh";
        try { navigator.clipboard.writeText(cmd); } catch(e){}
        alert("🚀 Surge Tek Tıkla Yayın Komutu Panoya Kopyalandı!\n\nİndirilen ZIP arşivini açıp klasörün içindeyken terminale şu komutu yapıştırın:\n" + cmd + "\n\n(Surge hesabı gerekirse terminalde anında e-posta sorar ve ücretsiz yayınlar)");
      };
    }
    const stopBtn2 = $("#stopCrawl"); if (stopBtn2) stopBtn2.disabled = true;
    if (pauseBtn) { pauseBtn.disabled = true; pauseBtn.textContent = "⏸ Duraklat"; }
    if (typeof oturumSil === "function" && !stopNow()) { try { oturumSil(); } catch (e) {} }
    setStat(stopNow() ? "durduruldu ✓" : "tamamlandı ✓");
    $("#crawlStat").textContent = pages + " sayfa · " + assets + " varlık · " + (toplamBayt / 1048576).toFixed(2) + " MB · " +
      (sink ? "diske kaydedildi" : "ZIP hazır") + (UNL ? " · [∞] sınırsız" : "") + (kaynakOzet.dosya ? " · :: " + kaynakOzet.dosya + " kaynak" : "");
    $("#crawlBar").style.width = "100%";
    log("✓ Tamamlandı: " + pages + " sayfa, " + assets + " varlık, " + (toplamBayt / 1048576).toFixed(2) + " MB" +
        (skipped ? " · atlanan: " + skipped : ""));
    if (robotsOn && robots.length) log("ℹ robots.txt etkin: yasaklı yollar indirilmedi. Sınırsız modda da uyulur; kapatmak için kutuyu kaldırın.");
  }
