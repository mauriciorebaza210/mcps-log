// startup_checklists.js — Two independent checklist types

// ── Technician Checklist definition ──────────────────────────────────────────
const SCL_TECHNICIAN = {
  'Remove': [
    'Remove Skimmer Pipes','Remove Plugs','Remove Sheer Descent Covers',
    'Remove Trash (job site clean and free of debris)','Clean Skimmers',
    'Clean plaster/grout if needed','Clean out ribs from debris on sheer descents',
    'Clean Autofill Canister and Flush it'
  ],
  'Install': [
    'Install Baskets','Install Skimmer Weir','Install Return Fittings (spa/pool/bubbler)',
    'Install Spa Fountain / Eyeballs','Install LED Bubbler Lenses','Install Deck Jet Nozzles and Caps',
    'Install Float Valve on Autofill','Install Deck Drains','Install Skimmer Lids',
    'Install Autofill Lid','Install Umbrella Sleeves'
  ],
  'Program': [
    'Program IQ20 Antenna / PDA Remote / Z4','Program Auxiliaries / Actuators / Time and Date',
    'Program LED Lights','Program Freeze Guard 38° — All Pumps','Program Variable Speed Pump'
  ],
  'Check': [
    'Check Other Water Features','Check Filter is Plumbed Correctly',
    'Check Cleaner Suction is Plumbed Correctly (after spa returns, P&S only)',
    'Check Valves present are installed correctly (P&S level, not check valves)',
    'Check Valve Boxes are installed where needed','Check Dip Switches and program Variable Speed Pump',
    'Check Autofill for Leaks (leave OFF, mark skimmer level)','Check all collars are tight — no leaks',
    'Check GFCI','Check and confirm lights are working and synced',
    'Check Dip Switches on Variable Speed Pump','Check Spa Operation (valves/actuators)',
    'Check Plaster Condition'
  ],
  'Start Up': [
    'Prime and Start All Pumps','Run Filter Pump 24 hours for 3–5 Days','Label Pipes',
    'Brush Pool (vacuum if necessary using brush vacuum)','Add Chemicals as Needed'
  ],
  'Adjust': [
    'Adjust Water Flow Bubbler','Adjust Sheer Descent','Adjust Waterfall','Adjust Deck Jets',
    'Adjust Grotto','Adjust and Even Spa Spillover',
    'Correct Automation Installed (AUX / P&S / P only / Z4 / PDA?)',
    'VSP Speeds: P:1750–2500 | S:3450 | Heat:3450 | Freeze:2000 | Cleaner:3450 | Prim'
  ],
  'Heater': [
    'Heater Pump / Chiller Setup and Tested (bypass installed?)',
    'Heater (remote t-stat, spa 104°) / Test Fire / Rotate Top? / Sediment Trap?'
  ]
};

// ── Pool School Checklist definition (YES/NO structure) ───────────────────────
const SCL_POOL_SCHOOL = [
  {
    section: 'Performance Check', type: 'yn',
    items: [
      'Check Pool Circulation System','Check Filter (correct operation/leaks)',
      'Check Filter Pressure','Check Pump(s) (correct operation/leaks)',
      'Check Skimmer','Check Pool Light(s)','Check Spa Light','Check Bubbler',
      'Check Lighted Bubbler','Check Heater (turn on at panel and app)','Check Blower',
      'Check Water Features','Check Auto Fill (correct operation/leaks)',
      'Check Equipment (correct operation/leaks)','Check Chlorinator (correct operation/use)'
    ]
  },
  {
    section: 'Understanding My Pool', type: 'yn',
    items: [
      'Main Pump(s) Labeled','Pool Filter Labeled','Return(s) Piping Labeled',
      'Chlorinator Labeled','Heater Labeled','Blower Labeled',
      'Salt System Labeled (if applicable)','Controlled Set Up (panel/app)'
    ]
  },
  {
    section: 'Pool Cleaning', type: 'yn',
    starred: [0,1,2,3],
    items: [
      'Leaf Raked / Floating Debris Removed','Brushed Pool Walls',
      'Emptied and Cleaned Skimmer Basket(s)','Emptied Pump Strainer Basket(s)',
      'Vacuumed Pool Bottom','Backwashed Filter','Installed Backwash Hose',
      'Cleaned Pool Surfaces','Cleaned Equipment Pad'
    ]
  },
  {
    section: 'Chemical Levels', type: 'chemical',
    chemicals: [
      { key: 'PH',          range: '7.2–7.6',   id: 'scl-chem-ph' },
      { key: 'Chlorine',    range: '2.0–4.0',   id: 'scl-chem-chlorine' },
      { key: 'Acid',        range: '110–150',    id: 'scl-chem-acid' },
      { key: 'Salt System', range: '250–325',    id: 'scl-chem-salt' }
    ]
  },
  {
    section: 'Pool School — Taught Me How To', type: 'yn',
    items: [
      'How to Use the System on the Panel','How to Use the System on the App',
      'How to Brush My Pool','How to Clean Skimmer(s) Basket',
      'How to Clean Pump Strainer Basket','How to Vacuum My Pool',
      'How to Do a Backwash of Filter','How to Check My Water Chemicals',
      'How to Put Chlorine Tablets on Chlorinator','How to Use My Equipment'
    ]
  }
];

