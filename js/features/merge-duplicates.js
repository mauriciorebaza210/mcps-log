// Duplicate Customers — staff review for one-person-per-person cleanup.
let _mdGroups = null;
let _mdBusy = false;

function mdReasonLabel(r) {
  const map = {
    same_email: 'Same email',
    same_phone: 'Same phone',
    same_name_and_address: 'Same name + address'
  };
  return map[r] || String(r || '').replace(/_/g, ' ');
}

function loadMergeDuplicates(force) {
  const body = document.getElementById('md-body');
  if (!body || _mdBusy) return;
  if (!_mdGroups || force) body.innerHTML = '<div class="sa-empty">Scanning customers…</div>';
  api({ action: 'find_duplicate_people', token: _s ? _s.token : '', limit: 50 })
    .then(res => {
      if (!res || !res.ok) {
        body.innerHTML = `<div class="im err" style="display:block">${escHtml((res && res.error) || 'Could not scan duplicate customers.')}</div>`;
        return;
      }
      _mdGroups = res.groups || [];
      mdRender();
    })
    .catch(() => {
      body.innerHTML = '<div class="im err" style="display:block">Network error scanning duplicate customers.</div>';
    });
}

function mdRender() {
  const body = document.getElementById('md-body');
  if (!body) return;
  const groups = _mdGroups || [];
  if (!groups.length) {
    body.innerHTML = '<div class="sa-alert ok">No obvious duplicate customers found.</div>';
    return;
  }
  body.innerHTML = `
    <div class="sa-alert">
      Review before merging. A merge keeps the survivor, moves linked records, and marks the duplicate client as merged.
    </div>
    ${groups.map((g, i) => mdGroupHtml(g, i)).join('')}`;
}

function mdGroupHtml(g, idx) {
  const reasons = (g.reasons || [g.reason]).filter(Boolean).map(mdReasonLabel).join(' · ');
  return `<div class="sa-group">
    <div class="sa-group-h">${escHtml(reasons || 'Possible duplicate')}
      <span class="sa-group-sub">${escHtml(g.key || '')}</span>
    </div>
    ${(g.clients || []).map(c => mdClientHtml(c, idx)).join('')}
  </div>`;
}

function mdClientHtml(c, groupIdx) {
  const name = c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.client_id;
  const locs = (c.locations || []).slice(0, 3).map(l =>
    `${l.service_address || ''}${l.city ? ', ' + l.city : ''}${l.zip_code ? ' ' + l.zip_code : ''}`.trim()
  ).filter(Boolean);
  return `<div class="sa-row">
    <div class="sa-main">
      <div class="sa-name">${escHtml(name)} <span class="sa-tag">${escHtml(c.client_id)}</span></div>
      <div class="sa-meta">
        <span>${escHtml(c.email || 'no email')}</span>
        <span>${escHtml(c.phone || 'no phone')}</span>
        <span>${Number(c.location_count || 0)} propert${Number(c.location_count || 0) === 1 ? 'y' : 'ies'}</span>
        ${c.status ? `<span>${escHtml(c.status)}</span>` : ''}
      </div>
      ${locs.length ? `<div class="sa-zips">${locs.map(escHtml).join(' · ')}</div>` : ''}
    </div>
    <div class="sa-actions">
      <button class="sa-btn sa-primary" onclick="mdMergeGroup(${groupIdx}, ${jsArg(c.client_id)})">Keep this</button>
    </div>
  </div>`;
}

async function mdMergeGroup(groupIdx, survivorId) {
  if (_mdBusy) return;
  const g = (_mdGroups || [])[groupIdx];
  if (!g) return;
  const duplicates = (g.clients || []).map(c => c.client_id).filter(id => id && id !== survivorId);
  if (!duplicates.length) return;
  const survivor = (g.clients || []).find(c => c.client_id === survivorId);
  const label = survivor ? (survivor.display_name || survivor.client_id) : survivorId;
  if (!confirm(`Keep "${label}" and merge ${duplicates.length} duplicate customer${duplicates.length === 1 ? '' : 's'} into it?`)) return;

  const body = document.getElementById('md-body');
  _mdBusy = true;
  if (body) body.innerHTML = '<div class="sa-empty">Merging duplicate customers…</div>';
  try {
    for (const duplicateId of duplicates) {
      const res = await api({
        action: 'merge_clients',
        token: _s ? _s.token : '',
        survivor_client_id: survivorId,
        duplicate_client_id: duplicateId,
        merged_by: (_s && (_s.name || _s.username)) || 'portal',
        reason: (g.reasons || [g.reason]).filter(Boolean).join(',')
      });
      if (!res || !res.ok) throw new Error((res && res.error) || `Could not merge ${duplicateId}.`);
    }
    _mdGroups = null;
    loadMergeDuplicates(true);
  } catch (e) {
    if (body) body.innerHTML = `<div class="im err" style="display:block">${escHtml(e.message || 'Merge failed.')}</div>`;
  } finally {
    _mdBusy = false;
  }
}
