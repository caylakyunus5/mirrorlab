/* ------------------------------------------------------------------
   MirrorLab — harici arayüz kabuğu (Surge / Hugging Face statik Space)
   ------------------------------------------------------------------
   Arayüz burada, motor ise ayrı bir adreste (Cloudflare Worker ya da kendi
   makineniz) çalışır. Bu betik göreli her isteği/adresi motora çevirir:

     • fetch/XHR            → /api/... istekleri motora gider
     • iframe/img/script/…  → src atamaları motora çevrilir (önizleme çerçevesi!)
     • innerHTML ile eklenen HTML içindeki src="/..." / href="/..." yolları
     • <a href="/..."> tıklamaları
   ------------------------------------------------------------------ */
(function () {
  "use strict";

  var KEY = "ml_api";
  var Q = new URLSearchParams(location.search);
  // Öncelik: ?api=... → tarayıcıda kayıtlı adres → derleme sırasında gömülen varsayılan
  var base = (Q.get("api") || localStorage.getItem(KEY) || window.MIRRORLAB_DEFAULT_API || "")
    .replace(/\/+$/, "");
  if (base) {
    localStorage.setItem(KEY, base);
    window.MIRRORLAB_API = base;   // arayüz apiUrl() yardımcısı bunu okur
  }

  function engineName(x) {
    if (!x) return "?";
    return x.engine_mode || x.engine || (x.edge ? "cloudflare-worker" : "?");
  }
  // "/api/x" → "<motor>/api/x"  (dış adresler, data:, //host, #çapa dokunulmaz)
  function abs(v) {
    if (!base || typeof v !== "string") return v;
    if (v.charAt(0) !== "/" || v.charAt(1) === "/") return v;
    return base + v;
  }

  /* 1) Ağ katmanı */
  var _fetch = window.fetch.bind(window);
  window.fetch = function (u, o) {
    if (typeof u === "string") u = abs(u);
    return _fetch(u, o);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    arguments[1] = abs(u);
    return _open.apply(this, arguments);
  };

  /* 2) Adres taşıyan özellikler: atama anında çevrilir (yarış yok) */
  var PROPS = [
    [window.HTMLImageElement, "src"], [window.HTMLImageElement, "srcset"],
    [window.HTMLIFrameElement, "src"],
    [window.HTMLScriptElement, "src"],
    [window.HTMLSourceElement, "src"], [window.HTMLSourceElement, "srcset"],
    [window.HTMLVideoElement, "src"], [window.HTMLVideoElement, "poster"],
    [window.HTMLAudioElement, "src"],
    [window.HTMLEmbedElement, "src"],
    [window.HTMLObjectElement, "data"],
    [window.HTMLLinkElement, "href"],
    [window.HTMLAnchorElement, "href"],
    [window.HTMLFormElement, "action"],
  ];
  PROPS.forEach(function (pair) {
    var proto = pair[0], prop = pair[1];
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto.prototype, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(proto.prototype, prop, {
      configurable: true, enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) { return d.set.call(this, prop === "srcset" ? fixSrcset(v) : abs(v)); },
    });
  });

  function fixSrcset(v) {
    if (!base || typeof v !== "string") return v;
    return v.split(",").map(function (c) {
      var s = c.trim(); if (!s) return s;
      var sp = s.split(/\s+/);
      return abs(sp[0]) + (sp[1] ? " " + sp[1] : "");
    }).join(", ");
  }

  /* 3) setAttribute yolu (innerHTML dışında kalanlar) */
  var _setAttr = Element.prototype.setAttribute;
  var ATTRS = { src: 1, srcset: 1, href: 1, data: 1, poster: 1, action: 1, "xlink:href": 1 };
  Element.prototype.setAttribute = function (n, v) {
    if (ATTRS[String(n).toLowerCase()]) v = (n.toLowerCase() === "srcset") ? fixSrcset(v) : abs(v);
    return _setAttr.call(this, n, v);
  };

  /* 4) innerHTML/insertAdjacentHTML: metin içindeki göreli adresler */
  function fixMarkup(html) {
    if (!base || typeof html !== "string" || html.indexOf("/") < 0) return html;
    return html.replace(/(\b(?:src|href|data|poster|action|srcset)\s*=\s*["'])\/(?!\/)/gi, "$1" + base + "/");
  }
  ["innerHTML", "outerHTML"].forEach(function (prop) {
    var d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(Element.prototype, prop, {
      configurable: true, enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) { return d.set.call(this, fixMarkup(v)); },
    });
  });
  var _iah = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, html) {
    return _iah.call(this, pos, fixMarkup(html));
  };
  var _wo = window.open;
  window.open = function (u) { return _wo.call(window, abs(u)); };

  /* 5) Emniyet ağı: artık üretilmiş göreli adresler */
  function sweep() {
    if (!base) return;
    var sel = "a[href^='/'],img[src^='/'],iframe[src^='/'],script[src^='/']," +
              "source[src^='/'],video[src^='/'],video[poster^='/'],audio[src^='/']," +
              "link[href^='/'],embed[src^='/'],object[data^='/']";
    document.querySelectorAll(sel).forEach(function (el) {
      ["href", "src", "poster", "data"].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v && v.charAt(0) === "/" && v.charAt(1) !== "/") el.setAttribute(a, base + v);
      });
    });
  }
  if (base) {
    new MutationObserver(sweep).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    setInterval(sweep, 1000);
  }

  /* 6) Ayar paneli (sağ alt) */
  function build() {
    var wrap = document.createElement("div");
    wrap.style.cssText = ["position:fixed", "bottom:14px", "right:14px", "z-index:99999",
      "font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif", "color:#e7eaf3", "max-width:340px"].join(";");
    wrap.innerHTML =
      '<div id="mlPanel" style="display:none;margin-bottom:8px;background:#111827;border:1px solid #313a4d;' +
      'border-radius:14px;padding:12px;box-shadow:0 12px 30px rgba(0,0,0,.45)">' +
      '<div style="font-weight:700;margin-bottom:6px">Motor adresi (arka uç)</div>' +
      '<div style="color:#9aa3b8;margin-bottom:8px">Bu arayüz istemci tarafında çalışır; klonlama/analiz işini motor yapar.</div>' +
      '<input id="mlUrl" placeholder="https://mirrorlab-edge.hesap.workers.dev" ' +
      'style="width:100%;box-sizing:border-box;background:#0b1220;border:1px solid #313a4d;color:#e7eaf3;' +
      'border-radius:9px;padding:8px 10px;font:12px ui-monospace,monospace">' +
      '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
      '<button data-fill="worker" style="cursor:pointer;background:#1f2937;color:#cbd5e1;border:1px solid #374151;border-radius:8px;padding:5px 9px;font-size:12px">Cloudflare Worker…</button>' +
      '<button data-fill="local" style="cursor:pointer;background:#1f2937;color:#cbd5e1;border:1px solid #374151;border-radius:8px;padding:5px 9px;font-size:12px">Kendi makinem</button>' +
      "</div>" +
      '<div style="display:flex;gap:8px;margin-top:10px;align-items:center">' +
      '<button id="mlSave" style="cursor:pointer;background:#059669;color:#fff;border:0;border-radius:9px;padding:8px 14px;font-weight:600">Bağlan</button>' +
      '<button id="mlClear" style="cursor:pointer;background:transparent;color:#9aa3b8;border:1px solid #374151;border-radius:9px;padding:7px 10px">Sıfırla</button>' +
      "</div>" +
      '<div id="mlStat" style="margin-top:9px;font-size:12px;color:#9aa3b8">Durum: bekleniyor</div>' +
      "</div>" +
      '<button id="mlToggle" style="all:unset;cursor:pointer;background:#4f46e5;color:#fff;' +
      'padding:7px 12px;border-radius:999px;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.35);float:right">⚙︎ Arka uç</button>';
    document.body.appendChild(wrap);

    var $ = function (s) { return wrap.querySelector(s); };
    var _f = window.fetch.bind(window);
    $("#mlUrl").value = base;
    $("#mlToggle").onclick = function () {
      var p = $("#mlPanel");
      p.style.display = p.style.display === "none" ? "block" : "none";
    };
    wrap.querySelectorAll("[data-fill]").forEach(function (b) {
      b.onclick = function () {
        $("#mlUrl").value = b.getAttribute("data-fill") === "local"
          ? "http://localhost:8000" : "https://mirrorlab-edge.";
        $("#mlUrl").focus();
      };
    });
    $("#mlSave").onclick = function () {
      var v = ($("#mlUrl").value || "").trim().replace(/\/+$/, "");
      if (v && !/^https?:\/\//i.test(v)) v = "http://" + v;
      localStorage.setItem(KEY, v);
      var st = $("#mlStat");
      st.textContent = "Durum: deneniyor…"; st.style.color = "#9aa3b8";
      _f(v + "/api/health").then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || "sağlık kontrolü başarısız");
        st.innerHTML = "✅ Bağlı · motor: <b>" + engineName(j) + "</b> · sınır: " + (j.rate_limit_per_hour || "?") + "/saat";
        st.style.color = "#34d399";
        setTimeout(function () { location.reload(); }, 700);
      }).catch(function (e) {
        st.innerHTML = "❌ " + e.message + " — adresi ve CORS'u kontrol et.";
        st.style.color = "#f87171";
      });
    };
    $("#mlUrl").onkeydown = function (e) { if (e.key === "Enter") $("#mlSave").click(); };
    $("#mlClear").onclick = function () { localStorage.removeItem(KEY); location.reload(); };

    if (!base) {
      $("#mlPanel").style.display = "block";
      $("#mlStat").textContent = "Durum: motor bağlı değil — adres gir ve Bağlan'a bas.";
    } else {
      _f(base + "/api/health").then(function (r) { return r.json(); }).then(function (j) {
        $("#mlStat").innerHTML = j && j.ok
          ? "✅ Bağlı · motor: <b>" + engineName(j) + "</b>" + (j.deep_analyze ? " · derin analiz açık" : "")
          : "⚠️ Motor yanıt verdi ama sağlık bilgisi okunamadı.";
      }).catch(function () {
        $("#mlStat").textContent = "❌ Motor yanıt vermiyor (kapalı olabilir).";
        $("#mlStat").style.color = "#f87171";
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
