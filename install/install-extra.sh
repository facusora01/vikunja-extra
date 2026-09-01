#!/usr/bin/env bash
# Pone nginx delante de Vikunja para inyectar /_extra/extra.js en el HTML.
# Reversible: ver el bloque "PARA REVERTIR" al final.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Correr con sudo"; exit 1; }

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }

log "Chequeo del modulo sub_filter"
nginx -V 2>&1 | grep -q with-http_sub_module && echo "  sub_filter disponible" \
    || { echo "ERROR: nginx sin http_sub_module"; exit 1; }

log "Copiando el script"
install -d /var/www/vikunja-extra
install -m 644 /home/sora/migracion/extra.js /var/www/vikunja-extra/extra.js

log "Configurando nginx en 127.0.0.1:8080"
cat > /etc/nginx/sites-available/vikunja-extra <<'EOF'
# Proxy delante de Vikunja que inyecta el script propio en el HTML.
server {
    listen 127.0.0.1:8080;
    server_name _;

    client_max_body_size 25m;

    location /_extra/ {
        alias /var/www/vikunja-extra/;
        add_header Cache-Control "no-cache";
    }

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # sub_filter no puede trabajar sobre respuestas comprimidas
        proxy_set_header Accept-Encoding "";
        proxy_read_timeout 300s;

        sub_filter '</head>' '<script src="/_extra/extra.js?v=VERSION"></script></head>';
        sub_filter_once on;
    }
}
EOF
sed -i "s/VERSION/$(date +%s)/" /etc/nginx/sites-available/vikunja-extra

# $connection_upgrade tiene que existir; se define una sola vez a nivel http
if ! grep -rq 'map \$http_upgrade \$connection_upgrade' /etc/nginx/conf.d/ /etc/nginx/nginx.conf 2>/dev/null; then
    cat > /etc/nginx/conf.d/upgrade-map.conf <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
EOF
fi

ln -sf /etc/nginx/sites-available/vikunja-extra /etc/nginx/sites-enabled/vikunja-extra
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
