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

  // ⚠️ NOT named api(). Every portal feature file shares one global scope, and
  // js/lib/api.js already defines a global api(payload) that talks to Apps
  // Script. A local api() here shadowed it, so the quote save silently called
  // the wrong function and no quote was ever created — with no error, because
  // the shapes are different enough to fail quietly.
  var FAST_SERVICES = ['Weekly Full Service', 'Bi-Weekly Maintenance', 'Repair / Replacement / Other Job'];

  function reviewApi(method, payload, op) {
    var t = token();
    // A session token in a query string ends up in server and proxy logs. GET
    // has nowhere else to put it, but POST does, so POST keeps it in the body.
    var url = '/api/service-request?op=' + (op || 'review') +
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
    reviewApi('GET').then(function (res) {
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
        (it.converted_quote_id ? quoteProgress(it) : '<div id="qp-' + esc(it.request_id) + '"></div>') +
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
    } else if (!it.converted_quote_id) {
      // Weekly service is built HERE, not handed off. Bouncing to another screen
      // to retype what the customer already told us is the hand-off this page
      // exists to remove.
      out.push('<button class="b pri" data-act="quote_show" data-id="' + id + '">Build quote</button>');
    }

    // A schedulable request with no pool_id cannot go on the board, and a quote
    // is what mints one — so offer it right where the block is explained.
    if (it.schedulable && !hasPool && !it.converted_quote_id) {
      out.push('<button class="b" data-act="quote_show" data-id="' + id + '">Build quote</button>');
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
    if (!it.schedulable && !it.converted_quote_id) {
      why = '<div class="why"><span>ℹ</span><span>Weekly service needs a signed agreement before it can go on a route. ' +
        'Build the quote here and send it for signature — the customer signs, and activation assigns the pool ID and route slot.</span></div>';
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


  // ══ Quote panel ═══════════════════════════════════════════════════════════
  //
  // The whole quote → proposal → send-for-approval flow, in the card.
  //
  // ⚠️ PRICING IS NOT REIMPLEMENTED HERE. MCPS_PRICING (js/lib/pricing.js) is the
  // one engine the quote tool, this page and the server all price through, so a
  // rate change lands everywhere at once. A second pricing implementation would
  // be two sources of truth for what a customer is charged, and they would drift
  // the first time a rate changed.
  //
  // Saving goes through the same `save_quote` action the quote tool posts, so a
  // quote raised here is indistinguishable from one raised there — same columns,
  // same pool_id minting, same operational sync.

  var SPECS = [
    ['size',      'Size',      [['small','Small · 0–15k gal'],['medium','Medium · 15–20k'],['large','Large · 20k+']]],
    ['pool_type', 'Pool type', [['inground','Inground'],['above_ground','Above ground']]],
    ['material',  'Material',  [['plaster','Plaster'],['fiberglass','Fiberglass'],['vinyl','Vinyl'],['tile','Tile']]],
    ['finish',    'Finish',    [['light','Light'],['dark','Dark']]],
    ['debris',    'Debris',    [['light','Light'],['heavy','Heavy']]]
  ];
  var TOGGLES = [['spa','Spa'],['has_robot','Robot on site'],['high_sun_exposure','High sun'],['has_pets','Pets']];

  var SERVICE_CHOICES = [
    ['weekly_full',    'Weekly Full Service'],
    ['biweekly_maint', 'Bi-Weekly Maintenance'],
    ['green_to_clean', 'Green-to-Clean'],
    ['pool_startup',   'Pool Startup'],
    ['repair_job',     'Repair / Other']
  ];

  // Reasonable opening guesses. The customer never told us their pool size, so
  // these are a starting point an admin corrects — not a claim.
  function newQuoteState(it) {
    return {
      service: it.category === 'weekly_service' ? 'weekly_full'
             : it.category === 'green_to_clean' ? 'green_to_clean'
             : it.category === 'repair' ? 'repair_job' : 'weekly_full',
      size: 'medium', pool_type: 'inground', material: 'plaster',
      spa: false, finish: 'light', debris: 'light',
      has_robot: false, high_sun_exposure: false, has_pets: false,
      startup_chemical: true, startup_programming: false, startup_pool_school: false,
      startup_company: '', startup_company_email: '', sponsored_by_mcp: false,
      startup_start_date: '', repair_type: '', repair_company: '', repair_amount: 0,
      // The engine's own adjustment vocabulary (MCPS_PRICING.calcAdjustment
      // lowercases these), so an adjustment means the same thing wherever it
      // was entered — and a Custom Price ABOVE the rate card is charged as a
      // premium rather than silently clamped down to the preset.
      discount_type: 'none', discount_value: 0, custom_price: 0,
      travel_fee: 0,
      first_name: it.first_name, last_name: it.last_name, email: it.email, phone: it.phone,
      address: it.service_address, city: it.city, zip_code: it.zip_code, area: '',
      travel: null, void_travel: false, busy: '', error: ''
    };
  }

  var _quotes = {};   // request_id -> quote state

  function quoteState(it) {
    if (!_quotes[it.request_id]) _quotes[it.request_id] = newQuoteState(it);
    return _quotes[it.request_id];
  }

  // Maps this card's quote state onto the engine's input shape — the same job
  // qPricingInput() does for the quote tool. One place, so a renamed field
  // breaks loudly here instead of quietly mispricing.
  function pricingInput(q) {
    return {
      service:            q.service,
      size:               q.size,
      pool_type:          q.pool_type,
      material:           q.material,
      spa:                q.spa,
      finish:             q.finish,
      debris:             q.debris,
      has_robot:          q.has_robot,
      high_sun_exposure:  q.high_sun_exposure,
      has_pets:           q.has_pets,
      startup_chemical:   q.startup_chemical,
      startup_programming:q.startup_programming,
      startup_pool_school:q.startup_pool_school,
      startup_company:    q.startup_company,
      repair_type:        q.repair_type,
      // Repair is operator-priced; the engine reads it as manual_price.
      manual_price:       Number(q.repair_amount) || 0,
      adjustment_type:    q.discount_type,
      adjustment_value:   q.discount_type === 'Custom Price' ? q.custom_price : q.discount_value,
      travel_fee:         q.travel_fee,
      void_travel:        q.void_travel
    };
  }

  function priceOf(q) {
    if (typeof MCPS_PRICING === 'undefined') return null;
    var input = pricingInput(q);
    var c = MCPS_PRICING.priceQuote(input);

    // `eng` keeps the shape this file already renders and saves from. Every
    // label comes from the engine, so the quote tool and this page can't drift.
    var eng = {
      service_label:   c.service_label,
      pool_type:       MCPS_PRICING.poolTypeLabel(q.pool_type),
      size:            c.service_key === 'pool_startup' ? 'startup'
                     : c.service_key === 'repair_job'   ? 'repair'
                     : q.size,
      material:        MCPS_PRICING.materialLabel(q.material),
      spa:             q.spa ? 'Yes' : 'No',
      finish:          q.finish === 'dark'   ? 'Dark'  : 'Light',
      debris:          q.debris === 'heavy'  ? 'Heavy' : 'Light',
      subtotal:        c.service_subtotal,
      chem_cost:       c.chem_cost_est,
      specs_summary:   MCPS_PRICING.buildSpecsSummary(input, c),
      pricing_ready:   c.pricing_ready,
      pricing_warning: c.adjustment_error || (c.warnings && c.warnings[0]) || '',
      qb_names:        c.qb_names,
      qb_skus:         c.qb_skus
    };

    // discountAmount keeps this file's existing sign convention — NEGATIVE for a
    // premium — so the "Premium +$X" rows below and the single discount_amount
    // column on the sheet both keep reading exactly as they always have.
    var da = c.adjustment_kind === 'premium' ? -c.adjustment_amount : c.adjustment_amount;

    return {
      eng: eng, discountAmount: da, discounted: c.adjusted_service, travel: c.travel_fee,
      subtotal: c.quote_subtotal, tax: c.sales_tax, total: c.total_with_tax
    };
  }

  function money(n) { return '$' + Number(n || 0).toFixed(2); }

  function quotePanel(it) {
    var q = quoteState(it);
    var id = esc(it.request_id);
    var p = priceOf(q);
    if (!p) {
      return '<div class="why"><span>⚠</span><span>The quote engine did not load. ' +
        'Open the Quote Tool from the sidebar instead.</span></div>';
    }
    var startup = q.service === 'pool_startup';
    var repair = q.service === 'repair_job';

    return '<div class="quote" id="q-' + id + '">' +
      '<div class="qt">Build the quote</div>' +
      '<div class="qrow">' +
        '<div class="qf" style="flex:1;min-width:190px"><label>Service</label><select data-q="service" data-id="' + id + '">' +
          SERVICE_CHOICES.map(function (s) {
            return '<option value="' + s[0] + '"' + (q.service === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>';
          }).join('') + '</select></div>' +
        (repair
          ? '<div class="qf" style="flex:1;min-width:150px"><label>Price</label>' +
            '<input type="number" step="0.01" data-q="repair_amount" data-id="' + id + '" value="' + esc(q.repair_amount) + '"></div>'
          : '') +
      '</div>' +
      (repair || startup ? '' :
        '<div class="qrow">' + SPECS.map(function (s) {
          return '<div class="qf"><label>' + esc(s[1]) + '</label><select data-q="' + s[0] + '" data-id="' + id + '">' +
            s[2].map(function (o) {
              return '<option value="' + o[0] + '"' + (q[s[0]] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
            }).join('') + '</select></div>';
        }).join('') + '</div>' +
        '<div class="qtoggles">' + TOGGLES.map(function (t) {
          return '<button class="chipq' + (q[t[0]] ? ' on' : '') + '" data-qt="' + t[0] + '" data-id="' + id + '">' + esc(t[1]) + '</button>';
        }).join('') + '</div>') +
      (startup
        ? '<div class="qtoggles">' +
          [['startup_chemical','Chemical work'],['startup_programming','Programming'],['startup_pool_school','Pool school']]
            .map(function (t) {
              return '<button class="chipq' + (q[t[0]] ? ' on' : '') + '" data-qt="' + t[0] + '" data-id="' + id + '">' + esc(t[1]) + '</button>';
            }).join('') + '</div>'
        : '') +
      // ── Price adjustments ────────────────────────────────────────────────
      // The rate card is a starting point, not a cage. Same three adjustment
      // kinds the quote tool offers, named identically so the saved row means
      // the same thing either way.
      '<div class="qrow">' +
        '<div class="qf"><label>Adjustment</label><select data-q="discount_type" data-id="' + id + '">' +
          [['none','None'],['Percentage','Percentage off'],['Dollar Amount','Dollar off'],['Custom Price','Set the price']]
            .map(function (o) {
              return '<option value="' + o[0] + '"' + (q.discount_type === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
            }).join('') + '</select></div>' +
        (q.discount_type === 'Custom Price'
          ? '<div class="qf"><label>Price</label><input type="number" step="0.01" min="0" ' +
            'data-q="custom_price" data-id="' + id + '" value="' + esc(q.custom_price) + '" ' +
            'placeholder="above or below the rate card"></div>'
          : q.discount_type !== 'none'
            ? '<div class="qf"><label>' + (q.discount_type === 'Percentage' ? 'Percent' : 'Amount') + '</label>' +
              '<input type="number" step="0.01" min="0" data-q="discount_value" data-id="' + id + '" value="' + esc(q.discount_value) + '"></div>'
            : '') +
        '<div class="qf"><label>Travel fee</label><input type="number" step="0.01" min="0" ' +
          'data-q="travel_fee" data-id="' + id + '" value="' + esc(q.travel_fee) + '"' +
          (q.void_travel ? ' disabled' : '') + '></div>' +
        '<div class="qf" style="justify-content:flex-end"><label>&nbsp;</label>' +
          '<button class="chipq' + (q.void_travel ? ' on' : '') + '" data-qt="void_travel" data-id="' + id + '">No travel</button></div>' +
      '</div>' +
      (p.eng.pricing_ready
        ? '<div class="qprice">' +
            '<div><span>Service</span><b>' + money(p.eng.subtotal) + '</b></div>' +
            (p.discountAmount
              ? (p.discountAmount < 0
                  ? '<div><span>Premium</span><b>+' + money(Math.abs(p.discountAmount)) + '</b></div>'
                  : '<div><span>Discount</span><b>&minus;' + money(p.discountAmount) + '</b></div>')
              : '') +
            (p.travel ? '<div><span>Travel</span><b>' + money(p.travel) + '</b></div>' : '') +
            '<div><span>Tax</span><b>' + money(p.tax) + '</b></div>' +
            '<div class="tot"><span>Total</span><b>' + money(p.total) + '</b></div>' +
          '</div>'
        : '<div class="why"><span>⚠</span><span>' + esc(p.eng.pricing_warning || 'This service needs a price entered by hand.') + '</span></div>') +
      '<div class="qspecs">' + esc(p.eng.specs_summary) + '</div>' +
      (q.error ? '<div class="msg on err">' + esc(q.error) + '</div>' : '') +
      // Creating a quote runs the Apps Script save, which writes the CRM row,
      // the relational tabs and the operational rows. It routinely takes a
      // minute. Saying so is the difference between "working" and "broken".
      (q.busy === 'saving'
        ? '<div class="msg on" style="background:var(--warn-bg);color:var(--warn)">' +
          'Creating the quote — this takes up to a minute. Leave this open.</div>'
        : '') +
      '<div class="acts" style="border-top:0;padding-top:10px">' +
        '<button class="b pri" data-act="quote_save" data-id="' + id + '"' +
          (q.busy || !p.eng.pricing_ready ? ' disabled' : '') + '>' +
          (q.busy === 'saving' ? 'Creating…' : 'Create quote') + '</button>' +
        '<button class="b dim" data-act="quote_hide" data-id="' + id + '">Cancel</button>' +
      '</div>' +
    '</div>';
  }

  // Once a quote exists the card shows the lifecycle instead of the form.
  function quoteProgress(it) {
    var id = esc(it.request_id);
    var q = _quotes[it.request_id] || {};
    var qid = it.converted_quote_id;
    if (!qid) return '';
    return '<div class="quote done">' +
      '<div class="qt">Quote ' + esc(qid) + '</div>' +
      (q.error ? '<div class="msg on err">' + esc(q.error) + '</div>' : '') +
      (q.busy === 'proposal'
        ? '<div class="msg on" style="background:var(--warn-bg);color:var(--warn)">' +
          'Building the proposal PDF — this takes a moment.</div>'
        : '') +
      '<div class="acts" style="border-top:0;padding-top:0">' +
        (q.proposal_url
          ? '<a class="b" href="' + esc(q.proposal_url) + '" target="_blank" rel="noopener">View proposal</a>'
          : '<button class="b" data-act="quote_proposal" data-id="' + id + '"' + (q.busy ? ' disabled' : '') + '>' +
            (q.busy === 'proposal' ? 'Generating…' : 'Generate proposal') + '</button>') +
        (q.proposal_url && !q.sent
          ? '<button class="b pri" data-act="quote_send" data-id="' + id + '"' + (q.busy ? ' disabled' : '') + '>' +
            (q.busy === 'sending' ? 'Sending…' : 'Send for approval') + '</button>'
          : '') +
        (q.sent ? '<span class="b dim" style="border:0">Sent — waiting on the customer to sign</span>' : '') +
        '<a class="b dim" href="/#quotes" target="_blank" rel="noopener">Open in Quote Tool</a>' +
      '</div>' +
    '</div>';
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
    // Quote panel: every change re-prices immediately, so the number on screen
    // is always the number that would be saved.
    // Fields that change which inputs exist need the full rebuild; everything
    // else must not, or it pulls the input out from under the person typing.
    var RESHAPES = { service: 1, discount_type: 1 };
    Array.prototype.forEach.call(document.querySelectorAll('[data-q]'), function (el) {
      var evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        var it = itemById(el.dataset.id);
        if (!it) return;
        quoteState(it)[el.dataset.q] = el.value;
        if (RESHAPES[el.dataset.q]) repaintQuote(el.dataset.id);
        else repaintPrice(el.dataset.id);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-qt]'), function (el) {
      el.addEventListener('click', function () {
        var it = itemById(el.dataset.id);
        if (!it) return;
        var q = quoteState(it);
        q[el.dataset.qt] = !q[el.dataset.qt];
        el.classList.toggle('on', !!q[el.dataset.qt]);
        // void_travel disables the fee input, so the row has to be re-rendered.
        if (el.dataset.qt === 'void_travel') repaintQuote(el.dataset.id);
        else repaintPrice(el.dataset.id);
      });
    });
  }

  function onAction(btn) {
    var act = btn.dataset.act;
    var id = btn.dataset.id;


    // ── Quote flow ─────────────────────────────────────────────────────────
    if (act === 'quote_show') {
      var host = $('qp-' + id);
      if (host) { host.innerHTML = quotePanel(itemById(id)); wire(); }
      return;
    }
    if (act === 'quote_hide') {
      var h2 = $('qp-' + id);
      if (h2) { h2.innerHTML = ''; delete _quotes[id]; }
      return;
    }
    if (act === 'quote_save')     return saveQuote(id, btn);
    if (act === 'quote_proposal') return generateProposal(id, btn);
    if (act === 'quote_send')     return sendProposal(id, btn);

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
    reviewApi('POST', payload).then(function (res) {
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

#page-service_requests .quote{background:var(--gray);border:1px solid var(--line);border-radius:11px;
  padding:15px 17px;margin-top:13px}
#page-service_requests .quote.done{background:var(--ok-bg);border-color:#c9ecdb}
#page-service_requests .quote .qt{font-family:var(--fh);font-weight:700;font-size:10.5px;letter-spacing:.11em;
  text-transform:uppercase;color:var(--teal);margin-bottom:12px}
#page-service_requests .qrow{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:11px}
#page-service_requests .qf{display:flex;flex-direction:column;gap:4px;flex:1;min-width:118px}
#page-service_requests .qf label{font-size:10px;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);font-weight:700;font-family:var(--fh)}
#page-service_requests .qf select,#page-service_requests .qf input{border:1.5px solid var(--line);
  border-radius:8px;padding:8px 10px;font-family:var(--fb);font-size:13.5px;background:#fff;color:var(--ink)}
#page-service_requests .qtoggles{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
#page-service_requests .chipq{border:1.5px solid var(--line);border-radius:999px;background:#fff;
  padding:6px 13px;font-size:12.5px;font-weight:600;color:var(--ink);cursor:pointer;font-family:var(--fb)}
#page-service_requests .chipq:hover{border-color:var(--aqua)}
#page-service_requests .chipq.on{background:var(--aqua);border-color:var(--aqua);color:#fff}
#page-service_requests .qprice{background:#fff;border:1px solid var(--line);border-radius:9px;padding:11px 14px;margin-bottom:10px}
#page-service_requests .qprice div{display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0;color:var(--muted)}
#page-service_requests .qprice div b{color:var(--ink);font-variant-numeric:tabular-nums}
#page-service_requests .qprice .tot{border-top:1px solid var(--line);margin-top:6px;padding-top:8px;font-size:15px}
#page-service_requests .qprice .tot span{color:var(--teal);font-weight:700}
#page-service_requests .qprice .tot b{color:var(--teal);font-family:var(--fh);font-weight:800}
#page-service_requests .qspecs{font-size:11.5px;color:var(--muted);line-height:1.5}
#page-service_requests .sr-pill{background:var(--gray);border-radius:999px;padding:5px 12px;font-size:12px;
  font-weight:700;font-family:var(--fh);color:var(--muted)}
#page-service_requests .spin{width:34px;height:34px;margin:50px auto;border:3px solid var(--line);
  border-top-color:var(--aqua);border-radius:50%;animation:srspin .8s linear infinite}
@keyframes srspin{to{transform:rotate(360deg)}}
`;


  function itemById(id) {
    for (var i = 0; i < STATE.items.length; i++) if (STATE.items[i].request_id === id) return STATE.items[i];
    return null;
  }

  // A FULL rebuild. Only for changes that alter the form's SHAPE — picking a
  // different service, or an adjustment kind that swaps which input is shown.
  function repaintQuote(id) {
    var it = itemById(id);
    var host = $('qp-' + id);
    if (host && it) { host.innerHTML = it.converted_quote_id ? quoteProgress(it) : quotePanel(it); wire(); }
  }

  // ⚠️ Everything else updates ONLY the numbers.
  //
  // Rebuilding the panel on every change tore out the input being typed in —
  // change fires on blur, so the element was replaced mid-blur. The browser
  // complained ("node to be removed is no longer a child"), and the real cost
  // was that focus jumped away every time someone tabbed out of the price box.
  function repaintPrice(id) {
    var it = itemById(id);
    if (!it) return;
    var q = quoteState(it);
    var p = priceOf(q);
    var host = $('q-' + id);
    if (!host || !p) return;

    var box = host.querySelector('.qprice');
    if (box && p.eng.pricing_ready) {
      box.innerHTML =
        '<div><span>Service</span><b>' + money(p.eng.subtotal) + '</b></div>' +
        (p.discountAmount
          ? (p.discountAmount < 0
              ? '<div><span>Premium</span><b>+' + money(Math.abs(p.discountAmount)) + '</b></div>'
              : '<div><span>Discount</span><b>&minus;' + money(p.discountAmount) + '</b></div>')
          : '') +
        (p.travel ? '<div><span>Travel</span><b>' + money(p.travel) + '</b></div>' : '') +
        '<div><span>Tax</span><b>' + money(p.tax) + '</b></div>' +
        '<div class="tot"><span>Total</span><b>' + money(p.total) + '</b></div>';
    }
    var specs = host.querySelector('.qspecs');
    if (specs) specs.textContent = p.eng.specs_summary;
    var save = host.querySelector('[data-act="quote_save"]');
    if (save) save.disabled = !!q.busy || !p.eng.pricing_ready;
  }

  // Same action, same payload shape, same server code path as the quote tool —
  // so a quote raised from a request is not a second class of quote.
  function saveQuote(id, btn) {
    var it = itemById(id), q = quoteState(it);
    var p = priceOf(q);
    if (!p || !p.eng.pricing_ready) return;
    q.busy = 'saving'; q.error = ''; repaintQuote(id);

    var payload = {
      action: 'save_quote', token: token(),
      first_name: q.first_name, last_name: q.last_name, email: q.email, phone: q.phone,
      address: q.address, city: q.city, zip_code: q.zip_code, area: q.area,
      service: p.eng.service_label, pool_type: p.eng.pool_type, size: p.eng.size,
      material: p.eng.material, spa: p.eng.spa, finish: p.eng.finish, debris: p.eng.debris,
      has_robot: q.has_robot, high_sun_exposure: q.high_sun_exposure, has_pets: q.has_pets,
      startup_chemical_work: q.startup_chemical, startup_programming: q.startup_programming,
      startup_pool_school: q.startup_pool_school, startup_company: q.startup_company,
      startup_company_email: q.startup_company_email, sponsored_by_mcp: q.sponsored_by_mcp,
      startup_start_date: q.startup_start_date, startup_total_days: q.sponsored_by_mcp ? 3 : 0,
      repair_job_type: q.service === 'repair_job' ? (q.repair_type || 'Repair') : '',
      repair_invoice_amount: q.service === 'repair_job' ? Number(q.repair_amount) || 0 : 0,
      travel_fee: p.travel,
      service_subtotal: p.eng.subtotal,
      discount_type: q.discount_type === 'none' ? '' : q.discount_type,
      discount_value: q.discount_type === 'Custom Price' ? q.custom_price : q.discount_value,
      discount_amount: p.discountAmount,
      discounted_service_subtotal: p.discounted,
      quote_subtotal: p.subtotal, sales_tax: p.tax, total_with_tax: p.total,
      chem_cost_est: p.eng.chem_cost,
      net_profit_est: Math.round((p.subtotal - p.eng.chem_cost) * 100) / 100,
      margin_percent: p.subtotal ? Math.round((p.subtotal - p.eng.chem_cost) / p.subtotal * 1000) / 10 : 0,
      specs_summary: p.eng.specs_summary,
      quickbooks_skus: (p.eng.qb_skus || []).join(', '),
      quickbooks_item_names: (p.eng.qb_names || []).join(', '),
      created_by: (typeof _s !== 'undefined' && _s && _s.name) || 'portal',
      // Recorded so a quote raised from a request is traceable to it later.
      quote_source: 'service_request',
      quote_version: '2.0',
      sales_flow: 'proposal_first',
      signature_required: 'TRUE',
      activation_method: 'SIGNED_AGREEMENT',
      status: 'UNSENT'
    };

    // Fast path first. Apps Script's save_quote takes ~80s because it fans out
    // across six relational tabs on every save; the Sheets API writes the flat
    // row in about a second, and generate_proposal performs that fan-out itself
    // (idempotently) when a proposal is actually needed.
    //
    // Green-to-clean and startups still go through Apps Script — those mint a
    // pool_id and write Routes rows, and skipping that would leave a customer
    // with no pool and no route.
    var quotePromise = FAST_SERVICES.indexOf(p.eng.service_label) !== -1
      ? reviewApi('POST', Object.assign({}, payload, { action: undefined }), 'quote')
          .then(function (r) {
            if (r && r.code === 'needs_apps_script') return gasApi(payload);
            return r;
          })
      : gasApi(payload);

    quotePromise.then(function (res) {
      q.busy = '';
      if (!res || !res.ok) { q.error = (res && res.error) || 'Could not create the quote.'; return repaintQuote(id); }
      // Stamp it on the request so the link survives a reload.
      return reviewApi('POST', { action: 'link_quote', request_id: id, quote_id: res.quote_id })
        .then(function () {
          toast('Quote ' + res.quote_id + ' created.', 'ok');
          load();
        });
    }).catch(function () {
      q.busy = ''; q.error = 'Network error — check the connection.'; repaintQuote(id);
    });
  }

  function generateProposal(id, btn) {
    var it = itemById(id), q = quoteState(it);
    q.busy = 'proposal'; q.error = ''; repaintQuote(id);
    gasApi({ action: 'generate_proposal', token: token(), quote_id: it.converted_quote_id })
      .then(function (res) {
        q.busy = '';
        if (res && res.ok) { q.proposal_url = res.proposal_pdf_url || ''; toast('Proposal generated.', 'ok'); }
        else q.error = (res && res.error) || 'Proposal generation failed.';
        repaintQuote(id);
      })
      .catch(function () { q.busy = ''; q.error = 'Network error.'; repaintQuote(id); });
  }

  function sendProposal(id, btn) {
    var it = itemById(id), q = quoteState(it);
    q.busy = 'sending'; q.error = ''; repaintQuote(id);
    gasApi({ action: 'send_proposal_for_approval', token: token(), quote_id: it.converted_quote_id })
      .then(function (res) {
        q.busy = '';
        if (res && res.ok) {
          q.sent = true;
          toast('Sent to ' + (it.email || 'the customer') + ' for signature.', 'ok');
        } else q.error = (res && res.error) || 'Could not send the proposal.';
        repaintQuote(id);
      })
      .catch(function () { q.busy = ''; q.error = 'Network error.'; repaintQuote(id); });
  }

  // The quote lifecycle lives in Apps Script, not in the Vercel endpoints, so
  // these go through the portal's own global api(). Referenced off window
  // deliberately: a bare `api` would resolve to whatever this file happens to
  // have in scope, which is how the shadowing bug above happened.
  function gasApi(payload) {
    if (typeof window.api === 'function') return window.api(payload);
    return fetch('/api/gas', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload) }).then(function (r) { return r.json(); });
  }

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
