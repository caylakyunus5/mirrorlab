#!/usr/bin/env bash
# Cloudflare Browser Rendering (ücretsiz: günde 10 dk) üzerinden tarayıcı analizi çalıştırır.
# Yerel Chrome indirmeye gerek yoktur.
#
# Kullanım:
#   export CF_ACCOUNT_ID="<hesap-id>"
#   export CF_API_TOKEN="<Browser Rendering - Edit izinli token>"
#   ./deploy/cloudflare/run-remote-engine.sh https://ornek.com cikti.json [probe] [mobile]
#
# Not: Puppeteer'ı Chrome olmadan kurmak için →  PUPPETEER_SKIP_DOWNLOAD=1 npm install puppeteer
set -euo pipefail
cd "$(dirname "$0")/../.." || exit 1

URL="${1:-}"
OUT="${2:-analiz.json}"
PROBE="${3:-0}"      # 1 = gezinme bağlantılarına tıklama sondası (daha çok tarayıcı süresi harcar)
MOBILE="${4:-0}"     # 1 = mobil ekran görüntüsü de al (ekstra ~3-5 sn)

if [ -z "$URL" ]; then
  echo "kullanım: $0 <url> <cikti.json> [probe 0|1] [mobile 0|1]" >&2
  exit 2
fi
if [ -z "${CF_ACCOUNT_ID:-}" ] || [ -z "${CF_API_TOKEN:-}" ]; then
  echo "HATA: CF_ACCOUNT_ID ve CF_API_TOKEN ortam değişkenleri gerekli." >&2
  echo "  Token oluşturma: Cloudflare panosu > My Profile > API Tokens > 'Browser Rendering - Edit'" >&2
  exit 2
fi
if ! node -e "require('puppeteer')" 2>/dev/null; then
  echo "HATA: puppeteer kurulu değil. Çalıştırın:" >&2
  echo "  PUPPETEER_SKIP_DOWNLOAD=1 npm install puppeteer" >&2
  exit 2
fi

export MIRRORLAB_BROWSER_WS="wss://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-run/devtools/browser?keep_alive=120000"
export MIRRORLAB_BROWSER_TOKEN="$CF_API_TOKEN"

CFG="$(mktemp)"
python3 - "$URL" "$OUT" "$CFG" "$PROBE" "$MOBILE" <<'PY'
import json, sys, os
url, out, cfg, probe, mobile = sys.argv[1:6]
json.dump({
    "url": url,
    "outDir": os.path.join(os.getcwd(), "output"),
    "jobId": "cf" + str(int(__import__("time").time())),
    "outFile": out,
    "probe": probe == "1",
    "probeCount": 2,
    "mobile": mobile == "1",
    "maxTotalMs": 60000,
}, open(cfg, "w", encoding="utf-8"))
PY

echo "→ Cloudflare tarayıcısına bağlanılıyor (ücretsiz katman: günde 10 dk)…"
node engine.js "$CFG"
rm -f "$CFG"

python3 - "$OUT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("Sonuç okunamadı:", e); raise SystemExit(1)
print()
print("  ok:", d.get("ok"), "| hata:", d.get("error"))
print("  süre:", round((d.get("elapsedMs") or 0) / 1000, 1), "sn")
print("  ağ isteği:", len(d.get("network") or []), "| API çağrısı:", len(d.get("api") or []))
print("  bölüm:", len(d.get("sections") or []), "| ekran görüntüsü:", len(d.get("screenshots") or {}))
print("  çatılar:", ", ".join(f.get("name", "") for f in (d.get("frameworks") or [])) or "—")
print("  renkler:", ", ".join(c.get("value", "") for c in (d.get("design", {}).get("colors") or [])[:6]))
if d.get("remoteBrowser"):
    print("  uzak tarayıcı:", d["remoteBrowser"]["endpoint"][:70])
PY
echo
echo "Çıktı: $OUT (tam kanıt paketi) · ekran görüntüleri: output/shots/"
