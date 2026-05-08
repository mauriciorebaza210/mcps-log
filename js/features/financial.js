// ══════════════════════════════════════════════════════════════════════════════
// FINANCIAL HUB — job history, pay estimates, chem cost visibility
// Depends on: constants.js (SEC), api.js (apiGet), auth.js (isAdmin, _s)
// Uses globals: _s
// ══════════════════════════════════════════════════════════════════════════════

let _finCache      = [];   // raw rows from GAS (newest first)
let _finVisitCache = {};   // id → visit object for drawer lookup
let _finGrouped    = [];   // aggregated rows displayed in table
let _finPage       = 1;
let _finPayRates   = {};   // { "Tech Name": rate } — per-tech pay rate map
let _finPayRate    = '';   // own pay_rate (fallback / My Jobs tech view)
let _finPeriod     = 'this_month'; // period key
let _finCustomFrom = '';           // 'YYYY-MM-DD' — used when _finPeriod === 'custom'
let _finCustomTo   = '';           // 'YYYY-MM-DD'
let _finTechFilter = '';           // '' = all techs (admin only)
let _finLoaded     = false;

let _finActiveTab  = 'payouts'; // 'payouts', 'profit', 'chemicals', 'visits', 'clients', 'payroll', 'unmatched', 'companies'
let _finCrmCache   = [];        // cache for CRM/Quote data

const FIN_PAGE_SIZE = 15;
const CHEM_KW = ['muriatic','liquid chlor','chlorine tablet', 'tablet', 'cal hypo','soda ash',
                 'borax','algae','algaTec','scaleTec','scale tec','startup','cyanuric acid add',
                 'shock','bicarb','acid'];

// ── Period presets (QB-style) ─────────────────────────────────────────────────

const FIN_PERIODS = [
  { key: 'this_week',    label: 'This Week' },
  { key: 'last_week',    label: 'Last Week' },
  { key: 'this_month',   label: 'This Month' },
  { key: 'last_month',   label: 'Last Month' },
  { key: 'this_quarter', label: 'This Quarter' },
  { key: 'ytd',          label: 'Year to Date' },
  { key: 'all',          label: 'All Time' },
  { key: 'custom',       label: 'Custom dates' },
];

// Returns { start: Date, end: Date } for the given period key, or null for 'all'
function _finGetDateRange(period) {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (period) {
    case 'this_week': {
      const s = new Date(today); s.setDate(today.getDate() - today.getDay());
      const e = new Date(s);     e.setDate(s.getDate() + 6);
      return { start: s, end: e };
    }
    case 'last_week': {
      const s = new Date(today); s.setDate(today.getDate() - today.getDay() - 7);
      const e = new Date(s);     e.setDate(s.getDate() + 6);
      return { start: s, end: e };
    }
    case 'this_month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1),
               end:   new Date(now.getFullYear(), now.getMonth() + 1, 0) };
    case 'last_month':
      return { start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
               end:   new Date(now.getFullYear(), now.getMonth(), 0) };
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      return { start: new Date(now.getFullYear(), q * 3, 1),
               end:   new Date(now.getFullYear(), q * 3 + 3, 0) };
    }
    case 'ytd':
      return { start: new Date(now.getFullYear(), 0, 1), end: today };
    case 'custom': {
      const s = _finCustomFrom ? new Date(_finCustomFrom + 'T00:00:00') : new Date(now.getFullYear(), now.getMonth(), 1);
      const e = _finCustomTo   ? new Date(_finCustomTo   + 'T00:00:00') : today;
      return { start: s, end: e };
    }
    default:
      return null; // 'all'
  }
}

// "Apr 1, 2026 – Apr 20, 2026"
function _finDateRangeText(period) {
  const range = _finGetDateRange(period);
  if (!range) return '';
  const fmt = d => d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return `${fmt(range.start)} – ${fmt(range.end)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _finRate(tech) {
  if (tech && _finPayRates[tech] !== undefined) return _finPayRates[tech];
  return parseFloat(_finPayRate) || 0;
}

function _finFmtCurrency(n) {
  const num = parseFloat(n) || 0;
  return '$' + num.toFixed(2);
}

function _finFilterRows(rows) {
  const range = _finGetDateRange(_finPeriod);
  if (!range) return rows;
  const endMs = range.end.getTime() + 86399999; // inclusive end-of-day
  return rows.filter(r => {
    const d = new Date(r.timestamp);
    return !isNaN(d) && d >= range.start && d.getTime() <= endMs;
  });
}

function _finIsThisWeek(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  const range = _finGetDateRange('this_week');
  return d >= range.start && d.getTime() <= range.end.getTime() + 86399999;
}

function _finIsThisMonth(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  const range = _finGetDateRange('this_month');
  return d >= range.start && d.getTime() <= range.end.getTime() + 86399999;
}

// Compute "M/D-M/D" week key from a timestamp string (Sun–Sat week)
function _finWeekKey(timestamp) {
  const d = new Date(timestamp);
  if (isNaN(d)) return null;
  const day = d.getDay();
  const s   = new Date(d); s.setDate(d.getDate() - day);
  const e   = new Date(s); e.setDate(s.getDate() + 6);
  return `${s.getMonth()+1}/${s.getDate()}-${e.getMonth()+1}/${e.getDate()}`;
}

// Resolve a raw technician name to the canonical name in _finPayRates.
// Handles short-name entries: "Chuy" → "Chuy Silva", "Mau" → "Mauricio Rebaza"
function _finCanonicalName(tech) {
  if (!tech) return null;
  if (_finPayRates[tech] !== undefined) return tech;
  const lower = tech.trim().toLowerCase();
  const match = Object.keys(_finPayRates).find(n => {
    const nl = n.toLowerCase();
    return nl === lower ||
           nl.startsWith(lower + ' ') ||        // "Chuy" → "Chuy Silva"
           nl.split(' ')[0].startsWith(lower);  // "Mau"  → "Mauricio Rebaza"
  });
  return match || tech;
}

// Is the current period a single-week view? (Week column redundant)
function _finIsSingleWeek() {
  return _finPeriod === 'this_week' || _finPeriod === 'last_week';
}

// Group by technician only — for single-week periods
function _finGroupByTech(rows) {
  const map = {};
  rows.forEach(r => {
    const tech = _finCanonicalName(r.technician);
    if (!tech) return;
    if (!map[tech]) map[tech] = { technician: tech, job_count: 0, chem_cost: 0, visits: [] };
    map[tech].job_count++;
    map[tech].chem_cost += parseFloat(r.chem_cost) || 0;
    map[tech].visits.push(r);
  });
  return Object.values(map).sort((a, b) => b.job_count - a.job_count);
}

// Group filtered rows by canonical-tech + week_key
function _finGroupByWeek(rows) {
  const map = {};
  rows.forEach(r => {
    const tech = _finCanonicalName(r.technician);
    if (!tech) return; // skip rows with no technician recorded

    const wk  = r.week_key || _finWeekKey(r.timestamp) || '?';
    const key  = tech + '|' + wk;
    if (!map[key]) {
      // derive week_start for sorting if missing
      const ws = r.week_start || (() => {
        const d = new Date(r.timestamp);
        if (isNaN(d)) return '';
        const s = new Date(d); s.setDate(d.getDate() - d.getDay());
        return s.toISOString().slice(0, 10);
      })();
      map[key] = {
        technician: tech,
        week_key:   wk,
        week_start: ws,
        job_count:  0,
        chem_cost:  0,
        visits:     []
      };
    }
    map[key].job_count++;
    map[key].chem_cost += parseFloat(r.chem_cost) || 0;
    map[key].visits.push(r);
  });

  return Object.values(map).sort((a, b) => {
    const wd = (b.week_start || b.week_key).localeCompare(a.week_start || a.week_key);
    return wd !== 0 ? wd : a.technician.localeCompare(b.technician);
  });
}

// ── Admin: Financial Hub page ─────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────────

function _finGetRowChemData(detail) {
  const chemMap = {};
  let totalCost = 0;
  
  Object.entries(detail || {}).forEach(([k, v2]) => {
    // Ignore meta columns and pre-calculated totals from the sheet
    if (k.includes('Unit Cost (Snapshot)') || k.toLowerCase().includes('total')) return;

    const kl = k.toLowerCase();
    const isChem = CHEM_KW.some(kw => kl.includes(kw));
    const num = parseFloat(v2);

    if (isChem && !isNaN(num) && num > 0) {
      const unitCost = parseFloat(detail[k + ' Unit Cost (Snapshot)']) || 0;
      const unit = (k.match(/\((.*?)\)/) || [])[1] || '';
      const name = k.replace(/\(.*?\)/, '').trim();
      const rowCost = num * unitCost;

      // Deduplicate by name: ensure each chemical is only counted once per visit
      if (!chemMap[name]) {
        chemMap[name] = { k: name, v: v2, unit, cost: rowCost };
        totalCost += rowCost;
      }
    }
  });
  return { chemRows: Object.values(chemMap), totalCost };
}

function _finGetClientNameFromCrm(item) {
  if (!item) return null;
  const combined = `${item.first_name || ''} ${item.last_name || ''}`.trim();
  return combined || item.client_name || null;
}

function _finNormalizePoolId(id) {
  return String(id || '').replace(/^MCPS-/i, '').trim();
}

function _finFindCrm(poolId, poolName) {
  const normId = _finNormalizePoolId(poolId);
  return _finCrmCache.find(c => {
    const cNormId = _finNormalizePoolId(c.pool_id || c.quote_id);
    if (normId && cNormId && normId === cNormId) return true;
    if (poolName && c.client_name && c.client_name.toLowerCase() === poolName.toLowerCase()) return true;
    return false;
  });
}

const _finTabTitles = {
  payouts:   'Payouts',
  profit:    'Profitability',
  chemicals: 'Chemical Analysis',
  visits:    'Visit History',
  clients:   'Clients',
  payroll:   'Payroll',
  unmatched: 'Unmatched Submissions',
  companies: 'Startup Companies'
};

function switchFinTab(tab) {
  _finActiveTab = tab;

  // Sync the hash to drive routing and sidebar state
  const newHash = `financial_hub/${tab}`;
  if (location.hash !== `#` + newHash) {
    location.hash = newHash;
  }

  // Update page title
  const hdr = document.querySelector('#page-financial_hub .fin-page-hdr h2');
  if (hdr) hdr.textContent = _finTabTitles[tab] || 'Financial Hub';

  // Toggle view visibility
  ['payouts', 'profit', 'chemicals', 'visits', 'clients', 'payroll', 'unmatched', 'companies'].forEach(t => {
    const view = document.getElementById(`fin-view-${t}`);
    if (view) view.style.display = t === tab ? 'block' : 'none';
  });

  // Ensure sidebar is highlighted correctly (router handles this but call just in case)
  if (typeof _setSidebarActive === 'function') {
    _setSidebarActive('financial_hub', tab);
  }

  loadFinancialHub(); // Re-trigger load to ensure data is synced for the active tab
}

