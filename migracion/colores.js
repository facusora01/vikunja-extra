const { linear } = require("./lin");
const { VIKUNJA_TOKEN } = require("./env");
const VK = "http://127.0.0.1:3456/api/v1";
const h = { Authorization: "Bearer " + VIKUNJA_TOKEN, "Content-Type": "application/json" };

// Colores para las etiquetas de estado (no vienen de Linear)
const ESTADO = { "estado: Backlog": "6b7280", "estado: In Review": "f59e0b", "estado: Done": "22c55e", "estado: Canceled": "ef4444" };

(async () => {
    const d = await linear("{ issueLabels(first:100){ nodes{ name color } } }");
    const linearColor = {};
    d.issueLabels.nodes.forEach(l => { linearColor[l.name] = l.color.replace("#", ""); });
    console.log("colores en Linear:", Object.entries(linearColor).map(([k,v]) => k+"="+v).join(", "));

    const labels = await (await fetch(VK + "/labels", { headers: h })).json();
    for (const l of labels) {
        const hex = linearColor[l.title] || ESTADO[l.title];
        if (!hex) { console.log("  sin color para: " + l.title); continue; }
        const r = await fetch(VK + "/labels/" + l.id, { method: "POST", headers: h, body: JSON.stringify({ title: l.title, hex_color: hex }) });
        console.log((r.ok ? "  ok  " : "  ERR ") + l.title + " -> #" + hex);
    }
})();
