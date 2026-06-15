// ══════════════════════════════════════════════════════════════════════════════
// TOUR — technician onboarding walkthrough (Driver.js v1.4)
// Vendored at /js/lib/vendor/driver.iife.min.js
// Depends on: constants.js (escHtml), api.js (api), auth.js (_s, _curPage),
//             router.js (navigateTo), routes.js (switchHubTab)
// ══════════════════════════════════════════════════════════════════════════════

var TOUR_VERSION    = 'technician-tour-v1';
var TOUR_STEP_COUNT = 13;

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
function forceLaunchTour() {
  window._tourAttemptedThisSession = true;
  window._tourForceMode            = true;
  _showWelcomeModal();
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
        '<img src="/White Logo Words.png" alt="Mission Custom Pool Solutions" class="tour-welcome-logo-img"' +
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
    animate:        !reducedMotion,
    overlayOpacity: 0.55,
    allowClose:     true,
    stagePadding:   8,
    stageRadius:    8,
    popoverClass:   'tour-popover',
    onDestroyStart: function() { window._tourActive = false; window._tourForceMode = false; },
    steps:          _buildSteps()
  });

  _driverInstance.drive(startIndex || 0);
}

// ─── DOM wait helper ──────────────────────────────────────────────────────────

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

// ─── Progress label ───────────────────────────────────────────────────────────

function _prog(n) {
  return '<span class="tour-step-prog">' + n + ' / ' + TOUR_STEP_COUNT + '</span>';
}

// ─── Step definitions ─────────────────────────────────────────────────────────

function _buildSteps() {
  var mobile = window.innerWidth < 768;

  return [
    // ── 1: Navigation sidebar ────────────────────────────────────────────────
    {
      element: mobile ? '#hamburger' : '#sidebar',
      popover: {
        title:       'Navigation ' + _prog(1),
        description: mobile
          ? 'Tap <strong>≡</strong> to open the menu. Every page in the portal is one tap away.'
          : 'This sidebar is your command center. Every page is one tap away. On mobile, tap <strong>≡</strong> to open it.',
        side:  mobile ? 'bottom' : 'right',
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
        align: 'start'
      },
      onNextClick: function() {
        navigateTo('live_map');
        _waitForEl('#day-tabs').then(function() {
          setTimeout(function() { if (_driverInstance) _driverInstance.moveNext(); }, 300);
        });
      }
    },

    // ── 3: Technician Hub — Schedule tab (on live_map) ───────────────────────
    {
      element: '#htab-schedule',
      popover: {
        title:       'Schedule Tab ' + _prog(3),
        description: 'Your weekly route lives here. Tap a day to load that day\'s assigned pools.',
        side:  'bottom',
        align: 'start'
      },
      onPrevClick: function() {
        navigateTo('home');
        _waitForEl('#tech-home-dashboard').then(function() {
          setTimeout(function() { if (_driverInstance) _driverInstance.movePrevious(); }, 300);
        });
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
        align: 'start'
      },
      onNextClick: function() {
        navigateTo('service_log');
        _waitForEl('[data-tour="svc-pool-select"]').then(function() {
          setTimeout(function() { if (_driverInstance) _driverInstance.moveNext(); }, 300);
        });
      }
    },

    // ── 6: Service log — pool selector (on service_log) ──────────────────────
    {
      element: '[data-tour="svc-pool-select"]',
      popover: {
        title:       'Select the Pool ' + _prog(6),
        description: 'Choose which pool you\'re servicing. When you tap Log Visit from a stop card, this fills in automatically.',
        side:  'bottom',
        align: 'start'
      },
      onPrevClick: function() {
        navigateTo('live_map');
        _waitForEl('#hub-tab-schedule').then(function() {
          setTimeout(function() { if (_driverInstance) _driverInstance.movePrevious(); }, 300);
        });
      }
    },

    // ── 7: Test results section ───────────────────────────────────────────────
    {
      element: '[data-tour="svc-test-results"]',
      popover: {
        title:       'Water Test Readings ' + _prog(7),
        description: 'Enter your test kit results here. Free Chlorine, pH, and Total Alkalinity are required. Calcium Hardness is optional but improves recommendation accuracy.',
        side:  'bottom',
        align: 'start'
      }
    },

    // ── 8: Recommendation box ─────────────────────────────────────────────────
    {
      element: '[data-tour="svc-recommendations"]',
      popover: {
        title:       'Mr. Chuy Recommends ' + _prog(8),
        description: 'As you type your readings, this box calculates exactly what to add — adjusted for pool size, material, and condition. It updates live every time you change a value.',
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

    // ── 10: Photo upload ──────────────────────────────────────────────────────
    {
      element: '#photo-drop-zone',
      popover: {
        title:       'Visit Photos ' + _prog(10),
        description: 'Attach up to 4 photos. Before and after shots are best practice — they protect you and help resolve questions from customers or management.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 11: Visit notes ───────────────────────────────────────────────────────
    {
      element: '[data-tour="svc-notes"]',
      popover: {
        title:       'Visit Notes ' + _prog(11),
        description: 'Leave notes about this visit here — they appear on the customer service report. Use the <em>Internal Notes</em> field above for staff-only observations that won\'t go to the customer.',
        side:  'top',
        align: 'start'
      }
    },

    // ── 12: Submit → onNextClick navigates to live_map/profile ───────────────
    {
      element: '#btn-svc',
      popover: {
        title:       'Submit Your Log ' + _prog(12),
        description: 'Tap Submit when everything is complete. If you\'re offline, your log saves locally and sends automatically once you reconnect.',
        side:  'top',
        align: 'start'
      },
      onNextClick: function() {
        navigateTo('live_map');
        _waitForEl('#htab-profile').then(function() {
          if (typeof switchHubTab === 'function') switchHubTab('profile');
          setTimeout(function() { if (_driverInstance) _driverInstance.moveNext(); }, 350);
        });
      }
    },

    // ── 13: Profile tab — where to restart ───────────────────────────────────
    {
      element: '#htab-profile',
      popover: {
        title:       'Your Profile ' + _prog(13),
        description: 'See your certifications and training progress here. Tap <strong>Restart Tutorial</strong> any time to run this tour again.',
        side:  'bottom',
        align: 'start',
        nextBtnText: 'Finish Tour'
      },
      onPrevClick: function() {
        navigateTo('service_log');
        _waitForEl('#btn-svc').then(function() {
          setTimeout(function() { if (_driverInstance) _driverInstance.movePrevious(); }, 300);
        });
      },
      onNextClick: function() {
        _finishTour();
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