async function loadFinancialHub() {
  const loading = document.getElementById('fin-loading');

  const hash = location.hash.replace('#','');
  if (hash.startsWith('financial_hub/') && hash.split('/')[1] !== _finActiveTab) {
    _finActiveTab = hash.split('/')[1];
  }

  const hdr = document.querySelector('#page-financial_hub .fin-page-hdr h2');
  if (hdr) hdr.textContent = _finTabTitles[_finActiveTab] || 'Financial Hub';

  ['payouts', 'profit', 'chemicals', 'visits', 'clients', 'payroll', 'unmatched', 'companies'].forEach(t => {
    const view = document.getElementById(`fin-view-${t}`);
    if (view) view.style.display = t === _finActiveTab ? 'block' : 'none';
  });

  const cachedVisits = _appCacheGet('fin_visits', 5 * 60 * 1000);
  const cachedCrm = _appCacheGet('crm_data', 15 * 60 * 1000);

  if (cachedVisits && cachedCrm) {
    _finCache = cachedVisits.rows || [];
    _finPayRate = String(cachedVisits.pay_rate || '');
    _finPayRates = cachedVisits.pay_rates || {};
    _finCrmCache = cachedCrm || [];
    
    _renderFinFilters();
    if (_finActiveTab === 'payouts') _finApplyAndRender();
    else if (_finActiveTab === 'profit') _renderProfitTab();
    else if (_finActiveTab === 'chemicals') _renderChemTab();
    else if (_finActiveTab === 'visits') loadVisitHistoryTab();
    else if (_finActiveTab === 'clients') _renderClientsTab();
    else if (_finActiveTab === 'payroll') _loadAndRenderPayroll();
    else if (_finActiveTab === 'unmatched') _loadAndRenderUnmatched();
    else if (_finActiveTab === 'companies') _loadAndRenderCompaniesTab();
  } else {
    if (loading) loading.style.display = 'block';
    if (_finActiveTab === 'unmatched') _loadAndRenderUnmatched();
    else if (_finActiveTab === 'companies') _loadAndRenderCompaniesTab();
  }

  try {
    const [visitsRes, crmRes] = await Promise.all([
      apiGet({ action: 'get_visit_history', token: _s.token }),
      apiGet({ action: 'get_crm_data',      token: _s.token })
    ]);

    let changed = false;

    if (visitsRes.ok) {
      const freshVisits = { rows: visitsRes.rows || [], pay_rate: visitsRes.pay_rate, pay_rates: visitsRes.pay_rates };
      if (!cachedVisits || JSON.stringify(cachedVisits) !== JSON.stringify(freshVisits)) {
        _finCache = freshVisits.rows;
        _finPayRate = String(freshVisits.pay_rate || '');
        _finPayRates = freshVisits.pay_rates || {};
        _appCacheSet('fin_visits', freshVisits);
        changed = true;
      }
    }
    
    if (crmRes.ok) {
      if (!cachedCrm || JSON.stringify(cachedCrm) !== JSON.stringify(crmRes.data)) {
        _finCrmCache = crmRes.data || [];
        _appCacheSet('crm_data', _finCrmCache);
        changed = true;
      }
    }

    if (changed || (!cachedVisits || !cachedCrm)) {
      _renderFinFilters();
      if (_finActiveTab === 'payouts') _finApplyAndRender();
      else if (_finActiveTab === 'profit') _renderProfitTab();
      else if (_finActiveTab === 'chemicals') _renderChemTab();
      else if (_finActiveTab === 'visits') loadVisitHistoryTab();
      else if (_finActiveTab === 'clients') _renderClientsTab();
      else if (_finActiveTab === 'payroll') _loadAndRenderPayroll();
      // unmatched and companies are loaded independently — skip here to avoid double-fetch
    }
  } catch(e) {
    console.error('Financial Hub load error:', e);
    if (!cachedVisits || !cachedCrm) {
      const targetId = _finActiveTab === 'payouts' ? 'fin-tbody' : (_finActiveTab === 'profit' ? 'profit-tbody' : (_finActiveTab === 'chemicals' ? 'chem-tbody' : (_finActiveTab === 'clients' ? 'clients-tbody' : 'vh-tbody')));
      const el = document.getElementById(targetId);
      if (el) el.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--error)">Failed to load data. Network error.</td></tr>`;
    }
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function _finApplyAndRender() {
  let filtered = _finFilterRows(_finCache);
  if (_finTechFilter) {
    filtered = filtered.filter(r => _finCanonicalName(r.technician) === _finTechFilter);
  }
  _finGrouped = _finGroupByTech(filtered);
  _finPage = 1;
  _renderFinStats(_finGrouped);
  _renderFinTable(_finGrouped);
  document.getElementById('fin-table-wrap').style.display = 'block';
}

function _renderFinFilters() {
  const el = document.getElementById('fin-shared-filters');
  if (!el) return;
  if (_finActiveTab === 'clients' || _finActiveTab === 'payroll') { el.innerHTML = ''; return; }

  const rangeText = (_finPeriod !== 'all' && _finPeriod !== 'custom') ? _finDateRangeText(_finPeriod) : '';

  // Default custom dates to current month if not yet set
  const nowForDef = new Date();
  const defaultFrom = `${nowForDef.getFullYear()}-${String(nowForDef.getMonth()+1).padStart(2,'0')}-01`;
  const lastDay = new Date(nowForDef.getFullYear(), nowForDef.getMonth()+1, 0).getDate();
  const defaultTo   = `${nowForDef.getFullYear()}-${String(nowForDef.getMonth()+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  const customInputs = _finPeriod === 'custom' ? `
    <div style="display:flex;flex-direction:column;gap:.3rem">
      <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">From</label>
      <input type="date" class="si" style="min-width:140px" value="${_finCustomFrom || defaultFrom}"
        onchange="_finCustomFrom=this.value;_finLoaded=true;loadFinancialHub()">
      <div style="min-height:.9rem"></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:.3rem">
      <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">To</label>
      <input type="date" class="si" style="min-width:140px" value="${_finCustomTo || defaultTo}"
        onchange="_finCustomTo=this.value;_finLoaded=true;loadFinancialHub()">
      <div style="min-height:.9rem"></div>
    </div>` : '';

  const periodSelect = `
    <div style="display:flex;flex-direction:column;gap:.3rem">
      <label for="fin-period-select" style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Report Period</label>
      <select id="fin-period-select" name="fin-period-select" class="si" style="min-width:170px" onchange="
        _finPeriod=this.value;
        if(_finPeriod==='custom'){_finCustomFrom='';_finCustomTo='';}
        _finLoaded=true;loadFinancialHub()">
        ${FIN_PERIODS.map(p => `<option value="${p.key}" ${_finPeriod===p.key?'selected':''}>${p.label}</option>`).join('')}
      </select>
      <div style="font-size:.72rem;color:var(--muted);min-height:.9rem">${rangeText}</div>
    </div>
    ${customInputs}`;

  // Tech dropdown — canonical names from pay_rates, plus any unmatched from cache
  const canonicalTechs = Object.keys(_finPayRates).sort();
  const cacheTechs = [...new Set(_finCache.map(r => _finCanonicalName(r.technician)).filter(Boolean))];
  const extraTechs = cacheTechs.filter(t => !canonicalTechs.includes(t)).sort();
  const techs = [...canonicalTechs, ...extraTechs];

  const techSelect = isAdmin() && techs.length > 1
    ? `<div style="display:flex;flex-direction:column;gap:.3rem">
        <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Technician</label>
        <select class="si" style="min-width:170px" onchange="_finTechFilter=this.value;_finLoaded=true;loadFinancialHub()">
          <option value="">All Techs</option>
          ${techs.map(t => `<option value="${t}" ${_finTechFilter===t?'selected':''}>${t}</option>`).join('')}
        </select>
        <div style="font-size:.72rem;color:transparent;min-height:.9rem">.</div>
      </div>`
    : '';

  el.innerHTML = `
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:flex-end;padding:0 1rem .85rem">
      ${periodSelect}
      ${techSelect}
      <div style="margin-left:auto">
        <button class="mvt-btn" onclick="_finPeriod='this_month';_finLoaded=false;loadFinancialHub()">↻ Refresh</button>
      </div>
    </div>`;
}

function _renderFinStats(groups) {
  const el = document.getElementById('fin-stats');
  if (!el) return;

  const totalJobs = groups.reduce((s, g) => s + g.job_count, 0);
  const totalPay  = groups.reduce((s, g) => s + g.job_count * _finRate(g.technician), 0);
  const totalChem = groups.reduce((s, g) => s + g.chem_cost, 0);
  const hasAnyRate = Object.keys(_finPayRates).length > 0 || parseFloat(_finPayRate);

  // Top tech by job count
  const topTech = groups.length ? groups.reduce((a, b) => b.job_count > a.job_count ? b : a) : null;

  el.innerHTML = `
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;padding:0 1rem .5rem">
      ${_finStatCard('Total Jobs', totalJobs)}
      ${hasAnyRate ? _finStatCard('Est. Total Pay', _finFmtCurrency(totalPay)) : ''}
      ${topTech ? _finStatCard('Top Tech', `${topTech.technician.split(' ')[0]} (${topTech.job_count})`) : ''}
      ${_finStatCard('Chem Cost', _finFmtCurrency(totalChem))}
    </div>`;
}

function _finStatCard(label, value) {
  return `<div style="background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:10px;padding:.75rem 1.1rem;min-width:130px;flex:1">
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">${label}</div>
    <div style="font-size:1.4rem;font-weight:700;color:var(--teal);margin-top:.15rem">${value}</div>
  </div>`;
}

function _renderFinTable(groups) {
  const thead = document.getElementById('fin-thead');
  const tbody = document.getElementById('fin-tbody');
  if (!tbody) return;

  // Clear visit cache on every full table render to prevent memory leak
  _finVisitCache = {};

  if (thead) {
    thead.innerHTML = `<tr>
      <th>Technician</th>
      <th style="text-align:center">Jobs</th>
      <th style="text-align:right">Est. Pay</th>
      <th style="text-align:right">Chem Cost</th>
    </tr>`;
  }

  if (!groups.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--muted)">No visits found for this period.</td></tr>`;
    document.getElementById('fin-pagination').innerHTML = '';
    return;
  }

  const start = (_finPage - 1) * FIN_PAGE_SIZE;
  const page  = groups.slice(start, start + FIN_PAGE_SIZE);

  tbody.innerHTML = page.map((g, idx) => {
    const techRate = _finRate(g.technician);
    const estPay   = techRate ? _finFmtCurrency(g.job_count * techRate) : '—';
    const chemFmt  = g.chem_cost ? _finFmtCurrency(g.chem_cost) : '—';
    const rowId    = `fin-row-${start + idx}`;
    
    // Find first visit to get pool info for the detail view (groups are tech-based, 
    // but in Payouts we want to see visits by tech. Wait, Payouts is Tech-based.)
    
    // Actually, in Payouts, clicking a Tech shows their visits. 
    // I should create a separate detail view for Tech visits or stick to the dropdown there.
    
    // User said "when i click on one i wanna see the detail of the visit... maybe not as a dropdown but as a card"
    // This specifically refers to the analytical views where "one" is a POOL.
    
    // In Payouts, "one" is a TECHNICIAN. 
    // I will keep the Payouts dropdown for now as it's tech-centric, 
    // unless the user clarifies they want tech-detail cards too.
    
    return `
      <tr style="cursor:pointer" onclick="_finToggleDetail('${rowId}')">
        <td>${g.technician}</td>
        <td style="text-align:center"><strong>${g.job_count}</strong></td>
        <td style="text-align:right;color:var(--teal)">${estPay}</td>
        <td style="text-align:right;color:var(--muted)">${chemFmt}</td>
      </tr>
      <tr id="${rowId}" style="display:none;background:var(--bg-subtle,#f8f9fa)">
        <td colspan="4" style="padding:.5rem 1rem .75rem">
          <div style="font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.4rem">Pools Serviced</div>
          ${g.visits.map((v, vIdx) => {
            const d   = v.timestamp ? new Date(v.timestamp).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}) : '—';
            const pid = String(v.pool_id||'').replace(/.*-\s*/,'').trim();
            // Enrichment using CRM for Payouts visit list
            const crmItem = _finFindCrm(v.pool_id, v.pool_name);
            const clientDisplay = _finGetClientNameFromCrm(crmItem) || v.client_name || v.pool_name || pid || '—';
            const hasPhotos = (() => { try { return JSON.parse((v.detail||{})._photo_urls||'[]').length > 0; } catch(e){ return false; } })();
            
            // Store in cache and use ID to avoid JSON escaping issues in HTML attributes
            const vid = `v_${start + idx}_${vIdx}`;
            _finVisitCache[vid] = v;

            return `<div onclick="_finOpenVisit('${vid}')" style="display:flex;justify-content:space-between;align-items:center;padding:.45rem .6rem;margin-bottom:.25rem;background:var(--surface,#fff);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:.875rem;transition:background .15s" onmouseover="this.style.background='var(--teal-light, #e8f4f2)'" onmouseout="this.style.background='var(--surface,#fff)'">
              <div>
                <div style="font-weight:600">${clientDisplay}</div>
                <div style="font-size:.75rem;color:var(--muted)">${pid}${v.client_service ? ' · '+v.client_service : ''}</div>
              </div>
              <div style="text-align:right">
                <div style="color:var(--muted);font-size:.8rem">${d}</div>
                ${hasPhotos ? '<div style="font-size:.7rem;color:var(--teal)">📷 photos</div>' : ''}
              </div>
            </div>`;
          }).join('')}
        </td>
      </tr>`;
  }).join('');

  _renderFinPagination(groups.length);
}

function _finToggleDetail(rowId) {
  const el = document.getElementById(rowId);
  if (el) el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}

