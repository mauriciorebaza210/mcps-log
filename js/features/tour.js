// ══════════════════════════════════════════════════════════════════════════════
// TOUR — technician onboarding walkthrough (Driver.js v1.4)
// Vendored at /js/lib/vendor/driver.iife.min.js
// Depends on: constants.js (escHtml), api.js (api), auth.js (_s, _curPage),
//             router.js (navigateTo), routes.js (switchHubTab)
// ══════════════════════════════════════════════════════════════════════════════

var TOUR_VERSION    = 'technician-tour-v1';
var TOUR_STEP_COUNT = 15;
var TOUR_DEMO_POOL  = 'Bullock - Weekly Full Service - 24102 Shelton Spring - MCPS-0017';
var TOUR_DEMO_READINGS = [
  { fc:'1.2', ph:'7.9', ta:'70',  ch:'220', tablet:'low',    size:'medium', mat:'plaster' },
  { fc:'2.4', ph:'8.1', ta:'90',  ch:'260', tablet:'medium', size:'medium', mat:'plaster' },
  { fc:'4.6', ph:'7.4', ta:'75',  ch:'480', tablet:'low',    size:'large',  mat:'plaster' },
  { fc:'1.8', ph:'7.7', ta:'110', ch:'310', tablet:'full',   size:'medium', mat:'fiberglass' }
];

window._tourActive               = false;
window._tourAttemptedThisSession = false;
window._tourForceMode            = false; // true when launched via ?tour=force — suppresses server writes

// ─── State helpers ─────────────────────────────────────────────────────────────

function _getTourStatus() {
  return (_s && _s.tutorial_status) ? String(_s.tutorial_status) : 'not_started';
}

// Write tutorial state to _s + localStorage cache, then sync to server.
// fireAndForget=true → no callbacks (for in_progress / start events).
// For completed/skipped: await server with retry; call onSuccess or onError.
function _setTourState(status, extra, opts) {
  opts           = opts || {};
  var ff         = !!opts.fireAndForget;
  var retries    = (opts.retries !== undefined) ? opts.retries : 2;
  var onSuccess  = opts.onSuccess || null;
  var onError    = opts.onError   || null;

  if (!_s) return;
  // Suppress all state writes when admin is previewing via ?tour=force
  if (window._tourForceMode) return;

  _s.tutorial_status  = status;
  _s.tutorial_version = TOUR_VERSION;
  if (extra && extra.started_at)   _s.tutorial_started_at    = extra.started_at;
  if (extra && extra.completed_at) _s.tutorial_completed_at  = extra.completed_at;
  try { localStorage.setItem('mcps_s', JSON.stringify(_s)); } catch(e) {}

  var payload = {
    action:                'set_tutorial_state',
    token:                 _s.token,
    target_username:       _s.username,
    tutorial_status:       status,
    tutorial_version:      TOUR_VERSION,
    tutorial_started_at:   _s.tutorial_started_at   || '',
    tutorial_completed_at: _s.tutorial_completed_at || ''
  };

  if (ff) { api(payload).catch(function() {}); return; }

  api(payload).then(function(res) {
    if (res && res.ok) { if (onSuccess) onSuccess(); }
    else throw new Error((res && res.error) || 'Server error');
  }).catch(function(err) {
    if (retries > 0) {
      setTimeout(function() {
        _setTourState(status, extra, { fireAndForget: false, retries: retries - 1, onSuccess: onSuccess, onError: onError });
      }, 2500);
    } else {
      if (onError) onError(err);
    }
  });
}

// ─── Entry point (called from showApp and triggerGraduation) ──────────────────

function checkAndLaunchTour() {
  if (!_s) return;
  var eligible = (_s.roles || []).some(function(r) { return r === 'technician' || r === 'lead'; });
  if (!eligible) return;
  if (_curPage !== 'home') return;
  if (window._tourAttemptedThisSession) return;
  window._tourAttemptedThisSession = true;

  var status = _getTourStatus();
  if (status === 'completed' || status === 'skipped') return;

  if (status === 'in_progress') {
    setTimeout(_showResumePrompt, 800);
  } else {
    // not_started (or blank)
    setTimeout(_showWelcomeModal, 800);
  }
}

