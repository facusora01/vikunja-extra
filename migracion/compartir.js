const { VIKUNJA_TOKEN } = require("./env");
const VK = "http://127.0.0.1:3456/api/v1";
const h = { Authorization: "Bearer " + VIKUNJA_TOKEN, "Content-Type": "application/json" };
async function vk(p, m = "GET", b) {
    const r = await fetch(VK + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    return { ok: r.ok, s: r.status, d: r.status === 204 ? null : await r.json().catch(() => null) };
}
(async () => {
    const teams = (await vk("/teams")).d || [];
    console.log("=== EQUIPOS ===");
    for (const t of teams) {
        const det = (await vk("/teams/" + t.id)).d;
        console.log("  id=" + t.id + " \"" + t.name + "\" miembros: " + ((det.members || []).map(m => m.username + (m.admin ? "*" : "")).join(", ") || "(ninguno)"));
    }
    const horn = teams.find(t => /hornero/i.test(t.name));
    if (!horn) { console.log("\nNo encontre el equipo Hornero"); return; }

    console.log("\n=== COMPARTIENDO CON \"" + horn.name + "\" (escritura) ===");
    for (const p of (await vk("/projects")).d.sort((a, b) => a.id - b.id)) {
        const r = await vk("/projects/" + p.id + "/teams", "PUT", { team_id: horn.id, right: 1 });
        const ya = (await vk("/projects/" + p.id + "/teams")).d || [];
        console.log("  " + p.title.slice(0, 42).padEnd(44) + (r.ok ? "ok" : (r.d && r.d.message) || r.s) + "  | equipos: " + ya.map(x => x.name).join(","));
    }
})();
