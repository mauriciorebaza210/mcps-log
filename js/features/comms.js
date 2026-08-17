// comms.js — Communications (mass email) page. Admin/manager only.
// Deps (shared global scope): constants.js (escHtml), api.js (api), auth.js
// (isAdmin/hasRole), router.js (navigateTo). Backend actions: comms_* in
// appscript/Comms.js. No build step — plain globals + inline onclick handlers.

let _commsTab        = 'compose';
let _commsCrm        = null;   // cached CRM rows for area list + manual pick-list
let _commsTemplates  = [];
let _commsCampaigns  = [];
let _commsPreview    = null;   // last audience preview result
let _commsPollTimer  = null;
let _commsCompose    = { category:'service_update', audienceType:'all_active',
                         statuses:[], areas:[], day:'Monday', operator:'', quoteIds:[],
                         testEmails:'', subject:'', body:'', sendAt:'' };

const COMMS_STATUSES = ['LEAD','SENT','SIGNED','ACTIVE_CUSTOMER','PAUSED','LOST','COMPLETED_JOB'];
// Mon–Sat only, matching WEEKDAYS in RouteData.js. There is no Sunday route, so a
// Sunday option can never resolve to anyone.
const COMMS_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const COMMS_PLACEHOLDERS = ['first_name','last_name','name','address','city','area','day','technician','properties_list'];

// ── Entry point (called by router.navigateTo) ───────────────────────────────
function loadCommsPage(sub) {
  const root = document.getElementById('comms-root');
  if (!root) return;
  _commsInjectStyles();
  if (sub && ['compose','templates','history','optouts'].includes(sub)) _commsTab = sub;
  root.innerHTML = _commsShell();
  _commsRenderTab();
}

function _commsShell() {
  const tabs = [['compose','Compose'],['templates','Templates'],['history','History'],['optouts','Opt-outs']];
  return `
    <div class="comms-wrap">
      <div class="comms-head">
        <h1>📣 Communications</h1>
        <div class="comms-sub">Send branded email to your customers and leads.</div>
      </div>
      <div class="comms-tabs">
        ${tabs.map(([k,l])=>`<button class="comms-tab ${_commsTab===k?'active':''}" onclick="commsSwitchTab('${k}')">${l}</button>`).join('')}
      </div>
      <div id="comms-tab-body"></div>
    </div>`;
}

function commsSwitchTab(tab) {
  _commsTab = tab;
  if (_commsPollTimer) { clearInterval(_commsPollTimer); _commsPollTimer = null; }
  document.querySelectorAll('.comms-tab').forEach(b=>{
    b.classList.toggle('active', b.getAttribute('onclick').includes("'"+tab+"'"));
  });
  _commsRenderTab();
}

function _commsRenderTab() {
  const body = document.getElementById('comms-tab-body');
  if (!body) return;
  if (_commsTab==='compose')    _commsRenderCompose(body);
  else if (_commsTab==='templates') _commsRenderTemplates(body);
  else if (_commsTab==='history')   _commsRenderHistory(body);
  else if (_commsTab==='optouts')   _commsRenderOptouts(body);
}

function _commsLoading(){ return `<div class="route-loading"><div class="spinner"></div></div>`; }
function _commsMsg(el,text,kind){ if(!el)return; el.className='comms-msg '+(kind||''); el.textContent=text; }

