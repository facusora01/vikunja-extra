#!/usr/bin/env bash
# Instala Vikunja 2.6.0 en Ubuntu 24.04 reutilizando el PostgreSQL 16 existente.
# Expone via Tailscale Funnel en https://sora-srv.tail97131d.ts.net:8443
# Idempotente: se puede volver a correr sin romper nada.
set -euo pipefail

VER="2.6.0"
URL="https://github.com/go-vikunja/vikunja/releases/download/v${VER}/vikunja-v${VER}-linux-amd64-full.zip"
DB_NAME="vikunja"
DB_USER="vikunja"
PUBLIC_URL="https://sora-srv.tail97131d.ts.net:8443/"
PORT="3456"

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Correr con sudo"; exit 1; }

log "Dependencias"
apt-get update -qq
apt-get install -y -qq unzip curl >/dev/null

log "Usuario de sistema"
id -u vikunja &>/dev/null || useradd --system --home /var/lib/vikunja --shell /usr/sbin/nologin vikunja
install -d -o vikunja -g vikunja /var/lib/vikunja /var/lib/vikunja/files /var/log/vikunja
install -d /etc/vikunja

log "Base de datos"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    echo "El rol ya existe, conservo la contraseña actual"
    DB_PASS="$(grep -oP '(?<=^  password: ").*(?=")' /etc/vikunja/config.yml 2>/dev/null || true)"
    [ -n "$DB_PASS" ] || { echo "ERROR: rol existente pero sin config previa. Borrar el rol y reintentar."; exit 1; }
else
    DB_PASS="$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)"
    sudo -u postgres psql -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
    || sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

log "Binario v${VER}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 300 -o "$tmp/v.zip" "$URL"
unzip -qo "$tmp/v.zip" -d "$tmp"
bin="$(find "$tmp" -type f -name 'vikunja-*-linux-amd64' | head -1)"
[ -n "$bin" ] || bin="$(find "$tmp" -type f -name 'vikunja*' ! -name '*.zip' ! -name '*.txt' | head -1)"
systemctl stop vikunja 2>/dev/null || true
install -m 755 "$bin" /usr/local/bin/vikunja
/usr/local/bin/vikunja version

log "Configuracion"
if [ ! -f /etc/vikunja/config.yml ]; then JWT="$(openssl rand -hex 32)"; else
    JWT="$(grep -oP '(?<=^  jwtsecret: ").*(?=")' /etc/vikunja/config.yml)"; fi
cat > /etc/vikunja/config.yml <<EOF
service:
  jwtsecret: "${JWT}"
  interface: "127.0.0.1:${PORT}"
  publicurl: "${PUBLIC_URL}"
  # Registro cerrado: la instancia es publica, las cuentas las creas vos.
  enableregistration: false
  timezone: America/Argentina/Buenos_Aires
  enablepublicteams: false

database:
  type: postgres
  host: localhost
  user: ${DB_USER}
  password: "${DB_PASS}"
  database: ${DB_NAME}
  sslmode: disable

files:
  basepath: /var/lib/vikunja/files
  maxsize: 20MB

log:
  path: /var/log/vikunja
  level: INFO

# SMTP: completar cuando tengas la app-password de Gmail y poner enabled: true
mailer:
  enabled: false
  host: smtp.gmail.com
  port: 587
  username: ""
  password: ""
  fromemail: ""
EOF
chown root:vikunja /etc/vikunja/config.yml
chmod 640 /etc/vikunja/config.yml

log "Servicio systemd"
cat > /etc/systemd/system/vikunja.service <<'EOF'
[Unit]
Description=Vikunja
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=vikunja
Group=vikunja
WorkingDirectory=/var/lib/vikunja
ExecStart=/usr/local/bin/vikunja
Restart=on-failure
RestartSec=5
Environment=VIKUNJA_SERVICE_ROOTPATH=/var/lib/vikunja
# Hardening: el servicio queda expuesto publicamente
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/vikunja /var/log/vikunja
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now vikunja
sleep 8
systemctl is-active --quiet vikunja || { journalctl -u vikunja -n 30 --no-pager; exit 1; }

log "Backup diario de la base (14 dias de retencion)"
install -d /var/backups/vikunja
cat > /etc/cron.daily/vikunja-backup <<'EOF'
#!/bin/sh
set -e
d="/var/backups/vikunja"
sudo -u postgres pg_dump -Fc vikunja > "$d/vikunja-$(date +%F).dump"
find "$d" -name 'vikunja-*.dump' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/vikunja-backup

log "Publicando en Tailscale Funnel :8443"
tailscale funnel --bg --https=8443 "http://127.0.0.1:${PORT}" || \
    echo "OJO: el funnel fallo, revisar con: tailscale funnel status"

log "LISTO"
echo "URL publica: ${PUBLIC_URL}"
echo
echo "Falta crear tu usuario admin (el registro publico esta cerrado):"
echo "  sudo vikunja -c /etc/vikunja/config.yml user create -u TUUSUARIO -e TUMAIL"
