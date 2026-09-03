#!/usr/bin/env bash
# Habilita el deploy automatico desde GitHub Actions. Se corre UNA VEZ, a mano,
# con sudo, en sora-srv. Idempotente: se puede repetir sin romper nada.
#
#   sudo ./install/setup-deploy.sh [usuario-de-deploy]
#
# QUE DEJA CONFIGURADO
#   1. El staging /opt/vikunja-extra-staging, donde el workflow deja el repo.
#   2. /usr/local/sbin/vikunja-extra-aplicar (copia de install/aplicar.sh), que
#      es lo unico que corre con privilegios.
#   3. Un permiso acotado para ejecutar SOLO ese script sin pedir password.
#
# POR QUE ASI Y NO UN PERMISO GENERAL
# El workflow tiene que escribir en /etc/nginx y reiniciar servicios. Dar un
# permiso amplio al usuario de deploy convierte "push al repo" en "control
# total del servidor" para cualquiera con acceso al repo. Con esta forma quien
# pushea controla el CONTENIDO que se despliega —que ya es bastante, y es
# inevitable en cualquier push-to-deploy— pero no el codigo privilegiado que lo
# instala: ese solo cambia si una persona vuelve a correr este script a mano.
set -euo pipefail

USUARIO="${1:-sora}"
STAGING=/opt/vikunja-extra-staging
APLICAR=/usr/local/sbin/vikunja-extra-aplicar
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }
fallo() { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fallo "correr con sudo"
id "$USUARIO" &>/dev/null || fallo "el usuario '$USUARIO' no existe"
[ -f "$AQUI/aplicar.sh" ] || fallo "no encuentro aplicar.sh junto a este script"

log "Staging en $STAGING"
install -d -o "$USUARIO" -g "$USUARIO" -m 755 "$STAGING"

log "Instalando el script privilegiado en $APLICAR"
install -m 755 -o root -g root "$AQUI/aplicar.sh" "$APLICAR"

log "Permiso acotado para el deploy"
REGLA=/etc/sudoers.d/vikunja-extra-deploy
printf '%s ALL=(root) NOPASSWD: %s, %s *\n' "$USUARIO" "$APLICAR" "$APLICAR" > "$REGLA"
chmod 440 "$REGLA"
visudo -cf "$REGLA" || { rm -f "$REGLA"; fallo "la regla no valida; se borro"; }
echo "  ${USUARIO} puede correr ${APLICAR} sin password, y nada mas"

log "LISTO"
cat <<EOF

FALTA LA CLAVE DE CI (se hace a mano, una vez):
  El workflow entra por SSH como '${USUARIO}'. Hay que agregar la clave publica
  del par de CI al final de ~${USUARIO}/.ssh/authorized_keys. Conviene
  anteponerle las opciones 'restrict,pty ' para que esa clave solo sirva para
  correr comandos y no como puente hacia el resto de la tailnet.

FALTA LO QUE VIVE FUERA DEL SERVIDOR:
  1. Secrets del repo (Settings -> Secrets and variables -> Actions):
       DEPLOY_SSH_KEY      la clave PRIVADA cuyo par publico se autorizo arriba
       TS_OAUTH_CLIENT_ID  OAuth client de Tailscale con scope auth_keys
       TS_OAUTH_SECRET     y tag tag:ci
     Variables (no secretas):
       DEPLOY_HOST         sora-srv.tail97131d.ts.net   (default si falta)
       DEPLOY_USER         ${USUARIO}                   (default si falta)

  2. ACL de Tailscale: tag:ci tiene que poder llegar a sora-srv al puerto 22.
     Hornerito ya usa tag:ci contra el 8443; hay que sumarle el 22.

PARA REVERTIR:
  sudo rm ${REGLA} ${APLICAR}
  sudo rm -rf ${STAGING}
  (y sacar la clave de CI de ~${USUARIO}/.ssh/authorized_keys)
EOF