// Ensure CRM rows are loaded (for area list + manual pick-list).
async function _commsEnsureCrm() {
  if (_commsCrm) return _commsCrm;
  try {
    const res = await api({ action:'get_crm_data' });
    _commsCrm = res.data || res.leads || res.rows || [];
  } catch(e){ _commsCrm = []; }
  return _commsCrm;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSE TAB
// ═══════════════════════════════════════════════════════════════════════════
async function _commsRenderCompose(body) {
  body.innerHTML = _commsLoading();
  await _commsEnsureCrm();
  const c = _commsCompose;
  const areas = Array.from(new Set((_commsCrm||[]).map(r=>String(r.area||'').trim()).filter(Boolean))).sort();

  body.innerHTML = `
  <div class="comms-grid">
    <div class="comms-col">
      <div class="comms-card">
        <label class="comms-lbl">Category</label>
        <select id="cm-category" class="comms-input" onchange="_commsCompose.category=this.value">
          <option value="service_update" ${c.category==='service_update'?'selected':''}>Service update (operational — opt-out doesn't block)</option>
          <option value="announcement" ${c.category==='announcement'?'selected':''}>Announcement</option>
          <option value="marketing" ${c.category==='marketing'?'selected':''}>Marketing</option>
        </select>

        <label class="comms-lbl">Audience</label>
        <select id="cm-audtype" class="comms-input" onchange="_commsCompose.audienceType=this.value;_commsRenderAudienceControls()">
          <option value="all_active" ${c.audienceType==='all_active'?'selected':''}>All active customers</option>
          <option value="status" ${c.audienceType==='status'?'selected':''}>By status</option>
          <option value="area" ${c.audienceType==='area'?'selected':''}>By area</option>
          <option value="route_day" ${c.audienceType==='route_day'?'selected':''}>By route day</option>
          <option value="manual" ${c.audienceType==='manual'?'selected':''}>Pick customers</option>
          <option value="test" ${c.audienceType==='test'?'selected':''}>Test addresses</option>
        </select>
        <div id="cm-aud-controls" data-areas='${escHtml(JSON.stringify(areas))}'></div>

        <button class="comms-btn ghost" onclick="commsPreviewAudience()">Preview recipients</button>
        <div id="cm-preview"></div>
      </div>
    </div>

    <div class="comms-col">
      <div class="comms-card">
        <label class="comms-lbl">Subject</label>
        <input id="cm-subject" class="comms-input" value="${escHtml(c.subject)}" oninput="_commsCompose.subject=this.value" placeholder="e.g. Your service day update, {{first_name}}">

        <label class="comms-lbl">Message</label>
        <div class="comms-toolbar">
          <button type="button" class="comms-tool" onclick="commsWrap('**','**')" title="Bold selected text"><b>B</b>&nbsp;Bold</button>
          <button type="button" class="comms-tool" onclick="commsInsertLink()" title="Turn selected text into a link">🔗&nbsp;Link</button>
        </div>
        <div class="comms-chips-label">Insert customer info — auto-fills for each recipient:</div>
        <div class="comms-chips">
          ${COMMS_PLACEHOLDERS.map(p=>`<button type="button" class="comms-chip" onclick="commsInsertPlaceholder('${p}')" title="${escHtml(_commsChipTip(p))}">${escHtml(_commsChipLabel(p))}</button>`).join('')}
        </div>
        <textarea id="cm-body" class="comms-input comms-textarea" oninput="_commsCompose.body=this.value" placeholder="Hi {{first_name}},&#10;&#10;Your next service day is {{day}}.">${escHtml(c.body)}</textarea>
        <div class="comms-fmt-hint">Write normally. Select text and click <b>B</b> to bold it or <b>🔗 Link</b> to add a link. Leave a blank line between paragraphs.</div>

        <div class="comms-row">
          <button class="comms-btn ghost" onclick="commsPreviewEmail()">Preview email</button>
          <button class="comms-btn ghost" onclick="commsSendTest()">Send test to me</button>
        </div>
        <div id="cm-emailpreview"></div>

        <label class="comms-lbl">Schedule (optional)</label>
        <input id="cm-sendat" type="datetime-local" class="comms-input" value="${escHtml(c.sendAt)}" oninput="_commsCompose.sendAt=this.value">

        <button class="comms-btn primary" onclick="commsSendCampaign()">Send campaign</button>
        <div id="cm-sendmsg" class="comms-msg"></div>
      </div>
    </div>
  </div>`;
  _commsRenderAudienceControls();
}

function _commsRenderAudienceControls() {
  const wrap = document.getElementById('cm-aud-controls');
  if (!wrap) return;
  const c = _commsCompose;
  let areas = []; try { areas = JSON.parse(wrap.getAttribute('data-areas')||'[]'); } catch(e){}
  let html = '';
  if (c.audienceType === 'status') {
    html = `<div class="comms-checks">${COMMS_STATUSES.map(s=>`
      <label class="comms-check"><input type="checkbox" value="${s}" ${c.statuses.includes(s)?'checked':''} onchange="_commsToggle('statuses','${s}',this.checked)"> ${s}</label>`).join('')}</div>`;
  } else if (c.audienceType === 'area') {
    html = areas.length
      ? `<div class="comms-checks">${areas.map(a=>`<label class="comms-check"><input type="checkbox" value="${escHtml(a)}" ${c.areas.includes(a)?'checked':''} onchange="_commsToggle('areas','${escHtml(a)}',this.checked)"> ${escHtml(a)}</label>`).join('')}</div>`
      : `<div class="comms-hint">No areas found in CRM data.</div>`;
  } else if (c.audienceType === 'route_day') {
    html = `
      <label class="comms-lbl">Day</label>
      <select class="comms-input" onchange="_commsCompose.day=this.value">${COMMS_DAYS.map(d=>`<option ${c.day===d?'selected':''}>${d}</option>`).join('')}</select>
      <label class="comms-lbl">Operator (optional)</label>
      <input class="comms-input" value="${escHtml(c.operator)}" oninput="_commsCompose.operator=this.value" placeholder="blank = all technicians">`;
  } else if (c.audienceType === 'manual') {
    const rows = (_commsCrm||[]).filter(r=>String(r.email||'').trim());
    html = `
      <input class="comms-input" placeholder="Search name/email…" oninput="_commsFilterPick(this.value)">
      <div id="cm-picklist" class="comms-picklist">${_commsPickRows(rows)}</div>`;
  } else if (c.audienceType === 'test') {
    html = `<textarea class="comms-input comms-textarea" placeholder="test1@example.com, test2@example.com" oninput="_commsCompose.testEmails=this.value">${escHtml(c.testEmails)}</textarea>`;
  } else {
    html = `<div class="comms-hint">Everyone with status ACTIVE_CUSTOMER.</div>`;
  }
  wrap.innerHTML = html;
}

function _commsPickRows(rows) {
  return rows.slice(0,500).map(r=>{
    const id = String(r.id||r.quote_id||'');
    return `<label class="comms-pick"><input type="checkbox" value="${escHtml(id)}" ${_commsCompose.quoteIds.includes(id)?'checked':''} onchange="_commsToggle('quoteIds','${escHtml(id)}',this.checked)"> <span>${escHtml(r.name||'(no name)')} · ${escHtml(r.email||'')}</span></label>`;
  }).join('') || `<div class="comms-hint">No customers with email.</div>`;
}
function _commsFilterPick(q) {
  q = (q||'').toLowerCase();
  const rows = (_commsCrm||[]).filter(r=>String(r.email||'').trim() &&
    ((String(r.name||'').toLowerCase().includes(q))||(String(r.email||'').toLowerCase().includes(q))));
  const el = document.getElementById('cm-picklist'); if (el) el.innerHTML = _commsPickRows(rows);
}
function _commsToggle(field, val, on) {
  const arr = _commsCompose[field];
  const i = arr.indexOf(val);
  if (on && i===-1) arr.push(val);
  if (!on && i>-1) arr.splice(i,1);
}

const COMMS_CHIP_LABELS = { first_name:'First name', last_name:'Last name', name:'Full name',
  address:'Address', city:'City', area:'Area', day:'Service day', technician:'Technician',
  properties_list:'Their pool(s)' };
const COMMS_CHIP_TIPS = {
  first_name:"The customer's first name", last_name:"The customer's last name",
  name:"The customer's full name", address:"The customer's pool/service address",
  city:"The customer's city", area:"The customer's service area",
  day:"The customer's service day (best used for a route-day send)",
  technician:"The technician assigned to that customer",
  properties_list:"A bulleted list of the customer's pool address(es) — and the service day, on route-day sends. Handy for customers with more than one pool." };
function _commsChipLabel(p){ return COMMS_CHIP_LABELS[p] || p; }
function _commsChipTip(p){ return COMMS_CHIP_TIPS[p] || ('Inserts the '+p); }

function commsInsertPlaceholder(p) {
  const ta = document.getElementById('cm-body'); if (!ta) return;
  const s = ta.selectionStart||ta.value.length, e = ta.selectionEnd||ta.value.length;
  const token = '{{'+p+'}}';
  ta.value = ta.value.slice(0,s) + token + ta.value.slice(e);
  _commsCompose.body = ta.value;
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + token.length;
}

// Wrap the current selection (or a placeholder word) with markup, e.g. **bold**.
function commsWrap(before, after) {
  const ta = document.getElementById('cm-body'); if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s,e) || 'text';
  ta.value = ta.value.slice(0,s) + before + sel + after + ta.value.slice(e);
  _commsCompose.body = ta.value;
  ta.focus(); ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
}

