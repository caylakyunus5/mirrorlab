# MirrorLab — üretim imajı (Python sunucu + Node/Puppeteer + headless Chrome)
# Tek konteyner: hem arayüz hem motor. Her ücretsiz Docker barındırmada çalışır.

FROM node:22-slim

# Chrome'un çalışma zamanı bağımlılıkları + Python 3 (sunucu yalnızca stdlib kullanır)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-minimal fonts-liberation \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libxshmfence1 libx11-xcb1 \
    && (apt-get install -y --no-install-recommends libasound2 \
        || apt-get install -y --no-install-recommends libasound2t64) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    PUPPETEER_SKIP_DOWNLOAD=0 \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1

# Önce bağımlılıklar (katman önbelleği için)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx puppeteer browsers install chrome \
 && npm cache clean --force

# Kaynak kod
COPY . .

# Çalışma zamanı dizinleri ve port
RUN mkdir -p /app/output/shots /app/output/jobs && chmod -R 777 /app/output
ENV PORT=8000 \
    MIRRORLAB_ENGINE=auto \
    MIRRORLAB_ENGINE_CONCURRENCY=1 \
    MIRRORLAB_RATE_LIMIT=40 \
    MIRRORLAB_LOWMEM=0
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=6s --start-period=25s --retries=3 \
  CMD python3 -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/api/health',timeout=5)" || exit 1

CMD ["python3", "server.py"]
