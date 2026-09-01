# vikunja-mcp

Servidor MCP para que Claude pueda leer y modificar los tickets de Vikunja:
crear, editar, mover de columna, asignar, comentar y etiquetar.

Corre **en la maquina de cada persona** por stdio, con **el token de esa
persona**. Nada se instala en `sora-srv`: es un cliente mas de la API REST, asi
que no consume RAM del server ni abre puertos nuevos. Cada accion queda con el
autor correcto y con los permisos que esa cuenta tenga en Vikunja.

Requisitos: Node 18 o mayor (usa `fetch` nativo). Sin dependencias npm.

## Sacar el token

En Vikunja: avatar (arriba a la derecha) → **Ajustes** → **Tokens API** →
**Crear un token**.

- Nombre: `claude`
- Vencimiento: el que quieras (si vence, hay que rehacerlo)
- Permisos: marcar **Tasks** (todo), **Projects** → read all, **Labels** → read all
- Copiar el `tk_...`: se muestra una sola vez

El token es una credencial: no va al repo ni por chat grupal.

## Configurarlo en Claude Code

Con el archivo en `~/vikunja-mcp.js` (o donde lo hayas dejado):

```bash
claude mcp add vikunja --scope user \
  -e VIKUNJA_URL=https://sora-srv.tail97131d.ts.net:8443 \
  -e VIKUNJA_TOKEN=tk_ELTOKENDECADAUNO \
  -- node /ruta/absoluta/a/vikunja-mcp.js
```

`--scope user` lo deja disponible en todos los proyectos de esa persona, no solo
en uno.

**En Windows hay que correrlo desde Git Bash o cmd, no desde PowerShell**:
PowerShell se come el `--` y el comando falla con
`error: missing required argument 'commandOrUrl'`. El truco `--%` tampoco sirve
porque `claude` es un script, no un ejecutable nativo.

Verificar: abrir Claude y pedirle *"con que usuario de Vikunja estas conectado"*
(usa `quien_soy`), o correr `claude mcp list`.

## O sin comandos, con .mcp.json

Otra via, si el equipo ya trabaja sobre un repo comun: dejar la config ahi, en
un `.mcp.json` en la raiz, y que cada uno solo defina su token como variable de
entorno. La config viaja con el repo y no hace falta que nadie corra
`claude mcp add`.

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "node",
      "args": ["../vikunja-extra/mcp/vikunja-mcp.js"],
      "env": {
        "VIKUNJA_URL": "https://sora-srv.tail97131d.ts.net:8443",
        "VIKUNJA_TOKEN": "${VIKUNJA_TOKEN}"
      }
    }
  }
}
```

Cada uno define `VIKUNJA_TOKEN` en su entorno (`setx VIKUNJA_TOKEN tk_...` en
Windows, el `.bashrc` o `.zshrc` en Linux y Mac) y clona este repo **al lado**
del otro, porque la ruta del script es relativa. Claude pide aprobacion la
primera vez que ve un `.mcp.json` nuevo. A quien no tenga la variable definida
el MCP simplemente no le arranca; no rompe nada del repo.

Asi esta puesto en el repo de CDF.

## Probar sin Claude

```bash
VIKUNJA_TOKEN=tk_... node vikunja-mcp.js
```

Tiene que imprimir `vikunja-mcp listo contra ...` y quedarse esperando. Si dice
que falta el token, la variable no llego.

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

Proyectos, columnas, usuarios y etiquetas se pueden nombrar por texto
(`"Backend"`, `"En progreso"`, `"facu"`), no hace falta saber los ids.

Las fechas aceptan `2026-09-05` (vence al final de ese dia, hora de Buenos
Aires) o un RFC3339 completo.

## Detalles

- Los cambios que haga Claude aparecen solos en el navegador de todos: los
  triggers de Postgres y `server/eventos.js` empujan el cambio por websocket.
- Proyectos, vistas, columnas y etiquetas se cachean 60 segundos para no
  encadenar tres llamadas por cada movimiento.
- Si una columna o un usuario no coincide, el error lista las opciones validas
  en vez de fallar seco.
