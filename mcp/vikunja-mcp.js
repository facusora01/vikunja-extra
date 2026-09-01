#!/usr/bin/env node
/* vikunja-mcp — expone los tickets de Vikunja como herramientas MCP.
 *
 * Cada persona lo corre en su maquina (stdio) con su propio token, asi las
 * acciones quedan a nombre de quien las pide y con sus permisos. El server
 * no se entera: esto es un cliente mas de la API REST.
 *
 * Sin dependencias: el protocolo MCP sobre stdio es JSON-RPC 2.0 por linea.
 *
 *   VIKUNJA_URL=https://sora-srv.tail97131d.ts.net:8443
 *   VIKUNJA_TOKEN=tk_...
 */
'use strict';

const URL_BASE = (process.env.VIKUNJA_URL || 'https://sora-srv.tail97131d.ts.net:8443').replace(/\/+$/, '');
const TOKEN = process.env.VIKUNJA_TOKEN || '';
const TZ = 'America/Argentina/Buenos_Aires';
const DESFASE = '-03:00';

// Los errores van a stderr: stdout es del protocolo y cualquier ruido lo rompe.
const log = (...a) => process.stderr.write(new Date().toISOString() + ' ' + a.join(' ') + '\n');

// ---------- API de Vikunja ----------

async function api(metodo, ruta, cuerpo) {
    const r = await fetch(URL_BASE + '/api/v1' + ruta, {
        method: metodo,
        headers: {
            Authorization: 'Bearer ' + TOKEN,
            'Content-Type': 'application/json'
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const texto = await r.text();
    let datos = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch (e) { datos = texto; }
    if (!r.ok) {
        const msg = datos && datos.message ? datos.message : (typeof datos === 'string' ? datos.slice(0, 300) : r.statusText);
        throw new Error(metodo + ' ' + ruta + ' -> ' + r.status + ': ' + msg);
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
// Proyectos, vistas y columnas cambian poco; evita 3 llamadas por cada mover_tarea.
const cache = new Map();
const TTL = 60 * 1000;

async function cacheado(clave, fn) {
    const v = cache.get(clave);
    if (v && Date.now() - v.ts < TTL) return v.dato;
    const dato = await fn();
    cache.set(clave, { dato, ts: Date.now() });
    return dato;
}

// ---------- helpers de dominio ----------

const proyectos = () => cacheado('proyectos', () => api('GET', '/projects'));

async function proyectoDe(ref) {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
        const id = parseInt(ref, 10);
        const p = (await proyectos()).find(x => x.id === id);
        if (p) return p;
        return api('GET', '/projects/' + id);
    }
    const buscado = String(ref).trim().toLowerCase();
    const lista = await proyectos();
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
async function vistaKanban(projectId) {
    return cacheado('vistas:' + projectId, async () => {
        const vistas = await api('GET', '/projects/' + projectId + '/views');
        const k = (vistas || []).find(v => v.view_kind === 'kanban' || v.view_kind === 3);
        if (!k) throw new Error('El proyecto ' + projectId + ' no tiene vista kanban');
        return k;
    });
}

async function columnas(projectId) {
    const vista = await vistaKanban(projectId);
    const buckets = await api('GET', '/projects/' + projectId + '/views/' + vista.id + '/buckets' + qs({ per_page: 100 }));
    return { vista, buckets: buckets || [] };
}

async function columnaDe(projectId, nombre) {
    const { vista, buckets } = await columnas(projectId);
    const buscado = String(nombre).trim().toLowerCase();
    const b = buckets.find(x => x.title.toLowerCase() === buscado)
        || buckets.find(x => x.title.toLowerCase().includes(buscado));
    if (!b) throw new Error('No hay columna "' + nombre + '". Hay: ' + buckets.map(x => x.title).join(', '));
    return { vista, bucket: b };
}

async function usuariosDe(projectId) {
    return cacheado('usuarios:' + projectId, () => api('GET', '/projects/' + projectId + '/projectusers'));
}

async function usuarioDe(projectId, ref) {
    const lista = await usuariosDe(projectId);
    const buscado = String(ref).trim().toLowerCase();
    const u = lista.find(x => x.username.toLowerCase() === buscado)
        || lista.find(x => (x.name || '').toLowerCase() === buscado)
        || lista.find(x => x.username.toLowerCase().includes(buscado) || (x.name || '').toLowerCase().includes(buscado));
    if (!u) throw new Error('No encontre a "' + ref + '" en el proyecto. Hay: ' + lista.map(x => x.username).join(', '));
    return u;
}

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
        'url: ' + URL_BASE + '/tasks/' + t.id,
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

const HERRAMIENTAS = [
    {
        name: 'listar_proyectos',
        description: 'Lista los proyectos de Vikunja visibles para el usuario, con su id.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            const l = await proyectos();
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
        run: async a => {
            const p = await proyectoDe(a.proyecto);
            const { buckets } = await columnas(p.id);
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
        run: async a => {
            const p = await proyectoDe(a.proyecto);
            const t = await api('GET', '/projects/' + p.id + '/tasks' + qs({
                filter: a.incluir_hechas ? undefined : 'done = false',
                filter_timezone: TZ,
                s: a.buscar,
                per_page: a.limite || 50
            }));
            if (!t || !t.length) return 'Sin tareas que coincidan en "' + p.title + '".';
            return 'Tareas de "' + p.title + '" (' + t.length + '):\n' + t.map(resumirTarea).join('\n');
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
        run: async a => {
            const t = await api('GET', '/tasks' + qs({
                s: a.texto,
                filter: a.incluir_hechas ? undefined : 'done = false',
                filter_timezone: TZ,
                per_page: a.limite || 30
            }));
            if (!t || !t.length) return 'Ninguna tarea coincide con "' + a.texto + '".';
            return t.map(resumirTarea).join('\n');
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
        run: async a => {
            const t = await api('GET', '/tasks/' + a.id);
            let c = null;
            if (a.con_comentarios !== false) {
                try { c = await api('GET', '/tasks/' + a.id + '/comments'); } catch (e) { log('sin comentarios:', e.message); }
            }
            return detallarTarea(t, c);
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
        run: async a => {
            const p = await proyectoDe(a.proyecto);
            const t = await api('PUT', '/projects/' + p.id + '/tasks', {
                title: a.titulo,
                description: a.descripcion || '',
                priority: a.prioridad || 0,
                due_date: fecha(a.vence)
            });
            const hecho = ['Creada #' + t.id + ' "' + t.title + '" en "' + p.title + '"'];
            for (const ref of a.asignar_a || []) {
                try {
                    const u = await usuarioDe(p.id, ref);
                    await api('PUT', '/tasks/' + t.id + '/assignees', { user_id: u.id });
                    hecho.push('asignada a ' + u.username);
                } catch (e) { hecho.push('NO pude asignar a ' + ref + ': ' + e.message); }
            }
            if (a.columna) {
                try {
                    const { vista, bucket } = await columnaDe(p.id, a.columna);
                    await api('POST', '/projects/' + p.id + '/views/' + vista.id + '/buckets/' + bucket.id + '/tasks', { task_id: t.id });
                    hecho.push('movida a "' + bucket.title + '"');
                } catch (e) { hecho.push('NO pude moverla: ' + e.message); }
            }
            hecho.push(URL_BASE + '/tasks/' + t.id);
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
        run: async a => {
            const actual = await api('GET', '/tasks/' + a.id);
            const cambios = {};
            if (a.titulo !== undefined) cambios.title = a.titulo;
            if (a.descripcion !== undefined) cambios.description = a.descripcion;
            if (a.prioridad !== undefined) cambios.priority = a.prioridad;
            if (a.vence !== undefined) cambios.due_date = a.vence === '' ? '0001-01-01T00:00:00Z' : fecha(a.vence);
            if (a.hecha !== undefined) cambios.done = a.hecha;
            if (!Object.keys(cambios).length) return 'No me pasaste ningun cambio para #' + a.id + '.';
            // La API espera la tarea completa: parto de la actual y encimo los cambios.
            const t = await api('POST', '/tasks/' + a.id, Object.assign({}, actual, cambios));
            return 'Actualizada #' + t.id + ': ' + Object.keys(cambios).join(', ') + '\n' + resumirTarea(t);
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
        run: async a => {
            const t = await api('GET', '/tasks/' + a.id);
            const { vista, bucket } = await columnaDe(t.project_id, a.columna);
            await api('POST', '/projects/' + t.project_id + '/views/' + vista.id + '/buckets/' + bucket.id + '/tasks', { task_id: t.id });
            return '#' + t.id + ' "' + t.title + '" movida a "' + bucket.title + '".';
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
        run: async a => {
            const t = await api('GET', '/tasks/' + a.id);
            const hecho = [];
            for (const ref of a.agregar || []) {
                const u = await usuarioDe(t.project_id, ref);
                await api('PUT', '/tasks/' + t.id + '/assignees', { user_id: u.id });
                hecho.push('+ ' + u.username);
            }
            for (const ref of a.sacar || []) {
                const u = await usuarioDe(t.project_id, ref);
                await api('DELETE', '/tasks/' + t.id + '/assignees/' + u.id);
                hecho.push('- ' + u.username);
            }
            if (!hecho.length) return 'Asignados actuales de #' + t.id + ': ' + ((t.assignees || []).map(x => x.username).join(', ') || 'nadie');
            return '#' + t.id + ': ' + hecho.join(', ');
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
        run: async a => {
            await api('PUT', '/tasks/' + a.id + '/comments', { comment: a.texto });
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
        run: async a => {
            const etiquetas = await cacheado('etiquetas', () => api('GET', '/labels' + qs({ per_page: 200 }))) || [];
            const buscar = n => {
                const b = String(n).trim().toLowerCase();
                const l = etiquetas.find(x => x.title.toLowerCase() === b) || etiquetas.find(x => x.title.toLowerCase().includes(b));
                if (!l) throw new Error('No existe la etiqueta "' + n + '". Hay: ' + etiquetas.map(x => x.title).join(', '));
                return l;
            };
            const hecho = [];
            for (const n of a.agregar || []) {
                const l = buscar(n);
                await api('PUT', '/tasks/' + a.id + '/labels', { label_id: l.id });
                hecho.push('+ ' + l.title);
            }
            for (const n of a.sacar || []) {
                const l = buscar(n);
                await api('DELETE', '/tasks/' + a.id + '/labels/' + l.id);
                hecho.push('- ' + l.title);
            }
            return hecho.length ? '#' + a.id + ': ' + hecho.join(', ') : 'Etiquetas disponibles: ' + etiquetas.map(x => x.title).join(', ');
        }
    },
    {
        name: 'quien_soy',
        description: 'Muestra con que usuario de Vikunja esta operando este MCP. Sirve para verificar la config.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
            try {
                const u = await api('GET', '/user');
                return 'Conectado a ' + URL_BASE + ' como ' + u.username + (u.name ? ' (' + u.name + ')' : '') + ', id ' + u.id + '.';
            } catch (e) {
                // Los API tokens de Vikunja no siempre alcanzan /user; con ver proyectos alcanza.
                const l = await proyectos();
                return 'Conectado a ' + URL_BASE + '. El token no lee /user, pero ve ' + l.length + ' proyectos.';
            }
        }
    }
];

const PORNOMBRE = new Map(HERRAMIENTAS.map(h => [h.name, h]));

// ---------- MCP sobre stdio ----------

function responder(id, resultado) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: resultado }) + '\n');
}

function fallar(id, codigo, mensaje) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: codigo, message: mensaje } }) + '\n');
}

async function atender(msg) {
    const { id, method, params } = msg;

    if (method === 'initialize') {
        return responder(id, {
            protocolVersion: (params && params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vikunja', version: '1.0.0' }
        });
    }
    if (method && method.startsWith('notifications/')) return;
    if (method === 'ping') return responder(id, {});
    if (method === 'tools/list') {
        return responder(id, { tools: HERRAMIENTAS.map(h => ({ name: h.name, description: h.description, inputSchema: h.inputSchema })) });
    }
    if (method === 'tools/call') {
        const h = PORNOMBRE.get(params && params.name);
        if (!h) return fallar(id, -32602, 'No existe la herramienta ' + (params && params.name));
        try {
            const texto = await h.run((params && params.arguments) || {});
            return responder(id, { content: [{ type: 'text', text: String(texto) }] });
        } catch (e) {
            log('fallo ' + h.name + ':', e.message);
            return responder(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
        }
    }
    if (id !== undefined) fallar(id, -32601, 'Metodo no soportado: ' + method);
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
        Promise.resolve(atender(msg)).catch(e => log('error interno:', e.message));
    }
});
process.stdin.on('end', () => process.exit(0));

if (!TOKEN) {
    log('ERROR: falta VIKUNJA_TOKEN. Sacalo de Ajustes > Tokens API en Vikunja.');
    process.exit(1);
}
log('vikunja-mcp listo contra ' + URL_BASE);
