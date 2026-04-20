// ══════════════════════════════════════════════════════════════════════════════
// API — shared fetch helpers (AS and SEC defined in constants.js)
// ══════════════════════════════════════════════════════════════════════════════

function api(payload){ return fetch(AS,{method:'POST',body:JSON.stringify(payload)}).then(r=>r.json()); }
function apiGet(params){ return fetch(AS+'?'+new URLSearchParams(params)).then(r=>r.json()); }
