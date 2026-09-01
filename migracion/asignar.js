const fs = require("fs");
const { VIKUNJA_TOKEN } = require("./env");
const VK = "http://127.0.0.1:3456/api/v1";
const h = { Authorization: "Bearer " + VIKUNJA_TOKEN, "Content-Type": "application/json" };
const USUARIOS = { "facusora1@gmail.com": 1, "micaelafuentes2005@gmail.com": 2, "hernandez.joaquin346@gmail.com": 3 };

async function vk(p, m = "GET", b) {
    const r = await fetch(VK + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    return { ok: r.ok, s: r.status, d: r.status === 204 ? null : await r.json().catch(() => null) };
}

(async () => {
    // 1. compartir todos los proyectos con derecho de escritura
    const ps = (await vk("/projects")).d.sort((a, b) => a.id - b.id);
    console.log("=== COMPARTIENDO (derecho: escritura) ===");
    for (const p of ps) {
        const linea = [];
        for (const uid of [2, 3]) {
            const r = await vk("/projects/" + p.id + "/users", "PUT", { user_id: uid, right: 1 });
            linea.push(uid + ":" + (r.ok ? "ok" : (r.d && r.d.message || r.s)));
        }
        console.log("  " + p.title.slice(0, 42).padEnd(44) + linea.join("  "));
    }

    // 2. asignar segun el mapa guardado en la migracion
    const mapa = JSON.parse(fs.readFileSync("mapa.json", "utf8"));
    const cuenta = {}; let ok = 0; const err = [];
    console.log("\n=== ASIGNANDO ===");
    for (const [ident, t] of Object.entries(mapa)) {
        if (!t.asignado) continue;
        const uid = USUARIOS[t.asignado];
        if (!uid) { err.push(ident + ": sin cuenta para " + t.asignado); continue; }
        const r = await vk("/tasks/" + t.id + "/assignees", "PUT", { user_id: uid });
        if (r.ok) { ok++; cuenta[t.asignado] = (cuenta[t.asignado] || 0) + 1; }
        else err.push(ident + ": " + (r.d && r.d.message || r.s));
    }
    console.log("  asignadas: " + ok);
    Object.entries(cuenta).forEach(([k, v]) => console.log("    " + v + " -> " + k));
    if (err.length) { console.log("  errores: " + err.length); err.slice(0, 8).forEach(e => console.log("    " + e)); }
})();
