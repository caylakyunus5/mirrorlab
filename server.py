#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MirrorLab — Web Sitesi Tersine Mühendislik / Arşivleme Aracı
Yalnızca Python standart kütüphanesi kullanır (harici bağımlılık yok).

Yetenekler
  * Herhangi bir sayfayı sunucu tarafında çeker, tüm varlık URL'lerini proxy'ler
  * Canlı önizleme (klonlanmış sayfa iframe içinde render edilir)
  * Teknoloji yığını parmak izi, DOM ağacı, varlık envanteri, tasarım token'ları
  * Tek dosya (data-URI gömülü) HTML dışa aktarma
  * Tam site aynası: robots.txt'e uyan, sınırlı BFS tarayıcı -> ZIP indirme

Etik not: Yalnızca kendi sitelerinizde, kamuya açık arşivleme ve öğrenme
amacıyla kullanın. Telif hakkı ve kullanım şartlarına saygı gösterin.
"""

from __future__ import annotations

import base64
import gzip
import shutil
import subprocess
import hashlib
import html as html_mod
import ipaddress
import json
import mimetypes
import os
import posixpath
import re
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

# --------------------------------------------------------------------------
# Ayarlar
# --------------------------------------------------------------------------

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8000"))

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
OUTPUT_DIR = os.path.join(ROOT, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Dağıtım ayarları (ücretsiz barındırma için ortam değişkenleriyle kontrol edilir)
ENGINE_MODE = os.environ.get("MIRRORLAB_ENGINE", "auto").lower()      # auto | on | off
ENGINE_CONCURRENCY = max(1, int(os.environ.get("MIRRORLAB_ENGINE_CONCURRENCY", "1")))
RATE_LIMIT_PER_HOUR = int(os.environ.get("MIRRORLAB_RATE_LIMIT", "40"))   # IP başına; 0 = kapalı
LOW_MEMORY = os.environ.get("MIRRORLAB_LOWMEM", "0") == "1"           # 512 MB'lık planlar için
PUBLIC_MAX_PAGES = int(os.environ.get("MIRRORLAB_MAX_PAGES", "60"))
PUBLIC_MAX_ASSETS = int(os.environ.get("MIRRORLAB_MAX_ASSETS", "400"))
PUBLIC_MAX_MB = int(os.environ.get("MIRRORLAB_MAX_MB", "80"))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
BOT_NAME = "MirrorLabBot"
MAX_BYTES = 8 * 1024 * 1024          # tek dosya için üst sınır
TEXT_MAX = 3 * 1024 * 1024
TIMEOUT = 20
CACHE_MAX_ENTRIES = 240

# Proxy ön eki
ASSET_PATH = "/api/asset"

_SAFE_SCHEMES = ("http://", "https://")
_SKIP_PREFIXES = ("data:", "javascript:", "mailto:", "tel:", "#", "about:",
                  "blob:", "sms:", "whatsapp:", "intent:", "file:", "ftp:")

# --------------------------------------------------------------------------
# Yardımcılar
# --------------------------------------------------------------------------


def norm_url(u: str) -> str:
    u = (u or "").strip()
    if u and not u.startswith(("http://", "https://")):
        u = "https://" + u.lstrip("/")
    return u


def is_http(u: str) -> bool:
    return u.startswith(_SAFE_SCHEMES)


def should_skip(raw: str) -> bool:
    if not raw:
        return True
    return raw.lstrip().lower().startswith(_SKIP_PREFIXES)


def abs_url(base: str, raw: str) -> str:
    try:
        return urljoin(base, raw)
    except Exception:
        return raw


def is_safe_host(host: str) -> bool:
    """SSRF koruması: yerel/tanımlı olmayan ağlara erişimi engelle."""
    host = host.split("@")[-1].split(":")[0].strip("[]")
    if not host:
        return False
    if host.lower() in ("localhost", "localhost.localdomain"):
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local or
                ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def check_url(u: str) -> str | None:
    """Güvenli değilse hata mesajı döndürür."""
    p = urlsplit(u)
    if p.scheme not in ("http", "https"):
        return "Sadece http/https adresleri destekleniyor."
    if not p.hostname:
        return "Geçersiz adres."
    if not is_safe_host(p.hostname):
        return "Bu adres güvenlik nedeniyle reddedildi (yerel/özel ağ)."
    return None


# --------------------------------------------------------------------------
# HTTP istemcisi
# --------------------------------------------------------------------------

_CTX = None


def ssl_ctx():
    global _CTX
    if _CTX is None:
        _CTX = __import__("ssl").create_default_context()
        _CTX.check_hostname = False
        _CTX.verify_mode = __import__("ssl").CERT_NONE
    return _CTX


class FetchResult:
    __slots__ = ("ok", "status", "headers", "body", "final_url", "error", "ctype")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


def ascii_url(u: str) -> str:
    """IRI → URI: ASCII dışı karakterleri yüzde-kodlar.

    http.client istek satırını ASCII ile kurar; bu yüzden "/wiki/Türkiye" gibi
    adresler UnicodeEncodeError veriyordu. Yüzde kaçışları ve rezerve karakterler
    korunur, yalnızca ASCII dışı baytlar UTF-8 olarak kodlanır.
    """
    if not u:
        return u
    try:
        u.encode("ascii")
        return u
    except UnicodeEncodeError:
        return quote(u, safe=":/?#[]@!$&'()*+,;=%~")


class _AsciiRedirect(urllib.request.HTTPRedirectHandler):
    """Yönlendirme hedefi de ASCII dışıysa onu da normalize eder."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, ascii_url(newurl))


# SSL bağlamı HTTPSHandler üzerinden verilir (urlopen'ın `context` parametresi
# OpenerDirector.open()'da yoktur).
_OPENER = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ssl_ctx()),
    _AsciiRedirect,
)


def fetch(url: str, referer: str | None = None, max_bytes: int = MAX_BYTES,
          method: str = "GET") -> FetchResult:
    """URL'yi çeker. Yönlendirmeleri takip eder, gzip/deflate açar."""
    if not is_http(url):
        return FetchResult(ok=False, error="desteklenmeyen şema", status=0)
    headers = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "close",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(ascii_url(url), headers=headers, method=method)
    try:
        with _OPENER.open(req, timeout=TIMEOUT) as r:
            raw = b"" if method == "HEAD" else r.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raw = raw[:max_bytes]
            enc = (r.headers.get("Content-Encoding") or "").lower()
            if enc == "gzip":
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            elif enc == "deflate":
                try:
                    raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                except Exception:
                    try:
                        raw = zlib.decompress(raw)
                    except Exception:
                        pass
            hdrs = {k.lower(): v for k, v in r.headers.items()}
            return FetchResult(ok=True, status=r.status, headers=hdrs, body=raw,
                               final_url=r.geturl(),
                               ctype=(hdrs.get("content-type") or "").split(";")[0].strip())
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read(max_bytes)
        except Exception:
            pass
        hdrs = {k.lower(): v for k, v in (e.headers or {}).items()}
        return FetchResult(ok=False, status=e.code, headers=hdrs, body=body,
                           final_url=url, error=f"HTTP {e.code}",
                           ctype=(hdrs.get("content-type") or "").split(";")[0].strip())
    except Exception as e:
        return FetchResult(ok=False, status=0, headers={}, body=b"",
                           final_url=url, error=f"{type(e).__name__}: {e}", ctype="")


def fetch_text(url: str, referer=None, max_bytes=TEXT_MAX) -> str:
    r = fetch(url, referer=referer, max_bytes=max_bytes)
    if not r.ok and not r.body:
        return ""
    return decode(r.body, r.headers.get("content-type", ""))


def decode(body: bytes, ctype: str = "") -> str:
    m = re.search(r"charset=([\w\-]+)", ctype or "", re.I)
    cands = []
    if m:
        cands.append(m.group(1))
    head = body[:4096].decode("latin-1", "ignore")
    m2 = re.search(r'charset=["\']?([\w\-]+)', head, re.I)
    if m2:
        cands.append(m2.group(1))
    cands += ["utf-8", "cp1254", "iso-8859-9", "latin-1"]
    for c in cands:
        try:
            return body.decode(c)
        except Exception:
            continue
    return body.decode("utf-8", "replace")


# --------------------------------------------------------------------------
# Önbellek
# --------------------------------------------------------------------------

_CACHE: dict[str, tuple[float, FetchResult]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 600


def cached_fetch(url: str, referer=None, max_bytes=MAX_BYTES) -> FetchResult:
    key = f"{url}\x00{referer or ''}"
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1]
    res = fetch(url, referer=referer, max_bytes=max_bytes)
    with _CACHE_LOCK:
        if len(_CACHE) > CACHE_MAX_ENTRIES:
            for k in sorted(_CACHE, key=lambda k: _CACHE[k][0])[:60]:
                _CACHE.pop(k, None)
        _CACHE[key] = (now, res)
    return res


# --------------------------------------------------------------------------
# Resolver'lar (URL -> yeni URL)
# --------------------------------------------------------------------------

def proxy_url(target: str, page: str = "", raw: bool = False) -> str:
    q = f"u={quote(target, safe='')}"
    if page:
        q += f"&r={quote(page, safe='')}"
    if raw:
        q += "&raw=1"
    return f"{ASSET_PATH}?{q}"


class Resolver:
    """kind -> dönüşüm stratejisi. Alt sınıflar resolve() uygular."""

    def resolve(self, raw: str, base: str, kind: str, tag: str = "") -> str:
        return raw


class PreviewResolver(Resolver):
    """Varlıkları proxy'ye yönlendir; navigasyon linklerini mutlak bırak."""

    def __init__(self, page_url: str, proxy: bool = True):
        self.page = page_url
        self.proxy = proxy

    def resolve(self, raw, base, kind, tag=""):
        if should_skip(raw):
            return raw
        target = abs_url(base, raw)
        if not is_http(target):
            return raw
        if kind in ("nav", "form"):
            return target
        if not self.proxy:
            return target
        return proxy_url(target, self.page)


class AbsoluteResolver(Resolver):
    """Her şeyi mutlak URL yap (indirilen dosya çevrimdışı olmasa da çalışsın)."""

    def resolve(self, raw, base, kind, tag=""):
        if should_skip(raw):
            return raw
        t = abs_url(base, raw)
        return t if is_http(t) else raw


# --------------------------------------------------------------------------
# HTML yeniden yazıcı
# --------------------------------------------------------------------------

RES_ATTRS = {
    "img": ("src", "data-src", "data-lazy-src", "data-original", "data-srcset"),
    "source": ("src", "data-src"),
    "script": ("src",),
    "video": ("src", "poster"),
    "audio": ("src",),
    "embed": ("src",),
    "object": ("data",),
    "track": ("src",),
    "input": ("src",),
    "body": ("background",),
    "table": ("background",),
    "td": ("background",),
    "image": ("href", "xlink:href"),
    "use": ("href", "xlink:href"),
}

LINK_RELS = ("stylesheet", "icon", "shortcut icon", "apple-touch-icon",
             "preload", "prefetch", "manifest", "mask-icon", "dns-prefetch")

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
             "meta", "param", "source", "track", "wbr", "basefont", "isindex"}


