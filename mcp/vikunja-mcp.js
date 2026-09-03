#!/usr/bin/env node
/* vikunja-mcp — expone los tickets de Vikunja como herramientas MCP.
 *
 * Funciona de dos maneras:
 *
 *  - Ejecutado directo (node vikunja-mcp.js): servidor MCP por stdio, con el
 *    token en VIKUNJA_TOKEN. Para uso personal en la propia maquina.
 *
 *  - Como modulo (require): expone manejarHttp(req, res) para que
 *    vikunja-eventos sirva MCP por HTTP en /_extra/mcp. Ahi el token viaja en
 *    el header Authorization de cada request, asi que un solo proceso atiende
 *    a todo el equipo y cada accion queda a nombre de quien la pidio.
 *
 * En ninguno de los dos casos hay dependencias: MCP es JSON-RPC 2.0, por linea
 * en stdio y por POST en HTTP.
 *
 *   VIKUNJA_URL         donde esta la API (en el server: http://127.0.0.1:3456)
 *   VIKUNJA_PUBLIC_URL  la URL que ve la gente, para armar los links
 *   VIKUNJA_TOKEN       solo en modo stdio
 */
'use strict';

const crypto = require('crypto');

const URL_FUNNEL = 'https://sora-srv.tail97131d.ts.net:8443';
const URL_BASE = (process.env.VIKUNJA_URL || URL_FUNNEL).replace(/\/+$/, '');
const URL_PUBLICA = (process.env.VIKUNJA_PUBLIC_URL || (URL_BASE.includes('127.0.0.1') ? URL_FUNNEL : URL_BASE)).replace(/\/+$/, '');
const TZ = 'America/Argentina/Buenos_Aires';
const DESFASE = '-03:00';

// Los errores van a stderr: en modo stdio, stdout es del protocolo.
const log = (...a) => process.stderr.write(new Date().toISOString() + ' ' + a.join(' ') + '\n');

// ---------- API de Vikunja ----------

async function api(token, metodo, ruta, cuerpo) {
    const r = await fetch(URL_BASE + '/api/v1' + ruta, {
        method: metodo,
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const texto = await r.text();
    let datos = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch (e) { datos = texto; }
    if (!r.ok) {
        const msg = datos && datos.message ? datos.message : (typeof datos === 'string' ? datos.slice(0, 300) : r.statusText);
        const e = new Error(metodo + ' ' + ruta + ' -> ' + r.status + ': ' + msg);
        e.status = r.status; // quien llama distingue un 403 de scope de un error real
        throw e;
    }
    return datos;
}

const qs = o => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? '?' + s : '';
};

// ---------- cache corto ----------
// Proyectos, vistas y columnas cambian poco; evita 3 llamadas por cada
// mover_tarea. Va por usuario (hash del token) porque cada uno ve proyectos
// distintos, y con TTL corto para que un permiso nuevo no tarde en aparecer.
const cache = new Map();
const TTL = 60 * 1000;
const MAX_CACHE = 500;

const claveCache = (token, clave) =>
    crypto.createHash('sha1').update(token).digest('hex').slice(0, 12) + ':' + clave;

async function cacheado(token, clave, fn) {
    const k = claveCache(token, clave);
    const v = cache.get(k);
    if (v && Date.now() - v.ts < TTL) return v.dato;
    const dato = await fn();
    if (cache.size > MAX_CACHE) cache.clear();
    cache.set(k, { dato, ts: Date.now() });
    return dato;
}

// Tras escribir hay que olvidar lo cacheado: si no, crear una etiqueta y
// usarla enseguida fallaria con "no existe" hasta que venza el TTL.
const olvidar = (token, clave) => cache.delete(claveCache(token, clave));

// ---------- helpers de dominio ----------

const proyectos = t => cacheado(t, 'proyectos', () => api(t, 'GET', '/projects'));

async function proyectoDe(t, ref) {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
        const id = parseInt(ref, 10);
        const p = (await proyectos(t)).find(x => x.id === id);
        if (p) return p;
        return api(t, 'GET', '/projects/' + id);
    }
    const buscado = String(ref).trim().toLowerCase();
    const lista = await proyectos(t);
    const exacto = lista.find(p => p.title.toLowerCase() === buscado);
    if (exacto) return exacto;
    const parciales = lista.filter(p => p.title.toLowerCase().includes(buscado));
    if (parciales.length === 1) return parciales[0];
    if (parciales.length > 1) {
        throw new Error('"' + ref + '" coincide con varios proyectos: ' + parciales.map(p => p.title + ' (' + p.id + ')').join(', '));
    }
    throw new Error('No encontre el proyecto "' + ref + '". Disponibles: ' + lista.map(p => p.title).join(', '));
}

