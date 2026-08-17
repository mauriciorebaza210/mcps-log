// ══════════════════════════════════════════════════════════════════════════════
// ACTION QUEUE — one inbox for everything needing a human decision
//
// Depends on: constants.js (SEC), api.js (api), auth.js (_s), app.js (_appCache*)
//
// Surfaces five event types, four of which previously had nowhere to appear:
//   recovery  a customer whose link lapsed asked for a new quote (was a dead end)
//   start     a customer's requested start date, awaiting confirmation
//   change    a customer asked for a change before signing  (was a dead end)
//   expiring  a quote about to lapse, or already expired    (was a dead end)
//   exception scheduler/assignment problems that need staff cleanup
//
// Cards mostly route to the feature that owns the record. This file mutates only
// the queue-owned resolutions: confirming a start date and resolving an exception.
// ══════════════════════════════════════════════════════════════════════════════

let _aqItems = [];
let _aqFilter = 'all';
let _aqLoading = false;
let _aqExceptionError = '';
const AQ_BADGE_BOOT_CACHE_TTL = 2 * 60 * 1000;

function loadActionQueue(force) {
  const list = document.getElementById('aq-list');
  if (!list) return;

  // Paint from cache first so the page never opens blank, then refresh behind.
  if (!force && typeof _appCacheGet === 'function') {
    const cached = _appCacheGet('action_queue', 5 * 60 * 1000);
    if (cached && Array.isArray(cached.items)) {
      _aqItems = cached.items;
      renderActionQueue();
    }
  }
  if (_aqLoading) return;
  _aqLoading = true;
  if (!_aqItems.length) list.innerHTML = '<div class="aq-empty">Loading…</div>';

  api({ action: 'get_action_queue', token: _s ? _s.token : '' })
    .then(res => {
      if (!res || !res.ok) {
        _aqLoading = false;
        list.innerHTML = `<div class="aq-empty">Couldn't load the queue. ${escHtml(res && res.error || '')}</div>`;
        return;
      }
      return aqLoadExceptionItems_().then(exceptionItems => {
        _aqLoading = false;
        _aqItems = (res.items || []).concat(exceptionItems || []);
        _aqItems.sort((a, b) => (b.sort || 0) - (a.sort || 0));
        if (typeof _appCacheSet === 'function') _appCacheSet('action_queue', { items: _aqItems });
        renderActionQueue();
        updateActionQueueBadge();
      });
    })
    .catch(() => {
      _aqLoading = false;
      if (!_aqItems.length) list.innerHTML = '<div class="aq-empty">Network error. Try again.</div>';
    });
}

function aqLoadExceptionItems_() {
  _aqExceptionError = '';
  return api({ action: 'get_assignment_exceptions', token: _s ? _s.token : '' })
    .then(res => {
      if (!res || !res.ok) {
        _aqExceptionError = (res && res.error) || 'Could not load assignment exceptions.';
        return [];
      }
      return (res.exceptions || []).map(aqExceptionToItem_);
    })
    .catch(() => {
      _aqExceptionError = 'Network error loading assignment exceptions.';
      return [];
    });
}

function aqExceptionLabel_(type) {
  const labels = {
    unresolved_zone: 'Unresolved Zone',
    unschedulable_zone_day: 'Bad Zone Day',
    missing_first_visit: 'Missing First Visit',
    preferred_day_unavailable: 'Preferred Day Unavailable'
  };
  return labels[String(type || '').trim()] || 'Assignment Exception';
}

function aqExceptionToItem_(ex) {
  const type = String(ex.type || '').trim();
  const qid = String(ex.quote_id || '').trim();
  const pid = String(ex.pool_id || '').trim();
  const when = String(ex.created_at || '');
  const then = when ? new Date(when) : null;
  const target = [qid ? 'Quote ' + qid : '', pid ? 'Pool ' + pid : ''].filter(Boolean).join(' · ');
  return {
    id: 'exception:' + String(ex.exception_id || ''),
    type: 'exception',
    kind: aqExceptionLabel_(type),
    title: aqExceptionLabel_(type) + (target ? ' · ' + target : ''),
    detail: String(ex.detail || 'A scheduler exception needs review.'),
    note: '',
    exception_id: String(ex.exception_id || ''),
    exception_type: type,
    quote_id: qid,
    pool_id: pid,
    when,
    sort: then && !isNaN(then.getTime()) ? then.getTime() : 0
  };
}

function aqSetFilter(f) {
  _aqFilter = f;
  renderActionQueue();
}

function aqCounts() {
  const c = { all: _aqItems.length, recovery: 0, start: 0, change: 0, expiring: 0, exception: 0 };
  _aqItems.forEach(i => { c[i.type] = (c[i.type] || 0) + 1; });
  return c;
}

function aqWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (isNaN(then.getTime())) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hrs / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  return then.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderActionQueue() {
  const list = document.getElementById('aq-list');
  const filters = document.getElementById('aq-filters');
  if (!list) return;

  const counts = aqCounts();
  if (filters) {
    const defs = [
      ['all', 'All'], ['recovery', 'Update Requested'], ['start', 'Start Dates'],
      ['exception', 'Exceptions'], ['change', 'Change Requests'], ['expiring', 'Expiring']
    ];
    filters.innerHTML = defs.map(([key, label]) =>
      `<button class="aq-filt${_aqFilter === key ? ' active' : ''}" onclick="aqSetFilter(${jsArg(key)})">
         ${label}<span class="aq-n">${counts[key] || 0}</span>
       </button>`).join('');
  }

  const shown = _aqItems.filter(i => _aqFilter === 'all' || i.type === _aqFilter);
  const warn = _aqExceptionError
    ? `<div class="aq-warn">Assignment exceptions could not be loaded. ${escHtml(_aqExceptionError)}</div>`
    : '';
  if (!shown.length) {
    list.innerHTML = `${warn}<div class="aq-empty">
      <div class="aq-empty-ic">✓</div>
      <h3>Nothing needs you right now</h3>
      <p>Start-date requests, change requests, assignment exceptions and expiring quotes all land here.</p>
    </div>`;
    return;
  }

  list.innerHTML = warn + shown.map(it => {
    const actions = aqActionsFor(it);
    return `<div class="aq-item aq-t-${escHtml(it.type)}">
      <div class="aq-main">
        <div class="aq-kind">
          <span class="aq-tag">${escHtml(it.kind || '')}</span>
          <span class="aq-when">${escHtml(aqWhen(it.when))}</span>
        </div>
        <h3>${escHtml(it.title || '')}</h3>
        <div class="aq-detail">${escHtml(it.detail || '')}</div>
        ${it.note ? `<div class="aq-note">“${escHtml(it.note)}”</div>` : ''}
      </div>
      <div class="aq-actions">${actions}</div>
    </div>`;
  }).join('');
}

function aqActionsFor(it) {
  // ⚠️ RAW here, then jsArg() at the call site. escHtml does not escape
  // apostrophes, so pre-escaping and wrapping in single quotes still breaks on a
  // value like O'Brien — and everything after the quote executes.
  const qid = String(it.quote_id || '');
  if (it.type === 'start') {
    const d = String(it.requested_start_date || '');
    return `<button class="aq-btn primary" onclick="aqConfirmStart(${jsArg(qid)}, ${jsArg(d)})">Confirm ${escHtml(d)}</button>
            <button class="aq-btn ghost" onclick="aqOpenQuote(${jsArg(qid)})">Open Quote</button>`;
  }
  if (it.type === 'change') {
    return `<button class="aq-btn primary" onclick="aqOpenQuote(${jsArg(qid)})">Open Quote</button>`;
  }
  if (it.type === 'exception') {
    const id = String(it.exception_id || '');
    const open = qid ? `<button class="aq-btn ghost" onclick="aqOpenQuote(${jsArg(qid)})">Open Quote</button>` : '';
    return `<button class="aq-btn primary" onclick="aqResolveException(${jsArg(id)})">Mark Resolved</button>${open}`;
  }
  // expiring / expired
  return `<button class="aq-btn primary" onclick="aqOpenQuote(${jsArg(qid)})">Open Quote</button>`;
}

function aqOpenQuote(quoteId) {
  // The Sales Hub owns quote records; deep-link rather than duplicating that UI.
  // loadCRM() consumes this and opens the lead drawer — see js/features/crm.js.
  window._pendingCrmQuoteId = quoteId;
  if (typeof navigateTo === 'function') navigateTo('crm');
}

function aqConfirmStart(quoteId, date) {
  if (!quoteId || !date) return;
  if (!confirm(`Confirm ${date} as the service start date?\n\nThis sets the service start. Billing start is unchanged.`)) return;

  api({ action: 'confirm_start_date', token: _s ? _s.token : '', quote_id: quoteId, confirmed_start_date: date })
    .then(res => {
      if (!res || !res.ok) {
        alert('Could not confirm: ' + ((res && res.error) || 'unknown error'));
        return;
      }
      // Drop it locally for instant feedback, then reconcile with the server.
      _aqItems = _aqItems.filter(i => i.quote_id !== quoteId || i.type !== 'start');
      renderActionQueue();
      updateActionQueueBadge();
      loadActionQueue(true);
    })
    .catch(() => alert('Network error confirming the start date.'));
}

function aqResolveException(exceptionId) {
  if (!exceptionId) return;
  if (!confirm('Mark this assignment exception resolved?')) return;

  api({ action: 'resolve_assignment_exception', token: _s ? _s.token : '', exception_id: exceptionId })
    .then(res => {
      if (!res || !res.ok) {
        alert('Could not resolve: ' + ((res && res.error) || 'unknown error'));
        return;
      }
      _aqItems = _aqItems.filter(i => i.type !== 'exception' || i.exception_id !== exceptionId);
      renderActionQueue();
      updateActionQueueBadge();
      loadActionQueue(true);
    })
    .catch(() => alert('Network error resolving the exception.'));
}

// Called at boot (app.js _prefetchCommon) so the badge carries a real count before
// anyone opens the page — an inbox nobody knows has mail in it is not an inbox.
// Paints instantly from a short cache; stale/missing cache refreshes behind it.
function primeActionQueueBadge(opts) {
  opts = opts || {};
  const shouldRefresh = opts.refresh !== false;
  if (!_s || !(_s.pages || []).includes('action_queue')) return;
  if (typeof _appCacheGet === 'function') {
    const cached = _appCacheGet('action_queue', AQ_BADGE_BOOT_CACHE_TTL);
    if (cached && Array.isArray(cached.items)) {
      _aqItems = cached.items;
      updateActionQueueBadge();
      return;
    }
  }
  if (!shouldRefresh) return;
  loadActionQueue(true);
}

// Sidebar badge — so the queue is visible without hunting for it.
function updateActionQueueBadge() {
  const el = document.getElementById('aq-badge');
  if (!el) return;
  const n = _aqItems.length;
  el.textContent = n > 99 ? '99+' : String(n);
  el.style.display = n ? '' : 'none';
}
