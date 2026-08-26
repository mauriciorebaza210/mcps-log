// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — config, icons, roles, sidebar structure
// ══════════════════════════════════════════════════════════════════════════════

// TODO: Replace with new GAS deployment URL after rotating in Apps Script editor
const AS  = 'https://script.google.com/macros/s/AKfycbxFrdZRbkXuGuazfqf7q-rKp-T-3DinM8t_3Pp5i6Efr7tciDU59Go6L7s3kxCQl9I/exec';
const SEC = '220ed543794285b632c27dec0b1b6529';

// ── Scope of Work: bundled fallback library ──────────────────────────────────
// Tier 0 of the three-tier load. Shipping these in the bundle means the quote
// tool's scope list renders at 0ms even on a cold cache with a dead network —
// it never blocks on Apps Script. localStorage (tier 1) and a background refresh
// from the Scope_Library sheet (tier 2) layer on top.
//
// ⚠️ These mirror the server-side defaults in buildProposalScopeHtml_
// (appscript/SalesHub.js). They are a floor, not the source of truth — anything
// saved to the Scope_Library sheet supersedes them once it loads.
const SCOPE_LIBRARY_FALLBACK = [
  { scope_item_id:'_w1', label:'Weekly pool service',          service_types:['weekly'], default_on:true,  sort_order:10 },
  { scope_item_id:'_w2', label:'Water testing and balancing',  service_types:['weekly','startup','g2c'], default_on:true, sort_order:20 },
  { scope_item_id:'_w3', label:'Clean pool baskets',           service_types:['weekly','g2c'], default_on:true, sort_order:30 },
  { scope_item_id:'_w4', label:'Equipment inspection',         service_types:['weekly','startup'], default_on:true, sort_order:40 },
  { scope_item_id:'_w5', label:'Weekly service report',        service_types:['weekly'], default_on:true,  sort_order:50 },
  { scope_item_id:'_w6', label:'Filter cleaning and inspection', service_types:['weekly','g2c'], default_on:false, sort_order:60 },
  { scope_item_id:'_w7', label:'24-hour emergency response',   service_types:['weekly'], default_on:false, sort_order:70 },
  { scope_item_id:'_s1', label:'Startup chemical work',        service_types:['startup'], default_on:true, sort_order:10 },
  { scope_item_id:'_s2', label:'Equipment programming support',service_types:['startup'], default_on:true, sort_order:20 },
  { scope_item_id:'_g1', label:'Green pool cleanup',           service_types:['g2c'], default_on:true, sort_order:10 },
  { scope_item_id:'_g2', label:'Brushing and debris removal',  service_types:['g2c'], default_on:true, sort_order:20 },
  { scope_item_id:'_g3', label:'Follow-up visit scheduling as needed', service_types:['g2c'], default_on:true, sort_order:30 },
  { scope_item_id:'_r1', label:'Repair / replacement labor',   service_types:['repair'], default_on:true, sort_order:10 },
  { scope_item_id:'_r2', label:'Job documentation',            service_types:['repair'], default_on:true, sort_order:20 },
  { scope_item_id:'_r3', label:'Parts coordination as approved', service_types:['repair'], default_on:true, sort_order:30 },
  { scope_item_id:'_r4', label:'Completion report',            service_types:['repair'], default_on:true, sort_order:40 }
];

const PAGE_META = {
  home:'Home', jobs:'Jobs', live_map:'Technician Hub', service_log:'Service Log',
  inventory:'Inventory', quotes:'Quote Tool', crm:'Sales Hub', training:'Training', admin:'Admin',
  contracts:'Contracts', action_queue:'Action Queue',
  onboarding:'Get Started', financial_hub:'Financial Hub', alerts:'Alerts & Issues',
  comms:'Communications', route_planner:'Route Planner'
};

// Emoji icons used on home cards only (sidebar uses SVG)
const PAGE_ICONS = {
  home:'🏠', jobs:'🧰', live_map:'🛟', service_log:'📝', inventory:'📦',
  quotes:'📄', crm:'📊', training:'🎓', admin:'🔒', onboarding:'📋', financial_hub:'💰',
  comms:'📣', route_planner:'🗓️'
};

// ── Sidebar SVG icon strings (16×16, stroke-based Heroicons) ─────────────────
const SVG_HOME     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
const SVG_CALENDAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const SVG_CLIP     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;
const SVG_BOX      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
const SVG_PLAY     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`;
const SVG_USER     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const SVG_DOC      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
const SVG_CHART    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
const SVG_LOCK     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const SVG_STAR     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const SVG_PEOPLE   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const SVG_BELL     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
const SVG_MAIL     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>`;
const SVG_INBOX    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;

