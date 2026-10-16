#!/usr/bin/env bash
# MirrorLab — açık kaynak GitHub deposunu oluşturur ve ilk sürümü gönderir.
#
#   GITHUB_TOKEN=ghp_... bash deploy/github-yayin.sh [kullanici/mirrorlab] [--ozel]
#
# Token yalnızca ortam değişkeninden okunur; hiçbir dosyaya yazılmaz.
# Token kapsamı: "repo" (public/private repo oluşturup push etmek için yeterli).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:-}"
OZEL="${2:-}"
TOKEN="${GITHUB_TOKEN:?kullanım: GITHUB_TOKEN=... bash deploy/github-yayin.sh [kullanici/repo]}"

KULLANICI=$(curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user | python3 -c "import sys,json;print(json.load(sys.stdin)['login'])")
REPO="${REPO:-$KULLANICI/mirrorlab}"
echo "→ depo: $REPO  (hesap: $KULLANICI)"

GIZLI=false; [ "$OZEL" = "--ozel" ] && GIZLI=true
# Depo zaten varsa oluşturmayı deneme (GitHub "Repository creation failed." döner)
DURUM=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO")
if [ "$DURUM" = "200" ]; then
  echo "   ℹ depo zaten var → mevcut depoya gönderilecek: https://github.com/$REPO"
else
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -d "{\"name\":\"${REPO##*/}\",\"description\":\"Site tersine mühendislik stüdyosu: tarayıcı analizi, tam site aynası (ZIP), REA derinliği, izleme ve fark — Türkçe arayüz, ücretsiz katman\",\"private\":$GIZLI,\"has_issues\":true,\"has_wiki\":false}" \
    https://api.github.com/user/repos | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('   ✓ depo oluşturuldu:', d['html_url']) if d.get('html_url') else print('   ⚠ depo oluşturulamadı:', d.get('message'))"
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "→ dosyalar kopyalanıyor (node_modules/output hariç)"
tar --exclude=node_modules --exclude=.wrangler --exclude=output --exclude=.git --exclude='*.zip' -cf - . | (cd "$TMP" && tar -xf -)
cd "$TMP"
git init -q -b main
git -c user.email=mirrorlab@local -c user.name=MirrorLab add -A
git -c user.email=mirrorlab@local -c user.name=MirrorLab commit -qm "MirrorLab ilk sürüm: tarayıcı analizi, Tam Ayna, REA derinliği, izleme ve fark"
git remote add origin "https://$KULLANICI:$TOKEN@github.com/$REPO.git"
git push -q origin main --force
echo "✓ gönderildi: https://github.com/$REPO"
echo "  (token'ı sızdırmamak için uzak adres yalnızca bu geçici kopyada kullanıldı)"
