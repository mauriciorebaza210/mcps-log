// StartupChecklists.js
// Handles saving and retrieving startup checklists

function getStartupChecklistsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Startup_Checklists');
  var headers = [
    'checklist_id', 'pool_id', 'customer_name', 'address', 'checklist_type',
    'start_date', 'access_code', 'animals', 'wifi_name', 'wifi_password',
    'equipment_type', 'plaster_type', 'items_data', 'qc_notes', 'punchlist_notes',
    'technician_name', 'signature_url', 'pdf_url', 'submitted_at', 'submitted_by',
    'phone', 'customer_notes', 'customer_signature_url',
    'startup_company', 'startup_company_email_sent_to', 'startup_company_email_sent_at'
  ];
  if (!sheet) {
    sheet = ss.insertSheet('Startup_Checklists');
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
      .map(function(h) { return String(h || '').trim().toLowerCase(); });
    headers.forEach(function(h) {
      if (existing.indexOf(String(h).toLowerCase()) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
        existing.push(String(h).toLowerCase());
      }
    });
  }
  return sheet;
}

function getOrCreateChecklistsFolder_() {
  var folderName = 'MCPS Startup Checklists';
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}

function handleSaveStartupChecklist_(payload) {
  try {
    var auth = validateToken(payload.token);
    if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
    if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager') && !hasRole(auth, 'technician')) {
      return jsonResponse_({ ok: false, error: 'Access denied.' });
    }

    var checklistId = 'CL-' + Utilities.getUuid().split('-')[0].toUpperCase();
    var folder = getOrCreateChecklistsFolder_();

    // Upload signature image to Drive
    var signatureUrl = '';
    var signatureBlob = null;
    if (payload.signature_data && payload.signature_data.length > 100) {
      try {
        var base64Data = payload.signature_data.replace(/^data:image\/\w+;base64,/, '');
        signatureBlob = Utilities.newBlob(
          Utilities.base64Decode(base64Data),
          'image/png',
          checklistId + '_signature.png'
        );
        var sigFile = folder.createFile(signatureBlob.copyBlob());
        sigFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        signatureUrl = sigFile.getUrl();
      } catch (sigErr) {
        Logger.log('Signature upload failed: ' + sigErr);
        signatureBlob = null;
      }
    }

    // Upload customer signature if provided (pool school)
    var customerSignatureUrl = '';
    var customerSignatureBlob = null;
    if (payload.customer_signature_data && payload.customer_signature_data.length > 100) {
      try {
        var custBase64 = payload.customer_signature_data.replace(/^data:image\/\w+;base64,/, '');
        customerSignatureBlob = Utilities.newBlob(
          Utilities.base64Decode(custBase64),
          'image/png',
          checklistId + '_customer_signature.png'
        );
        var custSigFile = folder.createFile(customerSignatureBlob.copyBlob());
        custSigFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        customerSignatureUrl = custSigFile.getUrl();
      } catch (cSigErr) {
        Logger.log('Customer signature upload failed: ' + cSigErr);
        customerSignatureBlob = null;
      }
    }

    if (!signatureBlob) {
      return jsonResponse_({ ok: false, error: 'Technician signature is required.' });
    }
    if (payload.checklist_type === 'pool_school' && !customerSignatureBlob) {
      return jsonResponse_({ ok: false, error: 'Customer signature is required for Pool School checklists.' });
    }

    // Generate PDF
    var pdfInfo = { url: '', file_id: '', name: '' };
    var pdfUrl = '';
    var pdfError = '';
    try {
      pdfInfo = generateChecklistPdf_(payload, checklistId, signatureUrl, customerSignatureUrl, folder, signatureBlob, customerSignatureBlob);
      pdfUrl = pdfInfo && pdfInfo.url ? pdfInfo.url : '';
    } catch (pdfErr) {
      pdfError = String(pdfErr);
      Logger.log('PDF generation failed: ' + pdfErr);
    }

    var userObj = auth.user || {};
    var submittedBy = userObj.username || auth.username || '';
    var companyEmailResult = { to: '', sent_at: '', startup_company: '' };

    try {
      companyEmailResult = sendStartupChecklistToCompany_(payload, checklistId, pdfInfo, submittedBy) || companyEmailResult;
    } catch (emailErr) {
      Logger.log('Startup checklist company email failed: ' + emailErr);
    }

    var sheet = getStartupChecklistsSheet_();
    sheet.appendRow([
      checklistId,
      payload.pool_id || '',
      payload.customer_name || '',
      payload.address || '',
      payload.checklist_type || 'technician',
      payload.start_date || '',
      payload.access_code || '',
      payload.animals || '',
      payload.wifi_name || '',
      payload.wifi_password || '',
      payload.equipment_type || '',
      payload.plaster_type || '',
      JSON.stringify(payload.items_data || {}),
      payload.qc_notes || '',
      payload.punchlist_notes || '',
      payload.technician_name || '',
      signatureUrl,
      pdfUrl,
      new Date().toISOString(),
      submittedBy,
      payload.phone || '',
      payload.customer_notes || '',
      customerSignatureUrl,
      companyEmailResult.startup_company || '',
      companyEmailResult.to || '',
      companyEmailResult.sent_at || ''
    ]);

    return jsonResponse_({
      ok: true,
      checklist_id: checklistId,
      pdf_url: pdfUrl,
      pdf_error: pdfError,
      startup_company_email_sent_to: companyEmailResult.to || ''
    });
  } catch (err) {
    Logger.log('handleSaveStartupChecklist_ error: ' + err);
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function handleGetStartupChecklists_(params) {
  try {
    var auth = validateToken(params.token || '');
    if (!auth.ok) return jsonResponse_({ ok: false, error: auth.error });
    if (!hasRole(auth, 'admin') && !hasRole(auth, 'manager')) {
      return jsonResponse_({ ok: false, error: 'Admin access required.' });
    }

    var sheet = getStartupChecklistsSheet_();
    if (sheet.getLastRow() < 2) return jsonResponse_({ ok: true, checklists: [] });

    var data = sheet.getDataRange().getValues();
    var h = data[0].map(function(v) { return String(v || '').trim().toLowerCase(); });
    var iId    = h.indexOf('checklist_id');
    var iPid   = h.indexOf('pool_id');
    var iCust  = h.indexOf('customer_name');
    var iAddr  = h.indexOf('address');
    var iType  = h.indexOf('checklist_type');
    var iDate  = h.indexOf('start_date');
    var iTech  = h.indexOf('technician_name');
    var iPdf   = h.indexOf('pdf_url');
    var iSubAt = h.indexOf('submitted_at');
    var iSubBy = h.indexOf('submitted_by');

    var poolFilter = (params.pool_id || '').trim().toUpperCase();
    var checklists = [];

    for (var i = 1; i < data.length; i++) {
      if (!data[i][iId]) continue;
      var rowPid = String(data[i][iPid] || '').trim().toUpperCase();
      if (poolFilter && rowPid !== poolFilter) continue;
      checklists.push({
        checklist_id:   data[i][iId],
        pool_id:        data[i][iPid],
        customer_name:  data[i][iCust],
        address:        data[i][iAddr],
        checklist_type: data[i][iType],
        start_date:     data[i][iDate] ? String(data[i][iDate]).split('T')[0] : '',
        technician_name:data[i][iTech],
        pdf_url:        data[i][iPdf],
        submitted_at:   data[i][iSubAt],
        submitted_by:   data[i][iSubBy]
      });
    }

    checklists.sort(function(a, b) {
      return a.submitted_at > b.submitted_at ? -1 : 1;
    });

    return jsonResponse_({ ok: true, checklists: checklists });
  } catch (err) {
    Logger.log('handleGetStartupChecklists_ error: ' + err);
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function sendStartupChecklistToCompany_(payload, checklistId, pdfInfo, submittedBy) {
  var company = lookupStartupChecklistCompany_(payload);
  var checklistType = payload.checklist_type === 'pool_school' ? 'Pool School Checklist' : 'Technician Startup Checklist';
  var customerName = payload.customer_name || 'Client';
  var subject = checklistType + ' Completed — ' + customerName;
  var sentAt = new Date().toISOString();

  // TO: client + startup company (both if present)
  var toRecipients = [];
  if (company && company.clientEmail) toRecipients.push(company.clientEmail);
  if (company && company.email)       toRecipients.push(company.email);
  if (!toRecipients.length)           toRecipients.push('mauricio@mcpoolsolutions.org'); // fallback so email always fires
  var toEmail = toRecipients.join(',');

  // BCC: always Mauricio, add Rosy if sponsored by MCP
  var bcc = 'mauricio@mcpoolsolutions.org';
  if (company && company.sponsoredByMcp) bcc += ',rosy@missioncustompools.com';
  var data = {
    checklistId: checklistId,
    checklistType: checklistType,
    customerName: customerName,
    poolId: payload.pool_id || '',
    address: payload.address || '',
    phone: payload.phone || '',
    startDate: payload.start_date || '',
    technicianName: payload.technician_name || '',
    submittedBy: submittedBy || '',
    submittedAt: sentAt,
    companyName: company && company.name ? company.name : '',
    pdfUrl: pdfInfo && pdfInfo.url ? pdfInfo.url : '',
    hasCustomerSignature: payload.checklist_type === 'pool_school',
    qcNotes: payload.qc_notes || '',
    punchlistNotes: payload.punchlist_notes || '',
    customerNotes: payload.customer_notes || ''
  };

  var zapierPayload = {
    to:        toEmail,
    bcc:       bcc,
    from:      VISIT_REPORT_FROM,
    from_name: VISIT_REPORT_FROM_NAME,
    subject:   subject,
    html_body: buildStartupChecklistEmailHtml_(data),
    text_body: buildStartupChecklistEmailText_(data)
  };

  try {
    UrlFetchApp.fetch(visitReportZapierWebhook_(), {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(zapierPayload),
      muteHttpExceptions: true
    });
  } catch (fetchErr) {
    Logger.log('Startup checklist Zapier webhook failed: ' + fetchErr);
  }

  return { to: toEmail, sent_at: sentAt, startup_company: company && company.name ? company.name : '' };
}

function lookupStartupChecklistCompany_(payload) {
  var quoteId = String(payload.quote_id || '').trim();
  var poolId = String(payload.pool_id || '').trim().toUpperCase();
  if (!quoteId && !poolId) return null;

  try {
    var crmSs = SpreadsheetApp.openById('1fw2qMdWnNbYlb3F6wM3A69CMDIymYVd2uhOF_iPoB6E');
    var sheet = crmSs.getSheetByName('Quotes');
    if (!sheet || sheet.getLastRow() < 2) return null;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    var quoteCol       = headers.indexOf('quote_id');
    var poolCol        = headers.indexOf('pool_id');
    var companyCol     = headers.indexOf('startup_company');
    var companyEmailCol= headers.indexOf('startup_company_email');
    var clientEmailCol = headers.indexOf('email');
    var mcpCol         = headers.indexOf('sponsored_by_mcp');
    if (quoteCol === -1 && poolCol === -1) return null;

    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < rows.length; i++) {
      var rowQuoteId = quoteCol !== -1 ? String(rows[i][quoteCol] || '').trim() : '';
      var rowPoolId  = poolCol  !== -1 ? String(rows[i][poolCol]  || '').trim().toUpperCase() : '';
      var matched = quoteId ? rowQuoteId === quoteId : rowPoolId === poolId;
      if (!matched) continue;

      var companyName  = companyCol      !== -1 ? String(rows[i][companyCol]      || '').trim() : '';
      var companyEmail = companyEmailCol !== -1 ? String(rows[i][companyEmailCol] || '').trim() : '';
      var clientEmail  = clientEmailCol  !== -1 ? String(rows[i][clientEmailCol]  || '').trim() : '';
      var sponsoredByMcp = mcpCol !== -1 ? isTruthyChecklistCell_(rows[i][mcpCol]) : false;
      return {
        name:           companyName,
        email:          companyEmail || lookupChecklistPoolCompanyEmail_(crmSs, companyName),
        clientEmail:    clientEmail,
        sponsoredByMcp: sponsoredByMcp
      };
    }
  } catch (err) {
    Logger.log('lookupStartupChecklistCompany_ error: ' + err);
  }
  return null;
}

function lookupChecklistPoolCompanyEmail_(crmSs, companyName) {
  var target = String(companyName || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!target) return '';

  try {
    var sheet = crmSs.getSheetByName('Pool_Companies');
    if (!sheet || sheet.getLastRow() < 2) return '';
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h) { return String(h || '').trim().toLowerCase().replace(/ /g, '_'); });
    var nameCol = headers.indexOf('company_name');
    var emailCol = headers.indexOf('report_bcc_email');
    var activeCol = headers.indexOf('active');
    if (nameCol === -1 || emailCol === -1) return '';

    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < rows.length; i++) {
      var name = String(rows[i][nameCol] || '').trim().replace(/\s+/g, ' ').toLowerCase();
      var active = activeCol === -1 ? 'TRUE' : String(rows[i][activeCol] || 'TRUE').trim().toUpperCase();
      if (name === target && active !== 'FALSE') return String(rows[i][emailCol] || '').trim();
    }
  } catch (err) {
    Logger.log('lookupChecklistPoolCompanyEmail_ error: ' + err);
  }
  return '';
}

