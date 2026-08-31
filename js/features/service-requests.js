// ══════════════════════════════════════════════════════════════════════════════
// SERVICE REQUESTS — the review queue, inside the portal
//
// Requests submitted on the public /service page land here. This is the ONLY
// place a request becomes CRM or scheduling data: the public endpoint writes to
// the Service_Requests tab and has no code path to Quotes, Clients,
// Scheduled_Visits or Repair_Orders. Duplicate prevention is structural, not a
// rule someone has to remember.
//
// Entry point is loadServiceRequests(), called by the router. It talks to
// /api/service-requests/review — a Vercel function, not Apps Script — so it
// carries _s.token explicitly rather than going through api().
//
// ⚠️ Registering a page takes FOUR edits, not one. ROLE_PAGES alone does not
// grant it: unionPages_ in js/lib/auth.js filters against a hard-coded `order`
// array, and a page missing from that array is silently dropped with no error
// anywhere. The others are PAGE_META for the label, SIDEBAR_GROUPS for the nav
// entry, and the <div class="pf" id="page-service_requests"> in index.html.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var STATE = { items: [], techs: [], filter: 'open', busy: {} };

  function token() {
    if (typeof _s !== 'undefined' && _s && _s.token) return _s.token;
    try {
      var s = JSON.parse(localStorage.getItem('mcps_s') || 'null');
      return s && s.token ? s.token : '';
    } catch (_) { return ''; }
  }

  function setCount(text) {
    var el = $('sr-count');
    if (el) el.textContent = text;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }
  function app() { return $('sr-body'); }

  function api(method, payload) {
    var t = token();
    // A session token in a query string ends up in server and proxy logs. GET
    // has nowhere else to put it, but POST does, so POST keeps it in the body.
    var url = '/api/service-request?op=review' +
      (method === 'GET'
        ? '&token=' + encodeURIComponent(t) + (STATE.filter === 'all' ? '&all=1' : '')
        : '');
    var opts = { method: method };
    if (method === 'POST') {
      opts.headers = { 'content-type': 'application/json' };
      opts.body = JSON.stringify(Object.assign({ token: t }, payload || {}));
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Unexpected response.' }; });
    });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function ago(iso) {
    var ms = Date.now() - Date.parse(iso || 0);
    if (isNaN(ms)) return '';
    var h = Math.floor(ms / 3600000);
    if (h < 1) return 'just now';
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }
  var TIMING_LABEL = {
    asap: 'As soon as possible', this_week: 'This week',
    next_week: 'Next week', flexible: 'Flexible'
  };
  var STATUS_TAG = {
    new: ['new', 'New'], in_review: ['review', 'In review'], scheduled: ['sched', 'Scheduled'],
    quoted: ['sched', 'Quoted'], declined: ['closed', 'Declined'], duplicate: ['closed', 'Duplicate']
  };

  // ── Load ─────────────────────────────────────────────────────────────────
  function load() {
    if (!token()) return renderNoSession();
    app().innerHTML = '<div class="spin"></div>';
    api('GET').then(function (res) {
      if (res && res.ok) {
        STATE.items = res.items || [];
        STATE.techs = res.technicians || [];
        setCount((res.counts ? res.counts.open : STATE.items.length) + ' open');
        return renderList();
      }
      if (res && (res.error || '').toLowerCase().indexOf('unauthor') !== -1) return renderNoSession();
      renderError(res && res.error);
    }).catch(function () { renderError('We could not reach the server.'); });
  }

  function renderNoSession() {
    app().innerHTML =
      '<div class="empty"><h2>Your session has expired</h2>' +
      '<p>Sign in again to see the service request queue.</p></div>';
  }
  function renderError(m) {
    app().innerHTML = '<div class="empty"><h2>Something went wrong</h2><p>' + esc(m || 'Please try again.') + '</p>' +
      '<p style="margin-top:16px"><button class="b" onclick="location.reload()">Reload</button></p></div>';
  }

  function renderList() {
    if (!STATE.items.length) {
      app().innerHTML = '<div class="empty"><h2>Nothing waiting</h2>' +
        '<p>' + (STATE.filter === 'open'
          ? 'No open service requests right now. New ones land here automatically.'
          : 'No service requests have come in yet.') + '</p></div>';
      return;
    }
    app().innerHTML = STATE.items.map(card).join('');
    wire();
    loadPhotos();
  }

  // ── Card ─────────────────────────────────────────────────────────────────
  function card(it) {
    var name = [it.first_name, it.last_name].filter(Boolean).join(' ').trim() || 'No name given';
    var addr = [it.service_address, it.city, it.zip_code].filter(Boolean).join(', ');
    var st = STATUS_TAG[it.status] || ['closed', it.status];

    return '<article class="card" data-id="' + esc(it.request_id) + '">' +
      '<div class="chead">' +
        '<div class="who">' +
          '<div class="name">' + esc(name) + '</div>' +
          '<div class="addr">' + esc(addr || 'No address given') + '</div>' +
          '<div class="meta">' + esc(it.request_id) + ' · ' + esc(ago(it.created_at)) + ' · ' + esc(fmtDate(it.created_at)) +
            (it.campaign_id ? ' · ' + esc(it.campaign_id) : '') +
            (it.same_key_count > 1 ? ' · <b>' + it.same_key_count + ' submissions</b>' : '') +
          '</div>' +
        '</div>' +
        '<div class="tags">' +
          (it.timing_preference === 'asap' ? '<span class="tag asap">ASAP</span>' : '') +
          '<span class="tag cat">' + esc(it.category_label) + '</span>' +
          '<span class="tag ' + st[0] + '">' + esc(st[1]) + '</span>' +
        '</div>' +
      '</div>' +
      matchBand(it) +
      '<div class="cbody">' +
        (it.description ? '<div class="desc">' + esc(it.description) + '</div>' : '') +
        photoStrip(it) +
        '<div class="kv">' +
          kv('What they need', it.category_label + (it.subcategory ? ' · ' + prettySub(it.subcategory) : '')) +
          kv('Timing', (TIMING_LABEL[it.timing_preference] || it.timing_preference) +
             (it.timing_notes ? ' — ' + it.timing_notes : '')) +
          kv('Phone', it.phone || '—') +
          kv('Email', it.email || '—') +
          (it.match_pool_id ? kv('Pool ID', it.match_pool_id) : '') +
          (it.review_notes ? kv('Notes', it.review_notes) : '') +
        '</div>' +
        candidates(it) +
        contactRow(it) +
        actions(it) +
        scheduleForm(it) +
        '<div class="msg" id="m-' + esc(it.request_id) + '"></div>' +
        auditLog(it) +
      '</div>' +
    '</article>';
  }

  function kv(k, v) {
    return '<div><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }
  function prettySub(s) {
    return String(s || '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function matchBand(it) {
    if (it.is_existing_customer) {
      return '<div class="band cust">⚠ Already an active customer — check their account before quoting anything.</div>';
    }
    if (it.match_status === 'confident' && (it.match_quote_id || it.match_client_id)) {
      return '<div class="band ok"><b>Matched</b> to ' +
        esc(it.match_quote_id || it.match_client_id) +
        (it.match_reasons ? ' on ' + esc(String(it.match_reasons).replace(/,/g, ', ')) : '') +
        (it.match_pool_id ? ' · pool ' + esc(it.match_pool_id) : ' · no pool ID yet') +
        '</div>';
    }
    if (it.match_status === 'ambiguous') {
      return '<div class="band warn"><b>Needs a human</b> — close matches exist but none is certain. Pick one below or create a new lead.</div>';
    }
    return '<div class="band none"><b>No match</b> — nobody in the CRM looks like this person.</div>';
  }

  function candidates(it) {
    if (!it.candidates || !it.candidates.length) return '';
    // A confident match still gets the list, collapsed. The matcher is
    // conservative but not infallible, and an admin who can see it is wrong
    // needs a way to say so without editing a spreadsheet by hand.
    if (it.match_status === 'confident') {
      return '<details class="cands"><summary class="t" style="cursor:pointer">Wrong person? Pick a different match</summary>' +
        candRows(it) + '</details>';
    }
    return '<div class="cands"><div class="t">Possible matches</div>' + candRows(it) + '</div>';
  }

  function candRows(it) {
    return
      it.candidates.map(function (c) {
        var label = c.display || c.email || c.quote_id || c.client_id;
        return '<div class="cand">' +
          '<div><div class="n">' + esc(label) + '</div>' +
          '<div class="d">' + esc([c.address, c.email, c.phone].filter(Boolean).join(' · ')) +
          (c.status ? ' · ' + esc(c.status) : '') + '</div></div>' +
          '<div class="s">' + esc((c.reasons || []).join('+')) + ' ' + esc(String(c.score)) + '</div>' +
          '<button class="b small" data-act="link" data-id="' + esc(it.request_id) + '"' +
            ' data-client="' + esc(c.client_id || '') + '" data-quote="' + esc(c.quote_id || '') + '"' +
            ' data-loc="' + esc(c.location_id || '') + '" data-pool="' + esc(c.pool_id || '') + '">' +
            'This is them</button>' +
        '</div>';
      }).join('');
  }

  // Photos live in a private blob store, so there is no URL an <img> can point
  // at. Setting src to the proxy would work but would put the session token in
  // the DOM and in browser history, so each photo is fetched with the token in a
  // header and rendered from an object URL instead.
  function photoStrip(it) {
    if (!it.photos || !it.photos.length) return '';
    return '<div class="shots">' + it.photos.map(function (p, i) {
      return '<button class="shot" data-photo="' + esc(p) + '" data-key="' + esc(it.request_id + ':' + i) + '" ' +
        'title="Open full size"><span class="ph">' + (i + 1) + '</span></button>';
    }).join('') + '</div>';
  }

  var _photoCache = {};
  function loadPhotos() {
    Array.prototype.forEach.call(document.querySelectorAll('.shot[data-photo]'), function (b) {
      var key = b.dataset.key;
      if (_photoCache[key]) return paint(b, _photoCache[key]);
      fetch('/api/service-request?op=view&pathname=' + encodeURIComponent(b.dataset.photo) +
            '&token=' + encodeURIComponent(token()))
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (blob) {
          if (!blob) { b.classList.add('missing'); b.title = 'Photo unavailable'; return; }
          var url = URL.createObjectURL(blob);
          _photoCache[key] = url;
          paint(b, url);
        })
        .catch(function () { b.classList.add('missing'); });
    });
  }
  function paint(btn, url) {
    btn.innerHTML = '<img src="' + url + '" alt="Customer photo">';
    btn.onclick = function () { window.open(url, '_blank', 'noopener'); };
  }

  // tel: / mailto: / copy — no new workflow, just fewer steps to follow up.
  function contactRow(it) {
    var bits = [];
    if (it.phone) bits.push('<a class="b small" href="tel:' + esc(String(it.phone).replace(/[^\d+]/g, '')) + '">Call</a>');
    if (it.phone) bits.push('<a class="b small" href="sms:' + esc(String(it.phone).replace(/[^\d+]/g, '')) + '">Text</a>');
    if (it.email) bits.push('<a class="b small" href="mailto:' + esc(it.email) + '?subject=' +
      encodeURIComponent('Your pool service request ' + it.request_id) + '">Email</a>');
    var addr = [it.service_address, it.city, it.zip_code].filter(Boolean).join(', ');
    if (addr) {
      bits.push('<button class="b small" data-act="copy" data-copy="' + esc(addr) + '">Copy address</button>');
      bits.push('<a class="b small" target="_blank" rel="noopener" href="https://maps.google.com/?q=' +
        encodeURIComponent(addr) + '">Map</a>');
    }
    return bits.length ? '<div class="acts" style="border-top:0;padding-top:0;margin-bottom:4px">' + bits.join('') + '</div>' : '';
  }

  function actions(it) {
    var id = esc(it.request_id);
    var closed = ['declined', 'duplicate'].indexOf(it.status) !== -1;
    if (closed) {
      return '<div class="acts"><span class="b dim" style="border:0;padding-left:0">Closed — ' +
        esc(it.review_notes || 'no reason recorded') + '</span></div>';
    }

    var hasPool = !!it.match_pool_id;
    var out = [];

    if (!it.converted_quote_id && it.match_status !== 'confident') {
      out.push('<button class="b" data-act="create_lead" data-id="' + id + '">Create lead</button>');
    }

    if (it.schedulable) {
      if (it.creates_repair_order) {
        out.push('<button class="b pri" data-act="repair_form" data-id="' + id + '"' + (hasPool ? '' : ' disabled') + '>' +
          (it.repair_order_id ? 'Repair order ' + esc(it.repair_order_id) : 'Create repair order') + '</button>');
      } else {
        out.push('<button class="b pri" data-act="show_sched" data-id="' + id + '"' + (hasPool ? '' : ' disabled') + '>' +
          (it.scheduled_visit_id ? 'Scheduled' : 'Schedule visit') + '</button>');
      }
    } else {
      out.push('<a class="b pri" href="/#quotes" target="_blank" rel="noopener">Open quote tool</a>');
    }

    // The why-note below tells a blocked admin to set the customer up in the
    // quote tool. Saying that without giving them the button is a dead end.
    if (it.schedulable && !hasPool) {
      out.push('<a class="b" href="/#quotes" target="_blank" rel="noopener">Open quote tool</a>');
    }

    out.push('<button class="b" data-act="note" data-id="' + id + '">Add note</button>');
    out.push('<button class="b bad" data-act="decline" data-id="' + id + '">Decline</button>');
    out.push('<button class="b dim" data-act="duplicate" data-id="' + id + '">Duplicate</button>');

    var why = '';
    if (it.schedulable && !hasPool) {
      // The preflight, explained where the disabled button is — a greyed control
      // with no reason is the most annoying thing in an internal tool.
      why = '<div class="why"><span>⚠</span><span>No pool ID on this property yet, so it can\'t go on the schedule. ' +
        'Link it to an existing customer above, or set them up in the quote tool first — that\'s what assigns a pool ID.</span></div>';
    }
    if (!it.schedulable) {
      why = '<div class="why"><span>ℹ</span><span>Weekly service needs a signed agreement, billing and a route slot. ' +
        'Build it in the quote tool so it goes through the normal proposal and e-sign flow.</span></div>';
    }
    return '<div class="acts">' + out.join('') + '</div>' + why;
  }

  function scheduleForm(it) {
    if (!it.schedulable) return '';
    var id = esc(it.request_id);
    var techOpts = ['<option value="">Unassigned</option>'].concat(
      STATE.techs.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; })
    ).join('');
    var isRepair = it.creates_repair_order;

    return '<div class="sched" id="s-' + id + '">' +
      (isRepair
        ? '<div class="f" style="flex:1;min-width:200px"><label>Job name</label>' +
          '<input type="text" id="jn-' + id + '" value="Repair: ' + esc(prettySub(it.subcategory) || 'customer request') + '"></div>' +
          '<div class="f"><label>Priority</label><select id="pr-' + id + '">' +
          '<option value="high"' + (it.timing_preference === 'asap' ? ' selected' : '') + '>High</option>' +
          '<option value="medium"' + (it.timing_preference !== 'asap' ? ' selected' : '') + '>Medium</option>' +
          '<option value="low">Low</option></select></div>'
        : '<div class="f"><label>Visit date</label><input type="date" id="d-' + id + '"></div>') +
      '<div class="f"><label>Technician</label><select id="t-' + id + '">' + techOpts + '</select></div>' +
      '<button class="b pri" data-act="' + (isRepair ? 'repair_order' : 'schedule') + '" data-id="' + id + '">' +
        (isRepair ? 'Create work order' : 'Put on the schedule') + '</button>' +
      '<button class="b dim" data-act="hide_sched" data-id="' + id + '">Cancel</button>' +
      '<div class="hint">Customer asked for: <b>' + esc(TIMING_LABEL[it.timing_preference] || it.timing_preference) + '</b>' +
        (it.timing_notes ? ' — ' + esc(it.timing_notes) : '') +
        '. That\'s their preference, not a commitment — pick the day that actually works.</div>' +
    '</div>';
  }

  function auditLog(it) {
    if (!it.action_log || !it.action_log.length) return '';
    return '<details class="log"><summary>History (' + it.action_log.length + ')</summary>' +
      it.action_log.slice().reverse().map(function (e) {
        return '<div>' + esc(fmtDate(e.at)) + ' — ' + esc(e.actor || '') + ' ' + esc(e.action || '') +
          (e.from_status && e.to_status && e.from_status !== e.to_status
            ? ' (' + esc(e.from_status) + ' → ' + esc(e.to_status) + ')' : '') + '</div>';
      }).join('') + '</details>';
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  function msg(id, text, kind) {
    var el = $('m-' + id);
    if (!el) return;
    el.textContent = text;
    el.className = 'msg on ' + (kind || 'err');
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () { onAction(b); });
    });
  }

  function onAction(btn) {
    var act = btn.dataset.act;
    var id = btn.dataset.id;

    if (act === 'copy') {
      navigator.clipboard.writeText(btn.dataset.copy).then(function () {
        var was = btn.textContent; btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = was; }, 1400);
      });
      return;
    }
    if (act === 'show_sched' || act === 'repair_form') { $('s-' + id).classList.add('on'); return; }
    if (act === 'hide_sched') { $('s-' + id).classList.remove('on'); return; }

    if (STATE.busy[id]) return;          // client-side double-click guard;
    STATE.busy[id] = true;               // the server is idempotent regardless
    btn.disabled = true;
    var restore = function () { STATE.busy[id] = false; btn.disabled = false; };

    if (act === 'link') {
      return send(id, {
        action: 'link', request_id: id,
        client_id: btn.dataset.client, quote_id: btn.dataset.quote,
        location_id: btn.dataset.loc, pool_id: btn.dataset.pool
      }, restore);
    }
    if (act === 'create_lead') {
      return send(id, { action: 'create_lead', request_id: id }, restore, function (res) {
        if (res && res.code === 'match_found') {
          msg(id, res.error + ' (' + (res.match.display || res.match.quote_id) + ')', 'err');
          return true;
        }
        return false;
      });
    }
    if (act === 'schedule') {
      var date = ($('d-' + id) || {}).value || '';
      if (!date) { msg(id, 'Pick a date for the visit.', 'err'); return restore(); }
      return send(id, {
        action: 'schedule', request_id: id,
        scheduled_date: date, assigned_technician: ($('t-' + id) || {}).value || ''
      }, restore);
    }
    if (act === 'repair_order') {
      return send(id, {
        action: 'repair_order', request_id: id,
        job_name: ($('jn-' + id) || {}).value || '',
        priority: ($('pr-' + id) || {}).value || '',
        assigned_to: ($('t-' + id) || {}).value || ''
      }, restore);
    }
    if (act === 'note') {
      var note = prompt('Add a note to this request:');
      if (note === null) return restore();
      return send(id, { action: 'note', request_id: id, review_notes: note }, restore);
    }
    if (act === 'decline' || act === 'duplicate') {
      var why = prompt(act === 'duplicate'
        ? 'Mark as a duplicate. What is it a duplicate of?'
        : 'Decline this request. Reason (the customer does not see this):');
      if (why === null) return restore();
      return send(id, { action: 'decline', request_id: id, duplicate: act === 'duplicate', review_notes: why }, restore);
    }
    restore();
  }

  // A card-level message is useless for an action that removes the card: acting
  // on a request moves it out of the open queue, so the confirmation would be
  // destroyed by the reload that follows it. This survives.
  function toast(text, kind) {
    var el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.className = 'toast on ' + (kind || 'ok');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = 'toast ' + (kind || 'ok'); }, 4000);
  }

  var DONE_COPY = {
    schedule: function (r) {
      return 'On the schedule for ' + r.scheduled_date +
        (r.assigned_technician ? ' with ' + r.assigned_technician : ', unassigned') +
        '. Route ordering catches up within 5 minutes.';
    },
    repair_order: function (r) { return 'Work order ' + r.order_id + ' created. It is in the Repairs hub now.'; },
    create_lead: function (r) { return 'Lead ' + r.quote_id + ' created in the CRM.'; },
    link: function () { return 'Linked. You can schedule it now.'; },
    note: function () { return 'Note saved.'; },
    decline: function (r) { return r.status === 'duplicate' ? 'Marked as a duplicate.' : 'Request declined.'; }
  };

  function send(id, payload, restore, handled) {
    api('POST', payload).then(function (res) {
      restore();
      if (res && res.ok) {
        var copy = DONE_COPY[payload.action];
        toast(res.existing
          ? 'Already done — nothing was created a second time.'
          : (copy ? copy(res) : 'Done.'), 'ok');
        return setTimeout(load, 400);
      }
      if (handled && handled(res)) return;
      var err = (res && res.error) || 'That did not work. Please try again.';
      msg(id, err, 'err');
      toast(err, 'err');
    }).catch(function () {
      restore();
      msg(id, 'We could not reach the server.', 'err');
      toast('We could not reach the server.', 'err');
    });
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  // Injected at runtime rather than added to style.css, matching how comms.js
  // ships its own styles. Every selector is namespaced under
  // #page-service_requests: the portal defines its own --teal at a different
  // value, and bare .card / .tab / .b rules would collide with existing ones.
  // The toast is the one exception — it attaches to <body>, so it cannot be
  // scoped to the page.
  function injectStyles() {
    if (document.getElementById('sr-styles')) return;
    var el = document.createElement('style');
    el.id = 'sr-styles';
    el.textContent = SR_CSS;
    document.head.appendChild(el);
  }

  var SR_CSS = `#page-service_requests{
  --teal:#0D3D3E; --aqua:#1FA7A8; --aqua-light:#5ED6D3; --gray:#F3F5F6;
  --ink:#222222; --muted:#5c6b6b; --line:#d8e2e4;
  --danger:#b42318; --danger-bg:#fef3f2;
  --warn:#a9750c; --warn-bg:#fdf4e3; --warn-line:#ebd9ae;
  --ok-bg:#ecfdf3; --ok-ink:#067647;
  --fh:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
  --fb:'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
}
#page-service_requests .pill{background:rgba(255,255,255,.14);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;font-family:var(--fh)}



#page-service_requests .card{background:#fff;border:1px solid var(--line);border-radius:13px;margin-bottom:16px;overflow:hidden;
  box-shadow:0 5px 18px rgba(13,61,62,.06)}
#page-service_requests .chead{padding:15px 17px;display:flex;gap:13px;align-items:flex-start;flex-wrap:wrap;border-bottom:1px solid var(--gray)}
#page-service_requests .chead .who{flex:1;min-width:210px}
#page-service_requests .chead .name{font-family:var(--fh);font-weight:800;font-size:16.5px;color:var(--teal)}
#page-service_requests .chead .addr{font-size:13.5px;color:var(--muted);margin-top:2px}
#page-service_requests .chead .meta{font-size:11.5px;color:var(--muted);margin-top:5px}
#page-service_requests .tag{display:inline-block;font-family:var(--fh);font-weight:700;font-size:10px;letter-spacing:.09em;
  text-transform:uppercase;padding:5px 10px;border-radius:20px;white-space:nowrap}
#page-service_requests .tag.cat{background:var(--gray);color:var(--teal)}
#page-service_requests .tag.new{background:var(--aqua);color:#fff}
#page-service_requests .tag.review{background:var(--warn-bg);color:var(--warn)}
#page-service_requests .tag.sched{background:var(--ok-bg);color:var(--ok-ink)}
#page-service_requests .tag.closed{background:var(--gray);color:var(--muted)}
#page-service_requests .tag.asap{background:var(--danger-bg);color:var(--danger)}
#page-service_requests .tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#page-service_requests .band{padding:11px 17px;font-size:13.5px;display:flex;gap:9px;align-items:flex-start}
#page-service_requests .band.ok{background:var(--ok-bg);color:#065f46;border-bottom:1px solid #c9ecdb}
#page-service_requests .band.warn{background:var(--warn-bg);color:#6b5410;border-bottom:1px solid var(--warn-line)}
#page-service_requests .band.none{background:var(--gray);color:#455;border-bottom:1px solid var(--line)}
#page-service_requests .band.cust{background:#fff5f5;color:var(--danger);border-bottom:1px solid #f6d5d2;font-weight:700}
#page-service_requests .band b{font-weight:700}
#page-service_requests .cbody{padding:15px 17px}
#page-service_requests .desc{background:var(--gray);border-radius:9px;padding:12px 14px;font-size:14px;margin-bottom:13px;white-space:pre-wrap}
#page-service_requests .kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:11px;margin-bottom:13px}
#page-service_requests .kv .k{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700;font-family:var(--fh)}
#page-service_requests .kv .v{font-size:14px;margin-top:2px;word-break:break-word}
#page-service_requests .shots{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:13px}
#page-service_requests .shots .shot{width:78px;height:78px;border-radius:8px;overflow:hidden;border:1px solid var(--line);
  background:var(--gray);padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center;
  position:relative;font-family:var(--fb)}
#page-service_requests .shots .shot .ph{font-family:var(--fh);font-weight:700;font-size:12px;color:var(--muted);opacity:.55}
#page-service_requests .shots .shot.missing{border-color:var(--danger);background:var(--danger-bg)}
#page-service_requests .shots .shot.missing::after{content:'unavailable';font-size:9px;color:var(--danger);position:absolute;bottom:5px}
#page-service_requests .shots img{width:100%;height:100%;object-fit:cover;display:block}
#page-service_requests .cands{border:1px dashed var(--warn-line);border-radius:9px;padding:11px 13px;margin-bottom:13px;background:#fffdf7}
#page-service_requests .cands .t{font-family:var(--fh);font-weight:700;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--warn);margin-bottom:8px}
#page-service_requests .cand{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #f0e4c8;flex-wrap:wrap}
#page-service_requests .cand:first-of-type{border-top:0}
#page-service_requests .cand .n{font-weight:700;font-size:13.5px}
#page-service_requests .cand .d{font-size:12px;color:var(--muted)}
#page-service_requests .cand .s{margin-left:auto;font-size:11px;color:var(--muted);font-family:var(--fh);font-weight:700}
#page-service_requests .acts{display:flex;gap:8px;flex-wrap:wrap;padding-top:13px;border-top:1px solid var(--gray)}
#page-service_requests .b{border:1.5px solid var(--line);background:#fff;border-radius:9px;padding:10px 14px;font-size:13.5px;
  font-weight:700;color:var(--ink);cursor:pointer;font-family:var(--fb);text-decoration:none;display:inline-flex;
  align-items:center;gap:6px;min-height:42px}
#page-service_requests .b:hover:not(:disabled){border-color:var(--aqua)}
#page-service_requests .b.pri{background:var(--aqua);border-color:var(--aqua);color:#fff}
#page-service_requests .b.pri:hover:not(:disabled){background:#1b9596}
#page-service_requests .b.dim{color:var(--muted)}
#page-service_requests .b.bad{color:var(--danger);border-color:#f0cdc9}
#page-service_requests .b:disabled{opacity:.42;cursor:not-allowed}
#page-service_requests .b.small{padding:7px 11px;font-size:12.5px;min-height:36px}
#page-service_requests .why{font-size:12px;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-line);
  border-radius:8px;padding:9px 11px;margin-top:11px;display:flex;gap:8px}
#page-service_requests .sched{background:var(--gray);border-radius:9px;padding:13px;margin-top:12px;display:none;gap:10px;flex-wrap:wrap;align-items:flex-end}
#page-service_requests .sched.on{display:flex}
#page-service_requests .sched .f{display:flex;flex-direction:column;gap:4px}
#page-service_requests .sched label{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700;font-family:var(--fh)}
#page-service_requests .sched input,#page-service_requests .sched select{border:1.5px solid var(--line);border-radius:8px;padding:9px 11px;font-family:var(--fb);font-size:14px;background:#fff}
#page-service_requests .sched .hint{font-size:12px;color:var(--muted);flex-basis:100%;margin-top:-4px}
#page-service_requests .empty{text-align:center;padding:60px 20px;color:var(--muted)}
#page-service_requests .empty h2{font-size:19px;color:var(--teal);margin-bottom:7px}
#page-service_requests .msg{border-radius:9px;padding:11px 14px;margin:11px 0 0;font-size:13.5px;font-weight:600;display:none}
#page-service_requests .msg.on{display:block}
#page-service_requests .msg.err{background:var(--danger-bg);color:var(--danger)}
#page-service_requests .msg.ok{background:var(--ok-bg);color:var(--ok-ink)}
#page-service_requests .log{font-size:11.5px;color:var(--muted);margin-top:11px}
#page-service_requests .log summary{cursor:pointer;font-weight:700}
#page-service_requests .log div{padding:3px 0 0 12px}
@media(max-width:560px){#page-service_requests .acts .b{flex:1;justify-content:center}}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,140%);z-index:50;
  max-width:min(560px,calc(100vw - 32px));padding:14px 20px;border-radius:11px;font-size:14px;font-weight:600;
  box-shadow:0 12px 34px rgba(13,61,62,.24);transition:transform .28s cubic-bezier(.2,.8,.3,1);
  background:var(--teal);color:#fff;text-align:center}
.toast.on{transform:translate(-50%,0)}
.toast.err{background:var(--danger)}

#page-service_requests .tab{background:#fff;border:1.5px solid var(--line);color:var(--ink);
  border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:700;cursor:pointer;
  font-family:var(--fb);min-height:38px}
#page-service_requests .tab:hover{border-color:var(--aqua);color:var(--teal)}
#page-service_requests .tab.on{background:var(--aqua);border-color:var(--aqua);color:#fff}
#page-service_requests .tab:focus-visible{outline:2.5px solid var(--aqua-light);outline-offset:2px}
#page-service_requests .sr-pill{background:var(--gray);border-radius:999px;padding:5px 12px;font-size:12px;
  font-weight:700;font-family:var(--fh);color:var(--muted)}
#page-service_requests .spin{width:34px;height:34px;margin:50px auto;border:3px solid var(--line);
  border-top-color:var(--aqua);border-radius:50%;animation:srspin .8s linear infinite}
@keyframes srspin{to{transform:rotate(360deg)}}
`;

  // ── Entry point ──────────────────────────────────────────────────────────
  // Called by the router on navigation. Wiring the header controls is done once;
  // re-entering the page just reloads the queue.
  var _wired = false;

  window.loadServiceRequests = function () {
    injectStyles();
    if (!_wired) {
      _wired = true;
      Array.prototype.forEach.call(document.querySelectorAll('#page-service_requests .tab[data-f]'), function (t) {
        t.addEventListener('click', function () {
          STATE.filter = t.dataset.f;
          Array.prototype.forEach.call(document.querySelectorAll('#page-service_requests .tab[data-f]'), function (o) {
            o.classList.toggle('on', o === t);
          });
          load();
        });
      });
      var r = $('sr-refresh');
      if (r) r.addEventListener('click', load);
    }
    load();
  };
})();