// Force-launch — caller must have already validated admin role.
// Sets _tourForceMode so no state is written to localStorage or the server.
// If the admin is currently in admin dashboard view, switches to technician
// view first so all tour targets are visible.
function forceLaunchTour() {
  window._tourAttemptedThisSession = true;
  window._tourForceMode            = true;

  var tds = document.getElementById('tech-home-dashboard');
  var needsSwitch = !tds || tds.style.display === 'none' || tds.style.display === '';

  if (needsSwitch && typeof loadHomeStats === 'function') {
    window._homeViewOverride = 'technician';
    loadHomeStats().then(function() {
      setTimeout(_showWelcomeModal, 400);
    }).catch(function() {
      setTimeout(_showWelcomeModal, 400);
    });
  } else {
    _showWelcomeModal();
  }
}

// Self-service restart (profile tab "Restart Tutorial" button)
function restartTour() {
  if (_driverInstance) { try { _driverInstance.destroy(); } catch(e) {} _driverInstance = null; }
  window._tourActive               = false;
  window._tourAttemptedThisSession = false;
  _setTourState('not_started', {}, { fireAndForget: true });
  navigateTo('home');
  setTimeout(_showWelcomeModal, 500);
}

// ─── Welcome modal (not_started) ──────────────────────────────────────────────

function _showWelcomeModal() {
  var existing = document.getElementById('tour-welcome-modal');
  if (existing) existing.remove();

  var firstName = (_s && _s.name) ? escHtml(_s.name.split(' ')[0]) : 'there';

  var el = document.createElement('div');
  el.id        = 'tour-welcome-modal';
  el.className = 'tour-welcome-backdrop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'tour-welcome-title');
  el.innerHTML =
    '<div class="tour-welcome-card">' +
      '<div class="tour-welcome-logo-wrap">' +
        '<img src="/logo.png" alt="Mission Custom Pool Solutions" class="tour-welcome-logo-img"' +
        '     onerror="this.style.display=\'none\'">' +
      '</div>' +
      '<div class="tour-welcome-body">' +
        '<h2 id="tour-welcome-title" class="tour-welcome-title">Welcome to the MCPS Portal, ' + firstName + '!</h2>' +
        '<p class="tour-welcome-sub">Let\'s take a 2-minute tour so you know exactly what to do on your first day.</p>' +
        '<ul class="tour-welcome-list">' +
          '<li><span aria-hidden="true">📅</span> Find your daily schedule</li>' +
          '<li><span aria-hidden="true">💧</span> Get chemical dosage recommendations</li>' +
          '<li><span aria-hidden="true">📸</span> Upload required photos</li>' +
          '<li><span aria-hidden="true">✅</span> Submit your service log</li>' +
        '</ul>' +
      '</div>' +
      '<div class="tour-welcome-actions">' +
        '<button class="btn-svc tour-welcome-start" id="tour-btn-start">Start Tour</button>' +
        '<button class="tour-welcome-skip" id="tour-btn-skip">Skip for now</button>' +
      '</div>' +
      '<div id="tour-welcome-err" class="tour-sync-err" style="display:none"></div>' +
    '</div>';
  document.body.appendChild(el);

  var startBtn = document.getElementById('tour-btn-start');
  var skipBtn  = document.getElementById('tour-btn-skip');
  var errEl    = document.getElementById('tour-welcome-err');

  startBtn.addEventListener('click', function() {
    el.remove();
    _setTourState('in_progress', { started_at: new Date().toISOString() }, { fireAndForget: true });
    _startDriver(0);
  });

  skipBtn.addEventListener('click', function() {
    skipBtn.textContent = 'Saving…';
    skipBtn.disabled    = true;
    startBtn.disabled   = true;
    _setTourState('skipped', { completed_at: new Date().toISOString() }, {
      onSuccess: function() { el.remove(); },
      onError:   function() {
        skipBtn.textContent = 'Retry';
        skipBtn.disabled    = false;
        startBtn.disabled   = false;
        errEl.textContent   = 'Could not reach server — tap Retry.';
        errEl.style.display = 'block';
      }
    });
  });

  el.addEventListener('keydown', function(e) { if (e.key === 'Escape') skipBtn.click(); });
  startBtn.focus();

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.style.animation = 'none';
    var card = el.querySelector('.tour-welcome-card');
    if (card) card.style.animation = 'none';
  }
}

// ─── Resume prompt (in_progress) ─────────────────────────────────────────────

