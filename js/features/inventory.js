// ══════════════════════════════════════════════════════════════════════════════
// INVENTORY — stock levels, purchases, SKU review, order CSV export
// Depends on: constants.js (SEC), api.js (api, apiGet), auth.js (isAdmin)
// Uses globals: _s, _invLoaded, _invData, _invTab
// ══════════════════════════════════════════════════════════════════════════════
let _invLoaded = false;
let _invData   = null;
let _invTab    = 'stock';

function loadInventory() {
  _invLoaded = true;
  document.getElementById('inv-loading').style.display = 'block';
  document.getElementById('inv-root').style.display    = 'none';
  apiGet({ action:'get_inventory', token:_s.token })
    .then(res => {
      document.getElementById('inv-loading').style.display = 'none';
      document.getElementById('inv-root').style.display    = 'block';
      if (!res.ok) {
        document.getElementById('inv-root').innerHTML =
          `<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">${res.error||'Failed to load inventory.'}</div></div>`;
        return;
      }
      _invData = res.data;
      renderInventoryPage();
    })
    .catch(e => {
      document.getElementById('inv-loading').style.display = 'none';
      document.getElementById('inv-root').style.display    = 'block';
      document.getElementById('inv-root').innerHTML =
        `<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">Network error: ${e.message}</div></div>`;
    });
}

function renderInventoryPage() {
  const root    = document.getElementById('inv-root');
  const mgr     = isAdmin();
  const items   = _invData || [];
  const outCount= items.filter(i=>i.status==='OUT').length;
  const lowCount= items.filter(i=>i.status==='LOW').length;
  const okCount = items.filter(i=>i.status==='OK').length;

  let html = '';

  // Stats row
  html += `<div class="inv-stat-row">
    <div class="inv-stat out-stat"><div class="inv-stat-num">${outCount}</div><div class="inv-stat-lbl">Out</div></div>
    <div class="inv-stat low-stat"><div class="inv-stat-num">${lowCount}</div><div class="inv-stat-lbl">Low</div></div>
    <div class="inv-stat ok-stat"><div class="inv-stat-num">${okCount}</div><div class="inv-stat-lbl">OK</div></div>
  </div>`;

  // Manager/admin action buttons
  if (mgr) {
    html += `<div class="inv-action-row">
      <button class="inv-action-btn" id="inv-btn-refresh" onclick="invRefreshData()">↻ Refresh</button>
      <button class="inv-action-btn" id="inv-btn-apply"   onclick="invApplyPurchases()">✓ Apply Purchases</button>
      <button class="inv-action-btn" id="inv-btn-csv"     onclick="invOpenOrderCsv()">⬇ Order CSV</button>
    </div>`;
  }

  // Tab bar
  html += `<div class="inv-tab-bar">
    <button class="inv-tab${_invTab==='stock'    ?' active':''}" onclick="invTab('stock')">Inventory</button>
    <button class="inv-tab${_invTab==='purchases'?' active':''}" onclick="invTab('purchases')">Purchases</button>
    ${mgr ? `<button class="inv-tab${_invTab==='review'?' active':''}" onclick="invTab('review')">Review</button>` : ''}
  </div>`;

  html += `<div id="inv-tab-content">${renderInvTabContent_()}</div>`;
  root.innerHTML = html;
}

function renderInvTabContent_() {
  if (_invTab === 'stock')     return renderStockTab_();
  if (_invTab === 'purchases') return renderPurchasesTab_();
  if (_invTab === 'review')    return renderReviewTab_();
  return '';
}

