/* Migra "Comunidad CED" de Linear a Vikunja, con maxima fidelidad.
 *
 *   node migrar2.js                      -> simulacion
 *   node migrar2.js --aplicar            -> migra todo
 *   node migrar2.js --aplicar --solo "5." -> migra solo los milestones que empiezan asi (piloto)
 *
 * Deja el mapa identifier -> task_id en mapa.json, para las pasadas siguientes
 * (relaciones y asignaciones).
 */
const fs = require('fs');
const { linear } = require('./lin');
const { VIKUNJA_TOKEN } = require('./env');

const VK = 'http://127.0.0.1:3456/api/v1';
const APLICAR = process.argv.includes('--aplicar');
const SOLO = (() => { const i = process.argv.indexOf('--solo'); return i > -1 ? process.argv[i + 1] : null; })();
const PROYECTO_LINEAR = 'Comunidad CED';
const PADRE = 1;
const MAPA = __dirname + '/mapa.json';

const PRIO = { 0: 0, 1: 4, 2: 3, 3: 2, 4: 1 };
const ESTADOS = ['Backlog', 'In Review', 'Done', 'Canceled'];

async function vk(path, method = 'GET', body) {
    for (let intento = 1; ; intento++) {
        try {
            const r = await fetch(VK + path, {
                method,
                headers: { Authorization: 'Bearer ' + VIKUNJA_TOKEN, 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            });
            if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 160));
            return r.status === 204 ? null : r.json();
        } catch (e) {
            if (intento >= 3) throw e;
            await new Promise(s => setTimeout(s, 400 * intento));
        }
    }
}