class HtmlRewriter(HTMLParser):
    """HTML'i ayrıştırıp URL'leri yeniden yazan tek geçişli yeniden üretici."""

    def __init__(self, base_url: str, resolver: Resolver, cfg: dict | None = None):
        super().__init__(convert_charrefs=False)
        self.base = base_url
        self.res = resolver
        self.cfg = cfg or {}
        self.out: list[str] = []
        self.stack: list[str] = []
        self.base_tag_used = False
        self.suppressed = 0          # <script> içeriğini atlarken >0
        self.pending_strip = 0       # kaldırılan script etiketi sayacı

    # ---- yardımcı ----
    def _attr(self, tag, attrs, name):
        for k, v in attrs:
            if k == name:
                return v
        return None

    def _rewrite_srcset(self, value, base):
        parts = []
        for item in value.split(","):
            item = item.strip()
            if not item:
                continue
            bits = item.split(None, 1)
            u = bits[0]
            desc = bits[1] if len(bits) > 1 else ""
            nu = self.res.resolve(u, base, "img", "srcset")
            parts.append((nu + (" " + desc if desc else "")).strip())
        return ", ".join(parts)

    def _rewrite_css_text(self, text, base):
        def u_sub(m):
            val = m.group(2).strip()
            if should_skip(val):
                return m.group(0)
            return f"url({m.group(1)}{self.res.resolve(val, base, 'asset', 'css')}{m.group(1)})"

        text = re.sub(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", u_sub, text, flags=re.I)

        def i_sub(m):
            val = m.group(2).strip()
            if should_skip(val):
                return m.group(0)
            return f"@import {m.group(1)}{self.res.resolve(val, base, 'css', 'css')}{m.group(1)}"

        text = re.sub(r"@import\s+(['\"])([^'\"]+)\1", i_sub, text, flags=re.I)
        return text

    # ---- olaylar ----
    def handle_decl(self, decl):
        self.out.append(f"<!{decl}>")

    def handle_comment(self, data):
        self.out.append(f"<!--{data}-->")

    def handle_pi(self, data):
        self.out.append(f"<?{data}>")

    def unknown_decl(self, data):
        self.out.append(f"<![{data}]>")

    def handle_entityref(self, name):
        if self.suppressed:
            return
        self.out.append(f"&{name};")

    def handle_charref(self, name):
        if self.suppressed:
            return
        self.out.append(f"&#{name};")

    def handle_data(self, data):
        if self.suppressed:
            return
        if self.stack and self.stack[-1] == "style":
            data = self._rewrite_css_text(data, self.base)
        self.out.append(data)

    def handle_startendtag(self, tag, attrs):
        self.out.append(self._render(tag, attrs, True))

    def handle_starttag(self, tag, attrs):
        if self.cfg.get("strip_scripts") and tag == "script":
            self.pending_strip += 1
            self.suppressed += 1
            if tag not in VOID_TAGS:
                self.stack.append(tag)
            return
        if tag not in VOID_TAGS:
            self.stack.append(tag)
        self.out.append(self._render(tag, attrs, tag in VOID_TAGS))

    def handle_endtag(self, tag):
        if tag == "script" and self.pending_strip > 0:
            self.pending_strip -= 1
            self.suppressed = max(0, self.suppressed - 1)
            if tag in self.stack:
                while self.stack and self.stack.pop() != tag:
                    pass
            return
        if self.suppressed:
            return
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass
        self.out.append(f"</{tag}>")

    # ---- asıl iş ----
    def _render(self, tag, attrs, self_closing):
        new_attrs: list[tuple[str, str | None]] = []
        rel = (self._attr(tag, attrs, "rel") or "").lower()
        itemtype = (self._attr(tag, attrs, "type") or "").lower()

        # <base> etiketini yok say (tüm URL'leri biz mutlaklaştırıyoruz)
        if tag == "base":
            self.base_tag_used = True
            return "<!-- base kaldırıldı -->"

        for name, value in attrs:
            lname = name.lower()
            if lname in ("integrity", "nonce"):
                continue
            if lname == "crossorigin":
                continue
            if value is None:
                new_attrs.append((name, None))
                continue

            if lname == "style":
                value = self._rewrite_css_text(value, self.base)
            elif lname == "srcset" or lname == "data-srcset":
                value = self._rewrite_srcset(value, self.base)
            elif lname == "href" and tag == "a":
                if not should_skip(value):
                    value = self.res.resolve(value, self.base, "nav", tag)
            elif lname == "href" and tag == "area":
                if not should_skip(value):
                    value = self.res.resolve(value, self.base, "nav", tag)
            elif lname == "href" and tag == "link":
                if "stylesheet" in rel or "icon" in rel or "preload" in rel or \
                        "manifest" in rel or "prefetch" in rel or "apple-touch" in rel:
                    if not should_skip(value):
                        kind = "css" if "stylesheet" in rel else "asset"
                        value = self.res.resolve(value, self.base, kind, tag)
            elif lname == "href" and tag == "link":
                # diğer rel türleri (canonical, alternate, rss...) mutlak kalsın
                if not should_skip(value):
                    av = abs_url(self.base, value)
                    value = av if is_http(av) else value
            elif lname == "href" and tag in ("use", "image"):
                if tag != "a" and not should_skip(value):
                    value = self.res.resolve(value, self.base, "asset", tag)
            elif lname in RES_ATTRS.get(tag, ()):
                if not should_skip(value):
                    kind = "js" if tag == "script" else ("img" if tag in ("img", "source", "image") else "asset")
                    value = self.res.resolve(value, self.base, kind, tag)
            elif lname == "action" and tag == "form":
                if not should_skip(value):
                    value = self.res.resolve(value, self.base, "form", tag)
            elif lname == "poster":
                if not should_skip(value):
                    value = self.res.resolve(value, self.base, "img", tag)
            elif lname == "value" and tag == "param" and \
                    (self._attr(tag, attrs, "name") or "").lower() in ("movie", "src", "url"):
                if not should_skip(value):
                    value = self.res.resolve(value, self.base, "asset", tag)
            new_attrs.append((name, value))

        # <script type="module"> için import haritası desteği kalsın
        if tag == "script" and itemtype == "module":
            pass

        parts = [tag]
        for k, v in new_attrs:
            if v is None:
                parts.append(k)
            else:
                parts.append(f'{k}="{html_mod.escape(v, quote=True)}"')
        inner = " ".join(parts)
        return f"<{inner}/>" if self_closing else f"<{inner}>"

    def result(self) -> str:
        return "".join(self.out)


def rewrite_html(html: str, base_url: str, resolver: Resolver, cfg=None) -> str:
    r = HtmlRewriter(base_url, resolver, cfg)
    try:
        r.feed(html)
        r.close()
    except Exception:
        return html
    return r.result()


# --------------------------------------------------------------------------
# CSS / JS yeniden yazma (proxy üzerinden sunulurken)
# --------------------------------------------------------------------------

def rewrite_css(text: str, base_url: str, resolver: Resolver) -> str:
    def u_sub(m):
        val = m.group(2).strip()
        if should_skip(val):
            return m.group(0)
        return f"url({m.group(1)}{resolver.resolve(val, base_url, 'asset', 'css')}{m.group(1)})"
    text = re.sub(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", u_sub, text, flags=re.I)

    def i_sub(m):
        val = m.group(2).strip()
        if should_skip(val):
            return m.group(0)
        return f"@import {m.group(1)}{resolver.resolve(val, base_url, 'css', 'css')}{m.group(1)}"
    text = re.sub(r"@import\s+(['\"])([^'\"]+)\1", i_sub, text, flags=re.I)
    return text


_JS_SPEC = re.compile(r"(\bfrom\s*|\bimport\s*\(?\s*|new\s+URL\s*\(\s*)(['\"])([^'\"\n]{1,400})\2")


def rewrite_js(text: str, base_url: str, resolver: Resolver) -> str:
    def sub(m):
        pre, q, spec = m.group(1), m.group(2), m.group(3)
        if not spec.startswith(("./", "../", "/")):
            return m.group(0)
        nu = resolver.resolve(spec, base_url, "js", "js")
        return f"{pre}{q}{nu}{q}"
    try:
        return _JS_SPEC.sub(sub, text)
    except Exception:
        return text


# --------------------------------------------------------------------------
# İçerik tipi yardımcıları
# --------------------------------------------------------------------------

def guess_kind(ctype: str, url: str) -> str:
    c = (ctype or "").split(";")[0].strip().lower()
    if "css" in c or url.lower().endswith(".css"):
        return "css"
    if "javascript" in c or "ecmascript" in c or url.lower().endswith(".js"):
        return "js"
    if c.startswith("image/") or re.search(r"\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$", url, re.I):
        return "img"
    if "font" in c or re.search(r"\.(woff2?|ttf|otf|eot)$", url, re.I):
        return "font"
    if "video" in c or "audio" in c:
        return "media"
    if "html" in c:
        return "doc"
    return "other"


EXT_KIND = {"css": "css", "js": "js", "img": "img", "font": "font",
            "media": "media", "doc": "doc", "other": "asset"}

# --------------------------------------------------------------------------
# Analiz
# --------------------------------------------------------------------------


class OutlineParser(HTMLParser):
    """DOM iskeleti + envanter + başlıklar + formlar + meta."""

    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.root = {"tag": "#document", "children": []}
        self.stack = [self.root]
        self.depth = 0
        self.meta = {}
        self.og = {}
        self.headings = []
        self.forms = []
        self.assets = []
        self.counts = {"nodes": 0, "scripts": 0, "stylesheets": 0, "images": 0,
                       "links": 0, "iframes": 0, "videos": 0, "inline_style_bytes": 0,
                       "inline_script_bytes": 0, "classes": 0}
        self.links_internal = 0
        self.links_external = 0
        self.link_sample = []
        self._in_title = False
        self._in_style = False
        self._in_script = False
        self._buf = []
        self._cur_form = None
        self.cur_text_node = None

    # -- içerik --
    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        self.counts["nodes"] += 1
        node = {"tag": tag, "children": []}
        if a.get("id"):
            node["id"] = a["id"][:60]
        if a.get("class"):
            self.counts["classes"] += 1
            cl = [c for c in a["class"].split() if c][:4]
            if cl:
                node["class"] = " ".join(cl)
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            node["heading"] = True
            node["_hlevel"] = int(tag[1])
            self.headings.append({"level": int(tag[1]), "text": ""})
            node["_hidx"] = len(self.headings) - 1
        if tag == "a" and a.get("href"):
            self.counts["links"] += 1
            absu = abs_url(self.base, a["href"])
            if urlsplit(absu).netloc == urlsplit(self.base).netloc:
                self.links_internal += 1
            else:
                self.links_external += 1
            if len(self.link_sample) < 60:
                self.link_sample.append({"href": absu, "text": ""})
                node["_lidx"] = len(self.link_sample) - 1
        elif tag == "img":
            self.counts["images"] += 1
            src = a.get("src") or a.get("data-src") or a.get("data-lazy-src") or ""
            self.assets.append({"type": "img", "url": abs_url(self.base, src) if src else "",
                                "tag": "img", "alt": a.get("alt", "")[:80]})
        elif tag == "link":
            rel = a.get("rel", "").lower()
            if "stylesheet" in rel:
                self.counts["stylesheets"] += 1
                if a.get("href"):
                    self.assets.append({"type": "css", "url": abs_url(self.base, a["href"]),
                                        "tag": "link", "rel": rel})
            elif "icon" in rel:
                if a.get("href"):
                    self.assets.append({"type": "img", "url": abs_url(self.base, a["href"]),
                                        "tag": "link", "rel": rel})
        elif tag == "script":
            self.counts["scripts"] += 1
            if a.get("src"):
                self.assets.append({"type": "js", "url": abs_url(self.base, a["src"]),
                                    "tag": "script",
                                    "module": "module" in a.get("type", "").lower(),
                                    "async": "async" in a, "defer": "defer" in a})
        elif tag == "iframe":
            self.counts["iframes"] += 1
            if a.get("src"):
                node["src"] = a["src"][:120]
                u = abs_url(self.base, a["src"])
                if is_http(u):
                    self.assets.append({"type": "iframe", "url": u, "tag": "iframe"})
        elif tag in ("video", "audio"):
            self.counts["videos"] += 1
            if a.get("src"):
                u = abs_url(self.base, a["src"])
                if is_http(u):
                    self.assets.append({"type": "video" if tag == "video" else "audio", "url": u, "tag": tag})
        elif tag == "source":
            if a.get("src"):
                u = abs_url(self.base, a["src"])
                if is_http(u):
                    self.assets.append({"type": "media", "url": u, "tag": "source"})
        elif tag == "style":
            self._in_style = True
            self._buf = []
        elif tag == "script":
            pass
        elif tag == "title":
            self._in_title = True
            self._buf = []
        elif tag == "form":
            self._cur_form = {"action": a.get("action", ""), "method": (a.get("method") or "GET").upper(),
                              "inputs": []}
        elif tag in ("input", "select", "textarea", "button") and self._cur_form is not None:
            self._cur_form["inputs"].append({
                "tag": tag, "type": a.get("type", ""), "name": a.get("name", ""),
                "placeholder": a.get("placeholder", "")[:60]})
        # meta
        if tag == "meta":
            name = (a.get("name") or a.get("property") or "").lower()
            content = a.get("content", "")
            if name in ("description", "keywords", "generator", "author", "viewport",
                        "theme-color", "robots", "application-name"):
                self.meta[name] = content[:400]
            if name.startswith("og:") or name.startswith("twitter:"):
                self.og[name] = content[:200]
        if tag == "html" and a.get("lang"):
            self.meta["lang"] = a["lang"]

        # ağaca ekle
        if self.stack:
            self.stack[-1]["children"].append(node)
        self.stack.append(node)
        self.cur_text_node = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "style" and self._in_style:
            self._in_style = False
            self.counts["inline_style_bytes"] += len("".join(self._buf))
            self._buf = []
        if tag == "title" and self._in_title:
            self._in_title = False
            self.meta["title"] = "".join(self._buf).strip()[:300]
            self._buf = []
        if tag == "form" and self._cur_form:
            self.forms.append(self._cur_form)
            self._cur_form = None
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self._in_title or self._in_style:
            self._buf.append(data)
            return
        node = self.stack[-1] if self.stack else None
        if not node:
            return
        if node.get("_hidx") is not None and len(self.headings[node["_hidx"]]["text"]) < 120:
            self.headings[node["_hidx"]]["text"] += data.strip() + " "
        if node.get("_lidx") is not None and len(self.link_sample[node["_lidx"]]["text"]) < 90:
            self.link_sample[node["_lidx"]]["text"] += data.strip() + " "
        t = data.strip()
        if t and node.get("tag") not in ("script", "style"):
            if node.get("text") is None or len(node.get("text", "")) < 70:
                node["text"] = (node.get("text", "") + " " + t)[:70]


# --------------------------------------------------------------------------
# Teknoloji parmak izi
# --------------------------------------------------------------------------

TECH_RULES = [
    # (isim, kategori, regex, kaynak: html|headers|cookies)
    ("WordPress", "CMS", r"wp-content|wp-includes|wp-json", "html"),
    ("WooCommerce", "E-ticaret", r"woocommerce|wc-ajax", "html"),
    ("Elementor", "Sayfa Kurucu", r"elementor", "html"),
    ("Shopify", "E-ticaret", r"cdn\.shopify\.com|shopify\.theme|myshopify\.com", "html"),
    ("Wix", "Site Kurucu", r"static\.parastorage\.com|wixstatic\.com|wix-code", "html"),
    ("Squarespace", "Site Kurucu", r"static1?\.squarespace\.com|sqsp\.net|squarespace-cdn", "html"),
    ("Webflow", "Site Kurucu", r"data-wf-page|data-wf-site|assets\.website-files\.com|webflow\.io", "html"),
    ("Next.js", "JS Çatı", r"__NEXT_DATA__|/_next/static|next/dist", "html"),
    ("Nuxt", "JS Çatı", r"__NUXT__|/_nuxt/", "html"),
    ("Gatsby", "JS Çatı", r"___gatsby|gatsby-", "html"),
    ("SvelteKit", "JS Çatı", r"__sveltekit|_app/immutable", "html"),
    ("Astro", "JS Çatı", r"astro-island|data-astro-", "html"),
    ("Angular", "JS Çatı", r"ng-version|ng-app|angular(\.min)?\.js|_ngcontent", "html"),
    ("React", "JS Kütüphanesi", r"react(-dom)?(\.production\.min|\.development)?\.js|data-reactroot|__REACT", "html"),
    ("Vue.js", "JS Kütüphanesi", r"vue(\.runtime)?(\.min)?\.js|data-v-[0-9a-f]{8}|__VUE__", "html"),
    ("jQuery", "JS Kütüphanesi", r"jquery[.\-]?([\d.]+)?(\.min)?\.js|\$\.ajax", "html"),
    ("Bootstrap", "CSS Çatı", r"bootstrap(\.bundle)?(\.min)?\.(css|js)|col-(xs|sm|md|lg|xl)-\d", "html"),
    ("Tailwind CSS", "CSS Çatı", r"tailwindcss|tailwind\.config|\b(sm|md|lg|xl|2xl):(flex|grid|hidden|w-|p-|m-|text-|gap-)|\b(dark|hover|focus|group-hover):(bg|text|border|ring|scale)-|\bshrink-0\b|\bspace-x-\d|\bring-offset-\d|\bw-fit\b", "html"),
    ("Bulma", "CSS Çatı", r"bulma(\.min)?\.css", "html"),
    ("Font Awesome", "İkon", r"font-?awesome|fa-(\w+)|cdnjs[^\"]*font-awesome", "html"),
    ("Google Fonts", "Yazı Tipi", r"fonts\.googleapis\.com|fonts\.gstatic\.com", "html"),
    ("Google Analytics (GA4)", "Analitik", r"googletagmanager\.com/gtag|gtag\(.config.,.?\s*.G-[A-Z0-9]{6,}", "html"),
    ("Google Tag Manager", "Etiket Yöneticisi", r"googletagmanager\.com/gtm\.js|GTM-[A-Z0-9]+", "html"),
    ("Facebook Pixel", "Pazarlama", r"connect\.facebook\.net/[^\"]*fbevents", "html"),
    ("Hotjar", "Analitik", r"static\.hotjar\.com|hjSiteSettings", "html"),
    ("Cloudflare", "CDN / Güvenlik", r"cloudflare|cf-ray", "headers"),
    ("Cloudflare Turnstile", "Bot Koruması", r"challenges\.cloudflare\.com", "html"),
    ("reCAPTCHA", "Bot Koruması", r"google\.com/recaptcha|gstatic\.com/recaptcha", "html"),
    ("hCaptcha", "Bot Koruması", r"hcaptcha\.com", "html"),
    ("Vercel", "Barındırma", r"vercel", "headers"),
    ("Netlify", "Barındırma", r"netlify", "headers"),
    ("GitHub Pages", "Barındırma", r"\.github\.io/|pages\.github\.com|\.github\.io\"", "headers"),
    ("Nginx", "Sunucu", r"nginx", "headers"),
    ("Apache", "Sunucu", r"apache", "headers"),
    ("LiteSpeed", "Sunucu", r"litespeed", "headers"),
    ("IIS", "Sunucu", r"microsoft-iis", "headers"),
    ("ASP.NET", "Çatı", r"asp\.net|__VIEWSTATE|aspnet", "html"),
    ("Django", "Çatı", r"csrfmiddlewaretoken", "html"),
    ("Laravel", "Çatı", r"laravel_session|XSRF-TOKEN", "headers_cookies"),
    ("Ruby on Rails", "Çatı", r"_rails|authenticity_token", "html"),
    ("Discourse", "Forum", r"discourse-|/discourse/|\.discourse\.(org|group)", "html"),
    ("Ghost", "Blog", r"ghost-content|/ghost/|ghost\.(io|org)/|content-api", "html"),
    ("Joomla", "CMS", r"/components/com_|/media/system/js/|option=com_", "html"),
    ("Drupal", "CMS", r"Drupal\.settings|/sites/(all|default)/files/|drupal\.js|data-drupal", "html"),
    ("Magento", "E-ticaret", r"Magento_|/static/version\d+/|mage/cookies|skin/frontend/|mage/requirejs", "html"),
    ("PrestaShop", "E-ticaret", r"prestashop|modules/ps_", "html"),
    ("Open Graph", "Meta", r'property="og:', "html"),
    ("PWA / Manifest", "Web App", r'rel="manifest"', "html"),
    ("Service Worker", "Web App", r"serviceWorker\.register", "html"),
    ("AMP", "Performans", r"cdn\.ampproject\.org|<html[^>]*\samp[\s>]", "html"),
]

HEADER_TECH = {
    "server": [("Nginx", r"nginx"), ("Apache", r"apache"), ("LiteSpeed", r"litespeed"),
               ("IIS", r"microsoft-iis"), ("Caddy", r"caddy"), ("Cloudflare", r"cloudflare"),
               ("Amazon S3", r"amazons3"), ("Gunicorn", r"gunicorn"), ("Werkzeug", r"werkzeug"),
               ("Deno", r"deno"), ("Tomcat", r"tomcat"), ("OpenResty", r"openresty")],
    "x-powered-by": [("PHP", r"php"), ("Express", r"express"), ("ASP.NET", r"asp\.net"),
                     ("Next.js", r"next\.js"), ("Nuxt", r"nuxt")],
    "x-generator": [("Drupal", r"drupal"), ("WordPress", r"wordpress"), ("Ghost", r"ghost"),
                    ("Hugo", r"hugo"), ("Jekyll", r"jekyll")],
    "x-vercel-id": [("Vercel", r".+")],
    "x-amz-cf-id": [("Cloudflare", r".+")],
    "x-github-request-id": [("GitHub", r".+")],
    "x-shopify-stage": [("Shopify", r".+")],
    "x-drupal-cache": [("Drupal", r".+")],
    "x-litespeed-cache": [("LiteSpeed", r".+")],
    "cf-cache-status": [("Cloudflare", r".+")],
    "x-nextjs-cache": [("Next.js", r".+")],
}


def detect_tech(html: str, headers: dict, cookies: str = "") -> list[dict]:
    found: dict[str, dict] = {}
    low_html = html[:900_000]
    hay_low = low_html.lower()

    for name, cat, pat, src in TECH_RULES:
        try:
            if src in ("headers", "headers_cookies"):
                blob = " ".join(f"{k}: {v}" for k, v in headers.items()) + " " + cookies
            else:
                blob = hay_low
            m = re.search(pat, blob, re.I)
            if m:
                ev = m.group(0)[:60].replace("\n", " ")
                found.setdefault(name, {"name": name, "category": cat,
                                        "confidence": "yüksek" if src == "html" else "orta",
                                        "evidence": ev})
        except re.error:
            continue

    for h, rules in HEADER_TECH.items():
        v = headers.get(h)
        if not v:
            continue
        for name, pat in rules:
            if re.search(pat, v, re.I):
                found.setdefault(name, {"name": name, "category": "Sunucu/Altyapı",
                                        "confidence": "yüksek",
                                        "evidence": f"{h}: {v[:70]}"})

    # html içinde bulunmayan başlık kanıtları için güven derecesi
    return sorted(found.values(), key=lambda x: (x["category"], x["name"]))


# --------------------------------------------------------------------------
# Tasarım token'ları (renk + font çıkarımı)
# --------------------------------------------------------------------------

COLOR_RE = re.compile(r"#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\([^)]{5,40}\)|hsla?\([^)]{5,40}\)", re.I)
FONT_RE = re.compile(r"font-family\s*:\s*([^;}\n]{2,160})", re.I)
FONT_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+\.(?:woff2?|ttf|otf|eot))", re.I)


def extract_design(html: str, css_texts: list[str]) -> dict:
    blob = "\n".join(css_texts) + "\n" + "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", html, re.S | re.I))
    colors: dict[str, int] = {}
    for m in COLOR_RE.finditer(blob[:600_000]):
        c = m.group(0).lower().replace(" ", "")
        colors[c] = colors.get(c, 0) + 1
    fonts: dict[str, int] = {}
    for m in FONT_RE.finditer(blob[:600_000]):
        f = m.group(1).strip().split(",")[0].strip().strip('"\'')
        if f and not f.startswith("var("):
            fonts[f] = fonts.get(f, 0) + 1
    font_files = []
    for m in FONT_URL_RE.finditer(html[:400_000]):
        font_files.append(m.group(1))
    top_colors = sorted(colors.items(), key=lambda x: -x[1])[:12]
    return {
        "colors": [{"value": c, "count": n} for c, n in top_colors],
        "fonts": [{"family": f, "count": n} for f, n in
                  sorted(fonts.items(), key=lambda x: -x[1])[:8]],
        "font_files": font_files[:12],
        "css_bytes": sum(len(t) for t in css_texts),
        "inline_style_bytes": len("".join(re.findall(r"<style[^>]*>(.*?)</style>", html, re.S | re.I))),
    }


