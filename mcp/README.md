# vikunja-mcp

MCP para que Claude pueda leer y modificar los tickets de Vikunja: crear,
editar, mover de columna, asignar, comentar y etiquetar.

Corre **dentro de vikunja-eventos** en `sora-srv`, como una ruta HTTP mas
(`/_extra/mcp`) del proceso que ya empuja los websockets — no suma proceso ni
RAM. Cada request trae el token de Vikunja de quien la hace en el header
`Authorization`, asi que un solo servicio atiende a todo el equipo y cada
accion queda con el autor y los permisos correctos.

Del lado de cada persona no se instala **nada**: ni Node, ni archivos, ni
`claude mcp add`. Solo el token.

## Para cada integrante del equipo

1. Tener cuenta en Vikunja con acceso a los proyectos (las crea el admin, el
   registro esta cerrado).
2. Sacar un token: avatar → **Ajustes** → **Tokens API** → crear uno llamado
   `claude`, marcando **Tasks** (todo), **Projects → read all**,
   **Labels → read all**. Se muestra una sola vez; es una credencial, no va al
   repo ni por chat grupal.
3. Guardarlo como variable de entorno `VIKUNJA_TOKEN`:
   - Windows: `setx VIKUNJA_TOKEN tk_...` y reabrir la terminal
   - Linux/Mac: `export VIKUNJA_TOKEN=tk_...` en el `.bashrc` o `.zshrc`
4. Abrir Claude en el repo del proyecto (que ya declara el MCP en su
   `.mcp.json`) y aceptar cuando pregunte.

Verificar: pedirle a Claude *"con que usuario de Vikunja estas conectado"*.

La entrada del `.mcp.json` del repo compartido es solo esto:

```json
"vikunja": {
  "type": "http",
  "url": "https://sora-srv.tail97131d.ts.net:8443/_extra/mcp",
  "headers": { "Authorization": "Bearer ${VIKUNJA_TOKEN}" }
}
```

Sin la variable definida, el server responde 401 con un mensaje que dice de
donde sacar el token.

## Herramientas

| Herramienta | Que hace |
|---|---|
| `listar_proyectos` | Proyectos visibles, con id |
| `listar_columnas` | Columnas del kanban de un proyecto (el equipo las usa como estados) |
| `listar_tareas` | Tareas de un proyecto, pendientes por defecto |
| `buscar_tareas` | Busqueda por texto en todos los proyectos |
| `ver_tarea` | Tarea completa con descripcion y comentarios |
| `crear_tarea` | Crea, y de paso asigna / pone columna / prioridad / vencimiento |
| `modificar_tarea` | Titulo, descripcion, prioridad, vencimiento, hecha/reabrir |
| `mover_tarea` | Cambia de columna |
| `asignar_tarea` | Agrega o saca asignados |
| `comentar_tarea` | Deja un comentario |
| `etiquetar_tarea` | Agrega o saca etiquetas existentes |
| `quien_soy` | Con que cuenta esta operando |

Borrar tareas no existe a proposito: es la unica accion irreversible del
conjunto y se hace desde la interfaz.

Proyectos, columnas, usuarios y etiquetas se pueden nombrar por texto
(`"Backend"`, `"En progreso"`, `"facu"`), no hace falta saber los ids. Las
fechas aceptan `2026-09-05` (vence al final de ese dia, hora de Buenos Aires)
o un RFC3339 completo.

## Modo alternativo: stdio local

El mismo archivo ejecutado directo es un MCP por stdio, util si el server no
esta a mano o para probar cambios:

```bash
VIKUNJA_TOKEN=tk_... node vikunja-mcp.js
```

Y se registra con `claude mcp add vikunja --scope user -e VIKUNJA_TOKEN=tk_...
-- node /ruta/a/vikunja-mcp.js`. **Desde Git Bash o cmd en Windows, no desde
PowerShell**: PowerShell se come el `--` y el CLI falla por falta de argumento.

## Despliegue en el server

`install/install-ws.sh` instala `vikunja-mcp.js` junto a `eventos.js` en
`/opt/vikunja-eventos` y agrega la ruta `/_extra/mcp` a nginx. Ver el README
raiz para el procedimiento completo.

Prueba rapida de que esta vivo (401 = la ruta funciona y pide token):

```bash
curl -s -X POST https://sora-srv.tail97131d.ts.net:8443/_extra/mcp
```

## Detalles

- El MCP habla con Vikunja por `127.0.0.1:3456` (misma maquina); los links que
  devuelve usan la URL publica.
- Proyectos, vistas, columnas y etiquetas se cachean 60 segundos **por
  usuario**, para no encadenar tres llamadas por cada movimiento.
- Los cambios que hace Claude aparecen solos en el navegador de todos: pasan
  por Postgres, asi que los triggers `vkx_*` los empujan por websocket como
  cualquier cambio hecho a mano.
- Si una columna o un usuario no coincide, el error lista las opciones validas
  en vez de fallar seco.