// Turn the selection into a link, using a branded in-page dialog (not prompt()).
function commsInsertLink() {
  const ta = document.getElementById('cm-body'); if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s,e);
  _commsLinkModal(sel, (text, url) => {
    const md = '['+(text||'link')+']('+url+')';
    ta.value = ta.value.slice(0,s) + md + ta.value.slice(e);
    _commsCompose.body = ta.value;
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + md.length;
  });
}
function _commsLinkModal(defaultText, onOk) {
  _commsCloseLinkModal();
  const ov = document.createElement('div');
  ov.className = 'comms-modal-ov';
  ov.innerHTML = `<div class="comms-modal" onclick="event.stopPropagation()">
    <h3>Add a link</h3>
    <label class="comms-lbl">Link text (what readers see)</label>
    <input id="cml-text" class="comms-input" value="${escHtml(defaultText||'')}" placeholder="e.g. Book your service">
    <label class="comms-lbl">Web address</label>
    <input id="cml-url" class="comms-input" value="https://" placeholder="https://…">
    <div class="comms-modal-msg" id="cml-msg"></div>
    <div class="comms-row" style="justify-content:flex-end;margin-top:14px">
      <button class="comms-btn ghost" onclick="_commsCloseLinkModal()">Cancel</button>
      <button class="comms-btn primary" id="cml-ok">Insert link</button>
    </div></div>`;
  ov.addEventListener('click', _commsCloseLinkModal);
  document.body.appendChild(ov);
  window._commsLinkOv = ov;
  const urlEl = ov.querySelector('#cml-url');
  urlEl.focus(); urlEl.setSelectionRange(8,8);
  const submit = () => {
    const text = ov.querySelector('#cml-text').value.trim();
    const url  = ov.querySelector('#cml-url').value.trim();
    if (!/^https?:\/\/.+/i.test(url)) { ov.querySelector('#cml-msg').textContent = 'Enter a full web address starting with https://'; return; }
    _commsCloseLinkModal();
    onOk(text, url);
  };
  ov.querySelector('#cml-ok').onclick = submit;
  urlEl.addEventListener('keydown', ev=>{ if(ev.key==='Enter') submit(); });
}
function _commsCloseLinkModal(){ if(window._commsLinkOv){ window._commsLinkOv.remove(); window._commsLinkOv=null; } }

