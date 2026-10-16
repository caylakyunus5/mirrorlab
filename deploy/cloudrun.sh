#!/usr/bin/env bash
# Google Cloud Run'a tek komutla dağıtım (ücretsiz katman: 2M istek, 180k vCPU-sn/ay)
# Ön koşul: gcloud CLI + faturalandırma açık bir proje (ücretsiz kotada kalırsanız ödeme olmaz)
#
#   ./deploy/cloudrun.sh                  → europe-west1, 1 GiB RAM
#   REGION=us-central1 ./deploy/cloudrun.sh
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-mirrorlab}"

if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "HATA: gcloud projesi seçili değil. Önce: gcloud config set project <PROJE_ID>" >&2
  exit 1
fi

echo "→ Proje: $PROJECT · Bölge: $REGION · Servis: $SERVICE"

gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --cpu-boost \
  --timeout 300 \
  --concurrency 4 \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "PORT=8080,MIRRORLAB_ENGINE=auto,MIRRORLAB_ENGINE_CONCURRENCY=1,MIRRORLAB_RATE_LIMIT=40,MIRRORLAB_LOWMEM=0,MIRRORLAB_MAX_PAGES=60" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "✅ Yayında: $URL"
echo "   Sağlık kontrolü: $URL/api/health"
echo
echo "Bütçe koruması (önerilir — yanlışlıkla ücret oluşmasın):"
echo "  1) Cloud Console > Billing > Budgets & alerts → 1 \$ bütçe + %50/%90 uyarı"
echo "  2) Cloud Run > $SERVICE > Revision: 'max instances' 3'te kalsın"
echo "  3) Free tier limitleri: 2M istek, 180.000 vCPU-sn, 360.000 GiB-sn / ay"
