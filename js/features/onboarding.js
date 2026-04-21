// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING + GRADUATION — new hire flow, PDF capture, role promotion
// Depends on: constants.js (SEC), api.js (api, apiGet)
// Uses globals: _s, _pendingW9PdfBytes, _pendingW4PdfBytes
// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════════════════════════════════════════════
function loadOnboarding() {
  const nameEl = document.getElementById('onb-welcome-name');
  if (nameEl) nameEl.textContent = 'Welcome, ' + (_s.name ? _s.name.split(' ')[0] : '') + '!';

  const authHdr = { 'Authorization': 'Bearer ' + _s.token, 'Content-Type': 'application/json' };

  // Fetch status and contract context in parallel
  Promise.all([
    apiGet({ action: 'onboarding_get_status', token: _s.token }).then(r => r),
    apiGet({ action: 'onboarding_get_context', token: _s.token }).then(r => r)
  ]).then(([status, ctx]) => {
    // Render contract HTML
    if (ctx && ctx.contract_html) {
      document.getElementById('onb-contract-html').innerHTML = ctx.contract_html;
    }
    
    // Branch on worker type
    const isW2 = status && status.worker_type === 'w2_employee';
    if (isW2) {
      document.getElementById('onb-w9-module').style.display = 'none';
      document.getElementById('onb-w4-module').style.display = 'block';
      document.querySelector('#onb-task-contract .onb-task-hdr div div').textContent = 'Employment Agreement';
      document.querySelector('#onb-task-contract .onb-task-hdr div div:nth-child(2)').textContent = 'Read and sign your W2 employment agreement';
      document.querySelector('#onb-task-info .onb-task-hdr div div:nth-child(2)').textContent = 'Legal name, address, tax info & W-4';
    } else {
      document.getElementById('onb-w9-module').style.display = 'block';
      document.getElementById('onb-w4-module').style.display = 'none';
      document.querySelector('#onb-task-contract .onb-task-hdr div div').textContent = 'Contractor Agreement';
      document.querySelector('#onb-task-contract .onb-task-hdr div div:nth-child(2)').textContent = 'Read and sign your independent contractor agreement';
      document.querySelector('#onb-task-info .onb-task-hdr div div:nth-child(2)').textContent = 'Legal name, address, tax info & W-9';
    }

    // Pre-fill signed date
    const dateEl = document.getElementById('onb-signed-date');
    if (dateEl) dateEl.value = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    updateOnbProgress(status || {});

    // Update task icons based on completion
    if (status && status.info_done) {
      document.getElementById('onb-icon-info').textContent = '✅';
    }
    if (status && status.contract_done) {
      document.getElementById('onb-icon-contract').textContent = '✅';
    }
  }).catch(() => {
    const dateEl = document.getElementById('onb-signed-date');
    if (dateEl) dateEl.value = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  });
}

function toggleOnbTask(task) {
  const body = document.getElementById('onb-body-' + task);
  const chev = document.getElementById('onb-chev-' + task);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(90deg)';
}