function renderStockTab_() {
  const items = _invData || [];
  const mgr   = isAdmin();
  if (!items.length) return `<div class="inv-empty">No inventory data found.</div>`;
  let html = `<div class="adm-card"><div style="overflow-x:auto"><table class="inv-tbl">
    <thead><tr>
      <th>Chemical</th><th>On Hand</th><th>Status</th><th>Reorder At</th><th>Target</th>${mgr ? '<th></th>' : ''}
    </tr></thead><tbody>`;
  items.forEach((item, idx) => {
    const rc  = item.status==='OUT'?'row-out':item.status==='LOW'?'row-low':'';
    const bdg = `<span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>`;
    const qty = fmtQty_(item.qty);
    const ro  = item.reorder_level>0 ? `${fmtQty_(item.reorder_level)} <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span>` : '—';
    const tg  = item.target_level >0 ? `${fmtQty_(item.target_level)}  <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span>` : '—';
    html += `<tr class="${rc}" id="inv-row-${idx}">
      <td style="font-weight:600">${item.name}</td>
      <td id="inv-qty-cell-${idx}">${qty} <span style="font-size:.75rem;color:var(--muted)">${item.unit}</span></td>
      <td id="inv-status-cell-${idx}">${bdg}</td><td>${ro}</td><td>${tg}</td>
      ${mgr ? `<td style="width:28px;padding:.4rem .5rem"><button class="inv-edit-btn" onclick="invEditQty(${idx})" title="Edit quantity">✏</button></td>` : ''}
    </tr>`;
  });
  html += `</tbody></table></div></div>`;
  return html;
}

function renderPurchasesTab_() {
  if (window._invPurchases) return `<div id="inv-purchases-content">${buildPurchaseTable_(window._invPurchases)}</div>`;
  apiGet({ action:'get_purchase_log', token:_s.token })
    .then(res => {
      window._invPurchases = res.ok ? res.data : [];
      const el = document.getElementById('inv-purchases-content');
      if (el) el.innerHTML = buildPurchaseTable_(window._invPurchases);
    })
    .catch(() => {
      const el = document.getElementById('inv-purchases-content');
      if (el) el.innerHTML = `<div class="inv-empty">Failed to load purchase log.</div>`;
    });
  return `<div id="inv-purchases-content"><div class="route-loading"><div class="spinner"></div></div></div>`;
}

function buildPurchaseTable_(rows) {
  if (!rows||!rows.length) return `<div class="inv-empty">No purchases found.</div>`;
  let html = `<div class="adm-card"><div style="overflow-x:auto"><table class="inv-tbl">
    <thead><tr>
      <th>Date</th><th>Invoice</th><th>Chemical</th><th>Qty</th><th>Applied</th>
    </tr></thead><tbody>`;
  rows.forEach(r => {
    const applied = r.applied==='yes'
      ? `<span class="status-badge ok">Applied</span>`
      : r.applied==='superseded'
        ? `<span class="status-badge" style="background:#f1f5f9;color:var(--muted)">Superseded</span>`
        : `<span class="status-badge low">Pending</span>`;
    const name = r.display_name||r.description||r.sku||'—';
    const qty  = r.qty_shipped>0 ? `${r.qty_shipped} ${r.uom}` : '—';
    html += `<tr>
      <td style="white-space:nowrap">${r.invoice_date||'—'}</td>
      <td style="font-family:'Barlow Condensed',sans-serif;font-size:.78rem;color:var(--muted)">${r.invoice_id||'—'}</td>
      <td style="font-weight:600;max-width:180px">${name}</td>
      <td style="white-space:nowrap">${qty}</td>
      <td>${applied}</td>
    </tr>`;
  });
  html += `</tbody></table></div></div>`;
  return html;
}

function renderReviewTab_() {
  if (window._invPending) return `<div id="inv-review-content">${buildPendingCards_(window._invPending)}</div>`;
  apiGet({ action:'get_pending_skus', token:_s.token })
    .then(res => {
      window._invPending = res.ok ? res.data : [];
      const el = document.getElementById('inv-review-content');
      if (el) el.innerHTML = buildPendingCards_(window._invPending);
    })
    .catch(() => {
      const el = document.getElementById('inv-review-content');
      if (el) el.innerHTML = `<div class="inv-empty">Failed to load pending SKUs.</div>`;
    });
  return `<div id="inv-review-content"><div class="route-loading"><div class="spinner"></div></div></div>`;
}

