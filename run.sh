#!/usr/bin/env bash
# MirrorLab başlatıcı — eksikleri otomatik kurar, sonra sunucuyu çalıştırır.
set -u
cd "$(dirname "$0")" || exit 1

echo "🧪 MirrorLab — Site Tersine Mühendislik Stüdyosu"
echo "-------------------------------------------------"

# 1) Node.js + Puppeteer + Chrome (tarayıcı motoru için)
if command -v node >/dev/null 2>&1; then
  if [ ! -d node_modules/puppeteer ]; then
    echo "→ Puppeteer kuruluyor (npm install)…"
    npm install puppeteer --no-fund --no-audit || echo "  ! Puppeteer kurulamadı; tarayıcı analizi devre dışı kalacak."
  fi
  if [ -d node_modules/puppeteer ]; then
    CHROME="$(node -e "try{console.log(require('puppeteer').executablePath())}catch(e){console.log('')}" 2>/dev/null)"
    if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
      echo "→ Chrome indiriliyor (npx puppeteer browsers install chrome)…"
      npx --yes puppeteer browsers install chrome || echo "  ! Chrome indirilemedi."
    fi
    if ! ldd "$CHROME" 2>/dev/null | grep -q "not found"; then :; else
      echo "  ! Chrome için sistem kütüphaneleri eksik. Şunu çalıştırın:"
      echo "    sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \\"
      echo "      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \\"
      echo "      libpango-1.0-0 libcairo2 libasound2t64 fonts-liberation libxshmfence1"
    fi
  fi
else
  echo "! Node.js bulunamadı — tarayıcı analizi (ağ/API/ekran görüntüsü) devre dışı."
  echo "  Kurulum: sudo apt-get install -y nodejs npm   (veya https://nodejs.org)"
fi

# 2) Sunucu
PORT="${PORT:-8000}"
echo "→ Sunucu başlıyor: http://localhost:${PORT}"
echo
exec python3 server.py