function _renderFinPagination(total) {
  const el = document.getElementById('fin-pagination');
  if (!el) return;
  const pages = Math.ceil(total / FIN_PAGE_SIZE);
  if (pages <= 1) { el.innerHTML = ''; return; }

  let html = '<div style="display:flex;gap:.4rem;justify-content:center;flex-wrap:wrap">';
  for (let i = 1; i <= pages; i++) {
    html += `<button class="mvt-btn${i===_finPage?' active':''}" onclick="_finPage=${i};_renderFinTable(_finGrouped)">${i}</button>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Visit detail drawer ───────────────────────────────────────────────────────

function _finOpenVisit(vid) {
  const v = _finVisitCache[vid];
  if (!v) return;
  const detail = v.detail || {};

  // Parse and sanitize photos
  let photos = [];
  try { 
    const raw = detail._photo_urls || '[]';
    photos = JSON.parse(raw);
    if (!Array.isArray(photos)) photos = [photos];
  } catch(e) {}
  photos = photos.filter(Boolean).map(u => String(u).trim());

  // Known water-test reading keywords
  const TEST_KW = ['ph','chlorine','free chlorine','total chlorine','combined chlorine',
                   'alkalinity','calcium','stabilizer','cyanuric','salt','temp',
                   'tds','orp','phosphate'];
  
  const testRows = [], noteKeys = ['Notes','Internal Notes','Observations','Comments'];
  let notes = '';

  // Process all fields first to categorize them
  const rowChem = _finGetRowChemData(detail);
  const chemRows = rowChem.chemRows;
  const visitChemCost = rowChem.totalCost;

  const rawTests = {};
  Object.entries(detail).forEach(([k, v2]) => {
    if (k === '_photo_urls' || k.includes('Unit Cost (Snapshot)')) return;
    const kl = k.toLowerCase();
    if (noteKeys.includes(k)) { notes = notes || String(v2); return; }

    const isTest = TEST_KW.some(kw => kl.includes(kw));

    if (isTest) {
      rawTests[k] = (v2 === '' || v2 === null) ? '-' : v2;
    }
  });

  // Map standard tests to ensure they always show up (even if 0 or missing)
  const STANDARDS = [
    { label: 'Free Chlorine', kw: ['free chlorine', 'chlorine'] },
    { label: 'pH', kw: ['ph'] },
    { label: 'Total Alkalinity (TA)', kw: ['alkalinity'] },
    { label: 'Calcium Hardness (CH)', kw: ['calcium'] }
  ];

  STANDARDS.forEach(st => {
    const matchKey = Object.keys(rawTests).find(k => st.kw.some(kw => k.toLowerCase().includes(kw)));
    if (matchKey) {
      testRows.push({ k: st.label, v: rawTests[matchKey] });
      delete rawTests[matchKey];
    } else {
      testRows.push({ k: st.label, v: '-' });
    }
  });
  // Add remaining non-standard tests
  Object.entries(rawTests).forEach(([k, v]) => testRows.push({ k, v }));

  const d = v.timestamp ? new Date(v.timestamp).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : '—';
  const pid = String(v.pool_id||'').replace(/.*-\s*/,'').trim();

  // Remove old drawer if any
  const old = document.getElementById('fin-drawer');
  if (old) old.remove();

  const drawer = document.createElement('div');
  drawer.id = 'fin-drawer';
  drawer.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;justify-content:flex-end';

  drawer.innerHTML = `
    <div style="position:absolute;inset:0;background:rgba(0,0,0,.35)" onclick="document.getElementById('fin-drawer').remove()"></div>
    <div style="position:relative;width:min(480px,100vw);height:100%;background:var(--surface,#fff);display:flex;flex-direction:column;box-shadow:-6px 0 32px rgba(0,0,0,.18);animation:finDrawerIn .22s ease">

      <!-- Header -->
      <div style="padding:1.25rem 1.25rem 1rem;border-bottom:1px solid var(--border);flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:1.15rem;font-weight:700;line-height:1.2">${v.client_name || pid}</div>
            <div style="font-size:.8rem;color:var(--muted);margin-top:.2rem">${pid}${v.client_service?' · '+v.client_service:''}</div>
            ${v.client_address ? `<div style="font-size:.8rem;color:var(--muted)">${v.client_address}</div>` : ''}
            <div style="font-size:.8rem;color:var(--muted);margin-top:.3rem">${d} · ${v.technician}</div>
          </div>
          <button onclick="document.getElementById('fin-drawer').remove()" style="background:none;border:none;font-size:1.5rem;line-height:1;cursor:pointer;color:var(--muted);padding:.2rem .4rem;border-radius:6px">×</button>
        </div>
        ${visitChemCost > 0 ? `<div style="margin-top:.6rem;display:inline-block;background:var(--teal);color:#fff;font-size:.8rem;font-weight:600;padding:.25rem .6rem;border-radius:20px">Chem cost: ${_finFmtCurrency(visitChemCost)}</div>` : ''}
      </div>

      <!-- Scrollable body -->
      <div style="flex:1;overflow-y:auto;padding:1rem 1.25rem 2rem">

        ${photos.length ? `
          <div style="margin-bottom:1.5rem">
            <div class="fin-drawer-label">Photos</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
              ${photos.map(url => `<img src="${url}" style="width:100%;border-radius:10px;object-fit:cover;aspect-ratio:4/3;cursor:zoom-in" onclick="window.open('${url}','_blank')" loading="lazy">`).join('')}
            </div>
          </div>` : ''}

        ${testRows.length ? `
          <div style="margin-bottom:1.5rem">
            <div class="fin-drawer-label">Water Test</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem">
              ${testRows.map(r => `
                <div style="background:var(--bg-subtle,#f4f6f5);border-radius:9px;padding:.55rem .75rem">
                  <div style="font-size:.65rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:.1rem">${r.k}</div>
                  <div style="font-weight:700;font-size:1rem;color:var(--teal)">${r.v}</div>
                </div>`).join('')}
            </div>
          </div>` : ''}

        ${chemRows.length ? `
          <div style="margin-bottom:1.5rem">
            <div class="fin-drawer-label">Chemicals Added</div>
            <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">
              ${chemRows.map((r, i) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .85rem;${i<chemRows.length-1?'border-bottom:1px solid var(--border)':''}">
                  <div style="font-size:.875rem">
                    <div>${r.k}</div>
                    ${r.cost ? `<div style="font-size:.7rem;color:var(--teal)">${_finFmtCurrency(r.cost)} total</div>` : ''}
                  </div>
                  <div style="text-align:right">
                    <span style="font-weight:700;font-size:.9rem">${r.v}</span>
                    ${r.unit ? `<span style="font-size:.7rem;color:var(--muted);margin-left:.2rem">${r.unit}</span>` : ''}
                  </div>
                </div>`).join('')}
            </div>
          </div>` : ''}

        ${notes ? `
          <div style="margin-bottom:1.5rem">
            <div class="fin-drawer-label">Notes</div>
            <div style="background:var(--bg-subtle,#f4f6f5);border-radius:10px;padding:.85rem;font-size:.875rem;line-height:1.55;white-space:pre-wrap">${notes}</div>
          </div>` : ''}

      </div>
    </div>`;

  document.body.appendChild(drawer);
}

function _finOpenPoolDetail(poolId, poolName) {
  // 1. Filter visits for this pool and current period
  let rows = _finFilterRows(_finCache);
  rows = rows.filter(r => r.pool_id === poolId || (poolName && r.pool_name === poolName));
  
  // Sort by date desc
  rows.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));

  // 2. Identify client detail from CRM
  const crm = _finFindCrm(poolId, poolName);
  const clientName = _finGetClientNameFromCrm(crm) || poolName || poolId;
  const status = crm?.status || 'UNKNOWN';

  // 3. Remove old drawer if any
  const old = document.getElementById('fin-pool-detail');
  if (old) old.remove();

  const drawer = document.createElement('div');
  drawer.id = 'fin-pool-detail';
  drawer.style.cssText = 'position:fixed;inset:0;z-index:8000;display:flex;justify-content:flex-end';

  const periodText = _finDateRangeText(_finPeriod) || 'All Time';

  drawer.innerHTML = `
    <div style="position:absolute;inset:0;background:rgba(0,0,0,.35)" onclick="document.getElementById('fin-pool-detail').remove()"></div>
    <div style="position:relative;width:min(520px,100vw);height:100%;background:var(--bg-subtle,#f8f9fa);display:flex;flex-direction:column;box-shadow:-6px 0 32px rgba(0,0,0,.18);animation:finDrawerIn .22s ease">
      
      <!-- Header -->
      <div style="padding:1.5rem 1.5rem 1rem;background:var(--surface,#fff);border-bottom:1px solid var(--border);flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:1.25rem;font-weight:700;line-height:1.2;color:var(--teal)">${clientName}</div>
            <div style="font-size:.85rem;color:var(--muted);margin-top:.2rem">${poolId} · ${status}</div>
            <div style="font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:.5rem">${periodText}</div>
          </div>
          <button onclick="document.getElementById('fin-pool-detail').remove()" style="background:none;border:none;font-size:1.5rem;line-height:1;cursor:pointer;color:var(--muted);padding:.2rem .4rem;border-radius:6px">×</button>
        </div>
      </div>

      <!-- Visit List -->
      <div style="flex:1;overflow-y:auto;padding:1.25rem 1.5rem 2.5rem">
        <div style="font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:.85rem">Visit History Card</div>
        
        ${rows.length ? rows.map((r, idx) => {
          const d = r.timestamp ? new Date(r.timestamp).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '—';
          const rate = _finRate(r.tech_name);
          const rowChem = _finGetRowChemData(r.detail);
          const chemCost = rowChem.totalCost;
          const totalCost = chemCost + rate;
          
          // Store in global visit cache for drill-down to individual visit details
          const vid = `pdetail_${idx}`;
          _finVisitCache[vid] = r;

          return `
            <div class="fin-visit-card" onclick="_finOpenVisit('${vid}')" style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.85rem;cursor:pointer;transition:transform .15s, box-shadow .15s">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.6rem">
                <div>
                  <div style="font-weight:700;font-size:.95rem">${d}</div>
                  <div style="font-size:.75rem;color:var(--muted)">${r.tech_name || 'Unassigned'}</div>
                </div>
                <div style="text-align:right">
                  <div style="font-weight:700;color:var(--teal);font-size:1rem">${_finFmtCurrency(totalCost)}</div>
                  <div style="font-size:0.65rem;color:var(--muted)">Total Cost</div>
                </div>
              </div>
              <div style="display:flex;gap:1.5rem;padding-top:.6rem;border-top:1px solid var(--border-light, #eee);font-size:.75rem">
                <div><span style="color:var(--muted)">Chem:</span> <b>${_finFmtCurrency(chemCost)}</b></div>
                <div><span style="color:var(--muted)">Labor:</span> <b>${_finFmtCurrency(rate)}</b></div>
              </div>
            </div>
          `;
        }).join('') : `<div style="text-align:center;padding:3rem 1rem;color:var(--muted)">No service logs found for this period.</div>`}
      </div>
    </div>
  `;

  document.body.appendChild(drawer);
}

// ── Tech: My Jobs hub tab ─────────────────────────────────────────────────────

let _myJobsCache  = [];
let _myJobsRate   = '';
let _myJobsLoaded = false;

async function loadMyJobsTab() {
  const root = document.getElementById('myjobs-root');
  if (!root) return;

  if (_myJobsLoaded && _myJobsCache.length) {
    _renderMyJobs();
    return;
  }

  root.innerHTML = '<div class="route-loading" style="display:flex;padding:2rem"><div class="spinner"></div></div>';

  try {
    const res = await apiGet({ action: 'get_visit_history', token: _s.token });
    if (!res.ok) {
      root.innerHTML = `<div style="padding:2rem;color:var(--error)">Error: ${res.error || 'Failed to load.'}</div>`;
      return;
    }
    _myJobsCache  = res.rows || [];
    _myJobsRate   = String(res.pay_rate || '');
    _myJobsLoaded = true;
    _renderMyJobs();
  } catch(e) {
    root.innerHTML = `<div style="padding:2rem;color:var(--error)">Network error. Please try again.</div>`;
  }
}

function _renderMyJobs() {
  const root = document.getElementById('myjobs-root');
  if (!root) return;

  const rate  = parseFloat(_myJobsRate) || 0;
  const rows  = _myJobsCache;

  const thisWeek  = rows.filter(r => _finIsThisWeek(r.timestamp));
  const thisMonth = rows.filter(r => _finIsThisMonth(r.timestamp));

  const weekJobs  = thisWeek.length;
  const monthJobs = thisMonth.length;
  const weekPay   = rate ? _finFmtCurrency(weekJobs * rate) : null;
  const monthPay  = rate ? _finFmtCurrency(monthJobs * rate) : null;

  // Recent visits — last 20
  const recent = rows.slice(0, 20);

  root.innerHTML = `
    <div style="padding:1rem">

      <!-- Summary cards -->
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1.25rem">
        <div style="flex:1;min-width:140px;background:var(--teal);color:#fff;border-radius:12px;padding:1rem 1.25rem">
          <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;opacity:.8">This Week</div>
          <div style="font-size:2rem;font-weight:700;line-height:1.1">${weekJobs}</div>
          <div style="font-size:.8rem;opacity:.85">${weekPay ? `Est. ${weekPay}` : 'jobs completed'}</div>
        </div>
        <div style="flex:1;min-width:140px;background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:12px;padding:1rem 1.25rem">
          <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">This Month</div>
          <div style="font-size:2rem;font-weight:700;line-height:1.1;color:var(--teal)">${monthJobs}</div>
          <div style="font-size:.8rem;color:var(--muted)">${monthPay ? `Est. ${monthPay}` : 'jobs completed'}</div>
        </div>
        ${rate ? `
        <div style="flex:1;min-width:140px;background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:12px;padding:1rem 1.25rem">
          <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Pay Rate</div>
          <div style="font-size:2rem;font-weight:700;line-height:1.1;color:var(--teal)">${_finFmtCurrency(rate)}</div>
          <div style="font-size:.8rem;color:var(--muted)">per stop</div>
        </div>` : ''}
      </div>

      <!-- Recent visits list -->
      <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.5rem">Recent Visits</div>
      ${recent.length ? recent.map(r => {
        const d   = r.timestamp ? new Date(r.timestamp).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'}) : '—';
        const pid = String(r.pool_id||'').replace(/.*-\s*/,'').trim();
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .75rem;margin-bottom:.35rem;background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:8px;font-size:.875rem">
          <div>
            <div style="font-weight:600">${pid || r.pool_id || '—'}</div>
            <div style="font-size:.75rem;color:var(--muted)">${r.week_key || ''}</div>
          </div>
          <div style="color:var(--muted);font-size:.8rem">${d}</div>
        </div>`;
      }).join('') : '<div style="color:var(--muted);padding:.5rem 0">No visits recorded yet.</div>'}

      <button class="mvt-btn" style="margin-top:.75rem" onclick="_myJobsLoaded=false;loadMyJobsTab()">↻ Refresh</button>
    </div>`;
}

// ── Profitability Tab ────────────────────────────────────────────────────────

function _renderProfitTab() {
  let rows = _finFilterRows(_finCache);
  if (_finTechFilter) {
    rows = rows.filter(r => _finCanonicalName(r.technician || r.tech_name) === _finTechFilter);
  }
  const grouped = {};

  // 1. Group logs by pool
  rows.forEach(r => {
    const key = r.pool_id || r.pool_name;
    if (!grouped[key]) {
      grouped[key] = {
        pool_id: r.pool_id,
        pool_name: r.pool_name,
        chem_cost: 0,
        labor_cost: 0,
        visit_count: 0,
        last_visit: null
      };
    }
    const g = grouped[key];
    const rowChem = _finGetRowChemData(r.detail);
    g.chem_cost += rowChem.totalCost;
    const rate = _finRate(r.tech_name);
    g.labor_cost += rate;
    g.visit_count++;
    if (!g.last_visit || new Date(r.timestamp) > new Date(g.last_visit)) {
      g.last_visit = r.timestamp;
    }
  });

  // 2. Join with CRM and calculate metrics
  const analysis = Object.values(grouped).map(g => {
    // Attempt match in CRM
    const crm = _finFindCrm(g.pool_id, g.pool_name);
    
    const revenue = parseFloat(crm?.discounted_service_subtotal) || 0;
    const totalCost = g.chem_cost + g.labor_cost;
    const profit = revenue - totalCost;
    const margin = revenue > 0 ? (profit / revenue) : 0;
    const marginEst = parseFloat(crm?.margin_est) || 0;
    const variance = margin - (marginEst / 100);

    return {
      ...g,
      display_name: _finGetClientNameFromCrm(crm) || g.pool_name || g.pool_id,
      status: crm?.status || 'UNKNOWN',
      revenue,
      totalCost,
      profit,
      margin,
      marginEst: marginEst / 100,
      variance
    };
  });

  // Sort by profit desc
  analysis.sort((a,b) => b.profit - a.profit);

  // 3. Render
  const tbody = document.getElementById('profit-tbody');
  const thead = document.getElementById('profit-thead');
  const stats = document.getElementById('profit-stats');

  thead.innerHTML = `
    <tr>
      <th style="padding-left:1rem">Pool</th>
      <th>Status</th>
      <th>Visits</th>
      <th>Revenue (Est.)</th>
      <th>Actual Cost</th>
      <th>Profit</th>
      <th>Margin</th>
      <th style="text-align:right;padding-right:1rem">Variance</th>
    </tr>
  `;

  if (!analysis.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--muted)">No data for this period.</td></tr>`;
  } else {
    tbody.innerHTML = analysis.map(a => {
      const statusClass = a.status === 'ACTIVE_CUSTOMER' ? 'svc-weekly' : (a.status === 'LOST' ? 'svc-gtc' : 'svc-other');
      const varColor = a.variance >= 0 ? '#16a34a' : '#dc2626';
      const marginColor = a.margin >= 0.4 ? '#16a34a' : (a.margin >= 0.2 ? '#b45309' : '#dc2626');

      return `
        <tr onclick="_finOpenPoolDetail('${a.pool_id}', '${a.pool_name}')" style="cursor:pointer">
          <td style="padding-left:1rem;font-weight:600">${a.display_name || '—'}</td>
          <td><span class="ps-label ${statusClass}">${a.status}</span></td>
          <td>${a.visit_count}</td>
          <td>${_finFmtCurrency(a.revenue)}</td>
          <td>
            <div style="font-weight:600">${_finFmtCurrency(a.totalCost)}</div>
            <div style="font-size:0.7rem;color:var(--muted)">Chem: ${_finFmtCurrency(a.chem_cost)} | Lab: ${_finFmtCurrency(a.labor_cost)}</div>
          </td>
          <td style="font-weight:700;color:${a.profit >= 0 ? 'var(--text)' : '#dc2626'}">${_finFmtCurrency(a.profit)}</td>
          <td style="color:${marginColor};font-weight:600">${(a.margin * 100).toFixed(1)}%</td>
          <td style="text-align:right;padding-right:1rem;color:${varColor};font-weight:700">
            ${a.variance >= 0 ? '+' : ''}${(a.variance * 100).toFixed(1)}%
          </td>
        </tr>
      `;
    }).join('');
  }

  // Stats cards
  const totalRev = analysis.reduce((sum, a) => sum + a.revenue, 0);
  const totalCost = analysis.reduce((sum, a) => sum + a.totalCost, 0);
  const totalProfit = totalRev - totalCost;
  const avgMargin = totalRev > 0 ? (totalProfit / totalRev) : 0;

  stats.innerHTML = `
    <div style="display:flex;gap:1rem;padding:1rem;flex-wrap:wrap">
      <div class="q-met hi" style="flex:1;min-width:140px">
        <div class="q-met-lbl">Total Period Revenue</div>
        <div class="q-met-val">${_finFmtCurrency(totalRev)}</div>
      </div>
      <div class="q-met" style="flex:1;min-width:140px">
        <div class="q-met-lbl">Actual Operating Cost</div>
        <div class="q-met-val">${_finFmtCurrency(totalCost)}</div>
      </div>
      <div class="q-met" style="flex:1;min-width:140px">
        <div class="q-met-lbl">Net Operating Profit</div>
        <div class="q-met-val" style="color:${totalProfit >= 0 ? 'var(--teal)' : '#dc2626'}">${_finFmtCurrency(totalProfit)}</div>
      </div>
      <div class="q-met" style="flex:1;min-width:140px">
        <div class="q-met-lbl">Avg Period Margin</div>
        <div class="q-met-val">${(avgMargin * 100).toFixed(1)}%</div>
      </div>
    </div>
  `;
}

