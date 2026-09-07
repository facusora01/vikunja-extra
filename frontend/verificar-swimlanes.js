/* Verifica los supuestos del agrupado por etiqueta contra la instancia real.
 * Pegar en la consola del navegador CON EL KANBAN ABIERTO (/projects/N/M).
 * Solo lee: no escribe nada. */
(async () => {
  const ok = (c, t, extra) => console.log((c ? '%c OK ' : '%c FALLA '), 'background:' + (c?'#22c55e':'#e74c3c') + ';color:#fff;border-radius:3px', t, extra === undefined ? '' : extra);
  const m = location.pathname.match(/\/projects\/(\d+)\/(\d+)/);
  if (!m) return console.error('Abrí primero la vista Kanban de un proyecto (URL /projects/N/M) y volvé a pegar esto.');
  const [, pid, vid] = m;

  // El token, igual que lo busca extra.js: por forma, no por nombre.
  let tk = null;
  for (let i = 0; i < localStorage.length; i++) {
    let v = localStorage.getItem(localStorage.key(i));
    try { v = JSON.parse(v); } catch (e) {}
    if (typeof v === 'string' && v.indexOf('eyJ') === 0) tk = v;
  }
  if (!tk) return console.error('No encontré el token de sesión en localStorage.');

  console.log('%c1. DOM', 'font-weight:bold;font-size:13px');
  const k = document.querySelector('.kanban');
  ok(!!k, '.kanban existe (sin esto el modo no se activa)');
  const buckets = document.querySelectorAll('.kanban .bucket');
  ok(buckets.length > 0, '.kanban .bucket ->', buckets.length + ' columnas');
  const cards = document.querySelectorAll('.task.kanban-card');
  ok(cards.length > 0, '.task.kanban-card ->', cards.length + ' tarjetas visibles');

  console.log('%c2. API: buckets de la vista (la llamada que alimenta las franjas)', 'font-weight:bold;font-size:13px');
  const r = await fetch(`/api/v1/projects/${pid}/views/${vid}/buckets?per_page=100`,
    { headers: { Authorization: 'Bearer ' + tk } });
  ok(r.ok, `GET /projects/${pid}/views/${vid}/buckets ->`, r.status);
  if (!r.ok) return;
  const bs = await r.json();
  ok(Array.isArray(bs), 'devuelve un array de', (bs || []).length + ' columnas');
  console.log('   columnas:', bs.map(b => b.title).join(' > '));

  const conTasks = bs.filter(b => Array.isArray(b.tasks) && b.tasks.length);
  ok(conTasks.length > 0, 'las columnas traen sus tareas embebidas');
  const todas = bs.flatMap(b => b.tasks || []);
  const conLabels = todas.filter(t => Array.isArray(t.labels) && t.labels.length);
  ok(todas.length > 0 && todas.every(t => 'labels' in t), 'cada tarea trae el campo labels');
  ok(conLabels.length > 0, 'hay tareas CON etiquetas ->', conLabels.length + ' de ' + todas.length);
  if (!conLabels.length) console.warn('   Sin ninguna tarea etiquetada vas a ver una sola franja ("Sin etiqueta"). Etiquetá alguna para probar de verdad.');
  ok(todas.some(t => 'priority' in t), 'traen priority (lo usa el menú)');
  ok(todas.some(t => 'assignees' in t), 'traen assignees (evita paginar /tasks)');
  ok(todas.some(t => t.identifier), 'traen identifier (el BACK-42 de los chips)');

  const etiquetas = {};
  todas.forEach(t => (t.labels || []).forEach(l => etiquetas[l.id] = l.title));
  const nEt = Object.keys(etiquetas).length;
  console.log(`   etiquetas en uso: ${nEt ? Object.values(etiquetas).join(', ') : '(ninguna)'}`);
  console.log(`   => se pintarían ${nEt + 1} franjas x ${bs.length} columnas = ${(nEt + 1) * bs.length} celdas`);

  console.log('%c3. Paginación de tareas por columna (el límite conocido)', 'font-weight:bold;font-size:13px');
  let truncada = false;
  for (const b of bs) {
    const n = (b.tasks || []).length;
    const total = b.count !== undefined ? b.count : (b.total_tasks !== undefined ? b.total_tasks : null);
    if (total !== null && n < total) { truncada = true; console.warn(`   "${b.title}": trae ${n} de ${total} tareas`); }
    else console.log(`   "${b.title}": ${n} tareas${total !== null ? ' de ' + total : ''}`);
  }
  ok(!truncada, truncada ? 'alguna columna viene cortada: la franja mostraría de menos' : 'ninguna columna viene cortada');

  console.log('%c4. Internals de Vue (para abrir tareas sin recargar)', 'font-weight:bold;font-size:13px');
  const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
  ok(!!app, '#app.__vue_app__ accesible');
  ok(!!(app && app.config.globalProperties.$router), '$router accesible (si falla, el click en un chip recarga la página — funciona igual, más lento)');

  console.log('%cListo. Si todo salió OK, el modo debería andar. Pasame la salida si algo dio FALLA.', 'font-weight:bold');
})();