function buildPendingCards_(items) {
  if (!items||!items.length) return `<div class="inv-empty">No SKUs pending review. 🎉</div>`;
  return items.map(item => {
    const cc = item.ai_confidence==='high'?'conf-high':item.ai_confidence==='medium'?'conf-medium':'conf-low';
    return `<div class="pend-card" id="pend-row-${item.rowIndex}">
      <div class="pend-sku">${item.sku}</div>
      <div class="pend-desc">${item.description||'—'}</div>
      <div class="pend-ai">
        ${item.ai_display_name?`<span class="pend-ai-pill">${item.ai_display_name}</span>`:''}
        ${item.ai_category   ?`<span class="pend-ai-pill">${item.ai_category}</span>`:''}
        ${item.ai_confidence ?`<span class="pend-ai-pill ${cc}">${item.ai_confidence} confidence</span>`:''}
        ${item.qty_shipped   ?`<span class="pend-ai-pill">Qty: ${item.qty_shipped} ${item.uom}</span>`:''}
      </div>
      ${item.ai_reason?`<div style="font-size:.78rem;color:var(--muted);margin-bottom:.75rem">${item.ai_reason}</div>`:''}
      <div class="pend-btns">
        <button class="pend-approve" onclick="invApproveSku(${item.rowIndex})">Approve</button>
        <button class="pend-reject"  onclick="invRejectSku(${item.rowIndex})">Reject</button>
      </div>
    </div>`;
  }).join('');
}

function invTab(tab) {
  _invTab = tab;
  document.querySelectorAll('.inv-tab').forEach(t => {
    t.classList.toggle('active', t.textContent.trim().toLowerCase()===tab);
  });
  document.getElementById('inv-tab-content').innerHTML = renderInvTabContent_();
}

function invRefreshData() {
  const btn = document.getElementById('inv-btn-refresh');
  if (btn) { btn.disabled=true; btn.textContent='Refreshing…'; }
  _invLoaded = false; _invData = null;
  window._invPurchases = null; window._invPending = null;
  loadInventory();
}

function invApplyPurchases() {
  const btn = document.getElementById('inv-btn-apply');
  if (btn) { btn.disabled=true; btn.textContent='Applying…'; }
  api({ secret:SEC, action:'manual_apply_purchases', token:_s.token })
    .then(res => {
      if (btn) { btn.disabled=false; btn.textContent='✓ Apply Purchases'; }
      if (res.ok) {
        const r = res.result||{};
        const msg = `Applied: ${r.applied||0}  |  Reversed: ${r.reversed||0}`
          + (r.unmapped&&r.unmapped.length ? `\nUnmapped: ${r.unmapped.join(', ')}` : '');
        alert(msg);
        invRefreshData();
      } else { alert('Error: '+(res.error||'Unknown')); }
    })
    .catch(e => { if (btn) { btn.disabled=false; btn.textContent='✓ Apply Purchases'; } alert('Network error: '+e.message); });
}

function invApproveSku(rowIndex) {
  const card = document.getElementById('pend-row-'+rowIndex);
  if (!card) return;
  const btn = card.querySelector('.pend-approve');
  if (btn) { btn.disabled=true; btn.textContent='Approving…'; }
  api({ secret:SEC, action:'approve_pending_sku', token:_s.token, rowIndex, overrides:{} })
    .then(res => {
      if (res.ok) {
        card.style.opacity='0.4'; card.style.pointerEvents='none';
        card.querySelector('.pend-btns').innerHTML =
          `<span style="font-family:'Barlow Condensed',sans-serif;font-size:.82rem;color:var(--success);font-weight:700">✓ Approved — ${res.displayName||''}</span>`;
        window._invPending = null;
      } else {
        if (btn) { btn.disabled=false; btn.textContent='Approve'; }
        alert('Error: '+(res.error||'Unknown'));
      }
    })
    .catch(e => { if (btn) { btn.disabled=false; btn.textContent='Approve'; } alert('Network error: '+e.message); });
}

function invRejectSku(rowIndex) {
  if (!confirm('Reject this SKU?')) return;
  const card = document.getElementById('pend-row-'+rowIndex);
  api({ secret:SEC, action:'reject_pending_sku', token:_s.token, rowIndex })
    .then(res => {
      if (res.ok && card) {
        card.style.opacity='0.4'; card.style.pointerEvents='none';
        card.querySelector('.pend-btns').innerHTML =
          `<span style="font-family:'Barlow Condensed',sans-serif;font-size:.82rem;color:var(--error);font-weight:700">✕ Rejected</span>`;
        window._invPending = null;
      }
    });
}

function fmtQty_(n) {
  const num = Number(n||0);
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/,'');
}

