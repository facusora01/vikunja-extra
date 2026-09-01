const fs = require("fs");
const raw = fs.readFileSync(__dirname + "/.env", "utf8").replace(/^\uFEFF/, "");
const env = {};
for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
}
module.exports = env;