// ── Chemical Analysis Tab ──────────────────────────────────────────────────

function _renderChemTab() {
  let rows = _finFilterRows(_finCache);
  if (_finTechFilter) {
    rows = rows.filter(r => _finCanonicalName(r.technician || r.tech_name) === _finTechFilter);
  }
  const fleetChems = {}; // chemical_name -> { cost: 0, amount: 0, unit: '', visits: 0 }
  const poolChems  = {}; // pool_id -> { pool_name, cost: 0, breakdown: {} }


    rows.forEach(r => {
      const detail = r.detail || {};
      const pk = r.pool_id || r.pool_name;
      
      const rowChem = _finGetRowChemData(detail);
      rowChem.chemRows.forEach(cr => {
        const name = cr.k;
        const cost = cr.cost;
        const num  = parseFloat(cr.v) || 0;
        const unit = cr.unit;

        // Fleet aggregation
        if (!fleetChems[name]) fleetChems[name] = { cost: 0, amount: 0, unit, visits: 0 };
        fleetChems[name].cost += cost;
        fleetChems[name].amount += num;
        fleetChems[name].visits++;

        // Pool aggregation
        const crmItem = _finFindCrm(r.pool_id, r.pool_name);
        const dispName = _finGetClientNameFromCrm(crmItem) || r.pool_name || r.pool_id;

        if (!poolChems[pk]) poolChems[pk] = { pool_name: dispName, pool_id: r.pool_id, cost: 0, breakdown: {} };
        poolChems[pk].cost += cost;
        if (!poolChems[pk].breakdown[name]) poolChems[pk].breakdown[name] = 0;
        poolChems[pk].breakdown[name] += cost;
      });
    });

  const sortedFleet = Object.entries(fleetChems).sort((a,b) => b[1].cost - a[1].cost);
  const sortedPools = Object.values(poolChems).sort((a,b) => b.cost - a.cost).slice(0, 10);

  // Stats: Top chemicals
  const stats = document.getElementById('chem-stats');
  stats.innerHTML = `
    <div style="padding:1rem; background:var(--surface); margin:1rem; border-radius:12px; border:1px solid var(--border)">
      <div class="q-met-lbl" style="margin-bottom:0.75rem">FLEET-WIDE CHEMICAL CONSUMPTION</div>
      <div style="display:flex; gap:1.5rem; flex-wrap:wrap">
        ${sortedFleet.slice(0, 4).map(([name, data]) => `
          <div style="min-width:120px">
            <div style="font-size:0.75rem; color:var(--muted); font-weight:600">${name.toUpperCase()}</div>
            <div style="font-size:1.1rem; font-weight:700; color:var(--teal)">${_finFmtCurrency(data.cost)}</div>
            <div style="font-size:0.65rem; color:var(--muted)">${data.amount.toFixed(1)}${data.unit} total</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const thead = document.getElementById('chem-thead');
  const tbody = document.getElementById('chem-tbody');

  thead.innerHTML = `
    <tr>
      <th style="padding-left:1rem">Pool (Top 10 High-Utilization)</th>
      <th>Total Chem Spend</th>
      <th style="text-align:right;padding-right:1rem">Highest Cost Factor</th>
    </tr>
  `;

  if (!sortedPools.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:2rem;color:var(--muted)">No chemical usage recorded.</td></tr>`;
  } else {
    tbody.innerHTML = sortedPools.map(p => {
      const topChem = Object.entries(p.breakdown).sort((a,b) => b[1] - a[1])[0];
      return `
        <tr onclick="_finOpenPoolDetail('${p.pool_id}', '${p.pool_name}')" style="cursor:pointer">
          <td style="padding-left:1rem;font-weight:600">${p.pool_name || '—'}</td>
          <td style="font-weight:700;color:var(--teal)">${_finFmtCurrency(p.cost)}</td>
          <td style="text-align:right;padding-right:1rem;font-size:0.85rem">
            ${topChem ? `<b>${topChem[0]}</b> (${_finFmtCurrency(topChem[1])})` : '—'}
          </td>
        </tr>
      `;
    }).join('');
  }
}

// ── Clients Tab ────────────────────────────────────────────────────────────────

let _clientsSearch = '';
let _clientsAreaFilter = '';
let _clientsBillingFilter = '';
let _clientsQuickFilter = '';
let _clientsSort = 'attention';

function _clientsPaymentLog(item) {
  try {
    const raw = item?.payment_log;
    const parsed = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    return parsed.map(e => ({ ...e }));
  } catch(e) {
    return [];
  }
}

function _clientsCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function _clientsMonthStatus(item, monthKey = _clientsCurrentMonthKey()) {
  const entry = _clientsPaymentLog(item).find(e => e.month === monthKey);
  if (entry?.status) return entry.status;
  return item.invoice_day && item.billing_start ? 'pending' : 'none';
}

function _clientsDaysAgo(dateStr) {
  const d = new Date(dateStr || '');
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}

function _clientsSetQuickFilter(filter) {
  _clientsQuickFilter = _clientsQuickFilter === filter ? '' : filter;
  _renderClientsTable();
}

function _clientsSetBillingFilter(filter) {
  _clientsBillingFilter = filter || '';
  _renderClientsTable();
}

async function _clientsMarkBilling(quoteId, status) {
  const item = (_finCrmCache || []).find(i => i.quote_id === quoteId);
  if (!item) return;

  const month = _clientsCurrentMonthKey();
  const log = _clientsPaymentLog(item);
  const entryIdx = log.findIndex(e => e.month === month);
  if (entryIdx > -1) log[entryIdx].status = status;
  else log.push({ month, status });

  const prevLog = item.payment_log;
  item.payment_log = log;
  if (typeof _crmCache !== 'undefined') {
    const idx = _crmCache.findIndex(i => i.quote_id === quoteId);
    if (idx > -1) _crmCache[idx].payment_log = log;
  }
  _appCacheSet('crm_data', _finCrmCache);
  _renderClientsTab();

  const res = await api({
    action: 'update_lead',
    token: _s.token,
    quote_id: quoteId,
    status: item.status || 'ACTIVE_CUSTOMER',
    notes: item.notes || '',
    payment_log: log
  });

  if (!res.ok) {
    item.payment_log = prevLog;
    if (typeof _crmCache !== 'undefined') {
      const idx = _crmCache.findIndex(i => i.quote_id === quoteId);
      if (idx > -1) _crmCache[idx].payment_log = prevLog;
    }
    _appCacheSet('crm_data', _finCrmCache);
    _renderClientsTab();
    alert(res.error || 'Billing update failed.');
  } else {
    _appCacheSet('crm_data', _finCrmCache);
  }
}

