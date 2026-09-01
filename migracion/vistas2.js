const { VIKUNJA_TOKEN } = require("./env");
const VK = "http://127.0.0.1:3456/api/v1";
const h = { Authorization: "Bearer " + VIKUNJA_TOKEN, "Content-Type": "application/json" };
const g = async p => (await fetch(VK + p, { headers: h })).json();
const post = async (p, b) => { const r = await fetch(VK + p, { method: "POST", headers: h, body: JSON.stringify(b) }); return { ok: r.ok, t: (await r.text()).slice(0, 120) }; };

(async () => {
    const ps = (await g("/projects")).sort((a, b) => a.id - b.id);
    for (const p of ps) {
        const vs = await g("/projects/" + p.id + "/views");
        const kb = vs.find(v => v.view_kind === "kanban");
        if (!kb) continue;
        const bs = await g("/projects/" + p.id + "/views/" + kb.id + "/tasks");
        const done = bs.find(b => b.title === "Done");

        // 1) Kanban primero, para que sea la vista que abre por defecto
        const orden = { kanban: 100, list: 200, table: 300, gantt: 400 };
        for (const v of vs) {
            await post("/projects/" + p.id + "/views/" + v.id, {
                title: v.title, view_kind: v.view_kind, filter: v.filter && v.filter.filter || "",
                position: orden[v.view_kind] || v.position,
                bucket_configuration_mode: v.bucket_configuration_mode,
                done_bucket_id: v.view_kind === "kanban" && done ? done.id : v.done_bucket_id
            });
        }
        const vs2 = await g("/projects/" + p.id + "/views");
        const kb2 = vs2.find(v => v.view_kind === "kanban");
        console.log(p.title.slice(0, 40).padEnd(42),
            "1a vista: " + vs2.sort((a,b)=>a.position-b.position)[0].view_kind.padEnd(7),
            "done_bucket: " + kb2.done_bucket_id + (done && kb2.done_bucket_id === done.id ? " ok" : " REVISAR"));
    }
})();