# --------------------------------------------------------------------------
# robots.txt
# --------------------------------------------------------------------------

_ROBOTS_CACHE: dict[str, list[dict]] = {}
_ROBOTS_LOCK = threading.Lock()


def robots_groups(host_root: str) -> list[dict]:
    with _ROBOTS_LOCK:
        if host_root in _ROBOTS_CACHE:
            return _ROBOTS_CACHE[host_root]
    txt = fetch_text(host_root + "/robots.txt", max_bytes=300_000)
    groups: list[dict] = []
    for block in re.split(r"\n\s*\n", txt or ""):
        agents, rules = [], []
        for line in block.splitlines():
            line = line.split("#")[0].strip()
            if not line or ":" not in line:
                continue
            k, v = line.split(":", 1)
            k, v = k.strip().lower(), v.strip()
            if k == "user-agent":
                agents.append(v.lower())
            elif k in ("allow", "disallow"):
                rules.append((k, v))
        if agents:
            groups.append({"agents": agents, "rules": rules})
    with _ROBOTS_LOCK:
        _ROBOTS_CACHE[host_root] = groups
    return groups


def robots_allows(url: str, ua: str = BOT_NAME) -> bool:
    p = urlsplit(url)
    root = f"{p.scheme}://{p.netloc}"
    groups = robots_groups(root)
    if not groups:
        return True
    ua_l = ua.lower()
    applicable = []
    for g in groups:
        for a in g["agents"]:
            if a == "*" or a in ua_l or ua_l in a:
                applicable.append(g)
                break
    if not applicable:
        return True
    path = p.path or "/"
    if p.query:
        path += "?" + p.query
    best = None  # (uzunluk, allow?)
    for g in applicable:
        for kind, pref in g["rules"]:
            if pref == "":
                if kind == "disallow":
                    continue
                continue
            if path.startswith(pref):
                cand = (len(pref), kind == "allow")
                if best is None or cand[0] > best[0]:
                    best = cand
    return True if best is None else best[1]