// La vista kanban es la que tiene las columnas que el equipo usa como estados.
async function vistaKanban(t, projectId) {
    return cacheado(t, 'vistas:' + projectId, async () => {
        const vistas = await api(t, 'GET', '/projects/' + projectId + '/views');
        const k = (vistas || []).find(v => v.view_kind === 'kanban' || v.view_kind === 3);
        if (!k) throw new Error('El proyecto ' + projectId + ' no tiene vista kanban');
        return k;
    });
}

async function columnas(t, projectId) {
    const vista = await vistaKanban(t, projectId);
    const buckets = await api(t, 'GET', '/projects/' + projectId + '/views/' + vista.id + '/buckets' + qs({ per_page: 100 }));
    return { vista, buckets: buckets || [] };
}

async function columnaDe(t, projectId, nombre) {
    const { vista, buckets } = await columnas(t, projectId);
    const buscado = String(nombre).trim().toLowerCase();
    const b = buckets.find(x => x.title.toLowerCase() === buscado)
        || buckets.find(x => x.title.toLowerCase().includes(buscado));
    if (!b) throw new Error('No hay columna "' + nombre + '". Hay: ' + buckets.map(x => x.title).join(', '));
    return { vista, bucket: b };
}

async function usuariosDe(t, projectId) {
    return cacheado(t, 'usuarios:' + projectId, () => api(t, 'GET', '/projects/' + projectId + '/projectusers'));
}

async function usuarioDe(t, projectId, ref) {
    const lista = await usuariosDe(t, projectId);
    const buscado = String(ref).trim().toLowerCase();
    const u = lista.find(x => x.username.toLowerCase() === buscado)
        || lista.find(x => (x.name || '').toLowerCase() === buscado)
        || lista.find(x => x.username.toLowerCase().includes(buscado) || (x.name || '').toLowerCase().includes(buscado));
    if (!u) throw new Error('No encontre a "' + ref + '" en el proyecto. Hay: ' + lista.map(x => x.username).join(', '));
    return u;
}

const etiquetas = t => cacheado(t, 'etiquetas', () => api(t, 'GET', '/labels' + qs({ per_page: 200 })));

// Mismo criterio que proyectoDe: si el parcial es ambiguo conviene fallar
// listando, no elegir el primero (con "bug" y "bugfix" acertar seria suerte).
async function etiquetaDe(t, ref) {
    const lista = (await etiquetas(t)) || [];
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
        const id = parseInt(ref, 10);
        const l = lista.find(x => x.id === id);
        if (l) return l;
        throw new Error('No existe la etiqueta con id ' + id + '.');
    }
    const buscado = String(ref).trim().toLowerCase();
    const exacto = lista.find(x => x.title.toLowerCase() === buscado);
    if (exacto) return exacto;
    const parciales = lista.filter(x => x.title.toLowerCase().includes(buscado));
    if (parciales.length === 1) return parciales[0];
    if (parciales.length > 1) {
        throw new Error('"' + ref + '" coincide con varias etiquetas: ' + parciales.map(x => x.title + ' (' + x.id + ')').join(', '));
    }
    throw new Error('No existe la etiqueta "' + ref + '". Hay: ' + (lista.map(x => x.title).join(', ') || 'ninguna'));
}

// Los API tokens de Vikunja separan los permisos por recurso y metodo: uno
// creado solo con "Labels > read all" lee pero no escribe, y el 403 pelado no
// explica que falta.
function conScopeLabels(e) {
    if (e && e.status === 403) {
        return new Error('El token no tiene permiso para escribir etiquetas. Regeneralo en Vikunja (Ajustes > Tokens API) marcando Labels completo, no solo "read all".');
    }
    return e;
}

const hex = c => String(c || '').trim().replace(/^#/, '');

// Acepta "2026-09-05" (vence al final del dia) o un RFC3339 completo.
function fecha(v) {
    if (!v) return undefined;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T23:59:00' + DESFASE;
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(s)) return s.replace(' ', 'T') + ':00' + DESFASE;
    return s;
}

