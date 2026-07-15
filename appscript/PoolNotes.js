// ══════════════════════════════════════════════════════════════════════════════
// PoolNotes.gs
// Per-pool operational notes / alerts shown on the Schedule pool cards and in the
// Sales Hub drawer. NOT cleaning instructions — messages & awareness.
//
// Stored in a Pool_Notes sheet in the Routes SS (RD_ROUTES_SS_ID).
// Two scopes:
//   always → shows every week for that pool (neutral ongoing context)
//   week   → shows only for one route week (week_start Monday); naturally gone after
//
// Public API (invoked from WebhookReceiver.js):
//   getPoolNotesForWeek_(weekStart)      → { ok, week_start, notes: { [pool_id]: [...] } }
//   getPoolNotesForPool_(poolId, weekS)  → { ok, notes: [...] }
//   savePoolNote_(payload, auth)         → { ok, note }         (admin/manager only)
//   deletePoolNote_(noteId)              → { ok, note_id, pool_id }
//
// Reuses globals from RouteData.js: RD_ROUTES_SS_ID, RD_TZ, getWeekStart_,
// getWeekStartForDate_.
// ══════════════════════════════════════════════════════════════════════════════

const PN_SHEET_NAME = 'Pool_Notes';
const PN_MAX_LEN    = 800;   // soft cap — alert board, not a journal
const PN_CACHE_TTL  = 300;   // seconds
const PN_REG_KEY    = 'pool_notes_weeks';  // best-effort registry of cached week keys

const PN_HEADERS = [
  'note_id',      // UUID
  'pool_id',
  'scope',        // always | week
  'week_start',   // yyyy-MM-dd Monday — only for scope=week
  'text',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at'
];

// ─── Sheet bootstrap ──────────────────────────────────────────────────────────
function ensurePoolNotesSheet_() {
  const ss = SpreadsheetApp.openById(RD_ROUTES_SS_ID);
  let sheet = ss.getSheetByName(PN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PN_SHEET_NAME);
    sheet.appendRow(PN_HEADERS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 280);
  }
  return sheet;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function pnHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h || '').trim().toLowerCase(); });
  const map = {};
  headers.forEach(function(h, i) { map[h] = i; });
  return map;
}

function pnRowToNote_(row, hm) {
  return {
    note_id:    String(row[hm['note_id']]    || ''),
    pool_id:    String(row[hm['pool_id']]    || ''),
    scope:      String(row[hm['scope']]      || 'always'),
    week_start: String(row[hm['week_start']] || ''),
    text:       String(row[hm['text']]       || ''),
    created_by: String(row[hm['created_by']] || ''),
    created_at: String(row[hm['created_at']] || ''),
    updated_by: String(row[hm['updated_by']] || ''),
    updated_at: String(row[hm['updated_at']] || '')
  };
}

// Sort: week notes first, then always; newest-activity-first within each group.
function pnSortNotes_(list) {
  list.sort(function(a, b) {
    if (a.scope !== b.scope) return a.scope === 'week' ? -1 : 1;
    const ta = a.updated_at || a.created_at || '';
    const tb = b.updated_at || b.created_at || '';
    return tb < ta ? -1 : (tb > ta ? 1 : 0);  // desc
  });
  return list;
}

// ─── Cache + best-effort registry invalidation ────────────────────────────────
function pnCache_() { return CacheService.getScriptCache(); }

function pnRegistryAdd_(weekStart) {
  try {
    const c = pnCache_();
    let weeks = [];
    try { weeks = JSON.parse(c.get(PN_REG_KEY) || '[]'); } catch (e) { weeks = []; }
    if (!Array.isArray(weeks)) weeks = [];
    if (weeks.indexOf(weekStart) === -1) {
      weeks.push(weekStart);
      c.put(PN_REG_KEY, JSON.stringify(weeks), 21600);  // 6h — registry outlives entries
    }
  } catch (e) { Logger.log('pnRegistryAdd_ error: ' + e); }
}

// Remove every cached week key (registry is best-effort; also pass explicit weeks
// so we invalidate even if the registry key expired).
function pnInvalidate_(explicitWeeks) {
  const c = pnCache_();
  const keys = {};
  (explicitWeeks || []).forEach(function(w) { if (w) keys['pool_notes:' + w] = true; });
  try {
    const weeks = JSON.parse(c.get(PN_REG_KEY) || '[]');
    if (Array.isArray(weeks)) weeks.forEach(function(w) { if (w) keys['pool_notes:' + w] = true; });
  } catch (e) { /* ignore — explicit weeks still handled */ }
  const list = Object.keys(keys);
  if (list.length) c.removeAll(list);
}

// ─── Reads ────────────────────────────────────────────────────────────────────
// Returns { ok, week_start, notes: { [pool_id]: [note,...] } } for a route week.
function getPoolNotesForWeek_(weekStart) {
  const ws = getWeekStartForDate_(weekStart) || getWeekStart_();
  const cacheKey = 'pool_notes:' + ws;
  const cached = pnCache_().get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to recompute */ }
  }

  const notes = pnReadRelevant_(ws, null);
  const byPool = {};
  notes.forEach(function(n) {
    (byPool[n.pool_id] = byPool[n.pool_id] || []).push(n);
  });
  Object.keys(byPool).forEach(function(pid) { pnSortNotes_(byPool[pid]); });

  const result = { ok: true, week_start: ws, notes: byPool };
  try {
    pnCache_().put(cacheKey, JSON.stringify(result), PN_CACHE_TTL);
    pnRegistryAdd_(ws);
  } catch (e) { Logger.log('getPoolNotesForWeek_ cache error: ' + e); }
  return result;
}

