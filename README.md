# vikunja-extra

Vikunja self-hosted usado como reemplazo de Linear, más una capa propia que le
agrega **tiempo real por websocket** y **asignación rápida desde la tarjeta**,
sin forkear Vikunja.

Corre en `sora-srv` (notebook con Ubuntu 24.04, Celeron N3050, **1.8 GB de RAM**).
Esa limitación de memoria es la que define todo el diseño: Plane necesita ~4 GB
y Huly ~8 GB, así que quedaron descartados.

## Arquitectura

```
navegador
   │  https (Tailscale Funnel :8443)
   ▼
nginx 127.0.0.1:8080 ──── inyecta <script src="/_extra/extra.js"> con sub_filter
   │                                      │
   │ proxy                                └── /var/www/vikunja-extra/extra.js
   ▼
Vikunja 127.0.0.1:3456 ──► PostgreSQL 16
                                │  triggers vkx_* → pg_notify
                                ▼
                        vikunja-eventos :3457 ──ws──► navegador
```

**No hay polling en ninguna parte.** El cambio lo anuncia Postgres con
`LISTEN/NOTIFY` y el sidecar lo empuja por websocket.

## Contenido

| Ruta | Qué es |
|---|---|
| `frontend/extra.js` | Script inyectado: asignación rápida, avatares en la tarjeta, íconos de estado por columna, cliente websocket |
| `server/eventos.js` | Servicio que escucha Postgres y empuja los cambios por websocket |
| `install/install-vikunja.sh` | Instala Vikunja sobre el PostgreSQL existente, con systemd y backup diario |
| `install/install-extra.sh` | Pone nginx delante e inyecta `extra.js` |
| `install/install-ws.sh` | Triggers en Postgres + servicio `vikunja-eventos` |
| `install/nginx/vikunja-extra.conf` | El vhost completo, fuente de verdad de la config de nginx |
| `install/aplicar.sh` | Lo que corre con privilegios en el servidor durante el deploy |
| `install/setup-deploy.sh` | Habilita el deploy automático (se corre una vez, a mano) |
| `.github/workflows/deploy.yml` | Deploy automático al pushear a `master` |
| `migracion/` | Scripts de migración desde Linear (una sola vez, se conservan como referencia) |
| `mcp/vikunja-mcp.js` | MCP para que Claude cree y modifique tickets, sus etiquetas y sus relaciones; corre dentro de `vikunja-eventos` en `/_extra/mcp`, cada request con el token del que pide ([detalle](mcp/README.md)) |

## Instalación

En orden, con `sudo`:

```bash
sudo bash install/install-vikunja.sh   # solo la primera vez
sudo bash install/install-extra.sh
sudo bash install/install-ws.sh
```

Cada script imprime al final cómo revertirse.

## Deploy

Un push a `master` que toque `frontend/`, `server/`, `mcp/` o `install/nginx/`
dispara el workflow [`Deploy`](.github/workflows/deploy.yml): copia el repo al
servidor y lo instala. No hay que entrar por SSH ni copiar archivos a mano.

El runner de GitHub no resuelve `sora-srv` —vive en la tailnet—, así que se une
a ella con `tailscale/github-action` antes de conectarse. Es el mismo obstáculo
que ya había resuelto Hornerito en el repo de CDF.

### Qué hace, en orden

1. Copia `frontend/`, `server/`, `mcp/` e `install/` a `/opt/vikunja-extra-staging`.
2. Corre `sudo /usr/local/sbin/vikunja-extra-aplicar <sha>`: instala los archivos,
   regenera el vhost con esa versión en el `?v=`, valida con `nginx -t`, recarga
   nginx y reinicia `vikunja-eventos`.
3. Verifica **desde afuera**, contra `https://sora-srv…:8443`, que el HTML sirva
   la versión recién desplegada.

Si `nginx -t` falla o `vikunja-eventos` no contesta `/salud`, el script
**restaura solo** la versión anterior y el workflow queda en rojo. Los respaldos
quedan fechados en `/var/backups/vikunja-extra/`.

A diferencia de Hornerito, este workflow **falla fuerte**: si el deploy no se
aplicó, el servidor quedó con código viejo y hay que enterarse. La única
excepción es el repo todavía sin configurar, que avisa y termina en verde.

### Habilitarlo (una sola vez)

En el servidor:

```bash
sudo ./install/setup-deploy.sh
```

Deja el staging, instala el script privilegiado y habilita correr **solo ese
script** sin password. Después hay que agregar a mano la clave pública de CI en
`~/.ssh/authorized_keys` del usuario de deploy.

Fuera del servidor:

