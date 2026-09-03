#!/usr/bin/env bash
# Pone nginx delante de Vikunja para inyectar /_extra/extra.js en el HTML.
# Instalacion inicial: para actualizar despues esta el deploy (ver README).
# Reversible: ver el bloque "PARA REVERTIR" al final.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Correr con sudo"; exit 1; }

# Antes esto apuntaba a /home/sora/migracion, una ruta que quedo de la primera
# instalacion y que ya no existe en el repo. Ahora sale del propio checkout.
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VHOST=/etc/nginx/sites-available/vikunja-extra

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }

log "Chequeo del modulo sub_filter"
nginx -V 2>&1 | grep -q with-http_sub_module && echo "  sub_filter disponible" \
    || { echo "ERROR: nginx sin http_sub_module"; exit 1; }

log "Copiando el script"
install -d /var/www/vikunja-extra
install -m 644 "${RAIZ}/frontend/extra.js" /var/www/vikunja-extra/extra.js

# $connection_upgrade tiene que existir; se define una sola vez a nivel http
if ! grep -rq 'map \$http_upgrade \$connection_upgrade' /etc/nginx/conf.d/ /etc/nginx/nginx.conf 2>/dev/null; then
    cat > /etc/nginx/conf.d/upgrade-map.conf <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
EOF
fi

log "Configurando nginx en 127.0.0.1:8080"
# El vhost completo vive en install/nginx/vikunja-extra.conf. Antes se escribia
# aca con un heredoc y despues install-ws.sh le insertaba los location de /ws y
# /mcp con awk y sed: la config entera solo existia en el servidor y no se
# podia revisar en un diff.
sed "s/__VERSION__/$(date +%s)/" "${RAIZ}/install/nginx/vikunja-extra.conf" > "$VHOST"
chmod 644 "$VHOST"
ln -sf "$VHOST" /etc/nginx/sites-enabled/vikunja-extra
nginx -t
systemctl reload nginx

log "Verificando que el script quede inyectado"
sleep 1
if curl -s http://127.0.0.1:8080/ | grep -q '/_extra/extra.js'; then
    echo "  OK: el HTML sale con el script"
else
    echo "  ERROR: no se inyecto; revisar 'curl -s http://127.0.0.1:8080/ | head -20'"
    exit 1
fi
curl -s -o /dev/null -w "  extra.js -> HTTP %{http_code}\n" http://127.0.0.1:8080/_extra/extra.js

log "Apuntando el Funnel al proxy"
tailscale funnel --bg --https=8443 http://127.0.0.1:8080

log "LISTO"
echo "Probar en https://sora-srv.tail97131d.ts.net:8443/"
echo
echo "PARA REVERTIR:"
echo "  sudo rm /etc/nginx/sites-enabled/vikunja-extra && sudo systemctl reload nginx"
echo "  sudo tailscale funnel --bg --https=8443 http://127.0.0.1:3456"
