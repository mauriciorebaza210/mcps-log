import sys

filepath = 'index.html'
with open(filepath, 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_js = """
// ══════════════════════════════════════════════════════════════════════════════
// TRAINING MODULE (LMS)
// ══════════════════════════════════════════════════════════════════════════════
let _trLoaded = false;
let _trModules = [];
let _trProgress = {};
let _trOpenModules = new Set();
let _activeContentType = 'video';
let _quizQuestions = [];

function loadTraining() {
  if (_trLoaded) { renderTraining(); return; }
  document.getElementById('tr-loading').style.display = 'block';
  document.getElementById('tr-root').innerHTML = '';
  Promise.all([
    apiGet({action:'get_modules', token:_s.token}),
    apiGet({action:'get_training_progress', token:_s.token}).catch(() => ({ok:false}))
  ])
    .then(([res, progRes]) => {
      document.getElementById('tr-loading').style.display = 'none';
      if (res.ok) {
        _trModules = res.modules || [];
        _trProgress = (progRes && progRes.ok && progRes.progress) ? progRes.progress : {};
        _trLoaded = true;
        renderTraining();
      } else {
        document.getElementById('tr-root').innerHTML = `<div class="tr-empty"><div class="tr-empty-icon">⚠️</div><div class="tr-empty-text">${res.error||'Failed to load modules'}</div></div>`;
      }
    })
    .catch(e => {
      document.getElementById('tr-loading').style.display = 'none';
      document.getElementById('tr-root').innerHTML = `<div class="tr-empty"><div class="tr-empty-icon">⚠️</div><div class="tr-empty-text">Network error: ${e.message}</div></div>`;
    });
}

function isModuleFullyCompleted(modId) {
  const mod = _trModules.find(m => m.id === modId);
  if (!mod || !mod.items || mod.items.length === 0) return true;
  return mod.items.every(item => isItemCompleted(modId, item.id));
}

function renderTraining() {
  const isAdm = isAdmin();
  const addBtn = document.getElementById('tr-add-mod-btn');
  if (addBtn) addBtn.style.display = isAdm ? 'inline-block' : 'none';

  const root = document.getElementById('tr-root');
  if (!_trModules.length) {
    root.innerHTML = `<div class="tr-empty"><div class="tr-empty-icon">🎓</div><div class="tr-empty-text">No modules yet</div><div class="tr-empty-sub">${isAdm ? 'Click "+ Module" to create the first one.' : 'Check back soon!'}</div></div>`;
    return;
  }

  let html = '';
  let prevModuleComplete = true; // used for gating

  _trModules.forEach((mod, idx) => {
    const items = mod.items || mod.videos || [];
    const completedCount = items.filter(v => isItemCompleted(mod.id, v.id)).length;
    const progressPct = items.length ? Math.round((completedCount / items.length) * 100) : 0;
    const isOpen = _trOpenModules.has(mod.id);

    // Module Gating
    let locked = false;
    if (mod.require_prev_module && !isAdm && !prevModuleComplete) {
      locked = true;
    }

    const adminActions = isAdm ? `
      <div class="tr-mod-actions">
        <button class="mod-act-btn" onclick="event.stopPropagation();openModuleDrawer('${mod.id}')">✏️ Edit</button>
        <button class="mod-act-btn danger" onclick="event.stopPropagation();deleteModule('${mod.id}')">🗑</button>
      </div>` : '';

    let prevItemComplete = true; // used for item gating
    const itemRows = items.map(v => {
      const completed = isItemCompleted(mod.id, v.id);
      
      let itemLocked = false;
      if (v.pass_required && !isAdm && !prevItemComplete) {
        itemLocked = true;
      }
      if (v.pass_required) prevItemComplete = completed; // for next item in loop

      const adminVBtns = isAdm ? `
        <div class="tr-item-admin">
          <button class="v-act-btn" onclick="event.stopPropagation();openVideoDrawer('${mod.id}','${v.id}')">✏️</button>
          <button class="v-act-btn danger" onclick="event.stopPropagation();deleteVideo('${mod.id}','${v.id}')">🗑</button>
        </div>` : '';

      let icon = '▶';
      if (v.content_type === 'quiz') icon = '📝';
      if (v.content_type === 'document') icon = '📄';

      if (locked || itemLocked) {
        return `
          <div class="tr-item-row locked">
            <span class="tr-item-icon">🔒</span>
            <div class="tr-item-info">
              <div class="tr-item-title">${escHtml(v.title)}</div>
              <div class="tr-item-desc">Finish previous required items to unlock.</div>
            </div>
          </div>`;
      }

      return `
        <div class="tr-item-row${completed ? ' done' : ''}" onclick="openItemDetail('${mod.id}','${v.id}')">
          <span class="tr-item-icon">${icon}</span>
          <div class="tr-item-info">
            <div class="tr-item-title">${escHtml(v.title)}</div>
            ${v.description ? `<div class="tr-item-desc">${escHtml(v.description)}</div>` : ''}
          </div>
          ${completed ? `<span class="tr-item-badge">✓ Done</span>` : ''}
          ${adminVBtns}
        </div>`;
    }).join('');

    const addVideoBtn = isAdm ? `
      <div class="tr-add-video-row">
        <button class="tr-add-video-btn" onclick="openVideoDrawer('${mod.id}', null)">+ Add Content</button>
      </div>` : '';

    const bodyContent = (items.length || isAdm) ? `${itemRows}${addVideoBtn}` : '';

    if (locked) {
      html += `
        <div class="tr-module-row locked" id="tr-mod-${mod.id}">
          <div class="tr-mod-hdr">
            <span class="tr-mod-arrow">🔒</span>
            <span class="tr-mod-num">${String(idx+1).padStart(2,'0')}</span>
            <div class="tr-mod-info">
              <div class="tr-mod-title">${escHtml(mod.title)}</div>
              <div class="tr-mod-meta">Complete previous module to unlock</div>
            </div>
            ${adminActions}
          </div>
        </div>`;
    } else {
      html += `
        <div class="tr-module-row${isOpen ? ' open' : ''}" id="tr-mod-${mod.id}">
          <div class="tr-mod-hdr" onclick="toggleModule('${mod.id}')">
            <span class="tr-mod-arrow">▶</span>
            <span class="tr-mod-num">${String(idx+1).padStart(2,'0')}</span>
            <div class="tr-mod-info">
              <div class="tr-mod-title">${escHtml(mod.title)}</div>
              <div class="tr-mod-meta">
                <span class="tr-mod-count">${items.length} item${items.length!==1?'s':''}</span>
                ${items.length ? `<span class="tr-mod-progress">${completedCount}/${items.length} complete (${progressPct}%)</span>` : ''}
              </div>
            </div>
            ${adminActions}
          </div>
          ${bodyContent ? `<div class="tr-mod-body">${bodyContent}</div>` : ''}
        </div>`;
    }

    prevModuleComplete = isModuleFullyCompleted(mod.id);
  });

  root.innerHTML = html;
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleModule(moduleId) {
  if (_trOpenModules.has(moduleId)) _trOpenModules.delete(moduleId);
  else _trOpenModules.add(moduleId);
  const row = document.getElementById('tr-mod-' + moduleId);
  if (row) row.classList.toggle('open', _trOpenModules.has(moduleId));
}

// ── Item Detail View (Video/Document/Quiz) ───────────────────────────────────
let _currentQuizAnswers = {};

function openItemDetail(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item) return;

  if (item.content_type !== 'quiz') {
    markItemInProgress(moduleId, itemId);
  }

  const completed = isItemCompleted(moduleId, itemId);
  let completeAction = '';
  if (item.content_type !== 'quiz') {
    completeAction = completed
      ? `<span class="tr-complete-tag">✓ Completed</span>`
      : `<button class="tr-complete-btn" id="tr-detail-complete-btn" onclick="markItemCompleteDetail('${moduleId}','${itemId}')">✓ Mark Complete</button>`;
  }

  const isAdm = isAdmin();
  const adminActions = isAdm ? `
    <button class="mod-act-btn" onclick="openVideoDrawer('${moduleId}','${itemId}')">✏️ Edit</button>
    <button class="mod-act-btn danger" onclick="deleteVideo('${moduleId}','${itemId}')">🗑 Delete</button>` : '';

  let viewerHtml = '';

  if (item.content_type === 'video' || item.content_type === 'document' || !item.content_type) {
    const driveId = extractDriveId(item.content_url || item.drive_url || item.url || '');
    const embedSrc = driveId ? `https://drive.google.com/file/d/${driveId}/preview` : (item.content_url || item.drive_url || item.url || '');
    viewerHtml = `<div class="tr-detail-frame-wrap"><iframe src="${embedSrc}" allow="autoplay" allowfullscreen></iframe></div>`;
  } else if (item.content_type === 'quiz') {
    _currentQuizAnswers = {}; // reset
    const quizData = typeof item.quiz_data === 'string' ? null : item.quiz_data; // JSON parsed in get_modules
    if (quizData && quizData.questions && quizData.questions.length) {
      const qHTML = quizData.questions.map((q, qIdx) => `
        <div class="qz-question">
          <div class="qz-qtext">${qIdx + 1}. ${escHtml(q.question)}</div>
          <div class="qz-options">
            ${q.options.map((opt, oIdx) => `
              <label class="qz-option-label">
                <input type="radio" name="qz_${qIdx}" value="${oIdx}" onchange="setQuizAnswer('${qIdx}', ${oIdx})">
                <span>${escHtml(opt)}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `).join('');

      let progressHtml = '';
      const key = `${moduleId}::${itemId}`;
      const prog = _trProgress[key];
      if (prog && prog.quiz_attempts > 0) {
        progressHtml = `<div class="mod-drawer-msg ${prog.status==='completed' ? 'ok' : 'warn'}" style="margin-bottom:1rem">
          Previous Score: ${prog.quiz_score}% (Attempts: ${prog.quiz_attempts})
          ${prog.status==='completed' ? ' - Passed!' : ''}
        </div>`;
      }

      viewerHtml = `
        <div class="qz-viewer">
          ${progressHtml}
          ${qHTML}
          <div style="margin-top:20px; text-align:center;">
             <button class="tr-add-video-btn" style="padding:10px 30px" onclick="submitQuizTaking('${moduleId}', '${itemId}')">Submit Quiz</button>
             <div id="quiz-result-msg" style="margin-top:10px;font-weight:bold;"></div>
          </div>
        </div>`;
    } else {
      viewerHtml = `<div class="tr-empty">No questions found in this quiz.</div>`;
    }
  }

  document.getElementById('tr-mod-list').style.display = 'none';
  const detail = document.getElementById('tr-detail');
  detail.style.display = 'block';
  detail.innerHTML = `
    <button class="tr-detail-back" onclick="closeVideoDetail()">← Back to Modules</button>
    <div class="tr-detail-breadcrumb">${escHtml(mod.title)}</div>
    <div class="tr-detail-title">${escHtml(item.title)}</div>
    ${item.description ? `<div class="tr-detail-desc">${escHtml(item.description)}</div>` : ''}
    ${viewerHtml}
    <div class="tr-detail-actions">${completeAction}${adminActions}</div>`;
}

function setQuizAnswer(qIdx, optIdx) { _currentQuizAnswers['q' + qIdx] = optIdx; }

function submitQuizTaking(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item || !item.quiz_data || !item.quiz_data.questions) return;
  
  if (Object.keys(_currentQuizAnswers).length < item.quiz_data.questions.length) {
    document.getElementById('quiz-result-msg').innerHTML = '<span style="color:red">Please answer all questions before submitting.</span>';
    return;
  }

  document.getElementById('quiz-result-msg').innerHTML = 'Grading quiz...';
  api({
    action: 'submit_quiz', token: _s.token,
    module_id: moduleId, content_id: itemId, answers: _currentQuizAnswers
  }).then(res => {
    if (!res.ok) { document.getElementById('quiz-result-msg').innerHTML = '<span style="color:red">Error: ' + (res.error||'Failed') + '</span>'; return; }
    
    // Update local progress state
    const key = `${moduleId}::${itemId}`;
    _trProgress[key] = {
      status: res.passed ? 'completed' : 'in_progress',
      quiz_score: res.score,
      quiz_attempts: (_trProgress[key] ? (_trProgress[key].quiz_attempts || 0) : 0) + 1,
      updated_at: new Date().toISOString()
    };
    
    let msg = `You scored ${res.score}% (${res.correct}/${res.total}). `;
    if (res.passed) {
      msg = `<span style="color:var(--ok)">✓ Passed! ${msg}</span>`;
      document.getElementById('quiz-result-msg').innerHTML = msg;
      setTimeout(() => closeVideoDetail(), 2000); // auto close on pass
    } else {
      msg = `<span style="color:var(--severe)">❌ Failed. Pass threshold is ${res.pass_threshold}%. ${msg} Please try again.</span>`;
      document.getElementById('quiz-result-msg').innerHTML = msg;
    }
  }).catch(() => { document.getElementById('quiz-result-msg').innerHTML = '<span style="color:red">Network error.</span>'; });
}

function closeVideoDetail() {
  document.getElementById('tr-detail').style.display = 'none';
  document.getElementById('tr-detail').innerHTML = '';
  document.getElementById('tr-mod-list').style.display = 'block';
  renderTraining();
}

function markItemCompleteDetail(moduleId, itemId) {
  api({
    action: 'upsert_training_progress', secret: SEC, token: _s.token,
    module_id: moduleId, content_id: itemId, status: 'completed'
  }).then(res => {
    if (!res.ok) { alert('Error: ' + (res.error || 'Unable to save progress.')); return; }
    const key = `${moduleId}::${itemId}`;
    _trProgress[key] = { status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const btn = document.getElementById('tr-detail-complete-btn');
    if (btn) {
      const span = document.createElement('span');
      span.className = 'tr-complete-tag';
      span.textContent = '✓ Completed';
      btn.replaceWith(span);
    }
  }).catch(() => alert('Network error while saving progress.'));
}

function isItemCompleted(moduleId, itemId) {
  const key = `${moduleId}::${itemId}`;
  return !!(_trProgress[key] && _trProgress[key].status === 'completed');
}

function markItemInProgress(moduleId, itemId) {
  if (!moduleId || !itemId) return;
  const key = `${moduleId}::${itemId}`;
  if (_trProgress[key] && _trProgress[key].status === 'completed') return;
  _trProgress[key] = Object.assign({}, _trProgress[key]||{}, { status: 'in_progress', updated_at: new Date().toISOString() });
  api({
    action: 'upsert_training_progress', secret: SEC, token: _s.token,
    module_id: moduleId, content_id: itemId, status: 'in_progress'
  }).catch(() => {});
}

function extractDriveId(url) {
  if (!url) return null;
  const m = url.match(/\\/file\\/d\\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── Module Drawer ─────────────────────────────────────────────────────────────
function openModuleDrawer(moduleId) {
  const isEdit = !!moduleId;
  document.getElementById('mod-drawer-title').textContent = isEdit ? 'Edit Module' : 'Add Module';
  document.getElementById('mod-id').value = moduleId || '';
  document.getElementById('mod-drawer-msg').className = 'mod-drawer-msg';
  document.getElementById('mod-drawer-msg').textContent = '';
  if (isEdit) {
    const mod = _trModules.find(m => m.id === moduleId);
    document.getElementById('mod-title').value = mod ? mod.title : '';
    document.getElementById('mod-desc').value = mod ? (mod.description || '') : '';
    document.getElementById('mod-order').value = mod ? (mod.order || '') : '';
    document.getElementById('mod-require-prev').checked = mod ? !!mod.require_prev_module : false;
  } else {
    document.getElementById('mod-title').value = '';
    document.getElementById('mod-desc').value = '';
    document.getElementById('mod-order').value = (_trModules.length + 1);
    document.getElementById('mod-require-prev').checked = false;
  }
  document.getElementById('mod-backdrop').classList.add('open');
  document.getElementById('mod-drawer').classList.add('open');
}

function closeModuleDrawer() {
  document.getElementById('mod-backdrop').classList.remove('open');
  document.getElementById('mod-drawer').classList.remove('open');
}

function saveModule() {
  const btn = document.getElementById('mod-save-btn');
  const msgEl = document.getElementById('mod-drawer-msg');
  const modId = document.getElementById('mod-id').value;
  const title = document.getElementById('mod-title').value.trim();
  const desc = document.getElementById('mod-desc').value.trim();
  const order = parseInt(document.getElementById('mod-order').value) || (_trModules.length + 1);
  const reqPrev = document.getElementById('mod-require-prev').checked;
  if (!title) { showDrawerMsg(msgEl, 'err', 'Title is required.'); return; }
  btn.disabled = true; btn.textContent = 'Saving...';
  msgEl.className = 'mod-drawer-msg'; msgEl.textContent = '';
  
  api({
    action: modId ? 'update_module' : 'create_module', token: _s.token,
    module_id: modId, title, description: desc, order, require_prev_module: reqPrev
  }).then(res => {
    btn.disabled = false; btn.textContent = 'Save Module';
    if (res.ok) { _trLoaded = false; closeModuleDrawer(); loadTraining(); }
    else showDrawerMsg(msgEl, 'err', res.error || 'Error saving module.');
  }).catch(() => { btn.disabled=false; btn.textContent='Save Module'; showDrawerMsg(msgEl,'err','Network error.'); });
}

function deleteModule(moduleId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!confirm(`Delete module "${mod ? mod.title : moduleId}"?\\n\\nThis will also delete all items inside it.`)) return;
  api({action:'delete_module', token:_s.token, module_id:moduleId})
    .then(res => { if (res.ok) { _trLoaded=false; loadTraining(); } else alert('Error: '+(res.error||'Unknown')); })
    .catch(() => alert('Network error.'));
}

// ── Content Drawer (Video/Doc/Quiz) ─────────────────────────────────────────
function selectContentType(type) {
  _activeContentType = type;
  document.querySelectorAll('.ct-pill').forEach(el => el.classList.remove('ct-active'));
  document.querySelector(`.ct-pill[data-type="${type}"]`).classList.add('ct-active');
  
  const urlGroup = document.getElementById('content-url-group');
  const quizGroup = document.getElementById('quiz-builder-group');
  const thresGroup = document.getElementById('content-threshold-group');
  const passReqCheck = document.getElementById('content-pass-required');
  const urlLabel = document.getElementById('content-url-label');
  const urlHint = document.getElementById('content-url-hint');

  if (type === 'quiz') {
    urlGroup.style.display = 'none';
    quizGroup.style.display = 'flex';
    passReqCheck.checked = true; // quizzes usually required to pass
  } else {
    urlGroup.style.display = 'flex';
    quizGroup.style.display = 'none';
    if (type === 'document') {
      urlLabel.textContent = 'Document/File URL';
      urlHint.textContent = 'Paste a Google Drive share link for PDF, Docs, Excel, etc.';
    } else {
      urlLabel.textContent = 'Video URL';
      urlHint.textContent = 'Paste a Google Drive video share link.';
    }
  }
  toggleThresholdVisibility();
}

function toggleThresholdVisibility() {
  const showThres = document.getElementById('content-pass-required').checked && _activeContentType === 'quiz';
  document.getElementById('content-threshold-group').style.display = showThres ? 'flex' : 'none';
}

function openVideoDrawer(moduleId, itemId) {
  const isEdit = !!itemId;
  document.getElementById('vid-drawer-title').textContent = isEdit ? 'Edit Content' : 'Add Content';
  document.getElementById('vid-id').value = itemId || '';
  document.getElementById('vid-module-id').value = moduleId || '';
  document.getElementById('vid-drawer-msg').className = 'mod-drawer-msg';
  document.getElementById('vid-drawer-msg').textContent = '';
  
  if (isEdit) {
    const mod = _trModules.find(m => m.id === moduleId);
    const item = mod ? (mod.items||[]).find(v => v.id === itemId) : null;
    document.getElementById('vid-title').value = item ? item.title : '';
    document.getElementById('vid-url').value = item ? (item.content_url || item.drive_url || item.url || '') : '';
    document.getElementById('vid-desc').value = item ? (item.description || '') : '';
    document.getElementById('vid-order').value = item ? (item.order || '') : '';
    document.getElementById('content-pass-required').checked = item ? !!item.pass_required : false;
    document.getElementById('content-pass-threshold').value = item ? (item.pass_threshold || 80) : 80;
    
    _quizQuestions = [];
    if (item && item.content_type === 'quiz' && item.quiz_data && item.quiz_data.questions) {
      _quizQuestions = JSON.parse(JSON.stringify(item.quiz_data.questions));
    }
    updateQuizSummary();
    selectContentType(item ? (item.content_type || 'video') : 'video');
  } else {
    document.getElementById('vid-title').value = '';
    document.getElementById('vid-url').value = '';
    document.getElementById('vid-desc').value = '';
    const mod = _trModules.find(m => m.id === moduleId);
    document.getElementById('vid-order').value = mod ? ((mod.items||[]).length + 1) : 1;
    document.getElementById('content-pass-required').checked = false;
    document.getElementById('content-pass-threshold').value = 80;
    _quizQuestions = [];
    updateQuizSummary();
    selectContentType('video');
  }
  
  document.getElementById('vid-backdrop').classList.add('open');
  document.getElementById('vid-drawer').classList.add('open');
}

function closeVideoDrawer() {
  document.getElementById('vid-backdrop').classList.remove('open');
  document.getElementById('vid-drawer').classList.remove('open');
}

function saveVideo() {
  const btn = document.getElementById('vid-save-btn');
  const msgEl = document.getElementById('vid-drawer-msg');
  const itemId = document.getElementById('vid-id').value;
  const moduleId = document.getElementById('vid-module-id').value;
  const title = document.getElementById('vid-title').value.trim();
  const url = document.getElementById('vid-url').value.trim();
  const desc = document.getElementById('vid-desc').value.trim();
  const order = parseInt(document.getElementById('vid-order').value) || 1;
  const passReq = document.getElementById('content-pass-required').checked;
  const passThres = parseInt(document.getElementById('content-pass-threshold').value) || 80;
  
  if (!title) { showDrawerMsg(msgEl, 'err', 'Title is required.'); return; }
  
  if (_activeContentType === 'video' || _activeContentType === 'document') {
    if (!url) { showDrawerMsg(msgEl, 'err', 'URL is required.'); return; }
    if (!extractDriveId(url)) { showDrawerMsg(msgEl, 'err', 'Could not parse a Google Drive file ID from this URL.'); return; }
  } else if (_activeContentType === 'quiz') {
    if (_quizQuestions.length === 0) { showDrawerMsg(msgEl, 'err', 'Add at least one quiz question.'); return; }
  }

  btn.disabled = true; btn.textContent = 'Saving...';
  msgEl.className = 'mod-drawer-msg'; msgEl.textContent = '';
  
  const payload = {
    action: itemId ? 'update_content' : 'create_content', token: _s.token,
    content_id: itemId, module_id: moduleId, title, content_url: url,
    description: desc, order, content_type: _activeContentType,
    pass_required: passReq, pass_threshold: passThres,
    quiz_data: _activeContentType === 'quiz' ? JSON.stringify({questions: _quizQuestions}) : ''
  };
  
  api(payload).then(res => {
    btn.disabled = false; btn.textContent = 'Save Content';
    if (res.ok) { _trLoaded = false; closeVideoDrawer(); loadTraining(); }
    else showDrawerMsg(msgEl, 'err', res.error || 'Error saving content.');
  }).catch(() => { btn.disabled=false; btn.textContent='Save Content'; showDrawerMsg(msgEl,'err','Network error.'); });
}

function deleteVideo(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  const item = mod ? (mod.items||[]).find(v => v.id === itemId) : null;
  if (!confirm(`Delete item "${item ? item.title : itemId}"?`)) return;
  api({action:'delete_content', token:_s.token, content_id:itemId, module_id:moduleId})
    .then(res => { if (res.ok) { _trLoaded=false; loadTraining(); } else alert('Error: '+(res.error||'Unknown')); })
    .catch(() => alert('Network error.'));
}

function showDrawerMsg(el, type, text) { el.textContent = text; el.className = 'mod-drawer-msg ' + type; }

// ── Quiz Wizard ───────────────────────────────────────────────────────────────
function updateQuizSummary() {
  document.getElementById('quiz-summary').textContent = _quizQuestions.length ? `${_quizQuestions.length} question(s) configured.` : 'No questions added yet.';
}

function openQuizWizard() {
  document.getElementById('quiz-wizard-overlay').style.display = 'flex';
  renderQuizWizard();
}

function closeQuizWizard() {
  document.getElementById('quiz-wizard-overlay').style.display = 'none';
  updateQuizSummary();
}

function saveQuizFromWizard() {
  // Save current dynamic inputs to array
  const qDivs = document.querySelectorAll('.qw-q-card');
  const tempArr = [];
  let valid = true;
  qDivs.forEach((div, idx) => {
    const qText = div.querySelector('.qw-q-text').value.trim();
    if (!qText) return;
    const opts = [];
    let correct = 0;
    div.querySelectorAll('.qw-o-text').forEach((inp, oIdx) => {
      const txt = inp.value.trim();
      if (txt) opts.push(txt);
      if (div.querySelector(`input[name="qw-r-${idx}"]:checked`)?.value == oIdx) correct = opts.length - 1;
    });
    if (opts.length < 2) valid = false;
    tempArr.push({ question: qText, options: opts, correct: correct });
  });
  
  if (!valid) { alert('Each question needs at least 2 options.'); return; }
  _quizQuestions = tempArr;
  closeQuizWizard();
}

function renderQuizWizard() {
  const cont = document.getElementById('qw-questions');
  if (!_quizQuestions.length) _quizQuestions.push({ question: '', options: ['',''], correct: 0 }); // init with 1 blank
  
  cont.innerHTML = _quizQuestions.map((q, qIdx) => `
    <div class="qw-q-card">
      <div style="display:flex;justify-content:space-between;margin-bottom:.5rem;">
        <strong>Question ${qIdx + 1}</strong>
        <button class="v-act-btn danger" onclick="removeQuizQuestion(${qIdx})">🗑</button>
      </div>
      <input type="text" class="qw-q-text" value="${escHtml(q.question)}" placeholder="Enter your question here..." style="width:100%;padding:.5rem;margin-bottom:.5rem;">
      <div style="font-size:.8rem;color:#666;margin-bottom:.25rem;">Select the radio button next to the correct answer:</div>
      <div id="qw-opts-${qIdx}">
        ${q.options.map((opt, oIdx) => `
          <div style="display:flex;align-items:center;margin-bottom:.25rem;gap:.5rem;">
            <input type="radio" name="qw-r-${qIdx}" value="${oIdx}" ${q.correct == oIdx ? 'checked' : ''}>
            <input type="text" class="qw-o-text" value="${escHtml(opt)}" placeholder="Option ${oIdx+1}" style="flex:1;padding:.4rem;">
            <button class="v-act-btn" onclick="removeQuizOption(${qIdx}, ${oIdx})">✕</button>
          </div>
        `).join('')}
      </div>
      <button class="mod-act-btn" style="margin-top:.5rem" onclick="addQuizOption(${qIdx})">+ Add Option</button>
    </div>
  `).join('');
}

function addQuizQuestion() {
  savePartialQuizState();
  _quizQuestions.push({ question: '', options: ['',''], correct: 0 });
  renderQuizWizard();
}

function removeQuizQuestion(qIdx) {
  savePartialQuizState();
  _quizQuestions.splice(qIdx, 1);
  renderQuizWizard();
}

function addQuizOption(qIdx) {
  savePartialQuizState();
  _quizQuestions[qIdx].options.push('');
  renderQuizWizard();
}

function removeQuizOption(qIdx, oIdx) {
  savePartialQuizState();
  if (_quizQuestions[qIdx].options.length <= 2) return; // need 2 min
  _quizQuestions[qIdx].options.splice(oIdx, 1);
  if (_quizQuestions[qIdx].correct == oIdx) _quizQuestions[qIdx].correct = 0;
  else if (_quizQuestions[qIdx].correct > oIdx) _quizQuestions[qIdx].correct--;
  renderQuizWizard();
}

function savePartialQuizState() {
  const tempArr = [];
  const qDivs = document.querySelectorAll('.qw-q-card');
  qDivs.forEach((div, idx) => {
    const qText = div.querySelector('.qw-q-text').value;
    const opts = [];
    let correct = 0;
    div.querySelectorAll('.qw-o-text').forEach((inp, oIdx) => {
      opts.push(inp.value);
      if (div.querySelector(`input[name="qw-r-${idx}"]:checked`)?.value == oIdx) correct = oIdx;
    });
    tempArr.push({ question: qText, options: opts, correct: correct });
  });
  _quizQuestions = tempArr;
}

function toggleQuizPreview() {
  const btn = document.getElementById('qw-preview-btn');
  const pre = document.getElementById('qw-preview');
  const bdy = document.getElementById('qw-body');
  savePartialQuizState();
  
  if (pre.style.display === 'none') { // Show preview
    btn.innerHTML = '✎ Edit Quiz';
    bdy.style.display = 'none';
    pre.style.display = 'block';
    pre.innerHTML = `
      <div style="font-weight:600;margin-bottom:1rem;color:var(--mcps-blue);">Student Preview:</div>
      ${_quizQuestions.map((q, qIdx) => `
        <div class="qz-question" style="background:#f1f3f4;padding:1rem;border-radius:4px;margin-bottom:1rem;">
          <div class="qz-qtext">${qIdx + 1}. ${escHtml(q.question) || '<i>[Empty Question]</i>'}</div>
          <div class="qz-options">
            ${q.options.map((opt, oIdx) => `
              <label class="qz-option-label">
                <input type="radio" disabled ${q.correct == oIdx ? 'checked' : ''}>
                <span style="${q.correct == oIdx ? 'color:var(--ok);font-weight:bold;' : ''}">${escHtml(opt) || '<i>[Empty Option]</i>'}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `).join('')}
    `;
  } else {
    btn.innerHTML = '👁 Preview Quiz';
    pre.style.display = 'none';
    bdy.style.display = 'block';
  }
}
"""

start_marker = "let _trLoaded = false;"
end_marker = "function headsUp(e, btn) {"

start_idx = -1
end_idx = -1

for i, line in enumerate(lines):
    if start_marker in line:
        start_idx = i
        break

for i in range(start_idx, len(lines)):
    if end_marker in line:
        pass
    if end_marker in lines[i]:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    # Account for the comment block above _trLoaded
    start_idx = start_idx - 3
    # Account for the headsUp comment block above the function
    end_idx = end_idx - 2

    lines[start_idx:end_idx] = [new_js + '\\n']
    with open(filepath, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print(f"Replaced Javascript training block from line {start_idx+1} to {end_idx+1}")
else:
    print("Could not find markers.")