// ── Shared utilities ─────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ⚠️ Use this — NOT escHtml — for a value going into an inline handler such as
// onclick="fn(...)". escHtml does not escape apostrophes, so a value containing
// one terminates the JS string early and whatever follows is executed:
//
//   onclick="fn('${escHtml(id)}')"   with id = O'Brien   →   fn('O'Brien')
//
// JSON.stringify emits a valid JS string literal (handling quotes, backslashes
// and control characters); escHtml then makes it safe for the double-quoted HTML
// attribute, and the parser hands JS back the correct literal.
//
// Note there are NO surrounding quotes at the call site — jsArg supplies them:
//   onclick="fn(${jsArg(id)})"
function jsArg(v) {
  return escHtml(JSON.stringify(String(v == null ? '' : v)));
}

// ── Chemical registry (CHEM-XX) — presentation only ───────────────────────────
// Canonical Chem ID + brand-bucket color for each chemical, from the MCPS Chem ID
// style guide. Names remain the payload/sheet keys; this map only drives display
// (number badge + color) in the service log and, later, admin surfaces.
// `dark:true` = light background, so the number is drawn in dark ink.
const CHEM_REGISTRY = [
  { id:'CHEM-01', num:'01', label:'Soda Ash',                color:'#2E9E4A', dark:false, aliases:['soda ash'] },
  { id:'CHEM-02', num:'02', label:'Sodium Bicarbonate',      color:'#1B6B34', dark:false, aliases:['alkalinity increaser','alkalinity increaser (sodium bicarb)','sodium bicarbonate','sodium bicarb'] },
  { id:'CHEM-03', num:'03', label:'Calcium Chloride',        color:'#16324F', dark:false, aliases:['calcium hardness increaser','calcium chloride'] },
  { id:'CHEM-04', num:'04', label:'Cyanuric Acid',           color:'#FFFFFF', dark:true,  aliases:['cyanuric acid (stabilizer)','cyanuric acid','stabilizer'] },
  { id:'CHEM-05', num:'05', label:'D.E.',                    color:'#111111', dark:false, aliases:['diatomaceous earth (de)','diatomaceous earth','d.e.','de'] },
  { id:'CHEM-06', num:'06', label:'Liquid Chlorine',         color:'#F4C400', dark:true,  aliases:['liquid chlorine','sodium hypochlorite'] },
  { id:'CHEM-07', num:'07', label:'Calcium Hypochlorite',    color:'#F4C400', dark:true,  aliases:['cal hypo','calcium hypochlorite'] },
  { id:'CHEM-08', num:'08', label:'Tabs',                    color:'#F4C400', dark:true,  aliases:['chlorine tablets (3")','chlorine tablets','tabs','trichlor'] },
  { id:'CHEM-09', num:'09', label:'Salt',                    color:'#5BC2E7', dark:true,  aliases:['salt','sodium chloride'] },
  { id:'CHEM-10', num:'10', label:'Muriatic Acid',           color:'#E8751A', dark:false, aliases:['muriatic acid','hydrochloric acid'] },
  { id:'CHEM-11', num:'11', label:'Dry Acid',                color:'#E8751A', dark:false, aliases:['dry acid','sodium bisulfate'] },
  { id:'CHEM-12', num:'12', label:'Enzymes',                 color:'#7B4EA8', dark:false, aliases:['enzymes','water clarifier'] },
  { id:'CHEM-13', num:'13', label:'Phosphate Remover',       color:'#7B4EA8', dark:false, aliases:['phosphate remover'] },
  { id:'CHEM-14', num:'14', label:'Emergency Kit',           color:'#D0342C', dark:false, aliases:['emergency kit'] }
];
const _CHEM_INDEX = (function(){
  const m = {};
  CHEM_REGISTRY.forEach(e => e.aliases.forEach(a => { m[a] = e; }));
  return m;
})();
// Look up a registry entry by any known chemical name/alias (case-insensitive).
function chemLookup(name){
  if(!name) return null;
  return _CHEM_INDEX[String(name).trim().toLowerCase()] || null;
}
// Render a CHEM-XX number badge for a chemical name; grey dash if unlisted.
function chemBadge(name){
  const e = chemLookup(name);
  if(!e) return '<span class="chem-badge chem-badge-none" title="'+escHtml(name||'Not assigned')+'" aria-label="No chem ID">–</span>';
  return '<span class="chem-badge'+(e.dark?' on-light':'')+'" style="background:'+e.color+'" title="'+escHtml(e.id+' · '+e.label)+'" aria-label="'+escHtml(e.id)+'">'+e.num+'</span>';
}