function md2html(md) {
    if (!md || !md.trim()) return '';
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bloques = [];
    md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => {
        bloques.push('<pre><code>' + esc(c.replace(/\n$/, '')) + '</code></pre>');
        return '' + (bloques.length - 1) + '';
    });
    const inline = t => esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">[imagen: $1]</a>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    const out = [];
    let lista = null;
    const cerrar = () => { if (lista) { out.push('</' + lista + '>'); lista = null; } };
    for (const raw of md.split(/\r?\n/)) {
        const l = raw.trim();
        const ph = l.match(/^(\d+)$/);
        if (ph) { cerrar(); out.push(bloques[+ph[1]]); continue; }
        if (!l) { cerrar(); continue; }
        const h = l.match(/^(#{1,6})\s+(.*)$/);
        if (h) { cerrar(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
        const tarea = l.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
        const ul = l.match(/^[-*]\s+(.*)$/);
        const ol = l.match(/^\d+[.)]\s+(.*)$/);
        if (tarea) {
            if (lista !== 'ul') { cerrar(); out.push('<ul>'); lista = 'ul'; }
            out.push('<li>' + (tarea[1].toLowerCase() === 'x' ? '&#9745;' : '&#9744;') + ' ' + inline(tarea[2]) + '</li>');
        } else if (ul) {
            if (lista !== 'ul') { cerrar(); out.push('<ul>'); lista = 'ul'; }
            out.push('<li>' + inline(ul[1]) + '</li>');
        } else if (ol) {
            if (lista !== 'ol') { cerrar(); out.push('<ol>'); lista = 'ol'; }
            out.push('<li>' + inline(ol[1]) + '</li>');
        } else {
            cerrar();
            out.push('<p>' + inline(l) + '</p>');
        }
    }
    cerrar();
    return out.join('\n');
}

async function traerIssues() {
    const p = await linear('{ projects(first:50){ nodes{ id name } } }');
    const proj = p.projects.nodes.find(x => x.name === PROYECTO_LINEAR);
    if (!proj) throw new Error('No encontre el proyecto ' + PROYECTO_LINEAR);
    const out = [];
    let after = null;
    do {
        const d = await linear('query($id:String!,$after:String){ project(id:$id){' +
            ' issues(first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{' +
            ' identifier title description priority dueDate createdAt url' +
            ' projectMilestone{name} state{name type} assignee{name email}' +
            ' labels(first:15){nodes{name}} parent{identifier}' +
            ' relations(first:20){nodes{type relatedIssue{identifier}}}' +
            ' attachments(first:15){nodes{title url}}' +
            ' comments(first:50){nodes{body createdAt user{name}}} } } } }',
            { id: proj.id, after });
        const c = d.project.issues;
        out.push(...c.nodes);
        after = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null;
        process.stderr.write('\r  descargando de Linear: ' + out.length + ' issues...');
    } while (after);
    process.stderr.write('\n');
    return out;
}

(async () => {
    console.log(APLICAR ? '*** MODO REAL ***' : '*** SIMULACION (no escribe nada) ***');
    if (SOLO) console.log('*** Filtrado a milestones que empiezan con: ' + SOLO + ' ***');
    console.log('');

    let issues = await traerIssues();
    if (SOLO) issues = issues.filter(i => (i.projectMilestone && i.projectMilestone.name || '').startsWith(SOLO));

    const proyectos = await vk('/projects');
    const porTitulo = Object.fromEntries(proyectos.map(p => [p.title, p.id]));
    const destino = i => (i.projectMilestone && porTitulo[i.projectMilestone.name]) || PADRE;

    const faltantes = new Set();
    issues.forEach(i => {
        const m = i.projectMilestone && i.projectMilestone.name;
        if (m && !porTitulo[m]) faltantes.add(m);
    });
    if (faltantes.size) {
        console.log('ERROR: milestones sin subproyecto:'); faltantes.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }

    const etiquetas = new Set();
    issues.forEach(i => {
        i.labels.nodes.forEach(l => etiquetas.add(l.name));
        etiquetas.add('estado: ' + i.state.name);
    });

    const resumen = {};
    issues.forEach(i => {
        const k = (i.projectMilestone && i.projectMilestone.name) || '(sin milestone) -> padre';
        resumen[k] = (resumen[k] || 0) + 1;
    });
    console.log('=== DESTINO ===');
    Object.entries(resumen).sort().forEach(([k, v]) => console.log('  ' + String(v).padStart(3) + ' -> ' + k));
    console.log('\ntareas: ' + issues.length
        + ' | completadas: ' + issues.filter(i => ['completed', 'canceled'].includes(i.state.type)).length
        + ' | comentarios: ' + issues.reduce((a, i) => a + i.comments.nodes.length, 0)
        + ' | adjuntos: ' + issues.reduce((a, i) => a + i.attachments.nodes.length, 0)
        + ' | sub-issues: ' + issues.filter(i => i.parent).length
        + ' | relaciones: ' + issues.reduce((a, i) => a + i.relations.nodes.length, 0));

    if (!APLICAR) { console.log('\nPara aplicar: node migrar2.js --aplicar'); return; }

    // ---------- 1. etiquetas ----------
    const labelId = {};
    for (const l of (await vk('/labels')) || []) labelId[l.title] = l.id;
    for (const nombre of etiquetas) {
        if (!labelId[nombre]) labelId[nombre] = (await vk('/labels', 'PUT', { title: nombre })).id;
    }
    console.log('\n1/4 etiquetas listas (' + etiquetas.size + ')');

    // ---------- 2. buckets de kanban por proyecto ----------
    const buckets = {}; // projectId -> { viewId, porEstado: {estado: bucketId} }
    for (const pid of [...new Set(issues.map(destino))]) {
        const views = await vk('/projects/' + pid + '/views');
        const kanban = views.find(v => v.view_kind === 'kanban' || v.view_kind === 3);
        if (!kanban) { console.log('  ojo: proyecto ' + pid + ' sin vista kanban'); continue; }
        const base = '/projects/' + pid + '/views/' + kanban.id + '/buckets';
        const existentes = await vk(base);
        const porEstado = {};
        for (const b of existentes) porEstado[b.title] = b.id;
        // Crea las columnas que faltan y las deja en el orden de Linear
        for (let k = 0; k < ESTADOS.length; k++) {
            const e = ESTADOS[k];
            if (!porEstado[e]) porEstado[e] = (await vk(base, 'PUT', { title: e })).id;
            try { await vk(base + '/' + porEstado[e], 'POST', { title: e, position: (k + 1) * 100 }); } catch (_) { }
        }
        // Borra las columnas por defecto que quedaron vacias (To-Do, Doing...)
        for (const b of existentes) {
            if (ESTADOS.includes(b.title)) continue;
            try { await vk(base + '/' + b.id, 'DELETE'); } catch (_) { }
        }
        buckets[pid] = { viewId: kanban.id, porEstado };
    }
    console.log('2/4 buckets creados en ' + Object.keys(buckets).length + ' proyectos');

    // ---------- 3. tareas ----------
    const mapa = fs.existsSync(MAPA) ? JSON.parse(fs.readFileSync(MAPA, 'utf8')) : {};
    let n = 0;
    const errores = [];
    for (const i of issues) {
        if (mapa[i.identifier]) { n++; continue; } // ya migrada
        try {
            const pid = destino(i);
            let desc = md2html(i.description);
            if (i.attachments.nodes.length) {
                desc += '<h3>Adjuntos</h3><ul>' + i.attachments.nodes
                    .map(a => '<li><a href="' + a.url + '">' + (a.title || a.url).replace(/</g, '&lt;') + '</a></li>').join('') + '</ul>';
            }
            desc += '<hr><p><em>Importado de Linear &middot; <a href="' + i.url + '">' + i.identifier + '</a>'
                + (i.assignee ? ' &middot; asignado a ' + i.assignee.name : '')
                + ' &middot; creado ' + i.createdAt.slice(0, 10) + '</em></p>';

            const body = {
                title: (i.identifier + ' - ' + i.title).slice(0, 250),
                description: desc,
                done: ['completed', 'canceled'].includes(i.state.type),
                priority: PRIO[i.priority] || 0
            };
            if (i.dueDate) body.due_date = new Date(i.dueDate).toISOString();
            const t = await vk('/projects/' + pid + '/tasks', 'PUT', body);
            mapa[i.identifier] = { id: t.id, pid, estado: i.state.name, asignado: i.assignee ? i.assignee.email : null };

            for (const l of [...i.labels.nodes.map(x => x.name), 'estado: ' + i.state.name]) {
                await vk('/tasks/' + t.id + '/labels', 'PUT', { label_id: labelId[l] });
            }
            for (const c of i.comments.nodes) {
                await vk('/tasks/' + t.id + '/comments', 'PUT', {
                    comment: '<p><strong>' + ((c.user && c.user.name) || 'alguien') + '</strong> <em>('
                        + c.createdAt.slice(0, 10) + ', importado de Linear)</em></p>' + md2html(c.body)
                });
            }
            const b = buckets[pid];
            if (b && b.porEstado[i.state.name]) {
                await vk('/projects/' + pid + '/views/' + b.viewId + '/buckets/' + b.porEstado[i.state.name] + '/tasks', 'POST', { task_id: t.id });
            }
            n++;
            if (n % 5 === 0) {
                process.stderr.write('\r  ' + n + '/' + issues.length + ' tareas...');
                fs.writeFileSync(MAPA, JSON.stringify(mapa, null, 1));
            }
        } catch (e) { errores.push(i.identifier + ': ' + e.message); }
    }
    fs.writeFileSync(MAPA, JSON.stringify(mapa, null, 1));
    console.log('\n3/4 tareas creadas: ' + n + '/' + issues.length);

    // ---------- 4. relaciones y jerarquia ----------
    let rel = 0;
    const relErr = [];
    for (const i of issues) {
        const yo = mapa[i.identifier];
        if (!yo) continue;
        const pares = [];
        if (i.parent && mapa[i.parent.identifier]) pares.push([mapa[i.parent.identifier].id, 'parenttask']);
        for (const r of i.relations.nodes) {
            const otro = r.relatedIssue && mapa[r.relatedIssue.identifier];
            if (!otro) continue;
            if (r.type === 'blocks') pares.push([otro.id, 'blocking']);
            else if (r.type === 'related') pares.push([otro.id, 'related']);
            else if (r.type === 'duplicate') pares.push([otro.id, 'duplicates']);
        }
        for (const [otroId, kind] of pares) {
            try { await vk('/tasks/' + yo.id + '/relations', 'PUT', { other_task_id: otroId, relation_kind: kind }); rel++; }
            catch (e) { relErr.push(i.identifier + ' ' + kind + ': ' + e.message); }
        }
    }
    console.log('4/4 relaciones creadas: ' + rel);

    if (errores.length) { console.log('\nERRORES en tareas (' + errores.length + '):'); errores.slice(0, 15).forEach(e => console.log('  ' + e)); }
    if (relErr.length) { console.log('\nERRORES en relaciones (' + relErr.length + '):'); relErr.slice(0, 10).forEach(e => console.log('  ' + e)); }
    console.log('\nmapa guardado en ' + MAPA);
})().catch(e => { console.error('ERROR FATAL:', e.message); process.exit(1); });