function _commsBuildAudience() {
  const c = _commsCompose;
  if (c.audienceType==='status')    return { type:'status', statuses:c.statuses };
  if (c.audienceType==='area')      return { type:'area', areas:c.areas };
  // Pin the week explicitly (reusing routes.js's helper). Without it the backend
  // falls back to "current week at send time", so a scheduled campaign could resolve
  // against a different week than the one you previewed.
  if (c.audienceType==='route_day') return { type:'route_day', day:c.day, operator:c.operator||'',
                                             week_start:_weekStartForOffset_(0) };
  if (c.audienceType==='manual')    return { type:'manual', quote_ids:c.quoteIds };
  if (c.audienceType==='test')      return { type:'test', emails:c.testEmails.split(',').map(s=>s.trim()).filter(Boolean) };
  return { type:'all_active' };
}

// Why this person is on the list — same labels the schedule uses for its stop badges
// (routes.js:1362-1364), so a preview can be eyeballed against Technician Hub.
function _commsVisitTag(visitType) {
  if (!visitType) return '';
  const label = (typeof _VISIT_TYPE_LABELS === 'object' && _VISIT_TYPE_LABELS[visitType])
    || visitType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  // Teal for a normal recurring stop, purple for a one-off — same split the schedule
  // uses (svc-weekly vs the scheduled-visit badge).
  const cls = visitType === 'weekly' ? 'type' : 'type visit';
  return `<span class="comms-tag ${cls}">${escHtml(label)}</span>`;
}

async function commsPreviewAudience() {
  const box = document.getElementById('cm-preview');
  box.innerHTML = _commsLoading();
  try {
    const res = await api({ action:'comms_preview_audience', audience:_commsBuildAudience(), category:_commsCompose.category });
    if (!res.ok) { box.innerHTML = `<div class="comms-msg error">${escHtml(res.error||'Failed')}</div>`; return; }
    _commsPreview = res;
    const list = (res.recipients||[]).slice(0,50).map(r=>`<div class="comms-precol"><span>${escHtml(r.name||'(no name)')}</span>${_commsVisitTag(r.visit_type)}<span class="comms-muted">${escHtml(r.email||'—')}</span>${r.invalid?'<span class="comms-tag err">invalid</span>':''}${r.opted_out?'<span class="comms-tag warn">opted out</span>':''}</div>`).join('');
    box.innerHTML = `
      <div class="comms-precount"><b>${res.sendable_count}</b> will receive this
        <span class="comms-muted">· ${res.total} matched · ${res.invalid_count} invalid · ${res.opted_out_count} opted out</span></div>
      <div class="comms-prelist">${list}${res.total>50?'<div class="comms-hint">…showing first 50</div>':''}</div>`;
  } catch(e){ box.innerHTML = `<div class="comms-msg error">${escHtml(e.message||'Error')}</div>`; }
}

async function commsPreviewEmail() {
  const box = document.getElementById('cm-emailpreview');
  box.innerHTML = _commsLoading();
  try {
    const res = await api({ action:'comms_preview_render', subject:_commsCompose.subject, body_markup:_commsCompose.body });
    if (!res.ok) { box.innerHTML = `<div class="comms-msg error">${escHtml(res.error||'Failed')}</div>`; return; }
    // Sandboxed iframe — no scripts, no same-origin. Defense in depth.
    box.innerHTML = `<div class="comms-emailwrap"><div class="comms-muted" style="margin-bottom:6px">Subject: ${escHtml(res.subject||'(none)')}</div>
      <iframe class="comms-iframe" sandbox="" srcdoc="${escHtml(res.html)}"></iframe></div>`;
  } catch(e){ box.innerHTML = `<div class="comms-msg error">${escHtml(e.message||'Error')}</div>`; }
}