# --------------------------------------------------------------------------
# Analiz motoru
# --------------------------------------------------------------------------

def analyze(url: str, deep: bool = True) -> dict:
    err = check_url(url)
    if err:
        return {"ok": False, "error": err}
    t0 = time.time()
    res = fetch(url)
    if not res.body:
        return {"ok": False, "error": res.error or "Sayfa alınamadı",
                "status": res.status}
    html = decode(res.body, res.headers.get("content-type", ""))
    final = res.final_url or url

    p = OutlineParser(final)
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass

    css_texts: list[str] = []
    if deep:
        budget = time.time() + 8
        for a in [x for x in p.assets if x["type"] == "css"][:6]:
            if time.time() > budget:
                break
            t = fetch_text(a["url"], referer=final, max_bytes=1_200_000)
            if t:
                css_texts.append(t)

    tech = detect_tech(html, res.headers)
    design = extract_design(html, css_texts)

    # varlık listesi temizle
    seen = set()
    assets = []
    for a in p.assets:
        u = a.get("url", "")
        key = (a["type"], u)
        if not u or not is_http(u) or key in seen:
            continue
        seen.add(key)
        assets.append(a)

    counts = dict(p.counts)
    counts["html_bytes"] = len(res.body)
    counts["css_bytes"] = design["css_bytes"]
    counts["assets_total"] = len(assets)
    counts["asset_types"] = {
        t: sum(1 for a in assets if a["type"] == t)
        for t in ("css", "js", "img", "font", "media")
    }
    counts["external_links"] = p.links_external
    counts["internal_links"] = p.links_internal

    # ağaç derinliği/boyutu buda
    budget = {"n": 1500}

    def prune(node, depth=0):
        budget["n"] -= 1
        if budget["n"] <= 0:
            return {"tag": "… (kısaltıldı)"}
        out = {"tag": node.get("tag")}
        for k in ("id", "class", "text", "src", "heading"):
            if node.get(k):
                out[k] = node[k]
        kids = node.get("children") or []
        if depth < 7 and budget["n"] > 0:
            out["children"] = [prune(c, depth + 1) for c in kids[:14]]
            if len(kids) > 14:
                out["children"].append({"tag": f"... +{len(kids)-14} kardeş"})
        else:
            out["children"] = []
        return out

    outline = prune(p.root)
    return {
        "ok": True,
        "url": url,
        "final_url": final,
        "status": res.status,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "headers": {k: v for k, v in sorted(res.headers.items())
                    if k not in ("set-cookie",)},
        "server_ip": _resolve_ip(final),
        "meta": p.meta,
        "og": p.og,
        "counts": counts,
        "tech": tech,
        "design": design,
        "headings": [h for h in p.headings if h["text"].strip()][:40],
        "forms": p.forms[:10],
        "links": {"internal": p.links_internal, "external": p.links_external,
                  "sample": [x for x in p.link_sample if x["href"]][:40]},
        "assets": assets[:400],
        "outline": outline,
    }


def _resolve_ip(url: str) -> str:
    try:
        return socket.gethostbyname(urlsplit(url).hostname or "")
    except Exception:
        return ""


# --------------------------------------------------------------------------
# Tek dosya dışa aktarma
# --------------------------------------------------------------------------

def export_single(url: str, mode: str = "inline", strip_scripts: bool = False) -> tuple[str, str]:
    """(dosya_adı, html) döndürür. mode: inline | absolute"""
    res = fetch(url)
    if not res.body:
        raise RuntimeError(res.error or "Sayfa alınamadı")
    final = res.final_url or url
    html = decode(res.body, res.headers.get("content-type", ""))

    if mode == "absolute":
        resolver: Resolver = AbsoluteResolver()
        out = rewrite_html(html, final, resolver, {"strip_scripts": strip_scripts})
    else:
        # data-URI gömme
        assets: dict[str, str] = {}

        class InlineResolver(Resolver):
            def resolve(self, raw, base, kind, tag=""):
                if should_skip(raw):
                    return raw
                t = abs_url(base, raw)
                if not is_http(t):
                    return raw
                if kind in ("nav", "form"):
                    return t
                if t in assets:
                    return assets[t]
                r = cached_fetch(t, referer=final, max_bytes=2_500_000)
                if not r.body:
                    return t
                ct = r.ctype or mimetypes.guess_type(t)[0] or "application/octet-stream"
                if kind in ("css",):
                    txt = rewrite_css(decode(r.body, ct),
                                      r.final_url or t, AbsoluteResolver())
                    data = txt.encode("utf-8")
                    ct = "text/css"
                elif kind == "js":
                    txt = rewrite_js(decode(r.body, ct),
                                     r.final_url or t, AbsoluteResolver())
                    data = txt.encode("utf-8")
                    ct = "application/javascript"
                else:
                    data = r.body
                b64 = base64.b64encode(data).decode()
                uri = f"data:{ct};base64,{b64}"
                assets[t] = uri
                return uri

        out = rewrite_html(html, final, InlineResolver(), {"strip_scripts": strip_scripts})

    host = urlsplit(final).hostname or "site"
    fname = re.sub(r"[^\w\-.]", "_", host)[:60] + "-mirror.html"
    return fname, out


# --------------------------------------------------------------------------
# Tam site aynası (crawler)
# --------------------------------------------------------------------------

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

SKIP_EXT = re.compile(
    r"\.(zip|rar|7z|tar|gz|exe|dmg|msi|apk|iso|mp4|avi|mov|mkv|mp3|wav|flac|pdf|docx?|xlsx?|pptx?|csv)$", re.I)


def local_path_for(absu: str, origin_host: str) -> str:
    p = urlsplit(absu)
    path = unquote(p.path or "/")
    parts = [seg for seg in path.split("/") if seg not in ("", ".", "..")]
    def clean(s):
        s = re.sub(r"[^\w\-.%()@+]", "_", s)
        return s[:120] or "_"
    parts = [clean(s) for s in parts]
    if not parts or path.endswith("/"):
        parts.append("index.html")
    elif "." not in parts[-1]:
        parts[-1] = parts[-1] + ".html"
    if p.query:
        q = hashlib.md5(p.query.encode()).hexdigest()[:6]
        base, ext = posixpath.splitext(parts[-1])
        parts[-1] = f"{base}_{q}{ext}"
    rel = "/".join(parts)
    if p.netloc and p.netloc != origin_host:
        rel = "_external/" + re.sub(r"[^\w\-.]", "_", p.netloc) + "/" + rel
    return rel


def job_update(jid: str, **kw):
    with JOBS_LOCK:
        j = JOBS.get(jid)
        if j:
            j.update(kw)
            j["updated"] = time.time()


def job_log(jid: str, msg: str):
    with JOBS_LOCK:
        j = JOBS.get(jid)
        if j:
            j["log"].append(msg)
            if len(j["log"]) > 300:
                del j["log"][:100]
            j["updated"] = time.time()


def start_crawl(url: str, opts: dict) -> str:
    jid = hashlib.md5(f"{url}{time.time()}".encode()).hexdigest()[:12]
    with JOBS_LOCK:
        JOBS[jid] = {"id": jid, "url": url, "status": "running", "log": [],
                     "pages_done": 0, "pages_total": 0, "assets_done": 0,
                     "bytes": 0, "zip": None, "error": None,
                     "started": time.time(), "updated": time.time(),
                     "options": opts, "result": None}
    t = threading.Thread(target=crawl_worker, args=(jid, url, opts), daemon=True)
    t.start()
    return jid