function _showResumePrompt() {
  if (document.getElementById('tour-resume-prompt')) return;

  var el = document.createElement('div');
  el.id        = 'tour-resume-prompt';
  el.className = 'tour-resume-prompt';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Portal tour');
  el.innerHTML =
    '<span class="tour-resume-icon" aria-hidden="true">🗺️</span>' +
    '<span class="tour-resume-text">Continue the portal tour?</span>' +
    '<div class="tour-resume-actions">' +
      '<button class="tour-resume-btn tour-resume-yes"  id="tour-resume-resume">Restart Tour</button>' +
      '<button class="tour-resume-btn tour-resume-dim"  id="tour-resume-dismiss">Dismiss for now</button>' +
    '</div>';
  document.body.appendChild(el);
  requestAnimationFrame(function() { el.classList.add('visible'); });

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.style.transition = 'none';
    el.classList.add('visible');
  }

  function _hide(cb) {
    el.classList.remove('visible');
    setTimeout(function() { if (el.parentNode) el.remove(); if (cb) cb(); }, 250);
  }

  document.getElementById('tour-resume-resume').addEventListener('click', function() {
    _hide(function() { _startDriver(0); });
  });
  document.getElementById('tour-resume-dismiss').addEventListener('click', function() {
    _hide(); // keep status in_progress — do not mark skipped or completed
  });
}

// ─── Driver.js setup ──────────────────────────────────────────────────────────

var _driverInstance = null;

function _startDriver(startIndex) {
  if (!window.driver || !window.driver.js || typeof window.driver.js.driver !== 'function') {
    console.error('[tour] Driver.js not available');
    return;
  }
  window._tourActive = true;
  if (_driverInstance) { try { _driverInstance.destroy(); } catch(e) {} _driverInstance = null; }

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  _driverInstance = window.driver.js.driver({
    animate:              !reducedMotion,
    overlayOpacity:       0.55,
    allowClose:           true,
    overlayClickBehavior: function() {},
    stagePadding:         8,
    stageRadius:          8,
    popoverClass:         'tour-popover',
    onDestroyStart:       function() { window._tourActive = false; window._tourForceMode = false; _hideTourTransition(); },
    steps:                _buildSteps()
  });

  _driverInstance.drive(startIndex || 0);
}

// ─── DOM wait helpers ─────────────────────────────────────────────────────────

// Waits until an element exists in the DOM (for dynamically-created elements).
function _waitForEl(selector, timeoutMs) {
  timeoutMs = timeoutMs || 4500;
  return new Promise(function(resolve) {
    var el = document.querySelector(selector);
    if (el) { resolve(el); return; }
    var obs = new MutationObserver(function() {
      var found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function() { obs.disconnect(); resolve(null); }, timeoutMs);
  });
}

// Waits until an element is in the DOM AND visible (offsetParent !== null).
// Use this for elements that exist in static HTML but inside display:none containers
// (e.g. #htab-schedule inside #route-content which starts hidden while routes load).
function _waitForVisible(selector, timeoutMs) {
  timeoutMs = timeoutMs || 6000;
  return new Promise(function(resolve) {
    var start = Date.now();
    function check() {
      var el = document.querySelector(selector);
      if (el && el.offsetParent !== null) { resolve(el); return; }
      if (Date.now() - start >= timeoutMs) { resolve(el || null); return; }
      setTimeout(check, 150);
    }
    check();
  });
}

function _waitForEitherVisible(selectors, timeoutMs) {
  timeoutMs = timeoutMs || 2500;
  return new Promise(function(resolve) {
    var start = Date.now();
    function check() {
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.offsetParent !== null) { resolve(el); return; }
      }
      if (Date.now() - start >= timeoutMs) { resolve(null); return; }
      setTimeout(check, 120);
    }
    check();
  });
}

function _setTourPopoverHidden(hidden) {
  var popover = document.getElementById('driver-popover-content');
  if (popover) popover.style.visibility = hidden ? 'hidden' : '';
}

function _showTourTransition(message) {
  var el = document.getElementById('tour-transition');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tour-transition';
    el.className = 'tour-transition';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="tour-transition-spinner"></div><div class="tour-transition-text"></div>';
    document.body.appendChild(el);
  }
  var text = el.querySelector('.tour-transition-text');
  if (text) text.textContent = message || 'Loading the next tour step...';
  requestAnimationFrame(function() { el.classList.add('visible'); });
}

function _hideTourTransition() {
  var el = document.getElementById('tour-transition');
  if (!el) return;
  el.classList.remove('visible');
  setTimeout(function() { if (el.parentNode && !el.classList.contains('visible')) el.remove(); }, 180);
}

