/**
 * Tests for js/features/startup_checklists.js — Pool School Checklist
 *
 * The source file is plain global-scope JS with no module system.
 * We seed required globals, then use indirect eval so const/let declarations
 * (converted to var) land on the global object and are accessible in tests.
 */

const fs   = require('fs');
const path = require('path');

// ── Stubs required by startup_checklists.js ───────────────────────────────────
global._s            = { token: 'test-token', name: 'Test Tech' };
global._crmCache     = null;
global._pasState     = null;
global._activeHubTab = '';

global.escHtml = str => String(str ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;');

global.isAdmin   = () => true;
global.apiGet    = () => Promise.resolve({ ok: true, checklists: [] });
global.api       = () => Promise.resolve({ ok: true });
global.findPool_ = () => null;
global.closePoolAction = () => {};

// ── Load module under test into global scope ──────────────────────────────────
// Indirect eval (0, eval)(...) runs at global scope, so var-declarations become
// properties of the global object — accessible by name in all test functions.
const src = fs.readFileSync(
  path.join(__dirname, '../js/features/startup_checklists.js'), 'utf8'
);
const varSrc = src.replace(/^(const|let) /gm, 'var ');
// eslint-disable-next-line no-eval
(0, eval)(varSrc);

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCL_POOL_SCHOOL data structure
// ─────────────────────────────────────────────────────────────────────────────
describe('SCL_POOL_SCHOOL data structure', () => {
  test('has exactly 5 sections', () => {
    expect(SCL_POOL_SCHOOL).toHaveLength(5);
  });

  test('section types are yn / yn / yn / chemical / yn', () => {
    expect(SCL_POOL_SCHOOL.map(s => s.type)).toEqual(['yn','yn','yn','chemical','yn']);
  });

  test('Performance Check section has 15 items', () => {
    const pc = SCL_POOL_SCHOOL.find(s => s.section === 'Performance Check');
    expect(pc.items).toHaveLength(15);
  });

  test('Pool Cleaning section has 4 starred items', () => {
    const pc = SCL_POOL_SCHOOL.find(s => s.section === 'Pool Cleaning');
    expect(pc.starred).toHaveLength(4);
  });

  test('Chemical Levels section has 4 chemicals', () => {
    const chem = SCL_POOL_SCHOOL.find(s => s.type === 'chemical');
    expect(chem.chemicals).toHaveLength(4);
  });

  test('each chemical has key, range, and id', () => {
    const chem = SCL_POOL_SCHOOL.find(s => s.type === 'chemical');
    chem.chemicals.forEach(c => {
      expect(c).toHaveProperty('key');
      expect(c).toHaveProperty('range');
      expect(c).toHaveProperty('id');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SCL_TECHNICIAN data structure
// ─────────────────────────────────────────────────────────────────────────────
describe('SCL_TECHNICIAN data structure', () => {
  test('has the 7 expected sections', () => {
    expect(Object.keys(SCL_TECHNICIAN)).toEqual(
      expect.arrayContaining(['Remove','Install','Program','Check','Start Up','Adjust','Heater'])
    );
  });

  test('every section has at least 1 item', () => {
    Object.values(SCL_TECHNICIAN).forEach(items => expect(items.length).toBeGreaterThan(0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. sclToggleYN
// ─────────────────────────────────────────────────────────────────────────────
describe('sclToggleYN', () => {
  function makeRow(rowClass = 'scl-yn-row') {
    document.body.innerHTML = `
      <div class="${rowClass}">
        <div class="scl-yn-btns">
          <button class="scl-yn-btn scl-yn-yes" data-val="yes">YES</button>
          <button class="scl-yn-btn scl-yn-no"  data-val="no">NO</button>
        </div>
      </div>`;
    return {
      yes: document.querySelector('.scl-yn-yes'),
      no:  document.querySelector('.scl-yn-no'),
    };
  }

  test('clicking YES marks it active; NO stays inactive', () => {
    const { yes, no } = makeRow();
    sclToggleYN(yes);
    expect(yes.classList.contains('active')).toBe(true);
    expect(no.classList.contains('active')).toBe(false);
  });

  test('switching from YES to NO updates correctly', () => {
    const { yes, no } = makeRow();
    sclToggleYN(yes);
    sclToggleYN(no);
    expect(no.classList.contains('active')).toBe(true);
    expect(yes.classList.contains('active')).toBe(false);
  });

  test('works on a scl-chem-row', () => {
    const { yes } = makeRow('scl-chem-row');
    sclToggleYN(yes);
    expect(yes.classList.contains('active')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. _serializeSclForm — pool_school
// ─────────────────────────────────────────────────────────────────────────────
describe('_serializeSclForm (pool_school)', () => {
  beforeEach(() => {
    _sclType = 'pool_school';

    // Build yn buttons for every item in every yn section so serializer
    // finds them and builds all sections in items_data.
    const ynButtons = SCL_POOL_SCHOOL
      .filter(s => s.type === 'yn')
      .flatMap(s => s.items.map(item => `
        <button class="scl-yn-btn scl-yn-yes"
          data-section="${s.section}" data-item="${item}" data-val="yes">YES</button>
        <button class="scl-yn-btn scl-yn-no"
          data-section="${s.section}" data-item="${item}" data-val="no">NO</button>`))
      .join('');

    document.body.innerHTML = `
      <select id="scl-client-select"><option value="Q001" selected>Client A</option></select>
      <input id="scl-customer-name-hidden" value="Client A">
      <input id="scl-pool-id-hidden"       value="P001">
      <input id="scl-phone-hidden"         value="5551234">
      <input id="scl-address"              value="123 Main St">
      <input id="scl-start-date"           value="2026-05-15">
      <input id="scl-access-code"          value="">
      <input id="scl-animals"              value="">
      <input id="scl-wifi-name"            value="">
      <input id="scl-wifi-pw"              value="">
      <select id="scl-equipment"><option value="" selected></option></select>
      <select id="scl-plaster"><option value=""  selected></option></select>
      <textarea id="scl-qc-notes"></textarea>
      <textarea id="scl-punchlist"></textarea>
      <textarea id="scl-customer-notes">Great visit</textarea>
      <input id="scl-tech-name" value="Test Tech">
      <input id="scl-chem-ph"       value="7.4">
      <input id="scl-chem-chlorine" value="3.0">
      <input id="scl-chem-acid"     value="130">
      <input id="scl-chem-salt"     value="280">
      <!-- Levels Are Normal YES (active) -->
      <button class="scl-yn-btn active"
        data-section="Chemical Levels" data-item="Levels Are Normal" data-val="yes">YES</button>
      <button class="scl-yn-btn"
        data-section="Chemical Levels" data-item="Levels Are Normal" data-val="no">NO</button>
      <!-- Performance Check first item YES (active) -->
      <div id="yn-buttons">${ynButtons}</div>`;

    // Mark one item active to verify selective capture
    document.querySelector(
      '.scl-yn-btn[data-section="Performance Check"][data-item="Check Pool Circulation System"][data-val="yes"]'
    ).classList.add('active');
  });

  test('returns checklist_type pool_school', () => {
    expect(_serializeSclForm().checklist_type).toBe('pool_school');
  });

  test('captures quote_id and customer fields', () => {
    const d = _serializeSclForm();
    expect(d.quote_id).toBe('Q001');
    expect(d.customer_name).toBe('Client A');
    expect(d.pool_id).toBe('P001');
  });

  test('captures chemical input values', () => {
    const chem = _serializeSclForm().items_data['Chemical Levels'];
    expect(chem.PH).toBe('7.4');
    expect(chem.Chlorine).toBe('3.0');
    expect(chem.Acid).toBe('130');
    expect(chem['Salt System']).toBe('280');
  });

  test('captures Levels Are Normal as "yes"', () => {
    expect(_serializeSclForm().items_data['Chemical Levels']['Levels Are Normal']).toBe('yes');
  });

  test('captures customer notes', () => {
    expect(_serializeSclForm().customer_notes).toBe('Great visit');
  });

  test('active YES button serializes as "yes"; untouched item serializes as null', () => {
    const pc = _serializeSclForm().items_data['Performance Check'];
    expect(pc['Check Pool Circulation System']).toBe('yes');
    expect(pc['Check Filter (correct operation/leaks)']).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. _applyDraftToForm — restores YES/NO buttons
// ─────────────────────────────────────────────────────────────────────────────
describe('_applyDraftToForm (pool_school)', () => {
  beforeEach(() => {
    _sclType = 'pool_school';
    global.sclClientSelected = jest.fn();

    document.body.innerHTML = `
      <select id="scl-client-select">
        <option value="">—</option>
        <option value="Q002">Client B</option>
      </select>
      <input id="scl-start-date"    value="">
      <input id="scl-access-code"   value=""><input id="scl-animals"  value="">
      <input id="scl-wifi-name"     value=""><input id="scl-wifi-pw"   value="">
      <select id="scl-equipment"></select><select id="scl-plaster"></select>
      <textarea id="scl-qc-notes"></textarea><textarea id="scl-punchlist"></textarea>
      <textarea id="scl-customer-notes"></textarea>
      <input id="scl-tech-name" value="">
      <input id="scl-chem-ph" value=""><input id="scl-chem-chlorine" value="">
      <input id="scl-chem-acid" value=""><input id="scl-chem-salt" value="">
      <button class="scl-yn-btn"
        data-section="Performance Check"
        data-item="Check Pool Circulation System" data-val="yes">YES</button>
      <button class="scl-yn-btn"
        data-section="Performance Check"
        data-item="Check Pool Circulation System" data-val="no">NO</button>`;
  });

  test('restores YES button from draft', () => {
    _applyDraftToForm({
      quote_id: 'Q002',
      items_data: { 'Performance Check': { 'Check Pool Circulation System': 'yes' } }
    });
    expect(document.querySelector('.scl-yn-btn[data-val="yes"]').classList.contains('active')).toBe(true);
  });

  test('restores NO button from draft', () => {
    _applyDraftToForm({
      quote_id: 'Q002',
      items_data: { 'Performance Check': { 'Check Pool Circulation System': 'no' } }
    });
    expect(document.querySelector('.scl-yn-btn[data-val="no"]').classList.contains('active')).toBe(true);
  });

  test('restores technician name', () => {
    _applyDraftToForm({ technician_name: 'Jane', items_data: {} });
    expect(document.getElementById('scl-tech-name').value).toBe('Jane');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. submitStartupChecklist — validation guards
// ─────────────────────────────────────────────────────────────────────────────
describe('submitStartupChecklist validation', () => {
  function baseDOM() {
    _sclType      = 'pool_school';
    _sclHasSig    = false;
    _sclHasCustSig = false;

    const ynButtons = SCL_POOL_SCHOOL
      .filter(s => s.type === 'yn')
      .flatMap(s => s.items.map(item => `
        <button class="scl-yn-btn"
          data-section="${s.section}" data-item="${item}" data-val="yes">YES</button>
        <button class="scl-yn-btn"
          data-section="${s.section}" data-item="${item}" data-val="no">NO</button>`))
      .join('');

    document.body.innerHTML = `
      <select id="scl-client-select"><option value="" selected>—</option></select>
      <input id="scl-customer-name-hidden" value="">
      <input id="scl-pool-id-hidden" value=""><input id="scl-phone-hidden" value="">
      <input id="scl-address" value=""><input id="scl-start-date" value="2026-05-15">
      <input id="scl-access-code" value=""><input id="scl-animals" value="">
      <input id="scl-wifi-name"   value=""><input id="scl-wifi-pw" value="">
      <select id="scl-equipment"></select><select id="scl-plaster"></select>
      <textarea id="scl-qc-notes"></textarea><textarea id="scl-punchlist"></textarea>
      <textarea id="scl-customer-notes"></textarea>
      <input id="scl-tech-name" value="">
      <input id="scl-chem-ph" value=""><input id="scl-chem-chlorine" value="">
      <input id="scl-chem-acid" value=""><input id="scl-chem-salt" value="">
      <button class="scl-yn-btn" data-section="Chemical Levels"
        data-item="Levels Are Normal" data-val="yes">YES</button>
      <button class="scl-yn-btn" data-section="Chemical Levels"
        data-item="Levels Are Normal" data-val="no">NO</button>
      ${ynButtons}
      <div id="scl-msg" style="display:none"></div>
      <button id="scl-submit-btn">Submit</button>`;
  }

  test('shows error when no client is selected', () => {
    baseDOM();
    submitStartupChecklist();
    const msg = document.getElementById('scl-msg');
    expect(msg.style.display).toBe('block');
    expect(msg.textContent).toMatch(/select a client/i);
  });

  test('shows error when technician name is missing', () => {
    baseDOM();
    document.getElementById('scl-client-select').innerHTML =
      '<option value="Q003" selected>Client C</option>';
    document.getElementById('scl-customer-name-hidden').value = 'Client C';
    submitStartupChecklist();
    expect(document.getElementById('scl-msg').textContent).toMatch(/technician name/i);
  });

  test('shows error when technician signature is missing', () => {
    baseDOM();
    document.getElementById('scl-client-select').innerHTML =
      '<option value="Q003" selected>Client C</option>';
    document.getElementById('scl-customer-name-hidden').value = 'Client C';
    document.getElementById('scl-tech-name').value = 'Jane';
    _sclHasSig = false;
    submitStartupChecklist();
    expect(document.getElementById('scl-msg').textContent).toMatch(/sign the checklist/i);
  });

  test('shows error when customer signature is missing (pool_school)', () => {
    baseDOM();
    document.getElementById('scl-client-select').innerHTML =
      '<option value="Q003" selected>Client C</option>';
    document.getElementById('scl-customer-name-hidden').value = 'Client C';
    document.getElementById('scl-tech-name').value = 'Jane';
    _sclHasSig     = true;
    _sclHasCustSig = false;
    submitStartupChecklist();
    expect(document.getElementById('scl-msg').textContent).toMatch(/customer signature/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Draft save / discard cycle
// ─────────────────────────────────────────────────────────────────────────────
describe('draft localStorage cycle', () => {
  beforeEach(() => {
    localStorage.clear();
    _sclType = 'pool_school';

    document.body.innerHTML = `
      <select id="scl-client-select"><option value="Q004" selected>D</option></select>
      <input id="scl-customer-name-hidden" value="D">
      <input id="scl-pool-id-hidden" value="P004"><input id="scl-phone-hidden" value="">
      <input id="scl-address" value=""><input id="scl-start-date" value="2026-05-15">
      <input id="scl-access-code" value=""><input id="scl-animals" value="">
      <input id="scl-wifi-name" value=""><input id="scl-wifi-pw" value="">
      <select id="scl-equipment"></select><select id="scl-plaster"></select>
      <textarea id="scl-qc-notes"></textarea><textarea id="scl-punchlist"></textarea>
      <textarea id="scl-customer-notes"></textarea>
      <input id="scl-tech-name" value="Jane">
      <input id="scl-chem-ph" value="7.4"><input id="scl-chem-chlorine" value="3">
      <input id="scl-chem-acid" value="120"><input id="scl-chem-salt" value="300">
      <button class="scl-yn-btn" data-section="Chemical Levels"
        data-item="Levels Are Normal" data-val="yes">YES</button>
      <button class="scl-yn-btn" data-section="Chemical Levels"
        data-item="Levels Are Normal" data-val="no">NO</button>
      <div id="scl-msg" style="display:none"></div>`;
  });

  test('sclSaveDraft writes to localStorage with correct fields', () => {
    sclSaveDraft();
    const raw = localStorage.getItem('mcps_scl_draft_pool_school');
    expect(raw).not.toBeNull();
    const draft = JSON.parse(raw);
    expect(draft.technician_name).toBe('Jane');
    expect(draft.checklist_type).toBe('pool_school');
    expect(draft.saved_at).toBeDefined();
  });

  test('sclDiscardDraft removes the localStorage key', () => {
    sclSaveDraft();
    document.body.innerHTML += `<div id="scl-draft-banner"></div>`;
    sclDiscardDraft();
    expect(localStorage.getItem('mcps_scl_draft_pool_school')).toBeNull();
  });
});
