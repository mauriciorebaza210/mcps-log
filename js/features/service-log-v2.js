// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG — pool visit logging, chemical math, photo uploads, drafts
// Depends on: constants.js (SEC), api.js (api, apiGet)
// Uses globals: _s, _curPage
// ══════════════════════════════════════════════════════════════════════════════
// SERVICE LOG
// ══════════════════════════════════════════════════════════════════════════════
const TF={FC:"Free Chlorine (FC)",PH:"pH",TA:"Total Alkalinity (TA)",CH:"Calcium Hardness (CH)"};
// Extra (non-mandatory) water-test fields that should use a numeric input but are
// NOT part of the chemical-dosing recommendation engine.
const TF_EXTRA=["Cyanuric Acid (CYA)","Salt Level"];
const SG={small:12000,medium:17500,large:25000};
const SM=[6,7,8,9];

let _svcContextReqId = 0;

// ── Static form schema — edit this array to change the form ──────────────────
// Cards are created per PAGE_BREAK. First card is always "Visit Details".
// The PAGE_BREAK titled "Used" also gets the rec box (Mr. Chuy Recommends).
// To add a chemical: append a TEXT entry after the "Used" PAGE_BREAK.
// To reorder fields: move the object. IDs are just for reference.
const FORM_SCHEMA = [
  // ── Visit Details ─────────────────────────────────────────────────────────
  { id:1,  title:'pool_id',                          type:'LIST',           isRequired:false, helpText:'',                                                                              choices:['Bullock - Weekly Full Service - 24102 Shelton Spring - MCPS-0017','Casarez - Weekly Full Service - 25 Inwood Ridge Drive - MCPS-0020','Chapa - Green-to-Clean Cleaning Service - 1090 North Trail - MCPS-0026','Libby - Weekly Full Service - 27121 Highland Crest - MCPS-0007','Lopez - Monthly Full Service - 307 Parkside Dr - MCPS-0021','Mendoza - Weekly Full Service - 22088 Mathis Rd - MCPS-0012','Menezes - Weekly Full Service - 4202 Coriander - MCPS-0026','Moczygemba - Weekly Full Service - 108 Elk Run - MCPS-0023','Murray - Weekly Full Service - 452 CR 257 - MCPS-0025','Pompa - Weekly Full Service - 18538 Shadow Canyon Dr - MCPS-0001','Robbins - Weekly Full Service - 2144 County Road 419 - MCPS-0018','Saldaña - Weekly Full Service - 306 Sligo St - MCPS-0024','Startz - Green-to-Clean Cleaning Service - 3431 County Rd 136 - MCPS-0019','Valdez - Weekly Full Service - 13355 Leeward Lane - MCPS-0009','Other / Pool not listed'] },
  // renderSvcForm injects Pool Size, Pool Material, Condition on Arrival, Internal Notes after pool_id
  { id:2,  title:'Pool description (if Other selected)', type:'TEXT',       isRequired:false, helpText:"Only fill this in if you selected 'Other / Pool not listed' above. Enter client name, address, or any info to identify the pool." },
  { id:3,  title:'Technician',                       type:'LIST',           isRequired:false, helpText:'',                                                                              choices:['Mauricio Rebaza','Tony Siller','Chuy Silva','Ryan Willford'] },
  { id:4,  title:'Notes',                            type:'PARAGRAPH_TEXT', isRequired:false, helpText:''                                                                              },
  // ── Initial Inspection (Step 2) ───────────────────────────────────────────
  { id:4.1,title:'Water Color',  type:'LIST', isRequired:false, helpText:'Overall water clarity on arrival.',
    choices:['Clear','Slightly Cloudy','Cloudy','Green','Black / Swamp'] },
  { id:4.2,title:'Debris',       type:'LIST', isRequired:false, helpText:'Amount of leaves/debris in the pool.',
    choices:['None','Light','Moderate','Heavy'] },
  { id:4.3,title:'Water Level',  type:'LIST', isRequired:false, helpText:'Water line relative to the skimmer.',
    choices:['Low','Normal','High'] },
  { id:4.4,title:'Algae',        type:'LIST', isRequired:false, helpText:'Visible algae present.',
    choices:['None','Slight','Moderate','Severe'] },
  // Inspection checklist areas (Step 2) — collapsible rows, optional statuses
  { id:4.6,title:'Skimmers and Returns', type:'LIST', isRequired:false, helpText:'', choices:['Good','Monitor','Issue'] },
  { id:4.7,title:'Visible Leaks',        type:'LIST', isRequired:false, helpText:'', choices:['None observed','Minor','Active leak'] },
  { id:4.8,title:'Deck and Surrounding', type:'LIST', isRequired:false, helpText:'', choices:['Good','Monitor','Issue'] },
  { id:4.85,title:'Inspection Checklist', type:'CHECKBOX', isRequired:false, helpText:'',
    choices:['Skimmers & returns','Visible leaks','Deck & surrounding area'] },
  // Equipment quick look (Step 2)
  { id:4.91,title:'Pump Status',    type:'LIST', isRequired:false, helpText:'', choices:['Running','Not running','Needs review'] },
  { id:4.92,title:'Filter Status',  type:'LIST', isRequired:false, helpText:'', choices:['Normal pressure','High pressure','Needs review'] },
  { id:4.93,title:'Cleaner Status', type:'LIST', isRequired:false, helpText:'', choices:['Operating','Needs review','Not present'] },
  // ── Test Results ──────────────────────────────────────────────────────────
  { id:5,  title:'Test Results',                     type:'PAGE_BREAK',     isSectionBreak:true                                                                                        },
  { id:6,  title:'Free Chlorine (FC)',               type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:7,  title:'pH',                               type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:8,  title:'Total Alkalinity (TA)',            type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:9,  title:'Calcium Hardness (CH)',            type:'TEXT',           isRequired:false, helpText:''                                                                              },
  { id:9.1,title:'Cyanuric Acid (CYA)',              type:'TEXT',           isRequired:false, helpText:''                          },
  { id:9.2,title:'Salt Level',                       type:'TEXT',           isRequired:false, helpText:''                          },
  // renderSvcForm injects Tablet Level pills after Salt Level (last field in Test Results)
  // ── Used ──────────────────────────────────────────────────────────────────
  { id:11, title:'Used',                             type:'PAGE_BREAK',     isSectionBreak:true                                                                                        },
  { id:11.5,title:'Soda Ash',                        type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:12, title:'Liquid Chlorine',                  type:'TEXT',           isRequired:false, helpText:'Enter gallons used (leave blank if none).'                                     },
  { id:13, title:'Muriatic Acid',                    type:'TEXT',           isRequired:false, helpText:'Enter gallons used (leave blank if none).'                                     },
  { id:14, title:'Alkalinity Increaser',             type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:15, title:'Calcium Hardness Increaser',       type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:16, title:'Chlorine Tablets (3")',            type:'TEXT',           isRequired:false, helpText:'Enter tablets used (leave blank if none).'                                    },
  { id:17, title:'Startup-Tec',                      type:'TEXT',           isRequired:false, helpText:'Enter bottles used (leave blank if none).'                                    },
  { id:18, title:'ScaleTec (Calcium Remover)',       type:'TEXT',           isRequired:false, helpText:'Enter bottles used (leave blank if none).'                                    },
  { id:19, title:'Algaecide',                        type:'TEXT',           isRequired:false, helpText:'Enter bottles used (leave blank if none).'                                    },
  { id:20, title:'Cyanuric Acid (Stabilizer)',       type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:21, title:'Diatomaceous Earth (DE)',          type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:22, title:'Salt',                             type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  { id:23, title:'Cal Hypo',                         type:'TEXT',           isRequired:false, helpText:'Enter lbs used (leave blank if none).'                                        },
  // ── Actions ───────────────────────────────────────────────────────────────
  { id:24, title:'Actions',                          type:'PAGE_BREAK',     isSectionBreak:true                                                                                        },
  { id:25, title:'Technician Actions',               type:'CHECKBOX',       isRequired:false, helpText:'Check the tasks you performed on this visit.',
    choices:['Netted','Vacuumed','Brushed','Backwashed','Cleaned pump basket','Cleaned skimmer basket','Cleaned cartridges','Cleaned automatic cleaner','Cleaned deck/coping'] },
  // ── Equipment Verification (Step 6) ───────────────────────────────────────
  { id:26, title:'Equipment Verification',           type:'CHECKBOX',       isRequired:false, helpText:'Confirm equipment is running before you leave.',
    choices:['Pump operating properly','Filter pressure normal','Cleaner operating','All systems functional'] },
];
// Field titles that belong to the "Initial Inspection" step (kept out of the
// chemical-fields slice above so they are collected but never priced).
const SVC_INSPECT_FIELDS = ['Water Color','Debris','Water Level','Algae'];
const SVC_CHEMICAL_FIELDS = FORM_SCHEMA.slice(
  FORM_SCHEMA.findIndex(i => i.isSectionBreak && String(i.title || '').trim().toLowerCase() === 'used') + 1,
  FORM_SCHEMA.findIndex(i => i.isSectionBreak && String(i.title || '').trim().toLowerCase() === 'actions')
).filter(i => i && i.type === 'TEXT' && i.title).map(i => i.title);

const SVC_PHOTO_SLOTS = [
  { id:'before',     label:'Before',     hint:'Upon arrival', fileName:'before-upon-arrival.jpg', required:true  },
  { id:'inspection', label:'Inspection', hint:'Condition / issue area', fileName:'inspection.jpg', required:false },
  { id:'after',      label:'After',      hint:'Pool after service', fileName:'after-pool.jpg', required:true  },
  { id:'equipment',  label:'Equipment',  hint:'Pump, filter, heater, or issue area', fileName:'equipment.jpg', required:true  },
  { id:'other',      label:'Other',      hint:'Extra / optional', fileName:'other-extra.jpg', required:false }
];

// Build a querySelector for a [name="…"] attribute. Inputs are rendered with the title
// HTML-encoded (`&quot;`), which the browser DECODES — so the live attribute holds a real
// quote (e.g. Chlorine Tablets (3")). When reading the value back we must CSS-escape the
// quote, NOT re-encode it as &quot; (CSS does not decode HTML entities, so &quot; silently
// matches nothing). That mismatch is why the only quote-bearing field — Chlorine Tablets (3")
// — was never collected, logged, or emailed.
function svcNameSel_(title){
  return '[name="' + String(title).replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"]';
}

function loadServiceLog(prefillPoolId){
  window._lastLoadedPoolId = null;
  window._svcLoadCounter = (window._svcLoadCounter||0) + 1;
  const thisRequest = window._svcLoadCounter;

  // Render immediately from the static schema. No Portal_Schema dependency.
  renderSvcForm(FORM_SCHEMA, prefillPoolId);
  document.getElementById('svc-loading').style.display = 'none';
  document.getElementById('svc-root').style.display = 'block';

  // Show recovery banner if there's an unsent log from a previous session
  const _queued = localStorage.getItem('svc_queued_submit');
  if (_queued) {
    try {
      const _q = JSON.parse(_queued);
      const _pk = _q.payload && Object.keys(_q.payload).find(k => k.trim().toLowerCase() === 'pool_id');
      const _pl = _pk ? _q.payload[_pk] : 'Unknown pool';
      const _age = _q.ts ? Math.round((Date.now() - _q.ts) / 60000) : 0;
      setTimeout(() => {
        const root = document.getElementById('svc-root');
        if (!root) return;
        const b = document.createElement('div');
        b.id = 'svc-retry-banner';
        b.className = 'svc-retry-banner';
        b.innerHTML = '<div class="svc-retry-msg">⚠️ Unsent log for <strong>' + escHtml(_pl) + '</strong> (' + _age + 'm ago)</div><button class="svc-retry-btn" onclick="_retrySvcNow_()">Send Now</button>';
        root.insertBefore(b, root.firstChild);
      }, 100);
    } catch(e) {}
  }

  // Live pool list — populates the pool_id dropdown when it arrives. Falls back to
  // the static schema list only if the live fetch fails (offline / error).
  api({ secret:SEC, action:'get_pool_list', token:_s.token }).then(res => {
    if (thisRequest !== window._svcLoadCounter) return;
    if (res && res.ok && res.pools && res.pools.length) _applyLivePoolList_(res.pools, prefillPoolId);
    else _applyStaticPoolFallback_(prefillPoolId);
  }).catch(() => { if (thisRequest === window._svcLoadCounter) _applyStaticPoolFallback_(prefillPoolId); });
  // Prefill context/identity is driven by the injected-option change event in
  // renderSvcForm() → handlePoolChange() → loadPoolContextForSelection_() (which
  // also owns the loading spinner), so no separate get_pool_context call here.
}

// Offline / error fallback: populate the pool dropdown from the static schema list.
function _applyStaticPoolFallback_(prefillPoolId){
  const sel = document.querySelector('[name="pool_id"]');
  if (!sel) return;
  // Only fall back if the live list never populated (still just the placeholder).
  if (sel.options.length > 2) return;
  const poolItem = FORM_SCHEMA.find(i => String(i.title || '').toLowerCase() === 'pool_id');
  const choices = (poolItem && poolItem.choices) ? poolItem.choices : [];
  if (choices.length) _applyLivePoolList_(choices, prefillPoolId);
}

// Replace the pool_id select with live data and re-apply any prefill match
function _applyLivePoolList_(pools, prefillPoolId) {
  const sel = document.querySelector('[name="pool_id"]');
  if (!sel) return;
  const normalize = v => (typeof v === 'string' ? v : (v.label || v.id || String(v)));
  sel.innerHTML = '<option value="">Select...</option>' +
    pools.map(p => {
      const raw = normalize(p);
      const v = escHtml(raw);                           // full label stays the submitted value
      const text = escHtml(_poolClientName_(raw));      // client name shown to the tech
      return `<option value="${v}">${text}</option>`;
    }).join('');
  if (!prefillPoolId) return;
  // Re-apply prefill match (same logic as renderSvcForm)
  const mcpsId = prefillPoolId.match(/(MCPS-\d{4,})\s*$/i);
  let matched = false;
  for (let i = 0; i < sel.options.length; i++) {
    const opt = sel.options[i].value;
    if (opt === prefillPoolId || (mcpsId && opt.toUpperCase().includes(mcpsId[1].toUpperCase()))) {
      sel.selectedIndex = i;
      matched = true;
      break;
    }
  }
  // Live list didn't include the scheduled pool — inject it so the selection holds.
  if (!matched) {
    const o = document.createElement('option');
    o.value = prefillPoolId;
    o.textContent = _poolClientName_(prefillPoolId);
    sel.appendChild(o);
    sel.value = prefillPoolId;
  }
  sel.dispatchEvent(new Event('change'));
  // Launched from a specific scheduled job — lock the pool + show the identity
  // banner so the tech can't silently log the wrong customer.
  updateSvcIdentityBanner_(sel.value, true);
}

// ── Wizard step definitions ───────────────────────────────────────────────────
const SVC_STEPS = [
  { id:'arrive',   n:1, title:'Arrive'   },
  { id:'inspect',  n:2, title:'Inspect'  },
  { id:'test',     n:3, title:'Test'     },
  { id:'service',  n:4, title:'Service'  },
  { id:'treat',    n:5, title:'Treat'    },
  { id:'verify',   n:6, title:'Verify'   },
  { id:'complete', n:7, title:'Complete' }
];
let _svcStep = 0;

// ── Reading health bands — IDEAL ranges per the Taylor pool & spa test manual ──
// green IDEAL / amber LOW·HIGH / red VERY HIGH. `min`/`max` = meter scale ends,
// `color` = the Taylor kit's test-section color (card identity, not health tone).
const SVC_READING_BANDS = {
  'Free Chlorine (FC)':    { low:3,    idealMax:5,                   min:0,    max:8,    unit:'ppm', color:'#C9A227' },
  'pH':                    { low:7.2,  idealMax:7.6,                 min:6.8,  max:8.4,  unit:'',    color:'#C24D6B' },
  'Total Alkalinity (TA)': { low:80,   idealMax:120,                 min:0,    max:240,  unit:'ppm', color:'#3E9E5B' },
  'Calcium Hardness (CH)': { low:200,  idealMax:400,                 min:0,    max:600,  unit:'ppm', color:'#3E7CB1' },
  'Cyanuric Acid (CYA)':   { low:30,   idealMax:80,   veryHigh:80,   min:0,    max:120,  unit:'ppm', color:'#2E9E7A', stripeColor:'#fff' },
  'Salt Level':            { low:2700, idealMax:4500, veryHigh:4500, min:1500, max:6000, unit:'ppm', color:'#3E7CB1', stripeColor:'#9edcf4' }
};
const SVC_BAND_LABEL = { low:'LOW', ideal:'IDEAL', high:'HIGH', veryhigh:'VERY HIGH' };
const SVC_READING_SHORT = { 'Free Chlorine (FC)':'FC', 'pH':'pH', 'Total Alkalinity (TA)':'TA', 'Calcium Hardness (CH)':'CH', 'Cyanuric Acid (CYA)':'CYA', 'Salt Level':'Salt' };

// Classify a reading value into a band key, or null if untested/unknown field.
function readingBand(field, val){
  const r = SVC_READING_BANDS[field];
  if(!r || val === null || val === '' || typeof val === 'undefined') return null;
  const v = parseFloat(val);
  if(isNaN(v)) return null;
  if(v < r.low) return 'low';
  if(v <= r.idealMax) return 'ideal';
  if(r.veryHigh && v > r.veryHigh) return 'veryhigh';
  return 'high';
}
// Mirror of svcNameSel_ for the band-badge lookup (CSS-escape the real quote).
function _svcBandSel_(title){
  return '[data-band-for="' + String(title).replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"]';
}
function _svcAttrEsc_(v){ return String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"'); }
function _fmtNum_(n){ return (Math.round(n * 100) / 100).toString(); }

// Position (0–100%) of a value on a reading's meter scale.
function _svcMeterPct_(r, v){ return Math.max(0, Math.min(100, ((v - r.min) / (r.max - r.min)) * 100)); }

// The LOW | IDEAL | HIGH (| VERY HIGH) gradient track + a marker for the value.
function _svcMeterHtml_(name){
  const r = SVC_READING_BANDS[name];
  const lowP = _svcMeterPct_(r, r.low), idP = _svcMeterPct_(r, r.idealMax);
  const vhP = r.veryHigh ? _svcMeterPct_(r, r.veryHigh) : 100;
  const AMBER = '#eab35a', GREEN = '#3ea36b', RED = '#e0574a';
  let grad = 'linear-gradient(90deg,' + AMBER + ' 0 ' + lowP + '%,' + GREEN + ' ' + lowP + '% ' + idP + '%,' + AMBER + ' ' + idP + '% ' + vhP + '%';
  if(r.veryHigh) grad += ',' + RED + ' ' + vhP + '% 100%';
  grad += ')';
  const te = name.replace(/"/g,'&quot;');
  return '<div class="svc-meter">'
    + '<div class="svc-meter-track" style="background:' + grad + '"></div>'
    + '<div class="svc-meter-mark" data-mark-for="' + te + '" style="display:none;left:0%"></div>'
    + '<div class="svc-meter-scale"><span>' + _fmtNum_(r.min) + '</span><span>' + _fmtNum_(r.max) + '</span></div>'
    + '</div>';
}

// One full reading card: Taylor-color identity stripe, ideal range, input,
// live status badge, and the range meter.
function _svcReadingCard_(meta, name){
  const item = meta.find(m => m.title === name);
  if(!item) return '';
  const r = SVC_READING_BANDS[name];
  const te = name.replace(/"/g,'&quot;');
  const displayName = name === 'Salt Level' ? 'Salt' : name;
  const isMandatory = (name === 'pH' || name === 'Free Chlorine (FC)' || name === 'Total Alkalinity (TA)');
  const star = isMandatory ? " <span style='color:red'>*</span>" : '';
  const unit = r.unit ? ' ' + r.unit : '';
  const ideal = 'Ideal ' + _fmtNum_(r.low) + '–' + _fmtNum_(r.idealMax) + unit;
  const help = item.helpText ? '<span class="sh">' + item.helpText + '</span>' : '';
  return '<div class="svc-rc" style="--rc:' + r.color + ';--rc-stripe:' + (r.stripeColor || r.color) + '">'
    + '<div class="svc-rc-head"><span class="svc-rc-name">' + displayName + star + '</span><span class="svc-rc-ideal">' + ideal + '</span></div>'
    + help
    + '<div class="svc-rc-row"><input class="si" type="number" step="any" name="' + te + '"' + (item.isRequired ? ' required' : '') + ' oninput="runRecs()" placeholder="—"><span class="reading-band" data-band-for="' + te + '"></span></div>'
    + _svcMeterHtml_(name)
    + '</div>';
}
function _chemBadgeHtml_(name){ return (typeof chemBadge === 'function') ? chemBadge(name) : ''; }
function _svcChemSortValue_(name){
  const entry = (typeof chemLookup === 'function') ? chemLookup(name) : null;
  return entry && entry.num ? parseInt(entry.num, 10) : 999;
}
function _svcSortedChemFields_(fields){
  return fields.slice().sort((a, b) => {
    const na = _svcChemSortValue_(a), nb = _svcChemSortValue_(b);
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

function _svcTabletOptionHtml_(level, label, meta, count){
  const isNone = level === 'none';
  const tabs = Array.from({ length: 6 }, (_, i) => {
    const y = 70 - (i * 7);
    const active = !isNone && i < count;
    return '<ellipse class="tablet-disc' + (active ? ' filled' : '') + '" cx="34" cy="' + y + '" rx="16" ry="4"></ellipse>';
  }).join('');
  const xMark = isNone
    ? '<path class="tablet-x" d="M19 27 L72 80 M72 27 L19 80"></path>'
    : '';
  return '<button type="button" class="tbpill tablet-option" onclick="tTablet(this,\'' + level + '\')" data-val="' + level + '" aria-pressed="false" aria-label="' + label + ', ' + meta + '">'
    + '<span class="tablet-graphic' + (isNone ? ' no-chlorinator' : '') + '" aria-hidden="true">'
    + '<svg viewBox="0 0 92 96" focusable="false">'
    + '<path class="chlor-body" d="M25 15 h18 a8 8 0 0 1 8 8 v48 a10 10 0 0 1-10 10 H27 a10 10 0 0 1-10-10 V23 a8 8 0 0 1 8-8 Z"></path>'
    + '<path class="chlor-cap" d="M22 12 h24 v8 H22z M20 76 h28 v9 H20z"></path>'
    + '<path class="chlor-port" d="M50 54 h16 v8 H50z"></path>'
    + '<path class="chlor-valve" d="M63 45 h18 v25 H63z"></path>'
    + '<path class="chlor-hose" d="M71 68 C74 84 56 88 42 84"></path>'
    + tabs
    + xMark
    + '</svg>'
    + '</span>'
    + '<span class="tablet-option-name">' + label + '</span>'
    + '<span class="tablet-option-meta">' + meta + '</span>'
    + '</button>';
}

function _svcActionIconSvg_(action){
  const key = String(action || '').toLowerCase();
  if (key.includes('net')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l8-8"></path><path d="M11 4l9 9-6 6-9-9z"></path><path d="M13 6l-6 6M16 9l-6 6M19 12l-6 6"></path></svg>';
  if (key.includes('vacuum')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15c0-3.3 2.7-6 6-6h2"></path><path d="M15 9V5h4v8h-4z"></path><path d="M6 15h6a4 4 0 0 1 4 4v1"></path><circle cx="6" cy="18" r="3"></circle><circle cx="14" cy="20" r="2"></circle></svg>';
  if (key.includes('brush')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l11-11"></path><path d="M14 6l4 4"></path><path d="M16 4l4 4"></path><path d="M7 17l3 3M10 14l3 3"></path></svg>';
  if (key.includes('backwash') || key.includes('filter') || key.includes('cartridge')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v14H7z"></path><path d="M9 4h6l1 3H8z"></path><path d="M10 10v8M14 10v8"></path><path d="M5 13h14"></path></svg>';
  if (key.includes('basket')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7z"></path><path d="M9 8a3 3 0 0 1 6 0"></path><path d="M9 11v6M12 11v6M15 11v6"></path></svg>';
  if (key.includes('automatic cleaner')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15c2-4 5-6 9-6h3"></path><path d="M14 9l4-4 2 2-3 5"></path><circle cx="7" cy="17" r="3"></circle><circle cx="15" cy="17" r="3"></circle></svg>';
  if (key.includes('deck') || key.includes('coping')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16"></path><path d="M5 14h14"></path><path d="M7 19h10"></path><path d="M8 5h8"></path></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l2 2 4-5"></path><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>';
}
function _svcTechnicianActionsHtml_(meta){
  const item = meta.find(m => m.title === 'Technician Actions');
  if(!item) return '';
  const name = item.title.replace(/"/g,'&quot;');
  const rows = item.choices.map(action => {
    const val = action.replace(/"/g,'&quot;');
    return '<label class="svc-action-row">'
      + '<input type="checkbox" name="' + name + '" value="' + val + '" onchange="runRecs()">'
      + '<span class="svc-action-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"></path></svg></span>'
      + '<span class="svc-action-icon">' + _svcActionIconSvg_(action) + '</span>'
      + '<span class="svc-action-name">' + action + '</span>'
      + '</label>';
  }).join('');
  return '<div class="svc-action-list">' + rows + '</div>';
}

// Client name for display only — the option VALUE stays the full "… - MCPS-XXXX"
// label so submit_form and the backend's extractPoolId_ keep working unchanged.
function _poolClientName_(label){
  const p = (typeof _parsePoolLabel_ === 'function') ? _parsePoolLabel_(label) : null;
  return (p && p.name) ? p.name : String(label || '');
}

// ── Single field group renderer (reused across steps) ─────────────────────────
function _svcField(meta, title){
  const item = meta.find(m => m.title === title);
  if(!item) return '';
  const te = item.title.replace(/"/g,'&quot;');
  const isPoolId = te.toLowerCase() === 'pool_id';
  const displayTitle = isPoolId ? 'Client' : item.title;   // shown to the tech; the field key stays pool_id
  const isHardMandatory = (isPoolId || te === 'pH' || te === 'Free Chlorine (FC)' || te === 'Total Alkalinity (TA)');
  const isSoftOptional  = (te === 'Calcium Hardness (CH)');
  const lbl = displayTitle + ((isHardMandatory || (item.isRequired && !isSoftOptional)) ? " <span style='color:red'>*</span>" : '');
  let tour = '';
  if(isPoolId) tour = ' data-tour="svc-pool-select"';
  else if(item.title === 'Notes')    tour = ' data-tour="svc-notes"';
  const band = SVC_READING_BANDS.hasOwnProperty(item.title)
    ? ' <span class="reading-band" data-band-for="'+te+'"></span>' : '';
  let inp = '';
  if(item.type === 'LIST' || item.type === 'MULTIPLE_CHOICE'){
    if(isPoolId){
      // Start with a loading placeholder instead of the small static list, so the
      // tech never sees a misleadingly short roster. loadServiceLog() fills it from
      // get_pool_list (live clients) and only falls back to the static list on error.
      inp = '<select class="si" name="'+te+'" onchange="handlePoolChange()"><option value="">Loading clients…</option></select>';
    } else {
      inp = '<select class="si" name="'+te+'" '+(item.isRequired?'required':'')+' onchange="runRecs()"><option value="">Select...</option>'+item.choices.map(c=>'<option value="'+c.replace(/"/g,'&quot;')+'">'+c+'</option>').join('')+'</select>';
    }
  } else if(item.type === 'CHECKBOX'){
    inp = '<div class="scb-grid">'+item.choices.map(c=>'<label class="scb"><input type="checkbox" name="'+te+'" value="'+c.replace(/"/g,'&quot;')+'" onchange="runRecs()"><span>'+c+'</span></label>').join('')+'</div>';
  } else if(item.type === 'PARAGRAPH_TEXT'){
    inp = '<textarea class="si" name="'+te+'" '+(item.isRequired?'required':'')+' oninput="runRecs()"></textarea>';
  } else {
    const isNum = Object.values(TF).indexOf(item.title) !== -1 || TF_EXTRA.indexOf(item.title) !== -1 || (item.helpText && item.helpText.toLowerCase().indexOf('quantity') !== -1);
    inp = '<input class="si" type="'+(isNum?'number':'text')+'" step="any" name="'+te+'" '+(item.isRequired?'required':'')+' oninput="runRecs()">';
  }
  return '<div class="sfg"'+tour+'><label>'+lbl+band+'</label>'+(item.helpText?'<span class="sh">'+item.helpText+'</span>':'')+inp+'</div>';
}

// One photo slot (the whole photo engine is unchanged — slots just live in steps).
function _svcPhotoSlotHtml(slotId){
  const slot = SVC_PHOTO_SLOTS.find(s => s.id === slotId);
  if(!slot) return '';
  const cameraIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5h6l1.4 2H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3.6L9 4.5Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  return `
    <div class="svc-photo-slot" id="svc-photo-slot-${slot.id}" data-slot="${slot.id}">
      <div class="svc-photo-slot-head">
        <div>
          <div class="svc-photo-slot-title">${escHtml(slot.label)}</div>
          <div class="svc-photo-slot-hint">${escHtml(slot.hint)}</div>
        </div>
        <span class="svc-photo-slot-req ${slot.required ? 'required' : 'optional'}">${slot.required ? 'Required' : 'Optional'}</span>
      </div>
      <div class="svc-photo-empty">
        <div class="pu-icon">${cameraIcon}</div>
        <div class="svc-photo-actions">
          <button type="button" class="svc-photo-action primary" onclick="triggerSvcPhotoInput_('${slot.id}','camera')">Take Photo</button>
          <button type="button" class="svc-photo-action" onclick="triggerSvcPhotoInput_('${slot.id}','library')">Choose Photo</button>
        </div>
        <div class="pu-sub">JPEG · PNG · large photos compressed</div>
      </div>
      <div class="svc-photo-filled" style="display:none"></div>
      <input type="file" id="svc-photo-${slot.id}-camera" accept="image/*" capture="environment" onchange="handlePhotoSlotSelect(this,'${slot.id}')" hidden>
      <input type="file" id="svc-photo-${slot.id}-library" accept="image/*" onchange="handlePhotoSlotSelect(this,'${slot.id}')" hidden>
    </div>`;
}

// Inner HTML for a given step. Every input for every step is mounted at once so
// submitSvc()/saveDraft() still collect the whole form from the live DOM.
function _svcStepInner(id, meta){
  const F = t => _svcField(meta, t);
  if(id === 'arrive'){
    return `
      <div class="svc-card">
        <div class="svc-stitle" tabindex="-1">Arrive</div>
        <div id="svc-arrive-identity"></div>
        ${F('pool_id')}
        <div id="svc-pool-desc-wrap" style="display:none">${F('Pool description (if Other selected)')}</div>
        <div class="svc-pool-meta">
          <div class="sfg"><label>Pool Size</label><span class="sh">Used for chemical dosing calculations.</span><select class="si" id="svc-size" onchange="runRecs()"><option value="small">Small (&lt;15k gal)</option><option value="medium">Medium (15k–20k gal)</option><option value="large">Large (20k+ gal)</option></select></div>
          <div class="sfg"><label>Pool Material</label><span class="sh">Affects acid dose — fiberglass gets reduced amount.</span><select class="si" id="svc-mat" onchange="runRecs()"><option value="plaster">Plaster</option><option value="fiberglass">Fiberglass</option><option value="vinyl">Vinyl</option></select></div>
        </div>
        <div id="svc-arrive-context"></div>
        ${F('Technician')}
        <button type="button" class="svc-info-btn" onclick="svcShowPoolInfo_()"><span aria-hidden="true">ⓘ</span> View pool info</button>
        <button type="button" id="svc-start-btn" class="svc-start-btn" onclick="svcStartService_(this)">Start Service</button>
      </div>
      <div class="svc-card">
        <div class="svc-stitle">Arrival Photo</div>
        <div class="svc-photo-slot-grid">${_svcPhotoSlotHtml('before')}</div>
      </div>`;
  }
  if(id === 'inspect'){
    const ic = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>';
    const IC = {
      water:   ic('<path d="M12 3c3 3.6 5 6.6 5 9a5 5 0 0 1-10 0c0-2.4 2-5.4 5-9z"/>'),
      debris:  ic('<path d="M5 18c0-7 5-11 14-11 0 8-4 13-11 13a5 5 0 0 1-3-2z"/><path d="M8.5 15c2-2 4.5-3.2 7.5-4"/>'),
      level:   ic('<path d="M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>'),
      algae:   ic('<path d="M12 21v-8"/><path d="M12 13c0-3-2-5-6-5 0 3 2 5 6 5z"/><path d="M12 15c0-3 2-5 6-5 0 3-2 5-6 5z"/>'),
      struct:  ic('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 12c1.6-1.6 3.4-1.6 5 0s3.4 1.6 5 0 3.4-1.6 5 0"/>'),
      skim:    ic('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
      leak:    ic('<path d="M4 7h16"/><path d="M8 7v3M16 7v3"/><path d="M12 12c1.4 1.7 2.3 3 2.3 4a2.3 2.3 0 0 1-4.6 0c0-1 .9-2.3 2.3-4z"/>'),
      deck:    ic('<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 12h18M12 3v18"/>'),
      pump:    ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.6"/><path d="M12 12l4.5-1.5M12 12l-3.2 3.4M12 12l-1.3-4.6"/>'),
      filter:  ic('<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>'),
      cleaner: ic('<rect x="4" y="10" width="16" height="8" rx="2"/><path d="M8 10V8a4 4 0 0 1 8 0v2"/><circle cx="9" cy="18.5" r="1"/><circle cx="15" cy="18.5" r="1"/>'),
      equip:   ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>')
    };
    const chOf = t => { const it = meta.find(m => m.title === t); return (it && it.choices) ? it.choices : []; };
    const opts = (name, choices, onchange) => {
      const te = name.replace(/"/g,'&quot;');
      return '<select class="si" name="'+te+'"'+(onchange?' onchange="'+onchange+'"':'')+'><option value="">—</option>'+choices.map(c=>'<option value="'+c.replace(/"/g,'&quot;')+'">'+c+'</option>').join('')+'</select>';
    };
    const cell = (icon, label, name) => '<div class="svc-insp-cell"><span class="svc-insp-ic">'+icon+'</span><div class="svc-insp-fld"><label>'+label+'</label>'+opts(name, chOf(name), 'runRecs()')+'</div></div>';
    const grid = '<div class="svc-insp-grid">'+cell(IC.water,'Water','Water Color')+cell(IC.debris,'Debris','Debris')+cell(IC.level,'Water Level','Water Level')+cell(IC.algae,'Algae','Algae')+'</div>';

    const areas = [
      { icon:IC.skim,   title:'Skimmers &amp; returns',       name:'Skimmers and Returns' },
      { icon:IC.leak,   title:'Visible leaks',                name:'Visible Leaks' },
      { icon:IC.deck,   title:'Deck &amp; surrounding area',  name:'Deck and Surrounding' }
    ];
    const checklist = areas.map(a => {
      const nt = a.name.replace(/"/g,'&quot;');
      return '<div class="svc-insp-item">'
        + '<div class="svc-insp-head">'
        +   '<label class="svc-insp-chk"><input type="checkbox" name="Inspection Checklist" value="'+a.title.replace(/"/g,'&quot;')+'" onchange="runRecs()"><span aria-hidden="true"></span></label>'
        +   '<span class="svc-insp-ic sm">'+a.icon+'</span>'
        +   '<span class="svc-insp-title">'+a.title+'<span class="svc-insp-sub" data-sub-for="'+nt+'"></span></span>'
        +   '<button type="button" class="svc-insp-chev" onclick="svcToggleInsp_(this)" aria-expanded="false" aria-label="Toggle detail">⌄</button>'
        + '</div>'
        + '<div class="svc-insp-body"><label class="svc-insp-blabel">Condition</label>'+opts(a.name, chOf(a.name), 'svcInspStatus_(this)')+'</div>'
        + '</div>';
    }).join('');

    const eq = [
      { icon:IC.pump,    name:'Pump Status',    label:'Pump' },
      { icon:IC.filter,  name:'Filter Status',  label:'Filter' },
      { icon:IC.cleaner, name:'Cleaner Status', label:'Cleaner' }
    ];
    const equip = eq.map(e => {
      const nt = e.name.replace(/"/g,'&quot;');
      return '<div class="svc-eq-row"><span class="svc-insp-ic sm">'+e.icon+'</span><span class="svc-eq-name">'+e.label+'</span><span class="svc-eq-dot" data-dot-for="'+nt+'"></span>'+opts(e.name, chOf(e.name), 'svcInspStatus_(this)')+'</div>';
    }).join('');

    return `
      <div class="svc-card">
        <div class="svc-stitle" tabindex="-1">Initial Inspection</div>
        <p class="svc-muted">Assess the overall visual condition.</p>
        ${grid}
      </div>
      <div class="svc-card">
        <div class="svc-insp-list">${checklist}</div>
      </div>
      <div class="svc-card">
        <div class="svc-insp-item svc-insp-eq open">
          <div class="svc-insp-head">
            <span class="svc-insp-ic sm">${IC.equip}</span>
            <span class="svc-insp-title eq-title">Equipment Quick Look</span>
            <button type="button" class="svc-insp-chev" onclick="svcToggleInsp_(this)" aria-expanded="true" aria-label="Toggle equipment">⌄</button>
          </div>
          <div class="svc-insp-body">${equip}</div>
        </div>
      </div>
      <div class="svc-card">
        <div class="svc-stitle">Inspection Photo <span class="svc-opt-tag">Optional</span></div>
        <div class="svc-photo-slot-grid">${_svcPhotoSlotHtml('inspection')}</div>
        <div class="sfg" data-tour="svc-internal-notes" style="margin-top:1.1rem">
          <label>Internal Note <span class="svc-opt-tag">Optional</span></label>
          <span class="sh">Admin-only — does NOT go to the customer report.</span>
          <textarea class="si" id="svc-internal-notes" name="Internal Notes" placeholder="Add note…"></textarea>
        </div>
      </div>`;
  }
  if(id === 'test'){
    const RC = n => _svcReadingCard_(meta, n);
    return `
      <div class="svc-card" data-tour="svc-test-results">
        <div class="svc-stitle" tabindex="-1">Water Testing</div>
        <p class="svc-muted">Ideal ranges from the Taylor test manual — status updates live.</p>
        ${RC('Free Chlorine (FC)')}${RC('pH')}${RC('Total Alkalinity (TA)')}${RC('Calcium Hardness (CH)')}${RC('Cyanuric Acid (CYA)')}${RC('Salt Level')}
        <div class="sfg tablet-level-field">
          <label>Tablet Level</label>
          <span class="sh">Current chlorine tablet level in the chlorinator.</span>
          <div class="tablet-level-control" id="tablet-pills" role="group" aria-label="Tablet level">
            ${_svcTabletOptionHtml_('low','Low','0-2 tabs',2)}
            ${_svcTabletOptionHtml_('medium','Medium','3-4 tabs',4)}
            ${_svcTabletOptionHtml_('full','Full','5-6 tabs',6)}
            ${_svcTabletOptionHtml_('none','None','No chlorinator',0)}
          </div>
        </div>
      </div>`;
  }
  if(id === 'service'){
    return `
      <div class="svc-card svc-service-card" data-tour="svc-actions">
        <div class="svc-panel-head">
          <span class="svc-panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l1 3h3v14H5V7h3z"></path><path d="M9 7h6"></path><path d="M8 12h8M8 16h8"></path></svg></span>
          <div class="svc-panel-title" tabindex="-1">Service Checklist</div>
        </div>
        ${_svcTechnicianActionsHtml_(meta)}
        <div class="svc-chlor-row">
          <label class="svc-action-row svc-action-row-compact">
            <input type="checkbox" id="svc-chlor-adj" onchange="toggleChlorAdj(this)">
            <span class="svc-action-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"></path></svg></span>
            <span class="svc-action-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h7a4 4 0 0 1 4 4v11H7z"></path><path d="M10 4V2h5v2"></path><path d="M18 10h3v5h-3"></path><path d="M10 8h5"></path></svg></span>
            <span class="svc-action-name">Adjusted chlorinator power</span>
          </label>
          <div id="svc-chlor-dir" class="svc-chlor-options" style="display:none">
            <button type="button" class="chpill svc-chlor-btn" onclick="tChlor(this)" data-val="Increased">Increased</button>
            <button type="button" class="chpill svc-chlor-btn" onclick="tChlor(this)" data-val="Decreased">Decreased</button>
          </div>
        </div>
      </div>
      <div class="svc-card svc-service-card">
        <div class="svc-panel-head svc-panel-head-split">
          <span class="svc-panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.2 6 11a6 6 0 0 1-12 0c0-4.8 6-11 6-11z"></path></svg></span>
          <div class="svc-panel-title">Water Chemistry</div>
        </div>
        <div id="svc-service-recap"></div>
      </div>`;
  }
  if(id === 'treat'){
    const treatFields = _svcSortedChemFields_(SVC_CHEMICAL_FIELDS);
    const rows = treatFields.map(f => {
      const te = f.replace(/"/g,'&quot;');
      return `<div class="svc-treat-row" style="display:none">
        <div class="svc-treat-row-head">${_chemBadgeHtml_(f)}<span class="svc-treat-name">${escHtml(f)}</span><span class="svc-treat-rec" data-rec-for="${te}"></span></div>
        <div class="svc-treat-actual"><label>Actual used</label><input class="si" type="text" name="${te}" oninput="svcChemInput_(this)"></div>
      </div>`;
    }).join('');
    const chips = treatFields.map(f => {
      const te = f.replace(/"/g,'&quot;');
      return `<button type="button" class="svc-chem-chip" data-chip-field="${te}" onclick="svcToggleChem_(this)">${_chemBadgeHtml_(f)}<span>${escHtml(f)}</span></button>`;
    }).join('');
    return `
      <div class="svc-card" data-tour="svc-chemicals-used">
        <div class="svc-stitle" tabindex="-1">Chemical Treatment</div>
        <div id="rec-box" class="rec-box treatment-plan" data-tour="svc-recommendations">
          <div class="rb-hdr">
            <span>Treatment Plan</span>
            <div class="rb-meta"><div id="rb-flags" class="rb-flags"></div><span id="rb-vol" class="rb-vol">—</span></div>
          </div>
          <div id="rb-list" class="rb-list"></div>
        </div>
        <div id="svc-treat-advisory" class="svc-treat-advisory"></div>
        <div id="svc-treat-list">${rows}</div>
        <div class="svc-treat-add">
          <div class="svc-treat-add-lbl">Add another chemical</div>
          <div class="svc-chem-chip-row" id="svc-chem-chips">${chips}</div>
        </div>
      </div>`;
  }
  if(id === 'verify'){
    return `
      <div class="svc-card svc-verify-card">
        <div class="svc-stitle" tabindex="-1">Verify</div>
        <p class="svc-muted">Review the visit record before completion.</p>
        <div class="svc-verify-section">
          <div class="svc-recap-sub">Tested Chemistry</div>
          <div id="svc-verify-recap"></div>
        </div>
        <div class="svc-verify-section">
          <div class="svc-recap-sub">Chemicals Used</div>
          <div id="svc-verify-chems"></div>
        </div>
        <div class="svc-verify-section">
          <div class="svc-recap-sub">Inspection Summary</div>
          <div id="svc-verify-inspection"></div>
        </div>
        <div class="svc-verify-section">
          <div class="svc-recap-sub">Equipment Summary</div>
          <div id="svc-verify-equipment"></div>
        </div>
        <div class="svc-verify-section">
          <div class="svc-recap-sub">Required Photos</div>
          <div class="svc-photo-slot-grid svc-verify-photos">${_svcPhotoSlotHtml('after')}${_svcPhotoSlotHtml('equipment')}</div>
        </div>
      </div>`;
  }
  if(id === 'complete'){
    return `
      <div class="svc-card svc-complete-card">
        <div class="svc-stitle" tabindex="-1">Complete</div>
        <div class="svc-submit-panel" id="svc-submit-panel"></div>
        <div class="svc-complete-section">
          <div class="svc-recap-sub">Customer Report Notes</div>
          <textarea class="si svc-complete-notes" name="Notes" oninput="runRecs()" placeholder="Optional notes that can appear on the customer report."></textarea>
        </div>
        <div class="svc-complete-section">
          <div class="svc-recap-sub">Extra Photo</div>
          <div class="svc-photo-slot-grid svc-complete-photos">${_svcPhotoSlotHtml('other')}</div>
        </div>
      </div>`;
  }
  return '';
}

function renderSvcForm(meta, prefillPoolId){
  _formItems = meta;
  const root = document.getElementById('svc-root'); root.innerHTML = '';
  window._pendingSvcPoolId = null; // Consume it
  window._svcStartedAt = null;     // reset Start Service stamp for a fresh visit
  _svcStep = 0;
  initSvcPhotoState_();

  // ── Back button / header ────────────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.id = 'svc-form-header';
  hdr.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:0 4px';
  hdr.innerHTML = `
    <button onclick="navigateTo('live_map')" style="background:var(--teal);color:#fff;border:none;padding:8px 14px;border-radius:10px;font-family:Oswald;font-size:0.85rem;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      BACK TO HUB
    </button>
  `;
  root.appendChild(hdr);

  // ── Tappable step indicator ─────────────────────────────────────────────────
  const stepper = document.createElement('div');
  stepper.id = 'svc-stepper'; stepper.className = 'svc-stepper';
  stepper.setAttribute('role','tablist'); stepper.setAttribute('aria-label','Service log steps');
  stepper.innerHTML = SVC_STEPS.map((s,i) =>
    `<button type="button" role="tab" id="svc-dot-${i}" class="svc-dot" aria-selected="${i===0?'true':'false'}" aria-controls="svc-step-${s.id}" onclick="svcGoStep(${i})"><span class="svc-dot-n">${s.n}</span><span class="svc-dot-l">${s.title}</span></button>`
  ).join('');
  root.appendChild(stepper);

  // ── Mounted step panels (inactive hidden via display) ───────────────────────
  const wrap = document.createElement('div'); wrap.id = 'svc-steps';
  wrap.innerHTML = SVC_STEPS.map((s,i) =>
    `<section class="svc-step" id="svc-step-${s.id}" role="tabpanel" aria-label="${s.title}"${i===0?'':' style="display:none"'}>${_svcStepInner(s.id, meta)}</section>`
  ).join('');
  root.appendChild(wrap);

  // ── Sticky Back / Next footer ───────────────────────────────────────────────
  const footer = document.createElement('div'); footer.id = 'svc-nav'; footer.className = 'svc-nav';
  footer.innerHTML = `
    <button type="button" id="svc-nav-back" class="svc-nav-btn ghost" onclick="svcBack()">Back</button>
    <button type="button" id="svc-nav-next" class="svc-nav-btn primary" onclick="svcNext()"><span id="svc-nav-next-label">Continue</span> ›</button>`;
  root.appendChild(footer);

  _svcSyncStepUI();
  renderPhotoPreviews_();

  // ── Auto-fill Technician + Complete-step sign-off from logged-in user ────────
  setTimeout(() => {
    const techEl = document.querySelector('[name="Technician"]');
    if (techEl && _s && _s.name) {
      if (techEl.tagName === 'SELECT') {
        for (let i = 0; i < techEl.options.length; i++) {
          if (techEl.options[i].value.toLowerCase().trim() === _s.name.toLowerCase().trim() ||
              techEl.options[i].text.toLowerCase().trim() === _s.name.toLowerCase().trim()) {
            techEl.selectedIndex = i; break;
          }
        }
      } else { techEl.value = _s.name; }
      const grp = techEl.closest('.sfg'); if (grp) grp.style.display = 'none';
    }
    _svcRenderSignoff_();
  }, 100);

  if (prefillPoolId) {
    setTimeout(() => {
      const poolSel = document.querySelector('[name="pool_id"]');
      if (!poolSel) return;
      const mcpsId = prefillPoolId.match(/(MCPS-\d{4,})\s*$/i);
      let matched = false;
      for (let i = 0; i < poolSel.options.length; i++) {
        const opt = poolSel.options[i].value;
        if (opt === prefillPoolId || (mcpsId && opt.toUpperCase().includes(mcpsId[1].toUpperCase()))) {
          poolSel.selectedIndex = i; matched = true; break;
        }
      }
      // Live list hasn't arrived yet — inject the prefilled client so its name,
      // address and context load INSTANTLY instead of waiting on get_pool_list.
      if (!matched) {
        const o = document.createElement('option');
        o.value = prefillPoolId;
        o.textContent = _poolClientName_(prefillPoolId);
        o.selected = true;
        poolSel.appendChild(o);
      }
      updateSvcIdentityBanner_(poolSel.value, true); // lock — came from a scheduled job
      poolSel.dispatchEvent(new Event('change'));    // → handlePoolChange → context + spinner
    }, 10);
  }
}

// ── Step navigation ───────────────────────────────────────────────────────────
function _svcReducedMotion_(){
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function svcGoStep(i){
  if(i < 0 || i >= SVC_STEPS.length) return;
  _svcStep = i;
  SVC_STEPS.forEach((s, idx) => {
    const panel = document.getElementById('svc-step-' + s.id);
    if(panel) panel.style.display = (idx === i) ? 'block' : 'none';
  });
  _svcSyncStepUI();
  _svcRenderRecaps_();
  const active = document.getElementById('svc-step-' + SVC_STEPS[i].id);
  if(active){
    const h = active.querySelector('.svc-stitle, .svc-panel-title');
    if(h){ try { h.focus({ preventScroll:true }); } catch(e) { h.focus(); } }
  }
  window.scrollTo({ top:0, behavior:_svcReducedMotion_() ? 'auto' : 'smooth' });
}
function svcNext(){ svcGoStep(Math.min(_svcStep + 1, SVC_STEPS.length - 1)); }
function svcBack(){ svcGoStep(Math.max(_svcStep - 1, 0)); }
function _svcSyncStepUI(){
  SVC_STEPS.forEach((s, idx) => {
    const dot = document.getElementById('svc-dot-' + idx);
    if(dot){
      dot.classList.toggle('active', idx === _svcStep);
      dot.classList.toggle('done',   idx <  _svcStep);
      dot.setAttribute('aria-selected', idx === _svcStep ? 'true' : 'false');
    }
  });
  const back = document.getElementById('svc-nav-back');
  const next = document.getElementById('svc-nav-next') || document.getElementById('btn-svc');
  if(back) back.style.display = _svcStep === 0 ? 'none' : 'inline-flex';   // no empty gap beside Next on step 1
  if(next) {
    next.style.display = 'inline-flex';
    next.setAttribute('onclick', _svcStep === SVC_STEPS.length - 1 ? 'submitSvc()' : 'svcNext()');
    if(_svcStep === SVC_STEPS.length - 1) next.id = 'btn-svc';
    else next.id = 'svc-nav-next';
  }
  const nextStep = SVC_STEPS[_svcStep + 1];
  if(next) next.innerHTML = nextStep
    ? '<span id="svc-nav-next-label">Continue to ' + escHtml(nextStep.title) + '</span> ›'
    : '<span id="svc-nav-next-label">Complete &amp; Send</span>';
}
function _svcStepOfField_(title){
  const t = String(title || '').toLowerCase();
  if(t === 'pool_id') return 0;
  if(SVC_INSPECT_FIELDS.map(x => x.toLowerCase()).indexOf(t) !== -1) return 1;
  if(SVC_READING_BANDS.hasOwnProperty(title)) return 2;
  if(SVC_CHEMICAL_FIELDS.map(x => x.toLowerCase()).indexOf(t) !== -1) return 4;
  return 6;
}

// ── Reading bands + read-only recaps ──────────────────────────────────────────
function _svcUpdateBands_(){
  Object.keys(SVC_READING_BANDS).forEach(field => {
    const input = document.querySelector(svcNameSel_(field));
    const band = input ? readingBand(field, input.value) : null;
    const badge = document.querySelector(_svcBandSel_(field));
    if(badge){
      badge.className = 'reading-band' + (band ? (' ' + band) : '');
      badge.textContent = band ? SVC_BAND_LABEL[band] : '';
    }
    if(input && band) input.setAttribute('aria-label', field + ' ' + input.value + ', ' + SVC_BAND_LABEL[band].toLowerCase());
    // Live meter marker
    const mark = document.querySelector('[data-mark-for="' + _svcAttrEsc_(field) + '"]');
    if(mark){
      const r = SVC_READING_BANDS[field];
      const v = input ? parseFloat(input.value) : NaN;
      if(input && input.value !== '' && !isNaN(v)){
        mark.style.left = _svcMeterPct_(r, v) + '%';
        mark.style.display = 'block';
        mark.className = 'svc-meter-mark' + (band ? (' ' + band) : '');
      } else {
        mark.style.display = 'none';
      }
    }
  });
}
function _svcReadingRecapHtml_(){
  const cells = Object.keys(SVC_READING_BANDS).map(field => {
    const input = document.querySelector(svcNameSel_(field));
    const has = input && input.value !== '';
    if (!has) return '';
    const val = has ? input.value : '—';
    const band = has ? readingBand(field, input.value) : null;
    const short = SVC_READING_SHORT[field] || field;
    return '<div class="svc-recap-cell"><div class="svc-recap-k">'+short+'</div><div class="svc-recap-v">'+escHtml(val)+'</div>'+(band?'<span class="reading-band '+band+'">'+SVC_BAND_LABEL[band]+'</span>':'')+'</div>';
  }).filter(Boolean).join('');
  if(!cells) return '<p class="svc-muted">No readings entered.</p>';
  return '<div class="svc-recap-grid">'+cells+'</div>';
}
function _svcChemRecapHtml_(){
  const used = SVC_CHEMICAL_FIELDS.map(f => {
    const el = document.querySelector(svcNameSel_(f));
    const v = el && el.value ? el.value.trim() : '';
    return v ? { name:f, amt:v } : null;
  }).filter(Boolean);
  if(!used.length) return '<p class="svc-muted">No chemicals logged.</p>';
  return '<div class="svc-chem-recap">'+used.map(u =>
    '<div class="svc-chem-recap-row">'+_chemBadgeHtml_(u.name)+'<span class="svc-chem-recap-name">'+escHtml(u.name)+'</span><span class="svc-chem-recap-amt">'+escHtml(u.amt)+'</span></div>'
  ).join('')+'</div>';
}
function _svcVerifySelectionHtml_(fields, emptyText){
  const rows = fields.map(f => {
    const el = document.querySelector(svcNameSel_(f.name));
    const val = el && el.value ? el.value.trim() : '';
    return val ? '<div class="svc-verify-row"><span class="svc-verify-k">'+escHtml(f.label)+'</span><span class="svc-verify-v">'+escHtml(val)+'</span></div>' : '';
  }).filter(Boolean).join('');
  return rows ? '<div class="svc-verify-list">'+rows+'</div>' : '<p class="svc-muted">'+emptyText+'</p>';
}
function _svcVerifyInspectionHtml_(){
  return _svcVerifySelectionHtml_([
    { name:'Water Color', label:'Water color' },
    { name:'Debris', label:'Debris' },
    { name:'Water Level', label:'Water level' },
    { name:'Algae', label:'Algae' }
  ], 'No inspection selections entered.');
}
function _svcVerifyEquipmentHtml_(){
  return _svcVerifySelectionHtml_([
    { name:'Pump Status', label:'Pump' },
    { name:'Filter Status', label:'Filter' },
    { name:'Cleaner Status', label:'Cleaner' },
    { name:'Skimmers and Returns', label:'Skimmers / returns' },
    { name:'Visible Leaks', label:'Leaks' },
    { name:'Deck and Surrounding', label:'Deck / surrounding' }
  ], 'No equipment selections entered.');
}
function _svcRenderRecaps_(){
  const s = document.getElementById('svc-service-recap'); if(s) s.innerHTML = _svcReadingRecapHtml_();
  const v = document.getElementById('svc-verify-recap');  if(v) v.innerHTML = _svcReadingRecapHtml_();
  const c = document.getElementById('svc-verify-chems');  if(c) c.innerHTML = _svcChemRecapHtml_();
  const i = document.getElementById('svc-verify-inspection'); if(i) i.innerHTML = _svcVerifyInspectionHtml_();
  const e = document.getElementById('svc-verify-equipment'); if(e) e.innerHTML = _svcVerifyEquipmentHtml_();
  _svcRenderCompletePanel_();
}
function _svcRenderSignoff_(){
  const so = document.getElementById('svc-signoff'); if(!so) return;
  const nm = (_s && _s.name) || '';
  const inits = nm.split(/\s+/).filter(Boolean).map(w => (w[0]||'').toUpperCase()).slice(0,3).join('');
  so.innerHTML = '<div class="svc-signoff-lbl">Technician</div><div class="svc-signoff-name">'+escHtml(nm || '—')+'</div><div class="svc-signoff-inits">Initials: <strong>'+escHtml(inits || '—')+'</strong></div>';
}
function _svcRenderCompletePanel_(){
  const panel = document.getElementById('svc-submit-panel');
  if(!panel) return;
  const nm = (_s && _s.name) || '—';
  const missing = svcMissingRequiredPhotos_();
  const ready = missing.length === 0;
  const statusText = ready ? 'Ready to submit' : 'Required photos needed';
  const detail = ready
    ? 'This will save the visit log, upload photos, update inventory, and send the customer report.'
    : 'Attach ' + missing.join(', ') + ' photo' + (missing.length === 1 ? '' : 's') + ' before submitting.';
  panel.innerHTML =
    '<div class="svc-submit-head">'
      + '<div><div class="svc-submit-eyebrow">Confirm Submission</div><div class="svc-submit-title">'+escHtml(statusText)+'</div></div>'
      + '<span class="svc-submit-status '+(ready ? 'ready' : 'warn')+'">'+(ready ? 'Ready' : 'Missing')+'</span>'
    + '</div>'
    + '<div class="svc-confirm-tech"><span>Technician</span><strong>'+escHtml(nm)+'</strong></div>'
    + '<p class="svc-submit-note">'+escHtml(detail)+'</p>';
}

// ── Arrive: Start Service timestamp (tracked on the log, no SMS/GPS) ──────────
function svcStartService_(btn){
  window._svcStartedAt = new Date().toISOString();
  if(!btn) return;
  const t = new Date();
  const h = t.getHours(), m = String(t.getMinutes()).padStart(2,'0');
  const ap = h >= 12 ? 'PM' : 'AM', h12 = ((h + 11) % 12) + 1;
  btn.classList.add('started');
  btn.disabled = true;
  btn.innerHTML = '✓ Service started · ' + h12 + ':' + m + ' ' + ap;
}

// ── Arrive: pool info modal (specs · last visit + trends · access notes) ──────
function svcShowPoolInfo_(){
  const ctx = window._svcPoolContext || {};
  const rec = window._svcRecipient || {};
  const cap = s => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };

  // Client header
  const client = (rec.name || rec.address)
    ? '<div class="svc-info-client"><div class="svc-info-client-name">'+escHtml(rec.name || '')+'</div>'+(rec.address ? '<div class="svc-info-client-addr">'+escHtml(rec.address)+'</div>' : '')+'</div>'
    : '';

  // Stat tiles
  const stats = [];
  if(ctx.last_size)     stats.push({ k:'Pool Size', v:cap(ctx.last_size) });
  if(ctx.last_material) stats.push({ k:'Material',  v:cap(ctx.last_material) });
  if(ctx.visit_count != null && ctx.visit_count !== '') stats.push({ k:'Visits Logged', v:String(ctx.visit_count), big:true });
  const statsHtml = stats.length
    ? '<div class="svc-info-stats">'+stats.map(s =>
        '<div class="svc-stat"><div class="svc-stat-k">'+escHtml(s.k)+'</div><div class="svc-stat-v'+(s.big?' big':'')+'">'+
        (s.pill ? '<span class="svc-info-pill '+s.pill.cls+'">'+escHtml(s.pill.txt)+'</span>' : escHtml(s.v))+
        '</div></div>').join('')+'</div>'
    : '<p class="svc-muted">No saved details yet for this pool.</p>';

  const trends = (ctx.trends && ctx.trends.length)
    ? '<div class="svc-info-sub">Trends</div><div class="rb-flags">'+ctx.trends.map(t => '<span class="pool-trend-pill">'+escHtml(t)+'</span>').join(' ')+'</div>' : '';
  const lastNotes = (ctx.internal_notes || ctx.last_notes)
    ? '<div class="svc-info-sub">Last visit notes</div><p class="svc-info-notes">'+escHtml(ctx.internal_notes || ctx.last_notes)+'</p>' : '';
  const access = '<div class="svc-info-sub">Access / gate notes</div><p class="svc-muted">None on file.</p>';

  let ov = document.getElementById('svc-info-modal');
  if(!ov){ ov = document.createElement('div'); ov.id = 'svc-info-modal'; ov.className = 'svc-info-modal'; document.body.appendChild(ov); }
  ov.innerHTML = '<div class="svc-info-card" role="dialog" aria-modal="true" aria-label="Pool info"><div class="svc-info-head"><span>Pool Info</span><button type="button" class="svc-info-close" aria-label="Close" onclick="closeSvcPoolInfo_()">✕</button></div>'+client+statsHtml+trends+lastNotes+access+'</div>';
  ov.classList.add('open');
  ov.onclick = e => { if(e.target === ov) closeSvcPoolInfo_(); };
}
function closeSvcPoolInfo_(){
  const ov = document.getElementById('svc-info-modal');
  if(ov) ov.classList.remove('open');
}

// ── Inspect step: collapsible rows + status tone dots/labels ──────────────────
function svcToggleInsp_(btn){
  const item = btn.closest('.svc-insp-item');
  if(!item) return;
  const open = item.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
const SVC_STATUS_TONE = {
  'Good':'good', 'None observed':'good', 'Running':'good', 'Normal pressure':'good', 'Operating':'good',
  'Monitor':'warn', 'Minor':'warn', 'Needs review':'warn', 'High pressure':'warn',
  'Issue':'bad', 'Active leak':'bad', 'Not running':'bad'
  // 'Not present' → neutral (no tone)
};
function svcInspStatus_(sel){
  const name = sel.getAttribute('name');
  const val = sel.value;
  const tone = SVC_STATUS_TONE[val] || '';
  const esc = String(name).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  const sub = document.querySelector('[data-sub-for="'+esc+'"]');
  if(sub){ sub.textContent = val || ''; sub.className = 'svc-insp-sub' + (tone ? ' ' + tone : ''); }
  const dot = document.querySelector('[data-dot-for="'+esc+'"]');
  if(dot){ dot.className = 'svc-eq-dot' + (tone ? ' ' + tone : ''); }
}

// ── Treat: merge dosing recs with the actual-used inputs ──────────────────────
// buildRecs() emits display names + amounts. Recs that map to a real chemical
// field AND carry a numeric amount become prefilled "actual used" rows; every
// rec still appears in the Treatment Plan panel.
const REC_TO_FIELD = {
  'Liquid Chlorine':                     'Liquid Chlorine',
  'Chlorine Tablets':                    'Chlorine Tablets (3")',
  'Muriatic Acid':                       'Muriatic Acid',
  'Soda Ash':                            'Soda Ash',
  'Alkalinity Increaser (Sodium Bicarb)':'Alkalinity Increaser',
  'Calcium Hardness Increaser':          'Calcium Hardness Increaser',
  'Salt':                                'Salt'
};
function _recNumeric_(amt){
  const m = String(amt || '').match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}
function _recIsNumericAmount_(amt){ return /^\s*\d/.test(String(amt || '')); }
function _svcRecAmountParts_(amt){
  const s = String(amt || '').trim();
  const m = s.match(/^(.+?)\s*(\([^)]*\))$/);
  return { primary: m ? m[1].trim() : s, secondary: m ? m[2].replace(/[()]/g,'').trim() : '' };
}
function _svcRecType_(rec){
  const name = String((rec && rec.name) || '');
  const amt = String((rec && rec.amt) || '');
  if (/algae protocol/i.test(name)) return 'protocol';
  if (/hold|leave as is/i.test(amt)) return 'hold';
  if (/chlorinator/i.test(name)) return 'system';
  if (/as needed/i.test(amt) && chemLookup(name)) return 'add';
  if (_recIsNumericAmount_(amt)) return 'add';
  return 'guidance';
}
function _svcRecMeta_(rec){
  const entry = (typeof chemLookup === 'function') ? chemLookup((rec && rec.name) || '') : null;
  const color = entry && entry.color ? entry.color : (rec.status === 'bad' ? '#ef4444' : rec.status === 'warning' ? '#d97706' : '#1a7a6e');
  return { entry, color };
}
function _svcTreatmentPlanHtml_(recs){
  const groups = { protocol: [], add: [], hold: [], system: [], guidance: [] };
  (recs || []).forEach(r => { groups[_svcRecType_(r)].push(r); });
  const section = (title, rows, kind) => {
    if (!rows.length) return '';
    return '<div class="tplan-section ' + kind + '">'
      + '<div class="tplan-section-title">' + title + '</div>'
      + rows.map(_svcTreatmentPlanRowHtml_).join('')
      + '</div>';
  };
  return section('Protocol', groups.protocol, 'protocol')
    + section('Add Now', groups.add, 'add')
    + section('Hold / Caution', groups.hold, 'hold')
    + section('System', groups.system, 'system')
    + section('Guidance', groups.guidance, 'guidance');
}
function _svcTreatmentPlanRowHtml_(rec){
  const meta = _svcRecMeta_(rec);
  const amount = _svcRecAmountParts_(rec.amt);
  const badge = meta.entry ? _chemBadgeHtml_(rec.name) : '<span class="tplan-type-mark ' + _svcRecType_(rec) + '"></span>';
  const amountHtml = amount.primary
    ? '<div class="tplan-amt"><span>' + escHtml(amount.primary) + '</span>' + (amount.secondary ? '<small>' + escHtml(amount.secondary) + '</small>' : '') + '</div>'
    : '';
  return '<div class="tplan-row ' + (rec.status || '') + '" style="--chem:' + meta.color + '">'
    + '<div class="tplan-main">' + badge + '<div class="tplan-copy"><div class="tplan-name">' + escHtml(rec.name || '') + '</div><div class="tplan-why">' + escHtml(rec.reason || '') + '</div></div></div>'
    + amountHtml
    + '</div>';
}

function svcChemInput_(el){
  if(el){ el.dataset.userEdited = '1'; el.removeAttribute('data-prefilled'); }
  runRecs();
}
function svcToggleChem_(btn){
  const f = btn.getAttribute('data-chip-field');
  const input = document.querySelector(svcNameSel_(f));
  const row = input && input.closest('.svc-treat-row');
  if(!row) return;
  const show = row.style.display === 'none';
  row.style.display = show ? 'block' : 'none';
  btn.classList.toggle('active', show);
  if(show && input){ try { input.focus(); } catch(e) {} }
}
function _svcApplyTreatRecs_(recs){
  (recs || []).forEach(r => {
    const field = REC_TO_FIELD[r.name];
    if(field && (_recIsNumericAmount_(r.amt) || _svcRecType_(r) === 'add')){
      const input = document.querySelector(svcNameSel_(field));
      const row = input && input.closest('.svc-treat-row');
      if(row){
        row.style.display = 'block';
        const hint = row.querySelector('[data-rec-for]');
        if(hint) hint.textContent = 'Recommended: ' + r.amt;
        row.classList.remove('good','warning','bad');
        if(r.status) row.classList.add(r.status);
        const num = _recNumeric_(r.amt);
        // Prefill only when safe: untouched by the tech and either empty or a
        // value we ourselves prefilled (so drafts and manual entries survive).
        if(input && num !== null && input.dataset.userEdited !== '1' && (input.value === '' || input.dataset.prefilled === '1')){
          input.value = num; input.dataset.prefilled = '1';
        }
      }
    }
  });
  const adv = document.getElementById('svc-treat-advisory');
  if(adv) adv.innerHTML = '';
  // Reveal any row that already holds a value (drafts / manual entry) and keep
  // the "add another chemical" chips in sync with row visibility.
  SVC_CHEMICAL_FIELDS.forEach(f => {
    const input = document.querySelector(svcNameSel_(f));
    const row = input && input.closest('.svc-treat-row');
    if(row && input && input.value !== '' && row.style.display === 'none') row.style.display = 'block';
    const chip = document.querySelector('[data-chip-field="' + String(f).replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"]');
    if(chip && row) chip.classList.toggle('active', row.style.display !== 'none');
  });
}

function mkCard(t){const d=document.createElement('div');d.className='svc-card';if(t){const h=document.createElement('div');h.className='svc-stitle';h.textContent=t;d.appendChild(h);}return d;}

// ── Map → Service Log flow ────────────────────────────────────────────────────
function goToSvcLog(poolId, customerName, scheduledVisitId, visitType) {
  if (!poolId) return;
  window._pendingSvcPoolId = poolId;
  window._prefillCustomer = customerName || '';
  window._pendingSvcMeta = {
    pool_id: poolId || '',
    scheduled_visit_id: scheduledVisitId || '',
    visit_type: visitType || ''
  };
  navigateTo('service_log');
}

function prefillSvcForm_(poolId) {
  // This legacy function is now partially absorbed by loadServiceLog parallel flow
  // but kept for compatibility with other triggers
}

function clearPoolContextBanners_() {
  const oldNotes = document.getElementById('pool-last-notes-banner');
  if (oldNotes) oldNotes.remove();
  const oldTrend = document.getElementById('pool-trend-banner');
  if (oldTrend) oldTrend.remove();
}

// ── Wrong-pool mitigation: identity banner + recipient (Layers 1 & 2) ─────────
// The dropdown labels pools as "LastName - ServiceType - Address - MCPS-0001".
// Parse a customer name + address out of that for an at-a-glance banner, even
// before the authoritative contact (with email) arrives from get_pool_context.
function _parsePoolLabel_(label) {
  const parts = String(label || '').split(' - ').map(s => s.trim()).filter(Boolean);
  let name = '', address = '';
  if (parts.length) {
    name = parts[0] || '';
    if (parts.length >= 3) address = parts[parts.length - 2] || '';
  }
  return { name, address };
}

// Render/refresh the big "Logging visit for …" banner. When `lock` is true the
// pool dropdown is disabled (the tech arrived from a specific scheduled job).
function updateSvcIdentityBanner_(poolId, lock) {
  const root = document.getElementById('svc-root');
  if (!root) return;
  const sel = document.querySelector('[name="pool_id"]');
  const anchor = document.getElementById('svc-arrive-identity'); // lives inside the Arrive step
  let banner = document.getElementById('svc-identity-banner');

  if (!poolId) { if (banner) banner.remove(); return; }

  // Parse from the option VALUE (full "… - Address - MCPS-XXXX" label) so the
  // address shows immediately, before get_pool_context returns.
  const fullLabel = (sel && sel.value) ? sel.value : poolId;
  const parsed = _parsePoolLabel_(fullLabel);
  const rec = window._svcRecipient || {};
  const name = rec.name || parsed.name || '—';
  const address = rec.address || parsed.address || '';

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'svc-identity-banner';
    if (anchor) anchor.appendChild(banner);
    else {
      const hdr = document.getElementById('svc-form-header');
      if (hdr && hdr.nextSibling) root.insertBefore(banner, hdr.nextSibling);
      else root.insertBefore(banner, root.firstChild);
    }
  } else if (anchor && banner.parentElement !== anchor) {
    anchor.appendChild(banner); // keep it inside Arrive, not floating at the top
  }

  const changeBtn = lock
    ? '<button type="button" onclick="_unlockSvcPool_()" style="background:transparent;border:1px solid rgba(255,255,255,.55);color:#fff;font-size:.7rem;padding:4px 9px;border-radius:8px;cursor:pointer;white-space:nowrap;font-family:Oswald,sans-serif">Wrong pool?</button>'
    : '';
  const loading =
    '<div id="svc-client-loading" class="svc-client-loading" style="display:' + (window._svcClientLoading ? 'flex' : 'none') + '">'
    + '<span class="svc-mini-spin" aria-hidden="true"></span>Loading pool details…</div>';
  banner.style.cssText = 'background:var(--teal,#0d4d44);color:#fff;border-radius:12px;padding:12px 14px;margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.12)';
  banner.innerHTML =
    '<div style="min-width:0">'
    + '<div style="font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;opacity:.8;font-family:Oswald,sans-serif">Logging visit for</div>'
    + '<div style="font-size:1.15rem;font-weight:700;font-family:Oswald,sans-serif;line-height:1.15">' + escHtml(name) + '</div>'
    + (address ? '<div style="font-size:.82rem;opacity:.95">' + escHtml(address) + '</div>' : '')
    + loading
    + '</div>'
    + changeBtn;

  if (sel && lock) { sel.disabled = true; sel.style.opacity = '.6'; }
}

// Toggle the "Loading pool details…" indicator inside the identity banner.
function _svcSetClientLoading_(loading){
  window._svcClientLoading = !!loading;
  const el = document.getElementById('svc-client-loading');
  if (el) el.style.display = loading ? 'flex' : 'none';
}

function _unlockSvcPool_() {
  const sel = document.querySelector('[name="pool_id"]');
  if (sel) { sel.disabled = false; sel.style.opacity = ''; sel.focus(); }
  const btn = document.querySelector('#svc-identity-banner button');
  if (btn) btn.remove();
}

// Store the authoritative contact from get_pool_context and refresh the banner.
function setSvcRecipient_(data) {
  if (!data) return;
  // Only treat the email as "known" (and thus trust a missing one → warning) when
  // the backend actually returned the contact field. An older backend that predates
  // the get_pool_context contact change omits it entirely — don't cry wolf then.
  const hasContact = Object.prototype.hasOwnProperty.call(data, 'customer_email');
  window._svcRecipient = {
    name: String(data.customer_name || '').trim(),
    address: String(data.customer_address || '').trim(),
    email: String(data.customer_email || '').trim(),
    resolved: hasContact
  };
  const sel = document.querySelector('[name="pool_id"]');
  const poolId = sel ? sel.value : null;
  if (poolId) updateSvcIdentityBanner_(poolId, !!(sel && sel.disabled));
}

function applyPoolContext_(ctx, poolId) {
  window._svcPoolContext = ctx;   // fuels the Arrive "View pool info" modal
  clearPoolContextBanners_();

  // Prefill pool size (case-insensitive, first-word match covers "Large (20k+)" → "large")
  if (ctx.last_size) {
    const sizeKey = ctx.last_size.toString().toLowerCase().split(/[^a-z]/)[0];
    const sizeSel = document.getElementById('svc-size');
    if (sizeSel) {
      for (let i = 0; i < sizeSel.options.length; i++) {
        if (sizeSel.options[i].value === sizeKey) { sizeSel.selectedIndex = i; break; }
      }
    }
  }

  // Prefill pool material (case-insensitive)
  if (ctx.last_material) {
    const matKey = ctx.last_material.toString().toLowerCase().split(/[^a-z]/)[0];
    const matSel = document.getElementById('svc-mat');
    if (matSel) {
      for (let i = 0; i < matSel.options.length; i++) {
        if (matSel.options[i].value === matKey) { matSel.selectedIndex = i; break; }
      }
    }
  }

  // Prefill last known tablet level
  if (ctx.last_tablet) {
    const tablet = String(ctx.last_tablet).toLowerCase();
    const pill = document.querySelector(`.tbpill[data-val="${tablet}"]`);
    if (pill && !pill.classList.contains('tactive')) tTablet(pill, tablet);
  }

  // Trigger recs recalc after prefill
  if (typeof runRecs === 'function') runRecs();

  // Show trend banner
  if (ctx.trends && ctx.trends.length) renderTrendBanner_(ctx.trends, ctx.visit_count || 0);

  // Show notes from last visit (inside the Arrive step, not floating on top).
  // Only render when there is real note text — never an empty box.
  const lastNotes = String(ctx.internal_notes || ctx.last_notes || '').trim();
  const existing = document.getElementById('pool-last-notes-banner');
  if (existing) existing.remove();
  if (lastNotes) {
    const anchor = document.getElementById('svc-arrive-context') || document.getElementById('svc-root');
    if (anchor) {
      const banner = document.createElement('div');
      banner.id = 'pool-last-notes-banner';
      banner.className = 'pool-trend-banner';
      banner.style.background = '#fffbeb';
      banner.style.color = '#92400e';
      banner.style.borderLeft = '4px solid #f59e0b';
      banner.innerHTML = '<strong>Notes from last visit:</strong> ' + escHtml(lastNotes);
      anchor.appendChild(banner);
    }
  }
}

function loadPoolContextForSelection_(poolId) {
  if (!poolId || poolId === 'Other / Pool not listed') {
    clearPoolContextBanners_();
    _svcSetClientLoading_(false);
    return Promise.resolve();
  }
  const reqId = ++_svcContextReqId;
  _svcSetClientLoading_(true);
  return api({ secret:SEC, action:'get_pool_context', token:_s.token, pool_id:poolId })
    .then(res => {
      if (reqId !== _svcContextReqId) return;
      if (res && res.ok && res.data) {
        setSvcRecipient_(res.data);
        if (res.data.found) applyPoolContext_(res.data, poolId);
        else clearPoolContextBanners_();
      } else {
        clearPoolContextBanners_();
      }
    })
    .catch(e => console.warn('Pool context load failed', e))
    .then(() => { if (reqId === _svcContextReqId) _svcSetClientLoading_(false); });
}

function renderTrendBanner_(trends, visitCount) {
  const anchor = document.getElementById('svc-arrive-context') || document.getElementById('svc-root');
  if (!anchor) return;
  const existing = document.getElementById('pool-trend-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'pool-trend-banner';
  banner.className = 'pool-trend-banner';
  const pills = trends.map(t => '<span class="pool-trend-pill">' + t + '</span>').join(' ');
  banner.innerHTML = '<strong>📊 Trend — last ' + visitCount + ' visit' + (visitCount !== 1 ? 's' : '') + '</strong>' + pills;
  anchor.appendChild(banner);
}
function tCond(el,type){const was=el.classList.contains('active')||el.classList.contains('active-ok')||el.classList.contains('active-cloudy');document.querySelectorAll('.cpill:not(.tbpill):not(.chpill)').forEach(p=>p.classList.remove('active','active-ok','active-cloudy'));if(!was)el.classList.add(type==='green'?'active':type==='clear'?'active-ok':'active-cloudy');runRecs();}
// Tablet level pill toggle
function tTablet(el,level){const was=el.classList.contains('tactive');document.querySelectorAll('.tbpill').forEach(p=>{p.classList.remove('tactive');p.setAttribute('aria-pressed','false');});if(!was){el.classList.add('tactive');el.setAttribute('aria-pressed','true');}runRecs();}
// Chlorinator power adjustment: checkbox reveals Increased/Decreased pills
function toggleChlorAdj(cb){const dir=document.getElementById('svc-chlor-dir');if(dir)dir.style.display=cb.checked?'flex':'none';if(!cb.checked)document.querySelectorAll('#svc-chlor-dir .chpill').forEach(p=>p.classList.remove('active-ok'));runRecs();}
function tChlor(el){document.querySelectorAll('#svc-chlor-dir .chpill').forEach(p=>p.classList.remove('active-ok'));el.classList.add('active-ok');runRecs();}
function getTabletLevel(){const a=document.querySelector('.tbpill.tactive');return a?a.dataset.val:null;}

function gn(t){const el=document.querySelector('[name="'+t+'"]');if(!el||!el.value)return null;const v=parseFloat(el.value);return isNaN(v)?null:v;}
function s2g(v){const s=String(v||'').toLowerCase();if(s.includes('large')||s.includes('>20'))return SG.large;if(s.includes('medium')||s.includes('15,000'))return SG.medium;return SG.small;}

function runRecs(){
  _svcUpdateBands_();      // reading health badges (runs before any early return)
  _svcRenderRecaps_();     // Service/Verify read-only recaps stay in sync
  const fc=gn(TF.FC),ph=gn(TF.PH),ta=gn(TF.TA),ch=gn(TF.CH),salt=gn('Salt Level');
  const pe=document.querySelector('[name="pool_id"]');
  const szEl=document.getElementById('svc-size');
  const gal=szEl?SG[szEl.value]||SG.small:s2g(pe?pe.value:'');
  const mat=(document.getElementById('svc-mat')||{value:'plaster'}).value;
  // Green/algae now derives from the Inspect step's Water Color + Algae dropdowns
  // (the "Pool Condition on Arrival" pill was removed).
  const wc=(document.querySelector('[name="Water Color"]')||{}).value||'';
  const alg=(document.querySelector('[name="Algae"]')||{}).value||'';
  const isG = wc==='Green' || wc==='Black / Swamp' || alg==='Moderate' || alg==='Severe';
  const isS=SM.indexOf(new Date().getMonth()+1)!==-1;
  const rb=document.getElementById('rec-box');if(!rb){ _svcApplyTreatRecs_([]); if(pe&&pe.value)saveDraft(pe.value); return; }
  if(fc===null&&ph===null&&ta===null&&ch===null&&salt===null&&!isG){rb.style.display='none';_svcApplyTreatRecs_([]);if(pe&&pe.value)saveDraft(pe.value);return;}
  const recs=buildRecs(fc,ph,ta,ch,gal,mat,isG,salt);
  _svcApplyTreatRecs_(recs);
  const vb=document.getElementById('rb-vol');if(vb)vb.textContent=(gal/1000).toFixed(0)+'K gal';
  const fe=document.getElementById('rb-flags');if(fe)fe.innerHTML=(isS?'<span class="rf summer">Summer +50% Cl</span>':'')+(isG?'<span class="rf green">Algae Protocol</span>':'')+(mat==='fiberglass'?'<span class="rf fiber">Fiberglass</span>':'')+(mat==='plaster'?'<span class="rf plstr">Plaster</span>':'');
  if(!recs.length){rb.style.display='none';} else {
    rb.style.display='block';
    document.getElementById('rb-list').innerHTML=_svcTreatmentPlanHtml_(recs);
  }
  
  if (pe && pe.value) {
    saveDraft(pe.value);
  }
}

function saveDraft(poolId) {
  if (window._tourActive) return;
  if(!poolId) return;
  const draft = {};
  _formItems.forEach(item => {
    if(!item.title) return;
    let val;
    if(item.type==='CHECKBOX') {
      const bs=document.querySelectorAll('input'+svcNameSel_(item.title)+':checked');
      val=Array.from(bs).map(b=>b.value);
    } else {
      const el=document.querySelector(svcNameSel_(item.title));
      if(el) val=el.value;
    }
    draft[item.title] = val;
  });
  
  const sizeSel = document.getElementById('svc-size');
  if (sizeSel) draft['svc_size'] = sizeSel.value;
  const matSel = document.getElementById('svc-mat');
  if (matSel) draft['svc_mat'] = matSel.value;
  
  const condPill = document.querySelector('.cpill.active, .cpill.active-cloudy, .cpill.active-ok');
  if(condPill) draft['svc_cond'] = condPill.dataset.val;

  const tabPill = document.querySelector('.tbpill.tactive');
  if(tabPill) draft['svc_tab'] = tabPill.dataset.val;

  localStorage.setItem('svc_draft_' + poolId, JSON.stringify(draft));
}

function loadDraft(poolId) {
  if(!poolId) return;
  const stored = localStorage.getItem('svc_draft_' + poolId);
  if(!stored) return;
  try {
    const draft = JSON.parse(stored);
    _formItems.forEach(item => {
      if(!item.title || draft[item.title] === undefined) return;
      let val = draft[item.title];
      if(val === '' || (Array.isArray(val) && !val.length)) return;
      if(item.title.trim().toLowerCase() === 'pool_id') return; // Do not overwrite pool_id
      
      if(item.type === 'CHECKBOX') {
        const bs = document.querySelectorAll('input'+svcNameSel_(item.title));
        bs.forEach(b => b.checked = (val || []).includes(b.value));
      } else {
        const el = document.querySelector(svcNameSel_(item.title));
        if(el) el.value = val;
      }
    });

    if (draft['svc_size']) { let el = document.getElementById('svc-size'); if (el) el.value = draft['svc_size']; }
    if (draft['svc_mat']) { let el = document.getElementById('svc-mat'); if (el) el.value = draft['svc_mat']; }
    if (draft['svc_cond']) { 
       let pill = document.querySelector(`.cpill:not(.tbpill)[data-val="${draft['svc_cond']}"]`);
       if(pill) tCond(pill, draft['svc_cond']);
    }
    if (draft['svc_tab']) {
       let pill = document.querySelector(`.tbpill[data-val="${draft['svc_tab']}"]`);
       if(pill) tTablet(pill, draft['svc_tab']);
    }
  } catch(e) { console.error('Error loading draft', e); }
}

// Show the free-text "Pool description" field only when "Other / Pool not listed"
// is chosen — otherwise it's noise for a known client.
function _svcSyncPoolDescVisibility_(poolId) {
  const wrap = document.getElementById('svc-pool-desc-wrap');
  if (!wrap) return;
  const isOther = /^other\b/i.test(String(poolId || '').trim());
  wrap.style.display = isOther ? 'block' : 'none';
  if (!isOther) {
    const inp = wrap.querySelector('[name="Pool description (if Other selected)"]');
    if (inp) inp.value = '';
  }
}

function handlePoolChange() {
  const pe = document.querySelector('[name="pool_id"]');
  const poolId = pe ? pe.value : null;
  _svcSyncPoolDescVisibility_(poolId);
  if (poolId && window._lastLoadedPoolId !== poolId) {
    window._lastLoadedPoolId = poolId;
    initSvcPhotoState_();
    renderPhotoPreviews_();
    // Reset the cached recipient; the banner shows name/address from the label
    // immediately and the authoritative email fills in when context returns.
    window._svcRecipient = null;
    updateSvcIdentityBanner_(poolId, !!(pe && pe.disabled));
    loadPoolContextForSelection_(poolId).then(() => {
      loadDraft(poolId);
      loadSvcDraftPhotos_(poolId);
      runRecs(); // re-sync bands, recaps & treat rows after draft values load
    });
  } else if (!poolId) {
    window._lastLoadedPoolId = null;
    window._svcRecipient = null;
    initSvcPhotoState_();
    renderPhotoPreviews_();
    updateSvcIdentityBanner_(null, false);
  }
  runRecs();
}

function roundQ(v){return v===0?0:Math.round(v*4)/4;}  // nearest 0.25 gal (liquids)
function roundH(v){return v===0?0:Math.round(v*2)/2;}  // nearest 0.5 lbs (solids)

// ── Smart scoop conversion ──────────────────────────────────────────────────
// Lbs in one full smart scoop, per chemical. Used to show techs how many
// scoops a recommended lb amount equals so they can measure without a scale.
const SCOOP_LB = {
  'sodium bicarb':3.9, 'alkalinity increaser':3.9,
  'salt':3.8,
  'calcium chloride':3.0, 'calcium hardness increaser':3.0,
  'cal hypo':2.9,
  'cyanuric acid':2.4, 'stabilizer':2.4,
  'diatomaceous earth':1.0
};
function scoopHint(name, lbs){
  if(!(lbs>0)) return '';
  const n=(name||'').toLowerCase();
  let w=null;
  for(const k in SCOOP_LB){ if(n.indexOf(k)!==-1){ w=SCOOP_LB[k]; break; } }
  if(!w) return '';
  const scoops=Math.round((lbs/w)*4)/4;  // nearest 1/4 scoop
  if(scoops<=0) return '';
  return ' ('+scoops+' smart scoop'+(scoops===1?'':'s')+')';
}

const SALT_TARGET = 3200;  // ppm — target for saltwater chlorine generators (per salt chart)
function buildRecs(fc, ph, ta, ch, gal, mat, isG, salt) {
  const res = [], isS = SM.indexOf(new Date().getMonth()+1) !== -1, g = gal/10000;
  const szEl = document.getElementById('svc-size');
  const poolSize = szEl ? szEl.value : 'small';
  const tabLvl = getTabletLevel(); // 'low', 'medium', 'full', or null

  // ── Rule 1 — Tablet × Chlorine Matrix ──────────────────────────────────────
  if (tabLvl && tabLvl !== 'none' && fc !== null) {
    if (tabLvl === 'low') {
      if (fc < 2) {
        // Large pool special: 6 tablets + 3 gal chlorine
        if (poolSize === 'large') {
          res.push({name:'Chlorine Tablets', status:'bad', amt:'6 tablets', reason:'Large pool, low tablets + low chlorine — max tablet load.'});
          let lc = 3;
          if (isS) lc = roundQ(lc * 1.5);
          res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'Large pool shock dose to recover FC'+(isS?' (summer ×1.5)':'')+'.'});
        } else {
          res.push({name:'Chlorine Tablets', status:'bad', amt:'4 tablets', reason:'Low tablets + low chlorine — replenish tablets.'});
          let lc = roundQ(0.5 * g);
          if (isS) lc = roundQ(lc * 1.5);
          // Medium pool: always 2 gal when FC 0-2
          if (poolSize === 'medium' && lc < 2) lc = 2;
          res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'Reduced liquid dose — tablets will raise FC over the week'+(isS?' (summer ×1.5)':'')+'.'});
        }
      } else if (fc <= 5) {
        // Medium or in-range chlorine → add 4 tablets, no liquid
        res.push({name:'Chlorine Tablets', status:'warning', amt:'4 tablets', reason:'Low tablets — replenish. Chlorine level adequate, no liquid needed.'});
      } else {
        // High chlorine → add fewer tablets
        res.push({name:'Chlorine Tablets', status:'good', amt:'2 tablets', reason:'Low tablets but chlorine is high — add fewer tablets to maintain.'});
      }
    } else if (tabLvl === 'medium') {
      if (fc < 2) {
        res.push({name:'Chlorine Tablets', status:'warning', amt:'2 tablets', reason:'Medium tablets + low chlorine — top off tablets.'});
        let lc = 1;
        if (isS) lc = roundQ(lc * 1.5);
        if (poolSize === 'medium') lc = Math.max(lc, 2);
        if (poolSize === 'large') lc = Math.max(lc, 2);
        res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'FC critically low — add liquid chlorine'+(isS?' (summer ×1.5)':'')+'.'});
      } else if (fc <= 5) {
        res.push({name:'Chlorine Tablets', status:'good', amt:'2 tablets', reason:'Medium tablets — top off. Chlorine adequate.'});
      } else {
        // High chlorine, medium tablets → leave as is
        res.push({name:'Chlorine Tablets', status:'good', amt:'Leave as is', reason:'Tablets medium, chlorine high — no changes needed.'});
      }
    } else if (tabLvl === 'full') {
      // Full tablets → only suggest liquid chlorine if needed
      if (fc < 2) {
        let lc = roundQ(1 * g);
        if (isS) lc = roundQ(lc * 1.5);
        if (poolSize === 'medium') lc = Math.max(lc, 2);
        res.push({name:'Liquid Chlorine', status:'bad', amt:lc.toFixed(2)+' gal', reason:'Tablets full but FC low — add liquid chlorine'+(isS?' (summer ×1.5)':'')+'.'});
      } else if (fc < 3) {
        let lc = roundQ(0.5 * g);
        if (isS) lc = roundQ(lc * 1.5);
        res.push({name:'Liquid Chlorine', status:'warning', amt:lc.toFixed(2)+' gal', reason:'Tablets full, FC slightly low — small liquid dose'+(isS?' (summer ×1.5)':'')+'.'});
      }
      res.push({name:'Chlorinator', status:'good', amt:'Adjust chlorinator', reason:'Tablets full — adjust water flow in the chlorinator for optimal dissolve rate.'});
    }
  } else if (fc !== null && (!tabLvl || tabLvl === 'none')) {
    // No tablet level or "none" selected — fall back to original liquid chlorine logic
    let b = 1*g;
    if (isS) b *= 1.5;
    if (isG)       res.push({name:'Liquid Chlorine',status:'bad',    amt:roundQ(b*2).toFixed(2)+' gal',reason:'Green/algae — shock dose. Do NOT adjust pH/TA/CH until chlorine works 24-48 hrs.'});
    else if (fc<2) {
      let dose = roundQ(b*2);
      if (poolSize === 'medium') dose = Math.max(dose, 2);
      res.push({name:'Liquid Chlorine',status:'bad',amt:dose.toFixed(2)+' gal',reason:'FC critically low — double dose'+(isS?' + summer ×1.5':'')});
    }
    else if (fc<3) res.push({name:'Liquid Chlorine',status:'warning',amt:roundQ(b).toFixed(2)+' gal',  reason:'FC below target (3–5 ppm)'+(isS?' (summer ×1.5)':'')});
    else if (fc<=5)res.push({name:'Liquid Chlorine',status:'good',   amt:roundQ(b).toFixed(2)+' gal',  reason:'FC in range — maintenance dose to hold through week'+(isS?' (summer ×1.5)':'')});
  }

  // ── Algae override (always adds liquid chlorine regardless of tablets) ─────
  if (isG && fc !== null) {
    // Remove any existing liquid chlorine recs if algae
    for (let i = res.length - 1; i >= 0; i--) {
      if (res[i].name === 'Liquid Chlorine') res.splice(i, 1);
    }
    let b = 1*g;
    if (isS) b *= 1.5;
    res.push({name:'Liquid Chlorine',status:'bad',amt:roundQ(b*2).toFixed(2)+' gal',reason:'Green/algae — shock dose. Do NOT adjust pH/TA/CH until chlorine works 24-48 hrs.'});
  }

  // ── Rule 2 — pH / Muriatic Acid or Soda Ash ───────────────────────────────
  if (ph !== null) {
    if (ph < 7.2) {
      res.push({name:'Soda Ash',status:'bad',amt:'As needed',reason:'pH below 7.2 — raise carefully, test before adding more.'});
    } else if (!isG && ph > 7.6) {
      let a = 0.5*g;
      if (mat === 'fiberglass') a *= 0.75;
      // Pool-size acid caps
      if (poolSize === 'medium') a = Math.min(a, 0.75);
      else if (poolSize === 'large') a = Math.min(a, 1.0);
      else a = Math.min(a, 0.5); // small pool default cap
      a = Math.max(roundQ(a), 0.25);
      res.push({name:'Muriatic Acid',status:ph>=8?'bad':'warning',amt:a.toFixed(2)+' gal',reason:'Lower pH to 7.2–7.6. One dose max per visit.'+(mat==='fiberglass'?' (reduced — fiberglass)':'')+(poolSize==='medium'?' (cap: 0.75 gal for medium pool)':'')+(poolSize==='large'?' (cap: 1.0 gal for large pool)':'')});
    } else if (isG && ph > 7.6) {
      res.push({name:'Muriatic Acid',status:'warning',amt:'Hold — after shock',reason:'Green pool: shock first, adjust pH after 24-48 hrs.'});
    }
  }

  // ── Rule 3 — Alkalinity ────────────────────────────────────────────────────
  if (ta !== null && ta < 80 && !isG) {
    const lbs=roundH(1.4*g*((100-ta)/10));
    res.push({name:'Alkalinity Increaser (Sodium Bicarb)',status:'warning',amt:lbs.toFixed(1)+' lbs'+scoopHint('sodium bicarb',lbs),reason:'Raise TA to 100 ppm (target 80–120 ppm)'});
  }

  // ── Rule 4 — Calcium Hardness ─────────────────────────────────────────────
  if (ch !== null && !isG) {
    if (ch < 250) {
      const lbs=roundH(1.2*g*((280-ch)/10));
      res.push({name:'Calcium Hardness Increaser',status:'warning',amt:lbs.toFixed(1)+' lbs'+scoopHint('calcium hardness increaser',lbs),reason:'Raise CH to 280 ppm (target 250–350 ppm).'+(mat==='plaster'?' Keep CH toward upper range for plaster surfaces.':'')});
    }
  }

  // ── Rule 5 — Salt (saltwater pools — target 3200 ppm, per salt chart) ─────
  if (salt !== null && salt < SALT_TARGET) {
    // lbs = gallons × (target − current) ppm × 8.34 / 1,000,000
    const lbs = Math.round(gal * (SALT_TARGET - salt) * 8.34 / 1000000);
    if (lbs > 0) {
      res.push({name:'Salt',status:'warning',amt:lbs+' lbs'+scoopHint('salt',lbs),reason:'Raise salt from '+salt+' to '+SALT_TARGET+' ppm for the chlorine generator.'});
    }
  }

  // ── Rule 6 — Algae Protocol banner (always first) ─────────────────────────
  if (isG) res.unshift({name:'ALGAE PROTOCOL',status:'bad',amt:'Shock first',reason:'Brush walls & floor. Double-dose chlorine. Wait 24-48 hrs before adjusting pH, TA, or CH.'});

  return res;
}

function submitSvc(){
  if(window._tourActive) return; // tour in progress — do not submit real service log
  const payload={};let hasErr=false;
  _formItems.forEach(item=>{
    if(!item.title)return;let val;
    if(item.type==='CHECKBOX'){const bs=document.querySelectorAll('input'+svcNameSel_(item.title)+':checked');val=Array.from(bs).map(b=>b.value);if(!val.length)val=null;}
    else{const el=document.querySelector(svcNameSel_(item.title));if(el)val=el.value.trim();}
    const _softOpt = (item.title === 'Calcium Hardness (CH)');
    if(item.isRequired && !_softOpt &&(!val||(Array.isArray(val)&&!val.length)))hasErr=true;
    if(val)payload[item.title]=val;
  });

  // ── Mandatory test results & pool_id ────────
  const missingFields = [];
  _formItems.forEach(i => {
    if (!i.title) return;
    const t = i.title.trim();
    const tLower = t.toLowerCase();
    
    // Only these 4 are strictly mandatory by code request
    const isMainMandatory = (t === 'pH' || t === 'Free Chlorine (FC)' || t === 'Total Alkalinity (TA)' || tLower === 'pool_id');
    
    if (isMainMandatory || i.isRequired) {
      if (!payload[i.title] || (Array.isArray(payload[i.title]) && !payload[i.title].length) || payload[i.title].toString().trim() === '') {
        missingFields.push(i.title);
      }
    }
  });

  if (missingFields.length || hasErr) {
    let errStr = missingFields.length ? ('Please fill in required fields:\n' + missingFields.join(', ')) : 'Fill out all required fields.';
    alert(errStr);
    // Jump to the step holding the first missing field so the tech can see it.
    if (missingFields.length && typeof svcGoStep === 'function') svcGoStep(_svcStepOfField_(missingFields[0]));
    missingFields.forEach((f, idx) => {
      const el = document.querySelector(svcNameSel_(f));
      if (el) { el.style.borderColor = 'var(--error)'; if (idx === 0) el.focus(); el.addEventListener('input', () => { el.style.borderColor = ''; }, { once: true }); }
    });
    return;
  }

  // ── Include portal-only fields in payload ──────────────────────────────────
  const sizeSel = document.getElementById('svc-size');
  if (sizeSel && sizeSel.value) payload['Pool Size'] = sizeSel.value;
  const matSel = document.getElementById('svc-mat');
  if (matSel && matSel.value) payload['Pool Material'] = matSel.value;

  const tabletLevel = getTabletLevel();
  if (tabletLevel) payload['Tablet Level'] = tabletLevel;

  const internalNotes = document.getElementById('svc-internal-notes');
  if (internalNotes && internalNotes.value) payload['Internal Notes'] = internalNotes.value;

  // Arrive-step "Start Service" timestamp (tracked on the log; no SMS/GPS).
  if (window._svcStartedAt) payload['Service Started At'] = window._svcStartedAt;

  const ap = document.querySelector('.cpill:not(.chpill).active, .cpill:not(.chpill).active-cloudy, .cpill:not(.chpill).active-ok');
  if(ap) payload['Notes'] = ((payload['Notes']||'') + ' [Condition: '+ap.dataset.val+']').trim();

  // ── Chlorinator power adjustment (Adjusted checkbox + direction) ───────────
  const chlorCb = document.getElementById('svc-chlor-adj');
  if (chlorCb && chlorCb.checked) {
    const dir = document.querySelector('#svc-chlor-dir .chpill.active-ok');
    payload['Chlorinator Adjustment'] = dir ? dir.dataset.val : 'Adjusted';
  }

  // Inject technician name from portal session
  if(_s && _s.name) payload['Technician'] = _s.name;

  // Tell GAS exactly which static fields this client considers chemical usage.
  payload['_chemical_fields'] = JSON.stringify(SVC_CHEMICAL_FIELDS);

  // Preserve the exact scheduled service identity when the log was launched
  // from the route card. This lets admin completion checks distinguish a
  // one-time/startup/GTC visit from the same pool's recurring service.
  if (window._pendingSvcMeta && window._pendingSvcMeta.scheduled_visit_id) {
    payload['_scheduled_visit_id'] = window._pendingSvcMeta.scheduled_visit_id;
    payload['_service_visit_id'] = window._pendingSvcMeta.scheduled_visit_id;
  }
  if (window._pendingSvcMeta && window._pendingSvcMeta.visit_type) {
    payload['_visit_type'] = window._pendingSvcMeta.visit_type;
  }

  // ── Chemical range validation ─────────────────────────────────────────────
  const CHEM_RANGES = {
    'pH':                    { min: 6.8,  max: 8.5,   label: 'pH'                    },
    'Free Chlorine (FC)':    { min: 0,    max: 15,    label: 'Free Chlorine (FC)'    },
    'Total Alkalinity (TA)': { min: 50,   max: 350,   label: 'Total Alkalinity (TA)' },
    'Calcium Hardness (CH)': { min: 0,    max: 2000,  label: 'Calcium Hardness (CH)' },
  };
  const outOfRange = [];
  Object.entries(CHEM_RANGES).forEach(([field, r]) => {
    const raw = payload[field];
    if (raw === undefined || raw === '') return;
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    if (val < r.min || val > r.max) {
      outOfRange.push(`${r.label}: ${val} (valid range ${r.min}–${r.max})`);
    }
  });
  if (outOfRange.length) {
    const msg = 'These readings look unusual — double-check before submitting:\n\n' + outOfRange.join('\n') + '\n\nTap OK to submit anyway, or Cancel to go back and correct.';
    if (!confirm(msg)) return;
  }

  const missingPhotos = svcMissingRequiredPhotos_();
  if (missingPhotos.length) {
    alert('Please attach required service photos:\n' + missingPhotos.join(', '));
    // Jump to the step holding the first missing photo so the tech can reach it.
    const firstSlot = SVC_PHOTO_SLOTS.find(s => s.required && missingPhotos.indexOf(s.label) !== -1);
    const photoStepById = { before:0, equipment:5, after:5, other:6 };
    if (firstSlot && typeof svcGoStep === 'function') svcGoStep(photoStepById[firstSlot.id] != null ? photoStepById[firstSlot.id] : _svcStep);
    highlightMissingPhotoSlots_(missingPhotos);
    return;
  }

  showSvcConfirm(payload);
}
function showSvcConfirm(payload){
  window._svcPayload=payload;

  // ── Hero: WHO this report is going to (wrong-pool mitigation, Layer 2) ──────
  let poolLabel = payload['pool_id'] || '';
  if (!poolLabel) {
    const pk = Object.keys(payload).find(k => k.trim().toLowerCase() === 'pool_id');
    if (pk) poolLabel = payload[pk];
  }
  const rec = window._svcRecipient || {};
  const parsed = _parsePoolLabel_(poolLabel);
  const name = rec.name || parsed.name || '—';
  const address = rec.address || parsed.address || '';

  const hero =
    '<div style="background:#f0fdfa;border:2px solid var(--teal,#0d4d44);border-radius:12px;padding:14px 16px;margin-bottom:14px">'
    + '<div style="font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:#0d4d44;opacity:.8;font-family:Oswald,sans-serif">You are submitting a visit for</div>'
    + '<div style="font-size:1.35rem;font-weight:700;font-family:Oswald,sans-serif;color:#0d4d44;line-height:1.15;margin-top:2px">' + escHtml(name) + '</div>'
    + (address ? '<div style="font-size:.9rem;color:#334155;margin-top:2px">' + escHtml(address) + '</div>' : '')
    + '</div>';

  // ── Collapsed detail dump (unchanged data, just tucked away) ────────────────
  const rows=Object.entries(payload).filter(([k]) => String(k || '').charAt(0) !== '_').map(([k,v])=>
    '<div class="conf-row"><span class="conf-key">'+k+'</span><span class="conf-val">'+(Array.isArray(v)?v.join(', '):v)+'</span></div>'
  ).join('');
  const pc=svcPhotoCount_();
  const photoRows=SVC_PHOTO_SLOTS.map(slot => {
    const attached = !!svcPhotoForSlot_(slot.id);
    return '<div class="conf-row"><span class="conf-key">'+escHtml(slot.label)+'</span><span class="conf-val">'+(attached?'attached':(slot.required?'missing':'optional'))+'</span></div>';
  }).join('');
  const photoRow=pc?photoRows:'';
  const details = '<details style="margin-top:4px"><summary style="cursor:pointer;font-size:.85rem;color:#0d4d44;font-weight:600;padding:4px 0">Show all details</summary><div style="margin-top:8px">' + rows + photoRow + '</div></details>';

  document.getElementById('conf-modal-body').innerHTML = hero + details;
  document.getElementById('conf-modal-backdrop').classList.add('open');
}
function closeSvcConfirm(event){
  if(event&&event.target!==document.getElementById('conf-modal-backdrop'))return;
  document.getElementById('conf-modal-backdrop').classList.remove('open');
}
function confirmAndSubmit(){
  document.getElementById('conf-modal-backdrop').classList.remove('open');
  _doSvcSubmit_(window._svcPayload, svcPhotosForSubmit_());
}

function _doSvcSubmit_(payload, photos) {
  const btn = document.getElementById('btn-svc');
  if (btn) { btn.disabled = true; btn.textContent = photos.length ? 'Uploading ' + photos.length + ' photo(s)...' : 'Submitting...'; }

  if (!navigator.onLine) {
    _svcQueueAndBail_(payload, photos);
    return;
  }

  api({ secret:SEC, action:'submit_form', token:_s.token, data:payload, photos:photos }).then(res => {
    if (res.ok) {
      _onSvcSuccess_(payload, photos.length, res);
    } else {
      if (btn) { btn.disabled = false; btn.innerHTML = '<span id="svc-nav-next-label">Complete &amp; Send</span> ›'; }
      if (document.getElementById('svc-root')) alert('Error: ' + res.error);
    }
  }).catch(() => {
    _svcQueueAndBail_(payload, photos);
  });
}

function _svcQueueAndBail_(payload, photos) {
  try {
    localStorage.setItem('svc_queued_submit', JSON.stringify({ payload, photos, ts: Date.now() }));
  } catch(e) {
    try { localStorage.setItem('svc_queued_submit', JSON.stringify({ payload, photos: [], ts: Date.now() })); } catch(_) {}
  }
  window._svcPayload = payload;
  window._svcPhotos = photos;
  window.addEventListener('online', _onSvcOnline_, { once: true });

  // Show saved screen so tech can move to next pool immediately
  const root = document.getElementById('svc-root');
  if (root) {
    root.innerHTML = '<div style="text-align:center;padding:3rem 1rem">'
      + '<div style="font-size:3.5rem;margin-bottom:1rem">💾</div>'
      + '<div style="font-family:Oswald,sans-serif;font-size:1.8rem;font-weight:700;letter-spacing:.1em;color:#0d4d44;margin-bottom:.5rem">LOG SAVED</div>'
      + '<p style="color:#64748b;margin-bottom:1.5rem">No signal — your log is saved and will send automatically when you\'re back online.</p>'
      + '<button onclick="resetSvc()" style="display:block;width:100%;padding:.85rem 1.75rem;background:#0d4d44;color:#fff;border:none;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-bottom:.75rem">Log Another Pool</button>'
      + '<button onclick="navigateTo(\'live_map\')" style="display:block;width:100%;padding:.85rem 1.75rem;background:transparent;color:#0d4d44;border:2px solid #0d4d44;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer">Back to Hub</button>'
      + '</div>';
  }
}

function _showSvcRetryBanner_(msg) {
  const root = document.getElementById('svc-root');
  if (!root) return;
  let b = document.getElementById('svc-retry-banner');
  if (!b) { b = document.createElement('div'); b.id = 'svc-retry-banner'; b.className = 'svc-retry-banner'; root.insertBefore(b, root.firstChild); }
  b.innerHTML = '<div class="svc-retry-msg">⚠️ ' + msg + '</div><button class="svc-retry-btn" onclick="_retrySvcNow_()">Retry</button>';
}

function _retrySvcNow_() {
  const raw = localStorage.getItem('svc_queued_submit');
  if (!raw) return;
  try {
    const { payload, photos } = JSON.parse(raw);
    window._svcPayload = payload;
    window._svcPhotos = photos || [];
    const b = document.getElementById('svc-retry-banner');
    if (b) b.remove();
    _doSvcSubmit_(payload, photos || []);
  } catch(e) {}
}

function _onSvcOnline_() {
  const raw = localStorage.getItem('svc_queued_submit');
  if (!raw) return;
  try {
    const { payload, photos } = JSON.parse(raw);
    window._svcPayload = payload;
    window._svcPhotos = photos || [];
    _showSvcRetryBanner_('Signal back — sending now...');
    _doSvcSubmit_(payload, photos || []);
  } catch(e) {}
}

function _onSvcSuccess_(payload, photoCount, res) {
  res = res || {};
  localStorage.removeItem('svc_queued_submit');
  window.removeEventListener('online', _onSvcOnline_);
  const poolIdKey = Object.keys(payload).find(k => k.trim().toLowerCase() === 'pool_id');
  const pId = poolIdKey ? payload[poolIdKey] : null;
  const scheduledVisitId = payload['_scheduled_visit_id'] || payload['_service_visit_id'] || '';
  const routeMeta = Object.assign({}, window._pendingSvcMeta || {});
  if (typeof markSvcSubmittedInRoute_ === 'function') {
    markSvcSubmittedInRoute_(payload, routeMeta);
  }
  if (pId) {
    localStorage.removeItem('svc_draft_' + pId);
    clearSvcDraftPhotos_(pId, scheduledVisitId);
    if (_activeDay && _routeData && _routeData.week_start) {
      const doneKey = `mcps_logged_${_routeData.week_start}_${_activeDay}`;
      const done = JSON.parse(localStorage.getItem(doneKey) || '[]');
      if (!done.includes(pId)) { done.push(pId); localStorage.setItem(doneKey, JSON.stringify(done)); }
      if (routeMeta.pool_id && !done.includes(routeMeta.pool_id)) {
        done.push(routeMeta.pool_id);
        localStorage.setItem(doneKey, JSON.stringify(done));
      }
      if (scheduledVisitId && !done.includes(scheduledVisitId)) {
        done.push(scheduledVisitId);
        localStorage.setItem(doneKey, JSON.stringify(done));
      }
    }
  }
  window._lastLoadedPoolId = null;
  window._pendingSvcMeta = null;

  // Capture what we need to reverse the local "completed" markings if the tech
  // undoes the send (wrong pool). doneKey/ids mirror the writes just above.
  const _undoDoneKey = (pId && _activeDay && _routeData && _routeData.week_start)
    ? `mcps_logged_${_routeData.week_start}_${_activeDay}` : null;
  window._svcUndoCtx = {
    uid: res.log_uid || '',
    doneKey: _undoDoneKey,
    ids: [pId, routeMeta.pool_id, scheduledVisitId].filter(Boolean)
  };

  const _successRoot = document.getElementById('svc-root');
  if (!_successRoot) return; // background send — DOM not visible, nothing to update

  const canUndo = !!(res.undoable && res.log_uid);
  const undoSecs = res.undo_seconds || 60;
  const undoBar = canUndo
    ? '<div id="svc-undo-bar" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:12px 14px;margin-bottom:1.25rem;display:flex;align-items:center;justify-content:space-between;gap:12px">'
        + '<div style="text-align:left;min-width:0"><div style="font-size:.85rem;color:#92400e;font-weight:600">Wrong pool? You can still stop it.</div>'
        + '<div style="font-size:.75rem;color:#b45309">Customer email sends in <span id="svc-undo-count">' + undoSecs + '</span>s</div></div>'
        + '<button id="svc-undo-btn" onclick="_undoSvcSend_()" style="background:#b45309;color:#fff;border:none;padding:8px 14px;border-radius:10px;font-family:Oswald,sans-serif;font-weight:600;font-size:.85rem;cursor:pointer;white-space:nowrap">↩ UNDO</button>'
        + '</div>'
    : '';
  const subtitle = canUndo
    ? 'Log received. The customer report sends shortly — undo below if this was the wrong pool.'
    : 'Log written, inventory deducted, email sent.';

  _successRoot.innerHTML = '<div style="text-align:center;padding:3rem 1rem">'
    + '<div style="font-size:3.5rem;margin-bottom:1rem">✅</div>'
    + '<div style="font-family:Oswald,sans-serif;font-size:1.8rem;font-weight:700;letter-spacing:.1em;color:#0d4d44;margin-bottom:.5rem">SUBMITTED</div>'
    + '<p style="color:#64748b;margin-bottom:.35rem">' + subtitle + '</p>'
    + (photoCount ? '<p style="color:#64748b;font-size:.85rem;margin-bottom:1.5rem">📸 ' + photoCount + ' photo' + (photoCount > 1 ? 's' : '') + ' saved to Drive.</p>' : '<br>')
    + undoBar
    + '<button onclick="returnToScheduleAfterSubmit()" style="display:block;width:100%;padding:.85rem 1.75rem;background:#0d4d44;color:#fff;border:none;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-bottom:.75rem">Back to Schedule</button>'
    + '<button onclick="resetSvc()" style="display:block;width:100%;padding:.85rem 1.75rem;background:transparent;color:#0d4d44;border:2px solid #0d4d44;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer">Log Another Pool</button>'
    + '</div>';

  if (canUndo) _startSvcUndoCountdown_(undoSecs);
}

// Countdown for the undo window. When it hits 0 the button disappears (the
// server-side trigger fires shortly after and the report is sent).
function _startSvcUndoCountdown_(secs) {
  if (window._svcUndoTimer) { clearInterval(window._svcUndoTimer); }
  let remaining = secs;
  window._svcUndoTimer = setInterval(function () {
    remaining--;
    const countEl = document.getElementById('svc-undo-count');
    if (countEl) countEl.textContent = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(window._svcUndoTimer);
      window._svcUndoTimer = null;
      const bar = document.getElementById('svc-undo-bar');
      if (bar) bar.remove();
    }
  }, 1000);
}

function _undoSvcSend_() {
  const ctx = window._svcUndoCtx || {};
  if (!ctx.uid) return;
  if (window._svcUndoTimer) { clearInterval(window._svcUndoTimer); window._svcUndoTimer = null; }
  const btn = document.getElementById('svc-undo-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

  api({ secret:SEC, action:'cancel_service_log', token:_s.token, log_uid: ctx.uid }).then(res => {
    const root = document.getElementById('svc-root');
    if (res && res.ok) {
      // Reverse the local "completed" markings so the schedule no longer shows it done.
      if (ctx.doneKey) {
        try {
          const done = JSON.parse(localStorage.getItem(ctx.doneKey) || '[]').filter(id => ctx.ids.indexOf(id) === -1);
          localStorage.setItem(ctx.doneKey, JSON.stringify(done));
        } catch (e) {}
      }
      if (typeof _clearRouteCache === 'function') _clearRouteCache();
      window._svcUndoCtx = null;
      if (root) {
        root.innerHTML = '<div style="text-align:center;padding:3rem 1rem">'
          + '<div style="font-size:3.5rem;margin-bottom:1rem">↩️</div>'
          + '<div style="font-family:Oswald,sans-serif;font-size:1.8rem;font-weight:700;letter-spacing:.1em;color:#0d4d44;margin-bottom:.5rem">CANCELLED</div>'
          + '<p style="color:#64748b;margin-bottom:1.5rem">Nothing was sent — no email, no inventory change. Log the correct pool now.</p>'
          + '<button onclick="resetSvc()" style="display:block;width:100%;padding:.85rem 1.75rem;background:#0d4d44;color:#fff;border:none;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-bottom:.75rem">Log Correct Pool</button>'
          + '<button onclick="navigateTo(\'live_map\')" style="display:block;width:100%;padding:.85rem 1.75rem;background:transparent;color:#0d4d44;border:2px solid #0d4d44;border-radius:12px;font-family:Oswald,sans-serif;font-size:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer">Back to Hub</button>'
          + '</div>';
      }
    } else {
      const bar = document.getElementById('svc-undo-bar');
      if (bar) bar.innerHTML = '<span style="color:#991b1b;font-size:.85rem">Could not cancel' + (res && res.error ? ': ' + res.error : '') + '. The report may have already sent.</span>';
    }
  }).catch(() => {
    const bar = document.getElementById('svc-undo-bar');
    if (bar) bar.innerHTML = '<span style="color:#991b1b;font-size:.85rem">Network error — could not cancel.</span>';
  });
}
// ── Photo handlers ──────────────────────────────────────────────────────────
const MAX_PHOTOS = 5;
const MAX_ORIGINAL_PHOTO_BYTES = 50 * 1024 * 1024;
const SVC_PHOTO_DB_NAME = 'mcps_service_log_photo_drafts';
const SVC_PHOTO_DB_STORE = 'photos';
let _svcPhotoDbPromise = null;

function initSvcPhotoState_() {
  window._svcPhotos = {};
  SVC_PHOTO_SLOTS.forEach(slot => { window._svcPhotos[slot.id] = null; });
}

function svcPhotoSlot_(slotId) {
  return SVC_PHOTO_SLOTS.find(slot => slot.id === slotId) || null;
}

function svcPhotoForSlot_(slotId) {
  if (Array.isArray(window._svcPhotos)) return null;
  return window._svcPhotos && window._svcPhotos[slotId] ? window._svcPhotos[slotId] : null;
}

function svcPhotoCount_() {
  if (Array.isArray(window._svcPhotos)) return window._svcPhotos.length;
  return SVC_PHOTO_SLOTS.filter(slot => svcPhotoForSlot_(slot.id)).length;
}

function svcPhotosForSubmit_() {
  if (Array.isArray(window._svcPhotos)) return window._svcPhotos;
  return SVC_PHOTO_SLOTS.map(slot => {
    const photo = svcPhotoForSlot_(slot.id);
    return photo ? { base64: photo.base64, mimeType: photo.mimeType || 'image/jpeg', name: slot.fileName } : null;
  }).filter(Boolean);
}

function svcMissingRequiredPhotos_() {
  return SVC_PHOTO_SLOTS
    .filter(slot => slot.required && !svcPhotoForSlot_(slot.id))
    .map(slot => slot.label);
}

function highlightMissingPhotoSlots_(missingLabels) {
  SVC_PHOTO_SLOTS.forEach(slot => {
    const el = document.getElementById('svc-photo-slot-' + slot.id);
    if (!el) return;
    const missing = missingLabels.indexOf(slot.label) !== -1;
    el.classList.toggle('missing', missing);
    if (missing) setTimeout(() => el.classList.remove('missing'), 2200);
  });
  const first = SVC_PHOTO_SLOTS.find(slot => missingLabels.indexOf(slot.label) !== -1);
  const firstEl = first ? document.getElementById('svc-photo-slot-' + first.id) : null;
  if (firstEl) firstEl.scrollIntoView({ behavior:'smooth', block:'center' });
}

function triggerSvcPhotoInput_(slotId, source) {
  const input = document.getElementById('svc-photo-' + slotId + '-' + source);
  if (input) input.click();
}

async function handlePhotoSlotSelect(input, slotId) {
  const slot = svcPhotoSlot_(slotId);
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  if (!slot || !file) return;
  const draftKey = svcCurrentPhotoDraftKey_();
  if (!draftKey) {
    alert('Select the pool before attaching photos so the draft can be saved.');
    return;
  }
  if (isUnsupportedPhoto_(file)) {
    alert('HEIC photos are not supported yet. Please choose JPEG or PNG.');
    return;
  }
  if (file.size > MAX_ORIGINAL_PHOTO_BYTES) {
    alert((file.name || 'Photo') + ' is too large to process (max ' + formatPhotoBytes_(MAX_ORIGINAL_PHOTO_BYTES) + ' before compression).');
    return;
  }
  setSvcPhotoSlotProcessing_(slotId, true);
  const compressed = await compressPhoto_(file);
  setSvcPhotoSlotProcessing_(slotId, false);
  if (!compressed) {
    alert('Could not read ' + (file.name || 'that photo') + '. Please try a JPEG or PNG.');
    return;
  }
  window._svcPhotos[slotId] = { base64: compressed.base64, mimeType: compressed.mimeType || 'image/jpeg', name: slot.fileName };
  renderPhotoPreviews_();
  saveSvcDraftPhoto_(slotId);
}

function formatPhotoBytes_(bytes) {
  const mb = bytes / (1024 * 1024);
  return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
}

function isUnsupportedPhoto_(file) {
  return /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
}

function compressPhoto_(file) {
  return new Promise(resolve => {
    const MAX_DIM = 1200;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
        else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(blob => {
        if (!blob) { resolve(null); return; }
        const r = new FileReader();
        r.onload = e => resolve({ base64: e.target.result.split(',')[1], mimeType: 'image/jpeg', name: file.name.replace(/\.\w+$/, '.jpg') });
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      }, 'image/jpeg', 0.72);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function setSvcPhotoSlotProcessing_(slotId, processing) {
  const el = document.getElementById('svc-photo-slot-' + slotId);
  if (!el) return;
  el.classList.toggle('processing', !!processing);
  const actions = el.querySelectorAll('button');
  actions.forEach(btn => { btn.disabled = !!processing; });
}

function removePhoto_(slotId) {
  if (!window._svcPhotos || Array.isArray(window._svcPhotos)) initSvcPhotoState_();
  if (window._svcPhotos[slotId]) window._svcPhotos[slotId] = null;
  renderPhotoPreviews_();
  removeSvcDraftPhoto_(slotId);
}

function renderPhotoPreviews_() {
  const countWrap = document.getElementById('photo-count-wrap');
  SVC_PHOTO_SLOTS.forEach(slot => {
    const card = document.getElementById('svc-photo-slot-' + slot.id);
    if (!card) return;
    const empty = card.querySelector('.svc-photo-empty');
    const filled = card.querySelector('.svc-photo-filled');
    const photo = svcPhotoForSlot_(slot.id);
    card.classList.toggle('has-photo', !!photo);
    if (empty) empty.style.display = photo ? 'none' : 'block';
    if (!filled) return;
    if (!photo) {
      filled.style.display = 'none';
      filled.innerHTML = '';
      return;
    }
    filled.style.display = 'block';
    filled.innerHTML =
      '<div class="photo-thumb svc-photo-thumb">'
      + '<img src="data:' + (photo.mimeType || 'image/jpeg') + ';base64,' + photo.base64 + '" alt="' + escHtml(slot.label) + ' photo">'
      + '<div class="svc-photo-thumb-label">' + escHtml(slot.label) + '</div>'
      + '</div>'
      + '<div class="svc-photo-actions filled-actions">'
      + '<button type="button" class="svc-photo-action primary" onclick="triggerSvcPhotoInput_(\'' + slot.id + '\',\'camera\')">Retake</button>'
      + '<button type="button" class="svc-photo-action" onclick="triggerSvcPhotoInput_(\'' + slot.id + '\',\'library\')">Replace</button>'
      + '<button type="button" class="svc-photo-action danger" onclick="removePhoto_(\'' + slot.id + '\')">Remove</button>'
      + '</div>';
  });
  if (countWrap) countWrap.innerHTML = '<span class="photo-count-badge">' + svcPhotoCount_() + ' / ' + MAX_PHOTOS + ' photos</span>';
  _svcRenderCompletePanel_();
}

function svcSelectedPoolId_() {
  const pe = document.querySelector('[name="pool_id"]');
  return pe && pe.value ? pe.value : '';
}

function svcPhotoDraftKeyFor_(poolId, scheduledVisitId) {
  if (scheduledVisitId) return 'visit:' + scheduledVisitId;
  if (poolId) return 'pool:' + poolId;
  return '';
}

function svcCurrentPhotoDraftKey_(poolId) {
  const meta = window._pendingSvcMeta || {};
  return svcPhotoDraftKeyFor_(poolId || svcSelectedPoolId_(), meta.scheduled_visit_id || '');
}

function svcDraftPhotoRecordKey_(draftKey, slotId) {
  return draftKey + '::' + slotId;
}

function svcIdbRequest_(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function svcPhotoDb_() {
  if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
  if (_svcPhotoDbPromise) return _svcPhotoDbPromise;
  _svcPhotoDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(SVC_PHOTO_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SVC_PHOTO_DB_STORE)) db.createObjectStore(SVC_PHOTO_DB_STORE, { keyPath:'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open photo draft storage'));
  });
  return _svcPhotoDbPromise;
}

function saveSvcDraftPhoto_(slotId) {
  const draftKey = svcCurrentPhotoDraftKey_();
  const photo = svcPhotoForSlot_(slotId);
  if (!draftKey || !photo) return;
  svcPhotoDb_().then(db => {
    const tx = db.transaction(SVC_PHOTO_DB_STORE, 'readwrite');
    tx.objectStore(SVC_PHOTO_DB_STORE).put({
      key: svcDraftPhotoRecordKey_(draftKey, slotId),
      draftKey,
      slotId,
      photo,
      updatedAt: Date.now()
    });
  }).catch(e => console.warn('Photo draft save failed', e));
}

function loadSvcDraftPhotos_(poolId) {
  const draftKey = svcCurrentPhotoDraftKey_(poolId);
  if (!draftKey) return;
  svcPhotoDb_().then(db => {
    const tx = db.transaction(SVC_PHOTO_DB_STORE, 'readonly');
    const store = tx.objectStore(SVC_PHOTO_DB_STORE);
    return Promise.all(SVC_PHOTO_SLOTS.map(slot => svcIdbRequest_(store.get(svcDraftPhotoRecordKey_(draftKey, slot.id)))));
  }).then(records => {
    if (draftKey !== svcCurrentPhotoDraftKey_(poolId)) return;
    if (!window._svcPhotos || Array.isArray(window._svcPhotos)) initSvcPhotoState_();
    records.forEach(record => {
      if (record && record.slotId && record.photo) window._svcPhotos[record.slotId] = record.photo;
    });
    renderPhotoPreviews_();
  }).catch(e => console.warn('Photo draft load failed', e));
}

function removeSvcDraftPhoto_(slotId) {
  const draftKey = svcCurrentPhotoDraftKey_();
  if (!draftKey) return;
  svcPhotoDb_().then(db => {
    const tx = db.transaction(SVC_PHOTO_DB_STORE, 'readwrite');
    tx.objectStore(SVC_PHOTO_DB_STORE).delete(svcDraftPhotoRecordKey_(draftKey, slotId));
  }).catch(e => console.warn('Photo draft remove failed', e));
}

function clearSvcDraftPhotos_(poolId, scheduledVisitId) {
  const draftKey = svcPhotoDraftKeyFor_(poolId, scheduledVisitId);
  if (!draftKey) return;
  svcPhotoDb_().then(db => {
    const tx = db.transaction(SVC_PHOTO_DB_STORE, 'readwrite');
    const store = tx.objectStore(SVC_PHOTO_DB_STORE);
    SVC_PHOTO_SLOTS.forEach(slot => store.delete(svcDraftPhotoRecordKey_(draftKey, slot.id)));
  }).catch(e => console.warn('Photo draft clear failed', e));
}

function resetSvc(){
  document.getElementById('svc-root').style.display='none';
  document.getElementById('svc-root').innerHTML='';
  loadServiceLog();
}
