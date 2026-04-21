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

let _finActiveTab  = 'payouts'; // 'payouts', 'profit', 'chemicals'
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

function switchFinTab(tab) {
  _finActiveTab = tab;
  
  // Sync the hash to drive routing and sidebar state
  const newHash = `financial_hub/${tab}`;
  if (location.hash !== `#` + newHash) {
    location.hash = newHash;
  }

  // Toggle view visibility
  ['payouts', 'profit', 'chemicals'].forEach(t => {
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

  ['payouts', 'profit', 'chemicals'].forEach(t => {
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
  } else {
    if (loading) loading.style.display = 'block';
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
    }
  } catch(e) {
    console.error('Financial Hub load error:', e);
    if (!cachedVisits || !cachedCrm) {
      const targetId = _finActiveTab === 'payouts' ? 'fin-tbody' : (_finActiveTab === 'profit' ? 'profit-tbody' : 'chem-tbody');
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
      <label style="font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)">Report Period</label>
      <select class="si" style="min-width:170px" onchange="
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