function submitPersonalInfo() {
  const msgEl = document.getElementById('onb-info-msg');
  const fields = {
    legal_name     : document.getElementById('onb-legal-name').value.trim(),
    dob            : document.getElementById('onb-dob').value,
    phone          : document.getElementById('onb-phone').value.trim(),
    address_line1  : document.getElementById('onb-addr1').value.trim(),
    address_city   : document.getElementById('onb-city').value.trim(),
    address_state  : document.getElementById('onb-state').value.trim(),
    address_zip    : document.getElementById('onb-zip').value.trim(),
    emergency_name : document.getElementById('onb-ec-name').value.trim(),
    emergency_phone: document.getElementById('onb-ec-phone').value.trim(),
    tax_type       : (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value || '',
    tax_ein_type   : document.getElementById('onb-ein-type').value,
    tax_id_full    : document.getElementById('onb-tax-full').value.trim(),
  };

  if (!fields.legal_name) { showMsg(msgEl, 'Legal name is required.', false); return; }
  if (!fields.dob) { showMsg(msgEl, 'Date of birth is required.', false); return; }
  if (!fields.phone) { showMsg(msgEl, 'Phone number is required.', false); return; }
  if (!fields.address_line1 || !fields.address_city || !fields.address_state || !fields.address_zip) {
    showMsg(msgEl, 'Complete address is required.', false); return;
  }
  if (!fields.emergency_name || !fields.emergency_phone) { showMsg(msgEl, 'Emergency contact is required.', false); return; }
  const isW2 = document.getElementById('onb-w4-module').style.display !== 'none';
  if (!isW2) {
    if (!fields.tax_type) { showMsg(msgEl, 'Select SSN or EIN.', false); return; }
    if (!fields.tax_id_full || fields.tax_id_full.length < 10) { showMsg(msgEl, 'Enter full Tax ID.', false); return; }
  } else {
    fields.tax_type = 'SSN';
    fields.tax_id_full = document.getElementById('onb-w4-ssn').value.replace(/\D/g, '');
    if (fields.tax_id_full.length < 9) { showMsg(msgEl, 'Enter full SSN.', false); return; }
    fields.w4_filing_status = (document.querySelector('input[name="onb-w4-status"]:checked') || {}).value;
    fields.w4_multiple_jobs = document.getElementById('onb-w4-step2').checked;
    fields.w4_dependents_1 = document.getElementById('onb-w4-dep1').value || '0';
    fields.w4_dependents_2 = document.getElementById('onb-w4-dep2').value || '0';
    fields.w4_other_income = document.getElementById('onb-w4-4a').value || '0';
    fields.w4_deductions = document.getElementById('onb-w4-4b').value || '0';
    fields.w4_extra_withholding = document.getElementById('onb-w4-4c').value || '0';
  }

  const w9b64 = document.getElementById('onb-w9-base64').value;
  const w4b64 = document.getElementById('onb-w4-base64').value;
  
  const doSave = (b64Key, b64Val) => {
    const body = Object.assign({ action: 'save_info' }, fields);
    if (b64Val) body[b64Key] = b64Val;

    body.token = _s.token;
    body.secret = SEC;
    
    api(body).then(res => {
      if (res.ok) {
        showMsg(msgEl, 'Saved!', true);
        document.getElementById('onb-icon-info').textContent = '✅';
        updateOnbProgress({ info_done: true, contract_done: !!res.contract_done });
      } else {
        showMsg(msgEl, res.error || 'Failed to save.', false);
      }
    }).catch(() => showMsg(msgEl, 'Network error.', false));
  };

  if (!isW2) {
    if (w9b64) {
      doSave('w9_base64', w9b64);
    } else {
      showMsg(msgEl, 'Please generate and review your W-9 Form before saving.', false);
    }
  } else {
    if (w4b64) {
      doSave('w4_base64', w4b64);
    } else {
      showMsg(msgEl, 'Please generate and review your W-4 Form before saving.', false);
    }
  }
}

function onbTaxTypeChanged() {
  const type = (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value;
  const inp = document.getElementById('onb-tax-full');
  const einTypeDiv = document.getElementById('onb-ein-type-fg');
  inp.disabled = false;
  inp.value = '';
  
  if (type === 'SSN') {
    inp.placeholder = '___-__-____';
    inp.maxLength = 11;
    einTypeDiv.style.display = 'none';
  } else if (type === 'EIN') {
    inp.placeholder = '__-_______';
    inp.maxLength = 10;
    einTypeDiv.style.display = 'block';
  }
}

function onbFormatTaxId(inp) {
  const type = (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value;
  let val = inp.value.replace(/\D/g, '');
  if (type === 'SSN') {
    let formatted = '';
    if (val.length > 0) formatted += val.substring(0, 3);
    if (val.length > 3) formatted += '-' + val.substring(3, 5);
    if (val.length > 5) formatted += '-' + val.substring(5, 9);
    inp.value = formatted;
  } else if (type === 'EIN') {
    let formatted = '';
    if (val.length > 0) formatted += val.substring(0, 2);
    if (val.length > 2) formatted += '-' + val.substring(2, 9);
    inp.value = formatted;
  }
}

let _pendingW9PdfBytes = null;

async function generateAndReviewW9() {
  const btn = document.getElementById('btn-gen-w9');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const rawForm = await fetch('/fw9.pdf').then(res => res.arrayBuffer());
    const pdfDoc = await PDFLib.PDFDocument.load(rawForm);
    const form = pdfDoc.getForm();
    
    // Fill fields
    const nameStr = document.getElementById('onb-legal-name').value.trim();
    const addr1 = document.getElementById('onb-addr1').value.trim();
    const city = document.getElementById('onb-city').value.trim();
    const state = document.getElementById('onb-state').value.trim();
    const zip = document.getElementById('onb-zip').value.trim();
    const taxType = (document.querySelector('input[name="onb-tax-type"]:checked') || {}).value;
    const einType = document.getElementById('onb-ein-type').value;
    const taxIdFilled = document.getElementById('onb-tax-full').value.replace(/\D/g, '');

    if (!nameStr || !addr1 || !city || !state || !zip || !taxType || taxIdFilled.length < 9) {
      alert("Please completely fill out your Personal Information, Home Address, and Full Tax ID before generating the W-9.");
      btn.textContent = 'Review & Sign W-9 Form';
      btn.disabled = false;
      return;
    }

    // Name and address mapping
    try { form.getField('topmostSubform[0].Page1[0].f1_01[0]').setText(nameStr); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_07[0]').setText(addr1); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_08[0]').setText(city + ', ' + state + ' ' + zip); } catch(e){}
    
    // Checkboxes
    // c1_1[0] = Individual/Sole prop
    // c1_1[1] = C Corp
    // c1_1[2] = S Corp
    // c1_1[3] = Partnership
    // c1_1[4] = Trust/estate
    // c1_1[5] = LLC (with text field f1_03 for type: C/S/P)
    let c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]'); // Individual
    
    if (taxType === 'EIN') {
      try {
        if (einType === 'ccorp') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[1]');
        else if (einType === 'scorp') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[2]');
        else if (einType === 'partnership') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[3]');
        else if (einType === 'trust') c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[4]');
        else if (einType.startsWith('llc_')) {
          c1 = form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[5]');
          const subtype = einType.split('_')[1].toUpperCase();
          form.getField('topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].f1_03[0]').setText(subtype);
        }
      } catch(e) {}
    }
    if (c1) { try { c1.check(); } catch(e){} }
    
    // Tax ID mapping
    if (taxType === 'SSN') {
      try { form.getField('topmostSubform[0].Page1[0].f1_11[0]').setText(taxIdFilled.slice(0,3)); } catch(e){}
      try { form.getField('topmostSubform[0].Page1[0].f1_12[0]').setText(taxIdFilled.slice(3,5)); } catch(e){}
      try { form.getField('topmostSubform[0].Page1[0].f1_13[0]').setText(taxIdFilled.slice(5,9)); } catch(e){}
    } else if (taxType === 'EIN') {
      try { form.getField('topmostSubform[0].Page1[0].f1_14[0]').setText(taxIdFilled.slice(0,2)); } catch(e){}
      try { form.getField('topmostSubform[0].Page1[0].f1_15[0]').setText(taxIdFilled.slice(2,9)); } catch(e){}
    }
    
    // E-Signature and Date (drawn onto the PDF since signature fields might be locked forms)
    const pages = pdfDoc.getPages();
    const page = pages[0];
    const signatureText = nameStr + ' (e-signed)';
    const dateText = new Date().toLocaleDateString();
    
    page.drawText(signatureText, { x: 140, y: 198, size: 14 });
    page.drawText(dateText, { x: 450, y: 198, size: 14 });

    const helveticaFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    form.updateFieldAppearances(helveticaFont);
    
    // Do not form.flatten(); as IRS W-9 Acroform appearances break upon flattening with pdf-lib
    const pdfBytes = await pdfDoc.save();
    
    _pendingW9PdfBytes = pdfBytes;
    
    // Convert to ObjectURL to view in iframe
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('w9-preview-frame').src = url;
    document.getElementById('w9-modal-backdrop').style.display = 'flex';
  } catch (err) {
    console.error(err);
    alert('Failed to generate W-9: ' + err.message);
  } finally {
    btn.textContent = 'Review & Sign W-9 Form';
    btn.disabled = false;
  }
}

