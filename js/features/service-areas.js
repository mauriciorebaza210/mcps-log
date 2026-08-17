// ══════════════════════════════════════════════════════════════════════════════
// SERVICE AREAS — admin management
//
// Depends on: api.js (api), auth.js (_s), constants.js (escHtml, jsArg)
//
// A zone is a named group of ZIP codes served on one weekday. Many zones may
// share a weekday with different technicians; a zone has exactly one day. That
// asymmetry is what lets a customer choose a WEEK without choosing a DAY on the
// signing page.
//
// Three views, in the order the work actually happens:
//
//   Suggestions — derive draft zones from the routes we already run
//   Zones       — the map itself
//   Coverage    — what is still uncovered, worst gaps first
//
// ⚠️ Coverage is not decoration. An address in no zone gets NO customer-facing
// day promise — the signing page falls back to preferred-week mode. A map that
// looks done but isn't is the failure this panel exists to prevent.
// ══════════════════════════════════════════════════════════════════════════════

// Display order only. The days an admin may actually PICK come from the server
// (get_service_areas → schedulable_days), because WEEKDAYS is Mon–Sat and the
// SCHEDULABLE_DAYS property can narrow it further. Hardcoding the picker would
// let someone save a zone on a day no technician can ever work.
const SA_DAY_ORDER = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
const SA_SWATCHES = ['#0d4d44', '#1FA7A8', '#c8a84b', '#7c5cbf', '#c2410c', '#0369a1', '#4d7c0f', '#9d174d'];

// Conservative until the server tells us: Mon–Sat, never Sunday.
let _saSchedulableDays = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
let _saZones = [];
let _saCoverage = null;
let _saProposals = null;
let _saTab = 'zones';
let _saShowArchived = false;
let _saEditing = null;      // zone_id being edited, '' for new, null for none

function saDayLabel(d) {
  const s = String(d || '');
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : '';
}

function saMsg(text, isErr) {
  const el = document.getElementById('sa-msg');
  if (!el) return;
  el.className = isErr ? 'im err' : 'im ok';
  el.style.display = text ? 'block' : 'none';
  el.textContent = text || '';
}

function loadServiceAreas(force) {
  const list = document.getElementById('sa-body');
  if (!list) return;
  if (!_saZones.length) {
    list.innerHTML = '<div class="sa-empty">Loading service areas…</div>';
  }
  api({ action: 'get_service_areas', token: _s ? _s.token : '', include_archived: true })
    .then(res => {
      if (!res || !res.ok) {
        list.innerHTML = `<div class="im err" style="display:block">${escHtml((res && res.error) || 'Could not load service areas.')}</div>`;
        return;
      }
      _saZones = res.zones || [];
      if (Array.isArray(res.schedulable_days) && res.schedulable_days.length) {
        _saSchedulableDays = res.schedulable_days;
      }
      renderServiceAreas();
    })
    .catch(() => {
      list.innerHTML = '<div class="im err" style="display:block">Network error loading service areas.</div>';
    });
}

// Sets both the state and the button highlight. Every path that changes tabs
// goes through here — when only one of the two was updated, the editor opened
// under a tab that still looked inactive.
function saSetTab_(tab) {
  _saTab = tab;
  ['zones', 'coverage', 'suggest'].forEach(t => {
    const b = document.getElementById('sa-tab-' + t);
    if (b) b.className = 'sa-tab' + (t === tab ? ' active' : '');
  });
}

function saSwitchTab(tab) {
  saSetTab_(tab);
  _saEditing = null;
  saMsg('');
  if (tab === 'coverage' && !_saCoverage) return saLoadCoverage();
  if (tab === 'suggest' && !_saProposals) return saLoadProposals();
  renderServiceAreas();
}

