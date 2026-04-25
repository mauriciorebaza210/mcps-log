// ══════════════════════════════════════════════════════════════════════════════
// ROUTES / MAP PAGE — technician hub, calendar, weather, operator profile, route management
// Depends on: constants.js (SEC, ALL_DAYS), api.js (api, apiGet), auth.js (isAdmin)
// Uses globals: _s, _routeData, _routeFetchInFlight, _activeOp, _activeDay, _daySelectTimer, _weekOffset, _leafMap, _mapMarkers, _mapLoaded, _calData, _calMonth, _calYear, _activeHubTab, _profileOp, _usersCache
// ══════════════════════════════════════════════════════════════════════════════
// ROUTES / MAP PAGE
// ══════════════════════════════════════════════════════════════════════════════
function loadRoutes(opOverride) {
  const op = opOverride || _activeOp;

  // ── Cache hit: skip network call entirely ──
  const cached = _getRouteCache(op, _weekOffset);
  if (cached) {
    _routeData = cached;
    document.getElementById('route-loading').style.display = 'none';
    document.getElementById('route-content').style.display = 'block';
    renderRoutePage();
    if (isAdmin()) loadUnassigned();
    return;
  }

  // ── Request deduplication: attach to in-flight promise if already fetching ──
  const fetchKey = _routeCacheKey(op, _weekOffset);
  if (_routeFetchInFlight && _routeFetchInFlight.key === fetchKey) {
    _routeFetchInFlight.promise.then(() => { if (_routeData) renderRoutePage(); });
    return;
  }

  // ── Show skeleton while loading ──
  _showRouteSkeleton();

  const params = { action: 'route_data', token: _s.token, operator: op, week_start: _weekStartForOffset_(_weekOffset) };
  if (_weekOffset !== 0) params.week_offset = _weekOffset;

  const svParams = { action: 'scheduled_visits', token: _s.token, operator: op, week_start: _weekStartForOffset_(_weekOffset) };

  const fetchPromise = Promise.all([
    apiGet(params),
    apiGet(svParams)
  ])
    .then(([res, svRes]) => {
      _routeFetchInFlight = null;
      if (!res.ok) {
        document.getElementById('route-content').innerHTML = `<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">${res.error}</div></div>`;
        return;
      }

      // Merge scheduled visits into route data days
      if (svRes && svRes.ok && svRes.visits && svRes.visits.length > 0) {
        _mergeScheduledVisits_(res.days, svRes.visits);
      }

      _routeData = res;
      _setRouteCache(op, _weekOffset, res);
      renderRoutePage();
      if (isAdmin()) loadUnassigned();
    })
    .catch(e => {
      _routeFetchInFlight = null;
      document.getElementById('route-content').innerHTML = `<div class="route-empty"><div class="route-empty-icon">⚠️</div><div class="route-empty-text">Network error: ${e.message}</div></div>`;
    });

  _routeFetchInFlight = { key: fetchKey, promise: fetchPromise };
}

// ── Merge Scheduled Visits Logic ──
function _mergeScheduledVisits_(days, visits) {
  if (!days || !visits) return;
  const dayMap = {};
  days.forEach(d => {
    if (d.date) dayMap[d.date] = d;
  });

  visits.forEach(v => {
    if (!v.scheduled_date) return;
    const dayObj = dayMap[v.scheduled_date];
    if (dayObj) {
      if (!dayObj.pools) dayObj.pools = [];
      // Deduplication: Avoid adding if there's already a regular route stop for this pool,
      // UNLESS we want both to show. For startups, we typically want the scheduled visit to 
      // replace or augment. For now, we will add it directly but mark it as a scheduled_visit.
      const existingIdx = dayObj.pools.findIndex(p => p.pool_id === v.pool_id);
      if (existingIdx !== -1) {
        // If a recurring route already exists, we can tag it or skip
        // We'll tag it with the visit info to update the badge later
        dayObj.pools[existingIdx]._is_scheduled_visit = true;
        dayObj.pools[existingIdx]._visit_type = v.visit_type;
        dayObj.pools[existingIdx]._scheduled_visit_id = v.scheduled_visit_id;
      } else {
        // Build a pool-like object for the scheduled visit
        dayObj.pools.push({
          pool_id: v.pool_id,
          customer_name: v.customer_name,
          address: v.address,
          city: v.city,
          service: v.service_type || v.visit_type,
          maps_url: '', // We can lazily recompute maps urls later if needed
          lat: '',
          lng: '',
          operator: v.assigned_technician,
          pinned: false,

          // Flags for renderer
          _is_scheduled_visit: true,
          _visit_type: v.visit_type,
          _scheduled_visit_id: v.scheduled_visit_id
        });
      }
    }
  });
}

// ── Map Calendar Logic ──
let _currentMapView = 'week';
let _calData = null;
let _calMonth = new Date().getMonth() + 1;
let _calYear = new Date().getFullYear();

// switchHubTab — see js/lib/router.js

// ── Admin week navigation ──
function navWeek(dir) {
  _weekOffset += dir;
  _routeData = null;
  _clearRouteCache();
  loadRoutes();
}

// Compute the Monday date string for a given offset from current week
function _weekStartForOffset_(offset) {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // this Monday
  const mon = new Date(d.getFullYear(), d.getMonth(), diff + (offset * 7));
  const pad = n => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
}

function _extendStartupPools_(origDays) {
  const days = origDays.map(d => ({ ...d, pools: (d.pools || []).map(p => ({ ...p })) }));
  days.forEach((d, dIdx) => {
    d.pools.forEach(pool => {
      // Do not duplicate explicitly scheduled visits
      if (pool._is_scheduled_visit) return;
      if (pool._startupDay) return; // already a ghost
      if (!(pool.service || '').toLowerCase().includes('startup')) return;
      pool._startupDay = 1;
      [1, 2].forEach(offset => {
        const nextIdx = dIdx + offset;
        if (nextIdx < days.length) {
          days[nextIdx].pools.push({ ...pool, _startupDay: offset + 1, _startupOriginDay: d.day });
        }
      });
    });
  });
  return days;
}

// Return up to 3 consecutive day names starting at startDay
function _startupSpanDays_(startDay) {
  const idx = ALL_DAYS.indexOf(startDay);
  if (idx === -1) return [startDay];
  return ALL_DAYS.slice(idx, idx + 3);
}

// Update the startup span preview inside the pool action sheet
function _updateStartupSpanPreview_() {
  const previewEl = document.getElementById('pas-startup-span');
  const labelEl = document.getElementById('pas-day-section-label');
  if (!previewEl) return;
  if (!_pasState || !_pasState.isStartup) {
    previewEl.style.display = 'none';
    if (labelEl) labelEl.textContent = '📅 Move to different day';
    return;
  }
  if (labelEl) labelEl.textContent = '📅 Set Startup Start Day';
  const spanDays = _startupSpanDays_(_pasState.newDay);
  previewEl.style.display = 'block';
  previewEl.innerHTML = '<span style="color:var(--muted)">3-day block: </span>'
    + spanDays.map(d => `<strong style="color:var(--teal)">${d.slice(0, 3)}</strong>`).join(' → ');
}

function switchMapView(view) {
  _currentMapView = view;
  document.getElementById('btn-view-week').classList.toggle('active', view === 'week');
  document.getElementById('btn-view-month').classList.toggle('active', view === 'month');

  if (view === 'week') {
    document.getElementById('map-week-view').style.display = 'block';
    document.getElementById('map-month-view').style.display = 'none';
    const addBtn = document.getElementById('btn-add-adhoc');
    if (addBtn) addBtn.style.display = 'none';
    if (!_routeData) loadRoutes();
  } else {
    document.getElementById('map-week-view').style.display = 'none';
    document.getElementById('map-month-view').style.display = 'block';
    if (isAdmin()) {
      const addBtn = document.getElementById('btn-add-adhoc');
      if (addBtn) addBtn.style.display = 'block';
    }
    loadCalendarData(_calMonth, _calYear);
  }
}

function navMonth(dir) {
  _calMonth += dir;
  if (_calMonth > 12) { _calMonth = 1; _calYear++; }
  else if (_calMonth < 1) { _calMonth = 12; _calYear--; }
  loadCalendarData(_calMonth, _calYear);
}

function loadCalendarData(m, y) {
  document.getElementById('route-loading').style.display = 'block';
  document.getElementById('route-content').style.display = 'none';

  const t = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const titleEl = document.getElementById('cal-month-title');
  if (titleEl) titleEl.textContent = t;

  apiGet({ action: 'calendar_data', token: _s.token, month: m, year: y, operator: _activeOp })
    .then(res => {
      document.getElementById('route-loading').style.display = 'none';
      document.getElementById('route-content').style.display = 'block';
      if (!res.ok) {
        document.getElementById('cal-cells').innerHTML = `<div style="grid-column: span 7; padding: 2rem; text-align: center;">Error: ${res.error}</div>`;
        return;
      }
      _calData = res.days || [];
      if (res.all_operators) _calOperatorList = res.all_operators;

      // Update Op Filter Data
      if (isAdmin() && res.all_operators && res.all_operators.length > 1) {
        const opRow = document.getElementById('op-filter-row');
        opRow.style.display = 'flex';
        opRow.innerHTML = '<button class="op-filter-btn' + ((_activeOp === 'all') ? ' active' : '') + '" onclick="switchOp(\'all\')">All</button>' +
          res.all_operators.map(op => { const un = op.username || op, nm = op.name || op; return `<button class="op-filter-btn${_activeOp === un ? ' active' : ''}" onclick="switchOp('${un}')">${nm.split(' ')[0]}</button>`; }).join('');
      }

      renderMapCalendar();
    })
    .catch(e => {
      document.getElementById('route-loading').style.display = 'none';
      document.getElementById('route-content').style.display = 'block';
      document.getElementById('cal-cells').innerHTML = `<div style="grid-column: span 7; padding: 2rem; text-align: center;">Network Error: ${e.message}</div>`;
    });
}