function _renderClientsTab() {
  // Hide the period/tech shared filters — not relevant for clients
  const sharedFilters = document.getElementById('fin-shared-filters');
  if (sharedFilters) sharedFilters.innerHTML = '';

  // Seed the CRM drawer's cache so viewCRMDetail works from this tab
  if (typeof _crmCache !== 'undefined' && _finCrmCache && _finCrmCache.length) {
    _crmCache = [..._finCrmCache];
  }

  const clients = (_finCrmCache || []).filter(r => r.status === 'ACTIVE_CUSTOMER');

  // Build route and last-visit signals from service submissions.
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const visitRows = (_finCache || []).filter(r => r.pool_id);
  const inRouteIds = new Set(
    visitRows
      .filter(r => {
        const ts = new Date(r.timestamp || r.date || '').getTime();
        return !isNaN(ts) && ts >= cutoff;
      })
      .map(r => _finNormalizePoolId(r.pool_id))
  );
  const lastVisitByPool = {};
  const visitsThisMonthByPool = {};
  const currentMonthKey = _clientsCurrentMonthKey();
  visitRows.forEach(r => {
    const normPoolId = _finNormalizePoolId(r.pool_id);
    const ts = new Date(r.timestamp || r.date || '');
    if (!isNaN(ts)) {
      if (!lastVisitByPool[normPoolId] || ts > new Date(lastVisitByPool[normPoolId].timestamp || lastVisitByPool[normPoolId].date || '')) {
        lastVisitByPool[normPoolId] = r;
      }
      const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}`;
      if (key === currentMonthKey) visitsThisMonthByPool[normPoolId] = (visitsThisMonthByPool[normPoolId] || 0) + 1;
    }
  });

  const now = new Date();

  // Days of the current week (Mon–Sun) that fall within the current month
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekDaysInMonth = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
      weekDaysInMonth.push(d.getDate());
    }
  }

  const enriched = clients.map(c => {
    const normPoolId = _finNormalizePoolId(c.pool_id);
    const inRoutes = !!(normPoolId && inRouteIds.has(normPoolId));
    const thisMonthStatus = _clientsMonthStatus(c, currentMonthKey);
    const monthlyRate = parseFloat(c.discounted_service_subtotal) || parseFloat(c.total_with_tax) || 0;
    const name = c.client_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
    const dueThisWeek = !!(c.invoice_day && weekDaysInMonth.includes(Number(c.invoice_day)));
    const lastVisit = normPoolId ? lastVisitByPool[normPoolId] : null;
    const lastVisitDays = _clientsDaysAgo(lastVisit?.timestamp || lastVisit?.date);
    const visitsThisMonth = normPoolId ? (visitsThisMonthByPool[normPoolId] || 0) : 0;
    const needsBilling = ['pending', 'none'].includes(thisMonthStatus);
    const noRoute = !inRoutes;
    const stale = lastVisitDays === null || lastVisitDays > 21;
    const attentionScore = (needsBilling ? 4 : 0) + (dueThisWeek ? 3 : 0) + (noRoute ? 3 : 0) + (stale ? 2 : 0);
    return { ...c, inRoutes, thisMonthStatus, monthlyRate, name, dueThisWeek, lastVisit, lastVisitDays, visitsThisMonth, needsBilling, noRoute, stale, attentionScore };
  });

  const totalMRR = enriched.reduce((s, c) => s + c.monthlyRate, 0);
  const inRoutesCount = enriched.filter(c => c.inRoutes).length;
  const billingIssues = enriched.filter(c => c.needsBilling).length;
  const routeMissing = enriched.filter(c => c.noRoute).length;
  const dueThisWeek = enriched.filter(c => c.dueThisWeek && c.thisMonthStatus !== 'paid').length;
  const staleVisits = enriched.filter(c => c.stale).length;

  const statsEl = document.getElementById('clients-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="clients-ops-grid">
        <button class="clients-op-card" onclick="_clientsSetQuickFilter('billing')">
          <span>Needs Billing</span><strong>${billingIssues}</strong><small>${dueThisWeek} due this week</small>
        </button>
        <button class="clients-op-card" onclick="_clientsSetQuickFilter('routes')">
          <span>Missing From Routes</span><strong>${routeMissing}</strong><small>${inRoutesCount} active in route logs</small>
        </button>
        <button class="clients-op-card" onclick="_clientsSetQuickFilter('stale')">
          <span>Stale / No Visits</span><strong>${staleVisits}</strong><small>Over 21 days or no log</small>
        </button>
        <div class="clients-op-card clients-op-card--money">
          <span>Monthly Revenue</span><strong>${_finFmtCurrency(totalMRR)}</strong><small>${enriched.length} active accounts</small>
        </div>
      </div>`;
  }

  const areas = [...new Set(enriched.map(c => c.area).filter(Boolean))].sort();
  const filtersEl = document.getElementById('clients-filters');
  if (filtersEl) {
    filtersEl.innerHTML = `
      <div class="clients-toolbar">
        <div class="clients-quick-filters">
          ${[
            ['billing', 'Needs Billing'],
            ['routes', 'Not In Routes'],
            ['stale', 'Stale Visits'],
            ['due', 'Due This Week'],
            ['paid', 'Paid']
          ].map(([key, label]) => `<button class="clients-chip ${_clientsQuickFilter===key?'active':''}" onclick="_clientsSetQuickFilter('${key}')">${label}</button>`).join('')}
        </div>
        <div class="clients-filter-grid">
        <div style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:.3rem">
          <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Search</label>
          <input type="text" class="si" placeholder="Name, email, or pool ID…"
            value="${_clientsSearch}" oninput="_clientsSearch=this.value;_renderClientsTable()">
        </div>
        <div style="display:flex;flex-direction:column;gap:.3rem">
          <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Area</label>
          <select class="si" style="width:auto" onchange="_clientsAreaFilter=this.value;_renderClientsTable()">
            <option value="">All Areas</option>
            ${areas.map(a => `<option value="${a}" ${_clientsAreaFilter===a?'selected':''}>${a}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:.3rem">
          <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Billing</label>
          <select class="si" style="width:auto" onchange="_clientsBillingFilter=this.value;_renderClientsTable()">
            <option value="">All</option>
            <option value="due_this_week" ${_clientsBillingFilter==='due_this_week'?'selected':''}>Due This Week</option>
            <option value="paid" ${_clientsBillingFilter==='paid'?'selected':''}>Paid</option>
            <option value="invoiced" ${_clientsBillingFilter==='invoiced'?'selected':''}>Invoiced</option>
            <option value="pending" ${_clientsBillingFilter==='pending'?'selected':''}>Pending</option>
            <option value="none" ${_clientsBillingFilter==='none'?'selected':''}>No Record</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:.3rem">
          <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Sort</label>
          <select class="si" style="width:auto" onchange="_clientsSort=this.value;_renderClientsTable()">
            <option value="attention" ${_clientsSort==='attention'?'selected':''}>Needs attention</option>
            <option value="invoice_day" ${_clientsSort==='invoice_day'?'selected':''}>Invoice day</option>
            <option value="rate" ${_clientsSort==='rate'?'selected':''}>Monthly rate</option>
            <option value="last_visit" ${_clientsSort==='last_visit'?'selected':''}>Last visit</option>
            <option value="name" ${_clientsSort==='name'?'selected':''}>Client name</option>
          </select>
        </div>
        </div>
      </div>`;
  }

  window._clientsEnriched = enriched;
  _renderClientsTable(enriched);
}

function _renderClientsTable(enriched) {
  const all = window._clientsEnriched || enriched || [];
  let rows = [...all];

  if (_clientsSearch) {
    const q = _clientsSearch.toLowerCase();
    rows = rows.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.pool_id || '').toLowerCase().includes(q)
    );
  }
  if (_clientsAreaFilter) rows = rows.filter(c => c.area === _clientsAreaFilter);
  if (_clientsBillingFilter) {
    if (_clientsBillingFilter === 'due_this_week') {
      rows = rows.filter(c => c.dueThisWeek);
    } else {
      rows = rows.filter(c => c.thisMonthStatus === _clientsBillingFilter);
    }
  }
  if (_clientsQuickFilter === 'billing') rows = rows.filter(c => c.needsBilling);
  if (_clientsQuickFilter === 'routes') rows = rows.filter(c => c.noRoute);
  if (_clientsQuickFilter === 'stale') rows = rows.filter(c => c.stale);
  if (_clientsQuickFilter === 'due') rows = rows.filter(c => c.dueThisWeek && c.thisMonthStatus !== 'paid');
  if (_clientsQuickFilter === 'paid') rows = rows.filter(c => c.thisMonthStatus === 'paid');

  rows.sort((a, b) => {
    if (_clientsSort === 'attention') return (b.attentionScore - a.attentionScore) || a.name.localeCompare(b.name);
    if (_clientsSort === 'invoice_day') return (Number(a.invoice_day) || 99) - (Number(b.invoice_day) || 99);
    if (_clientsSort === 'rate') return b.monthlyRate - a.monthlyRate;
    if (_clientsSort === 'last_visit') return (b.lastVisitDays ?? 9999) - (a.lastVisitDays ?? 9999);
    return a.name.localeCompare(b.name);
  });

  const thead = document.getElementById('clients-thead');
  const tbody = document.getElementById('clients-tbody');
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>
    <th style="padding-left:1rem">Client</th>
    <th>Billing</th>
    <th>Service / Route</th>
    <th>Last Visit</th>
    <th style="text-align:right;padding-right:1rem">Actions</th>
  </tr>`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--muted)">No active clients match your filters.</td></tr>`;
    return;
  }


  const billingBadge = (s, due) => {
    const map = {
      paid:     ['#d1fae5','#065f46','Paid'],
      invoiced: ['#fef3c7','#92400e','Invoiced'],
      pending:  ['#fee2e2','#991b1b','Pending'],
      none:     ['#f3f4f6','#6b7280','No Record']
    };
    const [bg, color, label] = map[s] || map.none;
    const duePill = due ? ` <span style="background:#fef3c7;color:#b45309;padding:.1rem .4rem;border-radius:99px;font-size:.72rem;font-weight:600">Due</span>` : '';
    return `<span style="background:${bg};color:${color};padding:.15rem .55rem;border-radius:99px;font-size:.78rem;font-weight:600">${label}</span>${duePill}`;
  };

  const routeBadge = c => c.inRoutes
    ? `<span class="clients-pill ok">In routes</span>`
    : `<span class="clients-pill warn">Not in routes</span>`;
  const visitText = c => {
    if (c.lastVisitDays === null) return '<span class="clients-pill warn">No visit log</span>';
    const date = new Date(c.lastVisit.timestamp || c.lastVisit.date).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const tone = c.lastVisitDays > 21 ? 'warn' : 'ok';
    return `<span class="clients-pill ${tone}">${date}</span><div class="clients-sub">${c.lastVisitDays === 0 ? 'Today' : `${c.lastVisitDays} days ago`} · ${c.visitsThisMonth} this month</div>`;
  };

  tbody.innerHTML = rows.map(c => {
    const quote = escHtml(c.quote_id);
    const email = escHtml(c.email || '');
    const phone = escHtml(c.phone || '');
    const mapUrl = c.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([c.address, c.city, c.zip_code].filter(Boolean).join(', '))}` : '';
    return `
      <tr class="clients-row" onclick="viewCRMDetail('${quote}')">
        <td style="padding-left:1rem">
          <div class="clients-name">${escHtml(c.name)}</div>
          <div class="clients-sub">${escHtml([c.city, c.area].filter(Boolean).join(' · ') || c.pool_id || 'No pool ID')}</div>
          <div class="clients-contact">
            ${email ? `<a onclick="event.stopPropagation()" href="mailto:${email}" title="${email}">✉ Email</a>` : ''}
            ${phone ? `<a onclick="event.stopPropagation()" href="tel:${phone}" title="${phone}">📞 ${escHtml(phone)}</a>` : ''}
            ${mapUrl ? `<a class="clients-map" onclick="event.stopPropagation()" href="${escHtml(mapUrl)}" target="_blank" rel="noopener">📍 Map</a>` : ''}
          </div>
        </td>
        <td>
          <div style="font-weight:700">${c.monthlyRate ? _finFmtCurrency(c.monthlyRate) : '—'}</div>
          ${c.invoice_day ? `<div class="clients-sub">Invoice day ${c.invoice_day}</div>` : ''}
          <div style="margin-top:.35rem">${billingBadge(c.thisMonthStatus, c.dueThisWeek)}</div>
        </td>
        <td>
          <div style="font-weight:600;font-size:.88rem">${escHtml(c.service || '—')}</div>
          <div style="margin-top:.35rem">${routeBadge(c)}</div>
        </td>
        <td>${visitText(c)}</td>
        <td style="text-align:right;padding-right:1rem">
          <div class="clients-actions">
            ${c.thisMonthStatus !== 'invoiced' && c.thisMonthStatus !== 'paid' ? `<button onclick="event.stopPropagation();_clientsMarkBilling('${quote}','invoiced')">Mark invoiced</button>` : ''}
            ${c.thisMonthStatus !== 'paid' ? `<button onclick="event.stopPropagation();_clientsMarkBilling('${quote}','paid')">Mark paid</button>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// PAYROLL TAB — K-1 partner distributions + W-2 owner-employee (Texas, Single)
// ══════════════════════════════════════════════════════════════════════════════

let _finPayrollData  = null; // { w2, partners, log }
let _finPayrollMonth = '';   // 'YYYY-MM'

// ── IRS Pub 15-T 2025/2026 Percentage Method (Single, no adjustments) ─────────
function _calcW2Withholding(grossMonthly) {
  const annual = grossMonthly * 12;
  const brackets = [
    { floor: 0,       base: 0,           rate: 0.10 },
    { floor: 11925,   base: 1192.50,     rate: 0.12 },
    { floor: 47150,   base: 5418.50,     rate: 0.22 },
    { floor: 100525,  base: 17161.00,    rate: 0.24 },
    { floor: 191950,  base: 39105.00,    rate: 0.32 },
    { floor: 243725,  base: 56172.00,    rate: 0.35 },
    { floor: 609350,  base: 184015.75,   rate: 0.37 },
  ];
  let annualFed = 0;
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (annual > brackets[i].floor) {
      annualFed = brackets[i].base + (annual - brackets[i].floor) * brackets[i].rate;
      break;
    }
  }
  const r = n => Math.round(n * 100) / 100;
  const fed = annualFed / 12;
  const ss  = grossMonthly * 0.062;
  const med = grossMonthly * 0.0145;
  return {
    fed:    r(fed),
    ss:     r(ss),
    med:    r(med),
    net:    r(grossMonthly - fed - ss - med),
    er_ss:  r(ss),
    er_med: r(med),
  };
}

async function _loadAndRenderPayroll() {
  const now = new Date();
  if (!_finPayrollMonth) {
    _finPayrollMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  const el = document.getElementById('payroll-content');
  if (el) el.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--muted)">Loading payroll data…</div>`;
  try {
    const year = _finPayrollMonth.slice(0, 4);
    const [configRes, logRes] = await Promise.all([
      apiGet({ action: 'get_payroll_config', token: _s.token }),
      apiGet({ action: 'get_payroll_log',    token: _s.token, year }),
    ]);
    _finPayrollData = {
      w2:       configRes.w2       || null,
      partners: configRes.partners || [],
      log:      logRes.rows        || [],
    };
  } catch (e) {
    if (el) el.innerHTML = `<div style="padding:2rem;color:var(--error)">Failed to load payroll data.</div>`;
    return;
  }
  _renderPayrollTab();
}

function _payrollPrevMonth() {
  const [y, m] = _finPayrollMonth.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  _finPayrollMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  _loadAndRenderPayroll();
}

function _payrollNextMonth() {
  const [y, m] = _finPayrollMonth.split('-').map(Number);
  const d = new Date(y, m, 1);
  _finPayrollMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  _loadAndRenderPayroll();
}

function _renderPayrollTab() {
  const el = document.getElementById('payroll-content');
  if (!el) return;

  const data = _finPayrollData;
  const notConfigured = !data || (!data.w2 && (!data.partners || data.partners.length === 0));

  const [selYear, selMon] = _finPayrollMonth.split('-').map(Number);
  const monthLabel = new Date(selYear, selMon - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const setupBtn = isAdmin()
    ? `<button class="adm-new-btn" style="background:var(--teal)" onclick="_finPayrollSetupModal()">⚙ Setup Payroll</button>`
    : '';

  if (notConfigured) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:1.5rem">
        <h3 style="margin:0;color:var(--teal)">Payroll</h3>
        ${setupBtn}
      </div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:2rem;text-align:center;color:var(--muted)">
        <div style="font-size:2rem;margin-bottom:.75rem">💼</div>
        <div style="font-weight:600;margin-bottom:.5rem">Payroll not configured</div>
        <div style="font-size:.9rem">Set up your W-2 employee and K-1 partners to get started.</div>
        ${isAdmin() ? `<button class="adm-new-btn" style="margin-top:1.25rem;background:var(--teal)" onclick="_finPayrollSetupModal()">Setup Payroll</button>` : ''}
      </div>`;
    return;
  }

  // ── Month nav ────────────────────────────────────────────────────────────────
  const nav = `
    <div style="display:flex;align-items:center;gap:1rem">
      <button class="mvt-btn" onclick="_payrollPrevMonth()">←</button>
      <span style="font-weight:600;font-size:1rem;min-width:130px;text-align:center">${monthLabel}</span>
      <button class="mvt-btn" onclick="_payrollNextMonth()">→</button>
    </div>`;

  // ── Shared profit estimate (used by both W-2 and K-1 sections) ───────────────
  const monthlyRevenue = _finCrmCache
    .filter(c => c.status === 'ACTIVE_CUSTOMER')
    .reduce((s, c) => s + (parseFloat(c.discounted_service_subtotal) || parseFloat(c.total_with_tax) || 0), 0);
  const monthVisits = _finCache.filter(r => {
    const d = new Date(r.timestamp || r.date || '');
    return !isNaN(d) && d.getFullYear() === selYear && (d.getMonth() + 1) === selMon;
  });
  const monthChem  = monthVisits.reduce((s, r) => s + (parseFloat(r.chem_cost)  || 0), 0);
  const monthLabor = monthVisits.reduce((s, r) => s + (parseFloat(r.labor_cost) || 0), 0);
  const estNet     = monthlyRevenue - monthChem - monthLabor; // gross profit — split by % for each owner

  // ── W-2 owner section ────────────────────────────────────────────────────────
  let w2Html = '';
  if (data.w2) {
    const w2Pct    = parseFloat(data.w2.pct) || 0;
    const w2Gross  = estNet > 0 ? estNet * w2Pct / 100 : 0;
    const wh       = _calcW2Withholding(w2Gross);
    const paidEntry = data.log.find(r => r.type === 'w2' && r.period === _finPayrollMonth);

    const ytdEntries  = data.log.filter(r => r.type === 'w2' && r.period.startsWith(String(selYear)));
    const ytdGross    = ytdEntries.reduce((s, r) => s + (r.gross || 0), 0);
    const futuaWageBase = 7000;
    const sutaWageBase  = 9000;
    const prevYtd     = ytdGross - (paidEntry ? (paidEntry.gross || 0) : 0);
    const futaWages   = Math.max(0, Math.min(w2Gross, futuaWageBase - prevYtd));
    const sutaWages   = Math.max(0, Math.min(w2Gross, sutaWageBase  - prevYtd));

    const statusBadge = paidEntry
      ? `<span style="background:#dcfce7;color:#166534;padding:.25rem .75rem;border-radius:99px;font-size:.82rem;font-weight:600">
           Paid ${_finFmtCurrency(paidEntry.net)} net on ${paidEntry.timestamp ? paidEntry.timestamp.split(' ')[0] : '—'}
         </span>`
      : (isAdmin()
          ? `<button class="adm-new-btn" style="background:var(--teal)" onclick="_finPayrollLogModal('w2',${JSON.stringify(data.w2.name).replace(/"/g, '&quot;')},${w2Gross.toFixed(2)},${wh.net.toFixed(2)},'${_finPayrollMonth}')">Log W-2 Payment (net ${_finFmtCurrency(wh.net)})</button>`
          : `<span style="color:var(--muted)">Not yet logged</span>`);

    w2Html = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem">
        <div style="display:flex;align-items:baseline;gap:.75rem;margin-bottom:1rem">
          <span style="font-weight:700;font-size:1rem;color:var(--teal)">W-2 Owner: ${escHtml(data.w2.name)}</span>
          <span style="background:#dbeafe;color:#1d4ed8;padding:.15rem .55rem;border-radius:99px;font-size:.75rem;font-weight:600">${w2Pct}% ownership → W-2 wages</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem 2rem;font-size:.9rem;margin-bottom:1rem">
          <span style="color:var(--muted)">Gross wages (${w2Pct}% of est. net)</span><span style="font-weight:600">${_finFmtCurrency(w2Gross)}</span>
          <span style="color:var(--muted)">Federal income tax</span><span style="color:#dc2626">−${_finFmtCurrency(wh.fed)}</span>
          <span style="color:var(--muted)">Social Security (6.2%)</span><span style="color:#dc2626">−${_finFmtCurrency(wh.ss)}</span>
          <span style="color:var(--muted)">Medicare (1.45%)</span><span style="color:#dc2626">−${_finFmtCurrency(wh.med)}</span>
          <span style="border-top:1px solid var(--border);padding-top:.4rem;font-weight:600">Net take-home</span>
          <span style="border-top:1px solid var(--border);padding-top:.4rem;font-weight:700;color:var(--teal)">${_finFmtCurrency(wh.net)}</span>
        </div>
        <div style="margin-bottom:1rem">${statusBadge}</div>
        <div style="background:rgba(0,0,0,.03);border-radius:8px;padding:.75rem;font-size:.83rem;color:var(--muted)">
          <strong style="color:var(--text)">Employer taxes also owed (EFTPS, separately):</strong><br>
          SS ${_finFmtCurrency(wh.er_ss)} · Medicare ${_finFmtCurrency(wh.er_med)}
          ${futaWages > 0 ? ` · FUTA ${_finFmtCurrency(futaWages * 0.006)} (${_finFmtCurrency(prevYtd)} of $7,000 YTD)` : ' · FUTA $0 (wage base met)'}
          ${sutaWages > 0 ? ` · SUTA TX ${_finFmtCurrency(sutaWages * 0.027)} (${_finFmtCurrency(prevYtd)} of $9,000 YTD)` : ' · SUTA TX $0 (wage base met)'}
        </div>
        <div style="font-size:.8rem;color:var(--muted);margin-top:.5rem">YTD gross paid: <strong>${_finFmtCurrency(ytdGross)}</strong> · IRS Pub 15-T 2025/2026 (Single, TX)</div>
      </div>`;
  }

  // ── K-1 section ──────────────────────────────────────────────────────────────
  let k1Html = '';
  if (data.partners && data.partners.length > 0) {
    const partnerRows = data.partners.map(p => {
      const suggested = estNet > 0 ? (estNet * p.pct / 100) : 0;
      const paidEntry = data.log.find(r => r.type === 'k1' && r.person === p.name && r.period === _finPayrollMonth);
      const ytdPaid   = data.log.filter(r => r.type === 'k1' && r.person === p.name && r.period.startsWith(String(selYear))).reduce((s, r) => s + (r.gross || 0), 0);
      const actionCell = paidEntry
        ? `<span style="background:#dcfce7;color:#166534;padding:.2rem .6rem;border-radius:99px;font-size:.8rem;font-weight:600">Paid ${_finFmtCurrency(paidEntry.gross)}</span>`
        : (isAdmin() ? `<button class="mvt-btn" style="font-size:.82rem" onclick="_finPayrollLogModal('k1',${JSON.stringify(p.name).replace(/"/g, '&quot;')},${suggested.toFixed(2)},${suggested.toFixed(2)},'${_finPayrollMonth}')">Log Distribution</button>` : '—');
      return `<tr>
        <td style="font-weight:600">${escHtml(p.name)}</td>
        <td style="color:var(--muted)">${p.pct}%</td>
        <td style="font-weight:600;color:var(--teal)">${estNet > 0 ? _finFmtCurrency(suggested) : '—'}</td>
        <td>${actionCell}</td>
        <td style="color:var(--muted);font-size:.85rem">${_finFmtCurrency(ytdPaid)} YTD</td>
      </tr>`;
    }).join('');

    k1Html = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem">
        <div style="font-weight:700;font-size:1rem;margin-bottom:1rem;color:var(--teal)">K-1 Partner Distributions</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.35rem 2rem;font-size:.88rem;margin-bottom:1rem">
          <span style="color:var(--muted)">Est. monthly revenue</span><span style="font-weight:600">${_finFmtCurrency(monthlyRevenue)}</span>
          <span style="color:var(--muted)">Est. costs (labor + chemicals)</span><span style="color:#dc2626">−${_finFmtCurrency(monthChem + monthLabor)}</span>
          <span style="border-top:1px solid var(--border);padding-top:.35rem;font-weight:600">Est. net (split pool)</span>
          <span style="border-top:1px solid var(--border);padding-top:.35rem;font-weight:700;color:${estNet > 0 ? 'var(--teal)' : '#dc2626'}">${_finFmtCurrency(estNet)}</span>
        </div>
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:1rem">⚠ Estimate from service data only. K-1 partners pay their own quarterly estimated taxes (Form 1040-ES).</div>
        <table class="adm-table" style="width:100%">
          <thead><tr><th>Partner</th><th>Share</th><th>Suggested</th><th>Action</th><th>YTD Paid</th></tr></thead>
          <tbody>${partnerRows}</tbody>
        </table>
      </div>`;
  }

  // ── IRS deposit tracker ──────────────────────────────────────────────────────
  let trackerHtml = '';
  if (data.w2) {
    const ytdEntries = data.log.filter(r => r.type === 'w2' && r.period.startsWith(String(selYear)));
    const ytdGross = ytdEntries.reduce((s, r) => s + (r.gross || 0), 0);
    const ytdNet   = ytdEntries.reduce((s, r) => s + (r.net   || 0), 0);
    const ytdWithheld = ytdGross - ytdNet;
    const ytdSS   = ytdGross * 0.062 * 2;
    const ytdMed  = ytdGross * 0.0145 * 2;
    const futaBase = Math.min(ytdGross, 7000);
    const sutaBase = Math.min(ytdGross, 9000);
    const ytdFuta = futaBase * 0.006;
    const ytdSuta = sutaBase * 0.027;
    const totalEftps = ytdWithheld + ytdSS + ytdMed;

    // Next Form 941 due date (last day of month following quarter end)
    const quarter941Dates = ['Apr 30', 'Jul 31', 'Oct 31', 'Jan 31'];
    const curQ = Math.floor((selMon - 1) / 3);
    const next941 = quarter941Dates[curQ];

    trackerHtml = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem">
        <div style="font-weight:700;font-size:1rem;margin-bottom:1rem;color:var(--teal)">IRS Tax Deposit Tracker — YTD ${selYear}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.35rem 2rem;font-size:.88rem">
          <span style="color:var(--muted)">Federal income tax withheld</span><span style="font-weight:600">${_finFmtCurrency(ytdWithheld)}</span>
          <span style="color:var(--muted)">Total SS (employee + employer)</span><span style="font-weight:600">${_finFmtCurrency(ytdSS)}</span>
          <span style="color:var(--muted)">Total Medicare (employee + employer)</span><span style="font-weight:600">${_finFmtCurrency(ytdMed)}</span>
          <span style="border-top:1px solid var(--border);padding-top:.35rem;font-weight:600">Deposit via EFTPS (Form 941)</span>
          <span style="border-top:1px solid var(--border);padding-top:.35rem;font-weight:700;color:var(--teal)">${_finFmtCurrency(totalEftps)} <span style="font-size:.8rem;color:var(--muted)">due ${next941}</span></span>
          <span style="color:var(--muted);padding-top:.5rem">FUTA owed YTD (Form 940)</span><span style="padding-top:.5rem">${_finFmtCurrency(ytdFuta)} <span style="font-size:.8rem;color:var(--muted)">(${_finFmtCurrency(futaBase)} of $7,000 wage base)</span></span>
          <span style="color:var(--muted)">SUTA TX owed YTD</span><span>${_finFmtCurrency(ytdSuta)} <span style="font-size:.8rem;color:var(--muted)">(${_finFmtCurrency(sutaBase)} of $9,000 wage base)</span></span>
        </div>
        <div style="font-size:.78rem;color:var(--muted);margin-top:.75rem">All amounts based on logged W-2 payments only. Confirm totals with your accountant before filing.</div>
      </div>`;
  }

  // ── Payment history ──────────────────────────────────────────────────────────
  const yearLog = data.log.filter(r => r.period && r.period.startsWith(String(selYear)));
  const histRows = yearLog.map(r => `
    <tr>
      <td style="color:var(--muted);font-size:.85rem">${r.timestamp ? r.timestamp.split(' ')[0] : '—'}</td>
      <td style="font-weight:600">${escHtml(r.person)}</td>
      <td><span style="background:${r.type==='w2'?'#dbeafe':'#fef9c3'};color:${r.type==='w2'?'#1d4ed8':'#854d0e'};padding:.15rem .55rem;border-radius:99px;font-size:.78rem;font-weight:600">${r.type.toUpperCase()}</span></td>
      <td style="text-align:right;font-weight:600">${_finFmtCurrency(r.gross)}</td>
      <td style="text-align:right;color:var(--muted)">${r.net && r.net !== r.gross ? _finFmtCurrency(r.net) : '—'}</td>
      <td style="color:var(--muted);font-size:.85rem">${r.period}</td>
      <td style="color:var(--muted);font-size:.82rem">${escHtml(r.note || '')}</td>
    </tr>`).join('');

  // YTD totals per person
  const allPersons = [...new Set(data.log.map(r => r.person))];
  const ytdTotals = allPersons.map(p => {
    const t = data.log.filter(r => r.person === p && r.period.startsWith(String(selYear)));
    const gross = t.reduce((s, r) => s + (r.gross || 0), 0);
    return `${escHtml(p)}: <strong>${_finFmtCurrency(gross)}</strong>`;
  }).join(' &nbsp;·&nbsp; ');

  const histHtml = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem">
      <div style="font-weight:700;font-size:1rem;margin-bottom:1rem;color:var(--teal)">${selYear} Payment History</div>
      ${yearLog.length === 0 ? `<div style="color:var(--muted);text-align:center;padding:1rem">No payments logged for ${selYear} yet.</div>` : `
      <div style="overflow-x:auto">
        <table class="adm-table" style="width:100%">
          <thead><tr><th>Date</th><th>Person</th><th>Type</th><th style="text-align:right">Gross</th><th style="text-align:right">Net</th><th>Period</th><th>Note</th></tr></thead>
          <tbody>${histRows}</tbody>
        </table>
      </div>`}
      ${allPersons.length > 0 ? `<div style="font-size:.85rem;margin-top:.75rem;color:var(--muted)">YTD ${selYear}: ${ytdTotals}</div>` : ''}
    </div>`;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1.25rem">
      <div style="display:flex;align-items:center;gap:1rem">
        <h3 style="margin:0;color:var(--teal)">Payroll</h3>
        ${nav}
      </div>
      ${isAdmin() ? `<button class="mvt-btn" onclick="_finPayrollSetupModal()">⚙ Edit Setup</button>` : ''}
    </div>
    ${w2Html}
    ${k1Html}
    ${trackerHtml}
    ${histHtml}`;
}