function closeW9Modal() {
  document.getElementById('w9-modal-backdrop').style.display = 'none';
  document.getElementById('w9-preview-frame').src = '';
  _pendingW9PdfBytes = null;
}

function confirmW9() {
  if (!_pendingW9PdfBytes) return;
  // Convert bytes to base64
  let binary = '';
  for (let i = 0; i < _pendingW9PdfBytes.byteLength; i++) {
    binary += String.fromCharCode(_pendingW9PdfBytes[i]);
  }
  const base64 = btoa(binary);
  document.getElementById('onb-w9-base64').value = base64;
  document.getElementById('w9-status-msg').style.display = 'block';
  closeW9Modal();
}

function onbFormatW4Ssn(inp) {
  let val = inp.value.replace(/\D/g, '');
  let formatted = '';
  if (val.length > 0) formatted += val.substring(0, 3);
  if (val.length > 3) formatted += '-' + val.substring(3, 5);
  if (val.length > 5) formatted += '-' + val.substring(5, 9);
  inp.value = formatted;
}

let _pendingW4PdfBytes = null;

async function generateAndReviewW4() {
  const btn = document.getElementById('btn-gen-w4');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const rawForm = await fetch('/fw4.pdf').then(res => res.arrayBuffer());
    const pdfDoc = await PDFLib.PDFDocument.load(rawForm);
    const form = pdfDoc.getForm();
    
    // Fill fields
    const fullName = document.getElementById('onb-legal-name').value.trim();
    const addr1 = document.getElementById('onb-addr1').value.trim();
    const city = document.getElementById('onb-city').value.trim();
    const state = document.getElementById('onb-state').value.trim();
    const zip = document.getElementById('onb-zip').value.trim();
    const ssn = document.getElementById('onb-w4-ssn').value.replace(/\D/g, '');

    if (!fullName || !addr1 || !city || !state || !zip || ssn.length < 9) {
      alert("Please check that Personal Information, Address, and SSN are fully entered.");
      btn.textContent = 'Review & Sign W-4 Form';
      btn.disabled = false;
      return;
    }

    const parts = fullName.split(' ');
    const lastName = parts.pop();
    const firstMiddle = parts.join(' ');

    const filingStatus = (document.querySelector('input[name="onb-w4-status"]:checked') || {}).value;
    const step2 = document.getElementById('onb-w4-step2').checked;
    
    // Convert dependent values
    let dep1Raw = parseFloat(document.getElementById('onb-w4-dep1').value) || 0;
    let dep2Raw = parseFloat(document.getElementById('onb-w4-dep2').value) || 0;
    let dep1 = dep1Raw * 2000;
    let dep2 = dep2Raw * 500;
    let depTotal = dep1 + dep2;

    const v4a = document.getElementById('onb-w4-4a').value.trim();
    const v4b = document.getElementById('onb-w4-4b').value.trim();
    const v4c = document.getElementById('onb-w4-4c').value.trim();

    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_01[0]').setText(firstMiddle); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_02[0]').setText(lastName); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_03[0]').setText(addr1); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].Step1a[0].f1_04[0]').setText(city + ', ' + state + ' ' + zip); } catch(e){}
    try { form.getField('topmostSubform[0].Page1[0].f1_05[0]').setText(ssn.substring(0,3) + '-' + ssn.substring(3,5) + '-' + ssn.substring(5,9)); } catch(e){}

    // Filing status checkboxes
    if (filingStatus === 'single') {
      try { form.getField('topmostSubform[0].Page1[0].c1_1[0]').check(); } catch(e){}
    } else if (filingStatus === 'married') {
      try { form.getField('topmostSubform[0].Page1[0].c1_1[1]').check(); } catch(e){}
    } else if (filingStatus === 'head') {
      try { form.getField('topmostSubform[0].Page1[0].c1_1[2]').check(); } catch(e){}
    }

    if (step2) {
      try { form.getField('topmostSubform[0].Page1[0].c1_2[0]').check(); } catch(e){}
    }

    try { if (dep1 > 0) form.getField('topmostSubform[0].Page1[0].Step3_ReadOrder[0].f1_06[0]').setText(dep1.toString()); } catch(e){}
    try { if (dep2 > 0) form.getField('topmostSubform[0].Page1[0].Step3_ReadOrder[0].f1_07[0]').setText(dep2.toString()); } catch(e){}
    try { if (depTotal > 0) form.getField('topmostSubform[0].Page1[0].f1_08[0]').setText(depTotal.toString()); } catch(e){}

    try { if (v4a) form.getField('topmostSubform[0].Page1[0].f1_09[0]').setText(v4a.toString()); } catch(e){}
    try { if (v4b) form.getField('topmostSubform[0].Page1[0].f1_10[0]').setText(v4b.toString()); } catch(e){}
    try { if (v4c) form.getField('topmostSubform[0].Page1[0].f1_11[0]').setText(v4c.toString()); } catch(e){}

    // E-Signature and Date (drawn onto the PDF)
    const pages = pdfDoc.getPages();
    const page = pages[0];
    const signatureText = fullName + ' (e-signed)';
    const dateText = new Date().toLocaleDateString();
    
    page.drawText(signatureText, { x: 80, y: 153, size: 14 });
    page.drawText(dateText, { x: 440, y: 153, size: 14 });

    const helveticaFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    form.updateFieldAppearances(helveticaFont);
    
    const pdfBytes = await pdfDoc.save();
    
    _pendingW4PdfBytes = pdfBytes;
    
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('w4-preview-frame').src = url;
    document.getElementById('w4-modal-backdrop').style.display = 'flex';
  } catch (err) {
    console.error(err);
    alert('Failed to generate W-4: ' + err.message);
  } finally {
    btn.textContent = 'Review & Sign W-4 Form';
    btn.disabled = false;
  }
}