function renderMapCalendar() {
  const wrap = document.getElementById('cal-cells');
  if (!wrap) return;
  if (!_calData || !_calData.length) { wrap.innerHTML = ''; return; }

  const todayStr = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); // yyyy-mm-dd

  let html = '';
  _calData.forEach((day, idx) => {
    let pillsHtml = '';

    // Summarize weeklies
    if (day.weeklies && day.weeklies.length > 0) {
      pillsHtml += `<div class="cal-pill weekly">${day.weeklies.length} Weeklies</div>`;
    }

    // Adhocs (already filtered softly by backend for technicians, though we enforce admin only on adHoc sheet)
    if (day.adhocs && day.adhocs.length > 0) {
      day.adhocs.forEach(a => {
        let pcls = 'onetime';
        if (a.type === 'Proposal') pcls = 'proposal';
        if (a.type === 'Green to Clean') pcls = 'green';
        pillsHtml += `<div class="cal-pill ${pcls}">${a.type}: ${a.customer_name || a.city || 'Unknown'}</div>`;
      });
    }

    const cls = [];
    if (!day.isCurrentMonth) cls.push('out-month');
    if (day.date === todayStr) cls.push('today');

    html += `<div class="cal-cell ${cls.join(' ')}" onclick="showCalDayDetails(${idx})">
               <div class="cal-cell-date">${day.dayNum}</div>
               ${pillsHtml}
             </div>`;
  });

  wrap.innerHTML = html;
  document.getElementById('cal-detail-card').style.display = 'none';
}

