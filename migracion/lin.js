const { LINEAR_KEY } = require('./env');
async function linear(query, variables) {
    const r = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: LINEAR_KEY },
        body: JSON.stringify({ query, variables })
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
}
module.exports = { linear };