const PRIORIDADES = { 0: 'sin prioridad', 1: 'baja', 2: 'media', 3: 'alta', 4: 'urgente', 5: 'DEFCON1' };

function resumirTarea(t) {
    const partes = ['#' + t.id + ' ' + t.title];
    if (t.done) partes.push('[hecha]');
    if (t.priority) partes.push('prioridad: ' + (PRIORIDADES[t.priority] || t.priority));
    if (t.due_date && !String(t.due_date).startsWith('0001')) partes.push('vence: ' + String(t.due_date).slice(0, 10));
    if (t.assignees && t.assignees.length) partes.push('asignada a: ' + t.assignees.map(a => a.username).join(', '));
    if (t.labels && t.labels.length) partes.push('etiquetas: ' + t.labels.map(l => l.title).join(', '));
    return partes.join(' | ');
}

function detallarTarea(t, comentarios) {
    const l = [
        '#' + t.id + ' ' + t.title,
        'proyecto: ' + t.project_id + ' | ' + (t.done ? 'HECHA' : 'pendiente'),
        'prioridad: ' + (PRIORIDADES[t.priority || 0] || t.priority),
        'vence: ' + (t.due_date && !String(t.due_date).startsWith('0001') ? t.due_date : '-'),
        'asignados: ' + ((t.assignees || []).map(a => a.username).join(', ') || '-'),
        'etiquetas: ' + ((t.labels || []).map(x => x.title).join(', ') || '-'),
        'url: ' + URL_PUBLICA + '/tasks/' + t.id,
        '',
        (t.description || '(sin descripcion)').replace(/<[^>]+>/g, '').trim()
    ];
    if (comentarios && comentarios.length) {
        l.push('', '--- comentarios ---');
        for (const c of comentarios) {
            l.push('[' + (c.author ? c.author.username : '?') + ' ' + String(c.created).slice(0, 16) + '] '
                + (c.comment || '').replace(/<[^>]+>/g, '').trim());
        }
    }
    return l.join('\n');
}

// ---------- herramientas ----------
// run recibe (argumentos, token): el token viene del entorno en modo stdio y
// del header Authorization en modo HTTP.

