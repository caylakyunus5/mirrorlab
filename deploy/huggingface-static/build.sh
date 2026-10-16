#!/usr/bin/env bash
# MirrorLab — Hugging Face statik Space kabuğunu üretir ve (isteğe bağlı) yayınlar.
#
#   ./deploy/huggingface-static/build.sh              → dosyaları üret (yerel test)
#   ./deploy/huggingface-static/build.sh publish TOKEN → HF'ye gönder (Space: <kullanıcı>/mirrorlab)
#
# Arayüzün tek kaynağı static/index.html; burada ondan bağımsız bir kopya üretilir ve
# hf-shell.js (arka uç seçici) enjekte edilir. Böylece iki sürüm birbirinden ayrışmaz.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
OUT="."

echo "→ arayüz kopyalanıyor: static/index.html"
# Varsayılan motor adresi: MIRRORLAB_API env ya da --api=... argümanı
DEFAULT_API="${MIRRORLAB_API:-}"
for a in "$@"; do case "$a" in --api=*) DEFAULT_API="${a#--api=}";; esac; done

python3 - "$ROOT/static/index.html" "$OUT/index.html" "$DEFAULT_API" <<'PY'
import sys
src, dst, default_api = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")
h = open(src, encoding="utf-8").read()
shell = ""
if default_api:
    shell += '<script>window.MIRRORLAB_DEFAULT_API = %s;</script>\n' % __import__("json").dumps(default_api)
shell += '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n'
shell += '<script src="hf-shell.js"></script>\n'
if "hf-shell.js" not in h:
    # Arayüzün ilk /api/health isteği de doğru adrese gitsin diye <head> içine,
    # ana <script> bloğundan ÖNCE enjekte edilir.
    i = h.find("</head>")
    h = h[:i] + shell + h[i:] if i > -1 else h + shell
open(dst, "w", encoding="utf-8").write(h)
print("   enjekte edildi: hf-shell.js · varsayılan motor:", default_api or "(yok)", "· boyut:", len(h), "bayt")
PY

# statik Space'te sunucu tarafı yok: Python'a özel hiçbir şey kalmadığından emin ol
grep -c "hf-shell.js" index.html >/dev/null && echo "✓ index.html hazır"
echo "✓ dosyalar: $(ls -1 | tr '\n' ' ')"

if [ "${1:-}" = "publish" ]; then
  TOKEN="${2:?kullanım: build.sh publish <HF_TOKEN>}"
  REPO="${3:-mirrorlab}"
  USER=$(curl -s -H "Authorization: Bearer $TOKEN" https://huggingface.co/api/whoami-v2 \
        | python3 -c "import sys,json;print(json.load(sys.stdin)['name'])")
  echo "→ Space: $USER/$REPO"
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$REPO\",\"type\":\"space\",\"sdk\":\"static\",\"private\":false}" \
    https://huggingface.co/api/repos/create | head -c 300; echo

  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  cp README.md index.html hf-shell.js "$TMP"/
  cd "$TMP"
  git init -q -b main
  git -c user.email=mirrorlab@local -c user.name=MirrorLab add -A
  git -c user.email=mirrorlab@local -c user.name=MirrorLab commit -qm "MirrorLab arayüz kabuğu"
  git remote add origin "https://$USER:$TOKEN@huggingface.co/spaces/$USER/$REPO"
  git push -q origin main --force
  echo "✓ gönderildi → https://huggingface.co/spaces/$USER/$REPO"
  echo "  canlı adres: https://$USER-$REPO.static.hf.space"
fi
