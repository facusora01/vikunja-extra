const { VIKUNJA_TOKEN } = require("./env");
const VK = "http://127.0.0.1:3456/api/v1";
const h = { Authorization: "Bearer " + VIKUNJA_TOKEN };
const g = async p => (await fetch(VK + p, { headers: h })).json();
(async () => {
    const ps = (await g("/projects")).sort((a, b) => a.id - b.id);
    let tot = 0;
    console.log("PROYECTO                                          tareas  columnas del kanban");
    for (const p of ps) {
        const r = await fetch(VK + "/projects/" + p.id + "/tasks?per_page=1&filter=done%20%3D%20true%20%7C%7C%20done%20%3D%20false", { headers: h });
        const n = parseInt(r.headers.get("x-pagination-total-count") || "0", 10);
        tot += n;
        const views = await g("/projects/" + p.id + "/views");
        const kb = views.find(v => v.view_kind === "kanban");
        const bs = kb ? await g("/projects/" + p.id + "/views/" + kb.id + "/tasks") : [];
        const cols = (bs || []).map(b => b.title + ":" + b.count).join("  ");
        console.log(p.title.slice(0, 46).padEnd(48) + String(n).padStart(5) + "   " + cols);
    }
    const ls = await g("/labels");
    console.log("\nTOTAL: " + tot + " tareas | " + ls.length + " etiquetas: " + ls.map(l => l.title).join(", "));
})();