const HERRAMIENTAS = [
    {
        name: 'listar_proyectos',
        description: 'Lista los proyectos de Vikunja visibles para el usuario, con su id.',
        inputSchema: { type: 'object', properties: {} },
        run: async (a, t) => {
            const l = await proyectos(t);
            if (!l || !l.length) return 'No hay proyectos visibles con este token.';
            return l.map(p => p.id + ' - ' + p.title).join('\n');
        }
    },
    {
        name: 'listar_columnas',
        description: 'Lista las columnas (estados) del tablero kanban de un proyecto.',
        inputSchema: {
            type: 'object',
            properties: { proyecto: { type: 'string', description: 'Id o nombre del proyecto' } },
            required: ['proyecto']
        },
        run: async (a, t) => {
            const p = await proyectoDe(t, a.proyecto);
            const { buckets } = await columnas(t, p.id);
            return 'Columnas de "' + p.title + '":\n' + buckets.map(b => b.id + ' - ' + b.title).join('\n');
        }
    },
    {
        name: 'listar_tareas',
        description: 'Lista las tareas de un proyecto. Por defecto solo las pendientes.',
        inputSchema: {
            type: 'object',
            properties: {
                proyecto: { type: 'string', description: 'Id o nombre del proyecto' },
                incluir_hechas: { type: 'boolean', description: 'Incluir tareas ya terminadas (default false)' },
                buscar: { type: 'string', description: 'Texto a buscar en el titulo' },
                limite: { type: 'number', description: 'Maximo de tareas (default 50)' }
            },
            required: ['proyecto']
        },
        run: async (a, t) => {
            const p = await proyectoDe(t, a.proyecto);
            const tareas = await api(t, 'GET', '/projects/' + p.id + '/tasks' + qs({
                filter: a.incluir_hechas ? undefined : 'done = false',
                filter_timezone: TZ,
                s: a.buscar,
                per_page: a.limite || 50
            }));
            if (!tareas || !tareas.length) return 'Sin tareas que coincidan en "' + p.title + '".';
            return 'Tareas de "' + p.title + '" (' + tareas.length + '):\n' + tareas.map(resumirTarea).join('\n');
        }
    },
    {
        name: 'buscar_tareas',
        description: 'Busca tareas por texto en todos los proyectos accesibles.',
        inputSchema: {
            type: 'object',
            properties: {
                texto: { type: 'string', description: 'Texto a buscar' },
                incluir_hechas: { type: 'boolean' },
                limite: { type: 'number' }
            },
            required: ['texto']
        },
        run: async (a, t) => {
            const tareas = await api(t, 'GET', '/tasks' + qs({
                s: a.texto,
                filter: a.incluir_hechas ? undefined : 'done = false',
                filter_timezone: TZ,
                per_page: a.limite || 30
            }));
            if (!tareas || !tareas.length) return 'Ninguna tarea coincide con "' + a.texto + '".';
            return tareas.map(resumirTarea).join('\n');
        }
    },
    {
        name: 'ver_tarea',
        description: 'Muestra una tarea completa con su descripcion y comentarios.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: 'Id de la tarea' },
                con_comentarios: { type: 'boolean', description: 'Traer los comentarios (default true)' }
            },
            required: ['id']
        },
        run: async (a, t) => {
            const tarea = await api(t, 'GET', '/tasks/' + a.id);
            let c = null;
            if (a.con_comentarios !== false) {
                try { c = await api(t, 'GET', '/tasks/' + a.id + '/comments'); } catch (e) { log('sin comentarios:', e.message); }
            }
            return detallarTarea(tarea, c);
        }
    },
    {
        name: 'crear_tarea',
        description: 'Crea una tarea en un proyecto. Puede asignarla, ponerle columna, prioridad y vencimiento de una.',
        inputSchema: {
            type: 'object',
            properties: {
                proyecto: { type: 'string', description: 'Id o nombre del proyecto' },
                titulo: { type: 'string' },
                descripcion: { type: 'string' },
                prioridad: { type: 'number', description: '0 ninguna, 1 baja, 2 media, 3 alta, 4 urgente, 5 DEFCON1' },
                vence: { type: 'string', description: 'YYYY-MM-DD o RFC3339' },
                asignar_a: { type: 'array', items: { type: 'string' }, description: 'Usernames' },
                columna: { type: 'string', description: 'Nombre de la columna kanban donde dejarla' }
            },
            required: ['proyecto', 'titulo']
        },
        run: async (a, t) => {
            const p = await proyectoDe(t, a.proyecto);
            const tarea = await api(t, 'PUT', '/projects/' + p.id + '/tasks', {
                title: a.titulo,
                description: a.descripcion || '',
                priority: a.prioridad || 0,
                due_date: fecha(a.vence)
            });
            const hecho = ['Creada #' + tarea.id + ' "' + tarea.title + '" en "' + p.title + '"'];
            for (const ref of a.asignar_a || []) {
                try {
                    const u = await usuarioDe(t, p.id, ref);
                    await api(t, 'PUT', '/tasks/' + tarea.id + '/assignees', { user_id: u.id });
                    hecho.push('asignada a ' + u.username);
                } catch (e) { hecho.push('NO pude asignar a ' + ref + ': ' + e.message); }
            }
            if (a.columna) {
                try {
                    const { vista, bucket } = await columnaDe(t, p.id, a.columna);
                    await api(t, 'POST', '/projects/' + p.id + '/views/' + vista.id + '/buckets/' + bucket.id + '/tasks', { task_id: tarea.id });
                    hecho.push('movida a "' + bucket.title + '"');
                } catch (e) { hecho.push('NO pude moverla: ' + e.message); }
            }
            hecho.push(URL_PUBLICA + '/tasks/' + tarea.id);
            return hecho.join('\n');
        }
    },
    {
        name: 'modificar_tarea',
        description: 'Cambia campos de una tarea existente. Solo toca lo que le pases.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                titulo: { type: 'string' },
                descripcion: { type: 'string' },
                prioridad: { type: 'number' },
                vence: { type: 'string', description: 'YYYY-MM-DD, RFC3339, o cadena vacia para sacarlo' },
                hecha: { type: 'boolean', description: 'Marcar como terminada o reabrir' }
            },
            required: ['id']
        },
        run: async (a, t) => {
            const actual = await api(t, 'GET', '/tasks/' + a.id);
            const cambios = {};
            if (a.titulo !== undefined) cambios.title = a.titulo;
            if (a.descripcion !== undefined) cambios.description = a.descripcion;
            if (a.prioridad !== undefined) cambios.priority = a.prioridad;
            if (a.vence !== undefined) cambios.due_date = a.vence === '' ? '0001-01-01T00:00:00Z' : fecha(a.vence);
            if (a.hecha !== undefined) cambios.done = a.hecha;
            if (!Object.keys(cambios).length) return 'No me pasaste ningun cambio para #' + a.id + '.';
            // La API espera la tarea completa: parto de la actual y encimo los cambios.
            const tarea = await api(t, 'POST', '/tasks/' + a.id, Object.assign({}, actual, cambios));
            return 'Actualizada #' + tarea.id + ': ' + Object.keys(cambios).join(', ') + '\n' + resumirTarea(tarea);
        }
    },
    {
        name: 'mover_tarea',
        description: 'Mueve una tarea a otra columna del kanban (el equipo usa las columnas como estados).',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                columna: { type: 'string', description: 'Nombre de la columna destino' }
            },
            required: ['id', 'columna']
        },
        run: async (a, t) => {
            const tarea = await api(t, 'GET', '/tasks/' + a.id);
            const { vista, bucket } = await columnaDe(t, tarea.project_id, a.columna);
            await api(t, 'POST', '/projects/' + tarea.project_id + '/views/' + vista.id + '/buckets/' + bucket.id + '/tasks', { task_id: tarea.id });
            return '#' + tarea.id + ' "' + tarea.title + '" movida a "' + bucket.title + '".';
        }
    },
    {
        name: 'asignar_tarea',
        description: 'Agrega o saca asignados de una tarea.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                agregar: { type: 'array', items: { type: 'string' }, description: 'Usernames a asignar' },
                sacar: { type: 'array', items: { type: 'string' }, description: 'Usernames a desasignar' }
            },
            required: ['id']
        },
        run: async (a, t) => {
            const tarea = await api(t, 'GET', '/tasks/' + a.id);
            const hecho = [];
            for (const ref of a.agregar || []) {
                const u = await usuarioDe(t, tarea.project_id, ref);
                await api(t, 'PUT', '/tasks/' + tarea.id + '/assignees', { user_id: u.id });
                hecho.push('+ ' + u.username);
            }
            for (const ref of a.sacar || []) {
                const u = await usuarioDe(t, tarea.project_id, ref);
                await api(t, 'DELETE', '/tasks/' + tarea.id + '/assignees/' + u.id);
                hecho.push('- ' + u.username);
            }
            if (!hecho.length) return 'Asignados actuales de #' + tarea.id + ': ' + ((tarea.assignees || []).map(x => x.username).join(', ') || 'nadie');
            return '#' + tarea.id + ': ' + hecho.join(', ');
        }
    },
    {
        name: 'comentar_tarea',
        description: 'Deja un comentario en una tarea.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'number' }, texto: { type: 'string' } },
            required: ['id', 'texto']
        },
        run: async (a, t) => {
            await api(t, 'PUT', '/tasks/' + a.id + '/comments', { comment: a.texto });
            return 'Comentario agregado en #' + a.id + '.';
        }
    },
    {
        name: 'etiquetar_tarea',
        description: 'Agrega o saca etiquetas de una tarea. Las etiquetas tienen que existir.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number' },
                agregar: { type: 'array', items: { type: 'string' } },
                sacar: { type: 'array', items: { type: 'string' } }
            },
            required: ['id']
        },
        run: async (a, t) => {
            const hecho = [];
            for (const n of a.agregar || []) {
                const l = await etiquetaDe(t, n);
                await api(t, 'PUT', '/tasks/' + a.id + '/labels', { label_id: l.id });
                hecho.push('+ ' + l.title);
            }
            for (const n of a.sacar || []) {
                const l = await etiquetaDe(t, n);
                await api(t, 'DELETE', '/tasks/' + a.id + '/labels/' + l.id);
                hecho.push('- ' + l.title);
            }
            if (hecho.length) return '#' + a.id + ': ' + hecho.join(', ');
            const l = (await etiquetas(t)) || [];
            return 'Etiquetas disponibles: ' + (l.map(x => x.title).join(', ') || 'ninguna');
        }
    },
    {
        name: 'listar_etiquetas',
        description: 'Lista las etiquetas que existen en Vikunja, con su id y color.',
        inputSchema: { type: 'object', properties: {} },
        run: async (a, t) => {
            const l = (await etiquetas(t)) || [];
            if (!l.length) return 'No hay etiquetas todavia.';
            return l.map(x => x.id + ' - ' + x.title + (x.hex_color ? ' (#' + x.hex_color + ')' : '')).join('\n');
        }
    },
    {
        name: 'crear_etiqueta',
        description: 'Crea una etiqueta nueva. Si ya existe una con ese titulo, devuelve la existente en vez de duplicarla.',
        inputSchema: {
            type: 'object',
            properties: {
                titulo: { type: 'string' },
                color: { type: 'string', description: 'Hex, con o sin #, ej e74c3c' },
                descripcion: { type: 'string' }
            },
            required: ['titulo']
        },
        run: async (a, t) => {
            // Vikunja acepta dos etiquetas con el mismo nombre; un agente que
            // reintenta terminaria llenando la lista de duplicados.
            const buscado = String(a.titulo).trim().toLowerCase();
            const ya = ((await etiquetas(t)) || []).find(x => x.title.toLowerCase() === buscado);
            if (ya) return 'Ya existia la etiqueta "' + ya.title + '" (id ' + ya.id + '). No cree ninguna.';
            let l;
            try {
                l = await api(t, 'PUT', '/labels', {
                    title: String(a.titulo).trim(),
                    hex_color: hex(a.color),
                    description: a.descripcion || ''
                });
            } catch (e) { throw conScopeLabels(e); }
            olvidar(t, 'etiquetas');
            return 'Creada la etiqueta "' + l.title + '" (id ' + l.id + ')' + (l.hex_color ? ' color #' + l.hex_color : '') + '.';
        }
    },
    {
        name: 'modificar_etiqueta',
        description: 'Cambia el titulo, el color o la descripcion de una etiqueta existente.',
        inputSchema: {
            type: 'object',
            properties: {
                etiqueta: { type: 'string', description: 'Id o nombre actual' },
                titulo: { type: 'string' },
                color: { type: 'string', description: 'Hex, con o sin #' },
                descripcion: { type: 'string' }
            },
            required: ['etiqueta']
        },
        run: async (a, t) => {
            const actual = await etiquetaDe(t, a.etiqueta);
            const cambios = {};
            if (a.titulo !== undefined) cambios.title = String(a.titulo).trim();
            if (a.color !== undefined) cambios.hex_color = hex(a.color);
            if (a.descripcion !== undefined) cambios.description = a.descripcion;
            if (!Object.keys(cambios).length) return 'No me pasaste ningun cambio para "' + actual.title + '".';
            let l;
            // Como en modificar_tarea: la API espera el objeto completo.
            try { l = await api(t, 'POST', '/labels/' + actual.id, Object.assign({}, actual, cambios)); }
            catch (e) { throw conScopeLabels(e); }
            olvidar(t, 'etiquetas');
            return 'Actualizada la etiqueta ' + actual.id + ' (' + Object.keys(cambios).join(', ') + '): "'
                + l.title + '"' + (l.hex_color ? ' #' + l.hex_color : '') + '.';
        }
    },
    {
        name: 'eliminar_etiqueta',
        description: 'Borra una etiqueta de todo Vikunja. Sin "confirmar" no borra: informa cuantas tareas la usan. Para borrar de verdad hay que pasar en "confirmar" el titulo exacto.',
        inputSchema: {
            type: 'object',
            properties: {
                etiqueta: { type: 'string', description: 'Id o nombre' },
                confirmar: { type: 'string', description: 'Repetir el titulo exacto de la etiqueta para confirmar el borrado' }
            },
            required: ['etiqueta']
        },
        run: async (a, t) => {
            const l = await etiquetaDe(t, a.etiqueta);
            if (String(a.confirmar || '').trim().toLowerCase() !== l.title.toLowerCase()) {
                let cuantas = '?';
                try {
                    const usadas = await api(t, 'GET', '/tasks' + qs({ filter: 'labels in ' + l.id, filter_timezone: TZ, per_page: 100 }));
                    cuantas = (usadas || []).length + ((usadas || []).length === 100 ? '+' : '');
                } catch (e) { log('no pude contar tareas de la etiqueta:', e.message); }
                return 'NO borre nada. La etiqueta "' + l.title + '" (id ' + l.id + ') esta en ' + cuantas
                    + ' tarea(s); borrarla se la saca a todas. Si igual queres borrarla, volve a llamar con confirmar: "' + l.title + '".';
            }
            try { await api(t, 'DELETE', '/labels/' + l.id); }
            catch (e) { throw conScopeLabels(e); }
            olvidar(t, 'etiquetas');
            return 'Borrada la etiqueta "' + l.title + '" (id ' + l.id + ').';
        }
    },
    {
        name: 'quien_soy',
        description: 'Muestra con que usuario de Vikunja esta operando este MCP. Sirve para verificar la config.',
        inputSchema: { type: 'object', properties: {} },
        run: async (a, t) => {
            try {
                const u = await api(t, 'GET', '/user');
                return 'Conectado a ' + URL_PUBLICA + ' como ' + u.username + (u.name ? ' (' + u.name + ')' : '') + ', id ' + u.id + '.';
            } catch (e) {
                // Los API tokens de Vikunja no siempre alcanzan /user; con ver proyectos alcanza.
                const l = await proyectos(t);
                return 'Conectado a ' + URL_PUBLICA + '. El token no lee /user, pero ve ' + l.length + ' proyectos.';
            }
        }
    }
];