function closeW4Modal() {
  document.getElementById('w4-modal-backdrop').style.display = 'none';
  document.getElementById('w4-preview-frame').src = '';
  _pendingW4PdfBytes = null;
}

function confirmW4() {
  if (!_pendingW4PdfBytes) return;
  let binary = '';
  for (let i = 0; i < _pendingW4PdfBytes.byteLength; i++) {
    binary += String.fromCharCode(_pendingW4PdfBytes[i]);
  }
  const base64 = btoa(binary);
  document.getElementById('onb-w4-base64').value = base64;
  document.getElementById('w4-status-msg').style.display = 'block';
  closeW4Modal();
}


function submitContract() {
  const msgEl = document.getElementById('onb-contract-msg');
  const agreed = document.getElementById('onb-agree-cb').checked;
  const signedName = document.getElementById('onb-signed-name').value.trim();

  if (!agreed) { showMsg(msgEl, 'You must check the agreement box.', false); return; }
  if (!signedName) { showMsg(msgEl, 'Type your full name to sign.', false); return; }

  api({ action: 'onboarding_save_contract', signed_name: signedName, signed_at: new Date().toISOString(), token: _s.token, secret: SEC })
  .then(res => {
    if (res.ok) {
      showMsg(msgEl, 'Signature saved!', true);
      document.getElementById('onb-icon-contract').textContent = '✅';
      updateOnbProgress({ info_done: !!res.info_done, contract_done: true });
    } else {
      showMsg(msgEl, res.error || 'Failed to save signature.', false);
    }
  }).catch(() => showMsg(msgEl, 'Network error.', false));
}

