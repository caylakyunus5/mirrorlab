#!/usr/bin/env bash
# MirrorLab — ücretsiz yüzeylere tam yayın (Surge + Hugging Face statik Space).
#
#   bash deploy/yayinla.sh [WORKER_URL]
#
# Sıra ÖNEMLİ: 1) modülleri index.html'e göm → 2) HF kabuğunu üret → 3) yayınla.
#   bash deploy/embed.sh                       (static/*.src.js → static/index.html)
#   bash deploy/huggingface-static/build.sh    (static/index.html → hf index.html)
#   surge …                                    (Surge)
#   git push                                   (HF Space)
set -euo pipefail
cd "$(dirname "$0")/.."
API="${1:-${MIRRORLAB_API:-https://mirrorlab-edge.yunusnavi.workers.dev}}"
SURGE_DOMAIN="${SURGE_DOMAIN:-mirrorlab-yunusnavi.surge.sh}"

echo "── 1/5 modüller gömülüyor"
bash deploy/embed.sh | tail -2

echo "── 2/5 arayüz kabuğu üretiliyor (motor: $API)"
bash deploy/huggingface-static/build.sh --api="$API" | tail -2

echo "── 3/5 Surge yayını"
if [ -z "${SURGE_TOKEN:-}" ]; then
  echo "   ! SURGE_TOKEN yok. Önce: export SURGE_LOGIN=... SURGE_TOKEN=... (token repoya yazılmaz)"
  echo "   (Surge atlandı; HF yayınına devam ediliyor)"
  SURGE_ATLA=1
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp deploy/huggingface-static/index.html deploy/huggingface-static/hf-shell.js \
   deploy/huggingface-static/favicon.svg "$TMP"/
[ -f deploy/huggingface-static/README.md ] && cp deploy/huggingface-static/README.md "$TMP"/
[ -f /tmp/surge-out/kaynak-test.html ] && cp /tmp/surge-out/kaynak-test.html "$TMP"/   # kaynak haritası testi (varsa)
[ -f /tmp/surge-out/robots.txt ] && cp /tmp/surge-out/robots.txt "$TMP"/                 # test alanı izin verir (yoksa Surge "Disallow: /" koyuyor)
[ -z "${SURGE_ATLA:-}" ] && npx --yes surge "$TMP" "$SURGE_DOMAIN" | tail -2

echo "── 4/5 GitHub Pages için docs/ güncelleniyor"
mkdir -p docs
cp deploy/huggingface-static/index.html docs/index.html
cp deploy/huggingface-static/hf-shell.js docs/hf-shell.js
cp deploy/huggingface-static/favicon.svg docs/favicon.svg
echo "   ✓ docs/index.html · docs/hf-shell.js · docs/favicon.svg (yayın adresi: https://<kullanici>.github.io/mirrorlab/)"

if [ "${HF_YAYIN:-}" != "1" ]; then
  echo "── HF yayını atlandı (kullanılmıyor · açmak için HF_YAYIN=1)"
  echo
  echo "✅ yayın tamam:"
  echo "   arayüz : https://$SURGE_DOMAIN"
  echo "   arayüz : GitHub Pages (docs/) — bash deploy/github-yayin.sh ile push edilir"
  echo "   motor  : $API"
  exit 0
fi
echo "── 5/5 Hugging Face yayını (isteğe bağlı)"
KOK=$(ls -dt /tmp/tmp.*/ 2>/dev/null | while read -r d; do
        grep -q "huggingface.co/spaces/.*/mirrorlab" "$d/.git/config" 2>/dev/null && { echo "$d"; break; }; done || true)
if [ -z "$KOK" ]; then
  echo "   ! HF klonu bulunamadı (token'lı git remote yok) — yalnızca arayüz dosyalarını /tmp'ye kopyaladım:"
  echo "     $TMP/hf-icin-*"
  exit 0
fi
cp deploy/huggingface-static/index.html deploy/huggingface-static/hf-shell.js \
   deploy/huggingface-static/favicon.svg "$KOK"/
cd "$KOK"
git -c user.email=mirrorlab@local -c user.name=MirrorLab add -A
git -c user.email=mirrorlab@local -c user.name=MirrorLab commit -qm "MirrorLab yayını $(date -u +%Y-%m-%dT%H:%M:%SZ)" || echo "   (değişiklik yok)"
git push -q origin main --force && echo "   ✓ HF Space güncellendi"
echo
echo "✅ yayın tamam:"
echo "   arayüz : https://$SURGE_DOMAIN"
echo "   arayüz : GitHub Pages — docs/ klasörü commit'lenip push edilmeli (bash deploy/github-yayin.sh)"
echo "   motor  : $API"
