  /* ═══════════════ "TAM KOPYALAMAYA UYGUN MU?" DEĞERLENDİRMESİ ═══════════════
     Tarayıcı analizinin çıktısına bakarak hedefin tam site kopyalamaya ne kadar
     uygun olduğunu söyler: robots.txt, bot koruması, SPA/istemci render, varlık
     yoğunluğu, gömülü çerçeve ve form/giriş sinyalleri.

     Seviyeler: uygun (yeşil) · kısmen (sarı) · uygun değil (kırmızı)
     ═══════════════════════════════════════════════════════════════════════ */

  /* robots.txt kurallarını /api/raw üzerinden çek (cross-origin dostu) */
  async function fetchRobots(origin) {
    try {
      const r = await fetch(apiUrl("/api/raw?u=" + encodeURIComponent(origin.replace(/\/$/, "") + "/robots.txt")));
      if (!r.ok) return { rules: [], ok: false, neden: "robots.txt yok (HTTP " + r.status + ")" };
      const t = await r.text();
      if (/^\s*</.test(t)) return { rules: [], ok: false, neden: "robots.txt yok (HTML döndü)" };
      const rules = parseRobots(t);
      return { rules, ok: true, neden: rules.length ? rules.length + " kural bulundu" : "boş" };
    } catch (e) { return { rules: [], ok: false, neden: "alınamadı" }; }
  }

  /* Kopya uygunluğunu hesapla */
  async function mirrorFit(d) {
    const c = d.domCounts || (d.counts || {});
    const net = d.network || [];
    const fw = (d.frameworks || []).map(f => (f.name || "").toLowerCase());
    let host = "";
    try { host = new URL(d.finalUrl || state.url).origin; } catch (e) {}

    const artilar = [], eksiler = [], notlar = [];
    let skor = 100;

    /* 1) bot koruması */
    const korumaMetni = ((d.title || "") + " " + (d.textSample || "") + " " +
      net.map(r => r.url || "").join(" ")).toLowerCase();
    const botKoruma = !!d.blockedChallenge ||
      /just a moment|attention required|checking your browser|verify you are human|captcha|bir dakika/.test(korumaMetni) ||
      net.some(r => /challenge-platform|cdn-cgi\/challenge|hcaptcha|recaptcha/i.test(r.url || ""));
    if (botKoruma) { skor -= 55; eksiler.push("Bot koruması / doğrulama sayfası görünüyor — kopyalanan içerik büyük olasılıkla boş ya da eksik çıkar."); }
    const hataliYanit = net.filter(r => (r.status || 0) >= 400 && (r.type === "document" || r.document)).length;
    if (hataliYanit) { skor -= 10; eksiler.push("Ana belge " + hataliYanit + " kez hata döndü (4xx/5xx)."); }

    /* 2) robots.txt */
    let robots = { rules: [], ok: false, neden: "" };
    if (host) robots = await fetchRobots(host);
    const yolYasak = (p) => robots.rules.length && robotsBlocked(robots.rules, p);
    const kokYasak = yolYasak("/");
    const varlikDizinler = ["/assets/", "/static/", "/css/", "/js/", "/_next/", "/images/", "/img/", "/wp-content/", "/w/", "/style/"];
    const yasakDizin = varlikDizinler.filter(yolYasak);
    if (kokYasak) { skor -= 45; eksiler.push("robots.txt **ana dizini** (`/`) yasaklıyor — robots kutusu işaretliyken kopyalama yapılamaz."); }
    else if (yasakDizin.length) {
      skor -= 15;
      eksiler.push("robots.txt varlık dizinlerini yasaklıyor: `" + yasakDizin.join("`, `") + "` -> CSS/JS/görseller eksik kalır (ör. Wikipedia `/w/` yüzünden stilsiz kopyalanır).");
    } else if (robots.ok) {
      artilar.push("robots.txt engeli yok" + (robots.rules.length ? " (" + robots.rules.length + " kural tarandı, varlık dizinleri açık)" : ""));
    } else {
      notlar.push("robots.txt " + (robots.neden || "okunamadı") + " -> engel sayılmıyor.");
    }

    /* 3) istemci tarafı render (SPA) */
    const spaCati = fw.find(n => /react|next\.?js|vue|nuxt|angular|svelte|ember/.test(n));
    const dugum = c.nodes || 0;
    const script = c.scripts || 0;
    if (spaCati && dugum < 1200) {
      skor -= 25;
      eksiler.push("İçerik istemci tarafında üretiliyor (" + spaCati + ") ve render edilen DOM küçük (" + dugum.toLocaleString("tr-TR") + " düğüm) -> statik kopya boş/eksik görünebilir; kopyalamak için JS çalıştırmayan bir araç yetersiz kalır.");
    } else if (dugum < 120 && script > 3) {
      skor -= 20;
      eksiler.push("Sayfa gövdesi çok küçük (" + dugum + " düğüm) ama " + script + " script var -> içerik büyük olasılıkla JavaScript ile geliyor.");
    } else if (dugum > 400) {
      artilar.push("Sunucudan gelen HTML dolu (" + dugum.toLocaleString("tr-TR") + " düğüm) -> statik kopyada içerik ve stil korunur");
    }

    /* 4) varlık yoğunluğu / boyut */
    const gorsel = c.images || 0, stil = c.stylesheets || 0, api = (d.api || []).length;
    const toplamIstek = net.length;
    if (toplamIstek > 250 || gorsel > 350) {
      skor -= 8;
      notlar.push("Yoğun sayfa (" + toplamIstek + " istek · " + gorsel + " görsel) -> **[∞] Sınırsız kopyala** ile diske akıtma önerilir, normal mod uzun sürebilir.");
    } else if (toplamIstek < 120 && gorsel < 120) {
      artilar.push("Varlık yükü makul (" + toplamIstek + " istek · " + gorsel + " görsel) -> hızlı kopyalanır");
    }
    if (stil === 0 && !spaCati) notlar.push("Harici stil dosyası yok -> görünüm satır içi stillerden geliyor olabilir.");

    /* 5) gömülü çerçeve, form, giriş */
    if ((c.iframes || 0) > 0) notlar.push((c.iframes) + " gömülü çerçeve (iframe) var -> çerçeve içerikleri kopyaya girmez.");
    if ((c.forms || 0) > 0) notlar.push((c.forms) + " form var -> formların çalışması için arka uç gerekir, kopyada işlevsiz kalır.");
    if (api > 0) notlar.push(api + " API çağrısı gözlendi -> dinamik veriler kopyaya dahil olmaz, sayfa statik anlık görüntü olur.");

    /* 6) sayfa sayısı ipucu */
    const icLinkler = (c.links || 0);
    const tahminSayfa = Math.max(1, Math.min(icLinkler, 500));
    if (icLinkler > 800) notlar.push("Çok sayıda bağlantı (" + icLinkler.toLocaleString("tr-TR") + ") -> gerçek site yüzlerce/binlerce sayfa olabilir; sınırsız mod + Durdur ile ilerleyin.");

    skor = Math.max(0, Math.min(100, skor));
    let seviye, etiket, renk, simge;
    if (skor >= 75) { seviye = "uygun"; etiket = "Tam kopyalamaya UYGUN"; renk = "#7dfa9b"; simge = "[✓]"; }
    else if (skor >= 40) { seviye = "kismen"; etiket = "KISMEN uygun"; renk = "#ffd479"; simge = "[!]"; }
    else { seviye = "uygun-degil"; etiket = "Kopyalamaya UYGUN DEĞİL"; renk = "#ff6b5e"; simge = "[x]"; }

    return { seviye, etiket, renk, simge, skor, artilar, eksiler, notlar, tahminSayfa, robots };
  }

  /* Karar kartını analiz görünümünün en üstüne yerleştir */
  async function renderMirrorFit(d) {
    const fit = await mirrorFit(d);
    const satir = (arr, renk, imza) => arr.length
      ? arr.map(x => '<div style="display:flex;gap:8px;margin:6px 0"><span style="color:' + renk + ';flex:0 0 auto">' + imza + '</span><span>' + x.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, '<code class="k">$1</code>') + "</span></div>").join("")
      : "";
    const renk = fit.renk;
    const html =
      '<div class="card" id="fitCard" style="border-left:4px solid ' + renk + '">' +
        '<div class="row" style="align-items:center">' +
          '<h3 style="margin:0">' + fit.simge + ' ' + fit.etiket + '</h3>' +
          '<div class="spacer"></div>' +
          '<span class="hint" title="robots.txt, bot koruması, istemci render ve varlık yükü birlikte değerlendirilir">uygunluk puanı: <b style="color:' + renk + '">' + fit.skor + '/100</b></span>' +
        '</div>' +
        '<div class="sub">Bu sayfa aynı zamanda <b>tam site kopyalama (Tam Ayna)</b> için değerlendirildi: robots.txt kuralları, bot koruması, içeriğin sunucudan mı JavaScript ile mi geldiği ve varlık yükü.</div>' +
        (fit.artilar.length ? '<div style="margin-top:10px">' + satir(fit.artilar, "#7dfa9b", "✓") + "</div>" : "") +
        (fit.eksiler.length ? '<div style="margin-top:10px">' + satir(fit.eksiler, "#ff6b5e", "x") + "</div>" : "") +
        (fit.notlar.length ? '<div style="margin-top:10px">' + satir(fit.notlar, "#a87200", "•") + "</div>" : "") +
        '<div class="row" style="margin-top:14px">' +
          '<button class="btn primary" id="fitUnl">[∞] Bu siteyi sınırsız kopyala</button>' +
          '<button class="btn" id="fitNorm">▶ Sınırlı kopyala</button>' +
          (fit.robots && fit.robots.rules.length ? '<span class="hint">robots.txt okundu: ' + fit.robots.rules.length + ' kural</span>' : "") +
        '</div>' +
      '</div>';

    state.fitOzet = { skor: fit.skor, seviye: fit.seviye, etiket: fit.etiket };
    const body = $("#engineBody");
    if (!body) return fit;
    const eski = $("#fitCard");
    if (eski) eski.outerHTML = html; else body.insertAdjacentHTML("afterbegin", html);
    const git = (unl) => {
      const t = $$("#tabs .tab")[8]; if (t) t.click();
      const u = $("#url"); if (u && !u.value) u.value = state.url;
      mirrorStart(unl);
    };
    const bu = $("#fitUnl"), bn = $("#fitNorm");
    if (bu) bu.onclick = () => git(true);
    if (bn) bn.onclick = () => git(false);
    return fit;
  }