const PORNOMBRE = new Map(HERRAMIENTAS.map(h => [h.name, h]));

// ---------- JSON-RPC (comun a los dos transportes) ----------
// Devuelve el objeto de respuesta, o undefined si el mensaje era una
// notificacion y no corresponde responder nada.

async function atender(msg, token) {
    const { id, method, params } = msg || {};

    if (method === 'initialize') {
        return {
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: (params && params.protocolVersion) || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'vikunja', version: '2.0.0' }
            }
        };
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0', id,
            result: { tools: HERRAMIENTAS.map(h => ({ name: h.name, description: h.description, inputSchema: h.inputSchema })) }
        };
    }
    if (method === 'tools/call') {
        const h = PORNOMBRE.get(params && params.name);
        if (!h) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'No existe la herramienta ' + (params && params.name) } };
        try {
            const texto = await h.run((params && params.arguments) || {}, token);
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(texto) }] } };
        } catch (e) {
            log('fallo ' + h.name + ':', e.message);
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
        }
    }
    if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Metodo no soportado: ' + method } };
    return undefined;
}

// ---------- transporte HTTP (streamable http, sin sesiones) ----------
// Para montar en un http.Server existente. El token de Vikunja viene en el
// Authorization de cada request; no se guarda nada del cliente entre llamadas.