function renderServiceAreas() {
  const body = document.getElementById('sa-body');
  if (!body) return;
  if (_saTab === 'coverage') return saRenderCoverage();
  if (_saTab === 'suggest') return saRenderProposals();

  const shown = _saZones.filter(z => _saShowArchived || z.active !== false);
  if (!shown.length) {
    body.innerHTML = `<div class="sa-empty">
      ${_saZones.length ? 'No zones match this view.' :
        'No service areas yet. Try <strong>Suggestions</strong> to derive them from the routes you already run.'}
    </div>`;
    return;
  }

  // Grouped by day, because "two zones on Tuesday" is the intended shape and
  // should read as siblings rather than as a duplicate.
  let html = '';
  SA_DAY_ORDER.forEach(day => {
    const inDay = shown.filter(z => z.service_day === day);
    if (!inDay.length) return;
    const zips = inDay.reduce((s, z) => s + (z.zip_count || 0), 0);
    // A zone on a day we no longer service can't be honoured by the scheduler.
    // Saving one is refused, but older rows may exist — say so rather than
    // listing it as if it worked.
    const serviceable = _saSchedulableDays.includes(day);
    html += `<div class="sa-group">
      <div class="sa-group-h"${serviceable ? '' : ' style="color:var(--error)"'}>${escHtml(saDayLabel(day))}
        <span class="sa-group-sub">${serviceable
          ? `${inDay.length} zone${inDay.length === 1 ? '' : 's'} · ${zips} ZIP${zips === 1 ? '' : 's'}`
          : 'we do not service this day — these areas cannot be scheduled'}</span>
      </div>
      ${inDay.map(saZoneRow).join('')}
    </div>`;
  });

  const noDay = shown.filter(z => !SA_DAY_ORDER.includes(z.service_day));
  if (noDay.length) {
    html += `<div class="sa-group"><div class="sa-group-h" style="color:var(--error)">No valid day — not used for scheduling</div>
      ${noDay.map(saZoneRow).join('')}</div>`;
  }
  body.innerHTML = html;
}

function saZoneRow(z) {
  const archived = z.active === false;
  const id = String(z.zone_id || '');
  const cap = z.max_per_day == null ? 'No limit' : `Max ${Number(z.max_per_day)}/day`;
  return `<div class="sa-row${archived ? ' sa-archived' : ''}">
    <span class="sa-dot" style="background:${escHtml(z.color || '#94a3b8')}"></span>
    <div class="sa-main">
      <div class="sa-name">${escHtml(z.zone_name)}${archived ? ' <span class="sa-tag">Archived</span>' : ''}</div>
      <div class="sa-meta">
        <span class="sa-tag sa-day">${escHtml(saDayLabel(z.service_day))}</span>
        <span>${Number(z.zip_count || 0)} ZIP${z.zip_count === 1 ? '' : 's'}</span>
        <span>${escHtml(z.primary_technician || 'No technician')}</span>
        <span>${escHtml(cap)}</span>
      </div>
      <div class="sa-zips">${(z.zips || []).map(escHtml).join(' · ') || '—'}</div>
    </div>
    <div class="sa-actions">
      <button class="sa-btn" onclick="saEditZone(${jsArg(id)})">Edit</button>
      <button class="sa-btn" onclick="saSetActive(${jsArg(id)}, ${archived ? 'true' : 'false'})">
        ${archived ? 'Restore' : 'Archive'}
      </button>
    </div>
  </div>`;
}

// ── Editor ───────────────────────────────────────────────────────────────────
function saNewZone() { saOpenEditor(null); }

function saEditZone(id) {
  const z = _saZones.find(x => x.zone_id === id);
  if (z) saOpenEditor(z);
}