def crawl_worker(jid: str, start_url: str, opts: dict):
    max_pages = max(1, min(int(opts.get("max_pages", 20)), PUBLIC_MAX_PAGES))
    max_assets = max(0, min(int(opts.get("max_assets", 250)), PUBLIC_MAX_ASSETS))
    total_cap = min(int(opts.get("total_mb", 60)), PUBLIC_MAX_MB) * 1024 * 1024
    same_host = bool(opts.get("same_host", True))
    obey_robots = bool(opts.get("robots", True))
    fetch_css_assets = bool(opts.get("css_assets", True))

    try:
        err = check_url(start_url)
        if err:
            raise RuntimeError(err)
        first = fetch(start_url)
        if not first.body:
            raise RuntimeError(first.error or "Başlangıç sayfası alınamadı")
        origin = urlsplit(first.final_url or start_url)
        origin_host = origin.netloc
        job_update(jid, root=first.final_url or start_url)

        visited: set[str] = set()
        page_map: dict[str, str] = {}      # abs url -> local path
        asset_map: dict[str, str] = {}     # abs url -> local path
        files: dict[str, bytes] = {}       # local path -> bytes
        queue: list[str] = [first.final_url or start_url]
        queued = set(queue)
        total_bytes = 0
        blocked = 0

        def same_site(u: str) -> bool:
            return urlsplit(u).netloc == origin_host

        # ---------------- 1. sayfaları gez ----------------
        while queue and len(visited) < max_pages:
            cur = queue.pop(0)
            if cur in visited:
                continue
            visited.add(cur)
            job_update(jid, pages_total=len(visited) + len(queue))
            if obey_robots and not robots_allows(cur):
                job_log(jid, f"robots.txt engelledi, atlandı: {cur}")
                blocked += 1
                continue

            r = fetch(cur) if cur != (first.final_url or start_url) else first
            if not r.body:
                job_log(jid, f"HATA {cur} -> {r.error}")
                continue
            ct = r.ctype or ""
            if "html" not in ct and not ct:
                ct = "text/html"
            if "html" not in ct:
                job_log(jid, f"HTML değil, sayfa olarak atlandı: {cur}")
                continue

            final_cur = r.final_url or cur
            html = decode(r.body, ct)
            lp = local_path_for(final_cur, origin_host)
            while lp in files:
                lp = re.sub(r"\.html$", "-1.html", lp)
            page_map[final_cur] = lp
            page_map[cur] = lp

            # sayfa içindeki bağlantı + varlıkları topla
            parser = OutlineParser(final_cur)
            try:
                parser.feed(html)
                parser.close()
            except Exception:
                pass

            hrefs = re.findall(r'<a[^>]+href=["\']([^"\']+)["\']', html, re.I)
            for h in hrefs:
                if should_skip(h) or h.startswith("//") is False and h.startswith("#"):
                    continue
                au = abs_url(final_cur, h)
                au = urlunsplit(urlsplit(au)._replace(fragment=""))
                if not is_http(au) or SKIP_EXT.search(urlsplit(au).path):
                    continue
                if same_host and not same_site(au):
                    continue
                if au not in queued and len(queued) < max_pages + 30:
                    queued.add(au)
                    queue.append(au)

            # varlıkları topla
            for a in parser.assets:
                u = a.get("url")
                if u and is_http(u) and u not in asset_map:
                    asset_map[u] = local_path_for(u, origin_host)
            for m in re.finditer(r'<link[^>]+href=["\']([^"\']+)["\'][^>]*>', html, re.I):
                tag = m.group(0)
                if "stylesheet" in tag.lower() or "icon" in tag.lower() or "preload" in tag.lower():
                    au = abs_url(final_cur, m.group(1))
                    if is_http(au) and au not in asset_map:
                        asset_map[au] = local_path_for(au, origin_host)
            for m in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.I):
                au = abs_url(final_cur, m.group(1))
                if is_http(au) and au not in asset_map:
                    asset_map[au] = local_path_for(au, origin_host)

            # script içi gömülü iframe ve oyun linklerini topla (GameDistribution vb.)
            gd_ids = set(re.findall(r'html5\.gamedistribution\.com/([a-zA-Z0-9_-]{24,40})', html, re.I))
            for gid in gd_ids:
                if gid != "rvvASMiM":
                    raw_game = f"https://html5.gamedistribution.com/rvvASMiM/{gid}/index.html"
                    if raw_game not in asset_map:
                        asset_map[raw_game] = local_path_for(raw_game, origin_host)
            for m in re.finditer(r'<iframe[^>]+src=["\']([^"\']+)["\']', html, re.I):
                au = abs_url(final_cur, m.group(1))
                if is_http(au) and au not in asset_map:
                    asset_map[au] = local_path_for(au, origin_host)

            files[lp] = html.encode("utf-8")
            total_bytes += len(files[lp])
            job_update(jid, pages_done=len(visited), bytes=total_bytes,
                       pages_total=min(max_pages, len(visited) + len(queue)))
            job_log(jid, f"[sayfa] {final_cur}  ->  {lp}")
            if total_bytes > total_cap:
                job_log(jid, "Toplam boyut sınırına ulaşıldı, gezinme durduruldu.")
                break

        # ---------------- 2. varlıkları indir ----------------
        want = list(asset_map.items())[:max_assets]
        job_log(jid, f"{len(want)} varlık indiriliyor...")
        css_jobs: list[tuple[str, str]] = []
        for i, (au, lp) in enumerate(want):
            if total_bytes > total_cap:
                job_log(jid, "Boyut sınırı: kalan varlıklar atlandı.")
                break
            if not same_host and urlsplit(au).netloc != origin_host:
                pass  # çapraz kaynak varlıklara izin ver (css/js/img/font)
            r = cached_fetch(au, referer=start_url, max_bytes=4_000_000)
            if not r.body or (r.status and r.status >= 400):
                continue
            kind = guess_kind(r.ctype, au)
            if kind == "css":
                css_jobs.append((au, lp))
            files[lp] = r.body
            total_bytes += len(r.body)
            job_update(jid, assets_done=i + 1, bytes=total_bytes)
            if i % 10 == 0:
                job_log(jid, f"[varlık {i+1}/{len(want)}] {au}")

        # ---------------- 3. CSS içi url()'leri de indir ----------------
        if fetch_css_assets:
            extra: dict[str, str] = {}
            for au, lp in css_jobs[:60]:
                if total_bytes > total_cap:
                    break
                r = cached_fetch(au, referer=start_url, max_bytes=4_000_000)
                if not r.body:
                    continue
                txt = decode(r.body, r.headers.get("content-type", ""))
                for m in re.finditer(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", txt, re.I):
                    raw = m.group(1).strip()
                    if should_skip(raw):
                        continue
                    absv = abs_url(au, raw)
                    if not is_http(absv) or absv in asset_map or absv in extra:
                        continue
                    extra[absv] = local_path_for(absv, origin_host)
                # @import edilen css dosyaları da
                for m in re.finditer(r"@import\s+['\"]([^'\"]+)['\"]", txt, re.I):
                    absv = abs_url(au, m.group(1))
                    if is_http(absv) and absv not in asset_map and absv not in extra:
                        extra[absv] = local_path_for(absv, origin_host)
            for au, lp in list(extra.items())[:max(0, max_assets - len(want))]:
                if total_bytes > total_cap:
                    break
                r = cached_fetch(au, referer=start_url, max_bytes=4_000_000)
                if not r.body:
                    continue
                files[lp] = r.body
                asset_map[au] = lp
                total_bytes += len(r.body)
                job_update(jid, assets_done=len(asset_map), bytes=total_bytes)

        # ---------------- 4. yeniden yaz ---------------
        def rel_from(page_lp: str, target_lp: str) -> str:
            d = posixpath.dirname(page_lp)
            return posixpath.relpath(target_lp, d or ".")

        class MirrorResolver(Resolver):
            def __init__(self, page_lp, page_url):
                self.page_lp = page_lp
                self.page_url = page_url

            def resolve(self, raw, base, kind, tag=""):
                if should_skip(raw):
                    return raw
                t = abs_url(base, raw)
                if not is_http(t):
                    return raw
                t_nofrag = urlunsplit(urlsplit(t)._replace(fragment=""))
                frag = urlsplit(t).fragment
                if kind == "nav":
                    lp = page_map.get(t_nofrag)
                    if lp:
                        s = rel_from(self.page_lp, lp)
                        return s + (("#" + frag) if frag else "")
                    return t
                lp = asset_map.get(t_nofrag)
                if lp and lp in files:
                    return rel_from(self.page_lp, lp)
                return t

        out_files: dict[str, bytes] = {}
        for au, lp in page_map.items():
            if lp not in files:
                continue
            html = decode(files[lp], "text/html")
            nm = MirrorResolver(lp, au)
            rewritten = rewrite_html(html, au, nm, {})
            out_files[lp] = rewritten.encode("utf-8")
        # css dosyalarını da göreli hale getir
        for au, lp in css_jobs:
            if lp not in files:
                continue
            txt = decode(files[lp], "text/css")
            nm = MirrorResolver(lp, au)
            out_files[lp] = rewrite_css(txt, au, nm).encode("utf-8")
        for lp, b in files.items():
            out_files.setdefault(lp, b)

        # ---------------- 5. ZIP ----------------
        report = {
            "kaynak": start_url,
            "kok": first.final_url or start_url,
            "tarih": time.strftime("%Y-%m-%d %H:%M:%S"),
            "sayfa_sayisi": len([k for k in page_map.values() if k in files]),
            "varlik_sayisi": len(asset_map),
            "toplam_bayt": total_bytes,
            "robots_engelledi": blocked,
            "sinirlar": {"max_sayfa": max_pages, "max_varlik": max_assets,
                         "toplam_mb": opts.get("total_mb", 60)},
        }
        tree = "\n".join(sorted(out_files))
        zip_name = f"mirror-{re.sub(r'[^\w\-.]', '_', origin_host)[:40]}-{int(time.time())}.zip"
        if len(zip_name) > 200:
            zip_name = zip_name[-190:]
        zip_path = os.path.join(OUTPUT_DIR, zip_name)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for lp, b in out_files.items():
                z.writestr(lp, b)
            report_txt = (
                "MirrorLab — site aynası raporu\n"
                "================================\n" +
                "\n".join(f"{k}: {v}" for k, v in report.items()) +
                "\n\nDosyalar:\n" + tree + "\n")
            z.writestr("_RAPOR.txt", report_txt.encode("utf-8"))
        size = os.path.getsize(zip_path)
        job_update(jid, status="done", zip=zip_path, zip_name=zip_name,
                   zip_size=size, result=report)
        job_log(jid, f"Tamamlandı: {zip_name} ({size/1024/1024:.2f} MB, "
                     f"{len(out_files)} dosya)")
    except Exception as e:
        job_update(jid, status="error", error=f"{type(e).__name__}: {e}")
        job_log(jid, f"HATA: {e}")


# ==========================================================================
#  TARAYICI MOTORU (Puppeteer / headless Chrome) — REA yaklaşımı
#  Gerçek tarayıcıda çalıştırır; ağ trafiği, API çağrıları, tasarım sistemi,
#  ekran görüntüleri ve kanıt/limit bilgisiyle birlikte rapor döndürür.
# ==========================================================================

ENGINE_JOBS: dict[str, dict] = {}
ENGINE_LOCK = threading.Lock()
NODE_ENGINE = os.path.join(ROOT, "engine.js")
JOBS_DIR = os.path.join(OUTPUT_DIR, "jobs")
os.makedirs(JOBS_DIR, exist_ok=True)


ENGINE_SLOT = threading.BoundedSemaphore(ENGINE_CONCURRENCY)
ENGINE_WAITING = {"n": 0}


def engine_env() -> dict:
    """Node + Puppeteer + Chrome kurulu mu?"""
    if ENGINE_MODE == "off":
        return {"node": "", "puppeteer": False, "chrome": "", "ready": False,
                "hint": "Tarayıcı motoru bu sunucuda kapatıldı (MIRRORLAB_ENGINE=off). "
                        "Statik analiz, tek dosya ve tam ayna çalışmaya devam eder."}
    node = shutil.which("node")
    info = {"node": node or "", "puppeteer": False, "chrome": "", "ready": False,
            "hint": ""}
    if not node:
        info["hint"] = "Node.js kurulu değil. Kurulum: https://nodejs.org (veya apt install nodejs npm)"
        return info
    remote = os.environ.get("MIRRORLAB_BROWSER_WS", "").strip()
    try:
        out = subprocess.run([node, "-e",
                              "const p=require('puppeteer');console.log(p.executablePath())"],
                             cwd=ROOT, capture_output=True, text=True, timeout=40)
        if out.returncode == 0:
            info["puppeteer"] = True
            info["chrome"] = (out.stdout or "").strip().splitlines()[-1] if out.stdout else ""
            if remote:
                # Uzak tarayıcı (ör. Cloudflare Browser Rendering) → yerel Chrome gerekmez
                info["ready"] = True
                info["remote"] = True
                info["hint"] = ""
            else:
                info["ready"] = bool(info["chrome"]) and os.path.exists(info["chrome"])
                if not info["ready"]:
                    info["hint"] = ("Chrome indirilmedi: cd mirrorlab && npx puppeteer browsers install chrome\n"
                                    "Alternatif: MIRRORLAB_BROWSER_WS ile uzak tarayıcı kullanın "
                                    "(bkz. deploy/cloudflare/README.md)")
        else:
            info["hint"] = ("Puppeteer kurulu değil. Kurulum: cd mirrorlab && "
                            "npm install puppeteer && npx puppeteer browsers install chrome")
    except Exception as e:
        info["hint"] = f"Puppeteer kontrolü başarısız: {e}"
    return info


def engine_log(jid: str, msg: str):
    with ENGINE_LOCK:
        j = ENGINE_JOBS.get(jid)
        if j:
            j["log"].append(msg)
            if len(j["log"]) > 400:
                del j["log"][:150]


def start_engine(url: str, opts: dict) -> str:
    jid = hashlib.md5(f"eng{url}{time.time()}".encode()).hexdigest()[:12]
    with ENGINE_LOCK:
        ENGINE_JOBS[jid] = {
            "id": jid, "url": url, "status": "running", "log": [], "error": None,
            "started": time.time(), "summary": None, "json": None, "opts": opts,
        }
    threading.Thread(target=engine_worker, args=(jid, url, opts), daemon=True).start()
    return jid


def engine_worker(jid: str, url: str, opts: dict):
    try:
        env = engine_env()
        if not env["ready"]:
            raise RuntimeError(env["hint"] or "Tarayıcı motoru hazır değil.")
        if ENGINE_WAITING["n"] > 6:
            raise RuntimeError("Sunucu şu anda yoğun (kuyrukta 6+ analiz var). "
                               "Lütfen birkaç dakika sonra tekrar deneyin.")
        ENGINE_WAITING["n"] += 1
        engine_log(jid, f"Sıra bekleniyor (eşzamanlı sınır: {ENGINE_CONCURRENCY})…")
        with ENGINE_SLOT:
            ENGINE_WAITING["n"] = max(0, ENGINE_WAITING["n"] - 1)
            _engine_run(jid, url, opts)
    except Exception as e:
        with ENGINE_LOCK:
            ENGINE_JOBS[jid].update(status="error", error=f"{type(e).__name__}: {e}")
        engine_log(jid, f"HATA: {e}")


def _engine_run(jid: str, url: str, opts: dict):
    try:
        cfg_path = os.path.join(JOBS_DIR, f"{jid}-cfg.json")
        out_path = os.path.join(JOBS_DIR, f"{jid}-result.json")
        cfg = {
            "url": url, "outDir": OUTPUT_DIR, "jobId": jid, "outFile": out_path,
            "probe": bool(opts.get("probe")), "probeCount": int(opts.get("probe_count", 3)),
            "mobile": bool(opts.get("mobile", True)) and not LOW_MEMORY,
            "blockMedia": bool(opts.get("block_media", False)),
            "maxTotalMs": int(opts.get("budget_ms", 75000)),
        }
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        engine_log(jid, f"Tarayıcı başlatılıyor: {url}")
        child_env = dict(os.environ)
        if LOW_MEMORY:
            child_env["MIRRORLAB_LOWMEM"] = "1"
        proc = subprocess.run(["node", NODE_ENGINE, cfg_path], cwd=ROOT,
                              capture_output=True, text=True, timeout=300,
                              env=child_env)
        for line in (proc.stderr or "").splitlines()[-20:]:
            engine_log(jid, line)
        if not os.path.exists(out_path):
            raise RuntimeError(f"Motor çıktı üretmedi: {(proc.stdout or proc.stderr or '')[:300]}")
        with open(out_path, encoding="utf-8") as f:
            data = json.load(f)
        if not data.get("ok"):
            raise RuntimeError(data.get("error") or "Analiz başarısız")
        data.pop("renderedHtml", None) if opts.get("drop_html") else None
        with ENGINE_LOCK:
            j = ENGINE_JOBS[jid]
            j.update(status="done", json=out_path,
                     summary={
                         "final_url": data.get("finalUrl"),
                         "elapsed_ms": data.get("elapsedMs"),
                         "network": len(data.get("network") or []),
                         "api": len(data.get("api") or []),
                         "sections": len(data.get("sections") or []),
                         "screenshots": data.get("screenshots") or {},
                         "frameworks": [f.get("name") for f in (data.get("frameworks") or [])],
                         "limits": data.get("limits") or [],
                     })
        engine_log(jid, f"Tamamlandı: {len(data.get('network') or [])} istek, "
                        f"{len(data.get('api') or [])} API çağrısı, "
                        f"{len(data.get('sections') or [])} bölüm")
    except subprocess.TimeoutExpired:
        with ENGINE_LOCK:
            ENGINE_JOBS[jid].update(status="error", error="Motor zaman aşımına uğradı (300 sn)")
    except Exception as e:
        with ENGINE_LOCK:
            ENGINE_JOBS[jid].update(status="error", error=f"{type(e).__name__}: {e}")
        engine_log(jid, f"HATA: {e}")


def load_engine_result(jid: str) -> dict | None:
    with ENGINE_LOCK:
        j = ENGINE_JOBS.get(jid)
    if not j or not j.get("json") or not os.path.exists(j["json"]):
        return None
    try:
        with open(j["json"], encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def build_starter_kit(jid: str) -> tuple[str, str]:
    """Analiz sonucundan 'kendi projen için başlangıç kiti' ZIP'i üretir."""
    data = load_engine_result(jid)
    if not data:
        raise RuntimeError("Analiz sonucu bulunamadı")
    host = urlsplit(data.get("finalUrl") or jid).hostname or "site"
    safe_host = re.sub(r"[^\w.-]", "_", host)[:50]
    files: dict[str, bytes] = {}

    # 1) render edilmiş DOM
    html = data.get("renderedHtml") or ("<!DOCTYPE html><html><head><meta charset='utf-8'>"
                                        f"<title>{html_mod.escape(data.get('seo',{}).get('title',''))}</title>"
                                        "</head><body><p>Render edilmiş DOM alınamadı.</p></body></html>")

    # 2) tasarım token'ları -> CSS değişkenleri
    d = data.get("design") or {}
    seo = data.get("seo") or {}
    lines = ["/* MirrorLab tarafından üretilen tasarım token'ları",
             f"   kaynak: {data.get('finalUrl')}  ·  {time.strftime('%Y-%m-%d %H:%M')} */",
             ":root {"]
    for i, c in enumerate((d.get("colors") or [])[:14], 1):
        lines.append(f"  --color-{i}: {c.get('value')};   /* {c.get('count')} kullanım */")
    for i, f_ in enumerate((d.get("fonts") or [])[:5], 1):
        lines.append(f"  --font-{i}: {f_.get('value')};")
    for i, v in enumerate((d.get("fontSizes") or [])[:8], 1):
        lines.append(f"  --text-{i}: {v.get('value')};")
    for i, v in enumerate((d.get("spacings") or [])[:8], 1):
        lines.append(f"  --space-{i}: {v.get('value')};")
    for i, v in enumerate((d.get("radii") or [])[:6], 1):
        lines.append(f"  --radius-{i}: {v.get('value')};")
    for i, v in enumerate((d.get("shadows") or [])[:5], 1):
        lines.append(f"  --shadow-{i}: {v.get('value')};")
    lines.append("}")
    lines.append("")
    lines.append("/* orijinal siteden çıkarılan bileşen stilleri (örnek) */")
    comps = d.get("components") or {}
    label = {"button": ".btn", "input": ".input", "link": ".link", "heading": "h1.hero-title", "card": ".card"}
    for key, cls in label.items():
        c = comps.get(key)
        if not c:
            continue
        lines.append(f"{cls} {{")
        if key == "heading":
            lines.append(f"  font-size: {c.get('fontSize')};")
            lines.append(f"  font-weight: {c.get('fontWeight')};")
        else:
            lines.append(f"  background: {c.get('background')};")
            lines.append(f"  color: {c.get('color')};")
            lines.append(f"  padding: {c.get('padding')};")
            lines.append(f"  border: {c.get('border')};")
            lines.append(f"  border-radius: {c.get('borderRadius')};")
            lines.append(f"  box-shadow: {c.get('boxShadow')};")
        lines.append(f"  font-family: {c.get('fontFamily')}, var(--font-1, sans-serif);")
        lines.append(f"  font-size: {c.get('fontSize')};")
        lines.append(f"  transition: {c.get('transition')};")
        lines.append("}")
        lines.append("")
    files["styles/tokens.css"] = ("\n".join(lines)).encode("utf-8")

    # 3) varlıkları indir + HTML'i yerelleştir
    asset_map: dict[str, str] = {}
    urls = re.findall(r'(?:src|href)="(https?://[^"]+)"', html)
    cand = []
    for u in urls:
        u2 = u.split("#")[0]
        if u2 in asset_map or u2 in cand:
            continue
        if re.search(r"\.(png|jpe?g|gif|webp|svg|avif|ico|woff2?|ttf|css)$", urlsplit(u2).path, re.I):
            cand.append(u2)
    for u in cand[:26]:
        try:
            r = cached_fetch(u, referer=data.get("finalUrl"), max_bytes=3_000_000)
            if not r.body:
                continue
            ext = os.path.splitext(urlsplit(u).path)[1] or ".bin"
            name = re.sub(r"[^\w.-]", "_", posixpath.basename(urlsplit(u).path) or "asset")[:80]
            local = f"assets/{name}"
            n = 1
            while local in files:
                local = f"assets/{os.path.splitext(name)[0]}-{n}{ext}"
                n += 1
            files[local] = r.body
            asset_map[u] = local
        except Exception:
            continue
    for u, local in asset_map.items():
        html = html.replace(f'"{u}"', f'"{local}"')
    # token CSS'i ve notu enjekte et
    inject = ('<link rel="stylesheet" href="styles/tokens.css">'
              "\n<!-- MirrorLab tarafından üretildi: orijinal sitenin render edilmiş DOM'u. "
              "Tasarım token'ları styles/tokens.css içinde. Detaylar: README.md -->")
    if "</head>" in html:
        html = html.replace("</head>", inject + "\n</head>", 1)
    else:
        html = inject + html
    files["index.html"] = html.encode("utf-8")

    # 4) analiz verisi + API örnekleri
    light = {k: v for k, v in data.items() if k != "renderedHtml"}
    files["data/analysis.json"] = json.dumps(light, ensure_ascii=False, indent=1).encode("utf-8")

    api_md = ["# Gözlemlenen API çağrıları", "",
              f"Toplam {len(data.get('api') or [])} benzersiz uç nokta yakalandı.", ""]
    for a in (data.get("api") or [])[:30]:
        api_md.append(f"## `{a.get('method')} {a.get('url')}`")
        api_md.append(f"- durum: {a.get('status')} · tür: {a.get('kind')} · boyut: {a.get('size')} bayt · {a.get('hits')} çağrı")
        if a.get("jsonShape"):
            api_md.append(f"- yanıt şeması: `{json.dumps(a['jsonShape'], ensure_ascii=False)[:400]}`")
        if a.get("bodyPreview"):
            api_md.append("```json")
            api_md.append(a["bodyPreview"][:900])
            api_md.append("```")
        api_md.append("")
    if len(api_md) <= 2:
        api_md.append("Bu sayfada XHR/fetch çağrısı yakalanmadı (tamamen sunucu tarafı render edilmiş olabilir).")
    files["data/api-examples.md"] = ("\n".join(api_md)).encode("utf-8")

    # 5) README — mimari açıklaması
    fw = ", ".join(f.get("name", "") for f in (data.get("frameworks") or [])) or "tespit edilemedi"
    sec_lines = [f"- **{s.get('heading') or s.get('tag')}** — yükseklik {s.get('rect', {}).get('h')}px"
                 + (f", görüntü: `{s.get('shot')}`" for _ in [0]).__next__() if False else
                 f"- **{(s.get('heading') or s.get('tag'))}** — {s.get('rect', {}).get('h')}px"
                 + (f" · `output/shots/{s.get('shot')}`" if s.get("shot") else "")
                 for s in (data.get("sections") or [])[:12]]
    readme = f"""# {seo.get('title','Klonlanan sayfa')} — tersine mühendislik kiti

MirrorLab tarafından **{time.strftime('%Y-%m-%d %H:%M')}** tarihinde üretildi.
Kaynak: {data.get('finalUrl')}

## Ne var bu pakette?

| Dosya | Açıklama |
|---|---|
| `index.html` | Gerçek tarayıcıda render edilmiş DOM (JS çalıştıktan sonraki hâli), yerel varlıklara bağlı |
| `styles/tokens.css` | Orijinal siteden **çıkarılan tasarım token'ları** + örnek bileşen stilleri |
| `assets/` | İndirilebilen görseller / fontlar / ikonlar |
| `data/analysis.json` | Tüm kanıt paketi (ağ kaydı, bölümler, tasarım taraması, limitler) |
| `data/api-examples.md` | Gözlemlenen API uç noktaları ve örnek yanıt gövdeleri |

## Tespit edilenler

- **Teknoloji yığını:** {fw}
- **Ağ trafiği:** {len(data.get('network') or [])} istek, {len(data.get('api') or [])} API çağrısı
- **DOM:** {data.get('domCounts', {}).get('nodes')} düğüm, {data.get('domCounts', {}).get('images')} görsel
- **SEO başlığı:** {seo.get('title')}
- **Meta açıklama:** {seo.get('description')}
- **Diller:** {data.get('a11y', {}).get('lang')}

## Sayfa akışı (bölümler)

{chr(10).join(sec_lines) if sec_lines else '- bölüm tespit edilemedi'}

## Renk paleti

{chr(10).join(f"- `{c.get('value')}` — {c.get('count')} kullanım" for c in (d.get('colors') or [])[:10])}

## Yazı tipleri

{chr(10).join(f"- {f.get('value')}" for f in (d.get('fonts') or [])[:5])}

## Tasarım token'larını kendi projene taşıma

```css
@import "styles/tokens.css";

.hero {{
  background: var(--color-1);
  font-family: var(--font-1);
  padding: var(--space-3);
  border-radius: var(--radius-2);
  box-shadow: var(--shadow-1);
}}
```

## Bilinen sınırlar (dürüst liste)

{chr(10).join('- ' + x for x in (data.get('limits') or []))}

## Yasal not

Bu paket tersine mühendislik **incelemesi** içindir. Orijinal tasarım, metin ve kodların telif
hakkı sahiplerine aittir; kendi projenizde kullanmadan önce izin/lisans kontrolü yapın.
"""
    files["README.md"] = readme.encode("utf-8")

    zip_name = f"starter-{safe_host}-{int(time.time())}.zip"
    zip_path = os.path.join(OUTPUT_DIR, zip_name)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for k, v in files.items():
            z.writestr(k, v)
    return zip_path, zip_name




# --------------------------------------------------------------------------
# HTTP sunucu
# --------------------------------------------------------------------------

_RATE: dict[str, list[float]] = {}
_RATE_LOCK = threading.Lock()


def rate_ok(ip: str) -> tuple[bool, int]:
    """Basit kayan pencere hız sınırı. (izin_var, kalan) döndürür."""
    if RATE_LIMIT_PER_HOUR <= 0:
        return True, 999
    now = time.time()
    with _RATE_LOCK:
        hits = [t for t in _RATE.get(ip, []) if now - t < 3600]
        if len(hits) >= RATE_LIMIT_PER_HOUR:
            _RATE[ip] = hits
            return False, 0
        hits.append(now)
        _RATE[ip] = hits
        if len(_RATE) > 5000:
            for k in list(_RATE)[:1000]:
                _RATE.pop(k, None)
        return True, RATE_LIMIT_PER_HOUR - len(hits)


def client_ip(self) -> str:
    fwd = self.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return self.client_address[0] if self.client_address else "?"


def read_robots_ok(url: str) -> bool:
    try:
        return robots_allows(url)
    except Exception:
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "MirrorLab/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- temel ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_bytes(self, code, body: bytes, ctype="application/json; charset=utf-8",
                   extra=None, download: str | None = None, cache="no-store"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        extra = {k: v for k, v in (extra or {}).items()}
        if "Cache-Control" in extra:
            cache = extra.pop("Cache-Control")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if download:
            ascii_name = re.sub(r'[^\w\-.]+', "_", download)
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(download)}")
        for k, v in extra.items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_json(self, obj, code=200):
        self.send_bytes(code, json.dumps(obj, ensure_ascii=False, default=str))

    def body_json(self) -> dict:
        """JSON gövdesini veya form-urlencoded gövdeyi sözlüğe çevirir."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if not raw:
                return {}
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "json" in ctype:
                return json.loads(raw.decode("utf-8"))
            return dict(urllib.parse.parse_qsl(raw.decode("utf-8", "replace"),
                                               keep_blank_values=True))
        except Exception:
            return {}

    def params(self) -> dict:
        """Sorgu parametreleri + (POST ise) gövde; gövde yalnızca bir kez okunur."""
        merged = dict(self.query())
        body = getattr(self, "_body", None)
        if body:
            merged.update({k: v for k, v in body.items() if v not in ("", None)})
        return merged

    def query(self) -> dict:
        q = urlsplit(self.path).query
        out: dict[str, list[str]] = {}
        for k, v in urllib.parse.parse_qsl(q, keep_blank_values=True):
            out.setdefault(k, []).append(v)
        return {k: v[0] for k, v in out.items()}

    # ---------- yönlendirme ----------
    def do_OPTIONS(self):
        self.send_bytes(204, b"", "text/plain")

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        self._body = self.body_json()          # gövde yalnızca bir kez okunur
        d = self.params()
        if path == "/api/env":
            return self.send_json({"ok": True, "engine": engine_env()})
        if path == "/api/analyze":
            url = norm_url(d.get("url", ""))
            if not url:
                return self.send_json({"ok": False, "error": "url gerekli"}, 400)
            return self.send_json(analyze(url, deep=str(d.get("deep", "1")) not in ("0", "false")))
        if path == "/api/crawl":
            return self._start_crawl(d)
        if path == "/api/engine":
            return self._start_engine(d)
        if path == "/api/engine/status":
            return self._engine_status(d)
        if path == "/api/engine/result":
            return self._engine_result(d)
        if path == "/api/starterkit":
            return self._starterkit(d)
        if path == "/api/export":
            return self.handle_export(d)
        return self.send_json({"ok": False, "error": "bilinmeyen uç nokta"}, 404)

    def do_GET(self):
        path = urlsplit(self.path).path
        q = self.query()

        # ---- statik arayüz ----
        if path in ("/", "/index.html"):
            return self.serve_static("index.html")
        if path.startswith("/static/"):
            return self.serve_static(path[len("/static/"):])

        # ---- durum ----
        if path == "/api/health":
            return self.send_json({
                "ok": True, "time": time.time(), "jobs": len(JOBS),
                "engine_jobs": len(ENGINE_JOBS), "engine_mode": ENGINE_MODE,
                "lowmem": LOW_MEMORY, "rate_limit_per_hour": RATE_LIMIT_PER_HOUR,
                "limits": {"max_pages": PUBLIC_MAX_PAGES, "max_assets": PUBLIC_MAX_ASSETS,
                           "max_mb": PUBLIC_MAX_MB}})
        if path == "/api/env":
            return self.send_json({"ok": True, "engine": engine_env()})

        # ---- klon önizleme katmanı ----
        if path == "/api/render":
            return self.handle_render(q)
        if path == "/api/raw":
            # Ham proxy: tarayıcı içi ayna motoru sayfaları/varlıkları bununla indirir.
            u = q.get("u", "")
            why = check_url(u)
            if why:
                return self.send_json({"ok": False, "error": why}, 400 if "şema" in why else 403)
            fr = fetch(u)
            if not fr.ok:
                return self.send_json({"ok": False, "error": fr.error or "alınamadı", "status": fr.status}, 502)
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "x-ml-final-url, x-ml-status")
            self.send_header("Content-Type", fr.ctype or "application/octet-stream")
            self.send_header("x-ml-final-url", fr.final_url or u)
            self.send_header("x-ml-status", str(fr.status))
            self.send_header("Content-Length", str(len(fr.body)))
            self.end_headers()
            return self.wfile.write(fr.body)
        if path == "/api/asset":
            return self.handle_asset(q)
        if path == "/shot":
            name = os.path.basename(unquote(q.get("f", "")))
            full = os.path.join(OUTPUT_DIR, "shots", name)
            if not name or not os.path.isfile(full):
                return self.send_bytes(404, b"yok", "text/plain; charset=utf-8")
            with open(full, "rb") as fh:
                blob = fh.read()
            return self.send_bytes(200, blob, "image/png", cache="public, max-age=600")

        # ---- statik analiz ----
        if path == "/api/analyze":
            url = norm_url(q.get("url", ""))
            if not url:
                return self.send_json({"ok": False, "error": "url gerekli"}, 400)
            return self.send_json(analyze(url, deep=q.get("deep", "1") not in ("0", "false")))

        # ---- tarayıcı motoru ----
        if path == "/api/engine":
            return self._start_engine(q)
        if path == "/api/engine/status":
            return self._engine_status(q)
        if path == "/api/engine/result":
            return self._engine_result(q)
        if path == "/api/starterkit":
            return self._starterkit(q)

        # ---- tam ayna ----
        if path == "/api/crawl":
            return self._start_crawl(q)
        if path == "/api/crawl/status":
            jid = q.get("id", "")
            with JOBS_LOCK:
                j = JOBS.get(jid)
                if not j:
                    return self.send_json({"ok": False, "error": "iş bulunamadı"}, 404)
                out = {k: v for k, v in j.items() if k != "zip"}
                out["ok"] = True
                out["has_zip"] = bool(j.get("zip"))
                if j.get("zip") and os.path.exists(j["zip"]):
                    out["zip_size"] = os.path.getsize(j["zip"])
                out["log"] = j["log"][-60:]
            return self.send_json(out)
        if path == "/api/crawl/file":
            jid = q.get("id", "")
            with JOBS_LOCK:
                j = JOBS.get(jid)
            if not j or not j.get("zip") or not os.path.exists(j["zip"]):
                return self.send_json({"ok": False, "error": "arşiv hazır değil"}, 404)
            with open(j["zip"], "rb") as fh:
                data = fh.read()
            return self.send_bytes(200, data, "application/zip",
                                   download=j.get("zip_name", "site.zip"))

        # ---- tek dosya dışa aktarma ----
        if path == "/api/export":
            return self.handle_export(q)

        return self.send_bytes(404, "Bulunamadı", "text/plain; charset=utf-8")

    def serve_static(self, rel: str):
        rel = unquote(rel).lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self.send_bytes(404, "yok", "text/plain; charset=utf-8")
        ct = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ct.startswith("text/") or ct in ("application/javascript",):
            ct += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_bytes(200, data, ct)

    # ---------- iş başlatıcılar (GET/POST ortak) ----------
    def _start_engine(self, d):
        ok, _left = rate_ok(client_ip(self))
        if not ok:
            return self.send_json({"ok": False, "error":
                f"Saatlik analiz sınırına ulaşıldı ({RATE_LIMIT_PER_HOUR}/saat). "
                "Lütfen daha sonra tekrar deneyin."}, 429)
        url = norm_url(d.get("url", ""))
        err = check_url(url)
        if err:
            return self.send_json({"ok": False, "error": err}, 400)
        env = engine_env()
        if not env["ready"]:
            return self.send_json({"ok": False,
                                   "error": env["hint"] or "Tarayıcı motoru hazır değil.",
                                   "env": env}, 503)
        opts = {
            "probe": str(d.get("probe", "1")) not in ("0", "false"),
            "probe_count": d.get("probe_count", 3),
            "mobile": str(d.get("mobile", "1")) not in ("0", "false"),
            "block_media": str(d.get("block_media", "0")) in ("1", "true"),
            "budget_ms": d.get("budget_ms", 75000),
        }
        return self.send_json({"ok": True, "job": start_engine(url, opts)})

    def _start_crawl(self, d):
        ok, _left = rate_ok(client_ip(self))
        if not ok:
            return self.send_json({"ok": False, "error":
                f"Saatlik aynalama sınırına ulaşıldı ({RATE_LIMIT_PER_HOUR}/saat)."}, 429)
        url = norm_url(d.get("url", ""))
        err = check_url(url)
        if err:
            return self.send_json({"ok": False, "error": err}, 400)
        opts = {
            "max_pages": d.get("max_pages", 20),
            "max_assets": d.get("max_assets", 250),
            "total_mb": d.get("total_mb", 60),
            "same_host": str(d.get("same_host", "1")) not in ("0", "false"),
            "robots": str(d.get("robots", "1")) not in ("0", "false"),
            "css_assets": str(d.get("css_assets", "1")) not in ("0", "false"),
        }
        if opts["robots"] and not read_robots_ok(url):
            return self.send_json({"ok": False, "error":
                "robots.txt bu adrese izin vermiyor. Ayarı kapatarak yine de deneyebilirsiniz."}, 403)
        return self.send_json({"ok": True, "job": start_crawl(url, opts)})

    # ---------- motor yardımcıları (GET/POST ortak) ----------
    def _engine_status(self, q):
        jid = q.get("id", "")
        with ENGINE_LOCK:
            j = ENGINE_JOBS.get(jid)
            if not j:
                return self.send_json({"ok": False, "error": "iş bulunamadı"}, 404)
            out = {"ok": True, "id": jid, "status": j["status"], "url": j["url"],
                   "log": j["log"][-80:], "error": j.get("error"),
                   "summary": j.get("summary"),
                   "has_result": bool(j.get("json") and os.path.exists(j["json"]))}
        return self.send_json(out)

    def _engine_result(self, q):
        jid = q.get("id", "")
        data = load_engine_result(jid)
        if data is None:
            return self.send_json({"ok": False, "error": "sonuç hazır değil"}, 404)
        if q.get("light") in ("1", "true"):
            data = {k: v for k, v in data.items() if k != "renderedHtml"}
        return self.send_json({"ok": True, "data": data})

    def _starterkit(self, q):
        jid = q.get("id", "")
        if load_engine_result(jid) is None:
            return self.send_json({"ok": False, "error":
                "Bu kimlik için hazır analiz sonucu yok. Önce 'Tarayıcıda İncele' ile analiz çalıştırın."}, 404)
        try:
            zip_path, zip_name = build_starter_kit(jid)
        except Exception as e:
            return self.send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)
        with open(zip_path, "rb") as f:
            blob = f.read()
        return self.send_bytes(200, blob, "application/zip", download=zip_name)

    # ---------- dışa aktarma ----------
    def handle_export(self, d=None):
        d = d if d is not None else self.params()
        url = norm_url(d.get("url", ""))
        if not url:
            return self.send_json({"ok": False, "error": "url gerekli"}, 400)
        err = check_url(url)
        if err:
            return self.send_json({"ok": False, "error": err}, 400)
        mode = d.get("mode", "inline")
        if mode not in ("inline", "absolute"):
            mode = "inline"
        strip = str(d.get("strip_scripts", "0")).lower() in ("1", "true", "on", "yes")
        try:
            fname, html = export_single(url, mode, strip)
        except Exception as e:
            return self.send_json({"ok": False,
                                   "error": f"{type(e).__name__}: {e}"}, 500)
        return self.send_bytes(200, html.encode("utf-8"),
                               "text/html; charset=utf-8", download=fname)

    # ---------- proxy ----------
    def handle_asset(self, q):
        target = q.get("u", "")
        ref = q.get("r", "") or None
        raw = q.get("raw") == "1"
        if not is_http(target):
            return self.send_bytes(400, "geçersiz hedef", "text/plain; charset=utf-8")
        err = check_url(target)
        if err:
            return self.send_bytes(403, err, "text/plain; charset=utf-8")
        res = cached_fetch(target, referer=ref)
        if not res.body and not res.ok:
            return self.send_bytes(res.status or 502,
                                   f"kaynak alınamadı: {res.error}".encode(),
                                   "text/plain; charset=utf-8")
        ct = res.ctype or mimetypes.guess_type(urlsplit(target).path)[0] or \
            "application/octet-stream"
        kind = guess_kind(ct, target)
        base = res.final_url or target
        page = ref or base

        if raw:
            data = res.body
        elif kind == "css":
            txt = rewrite_css(decode(res.body, ct), base, PreviewResolver(page, True))
            data = txt.encode("utf-8")
            ct = "text/css; charset=utf-8"
        elif kind == "js":
            txt = rewrite_js(decode(res.body, ct), base, PreviewResolver(page, True))
            data = txt.encode("utf-8")
            ct = "application/javascript; charset=utf-8"
        else:
            data = res.body

        # CSS/JS/font varlıklarına proxy'de ara bellek
        extra = {
            "X-Mirrorlab-Source": target[:200],
            "Cache-Control": "public, max-age=300",
        }
        if not raw:
            extra["Cache-Control"] = "public, max-age=300"
        self.send_bytes(200, data, ct, extra=extra)

    def handle_render(self, q):
        """Klonlanmış sayfayı önizleme için döndürür (iframe kaynağı)."""
        target = norm_url(q.get("u", ""))
        if not target:
            return self.send_bytes(400, b"url gerekli", "text/plain; charset=utf-8")
        err = check_url(target)
        if err:
            return self.send_bytes(403, err.encode(), "text/plain; charset=utf-8")
        res = fetch(target)
        if not res.body:
            return self.send_bytes(res.status or 502,
                                   f"Sayfa alınamadı: {res.error}".encode(),
                                   "text/plain; charset=utf-8")
        final = res.final_url or target
        html = decode(res.body, res.headers.get("content-type", ""))
        strip = q.get("strip_scripts", "0") in ("1", "true")
        do_proxy = q.get("proxy", "1") not in ("0", "false")
        out = rewrite_html(html, final, PreviewResolver(final, do_proxy),
                           {"strip_scripts": strip})

        banner = q.get("banner", "0") in ("1", "true")
        inject = INJECT_JS.replace("__PAGE__", json.dumps(final))
        if "</body>" in out.lower():
            idx = out.lower().rfind("</body>")
            out = out[:idx] + inject + out[idx:]
        else:
            out += inject
        if banner:
            out = out.replace("<body", '<body data-mirrorlab="1"', 1)
        self.send_bytes(200, out, "text/html; charset=utf-8",
                        extra={"X-Mirrorlab-Final": final[:200],
                               "Cache-Control": "no-store"})


INJECT_JS = """
<script>
(function(){
  var PAGE = __PAGE__;
  function relay(href){
    try { parent.postMessage({ml:'nav', href: href, page: PAGE}, '*'); } catch(e) {}
  }
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if(!a) return;
    var h = a.getAttribute('href') || '';
    if(h.charAt(0) === '#' || h.indexOf('javascript:') === 0) return;
    e.preventDefault();
    e.stopPropagation();
    relay(a.href || h);
  }, true);
  document.addEventListener('submit', function(e){ e.preventDefault(); relay('form:' + (e.target.action||'')); }, true);
  window.addEventListener('error', function(){});
})();
</script>
"""


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def cli_crawl(url: str, out_zip: str, max_pages: int = 20, max_assets: int = 250,
              total_mb: int = 60, robots: bool = True, cookie: str = "") -> int:
    """Sunucusuz kullanım: siteyi aynalar ve ZIP'i verilen yola yazar.
    GitHub Actions / cron işleri için:  python3 server.py --crawl URL out.zip 30 200"""
    url = norm_url(url)
    err = check_url(url)
    if err:
        print("HATA:", err, file=sys.stderr)
        return 2
    if robots and not read_robots_ok(url):
        print("HATA: robots.txt izin vermiyor. --ignore-robots ile yine de deneyebilirsiniz.", file=sys.stderr)
        return 3
    opts = {"max_pages": max_pages, "max_assets": max_assets, "total_mb": total_mb,
            "same_host": True, "robots": robots, "css_assets": True}
    jid = start_crawl(url, opts)
    seen = 0
    while True:
        time.sleep(1)
        with JOBS_LOCK:
            j = dict(JOBS.get(jid, {}))
        log = j.get("log", [])
        for line in log[seen:]:
            print(line, flush=True)
        seen = len(log)
        if j.get("status") != "running":
            break
    if j.get("status") == "done" and j.get("zip") and os.path.exists(j["zip"]):
        shutil.copyfile(j["zip"], out_zip)
        res = j.get("result") or {}
        print(f"\nZIP: {out_zip}")
        print(f"sayfa: {res.get('sayfa_sayisi')} · varlık: {res.get('varlik_sayisi')} · "
              f"boyut: {(res.get('toplam_bayt') or 0)/1024/1024:.2f} MB")
        return 0
    print("HATA:", j.get("error") or "aynalama başarısız", file=sys.stderr)
    return 4


def cli_engine(url: str, out_json: str) -> int:
    """Sunucusuz tarayıcı analizi: node engine.js'i doğrudan çalıştırır."""
    env = engine_env()
    if not env["ready"]:
        print("HATA:", env["hint"], file=sys.stderr)
        return 2
    jid = "cli" + str(int(time.time()))
    cfg_path = os.path.join(JOBS_DIR, f"{jid}-cfg.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"url": norm_url(url), "outDir": OUTPUT_DIR, "jobId": jid,
                   "outFile": out_json, "probe": True, "probeCount": 3, "mobile": True}, f)
    rc = subprocess.call(["node", NODE_ENGINE, cfg_path], cwd=ROOT,
                         env={**os.environ, "MIRRORLAB_LOWMEM": "1" if LOW_MEMORY else "0"})
    return 0 if rc == 0 and os.path.exists(out_json) else 4