// ── Sidebar accordion group definitions ──────────────────────────────────────
const SIDEBAR_GROUPS = [
  {
    id: 'alerts',
    label: 'Alerts & Issues',
    children: [
      { page:'alerts', label:'Alerts',  icon:SVG_BELL }
    ]
  },
  {
    id: 'sales',
    label: 'Sales Hub',
    children: [
      { page:'action_queue', label:'Action Queue',  icon:SVG_INBOX, badgeId:'aq-badge' },
      { page:'crm',       label:'Leads CRM',       icon:SVG_CHART },
      { page:'quotes',    label:'Quote Tool',      icon:SVG_DOC   },
      { page:'contracts', label:'Contracts',       icon:SVG_LOCK  },
      { page:'comms',     label:'Communications',  icon:SVG_MAIL }
    ]
  },
  {
    id: 'tech',
    label: 'Technician Hub',
    children: [
      { page:'jobs',        label:'Jobs',                  icon:SVG_CLIP     },
      { page:'live_map',    label:'Schedule',              icon:SVG_CALENDAR },
      { page:'route_planner', label:'Route Planner',       icon:SVG_CALENDAR },
      { page:'live_map',    label:'My Jobs',               icon:SVG_CHART, hubTab:'myjobs',              id:'sb-child-myjobs' },
      { page:'live_map',    label:'Training',              icon:SVG_PLAY,  hubTab:'training',            id:'sb-child-training' },
      { page:'live_map',    label:'Startup Checklists',    icon:SVG_CLIP,  hubTab:'startup_checklists',  id:'sb-child-startup_checklists', adminOnly:true },
      { page:'inventory',   label:'Inventory',             icon:SVG_BOX      },
      { page:'service_log', label:'Service Log',           icon:SVG_CLIP     }
    ]
  },
  {
    id: 'finance',
    label: 'Financial Hub',
    children: [
      { page:'financial_hub', label:'Payouts',             icon:SVG_CHART, hubTab:'payouts',   id:'ni-financial_hub-payouts' },
      { page:'financial_hub', label:'Profitability',       icon:SVG_CHART, hubTab:'profit',    id:'ni-financial_hub-profit' },
      { page:'financial_hub', label:'Chemical Analysis',  icon:SVG_CLIP,  hubTab:'chemicals', id:'ni-financial_hub-chemicals' },
      { page:'financial_hub', label:'Visit History',       icon:SVG_CLIP,  hubTab:'visits',    id:'ni-financial_hub-visits' },
      { page:'financial_hub', label:'Clients',             icon:SVG_CLIP,  hubTab:'clients',   id:'ni-financial_hub-clients' },
      { page:'financial_hub', label:'Payroll',             icon:SVG_CLIP,  hubTab:'payroll',   id:'ni-financial_hub-payroll' },
      { page:'financial_hub', label:'Unmatched',           icon:SVG_CLIP,  hubTab:'unmatched', id:'ni-financial_hub-unmatched' },
      { page:'financial_hub', label:'Companies',           icon:SVG_CLIP,  hubTab:'companies', id:'ni-financial_hub-companies' }
    ]
  }
];

// Pages per role — additive
// 'jobs' is intentionally granted to no role: the Jobs tab and its GAS backend
// are both deployed, but it hasn't been launched yet. Add it back here (and only
// here) when it's ready — js/features/jobs.js and appscript/Jobs.js are live.
const ROLE_PAGES = {
  technician:['home','live_map','service_log','alerts'],
  lead:['home','live_map','service_log','alerts'],
  trainee:['home','live_map'],
  new_hire:['onboarding'],
  office:['home','inventory','alerts'],
  // 'action_queue' is deliberately NOT granted to office: every card in the queue
  // deep-links to 'crm' (aqOpenQuote), and navigateTo() hard-returns on a page the
  // role lacks — office would get an inbox whose every button silently did nothing.
  // 'contracts' is admin/manager only for the same reason the GAS route is:
  // executed agreements carry pricing, signer IPs and signature images.
  manager:['home','crm','comms','route_planner','live_map','service_log','inventory','quotes','financial_hub','alerts','action_queue','contracts'],
  admin:['home','crm','comms','route_planner','live_map','service_log','inventory','quotes','admin','financial_hub','alerts','action_queue','contracts'],
};

const ALL_ROLES = ['technician','lead', 'office','manager','admin','trainee','new_hire'];
const ALL_DAYS  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