// For the Sales Hub drawer — a single pool's relevant notes (not cached; small).
function getPoolNotesForPool_(poolId, weekStart) {
  const ws = getWeekStartForDate_(weekStart) || getWeekStart_();
  const list = pnSortNotes_(pnReadRelevant_(ws, String(poolId || '')));
  return { ok: true, week_start: ws, pool_id: String(poolId || ''), notes: list };
}

// Read rows relevant to a week: all scope=always, plus scope=week matching ws.
// If poolFilter is set, restrict to that pool_id.
function pnReadRelevant_(ws, poolFilter) {
  const sheet = ensurePoolNotesSheet_();
  if (sheet.getLastRow() < 2) return [];
  const hm   = pnHeaderMap_(sheet);
  const data = sheet.getDataRange().getValues();
  const out  = [];
  for (let i = 1; i < data.length; i++) {
    const n = pnRowToNote_(data[i], hm);
    if (!n.note_id || !n.pool_id) continue;
    if (poolFilter && n.pool_id !== poolFilter) continue;
    if (n.scope === 'week') {
      if (n.week_start !== ws) continue;
    }
    out.push(n);
  }
  return out;
}

// ─── Writes (admin/manager gated at the WebhookReceiver layer) ─────────────────
// Create (no note_id) or update (note_id present). Returns { ok, note } / { ok:false, error }.
function savePoolNote_(payload, auth) {
  try {
    const poolId = String(payload.pool_id || '').trim();
    const text   = String(payload.text || '').trim();
    if (!poolId) return { ok: false, error: 'pool_id required' };
    if (!text)   return { ok: false, error: 'Note text is required' };
    if (text.length > PN_MAX_LEN) return { ok: false, error: 'Note too long (max ' + PN_MAX_LEN + ' chars)' };

    const scope = (String(payload.scope || 'always') === 'week') ? 'week' : 'always';
    const weekStart = scope === 'week'
      ? (getWeekStartForDate_(payload.week_start) || getWeekStart_())
      : '';

    const now      = new Date().toISOString();
    const username = (auth && auth.username) || '';
    const sheet    = ensurePoolNotesSheet_();
    const hm       = pnHeaderMap_(sheet);
    const noteId   = String(payload.note_id || '').trim();

    if (noteId) {
      // Update existing row
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][hm['note_id']] || '').trim() === noteId) {
          const oldWeek = String(data[i][hm['week_start']] || '');  // capture before write
          sheet.getRange(i + 1, hm['scope']      + 1).setValue(scope);
          sheet.getRange(i + 1, hm['week_start'] + 1).setValue(weekStart);
          sheet.getRange(i + 1, hm['text']       + 1).setValue(text);
          sheet.getRange(i + 1, hm['updated_by'] + 1).setValue(username);
          sheet.getRange(i + 1, hm['updated_at'] + 1).setValue(now);
          pnInvalidate_([oldWeek, weekStart, getWeekStart_()]);
          const row = sheet.getRange(i + 1, 1, 1, sheet.getLastColumn()).getValues()[0];
          return { ok: true, note: pnRowToNote_(row, hm) };
        }
      }
      return { ok: false, error: 'Note not found' };
    }

    // Create new row
    const id  = Utilities.getUuid();
    const row = [];
    row[hm['note_id']]    = id;
    row[hm['pool_id']]    = poolId;
    row[hm['scope']]      = scope;
    row[hm['week_start']] = weekStart;
    row[hm['text']]       = text;
    row[hm['created_by']] = username;
    row[hm['created_at']] = now;
    row[hm['updated_by']] = '';
    row[hm['updated_at']] = '';
    sheet.appendRow(row);
    pnInvalidate_([weekStart, getWeekStart_()]);
    return { ok: true, note: pnRowToNote_(row, hm) };
  } catch (err) {
    Logger.log('savePoolNote_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}

function deletePoolNote_(noteId) {
  try {
    const id = String(noteId || '').trim();
    if (!id) return { ok: false, error: 'note_id required' };
    const sheet = ensurePoolNotesSheet_();
    if (sheet.getLastRow() < 2) return { ok: false, error: 'Note not found' };
    const hm   = pnHeaderMap_(sheet);
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][hm['note_id']] || '').trim() === id) {
        const note = pnRowToNote_(data[i], hm);  // read before delete for cache + response
        sheet.deleteRow(i + 1);
        pnInvalidate_([note.week_start, getWeekStart_()]);
        return { ok: true, note_id: id, pool_id: note.pool_id };
      }
    }
    return { ok: false, error: 'Note not found' };
  } catch (err) {
    Logger.log('deletePoolNote_ error: ' + err);
    return { ok: false, error: String(err) };
  }
}