def main():
    args = sys.argv[1:]
    if args and args[0] == "--crawl":
        if len(args) < 3:
            print("kullanım: python3 server.py --crawl <url> <cikti.zip> [max_sayfa] [max_varlik]",
                  file=sys.stderr)
            return 2
        return cli_crawl(args[1], args[2],
                         int(args[3]) if len(args) > 3 else 20,
                         int(args[4]) if len(args) > 4 else 250,
                         robots="--ignore-robots" not in args)
    if args and args[0] == "--engine":
        if len(args) < 3:
            print("kullanım: python3 server.py --engine <url> <cikti.json>", file=sys.stderr)
            return 2
        return cli_engine(args[1], args[2])
    if len(sys.argv) > 1 and sys.argv[1] in ("--selftest", "-t"):
        print(json.dumps(analyze("https://example.com"), ensure_ascii=False)[:1200])
        return 0
    socketserver.TCPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    eng = engine_env()
    print(f"MirrorLab  ->  http://{HOST}:{PORT}")
    print(f"  motor: {'hazır' if eng['ready'] else 'devre dışı (' + (eng['hint'] or '')[:60] + ')'}"
          f" · eşzamanlılık: {ENGINE_CONCURRENCY} · hız sınırı: "
          f"{RATE_LIMIT_PER_HOUR if RATE_LIMIT_PER_HOUR > 0 else 'kapalı'}/saat")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