function _moveTourToWhenReady(index, attempts) {
  attempts = attempts === undefined ? 12 : attempts;
  if (!_driverInstance) return;

  try { _driverInstance.moveTo(index); } catch(e) {}

  if (_driverInstance && _driverInstance.getActiveIndex && _driverInstance.getActiveIndex() !== index && attempts > 0) {
    setTimeout(function() { _moveTourToWhenReady(index, attempts - 1); }, 100);
    return;
  }

  if (_driverInstance && _driverInstance.getActiveIndex && _driverInstance.getActiveIndex() !== index) {
    try { _driverInstance.destroy(); } catch(e) {}
    _driverInstance = null;
    setTimeout(function() { _startDriver(index); _hideTourTransition(); }, 50);
    return;
  }

  _hideTourTransition();
  _setTourPopoverHidden(false);
}

function _navigateTourTo(page, visibleSelector, stepIndex, opts) {
  opts = opts || {};
  _setTourPopoverHidden(true);
  _showTourTransition(opts.message);
  if (opts.beforeNavigate) opts.beforeNavigate();
  navigateTo(page);
  _waitForVisible(visibleSelector, opts.timeoutMs || 6500).then(function() {
    Promise.resolve(opts.afterVisible ? opts.afterVisible() : null).then(function() {
      setTimeout(function() { _moveTourToWhenReady(stepIndex); }, opts.delayMs || 450);
    });
  });
}

