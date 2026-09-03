#!/usr/bin/env bash
# Instala en su lugar definitivo lo que el deploy dejo en el staging.
#
# Se instala UNA VEZ en /usr/local/sbin/vikunja-extra-aplicar (lo hace
# install/setup-deploy.sh) y NO se actualiza desde CI. Esa es la frontera de
# privilegio: el workflow puede cambiar los archivos que se despliegan, pero no
# puede cambiar el codigo que corre como root. Si se edita este script hay que
# volver a correr setup-deploy.sh a mano, a proposito.
#
# Uso:  sudo /usr/local/sbin/vikunja-extra-aplicar <version>
# <version> es el SHA del commit; va al ?v= del <script> inyectado.
set -euo pipefail

STAGING=/opt/vikunja-extra-staging
DESTINO_WEB=/var/www/vikunja-extra
DESTINO_EVENTOS=/opt/vikunja-eventos
VHOST=/etc/nginx/sites-available/vikunja-extra
RESPALDO=/var/backups/vikunja-extra

VERSION="${1:-$(date +%s)}"

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }
fallo() { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fallo "hay que correrlo como root"
[ -d "$STAGING" ] || fallo "no existe $STAGING (¿corrio el rsync del deploy?)"

for f in frontend/extra.js server/eventos.js server/package.json \
         mcp/vikunja-mcp.js install/nginx/vikunja-extra.conf; do
    [ -f "$STAGING/$f" ] || fallo "falta $f en el staging"
done

# El vhost se valida antes de tocar nada mas: si la config no compila, no tiene
# sentido haber reemplazado los .js primero.
log "Preparando el vhost (version $VERSION)"
TMP_VHOST="$(mktemp)"
sed "s/__VERSION__/${VERSION}/" "$STAGING/install/nginx/vikunja-extra.conf" > "$TMP_VHOST"
grep -q "__VERSION__" "$TMP_VHOST" && fallo "quedo un __VERSION__ sin reemplazar"

log "Respaldando el estado actual"
install -d "$RESPALDO"
SELLO="$(date +%Y%m%d-%H%M%S)"
cp -a "$VHOST" "$RESPALDO/vikunja-extra.conf.$SELLO" 2>/dev/null || true
cp -a "$DESTINO_WEB/extra.js" "$RESPALDO/extra.js.$SELLO" 2>/dev/null || true
cp -a "$DESTINO_EVENTOS/eventos.js" "$RESPALDO/eventos.js.$SELLO" 2>/dev/null || true
cp -a "$DESTINO_EVENTOS/vikunja-mcp.js" "$RESPALDO/vikunja-mcp.js.$SELLO" 2>/dev/null || true
echo "  en $RESPALDO/*.$SELLO"

restaurar() {
    echo "Restaurando el estado anterior..."
    [ -f "$RESPALDO/vikunja-extra.conf.$SELLO" ] && cp -a "$RESPALDO/vikunja-extra.conf.$SELLO" "$VHOST"
    [ -f "$RESPALDO/extra.js.$SELLO" ] && cp -a "$RESPALDO/extra.js.$SELLO" "$DESTINO_WEB/extra.js"
    [ -f "$RESPALDO/eventos.js.$SELLO" ] && cp -a "$RESPALDO/eventos.js.$SELLO" "$DESTINO_EVENTOS/eventos.js"
    [ -f "$RESPALDO/vikunja-mcp.js.$SELLO" ] && cp -a "$RESPALDO/vikunja-mcp.js.$SELLO" "$DESTINO_EVENTOS/vikunja-mcp.js"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    systemctl restart vikunja-eventos || true
}

log "Instalando el frontend"
install -d "$DESTINO_WEB"
install -m 644 "$STAGING/frontend/extra.js" "$DESTINO_WEB/extra.js"

log "Instalando el servicio de eventos"
# `entorno` NO se toca nunca: tiene la clave de Postgres y no esta en el repo.
install -m 644 -o vikunja -g vikunja "$STAGING/server/eventos.js"      "$DESTINO_EVENTOS/eventos.js"
install -m 644 -o vikunja -g vikunja "$STAGING/mcp/vikunja-mcp.js"     "$DESTINO_EVENTOS/vikunja-mcp.js"

# npm install solo si cambiaron las dependencias: es lo unico lento del deploy.
if ! cmp -s "$STAGING/server/package.json" "$DESTINO_EVENTOS/package.json"; then
    log "Cambiaron las dependencias: npm install"
    install -m 644 -o vikunja -g vikunja "$STAGING/server/package.json" "$DESTINO_EVENTOS/package.json"
    ( cd "$DESTINO_EVENTOS" && sudo -u vikunja npm install --omit=dev --no-audit --no-fund >/dev/null )
else
    echo "  dependencias sin cambios"
fi

log "Instalando el vhost"
install -m 644 "$TMP_VHOST" "$VHOST"
rm -f "$TMP_VHOST"
ln -sf "$VHOST" /etc/nginx/sites-enabled/vikunja-extra

if ! nginx -t; then
    restaurar
    fallo "nginx -t fallo con la config nueva; se restauro la anterior"
fi
systemctl reload nginx

log "Reiniciando vikunja-eventos"
systemctl restart vikunja-eventos

log "Verificando"
ok=1
for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    systemctl is-active --quiet vikunja-eventos || continue
    curl -sf -o /dev/null http://127.0.0.1:3457/salud || continue
    ok=0; break
done
[ "$ok" -eq 0 ] || { journalctl -u vikunja-eventos -n 25 --no-pager; restaurar; fallo "vikunja-eventos no quedo sano"; }
echo "  vikunja-eventos: activo y respondiendo /salud"

curl -s http://127.0.0.1:8080/ | grep -q "/_extra/extra.js?v=${VERSION}" \
    || { restaurar; fallo "el HTML no sale con el script de la version ${VERSION}"; }
echo "  el HTML inyecta extra.js?v=${VERSION}"

curl -s -o /dev/null -D - http://127.0.0.1:8080/assets/ 2>/dev/null | head -1 >/dev/null || true

log "LISTO — version $VERSION desplegada"
