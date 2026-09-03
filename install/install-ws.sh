#!/usr/bin/env bash
# Instala vikunja-eventos: triggers en Postgres + servicio WebSocket.
# No toca Vikunja. Idempotente. Ver "PARA REVERTIR" al final.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Correr con sudo"; exit 1; }

DIR=/opt/vikunja-eventos
# Antes FUENTE=/home/sora/migracion, una ruta de la primera instalacion que
# ya no existe en el repo. Ahora los archivos salen del propio checkout.
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=vikunja
ROL=vikunja_eventos

log() { echo -e "\n\033[1;32m==>\033[0m $*"; }

log "Rol de solo-escucha en Postgres"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${ROL}'" | grep -q 1; then
    PASS="$(grep -oP '(?<=^PGPASSWORD=).*' ${DIR}/entorno 2>/dev/null || true)"
    [ -n "$PASS" ] || { echo "El rol existe pero no encuentro la clave. Borrar el rol y reintentar."; exit 1; }
else
    PASS="$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)"
    sudo -u postgres psql -qc "CREATE ROLE ${ROL} LOGIN PASSWORD '${PASS}'"
fi
sudo -u postgres psql -qc "GRANT CONNECT ON DATABASE ${DB} TO ${ROL}"

log "Triggers de notificacion"
# Se crean solo sobre las tablas que existan en esta version de Vikunja.
sudo -u postgres psql -d "${DB}" <<'SQL'
-- Cambios sobre la tabla de tareas: el project_id esta en la fila
CREATE OR REPLACE FUNCTION vkx_notify_task() RETURNS trigger AS $$
DECLARE fila record; BEGIN
    fila := COALESCE(NEW, OLD);
    PERFORM pg_notify('vikunja_cambio', json_build_object(
        'project_id', fila.project_id, 'tabla', TG_TABLE_NAME, 'op', TG_OP)::text);
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- Cambios sobre tablas relacionadas: hay que resolver el proyecto por el task_id
CREATE OR REPLACE FUNCTION vkx_notify_rel() RETURNS trigger AS $$
DECLARE fila record; pid bigint; BEGIN
    fila := COALESCE(NEW, OLD);
    SELECT project_id INTO pid FROM tasks WHERE id = fila.task_id;
    IF pid IS NOT NULL THEN
        PERFORM pg_notify('vikunja_cambio', json_build_object(
            'project_id', pid, 'tabla', TG_TABLE_NAME, 'op', TG_OP)::text);
    END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t text; BEGIN
    -- tabla principal
    IF to_regclass('public.tasks') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS vkx_tasks ON tasks';
        EXECUTE 'CREATE TRIGGER vkx_tasks AFTER INSERT OR UPDATE OR DELETE ON tasks
                 FOR EACH ROW EXECUTE FUNCTION vkx_notify_task()';
        RAISE NOTICE 'trigger en tasks';
    END IF;
    -- tablas relacionadas (solo las que existan)
    FOREACH t IN ARRAY ARRAY['task_assignees','label_tasks','labels_tasks','task_comments',
                             'task_buckets','task_relations','task_attachments'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS vkx_%s ON %I', t, t);
            EXECUTE format('CREATE TRIGGER vkx_%s AFTER INSERT OR UPDATE OR DELETE ON %I
                            FOR EACH ROW EXECUTE FUNCTION vkx_notify_rel()', t, t);
            RAISE NOTICE 'trigger en %', t;
        END IF;
    END LOOP;
END $$;
SQL
sudo -u postgres psql -d "${DB}" -qc "GRANT SELECT ON tasks TO ${ROL}"

log "Servicio"
install -d "${DIR}"
install -m 644 "${RAIZ}/server/eventos.js"  "${DIR}/eventos.js"
install -m 644 "${RAIZ}/mcp/vikunja-mcp.js" "${DIR}/vikunja-mcp.js"
# El package.json se versiona en server/. Antes se escribia aca con un heredoc,
# asi que las dependencias del servicio no figuraban en ningun archivo del repo.
install -m 644 "${RAIZ}/server/package.json" "${DIR}/package.json"
( cd "${DIR}" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 )
echo "  dependencias instaladas"

printf 'PGPASSWORD=%s\n' "${PASS}" > "${DIR}/entorno"
chmod 600 "${DIR}/entorno"

id -u vikunja &>/dev/null || useradd --system --shell /usr/sbin/nologin vikunja
chown -R vikunja:vikunja "${DIR}"

cat > /etc/systemd/system/vikunja-eventos.service <<EOF
[Unit]
Description=Vikunja eventos (websocket)
After=network.target postgresql.service vikunja.service
Wants=postgresql.service

[Service]
User=vikunja
Group=vikunja
WorkingDirectory=${DIR}
EnvironmentFile=${DIR}/entorno
# El MCP habla con Vikunja por localhost, no da la vuelta por el Funnel
Environment=VIKUNJA_URL=http://127.0.0.1:3456
ExecStart=/usr/bin/node ${DIR}/eventos.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
# enable --now no reinicia un servicio que ya esta activo: sin el restart, el
# proceso viejo sigue corriendo con el eventos.js de antes.
systemctl enable --now vikunja-eventos
systemctl restart vikunja-eventos
sleep 4
systemctl is-active --quiet vikunja-eventos || { journalctl -u vikunja-eventos -n 25 --no-pager; exit 1; }
curl -s http://127.0.0.1:3457/salud; echo

# El vhost de nginx ya no se parchea desde aca. Antes este script le insertaba
# los location de /_extra/ws y /_extra/mcp con awk y sed sobre el archivo que
# habia escrito install-extra.sh, y el resultado completo solo existia en el
# servidor: no habia forma de revisarlo en un diff. Ahora el vhost entero se
# versiona en install/nginx/vikunja-extra.conf.
log "Falta instalar el vhost"
echo "  Correr ./install/install-extra.sh (instala nginx y el frontend)."

log "LISTO"
echo "Servicio:  systemctl status vikunja-eventos"
echo "Salud:     curl -s http://127.0.0.1:3457/salud"
echo "Logs:      journalctl -u vikunja-eventos -f"
echo "MCP:       curl -s -X POST https://sora-srv.tail97131d.ts.net:8443/_extra/mcp  (401 sin token = OK)"
echo
echo "PARA REVERTIR:"
echo "  sudo systemctl disable --now vikunja-eventos"
echo "  sudo -u postgres psql -d vikunja -c \"DROP TRIGGER IF EXISTS vkx_tasks ON tasks\""
echo "  (y los demas triggers vkx_*; las funciones son vkx_notify_task/vkx_notify_rel)"
