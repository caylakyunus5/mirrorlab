#!/usr/bin/env bash
# MirrorLab — arayüzü Surge.sh'a (ücretsiz statik barındırma) yayınlar.
#
#   ./deploy/surge.sh                      → mirrorlab-yunusnavi.surge.sh
#   ./deploy/surge.sh benim-adim           → benim-adim.surge.sh
#
# Gerekli ortam değişkenleri (bir kez verilir, sonra saklanır):
#   SURGE_LOGIN  (e-posta)   SURGE_TOKEN  (surge token)
# Token almak için:  npx surge token
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

DOMAIN="${1:-mirrorlab-yunusnavi}"
API="${MIRRORLAB_API:-https://mirrorlab-edge.yunusnavi.workers.dev}"

command -v surge >/dev/null 2>&1 || { echo "→ surge kuruluyor…"; sudo npm install -g surge --no-audit --no-fund >/dev/null; }

echo "→ arayüz üretiliyor (varsayılan motor: $API)"
bash deploy/huggingface-static/build.sh "--api=$API" >/dev/null

OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
cp deploy/huggingface-static/index.html deploy/huggingface-static/hf-shell.js \
   deploy/huggingface-static/favicon.svg "$OUT"/

echo "→ yayınlanıyor: $DOMAIN.surge.sh"
surge "$OUT" "$DOMAIN.surge.sh"

echo
echo "✓ Arayüz:  https://$DOMAIN.surge.sh"
echo "  Motor  :  $API"
