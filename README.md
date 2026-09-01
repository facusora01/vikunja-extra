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
| `migracion/` | Scripts de migración desde Linear (una sola vez, se conservan como referencia) |

## Instalación

En orden, con `sudo`:

```bash
sudo bash install/install-vikunja.sh   # solo la primera vez
sudo bash install/install-extra.sh
sudo bash install/install-ws.sh
```

Cada script imprime al final cómo revertirse.

## Publicar un cambio del frontend

```bash
sudo install -m 644 frontend/extra.js /var/www/vikunja-extra/extra.js
```

Y recargar con Ctrl+F5. No hace falta reiniciar nginx: `/_extra/` va con
`Cache-Control: no-cache`.

## Decisiones y limitaciones

- **Por qué no forkear Vikunja**: agregar websockets nativos obliga a recompilar
  el backend Go y el frontend Vue, y a reaplicar el parche en cada actualización.
  Además el build del frontend no entra en 1.8 GB de RAM. El sidecar da el mismo
  push en tiempo real y sobrevive a las actualizaciones: lo único de lo que
  depende es del nombre de la tabla `tasks`.
- **El refresco es `location.reload()`**, no una actualización quirúrgica del
  store de Vue. Es instantáneo pero se nota. Actualizar el estado interno de
  Vikunja desde afuera sí requeriría forkearlo.
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