function manejarHttp(req, res) {
    const json = (codigo, obj) => {
        res.writeHead(codigo, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) {
        json(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Falta el token: header Authorization: Bearer tk_... (se crea en Vikunja, Ajustes > Tokens API)' } });
        return;
    }
    let cuerpo = '';
    let excedido = false;
    req.on('data', d => {
        cuerpo += d;
        if (cuerpo.length > 256 * 1024) { excedido = true; req.destroy(); }
    });
    req.on('end', async () => {
        if (excedido) return;
        let msg;
        try { msg = JSON.parse(cuerpo); } catch (e) {
            json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalido' } });
            return;
        }
        try {
            const lote = Array.isArray(msg) ? msg : [msg];
            const respuestas = [];
            for (const m of lote) {
                const r = await atender(m, token);
                if (r) respuestas.push(r);
            }
            if (!respuestas.length) { res.writeHead(202); res.end(); return; }
            json(200, Array.isArray(msg) ? respuestas : respuestas[0]);
        } catch (e) {
            log('error http:', e.message);
            json(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Error interno' } });
        }
    });
}

module.exports = { atender, manejarHttp, HERRAMIENTAS };

// ---------- transporte stdio (solo si se ejecuta directo) ----------

if (require.main === module) {
    const TOKEN = process.env.VIKUNJA_TOKEN || '';
    if (!TOKEN) {
        log('ERROR: falta VIKUNJA_TOKEN. Sacalo de Ajustes > Tokens API en Vikunja.');
        process.exit(1);
    }
    let pendiente = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', trozo => {
        pendiente += trozo;
        let corte;
        while ((corte = pendiente.indexOf('\n')) >= 0) {
            const linea = pendiente.slice(0, corte).trim();
            pendiente = pendiente.slice(corte + 1);
            if (!linea) continue;
            let msg;
            try { msg = JSON.parse(linea); } catch (e) { log('linea invalida:', e.message); continue; }
            atender(msg, TOKEN)
                .then(r => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); })
                .catch(e => log('error interno:', e.message));
        }
    });
    process.stdin.on('end', () => process.exit(0));
    log('vikunja-mcp (stdio) listo contra ' + URL_BASE);
}