function updateOnbProgress(status) {
  const done = (status.info_done ? 1 : 0) + (status.contract_done ? 1 : 0);
  const pct  = (done / 2) * 100;
  const fill = document.getElementById('onb-fill');
  const label = document.getElementById('onb-progress-label');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = done + ' of 2 steps complete';

  if (status.info_done && status.contract_done) {
    const pending = document.getElementById('onb-pending-state');
    if (pending) pending.style.display = 'block';
  }
}

// ── Admin: New Hire Applications ──────────────────────────────────────────────
function loadPendingHires() {
  const container = document.getElementById('pending-hires-list');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Loading…</div>';

  apiGet({ action: 'onboarding_list_pending', token: _s.token }).then(res => {
    if (!res.ok || !res.applications || !res.applications.length) {
      container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">' +
        (res.error || 'No pending applications.') + '</div>';
      return;
    }
    container.innerHTML = res.applications.map(a => `
      <div class="pend-card" id="hire-card-${a.username}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div class="pend-sku">${a.username}</div>
          ${a.worker_type === 'w2_employee' ? '<span style="font-size:.65rem;background:var(--accent);color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">W-2</span>' : '<span style="font-size:.65rem;background:#475569;color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">1099</span>'}
        </div>
        <div class="pend-desc">${a.full_name || '—'}</div>
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:.5rem">
          Submitted: ${a.info_submitted_at ? new Date(a.info_submitted_at).toLocaleDateString() : '—'}
        </div>
        <div class="pend-ai" style="margin-bottom:.65rem">
          <span class="pend-ai-pill ${a.info_done ? 'conf-high' : 'conf-low'}">${a.info_done ? '✓ Info' : '✗ Info'}</span>
          <span class="pend-ai-pill ${a.contract_done ? 'conf-high' : 'conf-low'}">${a.contract_done ? '✓ Contract' : '✗ Contract'}</span>
        </div>
        <div class="pend-btns" style="flex-wrap:wrap;gap:.4rem">
          <button class="pend-approve" onclick="approveNewHire('${a.username}')">Approve → Trainee</button>
          <button class="pend-reject" onclick="rejectNewHire('${a.username}')">Request Changes</button>
          <button class="pend-reject" style="border-color:var(--teal-light);color:var(--teal-mid)" onclick="viewHireDocs('${a.username}')">📄 View Docs</button>
        </div>
      </div>`).join('');
  }).catch(() => {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">Network error.</div>';
  });
}

function approveNewHire(username) {
  api({ action: 'onboarding_approve', username, token: _s.token, secret: SEC }).then(res => {
    if (!res.ok) { alert(res.error || 'Failed to approve.'); return; }
    // Promote role to trainee via GAS
    api({ action: 'update_user', secret: SEC, token: _s.token, username, fields: { roles: 'trainee', active: true } })
      .then(() => {
        const card = document.getElementById('hire-card-' + username);
        if (card) card.innerHTML = `<div style="padding:.5rem 0;color:var(--success);font-weight:600">✓ ${username} approved as Trainee</div>`;
      });
  }).catch(() => alert('Network error.'));
}

let _allRecordsCache = [];

function loadAllApplications() {
  const container = document.getElementById('all-records-list');
  container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Loading…</div>';

  apiGet({ action: 'onboarding_list_all', token: _s.token }).then(res => {
    if (!res.ok) { container.innerHTML = `<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">${res.error || 'Failed to load.'}</div>`; return; }
    _allRecordsCache = res.applications || [];
    renderRecords(_allRecordsCache);
  }).catch(() => {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">Network error.</div>';
  });
}

function filterRecords(q) {
  const lower = q.toLowerCase();
  const filtered = _allRecordsCache.filter(a =>
    (a.username || '').toLowerCase().includes(lower) ||
    (a.full_name || '').toLowerCase().includes(lower)
  );
  renderRecords(filtered);
}