function saOpenEditor(z) {
  const wrap = document.getElementById('sa-editor');
  if (!wrap) return;
  _saEditing = z ? z.zone_id : '';
  const v = z || { zone_name: '', service_day: '', zips: [], primary_technician: '',
                   max_per_day: null, color: SA_SWATCHES[_saZones.length % SA_SWATCHES.length] };

  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="sa-ed-title">${z ? 'Edit zone' : 'New zone'}</div>
    <div class="sa-ed-grid">
      <div><label class="sa-lbl">Zone name</label>
        <input class="sa-inp" id="sa-f-name" value="${escHtml(v.zone_name)}" placeholder="Stone Oak"></div>
      <div><label class="sa-lbl">Service day</label>
        <select class="sa-inp" id="sa-f-day">
          <option value="">— Select —</option>
          ${SA_DAY_ORDER.filter(d => _saSchedulableDays.includes(d))
            .map(d => `<option value="${d}"${v.service_day === d ? ' selected' : ''}>${saDayLabel(d)}</option>`).join('')}
          ${v.service_day && !_saSchedulableDays.includes(v.service_day)
            ? `<option value="${escHtml(v.service_day)}" selected>${escHtml(saDayLabel(v.service_day))} — not serviced</option>`
            : ''}
        </select></div>
      <div><label class="sa-lbl">Primary technician</label>
        <input class="sa-inp" id="sa-f-tech" value="${escHtml(v.primary_technician || '')}" placeholder="Optional"></div>
      <div><label class="sa-lbl">Max pools per day</label>
        <input class="sa-inp" id="sa-f-max" type="number" min="1" step="1"
          value="${v.max_per_day == null ? '' : Number(v.max_per_day)}" placeholder="No limit"></div>
      <div class="sa-ed-full"><label class="sa-lbl">ZIP codes <span class="sa-hint">comma separated — each ZIP may belong to only one zone</span></label>
        <input class="sa-inp" id="sa-f-zips" value="${escHtml((v.zips || []).join(', '))}" placeholder="78258, 78259, 78260"></div>
      <div class="sa-ed-full"><label class="sa-lbl">Colour</label>
        <div class="sa-swatches">
          ${SA_SWATCHES.map(c => `<button type="button" class="sa-sw${(v.color || '') === c ? ' on' : ''}"
             style="background:${c}" onclick="saPickColor(${jsArg(c)})" data-c="${escHtml(c)}"></button>`).join('')}
        </div>
        <input type="hidden" id="sa-f-color" value="${escHtml(v.color || '')}"></div>
    </div>
    <div id="sa-msg" class="im" style="display:none"></div>
    <div class="sa-ed-actions">
      <button class="sa-btn sa-primary" onclick="saSaveZone()">${z ? 'Save changes' : 'Create zone'}</button>
      <button class="sa-btn" onclick="saCloseEditor()">Cancel</button>
    </div>`;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function saPickColor(c) {
  const f = document.getElementById('sa-f-color');
  if (f) f.value = c;
  document.querySelectorAll('.sa-sw').forEach(b => {
    b.className = 'sa-sw' + (b.getAttribute('data-c') === c ? ' on' : '');
  });
}

function saCloseEditor() {
  _saEditing = null;
  const wrap = document.getElementById('sa-editor');
  if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
}

function saSaveZone() {
  const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
  const zone = {
    zone_name: val('sa-f-name'),
    service_day: val('sa-f-day'),
    zips: val('sa-f-zips'),
    primary_technician: val('sa-f-tech'),
    max_per_day: val('sa-f-max'),
    color: val('sa-f-color')
  };
  if (_saEditing) zone.zone_id = _saEditing;

  if (!zone.zone_name) return saMsg('Give the zone a name.', true);
  if (!zone.service_day) return saMsg('Choose the day this area is serviced.', true);

  saMsg('Saving…');
  api({ action: 'save_service_area', token: _s ? _s.token : '', zone })
    .then(res => {
      if (!res || !res.ok) {
        // The ZIP-conflict error names the other zone, so show it verbatim
        // rather than a generic failure — it tells the admin exactly what to fix.
        return saMsg((res && res.error) || 'Could not save the zone.', true);
      }
      saCloseEditor();
      _saCoverage = null; _saProposals = null;    // both are now stale
      loadServiceAreas(true);
    })
    .catch(() => saMsg('Network error saving the zone.', true));
}

function saSetActive(id, makeActive) {
  const z = _saZones.find(x => x.zone_id === id);
  const name = z ? z.zone_name : id;
  if (!makeActive && !confirm(`Archive "${name}"?\n\nIts ZIPs become unassigned, so addresses there will stop getting a service day until another zone covers them.`)) return;
  api({ action: 'archive_service_area', token: _s ? _s.token : '', zone_id: id, restore: !!makeActive })
    .then(res => {
      if (!res || !res.ok) return saMsg((res && res.error) || 'Could not update the zone.', true);
      _saCoverage = null; _saProposals = null;
      loadServiceAreas(true);
    })
    .catch(() => saMsg('Network error updating the zone.', true));
}

// ── Coverage ─────────────────────────────────────────────────────────────────
function saLoadCoverage() {
  const body = document.getElementById('sa-body');
  if (body) body.innerHTML = '<div class="sa-empty">Checking coverage…</div>';
  api({ action: 'get_zone_coverage', token: _s ? _s.token : '' })
    .then(res => {
      if (!res || !res.ok) {
        if (body) body.innerHTML = `<div class="im err" style="display:block">${escHtml((res && res.error) || 'Could not load coverage.')}</div>`;
        return;
      }
      _saCoverage = res;
      saRenderCoverage();
    })
    .catch(() => { if (body) body.innerHTML = '<div class="im err" style="display:block">Network error loading coverage.</div>'; });
}

function saRenderCoverage() {
  const body = document.getElementById('sa-body');
  if (!body || !_saCoverage) return;
  const c = _saCoverage, tot = c.totals || {};
  const gaps = c.priority_gaps || [];

  // The number that matters is customers, not ZIPs: an uncovered ZIP with no
  // customers costs nothing today, one with twelve costs twelve day promises.
  const headline = tot.customers_without_zone > 0
    ? `<div class="sa-alert">
         <strong>${Number(tot.customers_without_zone)} customer${tot.customers_without_zone === 1 ? '' : 's'}</strong>
         live in ${Number(tot.unassigned_with_customers)} ZIP${tot.unassigned_with_customers === 1 ? '' : 's'} with no service area.
         They will not be shown a service day when signing.
       </div>`
    : `<div class="sa-alert ok">Every ZIP with customers is covered by a service area.</div>`;

  body.innerHTML = `
    ${headline}
    <div class="sa-stats">
      <div class="sa-stat"><b>${Number(tot.assigned || 0)}</b><span>ZIPs covered</span></div>
      <div class="sa-stat"><b>${Number(tot.unassigned || 0)}</b><span>ZIPs uncovered</span></div>
      <div class="sa-stat"><b>${Number(tot.customers_without_zone || 0)}</b><span>Customers with no zone</span></div>
    </div>
    ${gaps.length ? `
      <div class="sa-group">
        <div class="sa-group-h">Fix these first<span class="sa-group-sub">uncovered ZIPs where we already have customers</span></div>
        ${gaps.map(g => `<div class="sa-zip-row gap">
          <span class="sa-zip">${escHtml(g.zip)}</span>
          <span class="sa-zip-meta">${Number(g.customers)} customer${g.customers === 1 ? '' : 's'} · no zone</span>
        </div>`).join('')}
      </div>` : ''}
    <div class="sa-group">
      <div class="sa-group-h">All ZIPs<span class="sa-group-sub">${(c.zips || []).length} in San Antonio and where we have customers</span></div>
      <div class="sa-zip-grid">
        ${(c.zips || []).map(z => `<div class="sa-zip-chip${z.assigned ? '' : ' un'}"
            style="${z.assigned && z.color ? 'border-color:' + escHtml(z.color) : ''}"
            title="${escHtml(z.assigned ? z.zone_name + ' · ' + saDayLabel(z.service_day) : 'No zone')}${z.customers ? ' · ' + z.customers + ' customer(s)' : ''}">
            ${escHtml(z.zip)}${z.customers ? `<i>${Number(z.customers)}</i>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

// ── Suggestions ──────────────────────────────────────────────────────────────
function saLoadProposals() {
  const body = document.getElementById('sa-body');
  if (body) body.innerHTML = '<div class="sa-empty">Reading the routes you already run…</div>';
  api({ action: 'propose_service_areas', token: _s ? _s.token : '' })
    .then(res => {
      if (!res || !res.ok) {
        if (body) body.innerHTML = `<div class="im err" style="display:block">${escHtml((res && res.error) || 'Could not build suggestions.')}</div>`;
        return;
      }
      _saProposals = res;
      saRenderProposals();
    })
    .catch(() => { if (body) body.innerHTML = '<div class="im err" style="display:block">Network error building suggestions.</div>'; });
}

function saRenderProposals() {
  const body = document.getElementById('sa-body');
  if (!body || !_saProposals) return;
  const p = _saProposals, props = p.proposals || [], decisions = p.decisions || [];

  if (!props.length && !decisions.length) {
    body.innerHTML = `<div class="sa-empty">
      Nothing to suggest — either every ZIP is already zoned, or the routes have no ZIP data yet.
    </div>`;
    return;
  }

  body.innerHTML = `
    <p class="sa-note">Derived from the pools you already service. <strong>Nothing is saved</strong> until you
    accept a suggestion, and accepting runs the same checks as creating a zone by hand.</p>
    ${decisions.length ? `
      <div class="sa-group">
        <div class="sa-group-h" style="color:var(--gold)">Needs your decision
          <span class="sa-group-sub">these ZIPs are serviced on more than one day, so they can't be zoned automatically</span>
        </div>
        ${decisions.map(d => `<div class="sa-row">
          <div class="sa-main">
            <div class="sa-name">ZIP ${escHtml(d.zip)}</div>
            <div class="sa-meta">${d.days.map(x => `<span class="sa-tag">${escHtml(saDayLabel(x.day))} · ${Number(x.pools)} pool${x.pools === 1 ? '' : 's'}</span>`).join('')}</div>
            <div class="sa-zips">${escHtml(d.reason)}</div>
          </div>
          <div class="sa-actions">
            <button class="sa-btn" onclick="saNewZoneFromZip(${jsArg(d.zip)}, ${jsArg(d.suggested_day)})">Create zone…</button>
          </div>
        </div>`).join('')}
      </div>` : ''}
    ${props.length ? `
      <div class="sa-group">
        <div class="sa-group-h">Suggested zones<span class="sa-group-sub">${props.length} ready to review</span></div>
        ${props.map((x, i) => `<div class="sa-row">
          <span class="sa-conf ${escHtml(x.confidence)}">${escHtml(x.confidence)}</span>
          <div class="sa-main">
            <div class="sa-name">${escHtml(x.zone_name)}</div>
            <div class="sa-meta">
              <span class="sa-tag sa-day">${escHtml(saDayLabel(x.service_day))}</span>
              <span>${x.zips.length} ZIP${x.zips.length === 1 ? '' : 's'}</span>
              <span>${Number(x.pools)} existing pool${x.pools === 1 ? '' : 's'}</span>
              ${x.primary_technician ? `<span>${escHtml(x.primary_technician)} (${Number(x.technician_share)}%)</span>` : ''}
            </div>
            <div class="sa-zips">${x.zips.map(escHtml).join(' · ')}</div>
          </div>
          <div class="sa-actions">
            <button class="sa-btn sa-primary" onclick="saAcceptProposal(${i})">Review &amp; create</button>
          </div>
        </div>`).join('')}
      </div>` : ''}`;
}

// Opens the proposal in the normal editor rather than saving it directly —
// a derived zone gets the same review as one typed by hand.
function saAcceptProposal(i) {
  const p = (_saProposals && _saProposals.proposals) ? _saProposals.proposals[i] : null;
  if (!p) return;
  saSetTab_('zones');
  renderServiceAreas();
  saOpenEditor({
    zone_name: p.zone_name, service_day: p.service_day, zips: p.zips,
    primary_technician: p.primary_technician, max_per_day: null,
    color: SA_SWATCHES[i % SA_SWATCHES.length]
  });
  _saEditing = '';    // a proposal is always a NEW zone, never an edit
}

function saNewZoneFromZip(zip, day) {
  saSetTab_('zones');
  renderServiceAreas();
  saOpenEditor({ zone_name: '', service_day: day || '', zips: [zip],
                 primary_technician: '', max_per_day: null, color: SA_SWATCHES[0] });
  _saEditing = '';
}

function saToggleArchived() {
  _saShowArchived = !_saShowArchived;
  const b = document.getElementById('sa-archived-btn');
  if (b) b.textContent = _saShowArchived ? 'Hide Archived' : 'Show Archived';
  renderServiceAreas();
}

function saRefresh() {
  _saCoverage = null; _saProposals = null;
  if (_saTab === 'coverage') return saLoadCoverage();
  if (_saTab === 'suggest') return saLoadProposals();
  loadServiceAreas(true);
}