function isTruthyChecklistCell_(value) {
  if (value === true) return true;
  var s = String(value || '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

function checklistEsc_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildStartupChecklistEmailHtml_(d) {
  var typeNote = d.hasCustomerSignature
    ? 'This Pool School checklist includes the customer and technician signatures.'
    : 'This technician checklist includes the technician signature.';
  var rows = [
    ['Client', d.customerName],
    ['Pool ID', d.poolId],
    ['Address', d.address],
    ['Phone', d.phone],
    ['Start Date', d.startDate],
    ['Technician', d.technicianName],
    ['Checklist ID', d.checklistId]
  ].filter(function(r) { return r[1]; }).map(function(r) {
    return '<tr><td style="padding:8px 12px;color:#64748b;border-bottom:1px solid #e5e7eb">' + checklistEsc_(r[0]) + '</td>' +
      '<td style="padding:8px 12px;color:#111827;font-weight:600;border-bottom:1px solid #e5e7eb">' + checklistEsc_(r[1]) + '</td></tr>';
  }).join('');

  var notes = '';
  if (d.qcNotes || d.punchlistNotes || d.customerNotes) {
    notes = [
      '<div style="margin-top:18px;padding:14px 16px;background:#f8fafc;border-left:4px solid #0f766e;border-radius:0 8px 8px 0">',
      '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:#0f766e;margin-bottom:8px">Notes</div>',
      d.qcNotes ? '<p style="margin:0 0 8px;color:#334155"><strong>QC:</strong> ' + checklistEsc_(d.qcNotes) + '</p>' : '',
      d.punchlistNotes ? '<p style="margin:0 0 8px;color:#334155"><strong>Punchlist:</strong> ' + checklistEsc_(d.punchlistNotes) + '</p>' : '',
      d.customerNotes ? '<p style="margin:0;color:#334155"><strong>Customer:</strong> ' + checklistEsc_(d.customerNotes) + '</p>' : '',
      '</div>'
    ].join('');
  }

  return [
    '<div style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;color:#111827">',
    '<div style="max-width:640px;margin:0 auto;padding:28px 16px">',
    '<div style="background:#064e3b;color:#fff;border-radius:12px 12px 0 0;padding:24px 28px">',
    '<div style="font-size:20px;font-weight:700">Mission Custom Pool Solutions</div>',
    '<div style="font-size:13px;color:#ccfbf1;margin-top:4px">Signed Startup Checklist</div>',
    '</div>',
    '<div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:26px 28px">',
    '<p style="margin:0 0 14px;font-size:15px">Hello' + (d.companyName ? ' ' + checklistEsc_(d.companyName) : '') + ',</p>',
    '<p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#334155">The <strong>' + checklistEsc_(d.checklistType) + '</strong> has been completed for <strong>' + checklistEsc_(d.customerName) + '</strong>. ' + checklistEsc_(typeNote) + ' The signed PDF is attached for your records.</p>',
    '<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:13px"><tbody>',
    rows,
    '</tbody></table>',
    notes,
    d.pdfUrl ? '<p style="margin:18px 0 0"><a href="' + checklistEsc_(d.pdfUrl) + '" style="display:inline-block;padding:10px 20px;background:#064e3b;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">📄 Download Signed PDF</a></p>' : '',
    '<p style="margin:22px 0 0;font-size:13px;color:#64748b">Thank you,<br><strong>Mission Custom Pool Solutions</strong></p>',
    '</div></div></div>'
  ].join('');
}

function buildStartupChecklistEmailText_(d) {
  return [
    'Mission Custom Pool Solutions',
    'Signed Startup Checklist',
    '',
    'The ' + d.checklistType + ' has been completed for ' + d.customerName + '.',
    'The signed PDF is attached for your records.',
    '',
    'Client: ' + d.customerName,
    'Pool ID: ' + d.poolId,
    'Address: ' + d.address,
    'Phone: ' + d.phone,
    'Start Date: ' + d.startDate,
    'Technician: ' + d.technicianName,
    'Checklist ID: ' + d.checklistId,
    d.pdfUrl ? 'Signed PDF: ' + d.pdfUrl : ''
  ].filter(Boolean).join('\n');
}

function appendSignatureImage_(body, label, blob, url) {
  var labelParagraph = body.appendParagraph(label);
  labelParagraph.editAsText().setFontSize(10).setBold(true);

  if (!blob) {
    body.appendParagraph('Signature: (not captured)').editAsText().setFontSize(9);
    return;
  }

  try {
    var image = body.appendImage(blob.copyBlob());
    var maxWidth = 260;
    var width = image.getWidth();
    var height = image.getHeight();
    if (width > maxWidth) {
      image.setWidth(maxWidth);
      image.setHeight(Math.round(height * (maxWidth / width)));
    }
    if (url) {
      body.appendParagraph('Signature file: ' + url).editAsText().setFontSize(8);
    }
  } catch (imgErr) {
    Logger.log('Signature image insert failed: ' + imgErr);
    body.appendParagraph(url ? 'Signature on file: ' + url : 'Signature: (captured, image unavailable)')
      .editAsText().setFontSize(9);
  }
}

function generateChecklistPdf_(payload, checklistId, signatureUrl, customerSignatureUrl, folder, signatureBlob, customerSignatureBlob) {
  var typeLabel = payload.checklist_type === 'pool_school' ? 'Pool School Checklist' : 'Start Up Check List';
  var customerName = payload.customer_name || payload.pool_id || checklistId;
  var docName = 'MCPS ' + typeLabel + ' — ' + customerName;

  var doc = DocumentApp.create(docName);
  var body = doc.getBody();

  // ── Header ──
  var title = body.appendParagraph('MISSION CUSTOM POOL SOLUTIONS');
  title.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  title.editAsText().setFontSize(18).setBold(true);

  var sub = body.appendParagraph(typeLabel);
  sub.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  sub.editAsText().setFontSize(12).setBold(false);
  body.appendParagraph('');

  // ── Customer info ──
  var infoLines = [
    'Customer Name: ' + (payload.customer_name || '') + '    Start Date: ' + (payload.start_date || ''),
    'Address: ' + (payload.address || ''),
    'Access Code: ' + (payload.access_code || '') + '    Animals: ' + (payload.animals || ''),
    'Wi-Fi Name: ' + (payload.wifi_name || '') + '    Wi-Fi Password: ' + (payload.wifi_password || ''),
    'Equipment: ' + (payload.equipment_type || '') + '    Plaster Type: ' + (payload.plaster_type || '')
  ];
  infoLines.forEach(function(line) {
    var p = body.appendParagraph(line);
    p.editAsText().setFontSize(10);
  });
  body.appendParagraph('');

  // ── Checklist sections ──
  var items = payload.items_data || {};
  Object.keys(items).forEach(function(section) {
    var sHead = body.appendParagraph(section.toUpperCase());
    sHead.editAsText().setFontSize(11).setBold(true);
    sHead.setSpacingBefore(8);

    var sectionItems = items[section];
    Object.keys(sectionItems).forEach(function(itemLabel) {
      var value = sectionItems[itemLabel];
      var line;
      if (value === true || value === false) {
        line = (value ? '☑ ' : '☐ ') + itemLabel;
      } else if (value === 'yes' || value === 'no') {
        line = value.toUpperCase() + ' — ' + itemLabel;
      } else if (value !== null && value !== undefined && String(value).trim() !== '') {
        line = itemLabel + ': ' + value;
      } else {
        line = '— ' + itemLabel;
      }
      var p = body.appendParagraph(line);
      p.editAsText().setFontSize(10).setBold(false);
      p.setIndentStart(18);
    });
    body.appendParagraph('');
  });

  // ── Type-specific footer fields ──
  if (payload.checklist_type === 'pool_school') {
    if (payload.customer_notes) {
      var cnHead = body.appendParagraph('NOTES FROM THE CUSTOMER');
      cnHead.editAsText().setFontSize(11).setBold(true);
      body.appendParagraph(payload.customer_notes).editAsText().setFontSize(10).setBold(false);
      body.appendParagraph('');
    }
    body.appendParagraph('I do Understand How My Pool Works: ___________________________')
      .editAsText().setFontSize(10).setBold(true);
    appendSignatureImage_(body, 'Customer Signature', customerSignatureBlob, customerSignatureUrl);
    body.appendParagraph('');
  } else {
    if (payload.qc_notes) {
      var qcHead = body.appendParagraph('QUALITY CONTROL NOTES');
      qcHead.editAsText().setFontSize(11).setBold(true);
      body.appendParagraph(payload.qc_notes).editAsText().setFontSize(10).setBold(false);
      body.appendParagraph('');
    }
    if (payload.punchlist_notes) {
      var plHead = body.appendParagraph('PUNCHLIST ITEMS INCOMPLETE');
      plHead.editAsText().setFontSize(11).setBold(true);
      body.appendParagraph(payload.punchlist_notes).editAsText().setFontSize(10).setBold(false);
      body.appendParagraph('');
    }
  }

  // ── Sign-off ──
  var signHead = body.appendParagraph('TECHNICIAN SIGN-OFF');
  signHead.editAsText().setFontSize(11).setBold(true);
  body.appendParagraph('Technician: ' + (payload.technician_name || '')).editAsText().setFontSize(10);
  body.appendParagraph('Date Completed: ' + new Date().toLocaleDateString('en-US')).editAsText().setFontSize(10);

  appendSignatureImage_(body, 'Technician Signature', signatureBlob, signatureUrl);

  body.appendParagraph('').editAsText().setFontSize(8);
  body.appendParagraph('Mission Custom Pool Solutions · San Antonio, TX · Confidential')
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
    .editAsText().setFontSize(8);

  doc.saveAndClose();

  var docId = doc.getId();
  var pdfBlob = DriveApp.getFileById(docId).getAs('application/pdf');
  pdfBlob.setName(docName + '.pdf');
  var pdfFile = folder.createFile(pdfBlob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  DriveApp.getFileById(docId).setTrashed(true);

  return { url: pdfFile.getUrl(), file_id: pdfFile.getId(), name: pdfBlob.getName() };
}