function renderRecords(list) {
  const container = document.getElementById('all-records-list');
  if (!list.length) { container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1rem;font-size:.85rem">No records found.</div>'; return; }

  const statusColor = { approved:'#dcfce7|#15803d', pending_review:'#fef3c7|#92400e', rejected:'#fee2e2|#b91c1c', in_progress:'#f1f5f9|#475569' };
  container.innerHTML = list.map(a => {
    const [bg, color] = (statusColor[a.status] || '#f1f5f9|#475569').split('|');
    const approvedLine = a.approved_at ? `<span style="font-size:.75rem;color:var(--muted)">Approved: ${new Date(a.approved_at).toLocaleDateString()}</span>` : '';
    return `<div class="pend-card" style="margin-bottom:.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.25rem">
        <div>
          <div style="display:flex;align-items:center;gap:.5rem">
            <div class="pend-sku">${a.username}</div>
            ${a.worker_type === 'w2_employee' ? '<span style="font-size:.65rem;background:var(--accent);color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">W-2</span>' : '<span style="font-size:.65rem;background:#475569;color:#fff;padding:.1rem .4rem;border-radius:4px;font-weight:700">1099</span>'}
          </div>
          <div class="pend-desc" style="margin:.1rem 0 0">${a.full_name || '—'}</div>
          ${approvedLine}
        </div>
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:99px;background:${bg};color:${color};text-transform:capitalize;letter-spacing:.04em">${(a.status||'').replace('_',' ')}</span>
      </div>
      <div class="pend-ai" style="margin-bottom:.5rem">
        <span class="pend-ai-pill ${a.info_done?'conf-high':'conf-low'}">${a.info_done?'✓ Info':'✗ Info'}</span>
        <span class="pend-ai-pill ${a.contract_done?'conf-high':'conf-low'}">${a.contract_done?'✓ Contract':'✗ Contract'}</span>
      </div>
      <button class="pend-reject" style="border-color:var(--teal-light);color:var(--teal-mid);width:100%" onclick="viewHireDocs('${a.username}')">📄 View Docs & Tax Form</button>
    </div>`;
  }).join('');
}

function viewHireDocs(username) {
  const modal = document.getElementById('docs-modal');
  const body  = document.getElementById('docs-modal-body');
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted)"><div class="spinner"></div></div>';
  modal.classList.add('open');

  apiGet({ action: 'onboarding_get_documents', username, token: _s.token }).then(d => {
    if (!d.ok) { body.innerHTML = `<p style="color:var(--error)">${d.error}</p>`; return; }
    body.innerHTML = `
      <div style="margin-bottom:1.25rem">
        <div class="docs-section-title">Personal Information</div>
        <div class="docs-row"><span>Full Name</span><span>${d.full_name || '—'}</span></div>
        <div class="docs-row"><span>Date of Birth</span><span>${d.dob || '—'}</span></div>
        <div class="docs-row"><span>Phone</span><span>${d.phone || '—'}</span></div>
        <div class="docs-row"><span>Address</span><span>${[d.address_line1, d.address_city, d.address_state, d.address_zip].filter(Boolean).join(', ') || '—'}</span></div>
        <div class="docs-row"><span>Emergency Contact</span><span>${d.emergency_name || '—'} ${d.emergency_phone ? '· ' + d.emergency_phone : ''}</span></div>
        <div class="docs-row"><span>Type</span><span style="font-weight:700;color:var(--accent)">${d.worker_type === 'w2_employee' ? 'W-2 Employee' : '1099 Contractor'}</span></div>
        <div class="docs-row"><span>Tax ID Type</span><span>${d.tax_type || '—'}</span></div>
        <div class="docs-row"><span>Last 4 Digits</span><span>${d.tax_id_last4 ? '••••' + d.tax_id_last4 : '—'}</span></div>
      </div>
      <div style="margin-bottom:1.25rem">
        <div class="docs-section-title">Contract Signature</div>
        <div class="docs-row"><span>Signed Name</span><span>${d.contract_signed_name || '—'}</span></div>
        <div class="docs-row"><span>Signed At</span><span>${d.contract_signed_at ? new Date(d.contract_signed_at).toLocaleString() : '—'}</span></div>
      </div>
      <div>
        <div class="docs-section-title">Tax Document</div>
        ${d.worker_type === 'w2_employee' ?
          (d.w4_signed_url
            ? `<a href="${d.w4_signed_url}" target="_blank" class="docs-w9-btn">⬇ Open W-4 PDF</a><div style="font-size:.72rem;color:var(--muted);margin-top:.3rem">Link expires in 1 hour</div>`
            : '<span style="color:var(--muted);font-size:.85rem">No W-4 uploaded</span>') :
          (d.w9_signed_url
            ? `<a href="${d.w9_signed_url}" target="_blank" class="docs-w9-btn">⬇ Open W-9 PDF</a><div style="font-size:.72rem;color:var(--muted);margin-top:.3rem">Link expires in 1 hour</div>`
            : '<span style="color:var(--muted);font-size:.85rem">No W-9 uploaded</span>')
        }
      </div>`;
  }).catch(() => { body.innerHTML = '<p style="color:var(--error)">Network error.</p>'; });
}

function closeDocsModal() {
  document.getElementById('docs-modal').classList.remove('open');
}

function rejectNewHire(username) {
  const note = prompt('Enter a note for the applicant (required):');
  if (!note) return;
  api({ action: 'onboarding_reject', username, note, token: _s.token, secret: SEC }).then(res => {
    if (!res.ok) { alert(res.error || 'Failed.'); return; }
    const card = document.getElementById('hire-card-' + username);
    if (card) card.innerHTML = `<div style="padding:.5rem 0;color:var(--warn);font-weight:600">⚠ Changes requested for ${username}</div>`;
  }).catch(() => alert('Network error.'));
}

