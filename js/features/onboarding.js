// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING + GRADUATION — new hire flow, PDF capture, role promotion
// Depends on: constants.js (SEC), api.js (api, apiGet)
// Uses globals: _s, _pendingW9PdfBytes, _pendingW4PdfBytes
// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════════════════════════════════════════════
let _onbStatus = { sensitive_info_done: false, i9_done: false, info_done: false, contract_done: false };

function loadOnboarding() {
  const nameEl = document.getElementById('onb-welcome-name');
  if (nameEl) nameEl.textContent = 'Welcome, ' + (_s.name ? _s.name.split(' ')[0] : '') + '!';

  // Fetch status and contract context in parallel
  Promise.all([
    apiGet({ action: 'onboarding_get_status', token: _s.token }).then(r => r),
    apiGet({ action: 'onboarding_get_context', token: _s.token }).then(r => r)
  ]).then(([status, ctx]) => {
    // Render contract HTML
    if (ctx && ctx.contract_html) {
      document.getElementById('onb-contract-html').innerHTML = ctx.contract_html;
    } 
    
    document.querySelector('#onb-task-contract .onb-task-hdr div div').textContent = 'Employee Agreement';
    document.querySelector('#onb-task-contract .onb-task-hdr div div:nth-child(2)').textContent = 'Read and sign your employment agreement';

    // Pre-fill signed date
    const dateEl = document.getElementById('onb-signed-date');
    if (dateEl) dateEl.value = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    updateOnbProgress(status || {});

    if (status) {
      const legalNameEl = document.getElementById('onb-legal-name');
      const phoneEl = document.getElementById('onb-phone');
      const emailEl = document.getElementById('onb-email');
      const preferredEl = document.getElementById('onb-preferred-name');
      const i9SigEl = document.getElementById('onb-i9-signature');
      const contractSigEl = document.getElementById('onb-signed-name');
      if (legalNameEl && status.full_name && !legalNameEl.value) legalNameEl.value = status.full_name;
      if (phoneEl && status.phone && !phoneEl.value) phoneEl.value = status.phone;
      if (emailEl && status.email && !emailEl.value) emailEl.value = status.email;
      if (preferredEl && status.preferred_name && !preferredEl.value) preferredEl.value = status.preferred_name;
      if (i9SigEl && status.full_name && !i9SigEl.value) i9SigEl.value = status.full_name;
      if (contractSigEl && status.full_name && !contractSigEl.value) contractSigEl.value = status.full_name;
    }

    // Update task icons based on completion
    if (status && status.sensitive_info_done) {
      document.getElementById('onb-icon-info').textContent = '✅';
    }
    if (status && status.i9_done) {
      document.getElementById('onb-icon-i9').textContent = '✅';
    }
    if (status && status.info_done) {
      document.getElementById('onb-icon-w4').textContent = '✅';
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
  if (!canOpenOnbTask_(task)) return;
  const body = document.getElementById('onb-body-' + task);
  const chev = document.getElementById('onb-chev-' + task);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(90deg)';
}

function canOpenOnbTask_(task) {
  if (task === 'info') return true;
  if (task === 'i9') return !!_onbStatus.sensitive_info_done;
  if (task === 'w4') return !!_onbStatus.i9_done;
  if (task === 'contract') return !!_onbStatus.info_done;
  return true;
}

function openOnbTask_(task) {
  if (!canOpenOnbTask_(task)) return;
  const body = document.getElementById('onb-body-' + task);
  const chev = document.getElementById('onb-chev-' + task);
  if (body) body.style.display = 'block';
  if (chev) chev.style.transform = 'rotate(90deg)';
}

function closeOnbTask_(task) {
  const body = document.getElementById('onb-body-' + task);
  const chev = document.getElementById('onb-chev-' + task);
  if (body) body.style.display = 'none';
  if (chev) chev.style.transform = '';
}

function submitPersonalInfo() {
  const msgEl = document.getElementById('onb-info-msg');
  const fields = {
    legal_name: document.getElementById('onb-legal-name').value.trim(),
    preferred_name: document.getElementById('onb-preferred-name').value.trim(),
    dob: document.getElementById('onb-dob').value,
    phone: document.getElementById('onb-phone').value.trim(),
    email: document.getElementById('onb-email').value.trim(),
    address_line1: document.getElementById('onb-addr1').value.trim(),
    address_line2: document.getElementById('onb-addr2').value.trim(),
    address_city: document.getElementById('onb-city').value.trim(),
    address_state: document.getElementById('onb-state').value.trim(),
    address_zip: document.getElementById('onb-zip').value.trim(),
    drivers_license_number: document.getElementById('onb-dl-number').value.trim(),
    drivers_license_expiration: document.getElementById('onb-dl-exp').value,
    emergency_name: document.getElementById('onb-ec-name').value.trim(),
    emergency_relationship: document.getElementById('onb-ec-relationship').value.trim(),
    emergency_phone: document.getElementById('onb-ec-phone').value.trim(),
    allergies: document.getElementById('onb-allergies').value.trim(),
    medical_conditions: document.getElementById('onb-medical').value.trim(),
    shirt_size: document.getElementById('onb-shirt-size').value,
  };

  if (!fields.legal_name) { showMsg(msgEl, 'Legal name is required.', false); return; }
  if (!fields.preferred_name) { showMsg(msgEl, 'Preferred name is required.', false); return; }
  if (!fields.dob) { showMsg(msgEl, 'Date of birth is required.', false); return; }
  if (!fields.phone) { showMsg(msgEl, 'Phone number is required.', false); return; }
  if (!fields.email) { showMsg(msgEl, 'Email is required.', false); return; }
  if (!fields.address_line1 || !fields.address_city || !fields.address_state || !fields.address_zip) {
    showMsg(msgEl, 'Complete address is required.', false); return;
  }
  if (!fields.drivers_license_number) { showMsg(msgEl, 'Driver license number is required.', false); return; }
  if (!fields.drivers_license_expiration) { showMsg(msgEl, 'Driver license expiration is required.', false); return; }
  if (!fields.emergency_name || !fields.emergency_relationship || !fields.emergency_phone) { showMsg(msgEl, 'Complete emergency contact is required.', false); return; }
  if (!fields.allergies) { showMsg(msgEl, 'Allergies are required. Type None if none.', false); return; }
  if (!fields.shirt_size) { showMsg(msgEl, 'Shirt size is required.', false); return; }

  const file = document.getElementById('onb-dl-photo').files[0];
  if (!file) { showMsg(msgEl, 'Driver license photo is required.', false); return; }

  showMsg(msgEl, 'Saving...', true);
  fileToDataUrl_(file).then(dataUrl => {
    api(Object.assign({ action: 'save_sensitive_info', token: _s.token, secret: SEC, drivers_license_photo: dataUrl, drivers_license_photo_name: file.name || 'drivers_license.jpg' }, fields))
      .then(res => {
        if (res.ok) {
          showMsg(msgEl, 'Saved!', true);
          document.getElementById('onb-icon-info').textContent = '✅';
          updateOnbProgress({ sensitive_info_done: true, i9_done: !!res.i9_done, info_done: !!res.info_done, contract_done: !!res.contract_done });
          closeOnbTask_('info');
          openOnbTask_('i9');
        } else {
          showMsg(msgEl, res.error || 'Failed to save.', false);
        }
      })
      .catch(() => showMsg(msgEl, 'Network error.', false));
  }).catch(() => showMsg(msgEl, 'Could not read driver license photo.', false));
}

function fileToDataUrl_(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function onbI9StatusChanged() {
  const status = (document.querySelector('input[name="onb-i9-status"]:checked') || {}).value;
  const lpr = document.getElementById('onb-i9-lpr-fields');
  const alien = document.getElementById('onb-i9-alien-fields');
  if (lpr) lpr.style.display = (status === 'lawful_permanent_resident' || status === 'alien_authorized') ? 'block' : 'none';
  if (alien) alien.style.display = status === 'alien_authorized' ? 'block' : 'none';
}

function collectI9Fields_() {
  const fullName = document.getElementById('onb-legal-name').value.trim();
  const parts = splitLegalName_(fullName);
  return {
    full_name: fullName,
    first_name: parts.first,
    middle_initial: parts.middleInitial,
    last_name: parts.last,
    other_last_names: document.getElementById('onb-i9-other-last').value.trim(),
    dob: document.getElementById('onb-dob').value,
    ssn_full: document.getElementById('onb-i9-ssn').value.replace(/\D/g, ''),
    email: document.getElementById('onb-email').value.trim(),
    phone: document.getElementById('onb-phone').value.trim(),
    address_line1: document.getElementById('onb-addr1').value.trim(),
    address_line2: document.getElementById('onb-addr2').value.trim(),
    address_city: document.getElementById('onb-city').value.trim(),
    address_state: document.getElementById('onb-state').value.trim().toUpperCase(),
    address_zip: document.getElementById('onb-zip').value.trim(),
    citizenship_status: (document.querySelector('input[name="onb-i9-status"]:checked') || {}).value || '',
    uscis_number: document.getElementById('onb-i9-uscis').value.trim(),
    work_authorization_expiration: document.getElementById('onb-i9-work-exp').value,
    i94_number: document.getElementById('onb-i9-i94').value.trim(),
    foreign_passport: document.getElementById('onb-i9-passport').value.trim(),
    foreign_passport_country: document.getElementById('onb-i9-passport-country').value.trim(),
    preparer_used: document.getElementById('onb-i9-preparer').checked,
    signature_name: document.getElementById('onb-i9-signature').value.trim(),
    signature_date: onbTodayMmddyyyy_()
  };
}

function validateI9Fields_(fields, msgEl) {
  if (!_onbStatus.sensitive_info_done) { showMsg(msgEl, 'Complete Personal Information first.', false); return false; }
  if (!fields.full_name || !fields.last_name || !fields.first_name) { showMsg(msgEl, 'Legal name is required from Personal Information.', false); return false; }
  if (!fields.address_line1 || !fields.address_city || !fields.address_state || !fields.address_zip) { showMsg(msgEl, 'Complete address is required from Personal Information.', false); return false; }
  if (!fields.dob) { showMsg(msgEl, 'Date of birth is required from Personal Information.', false); return false; }
  if (fields.ssn_full.length < 9) { showMsg(msgEl, 'Enter full SSN for this I-9.', false); return false; }
  if (!fields.citizenship_status) { showMsg(msgEl, 'Select citizenship or immigration status.', false); return false; }
  if (fields.citizenship_status === 'lawful_permanent_resident' && !fields.uscis_number) { showMsg(msgEl, 'Enter USCIS or A-Number.', false); return false; }
  if (fields.citizenship_status === 'alien_authorized' && !fields.uscis_number && !fields.i94_number && !(fields.foreign_passport && fields.foreign_passport_country)) {
    showMsg(msgEl, 'Enter USCIS/A-Number, I-94 number, or foreign passport details.', false); return false;
  }
  if (fields.preparer_used) { showMsg(msgEl, 'Preparer/translator support will be added next. For now, complete this yourself or contact admin.', false); return false; }
  if (!document.getElementById('onb-i9-agree').checked) { showMsg(msgEl, 'Check the I-9 attestation box.', false); return false; }
  if (!fields.signature_name || fields.signature_name.toLowerCase() !== fields.full_name.toLowerCase()) { showMsg(msgEl, 'Type your full legal name exactly to sign.', false); return false; }
  return true;
}

function splitLegalName_(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts.pop() : '';
  const first = parts.shift() || '';
  const middleInitial = parts.length ? parts.join(' ').charAt(0).toUpperCase() : '';
  return { first, middleInitial, last: last || first };
}

function onbDateInputToMmddyyyy_(value) {
  if (!value) return '';
  const parts = String(value).split('-');
  if (parts.length === 3) return parts[1] + '/' + parts[2] + '/' + parts[0];
  return value;
}

function onbTodayMmddyyyy_() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return mm + '/' + dd + '/' + d.getFullYear();
}

function setPdfText_(form, name, value) {
  if (value === undefined || value === null) return;
  try {
    const field = form.getField(name);
    if (field.setText) field.setText(String(value));
    else if (field.select) field.select(String(value));
  } catch(e) {}
}

function checkPdfBox_(form, name) {
  try { form.getCheckBox(name).check(); } catch(e) {
    try { form.getField(name).check(); } catch(_e) {}
  }
}

let _pendingI9PdfBytes = null;

async function generateAndReviewI9() {
  const btn = document.getElementById('btn-gen-i9');
  const msgEl = document.getElementById('onb-i9-msg');
  const fields = collectI9Fields_();
  if (!validateI9Fields_(fields, msgEl)) return;

  btn.textContent = 'Generating...';
  btn.disabled = true;
  try {
    const rawForm = await fetch('/i-9.pdf').then(res => res.arrayBuffer());
    const pdfDoc = await PDFLib.PDFDocument.load(rawForm);
    const form = pdfDoc.getForm();

    setPdfText_(form, 'Last Name (Family Name)', fields.last_name);
    setPdfText_(form, 'First Name Given Name', fields.first_name);
    setPdfText_(form, 'Employee Middle Initial (if any)', fields.middle_initial);
    setPdfText_(form, 'Employee Other Last Names Used (if any)', fields.other_last_names || 'N/A');
    setPdfText_(form, 'Address Street Number and Name', fields.address_line1);
    setPdfText_(form, 'Apt Number (if any)', fields.address_line2);
    setPdfText_(form, 'City or Town', fields.address_city);
    setPdfText_(form, 'State', fields.address_state);
    setPdfText_(form, 'ZIP Code', fields.address_zip);
    setPdfText_(form, 'Date of Birth mmddyyyy', onbDateInputToMmddyyyy_(fields.dob));
    setPdfText_(form, 'US Social Security Number', fields.ssn_full.substring(0,3) + '-' + fields.ssn_full.substring(3,5) + '-' + fields.ssn_full.substring(5,9));
    setPdfText_(form, 'Employees E-mail Address', fields.email);
    setPdfText_(form, 'Telephone Number', fields.phone);

    if (fields.citizenship_status === 'citizen') checkPdfBox_(form, 'CB_1');
    if (fields.citizenship_status === 'noncitizen_national') checkPdfBox_(form, 'CB_2');
    if (fields.citizenship_status === 'lawful_permanent_resident') {
      checkPdfBox_(form, 'CB_3');
      setPdfText_(form, '3 A lawful permanent resident Enter USCIS or ANumber', fields.uscis_number);
    }
    if (fields.citizenship_status === 'alien_authorized') {
      checkPdfBox_(form, 'CB_4');
      setPdfText_(form, 'Exp Date mmddyyyy', onbDateInputToMmddyyyy_(fields.work_authorization_expiration));
      setPdfText_(form, 'USCIS ANumber', fields.uscis_number);
      setPdfText_(form, 'Form I94 Admission Number', fields.i94_number);
      setPdfText_(form, 'Foreign Passport Number and Country of IssuanceRow1', [fields.foreign_passport, fields.foreign_passport_country].filter(Boolean).join(' / '));
    }

    const pages = pdfDoc.getPages();
    const page = pages[0];
    const signatureText = fields.signature_name + ' (e-signed)';
    const dateText = fields.signature_date;
    page.drawText(signatureText, { x: 42, y: 430, size: 10 });
    page.drawText(dateText, { x: 372, y: 430, size: 10 });

    setPdfText_(form, 'Signature of Employee', signatureText);
    setPdfText_(form, "Today's Date mmddyyy", dateText);

    const helveticaFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    form.updateFieldAppearances(helveticaFont);
    const pdfBytes = await pdfDoc.save();
    _pendingI9PdfBytes = pdfBytes;

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    document.getElementById('i9-preview-frame').src = url;
    document.getElementById('i9-modal-backdrop').style.display = 'flex';
  } catch (err) {
    console.error(err);
    showMsg(msgEl, 'Failed to generate I-9: ' + err.message, false);
  } finally {
    btn.textContent = 'Review & Sign I-9 Form';
    btn.disabled = false;
  }
}

function closeI9Modal() {
  document.getElementById('i9-modal-backdrop').style.display = 'none';
  document.getElementById('i9-preview-frame').src = '';
  _pendingI9PdfBytes = null;
}

function confirmI9() {
  if (!_pendingI9PdfBytes) return;
  let binary = '';
  for (let i = 0; i < _pendingI9PdfBytes.byteLength; i++) {
    binary += String.fromCharCode(_pendingI9PdfBytes[i]);
  }
  document.getElementById('onb-i9-base64').value = btoa(binary);
  document.getElementById('i9-status-msg').style.display = 'block';
  closeI9Modal();
}

function submitI9Info() {
  const msgEl = document.getElementById('onb-i9-msg');
  const fields = collectI9Fields_();
  if (!validateI9Fields_(fields, msgEl)) return;
  const i9b64 = document.getElementById('onb-i9-base64').value;
  if (!i9b64) { showMsg(msgEl, 'Please review and sign your I-9 Form before submitting.', false); return; }

  showMsg(msgEl, 'Saving...', true);
  api(Object.assign({ action: 'save_i9_info', token: _s.token, secret: SEC, i9_base64: i9b64 }, fields)).then(res => {
    if (res.ok) {
      showMsg(msgEl, 'Saved!', true);
      document.getElementById('onb-icon-i9').textContent = '✅';
      updateOnbProgress({ sensitive_info_done: !!res.sensitive_info_done, i9_done: true, info_done: !!res.info_done, contract_done: !!res.contract_done });
      closeOnbTask_('i9');
      openOnbTask_('w4');
    } else {
      showMsg(msgEl, res.error || 'Failed to save.', false);
    }
  }).catch(() => showMsg(msgEl, 'Network error.', false));
}

function submitW4Info() {
  const msgEl = document.getElementById('onb-w4-msg');
  const fields = {
    legal_name: document.getElementById('onb-legal-name').value.trim(),
    phone: document.getElementById('onb-phone').value.trim(),
    address_line1: document.getElementById('onb-addr1').value.trim(),
    address_city: document.getElementById('onb-city').value.trim(),
    address_state: document.getElementById('onb-state').value.trim(),
    address_zip: document.getElementById('onb-zip').value.trim(),
    tax_type: 'SSN',
    tax_id_full: document.getElementById('onb-w4-ssn').value.replace(/\D/g, ''),
    w4_filing_status: (document.querySelector('input[name="onb-w4-status"]:checked') || {}).value,
    w4_multiple_jobs: document.getElementById('onb-w4-step2').checked,
    w4_dependents_1: document.getElementById('onb-w4-dep1').value || '0',
    w4_dependents_2: document.getElementById('onb-w4-dep2').value || '0',
    w4_other_income: document.getElementById('onb-w4-4a').value || '0',
    w4_deductions: document.getElementById('onb-w4-4b').value || '0',
    w4_extra_withholding: document.getElementById('onb-w4-4c').value || '0',
  };
  if (!fields.legal_name || !fields.address_line1 || !fields.address_city || !fields.address_state || !fields.address_zip) {
    showMsg(msgEl, 'Complete Personal Information first.', false); return;
  }
  if (!_onbStatus.i9_done) { showMsg(msgEl, 'Complete I-9 first.', false); return; }
  if (fields.tax_id_full.length < 9) { showMsg(msgEl, 'Enter full SSN.', false); return; }

  const w4b64 = document.getElementById('onb-w4-base64').value;
  if (w4b64) {
    const body = Object.assign({ action: 'save_info', token: _s.token, secret: SEC, w4_base64: w4b64 }, fields);
    api(body).then(res => {
      if (res.ok) {
        showMsg(msgEl, 'Saved!', true);
        document.getElementById('onb-icon-w4').textContent = '✅';
        updateOnbProgress({ sensitive_info_done: !!res.sensitive_info_done, i9_done: !!res.i9_done, info_done: true, contract_done: !!res.contract_done });
        closeOnbTask_('w4');
        openOnbTask_('contract');
      } else {
        showMsg(msgEl, res.error || 'Failed to save.', false);
      }
    }).catch(() => showMsg(msgEl, 'Network error.', false));
    } else {
    showMsg(msgEl, 'Please generate and review your W-4 Form before saving.', false);
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
  if (!_onbStatus.info_done) { showMsg(msgEl, 'Complete W-4 first.', false); return; }

  api({ action: 'onboarding_save_contract', signed_name: signedName, signed_at: new Date().toISOString(), token: _s.token, secret: SEC })
  .then(res => {
    if (res.ok) {
      showMsg(msgEl, 'Signature saved!', true);
      document.getElementById('onb-icon-contract').textContent = '✅';
      updateOnbProgress({ sensitive_info_done: !!res.sensitive_info_done, i9_done: !!res.i9_done, info_done: !!res.info_done, contract_done: true });
    } else {
      showMsg(msgEl, res.error || 'Failed to save signature.', false);
    }
  }).catch(() => showMsg(msgEl, 'Network error.', false));
}

function updateOnbProgress(status) {
  _onbStatus = Object.assign({}, _onbStatus, status || {});
  const done = (_onbStatus.sensitive_info_done ? 1 : 0) + (_onbStatus.i9_done ? 1 : 0) + (_onbStatus.info_done ? 1 : 0) + (_onbStatus.contract_done ? 1 : 0);
  const pct  = (done / 4) * 100;
  const fill = document.getElementById('onb-fill');
  const label = document.getElementById('onb-progress-label');
  if (fill) fill.style.width = pct + '%';
  if (label) label.textContent = done + ' of 4 steps complete';

  if (_onbStatus.sensitive_info_done) document.getElementById('onb-icon-info').textContent = '✅';
  if (_onbStatus.i9_done) document.getElementById('onb-icon-i9').textContent = '✅';
  if (_onbStatus.info_done) document.getElementById('onb-icon-w4').textContent = '✅';
  if (_onbStatus.contract_done) document.getElementById('onb-icon-contract').textContent = '✅';

  refreshOnbLocks_();

  if (_onbStatus.sensitive_info_done && _onbStatus.i9_done && _onbStatus.info_done && _onbStatus.contract_done) {
    const pending = document.getElementById('onb-pending-state');
    if (pending) pending.style.display = 'block';
  }
}

function refreshOnbLocks_() {
  ['i9', 'w4', 'contract'].forEach(task => {
    const card = document.getElementById('onb-task-' + task);
    if (!card) return;
    const locked = !canOpenOnbTask_(task);
    card.classList.toggle('is-locked', locked);
    if (locked) closeOnbTask_(task);
  });
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
          <span class="pend-ai-pill ${a.i9_done ? 'conf-high' : 'conf-low'}">${a.i9_done ? '✓ I-9' : '✗ I-9'}</span>
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
        <span class="pend-ai-pill ${a.i9_done?'conf-high':'conf-low'}">${a.i9_done?'✓ I-9':'✗ I-9'}</span>
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
        <div class="docs-section-title">I-9</div>
        ${d.i9_signed_url
          ? `<a href="${d.i9_signed_url}" target="_blank" class="docs-w9-btn">⬇ Open I-9 PDF</a><div style="font-size:.72rem;color:var(--muted);margin-top:.3rem">Stored in sensitive employee docs</div>`
          : '<span style="color:var(--muted);font-size:.85rem">No I-9 uploaded</span>'}
      </div>
      <div style="margin-top:1.25rem">
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


// ── Active Clients Helpers ────────────────────────────────────────────────────