// ── Generic payroll modal helper ──────────────────────────────────────────────
function _prlOpenModal(title, bodyHtml) {
  _prlCloseModal();
  const el = document.createElement('div');
  el.id = 'prl-modal-backdrop';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:1rem';
  el.innerHTML = `
    <div onclick="event.stopPropagation()" style="background:var(--card);border-radius:14px;padding:1.5rem;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
        <div style="font-weight:700;font-size:1.05rem">${title}</div>
        <button onclick="_prlCloseModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--muted);line-height:1">✕</button>
      </div>
      <div id="prl-modal-body">${bodyHtml}</div>
    </div>`;
  el.addEventListener('click', _prlCloseModal);
  document.body.appendChild(el);
}

function _prlCloseModal() {
  const el = document.getElementById('prl-modal-backdrop');
  if (el) el.remove();
}

function _prlUpdatePctTotal() {
  const w2  = parseFloat(document.getElementById('prl-w2-pct')?.value)  || 0;
  const p1  = parseFloat(document.getElementById('prl-p1-pct')?.value)  || 0;
  const p2  = parseFloat(document.getElementById('prl-p2-pct')?.value)  || 0;
  const tot = w2 + p1 + p2;
  const el  = document.getElementById('prl-pct-total');
  if (el) {
    el.textContent = `Total: ${tot.toFixed(2)}%`;
    el.style.color = Math.abs(tot - 100) < 0.01 ? '#166534' : (tot > 100 ? 'var(--error)' : 'var(--muted)');
  }
}