// ══════════════════════════════════════════════════════════════════════════════
// GRADUATION
// ══════════════════════════════════════════════════════════════════════════════
function checkGraduation(moduleId) {
  if (!moduleId || !_s) return;
  if (!(_s.roles || []).includes('trainee')) return;

  const mod = (_trModules || []).find(m => m.id === moduleId);
  if (!mod || !mod.is_graduation_module) return;

  const items = (mod.items || []).filter(i => i.type !== 'submodule');
  if (!items.length) return;

  const allDone = items.every(i => {
    const key = `${moduleId}::${i.id}`;
    return _trProgress[key] && _trProgress[key].status === 'completed';
  });

  if (allDone) triggerGraduation();
}

function triggerGraduation() {
  api({ action: 'update_user', secret: SEC, token: _s.token, username: _s.username || _s.name,
        fields: { roles: 'technician', active: true } })
    .then(res => {
      if (!res.ok) return;
      _s.roles = ['technician'];
      _s.pages = unionPages_(['technician']);
      localStorage.setItem('mcps_s', JSON.stringify(_s));
      showGraduationModal();
      setTimeout(() => { buildNav(); navigateTo('home'); }, 3000);
    }).catch(() => {});
}

function showGraduationModal() {
  let el = document.getElementById('grad-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'grad-modal';
    el.className = 'grad-modal';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="grad-modal-inner">
    <div style="font-size:3.5rem;margin-bottom:.75rem">🎉</div>
    <div style="font-family:'Oswald',sans-serif;font-size:1.75rem;font-weight:700;letter-spacing:.02em">You're now a Technician!</div>
    <div style="font-size:.95rem;color:rgba(255,255,255,.75);margin-top:.5rem">Your account has been upgraded. Redirecting…</div>
  </div>`;
  el.style.display = 'flex';
  setTimeout(() => { el.style.display = 'none'; }, 3200);
}


async function loadHomeStats() {
  const container = document.getElementById('home-stats');
  if(!container) return;
  
  if(!isAdmin()) {
    container.style.display = 'none';
    const alertsEl = document.getElementById('home-alerts');
    if(alertsEl) alertsEl.innerHTML = '';
    return;
  }
  container.style.display = 'grid';

  // Show skeletons
  container.innerHTML = `<div class="hs-card skeleton-block" style="height:100px"></div><div class="hs-card skeleton-block" style="height:100px"></div><div class="hs-card skeleton-block" style="height:100px"></div>`;

  try {
    const [crmRes, goalRes, unRes, alertsRes] = await Promise.all([
      apiGet({ action: 'get_crm_data',       token: _s.token }),
      apiGet({ action: 'get_weekly_goal',    token: _s.token }),
      apiGet({ action: 'get_unassigned',     token: _s.token }),
      apiGet({ action: 'get_invoice_alerts', token: _s.token })
    ]);

    let signedCount = 0;
    if(crmRes.ok && crmRes.data){
      signedCount = crmRes.data.filter(i => (i.status||'').toUpperCase() === 'SIGNED').length;
    }

    let weeklyGoal = goalRes.ok ? (goalRes.goal || 5) : 5;
    let weeklySigned = goalRes.ok ? (goalRes.signed_this_week || 0) : 0;
    
    let unassignedCount = unRes.ok && unRes.pools
      ? unRes.pools.filter(p => (p.service||'').toLowerCase().includes('weekly full service')).length
      : 0;

    renderHomeStats(signedCount, weeklySigned, weeklyGoal, unassignedCount);
    renderInvoiceAlerts(alertsRes);
  } catch(e) {
    console.error("Home stats error:", e);
    container.innerHTML = `<div style="grid-column:1/-1;color:var(--muted);font-size:.8rem;text-align:center;padding:1rem;background:var(--surface);border-radius:12px">Summary unavailable</div>`;
  }
}

function renderHomeStats(totalSigned, weeklySigned, weeklyGoal, unassigned) {
  const container = document.getElementById('home-stats');
  if(!container) return;

  const pct = Math.min(weeklySigned / Math.max(weeklyGoal, 1), 1);

  container.innerHTML = `
    <div class="hs-card" onclick="navigateTo('crm')">
      <div class="hs-label">Signed Pools</div>
      <div class="hs-value">${totalSigned}</div>
      <div class="hs-sub">Active recurring contracts</div>
    </div>
    <div class="hs-card" onclick="navigateTo('crm')">
      <div class="hs-label">Weekly Progress</div>
      <div class="hs-value">${weeklySigned} / ${weeklyGoal}</div>
      <div class="hs-progress-wrap">
        <div class="hs-progress-bar" style="width:${pct*100}%"></div>
      </div>
      <div class="hs-sub">New signs this week</div>
    </div>
    <div class="hs-card" onclick="navigateTo('live_map')">
      <div class="hs-label">Needs Routing</div>
      <div class="hs-value" style="color: ${unassigned > 0 ? 'var(--warn)' : 'var(--teal)'}">${unassigned}</div>
      <div class="hs-sub">Pools without a schedule</div>
    </div>
  `;
}

function renderInvoiceAlerts(res) {
  const el = document.getElementById('home-alerts');
  if (!el) return;
  if (!res || !res.ok) { el.innerHTML = ''; return; }

  const firstList   = Array.isArray(res.first_invoice)   ? res.first_invoice   : [];
  const startupList = Array.isArray(res.startup_invoice) ? res.startup_invoice : [];
  const convertList = Array.isArray(res.startup_convert) ? res.startup_convert : [];
  if (!firstList.length && !startupList.length && !convertList.length) {
    el.innerHTML = `
      <div class="ia-allgood">
        <div class="ia-allgood-label">Billing Actions</div>
        <div class="ia-allgood-value">All caught up ✓</div>
        <div class="ia-allgood-sub">No invoices pending</div>
      </div>`;
    return;
  }

  const makeBanner = (id, label, countLabel, sub, pools) => {
    if (!pools.length) return '';
    const rows = pools.map(p => `
      <div class="ia-pool-row" onclick="_openAlertPool('${p.quote_id}')">
        <div>
          <div class="ia-pool-name">${p.customer_name || p.pool_id}</div>
          <div class="ia-pool-addr">${p.address || ''}${p.city ? ', ' + p.city : ''}</div>
        </div>
        <span class="ia-view-btn">View ▸</span>
      </div>`).join('');
    return `
      <div class="ia-banner" id="${id}">
        <div class="ia-header" onclick="this.closest('.ia-banner').classList.toggle('open')">
          <div class="ia-header-text">
            <div class="ia-label">${label}</div>
            <div class="ia-count">${pools.length}</div>
            <div class="ia-sub">${sub}</div>
          </div>
          <span class="ia-chevron">▼</span>
        </div>
        <div class="ia-body">${rows}</div>
      </div>`;
  };

  el.innerHTML =
    _makeConvertBanner(convertList) +
    makeBanner('ia-first-invoice',   'First Invoice',   firstList.length,   'Ready to send',   firstList) +
    makeBanner('ia-startup-invoice', 'Startup Invoice', startupList.length, 'Ready to send',   startupList);
}

function _makeConvertBanner(pools) {
  if (!pools.length) return '';
  const rows = pools.map(p => `
    <div class="ia-pool-row" id="ia-conv-${p.quote_id}">
      <div>
        <div class="ia-pool-name">${p.customer_name || p.pool_id}</div>
        <div class="ia-pool-addr">${p.address || ''}${p.city ? ', ' + p.city : ''}</div>
      </div>
      <div style="display:flex;gap:.4rem;flex-shrink:0">
        <span class="ia-view-btn ia-convert-btn" onclick="_convertToWFS('${p.quote_id}','${p.last_visit_date}',this)">Convert</span>
        <span class="ia-view-btn ia-skip-btn" onclick="_skipConvert('${p.quote_id}')">Skip</span>
      </div>
    </div>`).join('');
  return `
    <div class="ia-banner" id="ia-startup-convert">
      <div class="ia-header" onclick="this.closest('.ia-banner').classList.toggle('open')">
        <div class="ia-header-text">
          <div class="ia-label">Convert to WFS</div>
          <div class="ia-count">${pools.length}</div>
          <div class="ia-sub">Startup → Weekly Full Service</div>
        </div>
        <span class="ia-chevron">▼</span>
      </div>
      <div class="ia-body">${rows}</div>
    </div>`;
}

async function _convertToWFS(quoteId, billingStart, btn) {
  btn.textContent = '...';
  btn.style.opacity = '.5';
  btn.style.pointerEvents = 'none';
  try {
    const res = await api({ action: 'convert_to_wfs', token: _s.token, secret: SEC, quote_id: quoteId, billing_start: billingStart });
    if (res.ok) {
      document.getElementById('ia-conv-' + quoteId)?.remove();
      const body = document.querySelector('#ia-startup-convert .ia-body');
      if (body && !body.children.length) document.getElementById('ia-startup-convert')?.remove();
    } else {
      btn.textContent = 'Convert';
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
      alert('Conversion failed: ' + (res.error || 'Unknown error'));
    }
  } catch(e) {
    btn.textContent = 'Convert';
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
    alert('Network error. Please try again.');
  }
}

function _skipConvert(quoteId) {
  document.getElementById('ia-conv-' + quoteId)?.remove();
  const body = document.querySelector('#ia-startup-convert .ia-body');
  if (body && !body.children.length) document.getElementById('ia-startup-convert')?.remove();
}

function _openAlertPool(quoteId) {
  if (!quoteId) return;
  window._pendingAlertQuoteId = quoteId;
  navigateTo('crm');
}
