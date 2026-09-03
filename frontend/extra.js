/* Vikunja Extra — agregados propios sobre la interfaz de Vikunja.
 *
 *  1. Asignación rápida: botón en cada tarjeta del Kanban para asignar
 *     gente sin abrir la tarea.
 *  2. Tiempo real: recibe por websocket los cambios que hacen los demas
 *     (los dispara Postgres, no hay consultas periodicas) y refresca la
 *     vista, o avisa con un boton si estas escribiendo.
 *
 * Se inyecta vía nginx (sub_filter). No requiere instalar nada en el navegador.
 */
(function () {
    'use strict';

    var API = '/api/v1';

    var PREF = 'vkextra:autorefresh';

    // ---------- utilidades ----------

    // El token de sesión lo guarda el frontend en localStorage; lo buscamos
    // por forma (un JWT empieza con "eyJ") para no depender del nombre.
    function token() {
        for (var i = 0; i < localStorage.length; i++) {
            var v = localStorage.getItem(localStorage.key(i));
            if (!v) continue;
            try { v = JSON.parse(v); } catch (e) { }
            if (typeof v === 'string' && v.indexOf('eyJ') === 0) return v;
        }
        return null;
    }

    async function api(path, method, body) {
        var t = token();
        if (!t) throw new Error('sin sesión');
        var r = await fetch(API + path, {
            method: method || 'GET',
            headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status);
        return r.status === 204 ? null : r.json();
    }

    function proyectoActual() {
        var m = location.pathname.match(/\/projects\/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    function ocupado() {
        var a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return true;
        // Un modal abierto suele ser el detalle de una tarea
        return !!document.querySelector('.modal-mask, .task-view, .modal-container');
    }

    var css = document.createElement('style');
    css.textContent = [
        '.vkx-asig{display:flex;align-items:center;margin-left:auto;flex:none;cursor:pointer;padding-left:6px}',
        '.vkx-asig.vkx-flota{float:right;margin:0 0 4px 6px}',
        '.vkx-asig .vkx-av{width:22px;height:22px;border-radius:50%;object-fit:cover;',
        'border:2px solid var(--white,#fff);box-shadow:0 0 0 1px rgba(0,0,0,.12);margin-left:-10px;background:#fff}',
        '.vkx-asig .vkx-av:first-child{margin-left:0}',
        '.vkx-asig:hover .vkx-av{filter:brightness(1.08)}',
        '.vkx-btn{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
        'padding:0;cursor:pointer;border:1px dashed rgba(128,128,128,.6);background:var(--white,#fff);',
        'color:var(--grey-500,#8a8a8a);opacity:.7;transition:opacity .12s,border-color .12s,color .12s}',
        '.vkx-host:hover .vkx-btn,.vkx-btn.vkx-on{opacity:1}',
        '.vkx-btn:hover{border-color:var(--primary,#1973ff);color:var(--primary,#1973ff);opacity:1}',
        '.vkx-btn svg{width:13px;height:13px;display:block}',
        '.vkx-asig.vkx-tiene .vkx-btn{display:none}',
        '.vkx-host:hover .vkx-asig.vkx-tiene .vkx-btn,.vkx-asig.vkx-on .vkx-btn{display:flex;margin-left:-4px}',
        // Los avatares propios de Vikunja se ocultan: ya se ven arriba a la
        // derecha. Se apunta a la clase, no al src: las fotos reales son
        // blob: y las de quien no subio foto son un SVG en data:.
        '.kanban .avatar-wrapper,.vkx-host .avatar-wrapper,',
        '.kanban img.avatar:not(.vkx-av),.vkx-host img.avatar:not(.vkx-av){display:none!important}',
        '.vkx-pop{position:fixed;z-index:9999;min-width:190px;max-height:280px;overflow:auto;background:var(--white,#fff);',
        'border:1px solid rgba(128,128,128,.3);border-radius:6px;box-shadow:0 6px 22px rgba(0,0,0,.22);padding:4px;font-size:13px}',
        '.vkx-pop b{display:block;padding:5px 8px;color:var(--grey-500,#8a8a8a);font-weight:600;font-size:11px;text-transform:uppercase}',
        '.vkx-pop img{width:20px;height:20px;border-radius:50%;object-fit:cover;background:rgba(128,128,128,.2)}',
        '.vkx-pop button{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:6px 8px;border:0;',
        'background:none;cursor:pointer;border-radius:4px;color:inherit;font-size:13px}',
        '.vkx-pop button:hover{background:rgba(128,128,128,.14)}',
        '.vkx-dot{width:8px;height:8px;border-radius:50%;background:var(--primary,#1973ff);flex:none;visibility:hidden}',
        '.vkx-dot.vkx-yes{visibility:visible}',
        '.vkx-avisos{position:fixed;bottom:18px;right:18px;z-index:9999;display:flex;gap:8px;align-items:center;',
        'background:var(--primary,#1973ff);color:#fff;padding:9px 13px;border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.25);',
        'font-size:13px;cursor:pointer}',
        '.vkx-cfg{position:fixed;bottom:18px;left:18px;z-index:9998;font-size:11px;opacity:.5;cursor:pointer;',
        'background:var(--white,#fff);border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:4px 8px}',
        '.vkx-cfg:hover{opacity:1}',
        '.vkx-ico{vertical-align:-2px;margin-right:6px;flex:none}'
    ].join('');
    document.head.appendChild(css);

    // ---------- 1. asignacion rapida ----------
    //
    // Los asignados se leen de la API, no del DOM: Vikunja descarga los
    // avatares con fetch y los deja como blob:, asi que no hay forma de
    // reconocerlos por el src. Tener el dato propio ademas permite actualizar
    // la tarjeta al instante, sin recargar la pagina.

    var asignados = {};      // taskId -> [username]
    var avatarUrl = {};      // username -> blob url (se pide una sola vez)
    var usuariosCache = {};
    var cargaEnCurso = null;

    async function usuariosDe(pid) {
        if (!usuariosCache[pid]) usuariosCache[pid] = await api('/projects/' + pid + '/projectusers');
        return usuariosCache[pid];
    }

    async function avatarDe(username) {
        if (avatarUrl[username]) return avatarUrl[username];
        var r = await fetch(API + '/avatar/' + encodeURIComponent(username) + '?size=30',
            { headers: { Authorization: 'Bearer ' + token() } });
        if (!r.ok) throw new Error('avatar ' + r.status);
        avatarUrl[username] = URL.createObjectURL(await r.blob());
        return avatarUrl[username];
    }

    // Trae los asignados de todas las tareas del proyecto abierto
    async function cargarAsignados() {
        var pid = proyectoActual();
        if (!pid) return;
        if (cargaEnCurso) return cargaEnCurso;
        cargaEnCurso = (async function () {
            try {
                for (var pagina = 1; pagina <= 12; pagina++) {
                    var d = await api('/projects/' + pid + '/tasks?per_page=50&page=' + pagina);
                    if (!Array.isArray(d) || !d.length) break;
                    d.forEach(function (t) {
                        asignados[t.id] = (t.assignees || []).map(function (u) { return u.username; });
                    });
                    if (d.length < 50) break;
                }
            } catch (e) { /* se reintenta en el proximo ciclo */ }
            cargaEnCurso = null;
        })();
        return cargaEnCurso;
    }

    // Trae la gente del proyecto y sus fotos por adelantado
    async function precargarGente(pid) {
        try {
            var users = await usuariosDe(pid);
            users.forEach(function (u) { avatarDe(u.username).catch(function () { }); });
        } catch (e) { }
    }

    function cerrarPop() {
        var p = document.querySelector('.vkx-pop');
        if (p) p.remove();
        var b = document.querySelector('.vkx-asig.vkx-on');
        if (b) b.classList.remove('vkx-on');
    }

    async function abrirPop(cont, taskId) {
        cerrarPop();
        cont.classList.add('vkx-on');
        var pop = document.createElement('div');
        pop.className = 'vkx-pop';
        pop.textContent = 'cargando...';
        document.body.appendChild(pop);
        var r = cont.getBoundingClientRect();
        pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 260) + 'px';
        pop.style.left = Math.max(8, Math.min(r.left - 150, window.innerWidth - 210)) + 'px';

        try {
            var users = await usuariosDe(proyectoActual());
            if (!asignados[taskId]) {
                var t = await api('/tasks/' + taskId);
                asignados[taskId] = (t.assignees || []).map(function (u) { return u.username; });
            }

            pop.innerHTML = '';
            var tit = document.createElement('b');
            tit.textContent = 'Asignar a';
            pop.appendChild(tit);

            users.forEach(function (u) {
                var b = document.createElement('button');
                var dot = document.createElement('span');
                dot.className = 'vkx-dot';
                b.appendChild(dot);
                var foto = document.createElement('img');
                foto.alt = '';
                avatarDe(u.username).then(function (src) { foto.src = src; }).catch(function () { });
                b.appendChild(foto);
                b.appendChild(document.createTextNode(u.name || u.username));
                function pintar() {
                    dot.classList.toggle('vkx-yes', asignados[taskId].indexOf(u.username) > -1);
                }
                pintar();
                b.onclick = function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    var tenia = asignados[taskId].indexOf(u.username) > -1;
                    var antes = asignados[taskId].slice();

                    // Optimista: se actualiza la pantalla ya, y se le avisa al
                    // servidor despues. El websocket no debe recargar por esto.
                    marcarCambio();
                    asignados[taskId] = tenia
                        ? antes.filter(function (x) { return x !== u.username; })
                        : antes.concat([u.username]);
                    pintar();
                    pintarTarjetas();

                    var pedido = tenia
                        ? api('/tasks/' + taskId + '/assignees/' + u.id, 'DELETE')
                        : api('/tasks/' + taskId + '/assignees', 'PUT', { user_id: u.id });

                    pedido.then(function () { marcarCambio(); }).catch(function (e) {
                        asignados[taskId] = antes;   // no se pudo: se revierte
                        pintar();
                        pintarTarjetas();
                        alert('No se pudo asignar: ' + e.message);
                    });
                };
                pop.appendChild(b);
            });

            if (!users.length) pop.innerHTML = '<b>Nadie tiene acceso a este proyecto</b>';
        } catch (e) {
            pop.textContent = 'Error: ' + e.message;
        }
    }

    document.addEventListener('click', function (e) {
        if (!e.target.closest('.vkx-pop') && !e.target.closest('.vkx-asig')) cerrarPop();
    });

    // ---------- 1b. iconos de estado en las columnas ----------
    // Los titulos se identifican por su texto, no por clases CSS: el markup de
    // Vikunja cambia entre versiones, los nombres de las columnas no.

    function circulo(color, dentro, rayado) {
        return '<svg class="vkx-ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">'
            + '<circle cx="7" cy="7" r="6" fill="none" stroke="' + color + '" stroke-width="2"'
            + (rayado ? ' stroke-dasharray="2.5 2"' : '') + '/>' + (dentro || '') + '</svg>';
    }

    var ICONOS = {
        // gris rayado: todavia no empezo
        'Backlog': circulo('#95a2b3', '', true),
        'To-Do': circulo('#95a2b3', '', true),
        // amarillo a medio llenar: en curso
        'In Progress': circulo('#f2c94c', '<path d="M7 7 V2 A5 5 0 0 1 7 12 Z" fill="#f2c94c"/>'),
        'Doing': circulo('#f2c94c', '<path d="M7 7 V2 A5 5 0 0 1 7 12 Z" fill="#f2c94c"/>'),
        // naranja casi lleno: esperando revision
        'In Review': circulo('#f2994a', '<path d="M7 7 V2 A5 5 0 1 1 2.5 9.5 Z" fill="#f2994a"/>'),
        // verde lleno con tilde
        'Done': '<svg class="vkx-ico" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">'
            + '<circle cx="7" cy="7" r="6" fill="#22c55e"/>'
            + '<path d="M4.3 7.2 6.2 9.1 9.7 5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        // gris con cruz
        'Canceled': circulo('#95a2b3', '<path d="M5 5 L9 9 M9 5 L5 9" stroke="#95a2b3" stroke-width="1.6" stroke-linecap="round"/>')
    };

    function decorarColumnas() {
        var k = document.querySelector('.kanban');
        if (!k) return;
        var nodos = k.querySelectorAll('h2, h3, span, div, p, a');
        for (var i = 0; i < nodos.length; i++) {
            var el = nodos[i];
            if (el.children.length || el.dataset.vkxIco) continue;
            var svg = ICONOS[el.textContent.trim()];
            if (!svg) continue;
            el.dataset.vkxIco = '1';
            // Vikunja ya pone un doble tilde en la columna marcada como "hecho";
            // sobra al lado del circulo verde.
            var previo = el.previousElementSibling;
            if (previo && (previo.tagName === 'svg' || previo.querySelector('svg'))) previo.style.display = 'none';
            el.insertAdjacentHTML('afterbegin', svg);
        }
    }

    // Icono circular de persona (el mismo que usa Linear para "asignar")
    var SVG_PERSONA = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">'
        + '<circle cx="8" cy="5.4" r="2.6" stroke="currentColor" stroke-width="1.5"/>'
        + '<path d="M2.9 13.6c0-2.6 2.3-4.2 5.1-4.2s5.1 1.6 5.1 4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
        + '</svg>';

    // Primera fila de la tarjeta (la del numero y la fecha), si es flex
    function filaCabecera(card, a) {
        var candidatos = [card.firstElementChild, a.firstElementChild];
        for (var i = 0; i < candidatos.length; i++) {
            var el = candidatos[i];
            if (!el || el.classList.contains('vkx-asig')) continue;
            var d = getComputedStyle(el).display;
            if (d.indexOf('flex') > -1) return el;
        }
        return null;
    }

    function decorar() {
        var enlaces = document.querySelectorAll('a[href*="/tasks/"]');
        for (var i = 0; i < enlaces.length; i++) {
            var a = enlaces[i];
            if (a.closest('.vkx-pop')) continue;
            var m = a.getAttribute('href').match(/\/tasks\/(\d+)/);
            if (!m) continue;
            // La tarjeta tiene que ser el elemento propio de ESTA tarea. Si
            // .task no existe o el contenedor abarca varias tareas (la columna
            // entera), se usa el enlace: es lo unico que scrollea con la
            // tarjeta y contiene su avatar.
            var card = a.closest('.task');
            if (!card || card.querySelectorAll('a[href*="/tasks/"]').length > 1) card = a;
            // Buscar en toda la tarjeta, no solo en los hijos directos: cuando
            // hay fila de cabecera el contenedor queda anidado, y una guarda
            // por hijo directo no lo encuentra y lo agrega de nuevo en cada
            // pasada del observer.
            if (card.querySelector('.vkx-asig[data-task="' + m[1] + '"]')) continue;

            card.classList.add('vkx-host');
            var cont = document.createElement('div');
            cont.className = 'vkx-asig';
            cont.title = 'Asignar a alguien del equipo';
            cont.dataset.task = m[1];
            var btn = document.createElement('button');
            btn.className = 'vkx-btn';
            btn.innerHTML = SVG_PERSONA;
            btn.tabIndex = -1;
            cont.appendChild(btn);
            cont.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                abrirPop(this, this.dataset.task);
            });
            cont.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });

            var fila = filaCabecera(card, a);
            if (fila) {
                fila.appendChild(cont);
            } else {
                // Sin fila donde encajar: float dentro de la tarjeta. Sigue
                // estando en el flujo, asi que se recorta con ella.
                cont.classList.add('vkx-flota');
                (a.firstElementChild ? a : card).insertBefore(cont, (a.firstElementChild ? a : card).firstChild);
            }
        }
        pintarTarjetas();
    }

    // Dibuja los avatares de cada tarjeta segun el mapa de asignados
    function pintarTarjetas() {
        var conts = document.querySelectorAll('.vkx-asig');
        for (var i = 0; i < conts.length; i++) {
            (function (cont) {
                var id = cont.dataset.task;
                var quiero = asignados[id] || [];
                if (cont.dataset.pintado === quiero.join('|')) return;
                cont.dataset.pintado = quiero.join('|');

                var viejos = cont.querySelectorAll('.vkx-av');
                for (var k = 0; k < viejos.length; k++) viejos[k].remove();
                cont.classList.toggle('vkx-tiene', quiero.length > 0);

                var btn = cont.querySelector('.vkx-btn');
                quiero.forEach(function (u) {
                    var im = document.createElement('img');
                    im.className = 'vkx-av';
                    im.alt = u;
                    im.title = u;
                    im.draggable = false;
                    cont.insertBefore(im, btn);
                    avatarDe(u).then(function (src) { im.src = src; })
                        .catch(function () { im.remove(); });
                });
            })(conts[i]);
        }
    }

    // ---------- 2. tiempo real por websocket ----------
    //
    // El servidor de eventos empuja los cambios (los dispara Postgres con
    // LISTEN/NOTIFY). No hay consultas periódicas: se recibe y se actúa.

    var avisoVisible = false;
    var ws = null;
    var reintentoMs = 1000;
    var propio = 0;   // cambios hechos por uno mismo, para no avisarse solo

    function autoOn() { return localStorage.getItem(PREF) !== 'off'; }
    function marcarCambio() { propio = Date.now(); }
    // ---------- 2.bis. marcar como propia cualquier escritura a la API ----------
    //
    // El guard de "cambio propio" solo cubria las acciones de este script. El
    // drag&drop del kanban es codigo nativo de Vikunja (axios -> XHR), asi que
    // movias una tarjeta, el NOTIFY volvia por el websocket como si fuera de
    // otro, y alCambiar() disparaba location.reload(): uno se auto-recargaba.
    // Se envuelven XHR y fetch para que toda escritura a /api/v1/ marque el
    // cambio como propio. Se marca dos veces (al salir y al volver la
    // respuesta) porque el NOTIFY llega recien despues del commit.
    (function () {
        var ESCRITURA = /^(PUT|POST|DELETE|PATCH)$/i;
        function esApi(u) {
            try { return String(u).indexOf("/api/v1/") > -1; } catch (e) { return false; }
        }

        var xhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (metodo, url) {
            if (ESCRITURA.test(metodo) && esApi(url)) {
                marcarCambio();
                this.addEventListener("loadend", marcarCambio);
            }
            return xhrOpen.apply(this, arguments);
        };

        var fetchOrig = window.fetch;
        if (fetchOrig) {
            window.fetch = function (entrada, init) {
                var url = (entrada && entrada.url) || entrada;
                var metodo = (init && init.method) || (entrada && entrada.method) || "GET";
                var propia = ESCRITURA.test(metodo) && esApi(url);
                if (propia) marcarCambio();
                return fetchOrig.apply(this, arguments).then(function (r) {
                    if (propia) marcarCambio();
                    return r;
                });
            };
        }
    })();

    function mostrarAviso() {
        if (avisoVisible) return;
        avisoVisible = true;
        var d = document.createElement('div');
        d.className = 'vkx-avisos';
        d.innerHTML = '<span>&#128260;</span><span>Hay cambios nuevos — actualizar</span>';
        d.onclick = function () { location.reload(); };
        document.body.appendChild(d);
    }

    // Refresco suave: en vez de recargar el documento entero, se le pide al
    // store de kanban que vuelva a traer los buckets. Es el mismo patron que
    // usa Vikunja internamente cuando cambian los filtros de fecha:
    // loadBucketsForProject(projectId, viewId, params).
    // Depende de internals (__vue_app__ / pinia), asi que todo va envuelto en
    // try y devuelve false si algo no esta: el llamador recarga como antes.
    function refrescarSuave() {
        try {
            var raiz = document.querySelector("#app");
            var app = raiz && raiz.__vue_app__;
            if (!app) return false;
            var g = app.config.globalProperties;
            var pinia = g && g.$pinia;
            var router = g && g.$router;
            var kanban = pinia && pinia._s && pinia._s.get("kanban");
            if (!kanban || !router || typeof kanban.loadBucketsForProject !== "function") return false;

            // Solo aplica a la vista kanban: /projects/<id>/<viewId>
            var m = location.pathname.match(/\/projects\/(\d+)\/(\d+)/);
            if (!m) return false;

            kanban.loadBucketsForProject(
                parseInt(m[1], 10),
                parseInt(m[2], 10),
                router.currentRoute.value.query
            );
            return true;
        } catch (e) {
            return false;
        }
    }

    function alCambiar(pid) {
        var actual = proyectoActual();
        // Si el cambio es de otro proyecto, no molesta
        if (actual && pid && actual !== pid) return;
        // Un cambio propio de hace menos de 2s ya se ve en pantalla
        if (Date.now() - propio < 3000) return;
        if (autoOn() && !ocupado()) { if (!refrescarSuave()) location.reload(); }
        else mostrarAviso();
    }

    function conectar() {
        var t = token();
        if (!t) { setTimeout(conectar, 3000); return; }
        var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/_extra/ws';
        try { ws = new WebSocket(url); } catch (e) { reconectarWs(); return; }

        ws.onopen = function () {
            reintentoMs = 1000;
            ws.send(JSON.stringify({ tipo: 'auth', token: t }));
        };
        ws.onmessage = function (ev) {
            var m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.tipo === 'listo') pintarEstado(true);
            else if (m.tipo === 'cambio') alCambiar(m.project_id);
        };
        ws.onclose = function () { pintarEstado(false); reconectarWs(); };
        ws.onerror = function () { try { ws.close(); } catch (e) { } };
    }

    function reconectarWs() {
        // Reintento con espera creciente, hasta 30s
        setTimeout(conectar, reintentoMs);
        reintentoMs = Math.min(reintentoMs * 2, 30000);
    }

    // ---------- arranque ----------

    var cfg = document.createElement('div');
    cfg.className = 'vkx-cfg';
    var conectado = false;
    function pintarCfg() {
        cfg.textContent = (conectado ? '●' : '○') + ' tiempo real: ' + (autoOn() ? 'ON' : 'OFF');
        cfg.title = conectado ? 'Conectado al servidor de eventos' : 'Sin conexión con el servidor de eventos';
    }
    function pintarEstado(ok) { conectado = ok; pintarCfg(); }
    cfg.onclick = function () {
        localStorage.setItem(PREF, autoOn() ? 'off' : 'on');
        pintarCfg();
    };
    pintarCfg();

    var OPCIONES_OBS = { childList: true, subtree: true };

    function todo() { decorar(); decorarColumnas(); }

    // Al cambiar de proyecto hay que releer los asignados
    var proyectoVisto = null;
    function revisarProyecto() {
        var pid = proyectoActual();
        if (pid && pid !== proyectoVisto) {
            proyectoVisto = pid;
            asignados = {};
            cargarAsignados().then(pintarTarjetas);
            precargarGente(pid);
        }
    }

    function arrancar() {
        document.body.appendChild(cfg);
        // El observer se desconecta mientras redecora: lo que pinta extra.js son
        // cambios del DOM y volverian a dispararlo. El rAF junta la rafaga de
        // mutaciones de un re-render de Vue en una sola pasada.
        var obs = null, encolado = false;
        function repasar() {
            if (encolado) return;
            encolado = true;
            requestAnimationFrame(function () {
                encolado = false;
                obs.disconnect();
                try { todo(); } finally { obs.observe(document.body, OPCIONES_OBS); }
            });
        }
        obs = new MutationObserver(repasar);
        obs.observe(document.body, OPCIONES_OBS);
        todo();
        revisarProyecto();
        setInterval(revisarProyecto, 1000);
        conectar();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
    else arrancar();
})();