function showCalDayDetails(idx) {
  const day = _calData[idx];
  if (!day) return;
  const c = document.getElementById('cal-detail-card');
  c.style.display = 'block';

  let html = `<div style="font-family:'Oswald',sans-serif;font-size:1.1rem;color:var(--teal);border-bottom:1px solid var(--border);padding-bottom:0.5rem;margin-bottom:1rem;">Details for ${day.date}</div>`;

  if ((!day.weeklies || !day.weeklies.length) && (!day.adhocs || !day.adhocs.length)) {
    html += `<div style="color:var(--muted);font-size:0.9rem;">No services scheduled.</div>`;
  } else {
    // Adhocs First
    if (day.adhocs && day.adhocs.length > 0) {
      html += `<div style="font-weight:600;margin-bottom:0.5rem;font-size:0.85rem;color:var(--muted);text-transform:uppercase;">Special Services & Proposals</div>`;
      day.adhocs.forEach(a => {
        let pcls = 'onetime';
        if (a.type === 'Proposal') pcls = 'proposal';
        if (a.type === 'Green to Clean') pcls = 'green';

        html += `<div style="margin-bottom:0.75rem;padding:0.75rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
             <span style="font-weight:600;font-size:0.9rem;">${a.customer_name || 'No Name'}</span>
             <span class="cal-pill ${pcls}">${a.type}</span>
          </div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.25rem;">
            📍 ${a.address || 'No Address'} <br>
            👤 Op: ${a.operator || 'Unassigned'} <br>
            ${a.notes ? `📝 ${a.notes}` : ''}
          </div>
        </div>`;
      });
    }

    // Weeklies
    if (day.weeklies && day.weeklies.length > 0) {
      html += `<div style="font-weight:600;margin:1rem 0 0.5rem;font-size:0.85rem;color:var(--muted);text-transform:uppercase;">Recurring Routes (${day.weeklies.length})</div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(250px, 1fr));gap:0.5rem;">`;
      day.weeklies.forEach(w => {
        html += `<div style="padding:0.6rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:0.85rem;">
            <div style="font-weight:600;">${w.customer_name || w.pool_id}</div>
            <div style="color:var(--muted);font-size:0.75rem;">${w.address}, ${w.city}</div>
            <div style="color:var(--teal-mid);font-size:0.75rem;margin-top:0.2rem;font-weight:600;">Op: ${w.operator || 'Unassigned'}</div>
         </div>`;
      });
      html += `</div>`;
    }
  }

  c.innerHTML = html;
  c.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ── AdHoc Modal ──
function openAdHocModal() {
  document.getElementById('adhoc-date').value = new Date().toLocaleDateString('en-CA');
  document.getElementById('adhoc-type').value = 'Proposal';
  document.getElementById('adhoc-customer').value = '';
  document.getElementById('adhoc-address').value = '';
  document.getElementById('adhoc-notes').value = '';

  const opSel = document.getElementById('adhoc-operator');
  if (opSel) {
    opSel.innerHTML = '<option value="">Unassigned</option>';
    if (window._calOperatorList) {
      _calOperatorList.forEach(op => {
        opSel.innerHTML += `<option value="${op}">${op}</option>`;
      });
    } else if (_routeData && _routeData.all_operators) {
      _routeData.all_operators.forEach(op => {
        opSel.innerHTML += `<option value="${op}">${op}</option>`;
      });
    }
  }

  document.getElementById('adhoc-modal-backdrop').classList.add('open');
}

function closeAdHocModal() {
  document.getElementById('adhoc-modal-backdrop').classList.remove('open');
}

function saveAdHocEvent() {
  const btn = document.getElementById('btn-save-adhoc');
  const evt = {
    date: document.getElementById('adhoc-date').value,
    type: document.getElementById('adhoc-type').value,
    customer_name: document.getElementById('adhoc-customer').value.trim(),
    address: document.getElementById('adhoc-address').value.trim(),
    operator: document.getElementById('adhoc-operator').value,
    notes: document.getElementById('adhoc-notes').value.trim(),
  };

  if (!evt.date) { alert("Date is required"); return; }

  btn.disabled = true; btn.textContent = 'Saving...';
  api({ action: 'add_adhoc_event', token: _s.token, event: evt })
    .then(res => {
      btn.disabled = false; btn.textContent = 'Save Event';
      if (!res.ok) { alert(res.error || "Failed to save event"); return; }
      closeAdHocModal();
      loadCalendarData(_calMonth, _calYear); // reload
    })
    .catch(e => {
      btn.disabled = false; btn.textContent = 'Save Event';
      alert("Network error: " + e.message);
    });
}


// ── Form Editor (Admin) ──────────────────────────────────────────────────────
let _formSchema = [];

function toggleFormEditor(btn) {
  const wrap = document.getElementById('form-editor-wrap');
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '✕ Close' : '✏️ Edit Form';
  if (open && _formSchema.length === 0) adminLoadFormEditor();
}

function adminLoadFormEditor() {
  const list = document.getElementById('form-field-list');
  list.innerHTML = '<div style="text-align:center;padding:1.5rem"><div class="spinner" style="margin:0 auto"></div></div>';
  api({ secret: SEC, action: 'get_portal_schema', token: _s.token }).then(res => {
    if (!res.ok) { list.innerHTML = '<div style="color:var(--error);padding:1rem">Error: ' + res.error + '</div>'; return; }
    _formSchema = res.data;
    renderFormFieldList();
  }).catch(e => { list.innerHTML = '<div style="color:var(--error);padding:1rem">Network error: ' + e.message + '</div>'; });
}

function renderFormFieldList() {
  const el = document.getElementById('form-field-list');
  if (!_formSchema.length) { el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:1.5rem;font-size:.85rem">No fields. Add one below.</div>'; return; }
  el.innerHTML = _formSchema.map((item, idx) => {
    const type = String(item.type || '').trim();
    if (type === 'PAGE_BREAK') {
      return `<div class="fe-break">
        <span class="fe-break-label">── ${item.title || 'Section Break'} ──</span>
        <div style="display:flex;gap:.25rem">
          <button class="fe-btn" onclick="feMoveUp(${idx})" title="Move up">↑</button>
          <button class="fe-btn" onclick="feMoveDown(${idx})" title="Move down">↓</button>
          <button class="fe-btn fe-del" onclick="feDelete(${idx})" title="Delete">✕</button>
        </div>
      </div>`;
    }
    const hasChoices = type === 'LIST' || type === 'CHECKBOX';
    let choicesText = '';
    if (hasChoices && item.choices) {
      try { const c = JSON.parse(item.choices); choicesText = c.length + ' choices'; } catch (e) { }
    }
    return `<div class="fe-row" id="fe-row-${idx}">
        <div class="fe-row-left">
          <div class="fe-row-title">${item.title || '—'}</div>
          <div class="fe-row-meta">${type}${item.section ? ' · ' + item.section : ''}${item.helpText ? ' · ' + String(item.helpText).slice(0, 45) + (item.helpText.length > 45 ? '…' : '') : ''}${choicesText ? ' · ' + choicesText : ''}</div>
        </div>
        <div style="display:flex;gap:.25rem;flex-shrink:0;margin-left:.5rem">
          <button class="fe-btn" onclick="feMoveUp(${idx})" title="Move up">↑</button>
          <button class="fe-btn" onclick="feMoveDown(${idx})" title="Move down">↓</button>
          <button class="fe-btn" onclick="feToggleEdit(${idx})" title="Edit">✏️</button>
          <button class="fe-btn fe-del" onclick="feDelete(${idx})" title="Delete">✕</button>
        </div>
      </div>
      <div class="fe-edit-panel" id="fe-edit-${idx}" style="display:none">
        <div class="fe-edit-grid">
          <div class="dfg" style="margin:0"><label>Title</label><input class="si" id="fe-t-${idx}" value="${(item.title || '').replace(/"/g, '&quot;')}"></div>
          <div class="dfg" style="margin:0"><label>Help Text</label><input class="si" id="fe-h-${idx}" value="${(item.helpText || '').replace(/"/g, '&quot;')}"></div>
          ${hasChoices ? `<div class="dfg" style="margin:0;grid-column:span 2"><label>Choices (one per line)</label><textarea class="si" id="fe-c-${idx}" rows="4" style="resize:vertical">${item.choices ? JSON.parse(item.choices || '[]').join('\n') : ''}</textarea></div>` : ''}
          <div class="dfg" style="margin:0;display:flex;align-items:center;gap:.4rem;padding-top:.5rem">
            <label style="display:flex;align-items:center;gap:.35rem;font-size:.83rem;cursor:pointer">
              <input type="checkbox" id="fe-r-${idx}" ${(item.required === true || item.required === 'TRUE') ? 'checked' : ''}> Required
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;align-items:flex-end">
            <button class="adm-new-btn" style="padding:.38rem .85rem;font-size:.78rem" onclick="feApplyEdit(${idx})">Apply</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function feMoveUp(idx) {
  if (idx === 0) return;
  [_formSchema[idx - 1], _formSchema[idx]] = [_formSchema[idx], _formSchema[idx - 1]];
  _feReorder(); renderFormFieldList();
}
function feMoveDown(idx) {
  if (idx >= _formSchema.length - 1) return;
  [_formSchema[idx + 1], _formSchema[idx]] = [_formSchema[idx], _formSchema[idx + 1]];
  _feReorder(); renderFormFieldList();
}
function _feReorder() { _formSchema.forEach((item, i) => { item.order = i + 1; }); }

function feToggleEdit(idx) {
  const el = document.getElementById('fe-edit-' + idx);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function feApplyEdit(idx) {
  const item = _formSchema[idx];
  item.title = document.getElementById('fe-t-' + idx).value.trim();
  item.helpText = document.getElementById('fe-h-' + idx).value.trim();
  item.required = document.getElementById('fe-r-' + idx).checked;
  const choicesEl = document.getElementById('fe-c-' + idx);
  if (choicesEl) {
    item.choices = JSON.stringify(choicesEl.value.split('\n').map(s => s.trim()).filter(Boolean));
  }
  document.getElementById('fe-edit-' + idx).style.display = 'none';
  renderFormFieldList();
}

function feDelete(idx) {
  if (!confirm('Delete "' + (_formSchema[idx].title || 'this field') + '"?')) return;
  _formSchema.splice(idx, 1);
  _feReorder(); renderFormFieldList();
}

function adminAddFormField() {
  const title = document.getElementById('new-field-title').value.trim();
  const type = document.getElementById('new-field-type').value;
  if (!title && type !== 'PAGE_BREAK') { alert('Title is required.'); return; }
  const maxOrder = _formSchema.reduce((m, i) => Math.max(m, Number(i.order || 0)), 0);
  _formSchema.push({ order: maxOrder + 1, section: '', title, type, helpText: '', required: false, choices: '' });
  document.getElementById('new-field-title').value = '';
  renderFormFieldList();
  document.getElementById('form-field-list').lastElementChild.scrollIntoView({ behavior: 'smooth' });
}

function adminSaveFormSchema() {
  const btn = document.getElementById('fe-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  api({ secret: SEC, action: 'save_portal_schema', token: _s.token, schema: _formSchema })
    .then(res => {
      btn.disabled = false;
      if (res.ok) { btn.textContent = '✅ Saved!'; setTimeout(() => { btn.textContent = '💾 Save Changes'; }, 2500); }
      else { btn.textContent = '💾 Save Changes'; alert('Error: ' + res.error); }
    })
    .catch(e => { btn.disabled = false; btn.textContent = '💾 Save Changes'; alert('Network error: ' + e.message); });
}

function adminSyncPoolDropdown() {
  if (!confirm('Rebuild pool dropdown from Signed Customers?')) return;
  api({ secret: SEC, action: 'sync_pool_dropdown', token: _s.token }).then(res => {
    if (res.ok) { alert('✅ Pool dropdown synced.'); adminLoadFormEditor(); }
    else alert('Error: ' + res.error);
  }).catch(e => alert('Network error: ' + e.message));
}

function adminSyncChemicals() {
  if (!confirm('Sync chemical fields from Chem Costs?')) return;
  api({ secret: SEC, action: 'sync_chemicals', token: _s.token }).then(res => {
    if (res.ok) { alert('✅ Chemicals synced.'); adminLoadFormEditor(); }
    else alert('Error: ' + res.error);
  }).catch(e => alert('Network error: ' + e.message));
}

function recalculateRoutes() {
  if (!confirm('⚠️ Recalculate ALL routes?\n\nThis will reassign every un-pinned pool. Pinned pools stay put. Locked days are not affected.\n\nContinue?')) return;
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Recalculating...';
  api({ secret: SEC, action: 'recalculate_routes', token: _s.token })
    .then(res => {
      btn.disabled = false; btn.textContent = '🔄 Recalculate All Routes';
      if (res.ok) {
        _routeData = null;
        alert('✅ Routes recalculated successfully!');
        if (_curPage === 'live_map') loadRoutes();
      } else {
        alert('Error: ' + (res.error || 'Unknown'));
      }
    })
    .catch(e => {
      btn.disabled = false; btn.textContent = '🔄 Recalculate All Routes';
      alert('Network error: ' + e.message);
    });
}

function loadUnassigned() {
  Promise.all([
    apiGet({ action: 'get_unassigned', token: _s.token }),
    apiGet({ action: 'get_crm_data', token: _s.token })
  ]).then(([unRes, crmRes]) => {
    if (unRes.ok && unRes.pools) {
      const crmData = (crmRes.ok && crmRes.data) ? crmRes.data : [];
      _unassignedPools = unRes.pools.filter(p => {
        const s = (p.service || '').toLowerCase();
        const crmItem = crmData.find(c => c.pool_id === p.pool_id || c.quote_id === p.pool_id);
        const st = (p.status || (crmItem ? crmItem.status : '') || '').toUpperCase();
        p._status = st || 'N/A';

        const isEligible = s.includes('weekly full service') || s.includes('startup');
        const isActive = st !== 'LOST' && st !== 'COMPLETED';
        return isEligible && isActive;
      });
      renderNewPoolsBanner();
    } else {
      _unassignedPools = [];
      const existing = document.getElementById('new-pools-banner');
      if (existing) existing.remove();
    }
  }).catch(() => { });
}

function renderNewPoolsBanner() {
  let banner = document.getElementById('new-pools-banner');
  if (!_unassignedPools || !_unassignedPools.length) {
    if (banner) banner.remove();
    return;
  }
  const html = `<div class="new-pools-banner" id="new-pools-banner">
    <div class="npb-header" onclick="document.getElementById('npb-body').classList.toggle('open')">
      <span class="npb-title">⚠️ ${_unassignedPools.length} new pool${_unassignedPools.length > 1 ? 's' : ''} need${_unassignedPools.length === 1 ? 's' : ''} routing</span>
      <span class="npb-count">▼</span>
    </div>
    <div class="npb-body" id="npb-body">
      ${_unassignedPools.map(p => `<div class="npb-pool">
        <div class="npb-pool-info">
          <div class="npb-pool-name">${p.customer_name || p.pool_id} <span style="font-size:0.7rem; color:var(--muted); font-weight:700; background:rgba(0,0,0,0.05); padding:1px 4px; border-radius:3px; margin-left:4px">${p._status}</span></div>
          <div class="npb-pool-addr">${p.address || ''}, ${p.city || ''}</div>
        </div>
        <button class="npb-place-btn" onclick="openPlacePool('${p.pool_id}')">Place ▸</button>
      </div>`).join('')}
      <button class="npb-auto-btn" onclick="autoPlaceAll()">⚡ Auto-place all new pools</button>
    </div>
  </div>`;
  if (!banner) {
    const content = document.getElementById('route-content');
    content.insertAdjacentHTML('afterbegin', html);
  } else {
    banner.outerHTML = html;
  }
}

function renderRoutePage() {
  if (!_routeData) return;

  // Admin op filter
  const opRow = document.getElementById('op-filter-row');
  if (isAdmin() && _routeData.all_operators && _routeData.all_operators.length > 1) {
    opRow.style.display = 'flex';
    opRow.innerHTML = '<button class="op-filter-btn' + ((_activeOp === 'all') ? ' active' : '') + '" onclick="switchOp(\'all\')">All</button>' +
      _routeData.all_operators.map(op => { const un = op.username || op, nm = (op.name || op); return `<button class="op-filter-btn${_activeOp === un ? ' active' : ''}" onclick="switchOp('${un}')">${nm.split(' ')[0]}</button>`; }).join('');
  } else {
    opRow.style.display = 'none';
  }

  const days = _extendStartupPools_(_routeData.days || []);

  // Normalize today: GAS may return "2026-04-14" (date) or "Monday" (day name)
  let today = _routeData.today || '';
  const _tp = parseDateStr_(today);
  if (_tp) today = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(_tp.y, _tp.m - 1, _tp.d).getDay()];

  // ── Week range header ──
  const wrh = document.getElementById('week-range-hdr');
  const label = document.getElementById('week-range-label');
  const badge = document.getElementById('week-this-week-badge');
  if (wrh && days.length) {
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const fpFirst = parseDateStr_(firstDay.date);
    const fpLast = parseDateStr_(lastDay.date);
    // Fall back: compute from week_start if individual dates are missing
    let fpFallbackFirst = null, fpFallbackLast = null;
    if ((!fpFirst || !fpLast) && _routeData.week_start) {
      const ws = parseDateStr_(_routeData.week_start);
      if (ws) {
        fpFallbackFirst = ws;
        const sat = new Date(ws.y, ws.m - 1, ws.d + 5);
        const pad = n => String(n).padStart(2, '0');
        fpFallbackLast = parseDateStr_(`${sat.getFullYear()}-${pad(sat.getMonth() + 1)}-${pad(sat.getDate())}`);
      }
    }
    const fp1 = fpFirst || fpFallbackFirst;
    const fp2 = fpLast || fpFallbackLast;
    if (fp1 && fp2) {
      const d1 = new Date(fp1.y, fp1.m - 1, fp1.d);
      const d2 = new Date(fp2.y, fp2.m - 1, fp2.d);
      const short = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const full = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      label.textContent = `Week of ${short(d1)} – ${full(d2)}`;
    }
    // "This Week" badge
    const nowDate = new Date(); nowDate.setHours(0, 0, 0, 0);
    const rangeStart = fp1 ? new Date(fp1.y, fp1.m - 1, fp1.d) : null;
    const rangeEnd = fp2 ? new Date(fp2.y, fp2.m - 1, fp2.d) : null;
    const isThisWeek = rangeStart && rangeEnd && nowDate >= rangeStart && nowDate <= rangeEnd;
    badge.style.display = isThisWeek ? 'inline-block' : 'none';
    wrh.style.display = 'flex';
    // Admin week nav buttons
    const prevBtn = document.getElementById('btn-prev-week');
    const nextBtn = document.getElementById('btn-next-week');
    if (prevBtn) prevBtn.style.display = isAdmin() ? 'inline-block' : 'none';
    if (nextBtn) nextBtn.style.display = isAdmin() ? 'inline-block' : 'none';
  }

  // ── Pool count summary ──
  const summaryEl = document.getElementById('week-pool-summary');
  if (summaryEl) {
    const totalPools = days.reduce((n, d) => n + (d.pools || []).length, 0);
    const operators = new Set(days.flatMap(d => (d.pools || []).map(p => p.operator).filter(Boolean)));
    summaryEl.textContent = `${totalPools} pool${totalPools !== 1 ? 's' : ''} this week${operators.size > 0 ? ' · ' + operators.size + ' operator' + (operators.size !== 1 ? 's' : '') : ''}`;
    summaryEl.style.display = 'block';
  }

  // ── Build day tabs (compact date: "Apr 14", weather chip placeholder) ──
  const tabsEl = document.getElementById('day-tabs');
  tabsEl.innerHTML = days.map(d => {
    const isToday = d.day === today;
    const count = (d.pools || []).filter(p => !p._startupDay || p._startupDay === 1).length;
    const locked = d.locked;
    const _dp = parseDateStr_(d.date);
    const _dObj = _dp ? new Date(_dp.y, _dp.m - 1, _dp.d) : dayDateFromWeekStart_(d.day);
    const dateStr = _dObj
      ? _dObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : d.day.slice(0, 3);
    return `<div class="day-tab${isToday ? ' today' : ''}${locked ? ' locked' : ''}" id="tab-${d.day}" onclick="selectDay('${d.day}')">
      <span class="dt-day">${d.day.slice(0, 3)}</span>
      <span class="dt-date">${dateStr}</span>
      <span class="dt-weather" id="dtw-${d.day}">--</span>
      <span class="dt-count">${count} pool${count !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('');

  // Auto-select today (or Monday if Sunday), then scroll into view
  const jsDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let autoDay = jsDays[new Date().getDay()];
  if (autoDay === 'Sunday') autoDay = 'Monday';
  // If viewing a different week, just select the first available day
  if (_weekOffset !== 0) autoDay = (days[0] || {}).day || 'Monday';

  _doSelectDay(autoDay); // bypass debounce for initial auto-select

  // Fetch weather after tabs are rendered
  fetchWeekWeather();
}

function switchOp(op) {
  _activeOp = op;
  _routeData = null;
  _clearRouteCache();
  loadRoutes(op);
}

function selectDay(dayName) {
  // Debounce: ignore rapid double-taps within 80ms
  if (_daySelectTimer) clearTimeout(_daySelectTimer);
  _daySelectTimer = setTimeout(() => { _daySelectTimer = null; _doSelectDay(dayName); }, 80);
}

function _doSelectDay(dayName) {
  _activeDay = dayName;

  // Update tab active state
  document.querySelectorAll('.day-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('tab-' + dayName);
  if (tab) {
    tab.classList.add('active');
    // Smooth-scroll the active tab into the center of the bar (mobile-friendly)
    tab.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' });
  }

  const dayData = (_routeData && _routeData.days || []).find(d => d.day === dayName);

  // Trigger fade-in animation on the day card
  const card = document.getElementById('route-day-card');
  if (card) { card.classList.remove('day-entering'); void card.offsetWidth; card.classList.add('day-entering'); }

  renderDayCard(dayData);
}

function renderDayCard(dayData) {
  const card = document.getElementById('route-day-card');
  if (!dayData) {
    card.innerHTML = '<div class="route-empty"><div class="route-empty-icon">📅</div><div class="route-empty-text">No data for this day.</div></div>';
    return;
  }

  const today = _routeData.today;
  const isToday = dayData.day === today;
  const locked = dayData.locked;
  const pools = dayData.pools || [];
  const _ddp = parseDateStr_(dayData.date);
  const _ddObj = _ddp ? new Date(_ddp.y, _ddp.m - 1, _ddp.d) : dayDateFromWeekStart_(dayData.day);
  const dateStr = _ddObj
    ? _ddObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : dayData.day;

  // Load done state from localStorage
  const doneKey = `mcps_done_${_routeData.week_start}_${dayData.day}`;
  const doneSet = new Set(JSON.parse(localStorage.getItem(doneKey) || '[]'));

  let html = '';

  // Weather for this day from cache
  const cacheKey = _routeData.week_start || '';
  const cachedWeekW = _getWeatherCache(cacheKey);
  const dayWeather = (cachedWeekW || {})[dayData.day];
  const weatherHtml = dayWeather ? `${dayWeather.icon} ${dayWeather.high}°/${dayWeather.low}°` : '';

  // Pre-compute progress for initial render (exclude ghost startup day 2/3)
  const realPools = pools.filter(p => !p._startupDay || p._startupDay === 1);
  const totalCount = realPools.length;
  const doneCount = realPools.filter((p, i) => doneSet.has(p.pool_id || String(i))).length;
  const progressPct = totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0;
  const allDone = totalCount > 0 && doneCount === totalCount;

  // Header
  html += `<div class="rdc-header${locked ? ' locked-day' : ''}">
    <div class="rdc-header-main">
      <div class="rdc-day-name">
        ${dateStr} <span class="rdc-weather-chip" id="rdc-w-${dayData.day}">${weatherHtml || '<i style="font-style:normal;opacity:.6">--°</i>'}</span>
      </div>
    </div>
    <div class="rdc-badges">
      ${isToday ? '<span class="rdc-badge today-badge">Today</span>' : ''}
      ${locked ? '<span class="rdc-badge locked">Locked 🔒</span>' : ''}
      ${totalCount > 0 ? `<span class="rdc-progress-badge${allDone ? ' all-done' : ''}" id="rdc-progress-badge">${doneCount}/${totalCount} Done</span>` : ''}
      ${isAdmin() ? '<button class="pin-all-btn" onclick="pinAllDay(\'' + dayData.day + '\')" title="Pin all pools on this day">📌 Pin All</button>' : ''}
    </div>
    <div class="rdc-progress-bar-wrap">
      <div class="rdc-progress-bar-fill${allDone ? ' all-done' : ''}" id="rdc-progress-bar-fill" style="width:${progressPct}%"></div>
    </div>
  </div>`;

  if (!pools.length) {
    html += '<div class="route-empty" style="padding:2.5rem 1rem"><div class="route-empty-icon">😎</div><div class="route-empty-text">No pools scheduled for this day. Enjoy the break!</div></div>';
    card.innerHTML = html;
    return;
  }

  // Locked notice
  if (locked) {
    html += `<div class="locked-notice">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Route locked — no changes will be made to today's schedule. See you next week!
    </div>`;
  }

  // Maps launch buttons
  const gmapsUrl = dayData.maps_url || '';
  const amapsUrl = gmapsUrl.replace('https://www.google.com/maps/dir/', 'https://maps.apple.com/?daddr=').replace(/\//g, '&daddr=');

  html += `<div class="maps-btn-row">
    <a class="maps-btn gmaps${!gmapsUrl ? ' disabled-btn' : ''}" href="${gmapsUrl}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      Google Maps Route
    </a>
    <a class="maps-btn amaps${!gmapsUrl ? ' disabled-btn' : ''}" href="${buildAppleMapsUrl_(pools)}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
      Apple Maps Route
    </a>
  </div>`;

  // Pool stop list
  html += '<div class="pool-stops">';
  pools.forEach((pool, idx) => {
    const pId = pool.pool_id || String(idx);
    const done = doneSet.has(pId);
    const svcClass = getSvcClass_(pool.service);
    const svcLabel = getSvcLabel_(pool.service);
    const isPinned = pool.pinned === true || pool.pinned === 'TRUE';
    const indivMaps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(pool.address + ', ' + pool.city + ', TX');
    const isStartupGhost = pool._startupDay > 1;
    // Admin tap: ghost startups open the action sheet on their origin day
    const actionDay = isStartupGhost ? pool._startupOriginDay : dayData.day;
    const adminTap = isAdmin() ? ` onclick="openPoolAction('${escHtml(pId)}','${escHtml(actionDay)}','${escHtml(pool.operator || '')}',${isPinned})"` : '';

    if (isStartupGhost) {
      // Ghost startup (Day 2 or 3) — show as continuation indicator, no done checkbox
      html += `
    <div class="pool-stop startup-ghost" id="stop-${idx}" style="${isAdmin() ? 'cursor:pointer;opacity:.72' : 'opacity:.72'}"${adminTap}>
      <div class="ps-num-col">
        <div class="ps-num" style="background:rgba(200,168,75,.25);color:#92400e">${idx + 1}</div>
      </div>
      <div class="ps-main-col">
        <div class="ps-title">${pool.customer_name || '—'}</div>
        <div class="ps-meta"><span>📍 ${pool.address}${pool.city ? ', ' + pool.city : ''}</span></div>
        <div class="ps-label-row">
          <span class="ps-label svc-startup">Startup Day ${pool._startupDay}/3</span>
          ${pool.operator && isAdmin() ? `<span class="ps-label svc-other">${pool.op_name || pool.operator}</span>` : ''}
        </div>
        <div class="ps-btns" onclick="event.stopPropagation()">
          <a href="${indivMaps}" target="_blank" rel="noopener" class="ps-btn map-mini-btn" title="Open Map">🗺️</a>
        </div>
      </div>
    </div>`;
      return;
    }

    // Formatted visit type label for scheduled visits
    let scheduledBadgeHtml = '';
    if (pool._is_scheduled_visit) {
      let badgeText = 'Scheduled Visit';
      if (pool._visit_type) {
        badgeText = pool._visit_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }
      // Different styling to distinguish from standard recurring routes
      scheduledBadgeHtml = `<span class="ps-label svc-startup" style="background:rgba(147, 51, 234, 0.15);color:#7e22ce">${badgeText}</span>`;
    }

    // Startup Day 1: add "Day 1/3" badge alongside service label
    const startupDayBadge = pool._startupDay === 1
      ? `<span class="ps-label svc-startup" style="font-size:.7rem">Day 1/3</span>`
      : '';

    html += `
    <div class="pool-stop${done ? ' ps-done' : ''}${pool.priority ? ' ps-priority' : ''}" id="stop-${idx}" style="${isAdmin() ? 'cursor:pointer' : ''}"${adminTap}>
      <div class="ps-num-col">
        <div class="ps-num">${idx + 1}</div>
        ${isPinned ? '<div class="ps-pin" title="Pinned Stop">📌</div>' : ''}
      </div>
      <div class="ps-main-col">
        <div class="ps-title">${pool.customer_name || '—'}</div>
        <div class="ps-meta">
          <span>📍 ${pool.address}${pool.city ? ', ' + pool.city : ''}</span>
        </div>
        <div class="ps-label-row">
          ${scheduledBadgeHtml ? scheduledBadgeHtml : `<span class="ps-label ${svcClass}">${svcLabel}</span>` + startupDayBadge}
          ${pool.operator && isAdmin() ? `<span class="ps-label svc-other">${pool.op_name || pool.operator}</span>` : ''}
          ${pool.priority ? `<span class="ps-label" style="background:#fee2e2;color:#ef4444">High Priority</span>` : ''}
        </div>
        ${pool.notes ? `<div class="stop-notes" style="font-size:.75rem;color:var(--muted);margin-top:.3rem;font-style:italic">📋 ${pool.notes}</div>` : ''}

        <div class="ps-btns" onclick="event.stopPropagation()">
          <button class="ps-btn ps-log" onclick="goToSvcLog('${escHtml(pId)}','${escHtml(pool.customer_name || '')}')">
            📝 Log Service
          </button>
          <button class="ps-btn ps-sms" data-pool-id="${escHtml(pId)}" data-cust-name="${escHtml(pool.customer_name || '')}" onclick="headsUp(event,this)" title="Send heads up SMS">
            📲 On My Way
          </button>
          <a class="ps-btn ps-nav" href="${indivMaps}" target="_blank" rel="noopener" title="Navigate to this pool"></a>
        </div>
      </div>
      <div class="ps-action-col" onclick="event.stopPropagation();toggleDoneInHub(this,${idx},'${escHtml(pId)}','${doneKey}')">
        <div class="ps-check">${done ? '✓' : ''}</div>
      </div>
    </div>`;
  });
  html += '</div>';

  // Expandable map panel
  html += `<button class="map-toggle-btn" id="map-toggle-btn" onclick="toggleMapPanel()">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
    Show on Map
  </button>
  <div class="map-panel" id="map-panel"><div id="leaflet-map"></div></div>`;

  card.innerHTML = html;

  // Init/update map
  initOrUpdateMap_(pools);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEATHER (Open-Meteo — free, no API key)
// ══════════════════════════════════════════════════════════════════════════════

// Default service area coords — update if needed; used when no pools have lat/lng
const SERVICE_LAT = 29.4235;
const SERVICE_LNG = -98.4850;

function wmoIcon(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '🌨️';
  if (code <= 82) return '🌧️';
  if (code <= 94) return '⛈️';
  return '⛈️';
}

// Parse a date value from GAS — handles "YYYY-MM-DD", ISO timestamps, and Date.toString()
function parseDateStr_(raw) {
  if (!raw) return null;
  const s = String(raw);
  const match = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return {
    y: +match[1], m: +match[2], d: +match[3],
    iso: `${match[1]}-${match[2]}-${match[3]}`
  };
}

function guessWeekStart_() {
  const d = new Date();
  const day = d.getDay();
  // Adjust to previous Monday
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d.getFullYear(), d.getMonth(), diff);
  const pad = n => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
}

// Compute a JS Date for a given weekday using week_start (guaranteed fallback)
// week_start is Monday; Mon=+0, Tue=+1, …, Sat=+5
const _DAY_OFFSET = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5 };
function dayDateFromWeekStart_(dayName) {
  let wsRaw = _routeData && _routeData.week_start;
  if (!wsRaw && _routeData && _routeData.days && _routeData.days[0]) wsRaw = _routeData.days[0].date;
  if (!wsRaw) wsRaw = guessWeekStart_();

  const ws = parseDateStr_(wsRaw);
  if (!ws) return null;
  const off = _DAY_OFFSET[dayName];
  if (off === undefined) return null;
  return new Date(ws.y, ws.m - 1, ws.d + off);
}

function fetchWeekWeather() {
  if (!_routeData) return;
  const days = _routeData.days || [];
  if (!days.length) return;

  const cacheKey = _routeData.week_start || (days[0] && days[0].date) || '';
  const cachedW = _getWeatherCache(cacheKey);
  if (cachedW) {
    injectWeatherChips(cachedW, days);
    return;
  }

  // Derive lat/lng from first pool with coordinates
  let lat = 0, lng = 0;
  for (const d of days) {
    for (const p of (d.pools || [])) {
      if (p.lat && p.lng && p.lat !== 0 && p.lng !== 0) { lat = p.lat; lng = p.lng; break; }
    }
    if (lat) break;
  }
  if (!lat) { lat = SERVICE_LAT; lng = SERVICE_LNG; }

  // Build ISO date range
  const toISO = dateObj => {
    if (!dateObj) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
  };

  const _dpStart = parseDateStr_(days[0].date);
  const _dpEnd = parseDateStr_(days[days.length - 1].date);

  // Ensure we get a full week coverage if needed
  const startISO = (_dpStart && _dpStart.iso) || toISO(dayDateFromWeekStart_('Monday'));
  const endISO = (_dpEnd && _dpEnd.iso) || toISO(dayDateFromWeekStart_('Saturday'));

  if (!startISO || !endISO) {
    console.warn('[weather] No date range available — skipping fetch');
    return;
  }
  console.log('[weather] Fetching', startISO, '→', endISO, 'lat:', lat, 'lng:', lng);

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${startISO}&end_date=${endISO}`;

  fetch(url)
    .then(r => r.json())
    .then(data => {
      if (!data.daily || !data.daily.time) { console.warn('[weather] No daily data in response', data); return; }
      const result = {};
      data.daily.time.forEach((dateStr, i) => {
        const p = parseDateStr_(dateStr);
        if (!p) return;
        const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(p.y, p.m - 1, p.d).getDay()];
        result[dayName] = {
          icon: wmoIcon(data.daily.weathercode[i]),
          high: Math.round(data.daily.temperature_2m_max[i]),
          low: Math.round(data.daily.temperature_2m_min[i]),
        };
      });
      _setWeatherCache(cacheKey, result);
      injectWeatherChips(result, days);

      // Update current card if it matches the fetched week
      if (_activeDay && result[_activeDay]) {
        renderDayCard(days.find(d => d.day === _activeDay));
      }
    })
    .catch(err => console.warn('[weather] Fetch failed:', err));
}

function injectWeatherChips(weatherMap, days) {
  const todayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];

  days.forEach(d => {
    const el = document.getElementById('dtw-' + d.day);
    if (!el) return;
    const w = weatherMap[d.day];
    if (w) {
      el.textContent = `${w.icon} ${w.high}°`;
      el.title = `${w.high}° / ${w.low}°`;

      // Update Header Chip if present
      const headerChip = document.getElementById('rdc-w-' + d.day);
      if (headerChip) headerChip.textContent = `${w.icon} ${w.high}°/${w.low}°`;

      // Update Hub Hero if this is "Today"
      if (d.day === todayName) {
        const heroWrap = document.getElementById('hub-hero-weather');
        const heroTemp = document.getElementById('hhw-temp');
        const heroCond = document.getElementById('hhw-cond');
        if (heroWrap && heroTemp && heroCond) {
          heroWrap.style.display = 'block';
          heroTemp.textContent = `${w.high}°`;
          heroCond.textContent = `Today: ${w.icon}`;
        }
      }
    } else {
      el.textContent = '--';
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MY OPERATOR PROFILE TAB
// ══════════════════════════════════════════════════════════════════════════════

function renderProfileTab() {
  // Determine whose profile to show
  if (!_profileOp) _profileOp = _s.username;

  // Admin: show team availability grid at top, hide old selector pills
  const selEl = document.getElementById('profile-op-selector');
  if (selEl) selEl.style.display = 'none'; // pills replaced by grid row clicks

  const gridWrap = document.getElementById('profile-avail-grid-wrap');
  if (gridWrap) gridWrap.style.display = isAdmin() ? 'block' : 'none';
  if (isAdmin()) renderAvailabilityGrid();

  // Look up profile data from users cache (admins have it), otherwise use session
  let user = _usersCache.find(u => u.username === _profileOp);
  if (!user && _profileOp === _s.username) {
    user = { name: _s.name, username: _s.username, roles: _s.roles };
  }
  if (!user) {
    document.getElementById('profile-name').textContent = _profileOp || 'Loading…';
    document.getElementById('profile-meta').textContent = '';
    renderShiftRows({});
    return;
  }

  // Avatar initials/photo
  const initials = (user.name || user.username || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const initialsEl = document.getElementById('profile-initials');
  const imgEl = document.getElementById('profile-img');
  const avatarUrl = user.avatar_url || localStorage.getItem('mcps_avatar_' + user.username);

  if (avatarUrl && initialsEl && imgEl) {
    imgEl.src = avatarUrl;
    imgEl.style.display = 'block';
    initialsEl.style.display = 'none';
  } else if (initialsEl && imgEl) {
    imgEl.style.display = 'none';
    initialsEl.style.display = 'block';
    initialsEl.textContent = initials;
  }

  // Name + meta
  document.getElementById('profile-name').textContent = user.name || user.username;
  const roles = Array.isArray(user.roles) ? user.roles : String(user.roles || '').split(',').map(r => r.trim()).filter(Boolean);
  document.getElementById('profile-meta').textContent = `@${user.username}${roles.length ? ' · ' + roles.map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(', ') : ''}`;

  // Admin: show "Editing: <name>" label above the form
  const editingLabel = document.getElementById('profile-editing-label');
  if (editingLabel) {
    if (isAdmin()) {
      editingLabel.textContent = `Editing: ${user.name || user.username}`;
      editingLabel.style.display = 'block';
    } else {
      editingLabel.style.display = 'none';
    }
  }

  // Parse shift_preferences
  let prefs = {};
  if (user.shift_preferences) {
    try { prefs = JSON.parse(user.shift_preferences); } catch (e) { prefs = {}; }
  }
  renderShiftRows(prefs);
}

function switchProfileOp(op) {
  _profileOp = op;
  renderProfileTab();
  // Scroll the edit form into view so admin sees it after clicking a grid row
  const hdr = document.getElementById('profile-editing-label');
  if (hdr) hdr.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderShiftRows(prefs) {
  const container = document.getElementById('avail-shift-rows');
  if (!container) return;
  container.innerHTML = ALL_DAYS.map(day => {
    const val = prefs[day] || null; // 'am', 'pm', 'full', or null
    const unavailable = !val;
    return `<div class="avail-row${unavailable ? ' avail-unavailable' : ''}" id="avail-row-${day}">
      <div class="avail-day-label">${day}</div>
      <div class="avail-shifts">
        <button class="shift-btn${val === 'am' ? ' active' : ''}" data-day="${day}" data-shift="am" onclick="toggleShift(this)">AM</button>
        <button class="shift-btn${val === 'pm' ? ' active' : ''}" data-day="${day}" data-shift="pm" onclick="toggleShift(this)">PM</button>
        <button class="shift-btn${val === 'full' ? ' active' : ''}" data-day="${day}" data-shift="full" onclick="toggleShift(this)">Full Day</button>
      </div>
    </div>`;
  }).join('');
}

function toggleShift(btn) {
  const day = btn.dataset.day;
  const shift = btn.dataset.shift;
  const row = document.getElementById('avail-row-' + day);
  const allBtns = row.querySelectorAll('.shift-btn');

  if (shift === 'full') {
    // Full Day: deselect AM/PM, toggle full
    const isActive = btn.classList.contains('active');
    allBtns.forEach(b => b.classList.remove('active'));
    if (!isActive) btn.classList.add('active');
  } else {
    // AM or PM: deselect Full Day, toggle this one
    const fullBtn = row.querySelector('[data-shift="full"]');
    if (fullBtn) fullBtn.classList.remove('active');
    btn.classList.toggle('active');
  }

  // Update row dimming
  const anyActive = Array.from(allBtns).some(b => b.classList.contains('active'));
  row.classList.toggle('avail-unavailable', !anyActive);
}

function saveAvailability() {
  const targetUsername = _profileOp || _s.username;
  const btn = document.querySelector('.avail-save-btn');
  const msgEl = document.getElementById('avail-msg');

  // Build prefs object from current UI state
  const prefs = {};
  ALL_DAYS.forEach(day => {
    const row = document.getElementById('avail-row-' + day);
    if (!row) return;
    const active = row.querySelector('.shift-btn.active');
    prefs[day] = active ? active.dataset.shift : null;
  });

  // On-leave guard: all days null
  const hasDays = Object.values(prefs).some(v => v !== null);
  if (!hasDays) {
    if (!confirm('You have no days selected — this will mark you as completely unavailable for routing. Continue?')) return;
  }

  // Derive available_days from prefs (non-null days)
  const availDays = ALL_DAYS.filter(d => prefs[d] !== null).join(',');

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  msgEl.style.display = 'none';

  api({
    secret: SEC, action: 'update_user', token: _s.token,
    username: targetUsername,
    fields: {
      shift_preferences: JSON.stringify(prefs),
      available_days: availDays,
    }
  }).then(res => {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Availability'; }
    if (res.ok) {
      // Update local cache
      const cached = _usersCache.find(u => u.username === targetUsername);
      if (cached) { cached.shift_preferences = JSON.stringify(prefs); cached.available_days = availDays; }
      msgEl.className = 'im success';
      msgEl.textContent = '✓ Availability saved.';
    } else {
      msgEl.className = 'im error';
      msgEl.textContent = 'Error: ' + (res.error || 'Could not save.');
    }
    msgEl.style.display = 'block';
    setTimeout(() => { msgEl.style.display = 'none'; }, 4000);
  }).catch(e => {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Availability'; }
    msgEl.className = 'im error';
    msgEl.textContent = 'Network error: ' + e.message;
    msgEl.style.display = 'block';
  });
}

function toggleMapPanel() {
  const panel = document.getElementById('map-panel');
  const btn = document.getElementById('map-toggle-btn');
  const open = panel.classList.toggle('open');
  btn.textContent = open ? '▲ Hide Map' : '▼ Show on Map';
  if (open && _leafMap) setTimeout(() => _leafMap.invalidateSize(), 50);
}

function initOrUpdateMap_(pools) {
  // Defer until panel is opened
  const valid = pools.filter(p => p.lat && p.lng && p.lat !== 0 && p.lng !== 0);
  if (!valid.length) return;

  // We reinitialize when the day changes
  if (_leafMap) { _leafMap.remove(); _leafMap = null; _mapMarkers = []; }

  setTimeout(() => {
    const el = document.getElementById('leaflet-map');
    if (!el) return;
    _leafMap = L.map(el, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(_leafMap);

    const bounds = [];
    valid.forEach((pool, i) => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:26px;height:26px;border-radius:50%;background:var(--teal);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-size:13px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25)">${i + 1}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
      const m = L.marker([pool.lat, pool.lng], { icon }).addTo(_leafMap)
        .bindPopup(`<b>${pool.customer_name}</b><br>${pool.address}<br><small>${pool.service}</small>`);
      _mapMarkers.push(m);
      bounds.push([pool.lat, pool.lng]);
    });
    if (bounds.length) _leafMap.fitBounds(bounds, { padding: [20, 20] });
  }, 100);
}

function toggleDone(cb, idx, poolId, doneKey) {
  const row = document.getElementById('stop-' + idx);
  const done = JSON.parse(localStorage.getItem(doneKey) || '[]');
  if (cb.checked) { if (!done.includes(poolId)) done.push(poolId); }
  else { const i = done.indexOf(poolId); if (i !== -1) done.splice(i, 1); }
  localStorage.setItem(doneKey, JSON.stringify(done));
  if (row) row.classList.toggle('done-stop', cb.checked);
}

function toggleDoneInHub(actionCol, idx, poolId, doneKey) {
  const row = document.getElementById('stop-' + idx);
  const checkEl = actionCol.querySelector('.ps-check');

  // 1. Read current state from DOM — no localStorage read needed
  const isDone = row ? row.classList.contains('ps-done') : false;
  const nowDone = !isDone;

  // 2. Apply visual change to DOM IMMEDIATELY (optimistic)
  if (row) row.classList.toggle('ps-done', nowDone);
  if (checkEl) checkEl.textContent = nowDone ? '✓' : '';

  // 3. Update progress counter immediately from DOM
  _updateProgressCounter();

  // 4. Persist to localStorage
  try {
    const done = JSON.parse(localStorage.getItem(doneKey) || '[]');
    if (nowDone) { if (!done.includes(poolId)) done.push(poolId); }
    else { const i = done.indexOf(poolId); if (i !== -1) done.splice(i, 1); }
    localStorage.setItem(doneKey, JSON.stringify(done));
  } catch (e) { }
}

function _updateProgressCounter() {
  const allStops = document.querySelectorAll('#route-day-card .pool-stop:not(.startup-ghost)');
  const doneStops = document.querySelectorAll('#route-day-card .pool-stop.ps-done:not(.startup-ghost)');
  const total = allStops.length;
  const done = doneStops.length;
  const allDone = total > 0 && done === total;

  const badge = document.getElementById('rdc-progress-badge');
  const bar = document.getElementById('rdc-progress-bar-fill');
  if (badge) {
    badge.textContent = `${done}/${total} Done`;
    badge.classList.toggle('all-done', allDone);
  }
  if (bar) {
    bar.style.width = (total > 0 ? Math.round(done / total * 100) : 0) + '%';
    bar.classList.toggle('all-done', allDone);
  }
}

function buildAppleMapsUrl_(pools) {
  if (!pools.length) return '#';
  const last = pools[pools.length - 1];
  const dest = encodeURIComponent(last.address + ', ' + last.city + ', TX');
  if (pools.length === 1) return 'https://maps.apple.com/?daddr=' + dest;
  // Apple Maps doesn't support true multi-stop — deep link to last destination
  return 'https://maps.apple.com/?daddr=' + dest + '&dirflg=d';
}

function getSvcClass_(svc) {
  const s = (svc || '').toLowerCase();
  if (s.includes('bi-weekly') || s.includes('biweekly')) return 'svc-biweekly'; // must be before 'weekly'
  if (s.includes('weekly')) return 'svc-weekly';
  if (s.includes('startup')) return 'svc-startup';
  if (s.includes('monthly')) return 'svc-monthly';
  if (s.includes('green') || s.includes('clean')) return 'svc-gtc';
  return 'svc-other';
}
function getSvcLabel_(svc) {
  const s = (svc || '').toLowerCase();
  if (s.includes('weekly full')) return 'Weekly';
  if (s.includes('bi-weekly') || s.includes('biweekly')) return 'Bi-Weekly';
  if (s.includes('startup')) return 'Startup';
  if (s.includes('monthly')) return 'Monthly';
  if (s.includes('green')) return 'Green-to-Clean';
  return svc || 'Service';
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE MANAGEMENT (Admin portal controls)
// ══════════════════════════════════════════════════════════════════════════════

function openPoolAction(poolId, day, operator, pinned) {
  if (!isAdmin()) return;
  const pool = findPool_(poolId);
  const isStartup = !!(pool && (pool.service || '').toLowerCase().includes('startup'));
  _pasState = { pool_id: poolId, day, operator, pinned, newDay: day, newOp: operator, newPinned: pinned, isStartup, scope: 'permanent' };
  // Fill title
  document.getElementById('pas-title').textContent = pool ? pool.customer_name : poolId;
  document.getElementById('pas-sub').textContent = pool ? `${pool.address}, ${pool.city} · ${pool.service}` : '';
  // Day grid
  const dayGrid = document.getElementById('pas-day-grid');
  dayGrid.innerHTML = ALL_DAYS.map(d =>
    `<button class="pas-day-btn${d === day ? ' active' : ''}" onclick="pasSelectDay(this,'${d}')">${d.slice(0, 3)}</button>`
  ).join('');
  // Operator select
  const opSel = document.getElementById('pas-op-select');
  const ops = _routeData && _routeData.all_operators ? _routeData.all_operators : [];
  opSel.innerHTML = ops.map(op => { const un = op.username || op, nm = op.name || op; return `<option value="${un}"${un === operator ? ' selected' : ''}>${nm}</option>`; }).join('');
  // Pin toggle
  updatePasPin_(pinned);
  // Scope toggle: reset to permanent
  pasSetScope('permanent');
  // Startup span preview
  _updateStartupSpanPreview_();
  // Startup actions section
  const startupActionsEl = document.getElementById('pas-startup-actions');
  if (startupActionsEl) startupActionsEl.style.display = isStartup ? 'block' : 'none';
  // Show
  document.getElementById('pas-backdrop').classList.add('open');
  document.getElementById('pas-sheet').classList.add('open');
}

function closePoolAction() {
  document.getElementById('pas-backdrop').classList.remove('open');
  document.getElementById('pas-sheet').classList.remove('open');
  _pasState = null;
  _updateStartupSpanPreview_();
  const startupActionsEl = document.getElementById('pas-startup-actions');
  if (startupActionsEl) startupActionsEl.style.display = 'none';
  // Reset convert day picker to initial state
  const convertBtn = document.getElementById('pas-convert-btn');
  const picker = document.getElementById('pas-convert-day-picker');
  if (convertBtn) convertBtn.style.display = '';
  if (picker) picker.style.display = 'none';
  pasSetScope('permanent'); // reset scope toggle for next open
}

function pasSelectDay(btn, day) {
  document.querySelectorAll('.pas-day-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (_pasState) { _pasState.newDay = day; _updateStartupSpanPreview_(); }
}

function togglePasPin() {
  if (!_pasState) return;
  _pasState.newPinned = !_pasState.newPinned;
  updatePasPin_(_pasState.newPinned);
}

function updatePasPin_(pinned) {
  const toggle = document.getElementById('pas-pin-toggle');
  const icon = document.getElementById('pas-pin-icon');
  const text = document.getElementById('pas-pin-text');
  toggle.classList.toggle('pinned', pinned);
  icon.textContent = pinned ? '📌' : '○';
  text.textContent = pinned ? 'Pinned — won\'t be moved by auto-placement' : 'Unpinned — can be auto-reassigned';
}

function applyPoolAction() {
  if (!_pasState) return;
  const btn = document.getElementById('pas-apply-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  _pasState.newOp = document.getElementById('pas-op-select').value;

  if (_pasState.scope === 'week') {
    // ── This week only: remap the day in Weekly_Overrides, no permanent change ──
    api({
      secret: SEC, action: 'move_pool_week', token: _s.token,
      pool_id: _pasState.pool_id,
      new_day: _pasState.newDay,
      week_start: _routeData && _routeData.week_start
    }).then(res => {
      btn.disabled = false; btn.textContent = 'Apply Changes';
      if (res.ok) { closePoolAction(); _routeData = null; _clearRouteCache(); loadRoutes(); }
      else alert('Error: ' + (res.error || 'Unknown'));
    }).catch(e => {
      btn.disabled = false; btn.textContent = 'Apply Changes';
      alert('Network error: ' + e.message);
    });
  } else {
    // ── Permanent: update Routes sheet ──
    const payload = {
      secret: SEC, action: 'move_pool', token: _s.token,
      pool_id: _pasState.pool_id,
      new_day: _pasState.newDay,
      new_operator: _pasState.newOp,
      pinned: _pasState.newPinned
    };
    // For startup permanent moves, send the start date so GAS can filter by week
    if (_pasState.isStartup) {
      const startupDate = _pasState.startup_start_date || _dateForDay_(_pasState.newDay);
      if (startupDate) payload.startup_start_date = startupDate;
    }
    api(payload).then(res => {
      btn.disabled = false; btn.textContent = 'Apply Changes';
      if (res.ok) { closePoolAction(); _routeData = null; _clearRouteCache(); loadRoutes(); }
      else alert('Error: ' + (res.error || 'Unknown'));
    }).catch(e => {
      btn.disabled = false; btn.textContent = 'Apply Changes';
      alert('Network error: ' + e.message);
    });
  }
}

function pinAllDay(day) {
  if (!isAdmin() || !confirm('Pin all pools on ' + day + '?')) return;
  api({
    secret: SEC, action: 'pin_day', token: _s.token, day: day, pinned: true
  }).then(res => {
    if (res.ok) { _routeData = null; loadRoutes(); }
    else alert('Error: ' + (res.error || 'Unknown'));
  }).catch(e => alert('Network error: ' + e.message));
}

function autoPlaceAll() {
  if (!isAdmin() || !confirm('Auto-place all new pools using the route algorithm?')) return;
  const btn = document.querySelector('.npb-auto-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
  api({
    secret: SEC, action: 'recalculate_new', token: _s.token
  }).then(res => {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Auto-place all new pools'; }
    if (res.ok) {
      _routeData = null;
      _unassignedPools = null;
      loadRoutes();
    } else {
      alert('Error: ' + (res.error || 'Unknown'));
    }
  }).catch(e => {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Auto-place all new pools'; }
    alert('Network error: ' + e.message);
  });
}

function openPlacePool(poolId) {
  // Open pool action sheet in "place" mode for an unassigned pool
  const pool = _unassignedPools ? _unassignedPools.find(p => p.pool_id === poolId) : null;
  const isStartup = !!(pool && (pool.service || '').toLowerCase().includes('startup'));
  _pasState = { pool_id: poolId, day: 'Monday', operator: '', pinned: true, newDay: 'Monday', newOp: '', newPinned: true, isStartup, startup_start_date: pool ? pool.startup_start_date : null, isUnassigned: true };
  document.getElementById('pas-title').textContent = pool ? pool.customer_name : poolId;
  document.getElementById('pas-sub').textContent = pool ? `${pool.address || ''}, ${pool.city || ''} · ${pool.service || ''}` : 'New pool — choose a day and operator';
  const dayGrid = document.getElementById('pas-day-grid');
  dayGrid.innerHTML = ALL_DAYS.map(d =>
    `<button class="pas-day-btn${d === 'Monday' ? ' active' : ''}" onclick="pasSelectDay(this,'${d}')">${d.slice(0, 3)}</button>`
  ).join('');
  const opSel = document.getElementById('pas-op-select');
  const ops = _routeData && _routeData.all_operators ? _routeData.all_operators : [];
  opSel.innerHTML = ops.map((op, i) => { const un = op.username || op, nm = op.name || op; return `<option value="${un}"${i === 0 ? ' selected' : ''}>${nm}</option>`; }).join('');
  updatePasPin_(true);
  pasSetScope('permanent');
  _updateStartupSpanPreview_();
  const startupActionsEl = document.getElementById('pas-startup-actions');
  if (startupActionsEl) startupActionsEl.style.display = 'none'; // Unassigned startups shouldn't show actions
  document.getElementById('pas-backdrop').classList.add('open');
  document.getElementById('pas-sheet').classList.add('open');
}

function findPool_(poolId) {
  if (!_routeData || !_routeData.days) return null;
  for (const d of _routeData.days) {
    const p = (d.pools || []).find(p => p.pool_id === poolId);
    if (p) return p;
  }
  return null;
}

// Compute the calendar date (yyyy-MM-dd) of a given weekday in the currently-viewed week
function _dateForDay_(dayName) {
  const ws = _routeData && _routeData.week_start;
  if (!ws) return null;
  const p = parseDateStr_(ws);
  if (!p) return null;
  const off = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5 };
  const o = off[dayName];
  if (o === undefined) return null;
  const d = new Date(p.y, p.m - 1, p.d + o);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Pool action sheet scope toggle ──────────────────────────────────────────
function pasSetScope(scope) {
  if (!_pasState) return;
  _pasState.scope = scope;
  const permBtn = document.getElementById('pas-scope-perm');
  const weekBtn = document.getElementById('pas-scope-week');
  const opSec = document.getElementById('pas-op-section');
  const pinSec = document.getElementById('pas-pin-section');
  const teal = getComputedStyle(document.documentElement).getPropertyValue('--teal').trim() || '#0d4d44';

  if (permBtn) {
    permBtn.style.background = scope === 'permanent' ? 'var(--teal)' : 'transparent';
    permBtn.style.color = scope === 'permanent' ? '#fff' : 'var(--text)';
    permBtn.style.borderColor = scope === 'permanent' ? 'var(--teal)' : 'var(--border)';
  }
  if (weekBtn) {
    weekBtn.style.background = scope === 'week' ? 'var(--teal)' : 'transparent';
    weekBtn.style.color = scope === 'week' ? '#fff' : 'var(--text)';
    weekBtn.style.borderColor = scope === 'week' ? 'var(--teal)' : 'var(--border)';
  }
  // Operator & pin only apply to permanent changes
  if (opSec) opSec.style.opacity = scope === 'week' ? '.4' : '1';
  if (pinSec) pinSec.style.opacity = scope === 'week' ? '.4' : '1';
}

// ── Startup: convert to Weekly Full Service — step 1: show day picker ────────
function convertStartupToWeeklyService(evt) {
  if (evt) evt.stopPropagation();
  if (!_pasState) return;

  // Show the day picker, hide the convert button
  const convertBtn = document.getElementById('pas-convert-btn');
  const picker = document.getElementById('pas-convert-day-picker');
  const grid = document.getElementById('pas-convert-day-grid');
  if (!picker || !grid) return;

  // Pre-select the pool's current day if available
  const currentDay = _pasState.day || null;
  grid.innerHTML = ALL_DAYS.slice(0, 6).map(d =>
    `<button onclick="pasSelectConvertDay(this,'${d}')"
      style="padding:.3rem .55rem;border-radius:5px;border:1.5px solid var(--border);background:${d === currentDay ? 'var(--teal)' : 'transparent'};color:${d === currentDay ? '#fff' : 'var(--text)'};font-size:.78rem;font-weight:600;cursor:pointer"
      data-day="${d}"${d === currentDay ? ' class="active"' : ''}>${d.slice(0, 3)}</button>`
  ).join('');
  _pasState._convertDay = currentDay || null;

  if (convertBtn) convertBtn.style.display = 'none';
  picker.style.display = 'flex';
}

// First month toggle inside the convert picker
function pasToggleFirstMonth() {
  if (!_pasState) return;
  _pasState._firstMonth = !_pasState._firstMonth;
  const track = document.getElementById('pas-fm-toggle');
  const knob = document.getElementById('pas-fm-knob');
  if (track) track.style.background = _pasState._firstMonth ? 'var(--teal)' : '#ccc';
  if (knob) knob.style.left = _pasState._firstMonth ? '16px' : '2px';
}

// Day selection inside the convert picker
function pasSelectConvertDay(btn, day) {
  document.querySelectorAll('#pas-convert-day-grid button').forEach(b => {
    b.style.background = 'transparent';
    b.style.color = 'var(--text)';
  });
  btn.style.background = 'var(--teal)';
  btn.style.color = '#fff';
  if (_pasState) _pasState._convertDay = day;
}

/// ── Startup: convert — step 2: send confirmed request ────────────────────────
function confirmConvertToWeekly() {
  if (!_pasState) return;
  const newDay = _pasState._convertDay;
  if (!newDay) { alert('Please select the weekly service day first.'); return; }

  const confirmBtn = document.getElementById('pas-convert-confirm-btn');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Converting…'; }

  api({
    secret: SEC, action: 'convert_startup_to_weekly', token: _s.token,
    pool_id: _pasState.pool_id, new_day: newDay, first_month: !!_pasState._firstMonth
  })
    .then(res => {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm'; }
      if (res.ok) { closePoolAction(); _routeData = null; loadRoutes(); }
      else alert('Error: ' + (res.error || 'Unknown'));
    })
    .catch(e => {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm'; }
      alert('Network error: ' + e.message);
    });
}

/// ── Startup: cancel convert picker ───────────────────────────────────────────
function cancelConvertToWeekly() {
  const convertBtn = document.getElementById('pas-convert-btn');
  const picker = document.getElementById('pas-convert-day-picker');
  if (convertBtn) convertBtn.style.display = '';
  if (picker) picker.style.display = 'none';
  if (_pasState) { _pasState._convertDay = null; _pasState._firstMonth = false; }
  // Reset toggle visual
  const track = document.getElementById('pas-fm-toggle');
  const knob = document.getElementById('pas-fm-knob');
  if (track) track.style.background = '#ccc';
  if (knob) knob.style.left = '2px';
}

// ── Startup: mark complete (stop showing in schedule) ───────────────────────
function markStartupDone(evt) {
  if (evt) evt.stopPropagation();
  if (!_pasState) return;
  if (!confirm('Mark this startup as complete?\n\nThe pool will be removed from the schedule. Use "Convert to Weekly" if they\'re becoming a regular customer.')) return;
  const btn = evt && evt.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  api({ secret: SEC, action: 'mark_startup_complete', token: _s.token, pool_id: _pasState.pool_id })
    .then(res => {
      if (btn) { btn.disabled = false; btn.textContent = '✗ Startup complete — remove from schedule'; }
      if (res.ok) { closePoolAction(); _routeData = null; loadRoutes(); }
      else alert('Error: ' + (res.error || 'Unknown'));
    })
    .catch(e => {
      if (btn) { btn.disabled = false; btn.textContent = '✗ Startup complete — remove from schedule'; }
      alert('Network error: ' + e.message);
    });
}


// ── Profile Photo Upload ──────────────────────────────────────────────────────
function triggerProfilePhotoUpload() {
  // Only allow editing own profile unless admin
  if (_profileOp !== _s.username && !isAdmin()) return;
  document.getElementById('profile-photo-input').click();
}

function handleProfilePhotoSelect(input) {
  const file = input.files[0];
  if (!file) return;
  
  // Max 2MB for profile photo
  if (file.size > 2 * 1024 * 1024) {
    alert('Photo is too large (max 2MB).');
    input.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;
    
    // Update UI immediately
    const imgEl = document.getElementById('profile-img');
    const initialsEl = document.getElementById('profile-initials');
    if (imgEl && initialsEl) {
      imgEl.src = base64;
      imgEl.style.display = 'block';
      initialsEl.style.display = 'none';
    }

    // Persist locally for "personal use" first as requested
    localStorage.setItem('mcps_avatar_' + _profileOp, base64);
    if (_profileOp === _s.username && typeof updateSidebarAvatar === 'function') {
      updateSidebarAvatar();
    }

    // Also attempt to save to backend if configured
    api({
      secret: SEC, action: 'update_user', token: _s.token,
      username: _profileOp,
      fields: { avatar_base64: base64 }
    }).then(res => {
      if (!res.ok) console.warn('Backend avatar save failed:', res.error);
    }).catch(err => console.error('Network error saving avatar:', err));
  };
  reader.readAsDataURL(file);
}
