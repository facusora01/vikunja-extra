/* vikunja-eventos — empuja los cambios de Vikunja a los navegadores por WebSocket.
 *
 * No hace polling: PostgreSQL avisa por LISTEN/NOTIFY (disparado por triggers)
 * y este servicio reenvia el aviso a los clientes conectados que tengan acceso
 * al proyecto afectado.
 *
 * Solo viaja "cambio algo en el proyecto N" — nunca contenido de las tareas.
 * Cada cliente se autentica con su propio token de Vikunja.
 */
'use strict';

const http = require('http');
const { Client } = require('pg');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PUERTO || '3457', 10);
const CANAL = 'vikunja_cambio';
const VIKUNJA = process.env.VIKUNJA_URL || 'http://127.0.0.1:3456';
const PG = {
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'vikunja',
    user: process.env.PGUSER || 'vikunja_eventos',
    password: process.env.PGPASSWORD
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- clientes ----------
// cliente = { ws, userId, proyectos: Map<projectId, tsDeVerificacion> }
const clientes = new Set();
const TTL_PERMISO = 5 * 60 * 1000;

async function usuarioDe(token) {
    try {
        const r = await fetch(VIKUNJA + '/api/v1/user', { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return null;
        const u = await r.json();
        return u && u.id ? u : null;
    } catch (e) { return null; }
}

// Verifica contra Vikunja que el usuario pueda ver el proyecto (cacheado)
async function puedeVer(c, projectId) {
    const ahora = Date.now();
    const visto = c.proyectos.get(projectId);
    if (visto && ahora - visto.ts < TTL_PERMISO) return visto.ok;
    let ok = false;
    try {
        const r = await fetch(VIKUNJA + '/api/v1/projects/' + projectId, { headers: { Authorization: 'Bearer ' + c.token } });
        ok = r.ok;
    } catch (e) { ok = false; }
    c.proyectos.set(projectId, { ok, ts: ahora });
    return ok;
}

async function repartir(evento) {
    for (const c of clientes) {
        if (c.ws.readyState !== 1) continue;
        try {
            if (await puedeVer(c, evento.project_id)) {
                c.ws.send(JSON.stringify({ tipo: 'cambio', project_id: evento.project_id, origen: evento.tabla, op: evento.op }));
            }
        } catch (e) { /* si falla un cliente, no arrastra a los demas */ }
    }
}

// ---------- postgres ----------
let pg = null;

async function conectarPg() {
    pg = new Client(PG);
    pg.on('error', e => { log('error de postgres:', e.message); reconectar(); });
    await pg.connect();
    await pg.query('LISTEN ' + CANAL);
    log('escuchando el canal', CANAL);
    pg.on('notification', msg => {
        let ev;
        try { ev = JSON.parse(msg.payload); } catch (e) { return; }
        if (!ev || !ev.project_id) return;
        repartir(ev);
    });
}

let reintento = null;
function reconectar() {
    if (reintento) return;
    try { if (pg) pg.end().catch(() => { }); } catch (e) { }
    reintento = setTimeout(async () => {
        reintento = null;
        try { await conectarPg(); } catch (e) { log('reintento fallido:', e.message); reconectar(); }
    }, 3000);
}

// ---------- servidor ----------
const server = http.createServer((req, res) => {
    if (req.url === '/salud') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clientes: clientes.size, pg: !!pg }));
        return;
    }
    res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/_extra/ws' });

wss.on('connection', ws => {
    const c = { ws, token: null, userId: null, proyectos: new Map(), vivo: true };
    // Si no se autentica en 10 segundos, se cierra
    const plazo = setTimeout(() => { if (!c.userId) ws.close(4001, 'sin autenticar'); }, 10000);

    ws.on('message', async raw => {
        let m;
        try { m = JSON.parse(raw.toString().slice(0, 4000)); } catch (e) { return; }
        if (m.tipo === 'auth' && !c.userId) {
            const u = await usuarioDe(m.token);
            if (!u) { ws.close(4003, 'token invalido'); return; }
            c.token = m.token;
            c.userId = u.id;
            clearTimeout(plazo);
            clientes.add(c);
            ws.send(JSON.stringify({ tipo: 'listo', usuario: u.username }));
            log('conectado:', u.username, '| clientes:', clientes.size);
        } else if (m.tipo === 'ping') {
            ws.send(JSON.stringify({ tipo: 'pong' }));
        }
    });

    ws.on('pong', () => { c.vivo = true; });
    ws.on('close', () => { clearTimeout(plazo); clientes.delete(c); });
    ws.on('error', () => { clientes.delete(c); });
});

// Descarta conexiones muertas (celular que perdio señal, tapa cerrada, etc.)
setInterval(() => {
    for (const c of clientes) {
        if (!c.vivo) { try { c.ws.terminate(); } catch (e) { } clientes.delete(c); continue; }
        c.vivo = false;
        try { c.ws.ping(); } catch (e) { }
    }
}, 30000);

(async () => {
    if (!PG.password) { console.error('Falta PGPASSWORD'); process.exit(1); }
    await conectarPg();
    server.listen(PORT, '127.0.0.1', () => log('websocket escuchando en 127.0.0.1:' + PORT + '/_extra/ws'));
})().catch(e => { console.error('no arranco:', e.message); process.exit(1); });
