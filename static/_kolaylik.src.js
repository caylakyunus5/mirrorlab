  /* ═══════════════ KULLANIM KOLAYLIĞI (Paket 3) ══════════════════════════════
     1) Analiz geçmişi        — son 30 analiz tarayıcıda saklanır (localStorage)
     2) Paylaşılabilir rapor  — sonuçlar bağlantıya gömülür (#rapor=…), sunucu gerekmez
     3) Yarıda kalan kopya    — kuyruk + ayarlar saklanır; sayfa kapansa da sürdürülür
     4) Öğe denetçisi         — klonun içinde tıkla: etiket/sınıf/kutu modeli/stil
     Hiçbiri sunucuya veri göndermez; hepsi tarayıcınızda kalır.
     ═══════════════════════════════════════════════════════════════════════ */

  const KOLAY_GECMIS = "mirrorlab_gecmis_v1";
  const KOLAY_OTURUM = "mirrorlab_oturum_v1";
  const KOLAY_IZLEME = "mirrorlab_izleme_v1";

  function kDepoAl(anahtar, varsayilan) {
    try { const t = localStorage.getItem(anahtar); return t ? JSON.parse(t) : varsayilan; }
    catch (e) { return varsayilan; }
  }
  function kDepoKoy(anahtar, deger) {
    try { localStorage.setItem(anahtar, JSON.stringify(deger)); return true; }
    catch (e) { return false; }
  }
  function kDepoSil(anahtar) { try { localStorage.removeItem(anahtar); } catch (e) {} }
  const kKisaUrl = (u) => String(u || "").replace(/^https?:\/\//, "").slice(0, 58);
  const kTarih = (ts) => new Date(ts).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  /* ── 1) ANALİZ GEÇMİŞİ ─────────────────────────────────────────────── */
  function gecmisEkle(ozet) {
    if (!ozet || !ozet.url) return;
    const liste = kDepoAl(KOLAY_GECMIS, []).filter(x => x.url !== ozet.url || Math.abs((x.ts || 0) - (ozet.ts || 0)) > 60000);
    liste.unshift(ozet);
    kDepoKoy(KOLAY_GECMIS, liste.slice(0, 30));
    gecmisDugmeGuncelle();
  }
  function gecmisDugmeGuncelle() {
    const n = kDepoAl(KOLAY_GECMIS, []).length;
    const s = $("#gecmisSayi"); if (s) s.textContent = n ? "(" + n + ")" : "";
  }
  function gecmisCiz() {
    const panel = $("#gecmisPanel"); if (!panel) return;
    if (panel.style.display !== "none" && panel.innerHTML) { panel.style.display = "none"; return; }
    const liste = kDepoAl(KOLAY_GECMIS, []);
    if (!liste.length) {
      panel.innerHTML = '<div class="card"><div class="sub">Henüz kayıt yok. Bir adres analiz edince sonuçlar burada listelenir (tarayıcınızda saklanır, dışarı gönderilmez).</div></div>';
      panel.style.display = "block"; return;
    }
    const renk = (s) => s >= 75 ? "#7dfa9b" : s >= 40 ? "#ffd479" : "#ff6b5e";
    panel.innerHTML = '<div class="card"><div class="row"><h3 style="margin:0"># Analiz geçmişi</h3><div class="spacer"></div>' +
      '<span class="hint">' + liste.length + ' kayıt · yalnızca bu tarayıcıda</span>' +
      '<button class="btn sm ghost" id="gecmisTemizle">[x] geçmişi sil</button></div>' +
      '<div class="scroll" style="margin-top:10px"><table><tr><th>adres</th><th style="width:74px">uygunluk</th><th style="width:150px">teknoloji</th><th style="width:96px">güvenlik</th><th style="width:88px">tarih</th><th style="width:120px"></th></tr>' +
      liste.map((x, i) =>
        '<tr><td class="hint" title="' + dk(x.url) + '">' + dk(kKisaUrl(x.url)) + '</td>' +
        '<td><b style="color:' + renk(x.skor || 0) + '">' + (x.skor != null ? x.skor + "/100" : "—") + '</b></td>' +
        '<td class="hint">' + dk((x.teknoloji || []).slice(0, 3).join(", ") || "—") + '</td>' +
        '<td class="hint">' + (x.guvenlik != null ? x.guvenlik + "/100" : "—") + '</td>' +
        '<td class="hint">' + kTarih(x.ts) + '</td>' +
        '<td><button class="btn sm" data-gecmis="' + i + '">R yeniden analiz</button> ' +
        '<button class="btn sm ghost" data-rapor="' + i + '" title="sonuçları bağlantı olarak kopyala">&</button></td></tr>').join("") +
      '</table></div></div>';
    panel.style.display = "block";
    const temizle = $("#gecmisTemizle");
    if (temizle) temizle.onclick = () => { kDepoSil(KOLAY_GECMIS); gecmisDugmeGuncelle(); panel.innerHTML = ""; gecmisCiz(); };
    panel.querySelectorAll("[data-gecmis]").forEach(b => b.onclick = () => {
      const kayit = kDepoAl(KOLAY_GECMIS, [])[+b.dataset.gecmis]; if (!kayit) return;
      const u = $("#url"); if (u) u.value = kayit.url;
      state.url = kayit.url;
      const go = $("#go"); if (go) go.click();
    });
    panel.querySelectorAll("[data-rapor]").forEach(b => b.onclick = () => {
      const kayit = kDepoAl(KOLAY_GECMIS, [])[+b.dataset.rapor]; if (!kayit) return;
      raporKopyala(kayit);
    });
  }

  /* ── 2) PAYLAŞILABİLİR RAPOR BAĞLANTISI ─────────────────────────────── */
  function k64Kodla(metin) {
    try { return btoa(String.fromCharCode(...new TextEncoder().encode(metin))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    catch (e) { return ""; }
  }
  function k64Coz(kod) {
    try {
      const b = atob(kod.replace(/-/g, "+").replace(/_/g, "/"));
      const bayt = new Uint8Array([...b].map(c => c.charCodeAt(0)));
      return new TextDecoder().decode(bayt);
    } catch (e) { return ""; }
  }
  function raporOzetiTopla(url) {
    const fit = state.fitOzet || {}, derin = state.derinOzet || {};
    return {
      v: 1, url, ts: Date.now(),
      skor: fit.skor != null ? fit.skor : null, seviye: fit.seviye || "", etiket: fit.etiket || "",
      teknoloji: (derin.teknoloji || []).map(t => t.surum ? t.ad + " " + t.surum : t.ad).slice(0, 10),
      guvenlik: derin.guvenlik ? derin.guvenlik.skor : null,
      guvenlikEksik: derin.guvenlik ? (derin.guvenlik.eksikler || []).slice(0, 5) : [],
      apiYol: derin.apiYol || 0, graphql: derin.graphql || [],
      kaynakDosya: derin.kaynakDosya || 0,
    };
  }
  function raporBaglantiKur(ozet) {
    const kod = k64Kodla(JSON.stringify(ozet));
    const temel = location.origin + location.pathname;
    return temel + "#rapor=" + kod;
  }
  async function raporKopyala(ozet) {
    const link = raporBaglantiKur(ozet);
    let kopyalandi = false;
    try { await navigator.clipboard.writeText(link); kopyalandi = true; } catch (e) { /* pano izni yoksa aşağıdaki panel kullanılır */ }
    /* Her durumda görünür panel: panoya erişilemeyen tarayıcılar için güvenli yol */
    const panel = $("#raporPanel");
    if (panel) {
      panel.style.display = "block";
      panel.innerHTML = '<div class="card" style="border-left:4px solid #d3b0ff"><div class="row"><h3 style="margin:0">& Rapor bağlantısı</h3><div class="spacer"></div>' +
        '<span class="hint">' + (kopyalandi ? "panoya kopyalandı ✓" : "panoya yazılamadı — kutudan kopyalayın") + '</span></div>' +
        '<div class="sub" style="margin-top:6px">Bu bağlantı analiz özetini kendi içinde taşır: açan kişi sayfayı <b>yeniden çalıştırmadan</b> sonuçları görür. Sunucuya hiçbir şey gönderilmez.</div>' +
        '<input id="raporLink" readonly value="' + dk(link) + '" style="width:100%;margin-top:8px;font-size:12px" onclick="this.select()">' +
        '<div class="row" style="margin-top:10px"><button class="btn sm primary" id="raporAc">▶ Raporu bu sekmede aç</button>' +
        '<button class="btn sm ghost" id="raporKapat2">[x] kapat</button></div></div>';
      const lnk = $("#raporLink"); if (lnk) { lnk.focus(); lnk.select(); }
      const ac = $("#raporAc"); if (ac) ac.onclick = () => { location.hash = "#rapor=" + k64Kodla(JSON.stringify(ozet)); raporKartCiz(ozet); tabClick(1); };
      const kp = $("#raporKapat2"); if (kp) kp.onclick = () => { panel.style.display = "none"; };
    }
    bildir(kopyalandi ? "& Rapor bağlantısı kopyalandı — açan kişi sonuçları yeniden çalıştırmadan görür."
                      : "& Rapor bağlantısı hazır: kutudan kopyalayın.", kopyalandi ? undefined : "hata");
    return link;
  }
  function bildir(mesaj, tur) {
    let k = $("#kolayBildirim");
    if (!k) {
      k = document.createElement("div");
      k.id = "kolayBildirim";
      k.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:99;max-width:360px;padding:12px 14px;border-radius:12px;font:14px system-ui;box-shadow:0 10px 30px rgba(0,0,0,.45)";
      document.body.appendChild(k);
    }
    k.style.background = tur === "hata" ? "#6b2a22" : "#150e03";
    k.style.color = tur === "hata" ? "#ffbdb5" : "#ffd8a0";
    k.style.border = "1px solid " + (tur === "hata" ? "#6b2a22" : "#150e03");
    k.textContent = mesaj;
    k.style.display = "block";
    clearTimeout(k.__t); k.__t = setTimeout(() => { k.style.display = "none"; }, 6000);
  }
  function raporKartCiz(ozet) {
    const kutu = $("#raporKart"); if (!kutu) return;
    if (!ozet) { kutu.innerHTML = ""; return; }
    const renk = (s) => s == null ? "#a87200" : s >= 75 ? "#7dfa9b" : s >= 40 ? "#ffd479" : "#ff6b5e";
    kutu.innerHTML = '<div class="card" style="border-left:4px solid #d3b0ff">' +
      '<div class="row"><h3 style="margin:0">& Paylaşılan analiz raporu</h3><div class="spacer"></div>' +
      '<span class="hint">' + kTarih(ozet.ts || Date.now()) + ' · yeniden çalıştırılmadı, kayıtlı sonuçlar</span>' +
      '<button class="btn sm ghost" id="raporKapat">[x]</button></div>' +
      '<div class="sub" style="margin-top:8px">Adres: <code class="k">' + dk(ozet.url) + '</code></div>' +
      '<div class="grid g3" style="margin-top:10px">' +
        '<div class="stat"><div class="k">Kopyalama uygunluğu</div><div class="v" style="color:' + renk(ozet.skor) + '">' + (ozet.skor != null ? ozet.skor + " <small>/100</small>" : "—") + '</div></div>' +
        '<div class="stat"><div class="k">Güvenlik başlıkları</div><div class="v" style="color:' + renk(ozet.guvenlik) + '">' + (ozet.guvenlik != null ? ozet.guvenlik + " <small>/100</small>" : "—") + '</div></div>' +
        '<div class="stat"><div class="k">API yolu / kaynak dosya</div><div class="v">' + (ozet.apiYol || 0) + " <small>/</small> " + (ozet.kaynakDosya || 0) + '</div></div>' +
      '</div>' +
      ((ozet.teknoloji || []).length ? '<div style="margin-top:10px"><b>Teknolojiler:</b> <span class="hint">' + dk(ozet.teknoloji.join(" · ")) + '</span></div>' : "") +
      ((ozet.guvenlikEksik || []).length ? '<div style="margin-top:6px"><b>Öncelikli güvenlik eksikleri:</b> <span class="hint">' + dk(ozet.guvenlikEksik.join(", ")) + '</span></div>' : "") +
      '<div class="row" style="margin-top:12px"><button class="btn sm primary" id="raporCalistir">▶ Bu adresi şimdi analiz et</button>' +
      '<span class="hint">Rapor bağlantısı hiçbir veriyi sunucuya göndermez; özet bağlantının kendisinde taşınır.</span></div></div>';
    kutu.style.display = "block";
    const kapat = $("#raporKapat");
    if (kapat) kapat.onclick = () => { kutu.innerHTML = ""; kutu.style.display = "none"; if (location.hash.startsWith("#rapor=")) history.replaceState(null, "", location.pathname); };
    const calistir = $("#raporCalistir");
    if (calistir) calistir.onclick = () => { const u = $("#url"); if (u) u.value = ozet.url; const go = $("#go"); if (go) go.click(); };
  }
  function raporHashOku() {
    const h = location.hash || "";
    const i = h.indexOf("#rapor=");
    if (i < 0) return null;
    const j = k64Coz(h.slice(i + 7));
    if (!j) return null;
    try { const o = JSON.parse(j); return o && o.url ? o : null; } catch (e) { return null; }
  }

  /* ── 3) YARIDA KALAN KOPYALAMAYI SÜRDÜR ─────────────────────────────── */
  /* Motorun çağırdığı kancalar: kuyruk + ayarlar saklanır (dosya içerikleri değil). */
  function oturumKaydet(o) {
    if (!o || !o.seed) return;
    kDepoKoy(KOLAY_OTURUM, {
      seed: o.seed, ts: Date.now(), sayfa: o.pages || 0, varlik: o.assets || 0,
      kuyruk: (o.kuyruk || []).slice(0, 3000), ayar: o.ayar || {},
    });
    oturumBildir(true);
  }
  function oturumSil() { kDepoSil(KOLAY_OTURUM); oturumBildir(); }
  function oturumBildir(sessiz) {
    const k = $("#devamBanner"); if (!k) return;
    const o = kDepoAl(KOLAY_OTURUM, null);
    if (!o || !o.seed) { k.style.display = "none"; k.innerHTML = ""; return; }
    k.style.display = "block";
    k.innerHTML = '<div class="card" style="border-left:4px solid #ffd479">' +
      '<div class="row"><b>⏸ Yarıda kalmış kopyalama bulundu</b><div class="spacer"></div>' +
      '<span class="hint">' + kTarih(o.ts) + ' · ' + o.sayfa + ' sayfa · ' + (o.kuyruk || []).length + ' adres sırada</span></div>' +
      '<div class="sub" style="margin-top:6px">Kaynak: <code class="k">' + dk(kKisaUrl(o.seed)) + '</code> — ayarlar ve kuyruk saklandı. ' +
      'Devam ettiğinizde sayfalar <b>yeniden indirilir</b> (dosya içerikleri tarayıcıda saklanmaz), kuyruk kaldığı yerden sürer.</div>' +
      '<div class="row" style="margin-top:10px"><button class="btn sm primary" id="devamEt">▶ Kaldığı yerden devam et</button>' +
      '<button class="btn sm ghost" id="devamSil">[x] kaydı sil</button></div></div>';
    if (!sessiz) bildir("⏸ Yarıda kalan kopyalama bulundu: " + (o.kuyruk || []).length + " adres sırada.");
    const d = $("#devamEt"), s2 = $("#devamSil");
    if (d) d.onclick = () => {
      const o2 = kDepoAl(KOLAY_OTURUM, null); if (!o2) return;
      const t = $$("#tabs .tab")[8]; if (t) t.click();
      const u = $("#url"); if (u) u.value = o2.seed; state.url = o2.seed;
      const a = o2.ayar || {};
      if (a.pages) $("#cPages").value = a.pages;
      if (a.assets) $("#cAssets").value = a.assets;
      if (a.mb) $("#cMb").value = a.mb;
      if (a.scope != null) $("#cScope").value = a.scope;
      if (a.iframes != null && $("#cIframes")) $("#cIframes").checked = !!a.iframes;
      if (a.robots != null) $("#cRobots").checked = !!a.robots;
      if (a.render != null && $("#cRender")) $("#cRender").checked = !!a.render;
      state.devamKuyruk = o2.kuyruk || [];
      state.mirrorSeeds = null;
      mirrorStart(false);
    };
    if (s2) s2.onclick = () => { oturumSil(); };
  }

  /* ── 4) ÖĞE DENETÇİSİ ───────────────────────────────────────────────── */
  function denetciSeciciYolu(el) {
    const parca = [];
    let d = el;
    while (d && d.nodeType === 1 && parca.length < 5) {
      let s = d.tagName.toLowerCase();
      if (d.id) { parca.unshift(s + "#" + d.id); break; }
      const sinif = (d.className && typeof d.className === "string") ? d.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      if (sinif) s += "." + sinif;
      const kardes = d.parentElement ? [...d.parentElement.children].filter(x => x.tagName === d.tagName).indexOf(d) + 1 : 0;
      if (kardes > 1) s += ":nth-of-type(" + kardes + ")";
      parca.unshift(s);
      d = d.parentElement;
    }
    return parca.join(" > ");
  }

  function htmlToJsx(h) {
    if (!h) return "";
    let s = h
      .replace(/\sclass=/g, ' className=')
      .replace(/\sfor=/g, ' htmlFor=')
      .replace(/\sautocomplete=/gi, ' autoComplete=')
      .replace(/\s(tabindex|rowspan|colspan|readonly|maxlength)=/gi, (m, a) => ' ' + a.toLowerCase().replace(/^(.)(.*)$/, (x, y, z) => y + z[0].toUpperCase() + z.slice(1)) + '=');
    s = s.replace(/<(img|input|br|hr|meta|link)([^>]*?)(?<!\/)>/gi, '<$1$2 />');
    return s;
  }

  function stylesToTailwind(cs) {
    const tw = [];
    const d = cs.getPropertyValue("display");
    if (d === "flex") tw.push("flex");
    else if (d === "grid") tw.push("grid");
    else if (d === "inline-block") tw.push("inline-block");
    else if (d === "none") tw.push("hidden");

    if (d === "flex") {
      const fdir = cs.getPropertyValue("flex-direction");
      if (fdir === "column") tw.push("flex-col");
      const jc = cs.getPropertyValue("justify-content");
      if (jc.includes("center")) tw.push("justify-center");
      else if (jc.includes("space-between")) tw.push("justify-between");
      const ai = cs.getPropertyValue("align-items");
      if (ai.includes("center")) tw.push("items-center");
    }

    const pos = cs.getPropertyValue("position");
    if (pos === "relative") tw.push("relative");
    else if (pos === "absolute") tw.push("absolute");
    else if (pos === "fixed") tw.push("fixed");

    const fw = parseInt(cs.getPropertyValue("font-weight"), 10);
    if (fw >= 700) tw.push("font-bold");
    else if (fw >= 600) tw.push("font-semibold");
    else if (fw >= 500) tw.push("font-medium");

    const fz = parseFloat(cs.getPropertyValue("font-size"));
    if (fz >= 32) tw.push("text-3xl");
    else if (fz >= 24) tw.push("text-2xl");
    else if (fz >= 20) tw.push("text-xl");
    else if (fz >= 18) tw.push("text-lg");
    else if (fz <= 12) tw.push("text-xs");
    else if (fz <= 14) tw.push("text-sm");

    const br = parseFloat(cs.getPropertyValue("border-radius"));
    if (br >= 999) tw.push("rounded-full");
    else if (br >= 16) tw.push("rounded-2xl");
    else if (br >= 12) tw.push("rounded-xl");
    else if (br >= 8) tw.push("rounded-lg");
    else if (br >= 4) tw.push("rounded");

    const pad = parseFloat(cs.getPropertyValue("padding-top"));
    if (pad >= 24) tw.push("p-6");
    else if (pad >= 16) tw.push("p-4");
    else if (pad >= 8) tw.push("p-2");

    const bs = cs.getPropertyValue("box-shadow");
    if (bs && bs !== "none") tw.push("shadow-md");

    return tw.join(" ") || "relative";
  }

  function denetciGoster(el, pencere) {
    const kutu = $("#denetciInfo"); if (!kutu || !el) return;
    const cs = pencere.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const kisa = (s, n) => { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > (n || 60) ? s.slice(0, n || 60) + "…" : s; };
    const html = kisa(el.outerHTML, 420);
    const fullHtml = el.outerHTML;
    const jsxCode = htmlToJsx(fullHtml);
    const twClasses = stylesToTailwind(cs);

    kutu.innerHTML = '<div class="card"><div class="row"><h3 style="margin:0">:: ' + dk(el.tagName.toLowerCase()) + (el.id ? "#" + dk(el.id) : "") + '</h3>' +
      '<div class="spacer"></div><span class="hint">tıkla -> başka öğe · Esc -> temizle</span></div>' +
      '<div class="sub" style="margin-top:6px">seçici: <code class="k">' + dk(denetciSeciciYolu(el)) + '</code></div>' +
      '<div class="grid g3" style="margin-top:10px">' +
        '<div class="stat"><div class="k">Kutu (genişlik × yükseklik)</div><div class="v" style="font-size:15px">' + Math.round(r.width) + " × " + Math.round(r.height) + '</div></div>' +
        '<div class="stat"><div class="k">Konum (x, y)</div><div class="v" style="font-size:15px">' + Math.round(r.left) + ", " + Math.round(r.top) + '</div></div>' +
        '<div class="stat"><div class="k">Sınıflar</div><div class="v" style="font-size:13px">' + dk(kisa(el.className, 40) || "—") + '</div></div>' +
      '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn sm primary" id="denetciCopyJsx">⚛️ React JSX Kopyala</button>' +
        '<button class="btn sm" id="denetciCopyTw">🎨 Tailwind Kopyala</button>' +
        '<button class="btn sm" id="denetciCopyHtml">📋 HTML Kopyala</button>' +
      '</div>' +
      '<div style="margin-top:10px"><b>Yerleşim:</b><div class="scroll" style="margin-top:6px"><table>' +
        ["display", "position", "margin", "padding", "border-radius", "flex", "grid-template-columns", "z-index"].map(p => '<tr><td style="width:190px">' + p + '</td><td class="hint">' + dk(cs.getPropertyValue(p) || "—") + '</td></tr>').join("") +
      '</table></div></div>' +
      '<div style="margin-top:10px"><b>Metin ve renk:</b><div class="scroll" style="margin-top:6px"><table>' +
        ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "box-shadow"].map(p => '<tr><td style="width:190px">' + p + '</td><td class="hint">' + dk(cs.getPropertyValue(p) || "—") + '</td></tr>').join("") +
      '</table></div></div>' +
      '<div style="margin-top:10px"><b>Tailwind Tahmini</b><div class="mono" style="padding:8px;background:#0d0902;border-radius:8px;font-size:12px;color:#7dfa9b;margin-top:4px">' + dk(twClasses) + '</div></div>' +
      '<div style="margin-top:10px"><b>HTML parçası</b><pre class="scroll" style="max-height:150px;font-size:12px;padding:10px;background:#0d0902;border-radius:10px;margin-top:6px">' + dk(html) + '</pre></div>' +
      '<div class="sub" style="margin-top:8px">Denetçi, klonlanmış sayfanın <b>çevrimdışı kopyası</b> üzerinde çalışır; değerler o andaki hesaplanmış (computed) stillerdir.</div></div>';

    const bJsx = $("#denetciCopyJsx");
    if (bJsx) bJsx.onclick = async () => {
      try { await navigator.clipboard.writeText(jsxCode); bJsx.textContent = "✓ JSX Kopyalandı"; setTimeout(() => { bJsx.textContent = "⚛️ React JSX Kopyala"; }, 2000); } catch(e){}
    };
    const bTw = $("#denetciCopyTw");
    if (bTw) bTw.onclick = async () => {
      try { await navigator.clipboard.writeText(twClasses); bTw.textContent = "✓ Tailwind Kopyalandı"; setTimeout(() => { bTw.textContent = "🎨 Tailwind Kopyala"; }, 2000); } catch(e){}
    };
    const bHtml = $("#denetciCopyHtml");
    if (bHtml) bHtml.onclick = async () => {
      try { await navigator.clipboard.writeText(fullHtml); bHtml.textContent = "✓ HTML Kopyalandı"; setTimeout(() => { bHtml.textContent = "📋 HTML Kopyala"; }, 2000); } catch(e){}
    };

    // denetleyici özeti: tasarım sistemi sekmesine köprü
    kutu.querySelectorAll("[data-git]").forEach(b => b.onclick = () => b.dataset.git && tabClick(+b.dataset.git));
  }
  async function denetciBaslat() {
    const u = normUrl($("#url").value) || state.url;
    if (!u) { showErr("Önce bir adres girin."); return; }
    const panel = $("#denetciPanel"), ifr = $("#denetciFrame");
    panel.style.display = ifr.style.display === "none" ? "block" : "none";
    if (ifr.style.display !== "none") return;
    ifr.style.display = "block";
    $("#denetciInfo").innerHTML = '<div class="card"><div class="sub">Klon çevrimdışı kopyası hazırlanıyor…</div></div>';
    try {
      const r = await fetch(apiUrl("/api/raw?u=" + encodeURIComponent(u)));
      let html = await r.text();
      const taban = r.headers.get("x-ml-final-url") || u;
      html = html.replace(/<(base|meta http-equiv=["']?refresh)[^>]*>/gi, "");
      html = html.replace(/\s(href|src)=["']([^"']+)["']/gi, (t, at, v) => {
        const a = absUrl(v, taban);
        return a ? " " + at + '="' + a + '"' : t;
      });
      ifr.srcdoc = html;
      ifr.onload = () => {
        const w = ifr.contentWindow, d = ifr.contentDocument;
        if (!d) { $("#denetciInfo").innerHTML = '<div class="card"><div class="sub">Sayfa içeriğine erişilemedi (tarayıcı güvenlik kuralı).</div></div>'; return; }
        $("#denetciInfo").innerHTML = '<div class="card"><div class="sub">Klon içinde bir öğeye tıklayın — etiketi, sınıfları, kutu modeli ve stilleri burada gösterilir.</div></div>';
        const vurgula = (el, kat) => {
          if (el.__mlOnce || !el.style) return;
          el.__mlOnce = true;
          el.addEventListener("mouseenter", () => { el.__mlOldOutline = el.style.outline; el.style.outline = "2px solid #ffd479"; }, true);
          el.addEventListener("mouseleave", () => { el.style.outline = el.__mlOldOutline || ""; }, true);
        };
        d.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const el = ev.target;
          if (!el || el.nodeType !== 1) return;
          [...d.querySelectorAll("[data-ml-secili]")].forEach(x => { x.removeAttribute("data-ml-secili"); x.style.outline = x.__mlOldOutline || ""; });
          el.setAttribute("data-ml-secili", "1"); el.__mlOldOutline = el.style.outline; el.style.outline = "2px solid #d3b0ff";
          denetciGoster(el, w);
        }, true);
        d.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { const k = $("#denetciInfo"); if (k) k.innerHTML = ""; } });
        [...d.querySelectorAll("body, body *")].slice(0, 1500).forEach(el => vurgula(el));
        $("#denetciInfo").innerHTML = '<div class="card"><div class="sub">' + d.querySelectorAll("*").length + ' öğe yüklendi. Klon içinde bir öğeye tıklayın.</div></div>';
      };
    } catch (e) {
      $("#denetciInfo").innerHTML = '<div class="card"><div class="sub">Klon alınamadı: ' + dk(e.message) + '</div></div>';
    }
  }

  /* ── BAĞLANTILAR ────────────────────────────────────────────────────── */
  function kolaylikKur() {
    const g = $("#gecmisBtn"); if (g) g.onclick = () => { gecmisCiz(); };
    const r = $("#raporBtn");
    if (r) r.onclick = () => {
      const u = state.url || normUrl(($("#url") || {}).value) || "";
      if (!u) { showErr("Önce bir adres girin."); return; }
      const ozet = raporOzetiTopla(u);
      if (!state.fitOzet && !state.derinOzet) { bildir("Rapor için önce analiz çalıştırın (sonuçlar özetlenir).", "hata"); return; }
      raporKopyala(ozet);
    };
    const d = $("#denetciBtn"); if (d) d.onclick = (ev) => { ev.preventDefault(); denetciBaslat(); };
    const p = $("#pauseCrawl");
    if (p) p.onclick = () => {
      state.mirrorPause = !state.mirrorPause;
      p.textContent = state.mirrorPause ? "▶ Devam et" : "⏸ Duraklat";
      bildir(state.mirrorPause ? "⏸ Kopyalama duraklatıldı — kuyruk ve sayaçlar korunuyor." : "▶ Kopyalama sürüyor.");
    };
    gecmisDugmeGuncelle();
    oturumBildir();
    const ozet = raporHashOku();
    if (ozet) { tabClick(1); raporKartCiz(ozet); }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { const k = $("#denetciInfo"); if (k) k.innerHTML = ""; }
    });
  }
