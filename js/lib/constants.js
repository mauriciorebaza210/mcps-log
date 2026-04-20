// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — config, icons, roles, sidebar structure
// ══════════════════════════════════════════════════════════════════════════════

const AS  = 'https://script.google.com/macros/s/AKfycbzcCh5WVhiCZglMFQ_BaHHRD_QbsOFzpf5KgKyFWReAv7aJp2Z6_oYIUYBMLwzTIy_v/exec';
const SEC = 'mcps_webhook_2026';

const PAGE_META = {
  home:'Home', live_map:'Technician Hub', service_log:'Service Log',
  inventory:'Inventory', quotes:'Quote Tool', crm:'Sales Hub', training:'Training', admin:'Admin',
  onboarding:'Get Started'
};

// Emoji icons used on home cards only (sidebar uses SVG)
const PAGE_ICONS = {
  home:'🏠', live_map:'🛟', service_log:'📝', inventory:'📦',
  quotes:'📄', crm:'📊', training:'🎓', admin:'🔒', onboarding:'📋'
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

// ── Sidebar accordion group definitions ──────────────────────────────────────
const SIDEBAR_GROUPS = [
  {
    id: 'sales',
    label: 'Sales Hub',
    children: [
      { page:'crm',    label:'Leads CRM',  icon:SVG_CHART },
      { page:'quotes', label:'Quote Tool',  icon:SVG_DOC   }
    ]
  },
  {
    id: 'tech',
    label: 'Technician Hub',
    children: [
      { page:'live_map',    label:'Schedule',         icon:SVG_CALENDAR },
      { page:'live_map',    label:'Training',          icon:SVG_PLAY,     hubTab:'training', id:'sb-child-training' },
      { page:'inventory',   label:'Inventory',         icon:SVG_BOX      },
      { page:'service_log', label:'Service Log',       icon:SVG_CLIP     }
    ]
  }
];

// Pages per role — additive
const ROLE_PAGES = {
  technician:['live_map','service_log'],           // training accessed via hub tab
  lead:['live_map','service_log'],                  // training accessed via hub tab
  trainee:['live_map'],                             // hub-only: training tab shown exclusively
  new_hire:['onboarding'],
  office:['home','inventory'],
  manager:['home','crm','live_map','service_log','inventory','quotes'],  // training via hub tab
  admin:['home','crm','live_map','service_log','inventory','quotes','admin'],  // training via hub tab
};

const ALL_ROLES = ['technician','lead', 'office','manager','admin','trainee','new_hire'];
const ALL_DAYS  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