// ── Log payment modal ─────────────────────────────────────────────────────────
function _finPayrollLogModal(type, person, grossAmount, netAmount, period) {
  const isW2 = type === 'w2';
  const gross = parseFloat(grossAmount) || 0;
  const net   = parseFloat(netAmount)   || gross;

  let withholding = '';
  if (isW2) {
    const wh = _calcW2Withholding(gross);
    withholding = `
      <div style="background:rgba(0,0,0,.04);border-radius:8px;padding:.75rem;font-size:.83rem;margin-bottom:1rem">
        <div id="prl-wh-breakdown" style="display:grid;grid-template-columns:1fr 1fr;gap:.3rem .75rem">
          <span style="color:var(--muted)">Federal income tax</span><span>−${_finFmtCurrency(wh.fed)}</span>
          <span style="color:var(--muted)">Social Security</span><span>−${_finFmtCurrency(wh.ss)}</span>
          <span style="color:var(--muted)">Medicare</span><span>−${_finFmtCurrency(wh.med)}</span>
          <span style="font-weight:600">Net take-home</span><span style="font-weight:700">${_finFmtCurrency(wh.net)}</span>
        </div>
      </div>`;
  }

  _prlOpenModal(`Log ${isW2 ? 'W-2 Payment' : 'K-1 Distribution'} — ${escHtml(person)}`, `
    <input id="prl-type"   type="hidden" value="${escHtml(type)}">
    <input id="prl-person" type="hidden" value="${escHtml(person)}">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;font-size:.9rem;margin-bottom:.75rem">
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Person</label><div style="padding:.45rem .75rem;background:rgba(0,0,0,.04);border-radius:8px;font-weight:600">${escHtml(person)}</div></div>
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Type</label><div style="padding:.45rem .75rem;background:rgba(0,0,0,.04);border-radius:8px;font-weight:600">${escHtml(type).toUpperCase()}</div></div>
    </div>
    <div style="margin-bottom:.75rem">
      <label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Period</label>
      <input id="prl-period" class="si" type="month" value="${escHtml(period)}" style="width:100%">
    </div>
    <div style="margin-bottom:.75rem">
      <label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Gross amount ($)</label>
      <input id="prl-gross" class="si" type="number" min="0" step="0.01" value="${gross.toFixed(2)}" style="width:100%" oninput="_finPayrollModalSync()">
    </div>
    ${withholding}
    ${isW2 ? `<div style="margin-bottom:.75rem">
      <label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Net amount paid to employee ($)</label>
      <input id="prl-net" class="si" type="number" min="0" step="0.01" value="${net.toFixed(2)}" style="width:100%">
    </div>` : `<input id="prl-net" type="hidden" value="${gross.toFixed(2)}">`}
    <div style="margin-bottom:1.25rem">
      <label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Note (optional)</label>
      <input id="prl-note" class="si" type="text" placeholder="e.g. Zelle, bank transfer, check #…" style="width:100%">
    </div>
    <div style="display:flex;gap:.5rem;justify-content:flex-end">
      <button class="mvt-btn" onclick="_prlCloseModal()">Cancel</button>
      <button class="adm-new-btn" style="background:var(--teal)" onclick="_finPayrollSave()">Save Payment</button>
    </div>`);
}

function _finPayrollModalSync() {
  const type = document.getElementById('prl-type')?.value;
  const grossIn = document.getElementById('prl-gross');
  const netIn = document.getElementById('prl-net');
  const whCont = document.getElementById('prl-wh-breakdown');
  
  const gross = parseFloat(grossIn?.value) || 0;
  
  if (type === 'w2') {
    const wh = _calcW2Withholding(gross);
    if (netIn) netIn.value = wh.net.toFixed(2);
    if (whCont) {
      whCont.innerHTML = `
        <span style="color:var(--muted)">Federal income tax</span><span>−${_finFmtCurrency(wh.fed)}</span>
        <span style="color:var(--muted)">Social Security</span><span>−${_finFmtCurrency(wh.ss)}</span>
        <span style="color:var(--muted)">Medicare</span><span>−${_finFmtCurrency(wh.med)}</span>
        <span style="font-weight:600">Net take-home</span><span style="font-weight:700">${_finFmtCurrency(wh.net)}</span>
      `;
    }
  } else {
    // K-1: Gross = Net
    if (netIn) netIn.value = gross.toFixed(2);
  }
}

async function _finPayrollSave() {
  const type   = document.getElementById('prl-type')?.value   || '';
  const person = document.getElementById('prl-person')?.value || '';
  const period = document.getElementById('prl-period')?.value || _finPayrollMonth;
  const gross  = parseFloat(document.getElementById('prl-gross')?.value)  || 0;
  const net    = parseFloat(document.getElementById('prl-net')?.value)    || gross;
  const note   = document.getElementById('prl-note')?.value?.trim()       || '';

  if (!gross) { alert('Amount is required.'); return; }

  const btn = document.querySelector('#prl-modal-backdrop .adm-new-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const res = await api({ action: 'log_payroll_payment', token: _s.token, type, person, period, gross_amount: gross, net_amount: net, note });
    if (!res.ok) throw new Error(res.error || 'Failed to save');
    _prlCloseModal();
    const year = period.slice(0, 4);
    const logRes = await apiGet({ action: 'get_payroll_log', token: _s.token, year });
    if (_finPayrollData) _finPayrollData.log = logRes.rows || [];
    _finPayrollMonth = period;
    _renderPayrollTab();
  } catch (e) {
    alert('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Save Payment'; }
  }
}

// ── Partner setup modal ───────────────────────────────────────────────────────
function _finPayrollSetupModal() {
  const existing = _finPayrollData || { w2: null, partners: [] };
  const w2 = existing.w2 || {};
  const p1 = existing.partners[0] || {};
  const p2 = existing.partners[1] || {};

  _prlOpenModal('Payroll Setup', `
    <div style="font-size:.82rem;color:var(--muted);margin-bottom:1rem">All three ownership percentages must sum to 100. The W-2 owner receives their share as payroll wages (with withholding); K-1 partners receive distributions.</div>
    <div style="font-weight:600;margin-bottom:.5rem;font-size:.9rem">W-2 Owner (F-1 OPT)</div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:.5rem;margin-bottom:1rem">
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Name</label><input id="prl-w2-name" class="si" type="text" value="${escHtml(w2.name || '')}" style="width:100%"></div>
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Ownership %</label><input id="prl-w2-pct" class="si" type="number" min="0" max="100" step="0.01" value="${w2.pct || ''}" oninput="_prlUpdatePctTotal()" style="width:100%"></div>
    </div>
    <div style="font-weight:600;margin-bottom:.5rem;font-size:.9rem">K-1 Partners</div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:.5rem;margin-bottom:.5rem">
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Partner 1 Name</label><input id="prl-p1-name" class="si" type="text" value="${escHtml(p1.name || '')}" style="width:100%"></div>
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Ownership %</label><input id="prl-p1-pct" class="si" type="number" min="0" max="100" step="0.01" value="${p1.pct || ''}" oninput="_prlUpdatePctTotal()" style="width:100%"></div>
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:.5rem;margin-bottom:.75rem">
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Partner 2 Name</label><input id="prl-p2-name" class="si" type="text" value="${escHtml(p2.name || '')}" style="width:100%"></div>
      <div><label style="display:block;font-weight:600;font-size:.875rem;margin-bottom:.4rem">Ownership %</label><input id="prl-p2-pct" class="si" type="number" min="0" max="100" step="0.01" value="${p2.pct || ''}" oninput="_prlUpdatePctTotal()" style="width:100%"></div>
    </div>
    <div id="prl-pct-total" style="font-size:.82rem;text-align:right;color:var(--muted);margin-bottom:.5rem">Total: ${((w2.pct||0)+(p1.pct||0)+(p2.pct||0)).toFixed(2)}%</div>
    <div id="prl-setup-err" style="color:var(--error);font-size:.85rem;display:none;margin-bottom:.5rem"></div>
    <div style="display:flex;gap:.5rem;justify-content:flex-end">
      <button class="mvt-btn" onclick="_prlCloseModal()">Cancel</button>
      <button class="adm-new-btn" style="background:var(--teal)" onclick="_finPayrollSetupSave()">Save Setup</button>
    </div>`);
}