// ── State ─────────────────────────────────────────────────────────────────────
let _sclChecklists   = [];
let _sclClients      = [];
let _sclType         = 'technician'; // current drawer type
let _sclPreFill      = null;
let _sclSigCanvas    = null;
let _sclSigCtx       = null;
let _sclDrawing      = false;
let _sclLastX        = 0, _sclLastY = 0;
let _sclHasSig       = false;
let _sclCustSigCanvas = null;
let _sclCustSigCtx    = null;
let _sclCustDrawing   = false;
let _sclCustLastX     = 0, _sclCustLastY = 0;
let _sclHasCustSig    = false;

const _sclDraftKey = () => `mcps_scl_draft_${_sclType}`;

// ── Tab list ──────────────────────────────────────────────────────────────────
function loadStartupChecklistsTab() {
  if (!isAdmin()) return;
  const wrap = document.getElementById('scl-list-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="route-loading"><div class="spinner"></div></div>';
  apiGet({ action: 'get_startup_checklists', token: _s.token })
    .then(r => {
      _sclChecklists = r.ok ? (r.checklists || []) : [];
      _renderSclList(wrap, r.ok ? null : (r.error || 'Error'));
    })
    .catch(() => _renderSclList(wrap, 'Network error.'));
}

function _renderSclList(wrap, err) {
  if (err) { wrap.innerHTML = `<div class="im im-err" style="margin:1rem">${escHtml(err)}</div>`; return; }
  if (!_sclChecklists.length) {
    wrap.innerHTML = '<div class="scl-empty">No checklists submitted yet. Click "+ New Checklist" to start.</div>'; return;
  }
  wrap.innerHTML = `
    <table class="scl-table">
      <thead><tr><th>Date</th><th>Client</th><th>Type</th><th>Technician</th><th></th></tr></thead>
      <tbody>
        ${_sclChecklists.map(cl => `<tr>
          <td>${cl.submitted_at ? new Date(cl.submitted_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'}</td>
          <td>
            <div style="font-weight:600;font-size:.87rem">${escHtml(cl.customer_name||'—')}</div>
            ${cl.pool_id ? `<div style="font-size:.74rem;color:var(--muted)">${escHtml(cl.pool_id)}</div>` : ''}
          </td>
          <td><span class="scl-type-badge scl-type-${cl.checklist_type==='pool_school'?'ps':'tech'}">${cl.checklist_type==='pool_school'?'Pool School':'Technician'}</span></td>
          <td style="font-size:.85rem">${escHtml(cl.technician_name||'—')}</td>
          <td style="text-align:right">${cl.pdf_url?`<a href="${escHtml(cl.pdf_url)}" target="_blank" class="scl-pdf-btn">📄 PDF</a>`:'<span style="color:var(--muted);font-size:.8rem">No PDF</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Type picker ───────────────────────────────────────────────────────────────
function openSclTypePicker(preFill) {
  _sclPreFill = preFill || null;
  document.getElementById('scl-type-picker-backdrop').style.display = 'flex';
}

function closeSclTypePicker(e) {
  if (e && e.target !== document.getElementById('scl-type-picker-backdrop')) return;
  document.getElementById('scl-type-picker-backdrop').style.display = 'none';
}

function pickSclType(type) {
  document.getElementById('scl-type-picker-backdrop').style.display = 'none';
  openSclDrawer(type, _sclPreFill);
}

function openSclTypePickerFromPool() {
  const pool = (typeof findPool_ === 'function' && _pasState) ? findPool_(_pasState.pool_id) : null;
  const preFill = {
    pool_id:       _pasState ? _pasState.pool_id : '',
    customer_name: pool ? pool.customer_name : '',
    address:       pool ? ([pool.address, pool.city].filter(Boolean).join(', ')) : ''
  };
  closePoolAction();
  openSclTypePicker(preFill);
}

// ── Drawer open / close ───────────────────────────────────────────────────────
function openSclDrawer(type, preFill) {
  _sclType   = type || 'technician';
  _sclPreFill = preFill || null;
  _sclHasSig = false;
  _sclHasCustSig = false;

  const titleEl = document.getElementById('scl-drawer-title');
  const subEl   = document.getElementById('scl-drawer-sub');
  if (titleEl) titleEl.textContent = type === 'pool_school' ? 'Pool School Checklist' : 'Technician Checklist';
  if (subEl)   subEl.textContent   = type === 'pool_school' ? 'Pool Start-Up and Cleaning Check List' : 'Pool startup procedure — fill all sections, sign, and submit';

  const body = document.getElementById('scl-drawer-body');
  if (body) body.innerHTML = '<div class="route-loading" style="padding:2rem"><div class="spinner"></div></div>';

  document.getElementById('scl-backdrop').style.display = 'block';
  document.getElementById('scl-drawer').classList.add('open');
  document.body.style.overflow = 'hidden';

  _loadSclClients().then(clients => {
    _sclClients = clients;
    if (type === 'pool_school') _buildPoolSchoolForm();
    else _buildTechnicianForm();

    const raw = localStorage.getItem(_sclDraftKey());
    if (raw) { try { _showDraftBanner(JSON.parse(raw)); } catch(_) {} }
    if (_sclPreFill) _applySclPreFill(_sclPreFill);
  });
}

function closeSclDrawer() {
  document.getElementById('scl-backdrop').style.display = 'none';
  document.getElementById('scl-drawer').classList.remove('open');
  document.body.style.overflow = '';
  _sclPreFill = null;
  _sclSigCanvas = _sclSigCtx = _sclCustSigCanvas = _sclCustSigCtx = null;
}

// ── Client loader ─────────────────────────────────────────────────────────────
function _loadSclClients() {
  return new Promise(resolve => {
    const filter = data => data
      .filter(c => c.status === 'ACTIVE_CUSTOMER' && (c.service||'').toLowerCase().includes('startup'))
      .map(c => ({
        quote_id: c.quote_id, pool_id: c.pool_id||'',
        name: `${c.first_name||''} ${c.last_name||''}`.trim(),
        address: [c.address, c.city].filter(Boolean).join(', '),
        phone: c.phone||''
      }))
      .sort((a,b) => a.name.localeCompare(b.name));

    if (typeof _crmCache !== 'undefined' && _crmCache && _crmCache.length)
      return resolve(filter(_crmCache));

    apiGet({ action: 'get_crm_data', token: _s.token })
      .then(r => resolve(r.ok && Array.isArray(r.data) ? filter(r.data) : []))
      .catch(() => resolve([]));
  });
}

// ── Shared client section HTML ────────────────────────────────────────────────
function _buildClientSection() {
  const opts = _sclClients.length
    ? _sclClients.map(c => `<option value="${escHtml(c.quote_id)}" data-pool="${escHtml(c.pool_id)}" data-name="${escHtml(c.name)}" data-addr="${escHtml(c.address)}" data-phone="${escHtml(c.phone)}">${escHtml(c.name)}</option>`).join('')
    : '<option value="" disabled>No startup clients found</option>';
  return `
    <div class="scl-section">
      <div class="scl-section-label">Client</div>
      <div class="scl-field">
        <label class="scl-label">Select Client (Pool Startup)</label>
        <select class="scl-inp" id="scl-client-select" onchange="sclClientSelected()">
          <option value="">— Choose a client —</option>${opts}
        </select>
      </div>
      <div class="scl-field-row" id="scl-client-details" style="margin-top:.5rem;display:none">
        <div class="scl-field">
          <label class="scl-label">Address</label>
          <input class="scl-inp" id="scl-address" type="text" readonly style="background:var(--surface);color:var(--muted)">
        </div>
        <div class="scl-field" style="max-width:140px">
          <label class="scl-label">Pool ID</label>
          <input class="scl-inp" id="scl-pool-id-display" type="text" readonly style="background:var(--surface);color:var(--muted)">
        </div>
      </div>
      <input type="hidden" id="scl-pool-id-hidden">
      <input type="hidden" id="scl-customer-name-hidden">
      <input type="hidden" id="scl-phone-hidden">
    </div>`;
}

function _buildDraftBanner() {
  return `<div id="scl-draft-banner" style="display:none;padding:.65rem 1rem;background:#fefce8;border-bottom:1px solid #fde68a;display:none;align-items:center;gap:.6rem;font-size:.83rem">
    <span style="flex:1" id="scl-draft-banner-text">📝 You have a saved draft. Restore it?</span>
    <button onclick="sclRestoreDraft()" style="padding:.25rem .65rem;border-radius:6px;border:none;background:var(--teal);color:#fff;font-size:.78rem;font-weight:600;cursor:pointer">Restore</button>
    <button onclick="sclDiscardDraft()" style="padding:.25rem .65rem;border-radius:6px;border:1.5px solid var(--border);background:transparent;font-size:.78rem;font-weight:600;cursor:pointer">Discard</button>
  </div>`;
}

function _buildSigPad(canvasId, clearFn, label) {
  return `<div class="scl-sig-wrap">
    <div class="scl-sig-label">${escHtml(label)} <button class="scl-sig-clear" onclick="${clearFn}()">Clear</button></div>
    <canvas id="${canvasId}" class="scl-sig-canvas" width="460" height="130"></canvas>
    <div class="scl-sig-line-hint">Sign above</div>
  </div>`;
}

// ── Technician form ───────────────────────────────────────────────────────────
function _buildTechnicianForm() {
  const body = document.getElementById('scl-drawer-body');
  if (!body) return;

  const sections = Object.entries(SCL_TECHNICIAN).map(([section, items]) => `
    <div class="scl-section">
      <div class="scl-section-label">${escHtml(section)}</div>
      <div class="scl-items-grid">
        ${items.map((item,i) => {
          const id = `scl-tech-${section.replace(/\W+/g,'_')}-${i}`;
          return `<label class="scl-item-label" for="${id}">
            <input type="checkbox" id="${id}" class="scl-chk" data-section="${escHtml(section)}" data-item="${escHtml(item)}">
            <span>${escHtml(item)}</span>
          </label>`;
        }).join('')}
      </div>
    </div>`).join('');

  body.innerHTML = `
    ${_buildDraftBanner()}
    ${_buildClientSection()}
    <div class="scl-section">
      <div class="scl-section-label">Job Details</div>
      <div class="scl-field-row">
        <div class="scl-field">
          <label class="scl-label">Start Date</label>
          <input class="scl-inp" id="scl-start-date" type="date" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div class="scl-field">
          <label class="scl-label">Animals</label>
          <input class="scl-inp" id="scl-animals" type="text" placeholder="None">
        </div>
      </div>
      <div class="scl-field-row">
        <div class="scl-field">
          <label class="scl-label">Access Code</label>
          <input class="scl-inp" id="scl-access-code" type="text">
        </div>
        <div class="scl-field">
          <label class="scl-label">Equipment</label>
          <select class="scl-inp" id="scl-equipment">
            <option value="">Select...</option><option>Chlorine</option><option>Salt System</option>
          </select>
        </div>
      </div>
      <div class="scl-field-row">
        <div class="scl-field">
          <label class="scl-label">Wi-Fi Name</label>
          <input class="scl-inp" id="scl-wifi-name" type="text">
        </div>
        <div class="scl-field">
          <label class="scl-label">Wi-Fi Password</label>
          <input class="scl-inp" id="scl-wifi-pw" type="text">
        </div>
      </div>
      <div class="scl-field">
        <label class="scl-label">Plaster Type</label>
        <select class="scl-inp" id="scl-plaster">
          <option value="">Select...</option><option>Regular</option><option>QuartzScape</option><option>Mini-Pebbles</option>
        </select>
      </div>
    </div>
    ${sections}
    <div class="scl-section">
      <div class="scl-section-label">Quality Control Notes</div>
      <textarea class="scl-inp" id="scl-qc-notes" rows="3" placeholder="Any QC observations..."></textarea>
    </div>
    <div class="scl-section">
      <div class="scl-section-label">Punchlist Items Incomplete</div>
      <textarea class="scl-inp" id="scl-punchlist" rows="3" placeholder="List any incomplete items..."></textarea>
    </div>
    <div class="scl-section">
      <div class="scl-section-label">Technician Sign-Off</div>
      <div class="scl-field" style="margin-bottom:.75rem">
        <label class="scl-label">Technician Name</label>
        <input class="scl-inp" id="scl-tech-name" type="text" value="${escHtml(_s.name||'')}">
      </div>
      ${_buildSigPad('scl-sig-canvas','sclClearSig','Signature')}
    </div>
    <div class="im" id="scl-msg" style="display:none;margin:.5rem 1rem"></div>`;

  _initSigPad('scl-sig-canvas', false);
}

// ── Pool School form ──────────────────────────────────────────────────────────
function _buildPoolSchoolForm() {
  const body = document.getElementById('scl-drawer-body');
  if (!body) return;

  const ynSections = SCL_POOL_SCHOOL.filter(s => s.type === 'yn').map(s => {
    const rows = s.items.map((item, i) => {
      const starred = s.starred && s.starred.includes(i);
      return `<div class="scl-yn-row${starred ? ' scl-yn-starred' : ''}">
        <span class="scl-yn-label">${starred ? '★ ' : ''}${escHtml(item)}</span>
        <div class="scl-yn-btns">
          <button class="scl-yn-btn scl-yn-yes" data-section="${escHtml(s.section)}" data-item="${escHtml(item)}" data-val="yes" onclick="sclToggleYN(this)">YES</button>
          <button class="scl-yn-btn scl-yn-no" data-section="${escHtml(s.section)}" data-item="${escHtml(item)}" data-val="no" onclick="sclToggleYN(this)">NO</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="scl-section"><div class="scl-section-label">${escHtml(s.section)}</div><div class="scl-yn-grid">${rows}</div></div>`;
  });

  const chemDef = SCL_POOL_SCHOOL.find(s => s.type === 'chemical');
  const chemRows = chemDef ? chemDef.chemicals.map(c =>
    `<div class="scl-chem-row">
      <span class="scl-chem-label">${escHtml(c.key)} <span class="scl-chem-range">${escHtml(c.range)}</span></span>
      <input class="scl-chem-inp scl-inp" id="${c.id}" type="text" placeholder="—">
    </div>`
  ).join('') + `
    <div class="scl-chem-row" style="border-top:2px solid var(--border);margin-top:.25rem;padding-top:.5rem">
      <span class="scl-chem-label" style="font-weight:700">Levels Are Normal</span>
      <div class="scl-yn-btns">
        <button class="scl-yn-btn scl-yn-yes" data-section="Chemical Levels" data-item="Levels Are Normal" data-val="yes" onclick="sclToggleYN(this)">YES</button>
        <button class="scl-yn-btn scl-yn-no" data-section="Chemical Levels" data-item="Levels Are Normal" data-val="no" onclick="sclToggleYN(this)">NO</button>
      </div>
    </div>` : '';

  // Insert chemical section between Pool Cleaning and Pool School sections
  const sectionHtml = SCL_POOL_SCHOOL.map(s => {
    if (s.type === 'chemical') {
      return `<div class="scl-section"><div class="scl-section-label">Chemical Levels</div><div class="scl-chem-grid">${chemRows}</div></div>`;
    }
    const rows = s.items.map((item, i) => {
      const starred = s.starred && s.starred.includes(i);
      return `<div class="scl-yn-row${starred?' scl-yn-starred':''}">
        <span class="scl-yn-label">${starred?'★ ':''}${escHtml(item)}</span>
        <div class="scl-yn-btns">
          <button class="scl-yn-btn scl-yn-yes" data-section="${escHtml(s.section)}" data-item="${escHtml(item)}" data-val="yes" onclick="sclToggleYN(this)">YES</button>
          <button class="scl-yn-btn scl-yn-no" data-section="${escHtml(s.section)}" data-item="${escHtml(item)}" data-val="no" onclick="sclToggleYN(this)">NO</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="scl-section"><div class="scl-section-label">${escHtml(s.section)}</div><div class="scl-yn-grid">${rows}</div></div>`;
  }).join('');

  body.innerHTML = `
    ${_buildDraftBanner()}
    ${_buildClientSection()}
    <div class="scl-section">
      <div class="scl-section-label">Job Details</div>
      <div class="scl-field-row">
        <div class="scl-field">
          <label class="scl-label">Date</label>
          <input class="scl-inp" id="scl-start-date" type="date" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div class="scl-field">
          <label class="scl-label">Phone #</label>
          <input class="scl-inp" id="scl-phone-display" type="tel" readonly style="background:var(--surface);color:var(--muted)" placeholder="Auto-filled from client">
        </div>
      </div>
    </div>
    ${sectionHtml}
    <div class="scl-section">
      <div class="scl-section-label">Notes from Customer</div>
      <textarea class="scl-inp" id="scl-customer-notes" rows="3" placeholder="Customer comments or concerns..."></textarea>
    </div>
    <div class="scl-section">
      <div class="scl-section-label">Customer Sign-Off</div>
      <p style="font-size:.83rem;font-style:italic;color:var(--muted);margin-bottom:.75rem">I do Understand How My Pool Works</p>
      ${_buildSigPad('scl-cust-sig-canvas','sclClearCustSig','Customer Signature')}
    </div>
    <div class="scl-section">
      <div class="scl-section-label">Technician Sign-Off</div>
      <div class="scl-field" style="margin-bottom:.75rem">
        <label class="scl-label">Technician Name</label>
        <input class="scl-inp" id="scl-tech-name" type="text" value="${escHtml(_s.name||'')}">
      </div>
      ${_buildSigPad('scl-sig-canvas','sclClearSig','Technician Signature')}
    </div>
    <div class="im" id="scl-msg" style="display:none;margin:.5rem 1rem"></div>`;

  _initSigPad('scl-sig-canvas', false);
  _initSigPad('scl-cust-sig-canvas', true);
}

// ── YES / NO toggle ───────────────────────────────────────────────────────────
function sclToggleYN(btn) {
  const row = btn.closest('.scl-yn-row, .scl-chem-row');
  if (row) row.querySelectorAll('.scl-yn-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ── Client dropdown ───────────────────────────────────────────────────────────
function sclClientSelected() {
  const sel = document.getElementById('scl-client-select');
  const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  const details = document.getElementById('scl-client-details');
  if (!opt || !opt.value) { if (details) details.style.display = 'none'; return; }

  const addr  = opt.dataset.addr  || '';
  const pool  = opt.dataset.pool  || '';
  const name  = opt.dataset.name  || '';
  const phone = opt.dataset.phone || '';

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('scl-customer-name-hidden', name);
  set('scl-pool-id-hidden',       pool);
  set('scl-phone-hidden',         phone);
  set('scl-address',              addr);
  set('scl-pool-id-display',      pool || 'Not yet assigned');
  set('scl-phone-display',        phone || '');

  if (details) details.style.display = 'flex';
}

function _applySclPreFill(pf) {
  const sel = document.getElementById('scl-client-select');
  if (!sel) return;
  const match = _sclClients.find(c =>
    (pf.pool_id && c.pool_id === pf.pool_id) ||
    (pf.customer_name && c.name.toLowerCase() === (pf.customer_name||'').toLowerCase())
  );
  if (match) { sel.value = match.quote_id; sclClientSelected(); }
}

// ── Signature pads ────────────────────────────────────────────────────────────
function _initSigPad(canvasId, isCustomer) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  if (isCustomer) { _sclCustSigCanvas = canvas; _sclCustSigCtx = ctx; }
  else            { _sclSigCanvas = canvas;     _sclSigCtx = ctx;     }

  let drawing = false, lx = 0, ly = 0;
  const getPos = e => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width/r.width, sy = canvas.height/r.height;
    const s = e.touches ? e.touches[0] : e;
    return { x:(s.clientX-r.left)*sx, y:(s.clientY-r.top)*sy };
  };
  const start = e => { e.preventDefault(); const p=getPos(e); drawing=true; lx=p.x; ly=p.y; if(isCustomer) _sclHasCustSig=true; else _sclHasSig=true; };
  const move  = e => { if(!drawing) return; e.preventDefault(); const p=getPos(e); ctx.beginPath(); ctx.moveTo(lx,ly); ctx.lineTo(p.x,p.y); ctx.stroke(); lx=p.x; ly=p.y; };
  const end   = () => { drawing=false; };

  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);     canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('touchstart', start, {passive:false}); canvas.addEventListener('touchmove', move, {passive:false});
  canvas.addEventListener('touchend', end);
}

function sclClearSig()     { if (_sclSigCtx && _sclSigCanvas) { _sclSigCtx.clearRect(0,0,_sclSigCanvas.width,_sclSigCanvas.height); _sclHasSig=false; } }
function sclClearCustSig() { if (_sclCustSigCtx && _sclCustSigCanvas) { _sclCustSigCtx.clearRect(0,0,_sclCustSigCanvas.width,_sclCustSigCanvas.height); _sclHasCustSig=false; } }

// ── Draft ─────────────────────────────────────────────────────────────────────
function sclSaveDraft() {
  const data = _serializeSclForm();
  if (!data) return;
  localStorage.setItem(_sclDraftKey(), JSON.stringify({ ...data, saved_at: new Date().toISOString() }));
  const msg = document.getElementById('scl-msg');
  if (msg) { msg.textContent='Draft saved — you can close and come back.'; msg.className='im im-ok'; msg.style.display='block'; setTimeout(()=>{ if(msg) msg.style.display='none'; },3000); }
}

function _showDraftBanner(draft) {
  const banner = document.getElementById('scl-draft-banner');
  if (!banner) return;
  const when = draft.saved_at ? new Date(draft.saved_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const nameLabel = draft.customer_name ? ` for ${draft.customer_name}` : '';
  const txt = document.getElementById('scl-draft-banner-text');
  if (txt) txt.textContent = `📝 Saved draft${nameLabel}${when?' from '+when:''}. Restore it?`;
  banner.style.display = 'flex';
  banner._draft = draft;
}

function sclRestoreDraft() {
  const banner = document.getElementById('scl-draft-banner');
  if (!banner?._draft) return;
  banner.style.display = 'none';
  _applyDraftToForm(banner._draft);
}

function sclDiscardDraft() {
  localStorage.removeItem(_sclDraftKey());
  const banner = document.getElementById('scl-draft-banner');
  if (banner) banner.style.display = 'none';
}

function _serializeSclForm() {
  const g = id => document.getElementById(id)?.value || '';
  const sel = document.getElementById('scl-client-select');
  const itemsData = {};

  if (_sclType === 'pool_school') {
    SCL_POOL_SCHOOL.forEach(s => {
      if (s.type === 'yn') {
        itemsData[s.section] = {};
        s.items.forEach(item => {
          const active = document.querySelector(`.scl-yn-btn.active[data-section="${s.section}"][data-item="${item}"]`);
          itemsData[s.section][item] = active ? active.dataset.val : null;
        });
      } else if (s.type === 'chemical') {
        itemsData['Chemical Levels'] = {
          PH: g('scl-chem-ph'), Chlorine: g('scl-chem-chlorine'),
          Acid: g('scl-chem-acid'), 'Salt System': g('scl-chem-salt'),
          'Levels Are Normal': (() => { const a = document.querySelector('.scl-yn-btn.active[data-section="Chemical Levels"][data-item="Levels Are Normal"]'); return a ? a.dataset.val : null; })()
        };
      }
    });
  } else {
    Object.entries(SCL_TECHNICIAN).forEach(([section, items]) => {
      itemsData[section] = {};
      items.forEach(item => {
        const chk = document.querySelector(`input[data-section="${section}"][data-item="${item}"]`);
        itemsData[section][item] = chk ? chk.checked : false;
      });
    });
  }

  return {
    quote_id:       sel?.value || '',
    customer_name:  g('scl-customer-name-hidden'),
    pool_id:        g('scl-pool-id-hidden'),
    phone:          g('scl-phone-hidden'),
    address:        g('scl-address'),
    checklist_type: _sclType,
    start_date:     g('scl-start-date'),
    access_code:    g('scl-access-code'),
    animals:        g('scl-animals'),
    wifi_name:      g('scl-wifi-name'),
    wifi_password:  g('scl-wifi-pw'),
    equipment_type: g('scl-equipment'),
    plaster_type:   g('scl-plaster'),
    items_data:     itemsData,
    qc_notes:       g('scl-qc-notes'),
    punchlist_notes:g('scl-punchlist'),
    customer_notes: g('scl-customer-notes'),
    technician_name:g('scl-tech-name')
  };
}

function _applyDraftToForm(draft) {
  const sel = document.getElementById('scl-client-select');
  if (sel && draft.quote_id) { sel.value = draft.quote_id; sclClientSelected(); }

  const map = {
    'scl-start-date':'start_date','scl-access-code':'access_code','scl-animals':'animals',
    'scl-wifi-name':'wifi_name','scl-wifi-pw':'wifi_password','scl-equipment':'equipment_type',
    'scl-plaster':'plaster_type','scl-qc-notes':'qc_notes','scl-punchlist':'punchlist_notes',
    'scl-customer-notes':'customer_notes','scl-tech-name':'technician_name'
  };
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el && draft[key]) el.value = draft[key];
  });

  // Restore checkboxes (technician) or YES/NO buttons (pool school)
  const items = draft.items_data || {};
  Object.entries(items).forEach(([section, sectionItems]) => {
    Object.entries(sectionItems).forEach(([item, val]) => {
      if (typeof val === 'boolean') {
        const chk = document.querySelector(`input[data-section="${section}"][data-item="${item}"]`);
        if (chk) chk.checked = val;
      } else if (val === 'yes' || val === 'no') {
        const btn = document.querySelector(`.scl-yn-btn[data-section="${section}"][data-item="${item}"][data-val="${val}"]`);
        if (btn) btn.classList.add('active');
      }
    });
  });
}

// ── Submit ────────────────────────────────────────────────────────────────────
function submitStartupChecklist() {
  const msg = document.getElementById('scl-msg');
  const btn = document.getElementById('scl-submit-btn');
  const data = _serializeSclForm();
  if (!data) return;

  if (!data.quote_id) {
    msg.textContent='Please select a client.'; msg.className='im im-err'; msg.style.display='block'; return;
  }
  if (!data.technician_name) {
    msg.textContent='Technician name is required.'; msg.className='im im-err'; msg.style.display='block'; return;
  }
  if (!_sclHasSig) {
    msg.textContent='Please sign the checklist before submitting.'; msg.className='im im-err'; msg.style.display='block'; return;
  }

  msg.textContent='Saving… generating PDF (this may take a moment)…';
  msg.className='im'; msg.style.display='block';
  if (btn) { btn.disabled=true; btn.textContent='Saving…'; }

  api({
    action: 'save_startup_checklist',
    token: _s.token,
    ...data,
    signature_data:          _sclSigCanvas     ? _sclSigCanvas.toDataURL('image/png')     : '',
    customer_signature_data: _sclCustSigCanvas ? _sclCustSigCanvas.toDataURL('image/png') : ''
  }).then(r => {
    if (!r.ok) {
      msg.textContent=r.error||'Save failed.'; msg.className='im im-err'; msg.style.display='block';
      if (btn) { btn.disabled=false; btn.textContent='Submit Checklist'; }
      return;
    }
    localStorage.removeItem(_sclDraftKey());
    msg.textContent='Checklist saved!'; msg.className='im im-ok'; msg.style.display='block';
    if (_activeHubTab === 'startup_checklists') loadStartupChecklistsTab();
    setTimeout(() => { closeSclDrawer(); if (r.pdf_url) window.open(r.pdf_url,'_blank'); }, 1200);
  }).catch(() => {
    msg.textContent='Network error. Please try again.'; msg.className='im im-err'; msg.style.display='block';
    if (btn) { btn.disabled=false; btn.textContent='Submit Checklist'; }
  });
}
