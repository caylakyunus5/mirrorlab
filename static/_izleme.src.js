  /* ═══════════════ İZLEME VE FARK (Paket 4) ═════════════════════════════════
     1) Site farkı            — iki anlık görüntü arasındaki değişimi gösterir
     2) Periyodik kontrol     — izleme listesi; sayfa açıkken süresi gelen kontrolü
                                yapar, değişiklik olursa bildirir (tarayıcı bildirimi)
     3) Tasarım token geçmişi — renk/font geçmişi ve değişim tablosu

     Not: MirrorLab tamamen tarayıcıda çalıştığı için kontroller yalnızca sayfa
     AÇIKKEN yapılır; sunucu tarafında arka plan işi yoktur. Tüm veriler
     localStorage'da kalır, hiçbir yere gönderilmez.
     ═══════════════════════════════════════════════════════════════════════ */

  const IZLE_ANAHTAR = "mirrorlab_izleme_v1";
  const IZLE_URL_BASI = 6;      // adres başına saklanan anlık görüntü
  const IZLE_URL_SAYI = 40;     // en çok izlenen adres

  function izleDepo() { return kDepoAl(IZLE_ANAHTAR, {}); }
  function izleYaz(d) { return kDepoKoy(IZLE_ANAHTAR, d); }
  const izleKisa = (u) => String(u || "").replace(/^https?:\/\//, "").slice(0, 52);

  /* ── sayfayı çek ve özet çıkar ─────────────────────────────────────── */
  function izleTokenlar(html) {
    const renkSayac = {};
    for (const m of html.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      const r = ("#" + m[1]).toLowerCase();
      renkSayac[r] = (renkSayac[r] || 0) + 1;
    }
    for (const m of html.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/gi)) {
      const on = "#" + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, "0")).join("");
      renkSayac[on] = (renkSayac[on] || 0) + 1;
    }
    const renkler = Object.entries(renkSayac).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]);
    const fontSayac = {};
    for (const m of html.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
      const ilk = String(m[1]).split(",")[0].replace(/["']/g, "").trim().toLowerCase();
      if (ilk && ilk.length < 40 && !/inherit|initial|var\(/.test(ilk)) fontSayac[ilk] = (fontSayac[ilk] || 0) + 1;
    }
    const fontlar = Object.entries(fontSayac).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
    return { renkler, fontlar };
  }
  function izleMetin(doc) {
    const temiz = doc.body ? doc.body.cloneNode(true) : null;
    if (!temiz) return "";
    temiz.querySelectorAll("script,style,noscript,svg").forEach(e => e.remove());
    return (temiz.textContent || "").replace(/\s+/g, " ").trim().slice(0, 14000);
  }
  function izleVarliklar(doc, taban) {
    const liste = [];
    doc.querySelectorAll("script[src],link[href],img[src],source[src]").forEach(el => {
      const v = el.getAttribute("src") || el.getAttribute("href") || "";
      const a = absUrl(v, taban);
      if (!a) return;
      try { const o = new URL(a); liste.push(o.host + o.pathname); } catch (e) {}
    });
    return [...new Set(liste)].sort();
  }
  async function izleCek(url) {
    const r = await fetch(apiUrl("/api/raw?u=" + encodeURIComponent(url)));
    if (!r.ok) throw new Error("sayfa alınamadı (HTTP " + r.status + ")");
    const html = await r.text();
    const taban = r.headers.get("x-ml-final-url") || url;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hBasliklar = [...doc.querySelectorAll("h1,h2,h3")].map(h => h.tagName + " " + (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90)).filter(x => x.length > 3);
    return {
      ts: Date.now(), url, taban,
      baslik: (doc.querySelector("title") || {}).textContent || "",
      aciklama: ((doc.querySelector('meta[name="description"]') || {}).content) || "",
      metin: izleMetin(doc),
      basliklar: hBasliklar.slice(0, 120),
      varliklar: izleVarliklar(doc, taban),
      tokenlar: izleTokenlar(html),
      boyut: html.length,
    };
  }

  /* ── fark hesabı ───────────────────────────────────────────────────── */
  function izleCumleler(metin) {
    return String(metin || "").split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 12);
  }
  function izleFark(eski, yeni) {
    const esE = izleCumleler(eski.metin), yeE = izleCumleler(yeni.metin);
    const kume = (a) => new Set(a);
    const esK = kume(esE), yeK = kume(yeE);
    const eklenen = yeE.filter(s => !esK.has(s)).slice(0, 40);
    const silinen = esE.filter(s => !yeK.has(s)).slice(0, 40);
    const varlikEkle = yeni.varliklar.filter(v => !eski.varliklar.includes(v)).slice(0, 30);
    const varlikSil = eski.varliklar.filter(v => !yeni.varliklar.includes(v)).slice(0, 30);
    const baslikEkle = yeni.basliklar.filter(v => !eski.basliklar.includes(v)).slice(0, 20);
    const baslikSil = eski.basliklar.filter(v => !yeni.basliklar.includes(v)).slice(0, 20);
    const renkEkle = yeni.tokenlar.renkler.filter(v => !eski.tokenlar.renkler.includes(v)).slice(0, 12);
    const renkSil = eski.tokenlar.renkler.filter(v => !yeni.tokenlar.renkler.includes(v)).slice(0, 12);
    const fontEkle = yeni.tokenlar.fontlar.filter(v => !eski.tokenlar.fontlar.includes(v));
    const fontSil = eski.tokenlar.fontlar.filter(v => !yeni.tokenlar.fontlar.includes(v));
    const toplam = Math.max(1, esE.length + yeE.length);
    const yuzde = Math.round(100 * (eklenen.length + silinen.length) / toplam);
    return {
      eklenen, silinen, varlikEkle, varlikSil, baslikEkle, baslikSil, renkEkle, renkSil, fontEkle, fontSil,
      yuzde, baslikDegisti: (eski.baslik || "") !== (yeni.baslik || ""), eskiBaslik: eski.baslik, yeniBaslik: yeni.baslik,
      boyutFark: (yeni.boyut || 0) - (eski.boyut || 0), eski, yeni,
      degisti: !!(eklenen.length || silinen.length || varlikEkle.length || varlikSil.length || (eski.baslik || "") !== (yeni.baslik || "")),
    };
  }

  /* ── anlık görüntü + fark arayüzü ──────────────────────────────────── */
  async function izleGoruntuAl(url, sessiz) {
    if (!url) { showErr("Önce bir adres girin."); return null; }
    const kutu = $("#izlemeDurum");
    if (kutu) kutu.textContent = "* anlık görüntü alınıyor…";
    try {
      const g = await izleCek(url);
      const d = izleDepo();
      const kayit = d[url] || { kayitlar: [], aralikSaat: 24, sonKontrol: 0 };
      kayit.kayitlar = [g, ...(kayit.kayitlar || [])].slice(0, IZLE_URL_BASI);
      kayit.sonKontrol = Date.now();
      kayit.sonDegisim = null;
      d[url] = kayit;
      const anahtarlar = Object.keys(d);
      if (anahtarlar.length > IZLE_URL_SAYI) {
        anahtarlar.sort((a, b) => (d[a].sonKontrol || 0) - (d[b].sonKontrol || 0)).slice(0, anahtarlar.length - IZLE_URL_SAYI).forEach(k => delete d[k]);
      }
      izleYaz(d);
      if (kutu) kutu.textContent = "* " + kayit.kayitlar.length + " görüntü · son: " + kTarih(g.ts);
      if (!sessiz) bildir("* Anlık görüntü alındı (" + Math.round(g.boyut / 1024) + " KB · " + g.tokenlar.renkler.length + " renk · " + g.varliklar.length + " varlık). Değişimi görmek için 'Farkı gör'.");
      izlePanelCiz();
      return g;
    } catch (e) {
      if (kutu) kutu.textContent = "x " + e.message;
      if (!sessiz) bildir("Anlık görüntü alınamadı: " + e.message, "hata");
      return null;
    }
  }
  async function izleFarkGoster(url) {
    const d = izleDepo();
    const kayit = d[url];
    if (!kayit || !(kayit.kayitlar || []).length) { bildir("Önce '* Anlık görüntü al' ile bir referans kaydedin.", "hata"); return; }
    const eski = kayit.kayitlar[0];
    const kutu = $("#izlemeDurum");
    if (kutu) kutu.textContent = ":: karşılaştırılıyor…";
    try {
      const yeni = await izleCek(url);
      const f = izleFark(eski, yeni);
      const d2 = izleDepo();
      d2[url] = Object.assign({}, d2[url], { sonKontrol: Date.now(), sonDegisim: { ts: Date.now(), yuzde: f.yuzde, degisti: f.degisti, ozet: izleOzetMetni(f) } });
      izleYaz(d2);
      if (kutu) kutu.textContent = f.degisti ? ":: değişiklik: %" + f.yuzde : ":: değişiklik yok";
      izleFarkKart(f, url);
      izlePanelCiz();
      return f;
    } catch (e) {
      if (kutu) kutu.textContent = "x " + e.message;
      bildir("Karşılaştırma yapılamadı: " + e.message, "hata");
      return null;
    }
  }
  function izleOzetMetni(f) {
    const p = [];
    if (f.eklenen.length) p.push(f.eklenen.length + " yeni cümle");
    if (f.silinen.length) p.push(f.silinen.length + " kalkmış cümle");
    if (f.varlikEkle.length) p.push(f.varlikEkle.length + " yeni varlık");
    if (f.varlikSil.length) p.push(f.varlikSil.length + " kalkan varlık");
    if (f.baslikDegisti) p.push("başlık değişti");
    return p.join(" · ") || "değişiklik yok";
  }
  function izleFarkKart(f, url) {
    const kutu = $("#farkKart"); if (!kutu) return;
    const liste = (baslik, dizi, renk, bos) => !dizi.length ? "" :
      '<div style="margin-top:10px"><b style="color:' + renk + '">' + baslik + ' (' + dizi.length + ')</b><div class="scroll" style="max-height:190px;margin-top:6px">' +
      dizi.map(x => '<div class="hint" style="padding:3px 0;border-bottom:1px solid #150e03">' + dk(String(x).slice(0, 240)) + '</div>').join("") + '</div></div>' + (bos || "");
    kutu.innerHTML = '<div class="card" style="border-left:4px solid ' + (f.degisti ? "#ffd479" : "#7dfa9b") + '">' +
      '<div class="row"><h3 style="margin:0">' + (f.degisti ? ":: Değişiklik var" : "✓ Değişiklik yok") + '</h3><div class="spacer"></div>' +
      '<span class="hint">metin farkı: <b>%' + f.yuzde + '</b> · ' + kTarih(f.eski.ts) + " -> " + kTarih(f.yeni.ts) + '</span>' +
      '<button class="btn sm ghost" id="farkKapat">[x]</button></div>' +
      '<div class="sub" style="margin-top:6px">Adres: <code class="k">' + dk(izleKisa(url)) + '</code> · sayfa boyutu ' +
      (f.boyutFark >= 0 ? "+" : "") + Math.round(f.boyutFark / 1024) + ' KB</div>' +
      (f.baslikDegisti ? '<div style="margin-top:10px"><b>Başlık değişti:</b> <span class="hint">' + dk(f.eskiBaslik) + '</span> -> <b>' + dk(f.yeniBaslik) + '</b></div>' : "") +
      liste("Yeni metin", f.eklenen, "#7dfa9b") + liste("Kalkan metin", f.silinen, "#ff6b5e") +
      liste("Yeni başlıklar", f.baslikEkle, "#ffd479") + liste("Kalkan başlıklar", f.baslikSil, "#ff6b5e") +
      liste("Yeni varlıklar", f.varlikEkle, "#ffd479") + liste("Kalkan varlıklar", f.varlikSil, "#ff6b5e") +
      liste("Yeni renkler", f.renkEkle, "#d3b0ff") + liste("Kalkan renkler", f.renkSil, "#d3b0ff") +
      liste("Yeni fontlar", f.fontEkle, "#d3b0ff") + liste("Kalkan fontlar", f.fontSil, "#d3b0ff") +
      '<div class="sub" style="margin-top:10px">Metin farkı cümle kümesi karşılaştırmasıdır; dinamik sayaç/tarih gibi alanlar da "değişiklik" sayılabilir.</div></div>';
    kutu.style.display = "block";
    const k = $("#farkKapat"); if (k) k.onclick = () => { kutu.style.display = "none"; };
  }

  /* ── 2) İZLEME LİSTESİ + BİLDİRİM ──────────────────────────────────── */
  function izleListeye(ekle, url) {
    const d = izleDepo();
    if (!d[url]) d[url] = { kayitlar: [], aralikSaat: 24, sonKontrol: 0 };
    d[url].izleniyor = ekle;
    izleYaz(d);
    bildir(ekle ? "^ İzlemeye alındı: " + izleKisa(url) + " · sayfa açıkken 24 saatte bir kontrol edilir." : "İzleme listesinden çıkarıldı.");
    izlePanelCiz();
  }
  async function izleKontrol(sessiz) {
    const d = izleDepo();
    const simdi = Date.now();
    const vadesi = Object.keys(d).filter(u => d[u].izleniyor && (!d[u].sonKontrol || simdi - d[u].sonKontrol > (d[u].aralikSaat || 24) * 3600000));
    if (!vadesi.length) return [];
    const sonuc = [];
    for (const u of vadesi.slice(0, 3)) {                    // tek seferde en çok 3 kontrol
      try {
        const kayit = d[u];
        if (!(kayit.kayitlar || []).length) { await izleGoruntuAl(u, true); continue; }
        const yeni = await izleCek(u);
        const f = izleFark(kayit.kayitlar[0], yeni);
        const d2 = izleDepo();
        d2[u] = Object.assign({}, d2[u], { sonKontrol: simdi, sonDegisim: { ts: simdi, yuzde: f.yuzde, degisti: f.degisti, ozet: izleOzetMetni(f) } });
        if (f.degisti) d2[u].kayitlar = [yeni, ...(d2[u].kayitlar || [])].slice(0, IZLE_URL_BASI);
        izleYaz(d2);
        sonuc.push({ url: u, degisti: f.degisti, yuzde: f.yuzde });
        if (f.degisti && !sessiz) izleBildirimGonder(u, f);
      } catch (e) { sonuc.push({ url: u, hata: e.message }); }
    }
    izlePanelCiz();
    return sonuc;
  }
  function izleBildirimGonder(url, f) {
    const mesaj = "! " + izleKisa(url) + " değişti (%" + f.yuzde + "): " + izleOzetMetni(f);
    bildir(mesaj);
    try {
      if (window.Notification && Notification.permission === "granted") new Notification("MirrorLab · site değişti", { body: izleKisa(url) + " · " + izleOzetMetni(f) });
    } catch (e) {}
  }
  function izlePanelCiz() {
    const k = $("#izlemePanel"); if (!k || k.style.display === "none") return;
    const d = izleDepo();
    const adresler = Object.keys(d);
    if (!adresler.length) { k.innerHTML = '<div class="card"><div class="sub">Kayıt yok. "* Anlık görüntü al" ile bir referans oluşturun.</div></div>'; return; }
    const satir = adresler.map(u => {
      const r = d[u], k0 = (r.kayitlar || [])[0] || {};
      const sd = r.sonDegisim;
      return '<tr><td class="hint" title="' + dk(u) + '">' + dk(izleKisa(u)) + (r.izleniyor ? ' <span title="izleniyor">^</span>' : "") + '</td>' +
        '<td>' + (r.kayitlar || []).length + '</td>' +
        '<td class="hint">' + (k0.ts ? kTarih(k0.ts) : "—") + '</td>' +
        '<td class="hint">' + (sd ? (sd.degisti ? '<b style="color:#ffd479">%' + sd.yuzde + '</b> ' + dk(sd.ozet || "") : '<span style="color:#7dfa9b">değişiklik yok</span>') : "—") + '</td>' +
        '<td class="hint">' + ((k0.tokenlar && k0.tokenlar.renkler || []).slice(0, 5).map(c => '<i style="display:inline-block;width:11px;height:11px;border-radius:3px;background:' + c + ';margin-right:3px;border:1px solid #5e4000"></i>').join("")) + '</td>' +
        '<td><button class="btn sm" data-izle-fark="' + dk(u) + '">:: fark</button> ' +
        '<button class="btn sm" data-izle-goz="' + dk(u) + '">' + (r.izleniyor ? "^ bırak" : "^ izle") + '</button> ' +
        '<button class="btn sm" data-izle-git="' + dk(u) + '">R analiz</button> ' +
        '<button class="btn sm ghost" data-izle-sil="' + dk(u) + '">[x]</button></td></tr>';
    }).join("");
    k.innerHTML = '<div class="card"><div class="row"><h3 style="margin:0">^ İzleme listesi ve tasarım token geçmişi</h3><div class="spacer"></div>' +
      '<button class="btn sm" id="izleKontrolEt">R süresi gelenleri şimdi kontrol et</button>' +
      '<span class="hint">kontroller yalnızca sayfa açıkken yapılır</span></div>' +
      '<div class="scroll" style="margin-top:10px"><table><tr><th>adres</th><th style="width:66px">görüntü</th><th style="width:96px">son</th><th>son değişim</th><th style="width:100px">renkler</th><th style="width:250px"></th></tr>' + satir + '</table></div>' +
      '<div class="sub" style="margin-top:10px">Veriler yalnızca bu tarayıcıda (localStorage) tutulur. Tam arka plan izleme için sunucu gerekir; bu sürüm istemci tarafıdır.</div></div>';
    const kk = $("#izleKontrolEt");
    if (kk) kk.onclick = async () => {
      kk.disabled = true; kk.textContent = "kontrol ediliyor…";
      const r = await izleKontrol(false);
      kk.disabled = false; kk.textContent = "R süresi gelenleri şimdi kontrol et";
      if (!r.length) bildir("Süresi gelen kontrol yok (izlenen adreslerin süresi dolmamış).");
    };
    k.querySelectorAll("[data-izle-fark]").forEach(b => b.onclick = () => izleFarkGoster(b.dataset.izleFark));
    k.querySelectorAll("[data-izle-goz]").forEach(b => b.onclick = () => { const u = b.dataset.izleGoz; const d2 = izleDepo(); izleListeye(!(d2[u] && d2[u].izleniyor), u); });
    k.querySelectorAll("[data-izle-git]").forEach(b => b.onclick = () => { const u = b.dataset.izleGit; const i = $("#url"); if (i) i.value = u; state.url = u; const g = $("#go"); if (g) g.click(); });
    k.querySelectorAll("[data-izle-sil]").forEach(b => b.onclick = () => { const d2 = izleDepo(); delete d2[b.dataset.izleSil]; izleYaz(d2); izlePanelCiz(); });
  }
  async function izleGorunum(ac) {
    const k = $("#izlemePanel");
    k.style.display = ac === undefined ? (k.style.display === "none" ? "block" : "none") : (ac ? "block" : "none");
    if (k.style.display !== "none") izlePanelCiz();
  }
  function izleKur() {
    const g = $("#snapBtn"); if (g) g.onclick = () => { const u = state.url || normUrl(($("#url") || {}).value) || ""; izleGoruntuAl(u); };
    const f = $("#farkBtn"); if (f) f.onclick = () => { const u = state.url || normUrl(($("#url") || {}).value) || ""; izleFarkGoster(u); };
    const i = $("#izleBtn");
    if (i) i.onclick = () => {
      const u = state.url || normUrl(($("#url") || {}).value) || "";
      if (!u) { showErr("Önce bir adres girin."); return; }
      try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
      const d = izleDepo();
      const varMi = d[u] && (d[u].kayitlar || []).length;
      if (!varMi) izleGoruntuAl(u, true).then(() => izleListeye(true, u)); else izleListeye(true, u);
      izleGorunum(true);
    };
    const l = $("#izleListeBtn"); if (l) l.onclick = () => izleGorunum();
    setTimeout(() => { izleKontrol(true).catch(() => {}); }, 4000);   // açılışta süresi gelenleri sessizce kontrol et
  }