function _selectTourPool() {
  var sel = document.querySelector('[name="pool_id"]');
  if (!sel) return false;

  var targetIdx = -1;
  for (var i = 0; i < sel.options.length; i++) {
    var opt = sel.options[i].value || sel.options[i].text || '';
    if (opt === TOUR_DEMO_POOL || /Bullock/i.test(opt) || /MCPS-0017/i.test(opt)) {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx < 0) return false;
  if (sel.selectedIndex !== targetIdx) {
    sel.selectedIndex = targetIdx;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

function _getTourReadings() {
  if (!window._tourDemoReadings) {
    window._tourDemoReadings = TOUR_DEMO_READINGS[Math.floor(Math.random() * TOUR_DEMO_READINGS.length)];
  }
  return window._tourDemoReadings;
}

function _setTourField(name, value) {
  var el = document.querySelector('[name="' + name.replace(/"/g, '\\"') + '"]');
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function _seedTourReadings() {
  if (!window._tourActive) return;
  _selectTourPool();

  var sample = _getTourReadings();
  var sizeSel = document.getElementById('svc-size');
  if (sizeSel) sizeSel.value = sample.size;
  var matSel = document.getElementById('svc-mat');
  if (matSel) matSel.value = sample.mat;

  _setTourField('Free Chlorine (FC)', sample.fc);
  _setTourField('pH', sample.ph);
  _setTourField('Total Alkalinity (TA)', sample.ta);
  _setTourField('Calcium Hardness (CH)', sample.ch);

  var tablet = document.querySelector('.tbpill[data-val="' + sample.tablet + '"]');
  if (tablet && !tablet.classList.contains('tactive') && typeof tTablet === 'function') {
    tTablet(tablet, sample.tablet);
  } else if (typeof runRecs === 'function') {
    runRecs();
  }
}

function _prepTourServiceLog() {
  window._pendingSvcPoolId = TOUR_DEMO_POOL;
  window._prefillCustomer = 'Charles Bullock';
}

function _showTourPoolContext() {
  _selectTourPool();
  return _waitForEitherVisible(['#pool-trend-banner', '#pool-last-notes-banner'], 3500).then(function() {
    var mc = document.querySelector('.main-content');
    if (mc) mc.scrollTop = 0;
  });
}

// ─── Progress label ───────────────────────────────────────────────────────────

function _prog(n) {
  return '<span class="tour-step-prog">' + n + ' / ' + TOUR_STEP_COUNT + '</span>';
}

// ─── Step definitions ─────────────────────────────────────────────────────────

function _buildSteps() {
  var mobile = window.innerWidth < 768;

  return [
    // ── 1: Bottom navigation bar ─────────────────────────────────────────────
    {
      element: '#tech-bottom-nav',
      popover: {
        title:       'Navigation ' + _prog(1),
        description: 'These four tabs are your navigation. Home shows your daily dashboard, Schedule shows your route, Service Log is for logging visits, and Profile lets you manage your availability.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 2: Technician home dashboard → onNextClick navigates to live_map ───────
    {
      element: '#tech-home-dashboard',
      popover: {
        title:       'Your Dashboard ' + _prog(2),
        description: 'Your daily KPIs and today\'s stops appear here. Check this every morning to see how many pools are on your route and which one\'s up next.',
        side:  'bottom',
        align: 'start',
        onNextClick: function() {
          _navigateTourTo('live_map', '#tn-schedule', 2, {
            message: 'Loading your schedule...'
          });
        }
      }
    },

    // ── 3: Schedule tab in bottom nav ───────────────────────────────────────
    {
      element: '#tn-schedule',
      popover: {
        title:       'Schedule ' + _prog(3),
        description: 'Tap Schedule to open your weekly route. Choose a day to see that day\'s pools.',
        side:  'top',
        align: 'center',
        onPrevClick: function() {
          _navigateTourTo('home', '#tech-home-dashboard', 1, {
            message: 'Returning to your dashboard...'
          });
        }
      }
    },

    // ── 4: Day tabs ──────────────────────────────────────────────────────────
    {
      element: '#day-tabs',
      popover: {
        title:       'Day Tabs ' + _prog(4),
        description: 'Monday through Saturday. The badge shows the stop count. Stops you\'ve logged are checked off automatically after submission.',
        side:  'bottom',
        align: 'start'
      }
    },

    // ── 5: Stop cards area → onNextClick navigates to service_log ────────────
    {
      element: '#hub-tab-schedule',
      popover: {
        title:       'Service Stops ' + _prog(5),
        description: 'Once your route loads, each stop card shows the customer name, address, and service type. Tap a card then tap <strong>Log Visit</strong> to open the service form for that pool.',
        side:  'top',
        align: 'start',
        onNextClick: function() {
          _navigateTourTo('service_log', '[data-tour="svc-pool-select"]', 5, {
            beforeNavigate: _prepTourServiceLog,
            afterVisible: _showTourPoolContext,
            message: 'Opening Bullock\'s service log...',
            delayMs: 700
          });
        }
      }
    },

    // ── 6: Service log — pool selector (on service_log) ──────────────────────
    {
      element: '[data-tour="svc-pool-select"]',
      popover: {
        title:       'Select the Pool ' + _prog(6),
        description: 'The tutorial preselects Charles Bullock so you can see how recent notes and water trends appear at the top of the service log.',
        side:  'bottom',
        align: 'start',
        onPrevClick: function() {
          _navigateTourTo('live_map', '#hub-tab-schedule', 4, {
            message: 'Returning to the schedule...'
          });
        }
      }
    },

    // ── 7: Test results section ───────────────────────────────────────────────
    {
      element: '[data-tour="svc-test-results"]',
      onHighlighted: function() {
        _seedTourReadings();
      },
      popover: {
        title:       'Water Test Readings ' + _prog(7),
        description: 'For the tutorial, we filled in a sample set of readings so you can see the recommendation engine without leaving the walkthrough.',
        side:  'bottom',
        align: 'start'
      }
    },

    // ── 8: Recommendation box ─────────────────────────────────────────────────
    {
      element: '[data-tour="svc-recommendations"]',
      onHighlighted: function() {
        _seedTourReadings();
      },
      popover: {
        title:       'Mr. Chuy Recommends ' + _prog(8),
        description: 'These suggestions are generated from the sample readings, Bullock\'s pool size and material, and the selected tablet level.',
        side:  'left',
        align: 'start'
      }
    },

    // ── 9: Chemicals used section ─────────────────────────────────────────────
    {
      element: '[data-tour="svc-chemicals-used"]',
      popover: {
        title:       'Chemicals You Added ' + _prog(9),
        description: 'Record what you actually added here. These numbers feed the company\'s chemical usage reports and cost tracking.',
        side:  'bottom',
        align: 'start'
      }
    },

    // ── 10: Actions performed ────────────────────────────────────────────────
    {
      element: '[data-tour="svc-actions"]',
      onHighlighted: function() {
        try {
          ['Vacuumed', 'Brushed', 'Cleaned skimmer basket'].forEach(function(v) {
            var el = document.querySelector('input[name="Technician Actions"][value="' + v + '"]');
            if (el && !el.checked) el.checked = true;
          });
        } catch (e) {}
      },
      popover: {
        title:       'Actions Performed ' + _prog(10),
        description: 'Before you submit, tap the tasks you did on this visit — netting, brushing, basket cleaning, and more. These show up on the customer\'s service report so they see the hands-on work. We\'ve checked a few here as an example.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 11: Photo upload ──────────────────────────────────────────────────────
    {
      element: '#photo-drop-zone',
      popover: {
        title:       'Visit Photos ' + _prog(11),
        description: 'Attach up to 4 photos. Before and after shots are best practice — they protect you and help resolve questions from customers or management.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 12: Visit notes ───────────────────────────────────────────────────────
    {
      element: '[data-tour="svc-notes"]',
      popover: {
        title:       'Visit Notes ' + _prog(12),
        description: 'Leave notes about this visit here — these appear on the customer service report, so keep them friendly and customer-facing.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 13: Internal notes (staff-only) ──────────────────────────────────────
    {
      element: '[data-tour="svc-internal-notes"]',
      onHighlighted: function() {
        var el = document.getElementById('svc-internal-notes');
        if (el && !el.value) el.value = 'Equipment looks worn — flagging for a manager follow-up.';
      },
      popover: {
        title:       'Internal Notes ' + _prog(13),
        description: 'Anything you put here is <strong>staff-only</strong> — it\'s saved to the log for the office but never shows up on the customer\'s service report. Use it for equipment concerns, access issues, or follow-ups for management.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 14: Submit → onNextClick navigates to live_map/profile ───────────────
    {
      element: '#btn-svc',
      popover: {
        title:       'Submit Your Log ' + _prog(14),
        description: 'Tap Submit when everything is complete. If you\'re offline, your log saves locally and sends automatically once you reconnect.',
        side:  'top',
        align: 'start',
        onNextClick: function() {
          _navigateTourTo('live_map', '#htab-profile', 14, {
            afterVisible: function() {
              if (typeof switchHubTab === 'function') switchHubTab('profile');
            },
            message: 'Opening your operator profile...',
            delayMs: 500
          });
        }
      }
    },

    // ── 15: Profile tab — where to restart ───────────────────────────────────
    {
      element: '#htab-profile',
      popover: {
        title:       'Your Profile ' + _prog(15),
        description: 'This is your operator profile. You can review your own profile details here and tap <strong>Restart Tutorial</strong> any time to run this tour again.',
        side:  'over',
        align: 'center',
        nextBtnText: 'Finish Tour',
        onPrevClick: function() {
          _navigateTourTo('service_log', '#btn-svc', 13, {
            message: 'Returning to the service log...',
            delayMs: 500
          });
        },
        onNextClick: function() {
          _finishTour();
        }
      }
    }
  ];
}

// ─── Finish (completed) ───────────────────────────────────────────────────────

function _finishTour() {
  if (_driverInstance) { try { _driverInstance.destroy(); } catch(e) {} _driverInstance = null; }
  window._tourActive    = false;
  window._tourForceMode = false;

  var overlay = document.createElement('div');
  overlay.id        = 'tour-finish-overlay';
  overlay.className = 'tour-finish-overlay';
  overlay.innerHTML = '<div class="tour-finish-inner"><div class="tour-finish-spinner"></div><p>Saving your progress…</p></div>';
  document.body.appendChild(overlay);

  function _doSave(retriesLeft) {
    _setTourState('completed', { completed_at: new Date().toISOString() }, {
      retries: retriesLeft,
      onSuccess: function() {
        overlay.remove();
        _showTourFinishToast();
      },
      onError: function() {
        overlay.innerHTML =
          '<div class="tour-finish-inner">' +
            '<p class="tour-finish-err">Couldn\'t save right now. Your progress is stored locally and will sync when you\'re back online.</p>' +
            '<div class="tour-finish-btns">' +
              '<button class="btn-svc tour-welcome-start" id="tour-finish-retry">Retry</button>' +
              '<button class="tour-welcome-skip" id="tour-finish-ok">OK</button>' +
            '</div>' +
          '</div>';
        document.getElementById('tour-finish-retry').addEventListener('click', function() {
          overlay.innerHTML = '<div class="tour-finish-inner"><div class="tour-finish-spinner"></div><p>Saving your progress…</p></div>';
          _doSave(1);
        });
        document.getElementById('tour-finish-ok').addEventListener('click', function() { overlay.remove(); });
      }
    });
  }

  _doSave(2);
}

function _showTourFinishToast() {
  var toast = document.createElement('div');
  toast.className = 'tour-finish-toast';
  toast.textContent = '✅ Tour complete — you\'re all set!';
  document.body.appendChild(toast);
  requestAnimationFrame(function() { toast.classList.add('visible'); });
  setTimeout(function() {
    toast.classList.remove('visible');
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 400);
  }, 4500);
}