// ── Inline qty editing ──────────────────────────────────────────────────────

function invEditQty(idx) {
  const item = (_invData||[])[idx];
  if (!item) return;
  const cell = document.getElementById('inv-qty-cell-'+idx);
  if (!cell) return;
  const cur = Number(item.qty||0);
  const disp = Number.isInteger(cur) ? String(cur) : cur.toFixed(2).replace(/\.?0+$/,'');
  cell.innerHTML = `<span class="inv-qty-wrap">
    <input class="inv-qty-input" id="inv-qty-input-${idx}" type="number" min="0" step="any" value="${disp}">
    <button class="inv-qty-save" onclick="invSaveQty(${idx})">Save</button>
    <button class="inv-qty-cancel" onclick="invCancelEdit(${idx})">✕</button>
  </span>`;
  const inp = document.getElementById('inv-qty-input-'+idx);
  if (inp) { inp.focus(); inp.select(); inp.addEventListener('keydown', e => { if (e.key==='Enter') invSaveQty(idx); if (e.key==='Escape') invCancelEdit(idx); }); }
}

function invCancelEdit(idx) {
  const item = (_invData||[])[idx];
  if (!item) return;
  const cell = document.getElementById('inv-qty-cell-'+idx);
  if (!cell) return;
  cell.innerHTML = `${fmtQty_(item.qty)} <span style="font-size:.75rem;color:var(--muted)">${item.unit}</span>`;
}

function invSaveQty(idx) {
  const item = (_invData||[])[idx];
  if (!item) return;
  const inp = document.getElementById('inv-qty-input-'+idx);
  if (!inp) return;
  const newQty = parseFloat(inp.value);
  if (isNaN(newQty) || newQty < 0) { inp.focus(); return; }
  const saveBtn = inp.closest('.inv-qty-wrap').querySelector('.inv-qty-save');
  if (saveBtn) { saveBtn.disabled=true; saveBtn.textContent='Saving…'; }
  api({ secret:SEC, action:'set_inventory_qty', token:_s.token, chemical:item.name, qty:newQty })
    .then(res => {
      if (res.ok) {
        item.qty = newQty;
        // Recompute status
        if (newQty <= 0) item.status = 'OUT';
        else if (item.reorder_level > 0 && newQty <= item.reorder_level) item.status = 'LOW';
        else item.status = 'OK';
        invCancelEdit(idx);
        // Update row class
        const row = document.getElementById('inv-row-'+idx);
        if (row) row.className = item.status==='OUT'?'row-out':item.status==='LOW'?'row-low':'';
        // Update status badge
        const sc = document.getElementById('inv-status-cell-'+idx);
        if (sc) sc.innerHTML = `<span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>`;
        // Update summary counters
        const items = _invData||[];
        const outN = items.filter(i=>i.status==='OUT').length;
        const lowN = items.filter(i=>i.status==='LOW').length;
        const okN  = items.filter(i=>i.status==='OK').length;
        const el = s => document.querySelector(s);
        if (el('.out-stat .inv-stat-num')) el('.out-stat .inv-stat-num').textContent = outN;
        if (el('.low-stat .inv-stat-num')) el('.low-stat .inv-stat-num').textContent = lowN;
        if (el('.ok-stat  .inv-stat-num')) el('.ok-stat  .inv-stat-num').textContent = okN;
      } else {
        if (saveBtn) { saveBtn.disabled=false; saveBtn.textContent='Save'; }
        alert('Error: '+(res.error||'Unknown'));
      }
    })
    .catch(e => {
      if (saveBtn) { saveBtn.disabled=false; saveBtn.textContent='Save'; }
      alert('Network error: '+e.message);
    });
}

// ── Order CSV export ────────────────────────────────────────────────────────

function invOpenOrderCsv() {
  const backdrop = document.getElementById('csv-modal-backdrop');
  if (!backdrop) return;
  document.getElementById('csv-modal-body').innerHTML = '<div class="route-loading"><div class="spinner"></div></div>';
  backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
  invBuildCsvModal_();
}