| Dónde | Nombre | Qué es |
|---|---|---|
| Secret | `DEPLOY_SSH_KEY` | La clave **privada** de CI |
| Secret | `TS_OAUTH_CLIENT_ID` | OAuth client de Tailscale, scope `auth_keys`, tag `tag:ci` |
| Secret | `TS_OAUTH_SECRET` | ídem |
| Variable | `DEPLOY_HOST` | Opcional; default `sora-srv.tail97131d.ts.net` |
| Variable | `DEPLOY_USER` | Opcional; default `sora` |

Y en la ACL de Tailscale, `tag:ci` tiene que poder llegar a `sora-srv:22` — hoy
solo tiene habilitado el `:8443` que usa Hornerito.

### Para otro colaborador

Alcanza con permiso de push al repo. Los secrets son del repositorio, no de la
persona: no necesita cuenta en el servidor, ni Tailscale, ni la clave de SSH.

**Lo que eso implica:** quien pueda pushear a `master` puede cambiar el
JavaScript que se le sirve a todo el mundo y el vhost de nginx. Es inherente a
cualquier push-to-deploy. Por eso el script privilegiado **no** se actualiza
desde CI: cambiarlo exige que una persona vuelva a correr `setup-deploy.sh`.

### Sin CI

Sigue andando a mano, igual que antes:

```bash
sudo bash install/install-extra.sh
```

## Decisiones y limitaciones

- **Por qué no forkear Vikunja**: agregar websockets nativos obliga a recompilar
  el backend Go y el frontend Vue, y a reaplicar el parche en cada actualización.
  Además el build del frontend no entra en 1.8 GB de RAM. El sidecar da el mismo
  push en tiempo real y sobrevive a las actualizaciones: lo único de lo que
  depende es del nombre de la tabla `tasks`.
- **El refresco intenta ser quirúrgico y cae a `location.reload()` si no puede.**
  `refrescarSuave()` le pide al store de kanban (`loadBucketsForProject`) que
  vuelva a traer los buckets: el mismo patrón que usa Vikunja internamente
  cuando cambian los filtros de fecha. Depende de internals (`__vue_app__`,
  pinia), así que si una actualización los mueve devuelve `false` y se recarga
  como antes — nunca queda a medias.
- **Los cambios propios ya no refrescan.** El guard existía desde el principio,
  pero solo cubría las acciones de `extra.js`. El drag & drop del kanban es
  código nativo de Vikunja (axios → XHR), así que mover una tarjeta disparaba el
  `NOTIFY`, volvía por el websocket como si fuera de otro, y uno se recargaba a
  sí mismo en cada movimiento. Ahora se envuelven XHR y `fetch` para marcar como
  propia toda escritura a `/api/v1/`.
- **Los assets con hash se cachean un año.** Vikunja los sirve con
  `max-age=0, must-revalidate` y el service worker precachea 226 archivos, así
  que cada carga salía a revalidarlos todos: 226 respuestas `304` que congelaban
  la UI y se veían como un reload. Ese `location` tampoco limpia
  `Accept-Encoding` —`sub_filter` solo trabaja sobre HTML—, con lo que volvió el
  gzip: el bundle principal pasó de 315 KB a 108 KB.
- **El registro público está deshabilitado** a propósito: la instancia es
  accesible desde internet. Las cuentas se crean por CLI.
- Por el websocket viaja únicamente *"cambió algo en el proyecto N"*, nunca
  contenido. Cada cliente se autentica con su token y se verifica contra la API
  que pueda ver ese proyecto antes de avisarle.

## Hechos del DOM de Vikunja

Descubrirlos costó varias iteraciones. Antes de tocar `extra.js`, tenerlos a mano:

- Las tarjetas del Kanban son `div.task.kanban-card`, con un `a[href^="/tasks/"]`.
- Los avatares son `img.avatar` dentro de `span.avatar-wrapper`, y **el `src`
  nunca contiene la palabra "avatar"**: Vikunja los descarga con `fetch` y los
  deja como `blob:`, o usa un SVG en `data:` para quien no subió foto. No se los
  puede detectar por el `src`; hay que ir por la clase.
- **Nada propio debe ir en `position:absolute`**: la barra "+ ADD ANOTHER TASK"
  tapa las tarjetas de abajo, y un elemento absoluto se dibuja por encima de
  ella, quedando visible la foto de una tarjeta fuera de pantalla.
- El markup viene en chunks separados, así que las clases no aparecen en el CSS
  de la página inicial. Ante la duda, medir en el navegador en vez de suponer.

## Pendientes

- [ ] SMTP (hoy `mailer.enabled: false`): sin él nadie recupera su contraseña.
- [ ] Backups fuera de la notebook: hoy el `pg_dump` diario queda en el mismo disco.
- [ ] Reservar la IP del server en el router (es DHCP).