async function commsSendTest() {
  const el = document.getElementById('cm-sendmsg');
  _commsMsg(el,'Sending test…','');
  try {
    const res = await api({ action:'comms_send_test_draft', subject:_commsCompose.subject, body_markup:_commsCompose.body, category:_commsCompose.category });
    if (res.ok) _commsMsg(el,'Test sent to '+(res.sent_to||'your inbox')+'.','ok');
    else _commsMsg(el,res.error||'Failed','error');
  } catch(e){ _commsMsg(el,e.message||'Error','error'); }
}

async function commsSendCampaign() {
  const c = _commsCompose;
  if (!c.subject.trim()) { _commsMsg(document.getElementById('cm-sendmsg'),'Subject is required.','error'); return; }
  if (!c.body.trim())    { _commsMsg(document.getElementById('cm-sendmsg'),'Message body is required.','error'); return; }
  // Always preview so the confirm shows a real count.
  await commsPreviewAudience();
  const n = _commsPreview ? _commsPreview.sendable_count : 0;
  if (!n) { _commsMsg(document.getElementById('cm-sendmsg'),'No sendable recipients.','error'); return; }
  const when = c.sendAt ? new Date(c.sendAt) : null;
  const whenTxt = when ? (' scheduled for '+when.toLocaleString()) : ' now';
  if (!confirm(`Send this ${c.category.replace('_',' ')} campaign to ${n} recipient(s)${whenTxt}?`)) return;

  const el = document.getElementById('cm-sendmsg');
  _commsMsg(el,'Creating campaign…','');
  const payload = { action:'comms_send_campaign', name:(c.subject.slice(0,60)||'Campaign'),
    category:c.category, subject:c.subject, body_markup:c.body, audience:_commsBuildAudience() };
  if (when) payload.send_at = when.toISOString();
  try {
    const res = await api(payload);
    if (!res.ok) { _commsMsg(el,res.error||'Failed','error'); return; }
    _commsMsg(el, res.status==='scheduled' ? `Scheduled for ${when.toLocaleString()} · ${res.sendable} recipient(s).` : `Sending to ${res.sendable} recipient(s)…`, 'ok');
    setTimeout(()=>commsSwitchTab('history'), 1200);
  } catch(e){ _commsMsg(el,e.message||'Error','error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES TAB
// ═══════════════════════════════════════════════════════════════════════════
async function _commsRenderTemplates(body) {
  body.innerHTML = _commsLoading();
  try {
    const res = await api({ action:'comms_list_templates' });
    _commsTemplates = res.templates || [];
  } catch(e){ _commsTemplates = []; }
  body.innerHTML = `
    <div class="comms-card">
      <div class="comms-row between">
        <h3>Templates</h3>
        <button class="comms-btn primary" onclick="commsEditTemplate()">New template</button>
      </div>
      <div id="cm-tpl-editor"></div>
      <div class="comms-tpl-list">
        ${_commsTemplates.length ? _commsTemplates.map(t=>`
          <div class="comms-tpl">
            <div><b>${escHtml(t.name||'(unnamed)')}</b> <span class="comms-tag">${escHtml(t.category||'')}</span><div class="comms-muted">${escHtml(t.subject||'')}</div></div>
            <div class="comms-row">
              <button class="comms-btn ghost sm" onclick="commsUseTemplate('${t.template_id}')">Use</button>
              <button class="comms-btn ghost sm" onclick="commsEditTemplate('${t.template_id}')">Edit</button>
              <button class="comms-btn ghost sm danger" onclick="commsDeleteTemplate('${t.template_id}')">Delete</button>
            </div>
          </div>`).join('') : '<div class="comms-hint">No templates yet.</div>'}
      </div>
    </div>`;
}

function commsEditTemplate(id) {
  const t = id ? _commsTemplates.find(x=>x.template_id===id) : { template_id:'', name:'', subject:'', body_markup:'', category:'service_update' };
  const el = document.getElementById('cm-tpl-editor');
  el.innerHTML = `
    <div class="comms-card inner">
      <input id="tpl-name" class="comms-input" placeholder="Template name" value="${escHtml(t.name||'')}">
      <select id="tpl-cat" class="comms-input">
        ${['service_update','announcement','marketing'].map(x=>`<option value="${x}" ${t.category===x?'selected':''}>${x}</option>`).join('')}
      </select>
      <input id="tpl-subject" class="comms-input" placeholder="Subject" value="${escHtml(t.subject||'')}">
      <textarea id="tpl-body" class="comms-input comms-textarea" placeholder="Message…">${escHtml(t.body_markup||'')}</textarea>
      <input type="hidden" id="tpl-id" value="${escHtml(t.template_id||'')}">
      <div class="comms-row"><button class="comms-btn primary" onclick="commsSaveTemplate()">Save</button>
        <button class="comms-btn ghost" onclick="document.getElementById('cm-tpl-editor').innerHTML=''">Cancel</button></div>
      <div id="tpl-msg" class="comms-msg"></div>
    </div>`;
}

async function commsSaveTemplate() {
  const t = {
    template_id: document.getElementById('tpl-id').value || undefined,
    name: document.getElementById('tpl-name').value,
    category: document.getElementById('tpl-cat').value,
    subject: document.getElementById('tpl-subject').value,
    body_markup: document.getElementById('tpl-body').value
  };
  const el = document.getElementById('tpl-msg');
  _commsMsg(el,'Saving…','');
  try {
    const res = await api({ action:'comms_save_template', template:t });
    if (res.ok) _commsRenderTab(); else _commsMsg(el,res.error||'Failed','error');
  } catch(e){ _commsMsg(el,e.message||'Error','error'); }
}
async function commsDeleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  try { await api({ action:'comms_delete_template', template_id:id }); _commsRenderTab(); } catch(e){}
}
function commsUseTemplate(id) {
  const t = _commsTemplates.find(x=>x.template_id===id); if (!t) return;
  _commsCompose.subject = t.subject||''; _commsCompose.body = t.body_markup||'';
  _commsCompose.category = t.category||'service_update';
  commsSwitchTab('compose');
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY TAB
// ═══════════════════════════════════════════════════════════════════════════
async function _commsRenderHistory(body, silent) {
  if (!silent) body.innerHTML = _commsLoading();
  try {
    const res = await api({ action:'comms_list_campaigns' });
    _commsCampaigns = res.campaigns || [];
  } catch(e){ _commsCampaigns = []; }
  const anySending = _commsCampaigns.some(c=>c.status==='sending'||c.status==='scheduled');
  body.innerHTML = `
    <div class="comms-card">
      <h3>Campaign history</h3>
      <div class="comms-camp-list">
        ${_commsCampaigns.length ? _commsCampaigns.map(c=>{
          const prog = c.sendable_count ? Math.round(100*(c.sent_count+c.failed_count)/c.sendable_count) : (c.status==='done'?100:0);
          const canCancel = c.status==='scheduled' || c.status==='sending';
          return `<div class="comms-camp">
            <div class="comms-camp-main" onclick="commsCampaignDetail('${c.campaign_id}')">
              <div><b>${escHtml(c.name||'(untitled)')}</b> <span class="comms-tag ${_commsStatusClass(c.status)}">${escHtml(c.status)}</span></div>
              <div class="comms-muted">${escHtml(c.subject||'')}</div>
              <div class="comms-bar"><div class="comms-bar-fill" style="width:${prog}%"></div></div>
              <div class="comms-muted">${c.sent_count} sent · ${c.failed_count} failed · ${c.skipped_count} skipped / ${c.total_recipients} total</div>
            </div>
            ${canCancel?`<button class="comms-btn ghost sm danger" onclick="commsCancelCampaign('${c.campaign_id}')">Cancel</button>`:''}
          </div>`;
        }).join('') : '<div class="comms-hint">No campaigns yet.</div>'}
      </div>
      <div id="cm-camp-detail"></div>
    </div>`;
  if (_commsPollTimer) { clearInterval(_commsPollTimer); _commsPollTimer=null; }
  if (anySending && _commsTab==='history') {
    _commsPollTimer = setInterval(()=>{ const b=document.getElementById('comms-tab-body'); if(b&&_commsTab==='history') _commsRenderHistory(b,true); else {clearInterval(_commsPollTimer);_commsPollTimer=null;} }, 5000);
  }
}
function _commsStatusClass(s){ return s==='done'?'ok':(s==='done_with_errors'?'warn':(s==='cancelled'?'err':'')); }

async function commsCampaignDetail(id) {
  const box = document.getElementById('cm-camp-detail');
  box.innerHTML = _commsLoading();
  try {
    const res = await api({ action:'comms_campaign_detail', campaign_id:id });
    if (!res.ok) { box.innerHTML = `<div class="comms-msg error">${escHtml(res.error||'Failed')}</div>`; return; }
    box.innerHTML = `<div class="comms-card inner">
      <div class="comms-row between"><b>Recipients (${res.recipients.length})</b><button class="comms-btn ghost sm" onclick="document.getElementById('cm-camp-detail').innerHTML=''">Close</button></div>
      <div class="comms-prelist">${res.recipients.map(r=>`<div class="comms-precol"><span>${escHtml(r.email)}</span><span class="comms-tag ${r.status==='sent'?'ok':(r.status==='failed'||r.status==='bounced'?'err':'')}">${escHtml(r.status)}</span>${r.error?`<span class="comms-muted">${escHtml(r.error)}</span>`:''}</div>`).join('')}</div>
    </div>`;
  } catch(e){ box.innerHTML = `<div class="comms-msg error">${escHtml(e.message||'Error')}</div>`; }
}
async function commsCancelCampaign(id) {
  if (!confirm('Cancel this campaign? Queued recipients will not be sent.')) return;
  try { await api({ action:'comms_cancel_campaign', campaign_id:id }); _commsRenderTab(); } catch(e){}
}

// ═══════════════════════════════════════════════════════════════════════════
// OPT-OUTS TAB
// ═══════════════════════════════════════════════════════════════════════════
async function _commsRenderOptouts(body) {
  body.innerHTML = _commsLoading();
  let list = [];
  try { const res = await api({ action:'comms_list_optouts' }); list = res.optouts||[]; } catch(e){}
  body.innerHTML = `
    <div class="comms-card">
      <div class="comms-row between"><h3>Opt-outs (${list.length})</h3></div>
      <div class="comms-row">
        <input id="opt-email" class="comms-input" placeholder="email@example.com">
        <select id="opt-scope" class="comms-input" style="max-width:220px">
          <option value="all">All emails</option>
          <option value="marketing_announcements">Marketing &amp; announcements</option>
        </select>
        <button class="comms-btn primary" onclick="commsAddOptout()">Add</button>
      </div>
      <div id="opt-msg" class="comms-msg"></div>
      <div class="comms-prelist">
        ${list.length ? list.map(o=>`<div class="comms-precol"><span>${escHtml(o.email)}</span><span class="comms-tag">${escHtml(o.scope)}</span><span class="comms-muted">${escHtml(o.source||'')}</span><button class="comms-btn ghost sm danger" onclick="commsRemoveOptout('${escHtml(o.email)}')">Remove</button></div>`).join('') : '<div class="comms-hint">No opt-outs.</div>'}
      </div>
    </div>`;
}
async function commsAddOptout() {
  const email = document.getElementById('opt-email').value.trim();
  const scope = document.getElementById('opt-scope').value;
  const el = document.getElementById('opt-msg');
  if (!email) { _commsMsg(el,'Enter an email.','error'); return; }
  try { const res = await api({ action:'comms_add_optout', email, scope }); if (res.ok) _commsRenderTab(); else _commsMsg(el,res.error||'Failed','error'); }
  catch(e){ _commsMsg(el,e.message||'Error','error'); }
}
async function commsRemoveOptout(email) {
  if (!confirm('Remove '+email+' from the opt-out list?')) return;
  try { await api({ action:'comms_remove_optout', email }); _commsRenderTab(); } catch(e){}
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLES (scoped, injected once) — uses portal CSS variables
// ═══════════════════════════════════════════════════════════════════════════
function _commsInjectStyles() {
  if (document.getElementById('comms-styles')) return;
  const s = document.createElement('style');
  s.id = 'comms-styles';
  s.textContent = `
  .comms-wrap{max-width:1100px;margin:0 auto;padding:var(--sp-4)}
  .comms-head h1{margin:0;font-size:var(--text-xl);color:var(--teal)}
  .comms-sub{color:var(--muted);margin-bottom:var(--sp-4)}
  .comms-tabs{display:flex;gap:var(--sp-2);border-bottom:2px solid var(--border);margin-bottom:var(--sp-4);flex-wrap:wrap}
  .comms-tab{background:none;border:0;padding:var(--sp-3) var(--sp-4);cursor:pointer;font-weight:600;color:var(--muted);border-bottom:3px solid transparent;margin-bottom:-2px}
  .comms-tab.active{color:var(--teal);border-bottom-color:var(--teal)}
  .comms-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-4)}
  @media(max-width:820px){.comms-grid{grid-template-columns:1fr}}
  .comms-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-md);padding:var(--sp-4);box-shadow:var(--shadow-xs);margin-bottom:var(--sp-4)}
  .comms-card.inner{box-shadow:none;background:var(--surface)}
  .comms-lbl{display:block;font-weight:600;font-size:var(--text-sm);margin:var(--sp-3) 0 var(--sp-1);color:var(--text)}
  .comms-hint{color:var(--muted);font-size:var(--text-xs);font-weight:400}
  .comms-input{width:100%;padding:var(--sp-2) var(--sp-3);border:1px solid var(--border);border-radius:var(--r-sm);font-size:var(--text-base);font-family:inherit;box-sizing:border-box;background:#fff;color:var(--text)}
  .comms-textarea{min-height:140px;resize:vertical}
  .comms-btn{border:0;border-radius:var(--r-sm);padding:var(--sp-2) var(--sp-4);font-weight:600;cursor:pointer;font-size:var(--text-base);margin-top:var(--sp-3)}
  .comms-btn.primary{background:var(--teal);color:#fff}
  .comms-btn.ghost{background:var(--surface);color:var(--teal);border:1px solid var(--border)}
  .comms-btn.sm{padding:var(--sp-1) var(--sp-2);font-size:var(--text-xs);margin-top:0}
  .comms-btn.danger{color:var(--error)}
  .comms-row{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
  .comms-row.between{justify-content:space-between}
  .comms-toolbar{display:flex;gap:var(--sp-2);margin-bottom:var(--sp-2)}
  .comms-tool{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:4px 10px;font-size:var(--text-sm);cursor:pointer;color:var(--text)}
  .comms-tool:hover{background:var(--teal-glow);border-color:var(--teal-light)}
  .comms-chips-label{font-size:var(--text-xs);color:var(--muted);margin-bottom:4px}
  .comms-chips{display:flex;flex-wrap:wrap;gap:var(--sp-1);margin-bottom:var(--sp-2)}
  .comms-chip{background:var(--teal-glow);color:var(--teal-mid);border:1px solid var(--teal-glow);border-radius:20px;padding:2px 10px;font-size:var(--text-xs);cursor:pointer}
  .comms-chip:hover{border-color:var(--teal-light)}
  .comms-fmt-hint{font-size:var(--text-xs);color:var(--muted);margin-top:6px;line-height:1.5}
  .comms-checks{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-top:var(--sp-2)}
  .comms-check{font-size:var(--text-sm);display:flex;align-items:center;gap:4px}
  .comms-picklist{max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-sm);margin-top:var(--sp-2)}
  .comms-pick{display:flex;gap:6px;padding:4px 8px;font-size:var(--text-sm);border-bottom:1px solid var(--border);align-items:center}
  .comms-precount{margin-top:var(--sp-3);font-size:var(--text-md)}
  .comms-prelist{max-height:260px;overflow:auto;margin-top:var(--sp-2)}
  .comms-precol{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);font-size:var(--text-sm);flex-wrap:wrap}
  .comms-muted{color:var(--muted);font-size:var(--text-xs)}
  .comms-tag{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1px 8px;font-size:var(--text-xs);color:var(--muted)}
  .comms-tag.ok{background:#dcfce7;color:#166534;border-color:#bbf7d0}
  .comms-tag.err{background:#fee2e2;color:#991b1b;border-color:#fecaca}
  .comms-tag.warn{background:#fef3c7;color:#92400e;border-color:#fde68a}
  .comms-tag.type{background:rgba(26,122,110,.1);color:var(--teal-mid);border-color:transparent;
                  font-weight:700;letter-spacing:.04em;text-transform:uppercase}
  .comms-tag.type.visit{background:rgba(147,51,234,.15);color:#7e22ce}
  .comms-msg{margin-top:var(--sp-2);font-size:var(--text-sm);min-height:1em}
  .comms-msg.ok{color:var(--success)} .comms-msg.error{color:var(--error)}
  .comms-emailwrap{margin-top:var(--sp-3)}
  .comms-iframe{width:100%;height:420px;border:1px solid var(--border);border-radius:var(--r-sm);background:#fff}
  .comms-tpl,.comms-camp{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-3);padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--r-sm);margin-top:var(--sp-2)}
  .comms-camp-main{flex:1;cursor:pointer}
  .comms-bar{height:6px;background:var(--surface);border-radius:4px;overflow:hidden;margin:6px 0}
  .comms-bar-fill{height:100%;background:var(--teal-light);transition:width .4s}
  .comms-modal-ov{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
  .comms-modal{background:var(--card);border-radius:var(--r-md);padding:var(--sp-5);width:100%;max-width:420px;box-shadow:var(--shadow-lg)}
  .comms-modal h3{margin:0 0 var(--sp-2);color:var(--teal)}
  .comms-modal-msg{color:var(--error);font-size:var(--text-xs);min-height:1em;margin-top:6px}
  `;
  document.head.appendChild(s);
}
