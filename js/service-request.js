// ══════════════════════════════════════════════════════════════════════════════
// SERVICE REQUEST — public customer page
//
// ⚠️ This file deliberately does NOT load js/lib/constants.js or js/lib/api.js.
//    constants.js ships the webhook secret SEC to every page that includes it,
//    and api.js auto-injects the staff session token from localStorage into any
//    payload that omits `token` — so a logged-in admin opening this page would
//    silently send their staff session to a public endpoint. A page that never
//    loads api.js cannot have that bug. The 15-line post() below is the reason
//    the whole file is standalone.
//
// Everything renders client-side into #app. No navigation between steps, so the
// only network calls are the prefill (parallel with first paint), the photo
// uploads (in the background as they are picked) and the final submit.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var DRAFT_KEY = 'mcps_sr_draft';
  var DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  var MAX_PHOTOS = 4;
  var CONTACT = { phone: '', phone_href: '', email: '' };  // filled by CONFIG below

  // Single place to change the office contact details shown in the footer and
  // in the "call us instead" fallbacks.
  var CONFIG = window.MCPS_SERVICE_REQUEST_CONFIG || {};
  CONTACT.phone = CONFIG.phone || '(210) 559-2073';
  CONTACT.email = CONFIG.email || 'antonio@mcpoolsolutions.org';
  CONTACT.phone_href = 'tel:+1' + CONTACT.phone.replace(/\D/g, '');

  var params = new URLSearchParams(location.search);
  var LINK_TOKEN = params.get('k') || '';
  var CAMPAIGN = (params.get('c') || '').slice(0, 60);
  var REF_LOOKUP = params.get('r') || '';

  // ── State ────────────────────────────────────────────────────────────────
  var S = {
    step: 1,
    category: '',
    subcategory: '',
    description: '',
    first_name: '', last_name: '', email: '', phone: '',
    service_address: '', city: '', zip_code: '',
    timing_preference: 'flexible',
    timing_notes: '',
    photos: [],          // { id, dataUrl, url, state:'uploading'|'done'|'failed' }
    draft_id: '',
    prefilled: false,
    errors: {}
  };

  var CATEGORIES = [
    { key: 'green_to_clean', title: 'My pool is green',
      desc: 'Algae, cloudy or swampy water that needs a full cleanup',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#1FA7A8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 5.3 6 9.6A6 6 0 0 1 6 12.6C6 8.3 12 3 12 3z"/></svg>' },
    { key: 'repair', title: 'Something is broken',
      desc: 'Pump, filter, heater, salt system, lights or a leak',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#1FA7A8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 1 5 5L18 13l-7 7-4-4 7-7 .7-2.7z"/><path d="m5 19 2-2"/></svg>' },
    { key: 'weekly_service', title: 'I want regular service',
      desc: 'Weekly pool care — cleaning, chemicals and equipment checks',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#1FA7A8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m9 15 2 2 4-4"/></svg>' },
    { key: 'one_time', title: 'Something else',
      desc: 'One-time clean, filter clean, drain and fill, vacation coverage',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#1FA7A8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>' }
  ];

  var SUBS = {
    repair: [
      ['pump', 'Pump'], ['filter', 'Filter'], ['heater', 'Heater'],
      ['salt_system', 'Salt system'], ['chlorinator', 'Chlorinator'], ['lights', 'Lights'],
      ['leak', 'A leak'], ['automation', 'Automation'], ['plumbing', 'Plumbing'],
      ['surface', 'Pool surface'], ['other', "I'm not sure"]
    ],
    green_to_clean: [
      ['few_weeks', 'A few weeks'], ['a_month', 'About a month'],
      ['several_months', 'Several months'], ['unsure', "I'm not sure"]
    ],
    weekly_service: [
      ['no_current_service', 'No service right now'], ['switching_companies', 'Switching companies'],
      ['doing_it_myself', "I've been doing it myself"], ['unsure', 'Something else']
    ],
    one_time: [
      ['single_clean', 'A single clean'], ['pre_event_clean', 'Before an event'],
      ['filter_clean', 'Filter clean'], ['drain_and_fill', 'Drain and fill'],
      ['vacation_coverage', 'Vacation coverage'], ['water_test', 'Water test'], ['other', 'Something else']
    ]
  };

  var SUB_PROMPT = {
    repair: 'What seems to be the problem?',
    green_to_clean: 'How long has it looked like this?',
    weekly_service: "What's the situation today?",
    one_time: 'What do you need?'
  };

  var TIMING = [
    ['asap', 'As soon as possible'], ['this_week', 'This week'],
    ['next_week', 'Next week'], ['flexible', "I'm flexible"]
  ];

  var WANTS_PHOTOS = { green_to_clean: 1, repair: 1, one_time: 1 };

  // ── Helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }
  function app() { return $('app'); }

  function post(payload) {
    return fetch('/api/service-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  function catMeta(key) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].key === key) return CATEGORIES[i];
    return null;
  }
  function subLabel(cat, key) {
    var list = SUBS[cat] || [];
    for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1];
    return '';
  }
  function timingLabel(key) {
    for (var i = 0; i < TIMING.length; i++) if (TIMING[i][0] === key) return TIMING[i][1];
    return '';
  }

  // ── Draft persistence ────────────────────────────────────────────────────
  // A customer who bounces mid-form comes back to where they were. Photos are
  // not stored: their data URLs would blow the localStorage quota, and the
  // uploaded copies are already safe on the server.
  function saveDraft() {
    try {
      var copy = {};
      Object.keys(S).forEach(function (k) {
        if (k !== 'photos' && k !== 'errors') copy[k] = S[k];
      });
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), data: copy }));
    } catch (_) { /* private mode, quota — never block the form on this */ }
  }
  function loadDraft() {
    try {
      var raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!raw || !raw.data) return null;
      if (Date.now() - raw.ts > DRAFT_TTL_MS) { localStorage.removeItem(DRAFT_KEY); return null; }
      return raw.data;
    } catch (_) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} }

  // ── Progress ─────────────────────────────────────────────────────────────
  function renderSteps() {
    var el = $('steps');
    if (!el) return;
    if (S.step > 5) { el.innerHTML = ''; return; }
    var out = '';
    for (var i = 1; i <= 5; i++) out += '<span class="' + (i <= S.step ? 'on' : '') + '"></span>';
    el.innerHTML = out;
  }

  function go(step) {
    S.step = step;
    S.errors = {};
    saveDraft();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render() {
    renderSteps();
    if (S.step === 1) return renderCategory();
    if (S.step === 2) return renderDetail();
    if (S.step === 3) return renderWhere();
    if (S.step === 4) return renderWhen();
    if (S.step === 5) return renderReview();
  }

  // ── Step 1 — what do you need ────────────────────────────────────────────
  function renderCategory() {
    var greet = S.prefilled && S.first_name
      ? '<div class="notice">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1FA7A8" stroke-width="2" stroke-linecap="round"><path d="m5 12 5 5L20 7"/></svg>' +
          '<div>Welcome back, <b>' + esc(S.first_name) + '</b>.' +
          (S.service_address ? ' We have your pool at ' + esc(S.service_address) + '.' : '') +
          ' <button class="editlink" id="not-me">Not you?</button></div></div>'
      : '';

    app().innerHTML =
      greet +
      '<div class="eyebrow">Step 1 of 5</div>' +
      '<h2>What does your pool need?</h2>' +
      '<p class="sub">Pick the one that fits best. You can add details next.</p>' +
      '<div class="picks">' +
        CATEGORIES.map(function (c) {
          return '<button class="pick' + (S.category === c.key ? ' sel' : '') + '" data-cat="' + c.key + '">' +
            '<span class="ic">' + c.icon + '</span>' +
            '<span><span class="t">' + esc(c.title) + '</span><span class="d">' + esc(c.desc) + '</span></span>' +
            '<svg class="go" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>' +
            '</button>';
        }).join('') +
      '</div>';

    Array.prototype.forEach.call(document.querySelectorAll('.pick'), function (b) {
      b.addEventListener('click', function () {
        if (S.category !== b.dataset.cat) { S.subcategory = ''; }
        S.category = b.dataset.cat;
        go(2);
      });
    });
    var nm = $('not-me');
    if (nm) nm.addEventListener('click', function () {
      S.prefilled = false;
      S.first_name = ''; S.last_name = ''; S.service_address = ''; S.city = ''; S.zip_code = '';
      render();
    });
  }

  // ── Step 2 — tell us about it ────────────────────────────────────────────
  function renderDetail() {
    var cat = S.category;
    var meta = catMeta(cat);
    var showPhotos = !!WANTS_PHOTOS[cat];

    app().innerHTML =
      '<div class="eyebrow">Step 2 of 5</div>' +
      '<h2>' + esc(meta ? meta.title : 'Tell us more') + '</h2>' +
      '<p class="sub">' + esc(SUB_PROMPT[cat] || '') + '</p>' +
      '<div class="chips" id="subs">' +
        (SUBS[cat] || []).map(function (s) {
          return '<button class="chip' + (S.subcategory === s[0] ? ' on' : '') + '" data-sub="' + s[0] + '">' + esc(s[1]) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="fld full" style="margin-top:18px">' +
        '<label for="desc">Anything else we should know? <span class="opt">(optional)</span></label>' +
        '<textarea id="desc" placeholder="' + esc(placeholderFor(cat)) + '" maxlength="2000">' + esc(S.description) + '</textarea>' +
      '</div>' +
      (showPhotos ?
        '<div style="margin-top:20px">' +
          '<label style="font-size:12.5px;font-weight:700;color:var(--muted)">Photos <span class="opt">(optional — they help us quote faster)</span></label>' +
          '<div class="photos" id="photos"></div>' +
          '<input type="file" id="file" accept="image/*" multiple class="sr">' +
        '</div>' : '') +
      '<div class="actions">' +
        '<button class="btn ghost" id="back">Back</button>' +
        '<button class="btn primary wide" id="next">Continue</button>' +
      '</div>';

    Array.prototype.forEach.call(document.querySelectorAll('#subs .chip'), function (b) {
      b.addEventListener('click', function () {
        S.subcategory = S.subcategory === b.dataset.sub ? '' : b.dataset.sub;
        saveDraft();
        Array.prototype.forEach.call(document.querySelectorAll('#subs .chip'), function (o) {
          o.classList.toggle('on', o.dataset.sub === S.subcategory);
        });
      });
    });
    $('desc').addEventListener('input', function (e) { S.description = e.target.value; saveDraft(); });
    $('back').addEventListener('click', function () { go(1); });
    $('next').addEventListener('click', function () { go(3); });
    if (showPhotos) { renderPhotos(); wirePhotoInput(); }
  }

  function placeholderFor(cat) {
    if (cat === 'repair') return 'The pump has been making a grinding noise since last week.';
    if (cat === 'green_to_clean') return "We were away for a month and it's completely green.";
    if (cat === 'weekly_service') return 'Anything you want us to know about the pool or the property.';
    return 'Tell us what you have in mind.';
  }

  // ── Photos ───────────────────────────────────────────────────────────────
  function wirePhotoInput() {
    var input = $('file');
    if (!input) return;
    input.addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      files.slice(0, MAX_PHOTOS - S.photos.length).forEach(addPhoto);
      input.value = '';
    });
  }

  function renderPhotos() {
    var box = $('photos');
    if (!box) return;
    var html = S.photos.map(function (p) {
      return '<div class="photo ' + (p.state === 'done' ? 'done' : '') + (p.state === 'failed' ? ' failed' : '') + '" data-id="' + p.id + '">' +
        '<img src="' + p.dataUrl + '" alt="">' +
        '<button class="rm" data-rm="' + p.id + '" aria-label="Remove photo">&times;</button>' +
        (p.state === 'failed' ? '<div class="warn">Upload failed</div>' : '<div class="bar"></div>') +
        '</div>';
    }).join('');
    if (S.photos.length < MAX_PHOTOS) {
      html += '<button class="addphoto" id="addphoto">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="#0D3D3E" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' +
        'Add photo</button>';
    }
    box.innerHTML = html;
    var add = $('addphoto');
    if (add) add.addEventListener('click', function () { $('file').click(); });
    Array.prototype.forEach.call(box.querySelectorAll('.rm'), function (b) {
      b.addEventListener('click', function () {
        S.photos = S.photos.filter(function (p) { return p.id !== b.dataset.rm; });
        renderPhotos();
      });
    });
  }

  // Resize before upload. A modern phone photo is 4-12 MB; at 1600px/q0.75 it is
  // typically under 500 KB, which is the difference between an upload that
  // finishes while the customer fills in the next field and one that doesn't.
  function resize(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('read failed')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('decode failed')); };
        img.onload = function () {
          var max = 1600;
          var w = img.width, h = img.height;
          if (w > max || h > max) {
            if (w > h) { h = Math.round(h * max / w); w = max; }
            else { w = Math.round(w * max / h); h = max; }
          }
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.75));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function addPhoto(file) {
    if (!/^image\//.test(file.type)) return;
    if (!S.draft_id) {
      S.draft_id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      saveDraft();
    }
    var id = 'p' + Math.random().toString(36).slice(2, 10);
    var entry = { id: id, dataUrl: '', url: '', state: 'uploading' };
    S.photos.push(entry);

    resize(file).then(function (dataUrl) {
      entry.dataUrl = dataUrl;
      renderPhotos();
      // Uploads start the moment a photo is picked, so by the time the customer
      // reaches Review the URLs are already attached and Send is instant.
      return fetch('/api/service-request-photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft_id: S.draft_id, data_url: dataUrl, name: file.name })
      }).then(function (r) { return r.json(); });
    }).then(function (res) {
      if (res && res.ok && res.url) { entry.url = res.url; entry.state = 'done'; }
      else { entry.state = 'failed'; }
      renderPhotos();
    }).catch(function () {
      entry.state = 'failed';
      renderPhotos();
    });
  }

  // ── Step 3 — where ───────────────────────────────────────────────────────
  function renderWhere() {
    app().innerHTML =
      '<div class="eyebrow">Step 3 of 5</div>' +
      '<h2>Where is the pool?</h2>' +
      '<p class="sub">So we know whose pool we\'re looking at and how to reach you.</p>' +
      '<div class="fgrid">' +
        fld('first_name', 'First name', 'text', 'given-name', 'full') +
        fld('last_name', 'Last name', 'text', 'family-name') +
        fld('phone', 'Phone', 'tel', 'tel') +
        fld('email', 'Email', 'email', 'email', 'full') +
        fld('service_address', 'Street address', 'text', 'street-address', 'full') +
        fld('city', 'City', 'text', 'address-level2') +
        fld('zip_code', 'ZIP', 'text', 'postal-code') +
      '</div>' +
      '<div class="msg err" id="msg"></div>' +
      '<div class="actions">' +
        '<button class="btn ghost" id="back">Back</button>' +
        '<button class="btn primary wide" id="next">Continue</button>' +
      '</div>';

    ['first_name', 'last_name', 'phone', 'email', 'service_address', 'city', 'zip_code'].forEach(function (k) {
      var el = $('f_' + k);
      el.addEventListener('input', function (e) {
        S[k] = e.target.value;
        el.parentNode.classList.remove('bad');
        saveDraft();
      });
    });
    $('back').addEventListener('click', function () { go(2); });
    $('next').addEventListener('click', function () {
      if (!validateWhere()) return;
      go(4);
    });
  }

  function fld(key, label, type, ac, full) {
    var bad = S.errors[key];
    return '<div class="fld ' + (full ? 'full ' : '') + (bad ? 'bad' : '') + '">' +
      '<label for="f_' + key + '">' + esc(label) + '</label>' +
      '<input id="f_' + key + '" type="' + type + '" autocomplete="' + ac + '" value="' + esc(S[key]) + '"' +
      (type === 'email' ? ' inputmode="email"' : '') +
      (type === 'tel' ? ' inputmode="tel"' : '') +
      (key === 'zip_code' ? ' inputmode="numeric" maxlength="10"' : '') + '>' +
      (bad ? '<span class="err">' + esc(bad) + '</span>' : '') +
      '</div>';
  }

  function validateWhere() {
    S.errors = {};
    if (!S.service_address.trim()) S.errors.service_address = 'We need the address of the pool.';

    var typedEmail = S.email.trim();
    var typedPhone = S.phone.trim();
    var hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(typedEmail);
    var digits = S.phone.replace(/\D/g, '');
    var hasPhone = digits.length === 10 || (digits.length === 11 && digits[0] === '1');

    // Say what is actually wrong. "Add an email or a phone" is unhelpful when
    // the customer clearly typed one and got a character wrong.
    if (typedEmail && !hasEmail) S.errors.email = 'That email looks incomplete. Please check it.';
    if (typedPhone && !hasPhone) S.errors.phone = 'That phone number needs 10 digits.';
    if (!hasEmail && !hasPhone && !typedEmail && !typedPhone) {
      S.errors.email = 'Add an email address or a phone number so we can reach you.';
      S.errors.phone = ' ';   // highlighted, but the message is shown once
    }

    if (!Object.keys(S.errors).length) return true;

    // Re-rendering the step throws away focus and scroll position, which on a
    // phone leaves the customer staring at the top of a form whose problem is
    // somewhere below. Put them on the first bad field instead.
    var first = ['service_address', 'email', 'phone'].filter(function (k) { return S.errors[k]; })[0];
    render();
    var msg = $('msg');
    if (msg) { msg.textContent = 'Please check the highlighted fields.'; msg.classList.add('show'); }
    var el = first && $('f_' + first);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // A focus() during a smooth scroll fights it on iOS; let the scroll land.
      setTimeout(function () { try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); } }, 260);
    }
    return false;
  }

  // ── Step 4 — when ────────────────────────────────────────────────────────
  function renderWhen() {
    app().innerHTML =
      '<div class="eyebrow">Step 4 of 5</div>' +
      '<h2>How soon do you need us?</h2>' +
      '<p class="sub">We\'ll confirm the exact day with you — this just tells us how to prioritise.</p>' +
      '<div class="chips" id="timing">' +
        TIMING.map(function (t) {
          return '<button class="chip' + (S.timing_preference === t[0] ? ' on' : '') + '" data-t="' + t[0] + '">' + esc(t[1]) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="fld full" style="margin-top:18px">' +
        '<label for="tnotes">Any days or times that don\'t work? <span class="opt">(optional)</span></label>' +
        '<textarea id="tnotes" placeholder="Mornings are best. Please don\'t come Thursday." maxlength="500">' + esc(S.timing_notes) + '</textarea>' +
      '</div>' +
      '<div class="actions">' +
        '<button class="btn ghost" id="back">Back</button>' +
        '<button class="btn primary wide" id="next">Continue</button>' +
      '</div>';

    Array.prototype.forEach.call(document.querySelectorAll('#timing .chip'), function (b) {
      b.addEventListener('click', function () {
        S.timing_preference = b.dataset.t;
        saveDraft();
        Array.prototype.forEach.call(document.querySelectorAll('#timing .chip'), function (o) {
          o.classList.toggle('on', o.dataset.t === S.timing_preference);
        });
      });
    });
    $('tnotes').addEventListener('input', function (e) { S.timing_notes = e.target.value; saveDraft(); });
    $('back').addEventListener('click', function () { go(3); });
    $('next').addEventListener('click', function () { go(5); });
  }

  // ── Step 5 — review ──────────────────────────────────────────────────────
  function renderReview() {
    var meta = catMeta(S.category);
    var name = [S.first_name, S.last_name].filter(Boolean).join(' ');
    var addr = [S.service_address, S.city, S.zip_code].filter(Boolean).join(', ');
    var uploading = S.photos.filter(function (p) { return p.state === 'uploading'; }).length;
    var okPhotos = S.photos.filter(function (p) { return p.state === 'done'; }).length;

    app().innerHTML =
      '<div class="eyebrow">Step 5 of 5</div>' +
      '<h2>Does this look right?</h2>' +
      '<p class="sub">We\'ll review it and get back to you with a day and a price.</p>' +
      '<div class="rev">' +
        row('What you need', (meta ? meta.title : '') + (S.subcategory ? ' · ' + subLabel(S.category, S.subcategory) : ''), 2, true) +
        (S.description ? row('Details', S.description, 2) : '') +
        (S.photos.length ? row('Photos', okPhotos + ' attached' + (uploading ? ' · ' + uploading + ' still uploading' : ''), 2) : '') +
        row('Name', name || '—', 3) +
        row('Contact', [S.phone, S.email].filter(Boolean).join(' · ') || '—', 3) +
        row('Pool address', addr || '—', 3) +
        row('Timing', timingLabel(S.timing_preference) + (S.timing_notes ? ' · ' + S.timing_notes : ''), 4) +
      '</div>' +
      '<div class="msg err" id="msg"></div>' +
      '<div class="actions">' +
        '<button class="btn ghost" id="back">Back</button>' +
        '<button class="btn primary wide" id="send">Send request</button>' +
      '</div>' +
      '<p class="muted" style="font-size:12.5px;margin:14px 0 0;text-align:center">' +
        'We\'ll confirm your day and price before any work begins.</p>';

    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
      b.addEventListener('click', function () { go(Number(b.dataset.edit)); });
    });
    $('back').addEventListener('click', function () { go(4); });
    $('send').addEventListener('click', submit);

    // Submitting mid-upload silently drops the photo — the customer attached it,
    // watched it appear, and it never arrives. Hold the button and re-check,
    // rather than letting them send an incomplete request.
    if (uploading) waitForUploads();
  }

  function row(k, v, editStep, strong) {
    return '<div class="row"><div class="k">' + esc(k) +
      (editStep ? '<br><button class="editlink" data-edit="' + editStep + '">Change</button>' : '') +
      '</div><div class="v' + (strong ? ' strong' : '') + '">' + esc(v) + '</div></div>';
  }

  function waitForUploads() {
    var btn = $('send');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Finishing photos...';
    var tries = 0;
    var poll = setInterval(function () {
      var left = S.photos.filter(function (p) { return p.state === 'uploading'; }).length;
      // 30s ceiling: a stuck upload must not trap someone on the review screen.
      // Failed photos are simply left off, which the customer can see.
      if (!left || ++tries > 60) {
        clearInterval(poll);
        if (!$('send')) return;
        $('send').disabled = false;
        $('send').textContent = 'Send request';
        if (S.step === 5) render();
      }
    }, 500);
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  function submit() {
    var btn = $('send');
    var msg = $('msg');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    msg.classList.remove('show');

    post({
      category: S.category,
      subcategory: S.subcategory,
      description: S.description,
      first_name: S.first_name,
      last_name: S.last_name,
      email: S.email,
      phone: S.phone,
      service_address: S.service_address,
      city: S.city,
      zip_code: S.zip_code,
      timing_preference: S.timing_preference,
      timing_notes: S.timing_notes,
      campaign_id: CAMPAIGN,
      draft_id: S.draft_id,
      photo_urls: S.photos.filter(function (p) { return p.state === 'done'; }).map(function (p) { return p.url; }),
      k: LINK_TOKEN
    }).then(function (res) {
      if (res && res.ok) { clearDraft(); return renderDone(res); }
      btn.disabled = false;
      btn.textContent = 'Send request';
      msg.textContent = (res && res.error) || 'We could not send your request. Please try again.';
      msg.classList.add('show');
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Send request';
      msg.textContent = 'We could not reach our system. Please check your connection and try again.';
      msg.classList.add('show');
    });
  }

  function renderDone(res) {
    S.step = 6;
    renderSteps();
    app().innerHTML =
      '<div class="done">' +
        '<div class="tick"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#067647" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg></div>' +
        '<h2>' + (res.updated ? 'Your request is updated' : 'Request received') + '</h2>' +
        '<p class="sub" style="margin-bottom:0">Thank you' + (S.first_name ? ', ' + esc(S.first_name) : '') + '. ' +
          'A member of our team will contact you within one business day to confirm the day and the price.</p>' +
        '<div class="refbox"><div class="lbl">Your reference number</div>' +
          '<div class="ref">' + esc(res.request_id) + '</div></div>' +
        '<p class="muted" style="font-size:13.5px">Keep this number handy. You can ' +
          '<a href="?r=' + encodeURIComponent(res.request_id) + '" style="color:var(--aqua);font-weight:600">check the status</a> ' +
          'any time, or call us at <a href="' + CONTACT.phone_href + '" style="color:var(--aqua);font-weight:600">' + esc(CONTACT.phone) + '</a>.</p>' +
        '<p class="muted" style="font-size:12.5px;margin-top:20px">Thank you for choosing Mission Custom Pool Solutions.</p>' +
      '</div>';
  }

  // ── Status view (?r=) ────────────────────────────────────────────────────
  function renderStatus(ref) {
    S.step = 6;
    renderSteps();
    app().innerHTML = '<div class="eyebrow">Request status</div><h2>Looking up ' + esc(ref) + '</h2><div class="spin"></div>';
    fetch('/api/service-request?r=' + encodeURIComponent(ref))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) {
          app().innerHTML =
            '<div class="eyebrow">Request status</div>' +
            '<h2>We couldn\'t find that reference</h2>' +
            '<p class="sub">Please check the number, or call us at <a href="' + CONTACT.phone_href + '">' + esc(CONTACT.phone) + '</a> and we\'ll look it up for you.</p>' +
            '<div class="actions"><a class="btn primary" href="/service">Start a new request</a></div>';
          return;
        }
        app().innerHTML =
          '<div class="eyebrow">Request status</div>' +
          '<h2>' + esc(res.status) + '</h2>' +
          '<div class="refbox"><div class="lbl">Reference</div><div class="ref">' + esc(res.request_id) + '</div></div>' +
          '<p class="sub">' + esc(statusCopy(res.status)) + '</p>' +
          '<div class="actions">' +
            '<a class="btn" href="' + CONTACT.phone_href + '">Call us</a>' +
            '<a class="btn ghost" href="/service">Start a new request</a>' +
          '</div>';
      })
      .catch(function () {
        app().innerHTML = '<h2>We couldn\'t reach our system</h2><p class="sub">Please try again in a moment.</p>';
      });
  }

  function statusCopy(status) {
    if (status === 'Scheduled') return 'You\'re on the schedule. We\'ll be in touch with the details.';
    if (status === 'In review') return 'We have your request and we\'re working out the details. You\'ll hear from us within one business day.';
    if (status === 'Quote sent') return 'We\'ve sent you a quote. Check your email — and let us know if you have questions.';
    if (status === 'Closed') return 'This request is closed. If you still need help, please start a new request or give us a call.';
    return 'We have your request. A member of our team will contact you within one business day.';
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    $('foot-contact').innerHTML =
      'Questions? <a href="' + CONTACT.phone_href + '">' + esc(CONTACT.phone) + '</a> · ' +
      '<a href="mailto:' + esc(CONTACT.email) + '">' + esc(CONTACT.email) + '</a>';

    if (REF_LOOKUP) return renderStatus(REF_LOOKUP);

    var draft = loadDraft();
    if (draft) {
      Object.keys(draft).forEach(function (k) { if (k in S) S[k] = draft[k]; });
      S.step = Math.min(S.step || 1, 5);
      S.photos = [];   // uploaded copies survive; local previews do not
    }

    render();

    // Fire-and-forget warm-up. Minting the Google token and loading the match
    // snapshot is most of the submit latency, and doing it now — while the
    // customer is still choosing a category — takes it off the critical path.
    fetch('/api/service-request?warm=1').catch(function () {});

    // Prefill resolves alongside first paint. The form is already usable, so a
    // slow or failed lookup costs nothing — and an invalid, expired or forwarded
    // link falls through to the address form rather than a dead end.
    if (LINK_TOKEN && !draft) {
      fetch('/api/service-request?k=' + encodeURIComponent(LINK_TOKEN))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || !res.ok || !res.prefill) return;
          var p = res.prefill;
          if (!S.first_name) S.first_name = p.first_name || '';
          if (!S.service_address) S.service_address = p.service_address || '';
          if (!S.city) S.city = p.city || '';
          if (!S.zip_code) S.zip_code = p.zip_code || '';
          S.prefilled = !!(p.first_name || p.service_address);
          saveDraft();
          if (S.step === 1) render();
        })
        .catch(function () { /* silent: the form already works */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