async function _finPayrollSetupSave() {
  const w2Name   = document.getElementById('prl-w2-name')?.value?.trim();
  const w2Pct    = parseFloat(document.getElementById('prl-w2-pct')?.value);
  const p1Name   = document.getElementById('prl-p1-name')?.value?.trim();
  const p1Pct    = parseFloat(document.getElementById('prl-p1-pct')?.value);
  const p2Name   = document.getElementById('prl-p2-name')?.value?.trim();
  const p2Pct    = parseFloat(document.getElementById('prl-p2-pct')?.value);
  const errEl    = document.getElementById('prl-setup-err');

  const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

  if (!w2Name || isNaN(w2Pct)) { showErr('W-2 owner name and ownership % are required.'); return; }
  if (!p1Name || isNaN(p1Pct) || !p2Name || isNaN(p2Pct)) { showErr('Both partner names and percentages are required.'); return; }
  const totalPct = w2Pct + p1Pct + p2Pct;
  if (Math.abs(totalPct - 100) > 0.01) { showErr(`All percentages must sum to 100 (currently ${totalPct.toFixed(2)}%).`); return; }

  const config = {
    w2: { name: w2Name, pct: w2Pct, filing_status: 'single' },
    partners: [
      { name: p1Name, pct: p1Pct },
      { name: p2Name, pct: p2Pct },
    ],
  };

  const btn = document.querySelector('#prl-modal-backdrop .adm-new-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const res = await api({ action: 'save_payroll_config', token: _s.token, config });
    if (!res.ok) throw new Error(res.error || 'Failed to save');
    _prlCloseModal();
    if (_finPayrollData) { _finPayrollData.w2 = config.w2; _finPayrollData.partners = config.partners; }
    else _finPayrollData = { w2: config.w2, partners: config.partners, log: [] };
    _renderPayrollTab();
  } catch (e) {
    showErr('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Save Setup'; }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UNMATCHED SUBMISSIONS TAB
// ══════════════════════════════════════════════════════════════════════════════

let _unmatchedRows  = [];
let _unmatchedPools = [];

async function _loadAndRenderUnmatched() {
  const el = document.getElementById('unmatched-content');
  if (!el) return;
  el.innerHTML = '<div style="padding:2rem;text-align:center"><div class="spinner"></div></div>';

  try {
    const [umRes, poolsRes] = await Promise.all([
      apiGet({ action: 'get_unmatched_submissions', token: _s.token }),
      apiGet({ action: 'get_pools_for_matching',    token: _s.token })
    ]);

    _unmatchedRows  = (umRes.ok  && umRes.rows)  ? umRes.rows  : [];
    _unmatchedPools = (poolsRes.ok && poolsRes.pools) ? poolsRes.pools : [];
  } catch(e) {
    el.innerHTML = `<p style="color:var(--error);padding:1rem">Failed to load: ${escHtml(String(e))}</p>`;
    return;
  }

  _renderUnmatchedTab();
}

function _fmtUnmatchedDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', year:'numeric' })
    + ' at ' + d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
}

function _fmtChemTags(chemsStr) {
  if (!chemsStr || chemsStr.trim() === 'none' || chemsStr.trim() === '') return '<em style="color:var(--text-muted)">none</em>';
  return chemsStr.split(',').map(c => c.trim()).filter(Boolean).map(c => {
    const parts = c.split(':');
    const name  = escHtml(parts[0].trim());
    const qty   = parts[1] ? escHtml(parts[1].trim()) : '';
    return `<span style="display:inline-block;background:var(--surface-2,#f1f5f9);border:1px solid var(--border);border-radius:12px;padding:2px 10px;font-size:0.8rem;margin:2px">${name}${qty ? ': <strong>' + qty + '</strong>' : ''}</span>`;
  }).join(' ');
}

function _renderUnmatchedTab() {
  const el = document.getElementById('unmatched-content');
  if (!el) return;

  if (!_unmatchedRows.length) {
    el.innerHTML = '<p style="padding:1.5rem;color:var(--text-muted)">No pending unmatched submissions.</p>';
    return;
  }

  const poolOpts = _unmatchedPools.map(p =>
    `<option value="${escHtml(p.poolId)}">${escHtml(p.label)}</option>`
  ).join('');

  const cards = _unmatchedRows.map(r => {
    const row       = Number(r.rowIndex || 0);
    const tech      = escHtml(r.technician       || '—');
    const visitDate = _fmtUnmatchedDate(r.timestamp);
    const flagDate  = _fmtUnmatchedDate(r.flagged_at);
    const desc      = escHtml(r.pool_description || '(none entered)');
    const notes     = escHtml(r.notes            || '—');
    const chemTags  = _fmtChemTags(r.chemicals_used || '');
    const logRow    = Number(r.log_row_index    || 0);
    const pricedRow = Number(r.priced_row_index || 0);

    return `
<div class="unmatched-card" id="unmatched-card-${row}" style="border:1px solid var(--border);border-radius:10px;margin-bottom:0.75rem;background:var(--surface);overflow:hidden">
  <div onclick="_unmatchedToggle(${row})" style="display:flex;justify-content:space-between;align-items:center;padding:0.85rem 1.1rem;cursor:pointer;gap:0.75rem;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
      <strong style="font-size:1rem">${tech}</strong>
      <span style="color:var(--text-muted);font-size:0.85rem">${visitDate}</span>
      <span style="color:var(--text-muted);font-size:0.85rem;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${desc}">${desc}</span>
    </div>
    <div style="display:flex;align-items:center;gap:0.5rem;flex-shrink:0">
      <span style="font-size:0.72rem;background:#fef3c7;color:#92400e;padding:2px 9px;border-radius:12px;font-weight:600">PENDING</span>
      <span id="unmatched-chevron-${row}" style="font-size:0.85rem;color:var(--text-muted);transition:transform 0.2s">▼</span>
    </div>
  </div>
  <div id="unmatched-detail-${row}" style="display:none;padding:0 1.1rem 1rem;border-top:1px solid var(--border)">
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.6rem;margin:0.85rem 0">
      <div><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Technician</span><div style="margin-top:2px;font-weight:600">${tech}</div></div>
      <div><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Visit Date &amp; Time</span><div style="margin-top:2px">${visitDate}</div></div>
      <div><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Flagged At</span><div style="margin-top:2px">${flagDate}</div></div>
      <div><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Pool Description</span><div style="margin-top:2px">${desc}</div></div>
      <div><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Notes</span><div style="margin-top:2px">${notes}</div></div>
      ${logRow ? `<div><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Log / Priced Rows</span><div style="margin-top:2px;font-family:monospace;font-size:0.85rem">#${logRow} / #${pricedRow || '—'}</div></div>` : ''}
    </div>
    <div style="margin-bottom:0.85rem">
      <span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">Chemicals Used</span>
      <div style="margin-top:6px">${chemTags}</div>
    </div>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;padding-top:0.5rem;border-top:1px solid var(--border)">
      <select id="unmatched-sel-${row}" style="flex:1;min-width:220px;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.95rem">
        <option value="">— Select pool to match —</option>
        ${poolOpts}
      </select>
      <button class="adm-new-btn" style="white-space:nowrap" onclick="_resolveUnmatched(${row}, this)">Resolve</button>
    </div>
    <div id="unmatched-err-${row}" style="color:var(--error);font-size:0.85rem;margin-top:0.4rem"></div>
  </div>
</div>`;
  }).join('');

  el.innerHTML = `
<div style="padding:0 0 1rem">
  <div style="display:flex;align-items:baseline;gap:0.5rem;margin-bottom:0.35rem">
    <h3 style="margin:0">Unmatched Submissions</h3>
    <span style="font-size:0.85rem;color:var(--text-muted)">${_unmatchedRows.length} pending</span>
  </div>
  <p style="margin:0 0 1rem;font-size:0.9rem;color:var(--text-muted)">Visits submitted with "Other / Pool not listed". Click a row to expand and match it to the correct pool.</p>
  ${cards}
</div>`;
}

function _unmatchedToggle(row) {
  const detail   = document.getElementById(`unmatched-detail-${row}`);
  const chevron  = document.getElementById(`unmatched-chevron-${row}`);
  if (!detail) return;
  const open = detail.style.display === 'none';
  detail.style.display  = open ? 'block' : 'none';
  if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
}

async function _resolveUnmatched(rowIndex, btn) {
  const sel = document.getElementById(`unmatched-sel-${rowIndex}`);
  const err = document.getElementById(`unmatched-err-${rowIndex}`);
  if (!sel || !sel.value) {
    if (err) err.textContent = 'Select a pool first.';
    return;
  }
  if (err) err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await api({ action: 'resolve_unmatched', token: _s.token, row_index: rowIndex, pool_id: sel.value });
    if (!res.ok) throw new Error(res.error || 'Failed');
    const card = document.getElementById(`unmatched-card-${rowIndex}`);
    if (card) {
      card.style.opacity = '0.5';
      card.innerHTML = `<div style="padding:0.5rem;color:var(--text-muted)">✓ Resolved — matched to <strong>${escHtml(sel.options[sel.selectedIndex].text)}</strong></div>`;
    }
    _unmatchedRows = _unmatchedRows.filter(r => Number(r.rowIndex) !== rowIndex);
    if (!_unmatchedRows.length) {
      setTimeout(() => _renderUnmatchedTab(), 1200);
    }
  } catch(e) {
    if (err) err.textContent = 'Error: ' + String(e.message || e);
    btn.disabled = false;
    btn.textContent = 'Resolve';
  }
}

// ── Startup Companies Tab ────────────────────────────────────────────────────

let _companiesCache = null;
let _companiesSearch = '';

async function _loadAndRenderCompaniesTab() {
  const el = document.getElementById('companies-content');
  if (!el) return;
  el.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--muted)"><div class="spinner"></div></div>';

  try {
    const res = await api({ action: 'get_startup_companies', token: _s.token });
    if (!res.ok) throw new Error(res.error || 'Failed to load companies');
    _companiesCache = res.companies || [];
  } catch(e) {
    el.innerHTML = `<div style="padding:2rem;text-align:center;color:#dc2626">Error: ${escHtml(String(e.message || e))}</div>`;
    return;
  }
  _renderCompaniesTab();
}

function _renderCompaniesTab() {
  const el = document.getElementById('companies-content');
  if (!el) return;

  const sharedFilters = document.getElementById('fin-shared-filters');
  if (sharedFilters) sharedFilters.innerHTML = '';

  const all = _companiesCache || [];
  const q = _companiesSearch.toLowerCase();
  let rows = q
    ? all.filter(c =>
        (c.company_name || '').toLowerCase().includes(q) ||
        (c.contact_name || '').toLowerCase().includes(q) ||
        (c.report_bcc_email || '').toLowerCase().includes(q)
      )
    : all;

  const activeCount = all.filter(c => String(c.active || 'TRUE').toUpperCase() !== 'FALSE').length;
  const withEmail   = all.filter(c => c.report_bcc_email && String(c.active || 'TRUE').toUpperCase() !== 'FALSE').length;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem">
      <div style="display:flex;gap:1rem;flex-wrap:wrap">
        <div class="clients-op-card clients-op-card--money" style="cursor:default;min-width:140px">
          <span>Active Companies</span><strong>${activeCount}</strong>
        </div>
        <div class="clients-op-card clients-op-card--money" style="cursor:default;min-width:140px">
          <span>With BCC Email</span><strong>${withEmail}</strong>
        </div>
      </div>
      <button class="adm-new-btn" style="background:var(--teal)" onclick="openCompanyModal()">+ Add Company</button>
    </div>
    <div style="margin-bottom:.75rem">
      <input class="si" style="max-width:320px" placeholder="Search companies…"
        value="${escHtml(_companiesSearch)}"
        oninput="_companiesSearch=this.value;_renderCompaniesTab()">
    </div>
    <div style="overflow-x:auto">
      <table class="adm-table" style="width:100%">
        <thead>
          <tr>
            <th style="padding-left:1rem">Company</th>
            <th>Contact</th>
            <th>BCC Email</th>
            <th>Phone</th>
            <th>Status</th>
            <th style="text-align:right;padding-right:1rem">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--muted)">No companies found.</td></tr>`
            : rows.map(c => {
                const isActive = String(c.active || 'TRUE').toUpperCase() !== 'FALSE';
                const statusBadge = isActive
                  ? `<span style="background:#d1fae5;color:#065f46;padding:.15rem .55rem;border-radius:99px;font-size:.78rem;font-weight:600">Active</span>`
                  : `<span style="background:#f3f4f6;color:#6b7280;padding:.15rem .55rem;border-radius:99px;font-size:.78rem;font-weight:600">Inactive</span>`;
                return `<tr>
                  <td style="padding-left:1rem;font-weight:600">${escHtml(c.company_name || '—')}<br>
                    <span style="font-size:.75rem;color:var(--muted);font-weight:400">${escHtml(c.pool_company_id || '')}</span>
                  </td>
                  <td>${escHtml(c.contact_name || '—')}</td>
                  <td style="font-size:.85rem">${c.report_bcc_email ? `<a href="mailto:${escHtml(c.report_bcc_email)}" style="color:var(--teal)">${escHtml(c.report_bcc_email)}</a>` : '<span style="color:var(--muted)">—</span>'}</td>
                  <td>${escHtml(c.phone || '—')}</td>
                  <td>${statusBadge}</td>
                  <td style="text-align:right;padding-right:1rem">
                    <button class="adm-new-btn" style="background:var(--surface);color:var(--text);border:1.5px solid var(--border);font-size:.8rem;padding:.35rem .9rem"
                      onclick='openCompanyModal(${JSON.stringify(c)})'>Edit</button>
                  </td>
                </tr>`;
              }).join('')
          }
        </tbody>
      </table>
    </div>`;
}

function openCompanyModal(company) {
  document.getElementById('co-id').value      = company ? (company.pool_company_id || '') : '';
  document.getElementById('co-name').value    = company ? (company.company_name || '') : '';
  document.getElementById('co-contact').value = company ? (company.contact_name || '') : '';
  document.getElementById('co-email').value   = company ? (company.report_bcc_email || '') : '';
  document.getElementById('co-phone').value   = company ? (company.phone || '') : '';
  document.getElementById('co-notes').value   = company ? (company.notes || '') : '';
  document.getElementById('co-modal-title').textContent = company ? 'Edit Company' : 'Add Company';
  document.getElementById('co-error').style.display = 'none';
  document.getElementById('co-error').textContent = '';

  const deactivateBtn = document.getElementById('co-deactivate-btn');
  if (company && company.pool_company_id) {
    const isActive = String(company.active || 'TRUE').toUpperCase() !== 'FALSE';
    deactivateBtn.style.display = 'inline-flex';
    deactivateBtn.textContent = isActive ? 'Deactivate' : 'Reactivate';
    deactivateBtn.dataset.active = isActive ? 'TRUE' : 'FALSE';
    deactivateBtn.dataset.id = company.pool_company_id;
  } else {
    deactivateBtn.style.display = 'none';
  }

  document.getElementById('co-modal-backdrop').classList.add('open');
  document.getElementById('co-name').focus();
}

function closeCompanyModal(event) {
  if (event && event.target !== document.getElementById('co-modal-backdrop')) return;
  document.getElementById('co-modal-backdrop').classList.remove('open');
}

async function saveCompany() {
  const errEl  = document.getElementById('co-error');
  const saveBtn = document.getElementById('co-save-btn');
  const name   = document.getElementById('co-name').value.trim();
  if (!name) {
    errEl.textContent = 'Company name is required.';
    errEl.style.display = 'block';
    document.getElementById('co-name').focus();
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  errEl.style.display = 'none';

  const company = {
    pool_company_id:  document.getElementById('co-id').value.trim() || undefined,
    company_name:     name,
    contact_name:     document.getElementById('co-contact').value.trim(),
    report_bcc_email: document.getElementById('co-email').value.trim(),
    phone:            document.getElementById('co-phone').value.trim(),
    notes:            document.getElementById('co-notes').value.trim(),
    active:           'TRUE'
  };

  try {
    const res = await api({ action: 'upsert_startup_company', token: _s.token, company });
    if (!res.ok) throw new Error(res.error || 'Save failed');
    document.getElementById('co-modal-backdrop').classList.remove('open');
    _companiesCache = null;
    await _loadAndRenderCompaniesTab();
  } catch(e) {
    errEl.textContent = String(e.message || e);
    errEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function deactivateCompany() {
  const btn = document.getElementById('co-deactivate-btn');
  const id  = btn.dataset.id;
  const currentlyActive = btn.dataset.active === 'TRUE';
  const newActive = currentlyActive ? 'FALSE' : 'TRUE';
  const label = currentlyActive ? 'Deactivating…' : 'Reactivating…';
  const confirm_msg = currentlyActive
    ? 'Deactivate this company? They will no longer receive BCC emails for new service reports.'
    : 'Reactivate this company?';

  if (!confirm(confirm_msg)) return;

  btn.disabled = true;
  btn.textContent = label;

  const existing = (_companiesCache || []).find(c => c.pool_company_id === id) || {};
  try {
    const res = await api({ action: 'upsert_startup_company', token: _s.token, company: { ...existing, active: newActive } });
    if (!res.ok) throw new Error(res.error || 'Failed');
    document.getElementById('co-modal-backdrop').classList.remove('open');
    _companiesCache = null;
    await _loadAndRenderCompaniesTab();
  } catch(e) {
    alert('Error: ' + String(e.message || e));
    btn.disabled = false;
    btn.textContent = currentlyActive ? 'Deactivate' : 'Reactivate';
  }
}