function invCloseCsvModal(e) {
  if (e && e.target !== document.getElementById('csv-modal-backdrop')) return;
  const backdrop = document.getElementById('csv-modal-backdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.body.style.overflow = '';
}

function invBuildCsvModal_() {
  const body = document.getElementById('csv-modal-body');
  if (!body) return;

  const buildTable = () => {
    const items    = _invData || [];
    const purchases = window._invPurchases || [];

    // Build latest-purchase map keyed by display_name
    const latestPurch = {};
    for (const p of purchases) {
      const key = (p.display_name || p.description || p.sku || '').trim();
      if (!key) continue;
      latestPurch[key] = { sku: p.sku||'', description: p.description||'', uom: p.uom||'' };
    }

    const orderItems = items.filter(i => i.status==='OUT' || i.status==='LOW');
    if (!orderItems.length) {
      body.innerHTML = `<div class="inv-empty" style="padding:2rem 0">No items need ordering right now. 🎉</div>`;
      return;
    }

    let html = `<p style="font-size:.82rem;color:var(--muted);margin-bottom:.85rem">Adjust order quantities as needed, then download. Items without a SKU are excluded from the CSV.</p>`;
    html += `<table class="csv-tbl"><thead><tr>
      <th>Chemical</th><th>SKU</th><th>Status</th><th>Stock</th><th>Target</th><th style="text-align:right">Order Qty</th><th>UOM</th>
    </tr></thead><tbody>`;

    orderItems.forEach(item => {
      const purch   = latestPurch[item.name] || {};
      const gap     = Math.max(0, (item.target_level||0) - (item.qty||0));
      const defQty  = Math.ceil(gap) || 1;
      const sku     = purch.sku || '';
      const uom     = purch.uom || item.unit || '';
      const desc    = purch.description || '';
      const badge   = `<span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>`;
      const skuCell = sku
        ? `<span style="font-family:'Barlow Condensed',sans-serif;font-size:.78rem;">${sku}</span>`
        : `<span class="csv-no-sku">—</span>`;
      // escape for data attrs
      const safeDesc = desc.replace(/"/g, '&quot;');
      const safeSku  = sku.replace(/"/g, '&quot;');
      const safeUom  = uom.replace(/"/g, '&quot;');
      html += `<tr>
        <td style="font-weight:600">${item.name}</td>
        <td>${skuCell}</td>
        <td>${badge}</td>
        <td>${fmtQty_(item.qty)} <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span></td>
        <td>${fmtQty_(item.target_level)} <span style="font-size:.72rem;color:var(--muted)">${item.unit}</span></td>
        <td style="text-align:right"><input class="csv-order-qty" type="number" min="0" step="any" value="${defQty}"
          data-sku="${safeSku}" data-uom="${safeUom}" data-desc="${safeDesc}"></td>
        <td style="font-size:.78rem;color:var(--muted)">${uom}</td>
      </tr>`;
    });

    html += `</tbody></table>`;
    body.innerHTML = html;
  };

  if (window._invPurchases) {
    buildTable();
  } else {
    apiGet({ action:'get_purchase_log', token:_s.token })
      .then(res => { window._invPurchases = res.ok ? res.data : []; buildTable(); })
      .catch(() => { window._invPurchases = []; buildTable(); });
  }
}

function invDownloadOrderCsv() {
  const inputs = document.querySelectorAll('#csv-modal-body .csv-order-qty');
  const rows = ['ITEM #,Qty,Product Name,MFG #,Price,UOM,ExtendedPrice'];
  let hasRows = false;

  inputs.forEach(inp => {
    const qty = parseFloat(inp.value);
    if (!qty || qty <= 0) return;
    const sku  = inp.dataset.sku  || '';
    const uom  = inp.dataset.uom  || '';
    let   desc = inp.dataset.desc || '';
    if (!sku) return; // skip items without a SKU
    if (desc.includes(',') || desc.includes('"') || desc.includes('\n')) {
      desc = `"${desc.replace(/"/g, '""')}"`;
    }
    rows.push(`${sku},${qty},${desc},,,,${uom},`);
    hasRows = true;
  });

  if (!hasRows) {
    alert('No items with SKUs and qty > 0. Items need purchase history to have a SKU.');
    return;
  }

  const csv  = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const d    = new Date();
  const pad  = n => String(n).padStart(2, '0');
  a.href     = url;
  a.download = `Heritage_Order_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
