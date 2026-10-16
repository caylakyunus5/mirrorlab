#!/usr/bin/env bash
# Cloudflare'e tek komutla yayınla (ücretsiz plan, kredi kartı gerekmez)
#   ./deploy/cloudflare/publish.sh
#
# Ne olur:
#   1. wrangler kurulu mu / giriş yapılmış mı kontrol eder
#   2. Worker'ı (arayüz + /api/render + /api/asset + /api/analyze + /api/export + /api/deep) yükler
#   3. Yayın adresini yazdırır ve /api/health ile doğrular
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

echo "🧪 MirrorLab → Cloudflare Workers (ücretsiz)"
echo "-------------------------------------------"

if ! command -v node >/dev/null 2>&1; then
  echo "! Node.js gerekli: sudo apt install -y nodejs npm   (veya https://nodejs.org)" >&2
  exit 1
fi

if [ ! -d node_modules/wrangler ]; then
  echo "→ wrangler kuruluyor…"
  npm install -D wrangler --no-fund --no-audit
fi

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "→ Cloudflare hesabına giriş yapmanız gerekiyor (tarayıcı açılacak):"
  npx wrangler login
fi

echo "→ Deploy ediliyor (ilk seferde ~30 sn, sonra saniyeler)…"
npx wrangler deploy --config deploy/cloudflare/wrangler.toml

URL="$(npx wrangler deployments list --config deploy/cloudflare/wrangler.toml --json 2>/dev/null \
  | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print(d[0].get('url') or '')
except Exception:
    print('')" 2>/dev/null || true)"

if [ -z "$URL" ]; then
  # deployments list JSON vermezse panodan bakılacak; basitçe health'i deneyecek şekilde bilgi ver
  echo
  echo "✅ Deploy tamam. Yayın adresi: https://mirrorlab-edge.<hesabınız>.workers.dev"
  echo "   (Kesin adres deploy çıktısında ve Cloudflare panosunda görünür.)"
else
  echo
  echo "✅ Yayında: $URL"
  curl -fsS --max-time 30 "$URL/api/health" >/dev/null 2>&1 && echo "   /api/health → tamam" || echo "   /api/health → henüz yanıt vermedi, birkaç saniye sonra tekrar deneyin"
fi

cat <<'NOTLAR'

Notlar
------
* Ücretsiz plan: 100.000 istek/gün, istek başına 10 ms CPU. Site uyumaz.
* Derin analiz (/api/deep) Cloudflare Browser Rendering kullanır: ücretsiz kotada günde 10 dakika Chrome.
  Sınır, Workers panelinizde Workers & Pages > mirrorlab-edge > Browser Rendering altında görünür.
* Kendi alan adınız varsa: Workers > mirrorlab-edge > Settings > Domains & Routes → Custom Domain ekleyin (ücretsiz).
* Kötüye kullanımı azaltmak için hız sınırı kod içinde açık (IP başına saatlik).
  Kalıcı/küresel sınır için: Security > WAF > Rate limiting rules.
NOTLAR
