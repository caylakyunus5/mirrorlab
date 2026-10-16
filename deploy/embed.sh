#!/usr/bin/env bash
# MirrorLab — tarayıcı modüllerini static/index.html içine gömer.
#
#   bash deploy/embed.sh
#
# static/index.html TEK KAYNAK DEĞİL: motor ve analiz modülleri ayrı dosyalarda
# tutulur, bu betik onları index.html içindeki IIFE'ye gömer:
#   static/_edge_mirror.src.js  → tarayıcı içi tam ayna motoru
#   static/_mirror_fit.src.js   → "tam kopyalamaya uygun mu?" karar kartı
#   static/_mirror_derin.src.js → REA derinliği (teknoloji/güvenlik/API/kaynak)
# Gömdükten sonra index.html'in söz dizimi denetlenir (node --check).
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - "$@" <<'PY'
import re, sys
idx = "static/index.html"
h = open(idx, encoding="utf-8").read()

motor = open("static/_edge_mirror.src.js", encoding="utf-8").read().rstrip("\n")
# apiUrl index.html'de zaten tanımlı (yukarıda); motordaki kopya gömülmez
motor = "\n".join(l for l in motor.split("\n") if not l.startswith("  function apiUrl(p)"))
fit = open("static/_mirror_fit.src.js", encoding="utf-8").read().rstrip("\n")
derin = open("static/_mirror_derin.src.js", encoding="utf-8").read().rstrip("\n")
kolay = open("static/_kolaylik.src.js", encoding="utf-8").read().rstrip("\n")
izle = open("static/_izleme.src.js", encoding="utf-8").read().rstrip("\n")

bas = "  /* ═══════════════ TARAYICI İÇİ TAM AYNA (edge modu)"
son = "  /* ═══════════════ TARAYICI MOTORU (REA tarzı) ═══════════════ */"
i, j = h.find(bas), h.find(son)
if i < 0 or j < 0 or j < i:
    sys.exit("HATA: gömme çıpaları bulunamadı (index.html beklenen biçimde değil)")

yeni = motor + "\n\n" + fit + "\n\n" + derin + "\n\n" + kolay + "\n\n" + izle + "\n\n"
onceki = h[j] if False else h[i:j]
h = h[:i] + yeni + h[j:]
open(idx, "w", encoding="utf-8").write(h)
print("gömüldü: motor %d · fit %d · derin %d · kolaylık %d · izleme %d satır" %
      (motor.count("\n") + 1, fit.count("\n") + 1, derin.count("\n") + 1, kolay.count("\n") + 1, izle.count("\n") + 1))
PY

# söz dizimi denetimi: en büyük <script> bloğunu çıkar ve node ile doğrula
python3 - <<'PY'
import re
h = open("static/index.html", encoding="utf-8").read()
s = max(re.findall(r"<script>(.*?)</script>", h, re.S), key=len)
open("/tmp/mirrorlab-app.js", "w", encoding="utf-8").write(s)
print("script bloğu: %d bayt" % len(s))
PY
node --check /tmp/mirrorlab-app.js && echo "✓ söz dizimi: OK"

# ── ÇAĞRI/TANIM DENETİMİ ──────────────────────────────────────────────────
# Yaşanan hata: çağrı "derinGuvenlikDeğerlendir" (Türkçe ğ), tanım ise
# "derinGuvenlikDegerlendir" (ASCII) → ReferenceError, kart hiç çizilmedi.
# Kural: Türkçe karakter içeren bir çağrının ASCII'ye katlanmış hâli bir tanımla
# eşleşiyorsa bu gerçek bir hatadır (düz metin yanlış pozitif üretmez).
python3 - <<'PY2'
import re, sys
h = open("/tmp/mirrorlab-app.js", encoding="utf-8").read()
katla = str.maketrans({"ğ":"g","ü":"u","ş":"s","ı":"i","ö":"o","ç":"c",
                       "Ğ":"G","Ü":"U","Ş":"S","İ":"I","Ö":"O","Ç":"C"})
tanim = set(re.findall(r"function\s+([A-Za-z_$][\w$]*)\s*\(", h))
tur = "ğüşıöçİĞÜŞÖÇ"
bulunan = sorted(ad for ad in set(re.findall(r"([A-Za-z_$][\w$]*)\s*\(", h))
                 if any(c in tur for c in ad) and ad.translate(katla) in tanim)
if bulunan:
    print("⚠ Türkçe karakterli çağrı tanımı TUTMUYOR:", ", ".join(bulunan))
    sys.exit(3)
print("✓ çağrı/tanım denetimi: temiz")
PY2

echo "✓ static/index.html hazır — yayın için: bash deploy/yayinla.sh"
