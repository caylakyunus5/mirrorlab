#!/usr/bin/env bash
# Tam özellikli MirrorLab'ı kendi makinenizden ücretsiz HTTPS ile yayınla (Cloudflare Tunnel)
#   ./deploy/tunnel.sh              → geçici *.trycloudflare.com adresi (hesap gerekmez)
#   ./deploy/tunnel.sh kalici       → kalıcı adres için yönergeler (alan adı + named tunnel)
#
# Chrome gerektiren her şey (ağ kaydı, API gövdeleri, ekran görüntüleri, tam ayna ZIP) bu yolda çalışır,
# çünkü uygulama tam sürüm olarak bilgisayarınızda çalışıyor; Tunnel yalnızca kapıyı dışarı açıyor.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-hizli}"
PORT="${PORT:-8000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "! cloudflared kurulu değil. Kurulum (tek satır):"
  echo "   Linux arm64:  curl -L -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared"
  echo "   Linux amd64:  curl -L -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared"
  echo "   macOS:        brew install cloudflared"
  exit 1
fi

if [ "$MODE" = "kalici" ]; then
  cat <<'NASIL'
Kalıcı adres (alan adı gerekir, ücretsiz):
  1) Alan adınızı Cloudflare'e ekleyin (ücretsiz plan, DNS zaten oradaysa hazır)
  2) cloudflared tunnel login          # tarayıcıdan zone seçin
  3) cloudflared tunnel create mirrorlab
  4) cloudflared tunnel route dns mirrorlab mirrorlab.ornek.com
  5) ./deploy/tunnel.sh servis         # systemd servisi olarak kurar (aşağıda)

Şifre koruması (ücretsiz, önerilir): Zero Trust → Access → Applications → Add
  → Self-hosted → alan adınız → politika: "Emails" → kendi e-postanız. Böylece yalnızca siz girebilirsiniz.
NASIL
  exit 0
fi

if [ "$MODE" = "servis" ]; then
  echo "→ systemd servisi kuruluyor (cloudflared, ~/.cloudflared/config.yml gerekir)"
  cloudflared --version
  sudo cloudflared service install || {
    echo "! 'cloudflared service install' başarısız oldu; elle kurulum:"
    echo "  sudo tee /etc/systemd/system/cloudflared.service >/dev/null <<'EOF'"
    echo "  [Unit]"; echo "  Description=Cloudflare Tunnel"; echo "  After=network.target tunnel.target"
    echo "  [Service]"; echo "  ExecStart=/usr/local/bin/cloudflared tunnel run mirrorlab"
    echo "  Restart=always"; echo "  [Install]"; echo "  WantedBy=multi-user.target"; echo "  EOF"
    echo "  sudo systemctl enable --now cloudflared"
  }
  exit 0
fi

# --- hızlı mod: yerel sunucu + geçici genel adres ---
if ! curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "→ Yerel sunucu başlatılıyor (port ${PORT})…"
  (nohup python3 server.py > /tmp/mirrorlab-tunnel.log 2>&1 &)
  for _ in $(seq 1 20); do
    sleep 1
    curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break
  done
fi
curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 \
  && echo "✓ Yerel sunucu ayakta: http://127.0.0.1:${PORT}" \
  || { echo "! Yerel sunucu başlamadı; /tmp/mirrorlab-tunnel.log dosyasına bakın."; exit 1; }

echo
echo "→ Cloudflare Tunnel açılıyor (geçici genel adres). Durdurmak için Ctrl+C."
echo "  (İlk istek birkaç saniye gecikebilir; adres her açılışta değişir.)"
echo
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate
