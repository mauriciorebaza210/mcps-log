// ══════════════════════════════════════════════════════════════════════════════
// SERVICE REQUESTS — staff review console
//
// Standalone rather than a page inside the SPA on purpose. index.html is 305KB
// and carries unfinished work, and adding a page there also means editing the
// `order` array in auth.js — the unionPages_ trap that has silently dropped
// pages before. This ships on its own and can be folded into the SPA later.
//
// It reuses the portal session already in localStorage (`mcps_s`), so an admin
// who is logged into the portal is logged into this. Every endpoint re-checks
// that token server-side with requireAdminPortalToken; the token in the browser
// is a convenience, never the authority.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var STATE = { items: [], techs: [], filter: 'open', busy: {} };

  function token() {
    try {
      var s = JSON.parse(localStorage.getItem('mcps_s') || 'null');
      return s && s.token ? s.token : '';
    } catch (_) { return ''; }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }
  function app() { return $('app'); }

  function api(method, payload) {
    var t = token();
    // A session token in a query string ends up in server and proxy logs. GET
    // has nowhere else to put it, but POST does, so POST keeps it in the body.
    var url = '/api/service-requests/review' +
      (method === 'GET'
        ? '?token=' + encodeURIComponent(t) + (STATE.filter === 'all' ? '&all=1' : '')
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
        $('count').textContent = (res.counts ? res.counts.open : STATE.items.length) + ' open';
        return renderList();
      }
      if (res && (res.error || '').toLowerCase().indexOf('unauthor') !== -1) return renderNoSession();
      renderError(res && res.error);
    }).catch(function () { renderError('We could not reach the server.'); });
  }

  function renderNoSession() {
    app().innerHTML =
      '<div class="empty"><h2>Sign in to the portal first</h2>' +
      '<p>This page uses your portal session. Open the portal, sign in, then come back.</p>' +
      '<p style="margin-top:16px"><a class="b pri" href="/">Go to the portal</a></p></div>';
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

  function photoStrip(it) {
    if (!it.photos || !it.photos.length) return '';
    return '<div class="shots">' + it.photos.map(function (u) {
      return '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="Customer photo" loading="lazy"></a>';
    }).join('') + '</div>';
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

  // ── Boot ─────────────────────────────────────────────────────────────────
  Array.prototype.forEach.call(document.querySelectorAll('.tab[data-f]'), function (t) {
    t.addEventListener('click', function () {
      STATE.filter = t.dataset.f;
      Array.prototype.forEach.call(document.querySelectorAll('.tab[data-f]'), function (o) {
        o.classList.toggle('on', o === t);
      });
      load();
    });
  });
  $('refresh').addEventListener('click', load);
  load();
})();
