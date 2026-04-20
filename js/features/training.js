// ══════════════════════════════════════════════════════════════════════════════
// TRAINING MODULE (LMS) — modules, quizzes, progress tracking
// Depends on: constants.js (SEC), api.js (api, apiGet), auth.js (isAdmin)
// Uses globals: _s, _trLoaded, _trModules, _trProgress, _trOpenModules, _trOpenSubmodules, _quizQuestions, _quizCurrentStep, _quizShuffledData
// ══════════════════════════════════════════════════════════════════════════════
// TRAINING MODULE (LMS)
// ══════════════════════════════════════════════════════════════════════════════
let _trLoaded = false;
let _trModules = [];
let _trProgress = {};
let _trOpenModules = new Set();
let _trOpenSubmodules = new Set();
let _activeContentType = 'video';
let _quizQuestions = [];
let _quizCurrentStep = 0;        // which question the technician is on
let _quizShuffledData = null;    // shuffled copy of questions for the current attempt
const TR_SUBMODULE_URL_MARKER = 'submodule://container';

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns a stable string key for a question based on its content.
// Includes type and normalized correct answer(s) so questions with the same
// text/options but different answers or types don't collide.
function questionKey_(q) {
  const text = String(q.question || '').trim().toLowerCase();
  const opts = (q.options || []).map(o => String(o || '').trim().toLowerCase()).sort().join('|');
  const type = String(q.type || 'single');
  const correct = Array.isArray(q.correct)
    ? q.correct.slice().sort().join(',')
    : String(q.correct ?? '');
  return text + '\x00' + opts + '\x00' + type + '\x00' + correct;
}

// Build a shuffled copy of quiz questions (shuffles question order and each
// question's options while keeping the correct-answer mapping intact).
function buildShuffledQuiz(questions) {
  // Tag each question with a stable content-based key before shuffling.
  // This key is used for wrong-answer tracking and survives question reordering.
  const indexed = questions.map(q => ({ ...q, _qkey: q._qkey || questionKey_(q) }));
  const shuffledQs = shuffleArray(indexed).map(q => {
    const indices = q.options.map((_, i) => i);
    const newOrder = shuffleArray(indices);
    const newOptions = newOrder.map(i => q.options[i]);
    const newCorrect = Array.isArray(q.correct)
      ? q.correct.map(c => newOrder.indexOf(c))
      : newOrder.indexOf(q.correct);
    return { ...q, options: newOptions, correct: newCorrect, _originalOrder: newOrder };
  });
  return shuffledQs;
}
const TR_PARENT_META_RE = /\n?\[\[parent:([a-zA-Z0-9_-]+)\]\]\s*$/;

function trExtractParentMeta_(item) {
  const explicitParent = String(item && item.parent_content_id || '').trim();
  const rawDesc = String(item && item.description || '');
  const metaMatch = rawDesc.match(TR_PARENT_META_RE);
  const metaParent = metaMatch ? String(metaMatch[1] || '').trim() : '';
  return {
    parent_content_id: explicitParent || metaParent,
    description: rawDesc.replace(TR_PARENT_META_RE, '').trim()
  };
}

function trComposeDescriptionWithParent_(description, parentContentId) {
  const clean = String(description || '').replace(TR_PARENT_META_RE, '').trim();
  const parent = String(parentContentId || '').trim();
  if (!parent) return clean;
  return clean ? `${clean}\n[[parent:${parent}]]` : `[[parent:${parent}]]`;
}

function trNormalizeItem_(item) {
  const rawType = String(item && item.content_type || '').toLowerCase();
  const rawUrl = String((item && (item.content_url || item.drive_url || item.url)) || '');
  const isMarkedSubmodule = rawType === 'document' && rawUrl.startsWith(TR_SUBMODULE_URL_MARKER);
  const parentMeta = trExtractParentMeta_(item);
  const normalized = {
    ...item,
    parent_content_id: parentMeta.parent_content_id,
    description: parentMeta.description
  };
  if (isMarkedSubmodule) return { ...normalized, content_type: 'submodule', content_url: '' };
  // If quiz_data flags this as a final quiz, expose it with its own content_type
  if (normalized.content_type === 'quiz' && normalized.quiz_data && normalized.quiz_data.is_final_quiz) {
    return { ...normalized, content_type: 'final_quiz' };
  }
  return normalized;
}

function trNormalizeModules_(modules) {
  return (modules || []).map(mod => ({
    ...mod,
    items: (mod.items || []).map(trNormalizeItem_)
  }));
}

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
        _trModules = trNormalizeModules_(res.modules || []);
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

    const childrenByParent = {};
    items.forEach(v => {
      const pid = v.parent_content_id || '';
      if (!childrenByParent[pid]) childrenByParent[pid] = [];
      childrenByParent[pid].push(v);
    });

    let prevItemComplete = true; // used for item gating
    const renderItemRow = (v, depth = 0) => {
      const completed = isItemCompleted(mod.id, v.id);
      const isSubmodule = v.content_type === 'submodule';
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
      if (v.content_type === 'final_quiz') icon = '🏁';
      if (v.content_type === 'document') icon = '📄';
      if (isSubmodule) icon = _trOpenSubmodules.has(v.id) ? '▼' : '▶';

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

      const children = childrenByParent[v.id] || [];
      const nestedRows = children.map(child => renderItemRow(child, depth + 1)).join('');
      const nestedWrap = children.length && _trOpenSubmodules.has(v.id)
        ? `<div class="tr-sub-items">${nestedRows}</div>`
        : '';
      const clickAction = isSubmodule
        ? `toggleSubmodule('${v.id}')`
        : `openItemDetail('${mod.id}','${v.id}')`;

      return `
        <div class="tr-item-row${completed ? ' done' : ''}${isSubmodule ? ' submodule-row' : ''}" onclick="${clickAction}" style="${depth ? `padding-left:${(depth*1.2)+1}rem` : ''}">
          <span class="tr-item-icon">${icon}</span>
          <div class="tr-item-info">
            <div class="tr-item-title">${escHtml(v.title)}</div>
            ${v.description ? `<div class="tr-item-desc">${escHtml(v.description)}</div>` : ''}
          </div>
          ${completed ? `<span class="tr-item-badge">✓ Done</span>` : ''}
          ${adminVBtns}
        </div>
        ${nestedWrap}`;
    };
    const itemRows = (childrenByParent[''] || []).map(v => renderItemRow(v)).join('');

    const addVideoBtn = isAdm ? `
      <div class="tr-add-video-row">
        <div class="tr-add-menu-wrap">
          <button class="tr-add-video-btn" onclick="toggleAddContentMenu('${mod.id}', event)">+ Add Content</button>
          <div class="tr-add-menu" id="tr-add-menu-${mod.id}" style="display:none">
            <button onclick="openVideoDrawerWithType('${mod.id}','video')">🎬 Video</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','document')">📄 Document</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','quiz')">📝 Quiz</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','final_quiz')">🏁 Final Quiz</button>
            <button onclick="openVideoDrawerWithType('${mod.id}','submodule')">📂 Submodule</button>
          </div>
        </div>
      </div>` : '';

    const bodyContent = items.length ? itemRows : '';
    const footerContent = isAdm ? `<div class="tr-mod-footer">${addVideoBtn}</div>` : '';

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
          ${footerContent}
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

function toggleSubmodule(contentId) {
  if (_trOpenSubmodules.has(contentId)) _trOpenSubmodules.delete(contentId);
  else _trOpenSubmodules.add(contentId);
  renderTraining();
}

function toggleAddContentMenu(moduleId, ev) {
  ev.stopPropagation();
  document.querySelectorAll('.tr-add-menu').forEach(el => {
    if (el.id !== `tr-add-menu-${moduleId}`) el.style.display = 'none';
  });
  const menu = document.getElementById(`tr-add-menu-${moduleId}`);
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function openVideoDrawerWithType(moduleId, type) {
  document.querySelectorAll('.tr-add-menu').forEach(el => { el.style.display = 'none'; });
  openVideoDrawer(moduleId, null);
  selectContentType(type);
}

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.tr-add-menu-wrap')) {
    document.querySelectorAll('.tr-add-menu').forEach(el => { el.style.display = 'none'; });
  }
});

// ── Final Quiz generation helpers ────────────────────────────────────────────

// Returns array of question objects for the given final quiz item, personalized
// for the current user. Returns null if the user hasn't attempted any source quiz yet.
function buildFinalQuizQuestions(finalQuizItem) {
  const qd = finalQuizItem.quiz_data || {};
  const sourceIds = qd.source_quiz_ids || [];
  const targetCount = qd.question_count || 20;

  const allSourceQuestions = [];
  const wrongQuestions = [];
  let hasAnyAttempt = false;

  for (const mod of (_trModules || [])) {
    for (const it of (mod.items || [])) {
      if (!sourceIds.includes(it.id)) continue;
      if (!it.quiz_data || !it.quiz_data.questions) continue;
      const progressKey = `${mod.id}::${it.id}`;
      const prog = _trProgress[progressKey] || {};
      if ((prog.quiz_attempts || 0) > 0) hasAnyAttempt = true;
      // wrong_question_ids are stable content-based string keys; filter out any
      // legacy numeric values from before the stable-key migration.
      const wrongKeys = new Set((prog.wrong_question_ids || []).filter(k => typeof k === 'string'));
      it.quiz_data.questions.forEach(q => {
        const key = questionKey_(q);
        const tagged = { ...q, _qkey: key, _sourceQuizId: it.id };
        allSourceQuestions.push(tagged);
        if (wrongKeys.has(key)) wrongQuestions.push(tagged);
      });
    }
  }

  if (!hasAnyAttempt) return null; // block access

  // Deduplicate by stable content key (handles the same question appearing in multiple source quizzes)
  const uniqueWrong = deduplicateByKey_(wrongQuestions);
  const wrongKeySet = new Set(uniqueWrong.map(q => q._qkey));
  const remainingPool = shuffleArray(allSourceQuestions.filter(q => !wrongKeySet.has(q._qkey)));
  const fillCount = Math.max(0, targetCount - uniqueWrong.length);
  const fillQuestions = remainingPool.slice(0, fillCount);
  const combined = uniqueWrong.length > targetCount
    ? shuffleArray(uniqueWrong).slice(0, targetCount)
    : [...uniqueWrong, ...fillQuestions];
  return combined.slice(0, targetCount);
}

function deduplicateByKey_(questions) {
  const seen = new Set();
  return questions.filter(q => {
    const k = q._qkey || questionKey_(q);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Item Detail View (Video/Document/Quiz) ───────────────────────────────────
let _currentQuizAnswers = {};

function openItemDetail(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item) return;
  const navigableItems = (mod.items || []).filter(v => v.content_type !== 'submodule');
  const currentIndex = navigableItems.findIndex(v => v.id === itemId);
  const prevItem = currentIndex > 0 ? navigableItems[currentIndex - 1] : null;
  const nextItem = currentIndex >= 0 && currentIndex < navigableItems.length - 1 ? navigableItems[currentIndex + 1] : null;

  if (item.content_type !== 'quiz' && item.content_type !== 'final_quiz') {
    markItemInProgress(moduleId, itemId);
  }

  const completed = isItemCompleted(moduleId, itemId);
  let completeAction = '';
  if (item.content_type !== 'quiz' && item.content_type !== 'final_quiz') {
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
  } else if (item.content_type === 'quiz' || item.content_type === 'final_quiz') {
    _currentQuizAnswers = {}; // reset
    _quizCurrentStep = 0;

    let quizQuestions = null;

    if (item.content_type === 'final_quiz') {
      const generated = buildFinalQuizQuestions(item);
      if (generated === null) {
        // User hasn't attempted any source quiz yet — list which ones are needed
        const sourceIds = (item.quiz_data && item.quiz_data.source_quiz_ids) || [];
        const notAttempted = [];
        for (const mod of (_trModules || [])) {
          for (const it of (mod.items || [])) {
            if (!sourceIds.includes(it.id)) continue;
            const prog = _trProgress[`${mod.id}::${it.id}`] || {};
            if ((prog.quiz_attempts || 0) === 0) notAttempted.push(it.title);
          }
        }
        const listHtml = notAttempted.map(t => `<li>${escHtml(t)}</li>`).join('');
        viewerHtml = `<div class="tr-empty fq-blocked">
          <div style="font-size:1.5rem;margin-bottom:.5rem">🏁</div>
          <strong>Complete the required quizzes first before taking this Final Quiz.</strong>
          ${notAttempted.length ? `<ul style="margin-top:.75rem;text-align:left">${listHtml}</ul>` : ''}
        </div>`;
      } else if (!generated.length) {
        viewerHtml = `<div class="tr-empty">No questions available in the selected source quizzes.</div>`;
      } else {
        quizQuestions = generated;
      }
    } else {
      const quizData = typeof item.quiz_data === 'string' ? null : item.quiz_data; // JSON parsed in get_modules
      if (quizData && quizData.questions && quizData.questions.length) {
        quizQuestions = quizData.questions;
      }
    }

    if (quizQuestions) {
      _quizShuffledData = buildShuffledQuiz(quizQuestions);

      let progressHtml = '';
      const key = `${moduleId}::${itemId}`;
      const prog = _trProgress[key];
      if (prog && prog.quiz_attempts > 0) {
        progressHtml = `<div class="mod-drawer-msg ${prog.status==='completed' ? 'ok' : 'warn'}" style="margin-bottom:1rem">
          Previous Score: ${prog.quiz_score}% (Attempts: ${prog.quiz_attempts})
          ${prog.status==='completed' ? ' — Passed!' : ''}
        </div>`;
      }

      viewerHtml = `
        <div class="qz-viewer" id="qz-viewer-wrap">
          ${progressHtml}
          <div id="qz-step-content"></div>
          <div id="quiz-result-msg" style="margin-top:10px;font-weight:bold;"></div>
        </div>`;

      window._qzPendingRender = { moduleId, itemId };
    } else if (!viewerHtml) {
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
    ${item.content_type === 'final_quiz' ? `<div class="tr-detail-desc fq-subtitle">🏁 Final Quiz — personalized for you based on your previous answers.</div>` : ''}
    ${item.description ? `<div class="tr-detail-desc">${escHtml(item.description)}</div>` : ''}
    ${viewerHtml}
    <div class="tr-detail-nav">
      <button class="tr-detail-nav-btn" ${prevItem ? `onclick="openItemDetail('${moduleId}','${prevItem.id}')"` : 'disabled'}>← Previous</button>
      <button class="tr-detail-nav-btn" ${nextItem ? `onclick="openItemDetail('${moduleId}','${nextItem.id}')"` : 'disabled'}>Next →</button>
    </div>
    <div class="tr-detail-actions">${completeAction}${adminActions}</div>`;

  // If we have a pending quiz step render, execute it now that the DOM is ready
  if (window._qzPendingRender) {
    const { moduleId: mid, itemId: iid } = window._qzPendingRender;
    window._qzPendingRender = null;
    renderQuizStep(mid, iid);
  }
}

function setQuizAnswer(qIdx, optIdx, isMulti) {
  const key = 'q' + qIdx;
  if (isMulti) {
    if (!Array.isArray(_currentQuizAnswers[key])) _currentQuizAnswers[key] = [];
    const arr = _currentQuizAnswers[key];
    const pos = arr.indexOf(optIdx);
    if (pos === -1) arr.push(optIdx); else arr.splice(pos, 1);
    if (arr.length === 0) delete _currentQuizAnswers[key];
  } else {
    _currentQuizAnswers[key] = optIdx;
  }
  // Refresh option highlight states without re-rendering the whole step
  const stepEl = document.getElementById('qz-step-content');
  if (stepEl) {
    stepEl.querySelectorAll('.qz-option-label').forEach(lbl => {
      const inp = lbl.querySelector('input');
      if (!inp) return;
      const selected = Array.isArray(_currentQuizAnswers[key])
        ? _currentQuizAnswers[key].includes(parseInt(inp.value))
        : _currentQuizAnswers[key] === parseInt(inp.value);
      lbl.classList.toggle('qz-selected', selected);
    });
  }
}

// Render the current step of the step-by-step quiz.
function renderQuizStep(moduleId, itemId) {
  const questions = _quizShuffledData;
  if (!questions) return;
  const total = questions.length;
  const step = _quizCurrentStep;
  const q = questions[step];
  const isMulti = q.type === 'multi';
  const pct = Math.round(((step) / total) * 100);

  const answerKey = 'q' + step;
  const currentAns = _currentQuizAnswers[answerKey];

  const optionsHtml = q.options.map((opt, oIdx) => {
    const isSelected = isMulti
      ? (Array.isArray(currentAns) && currentAns.includes(oIdx))
      : (currentAns === oIdx);
    const inputType = isMulti ? 'checkbox' : 'radio';
    return `<label class="qz-option-label${isSelected ? ' qz-selected' : ''}">
      <input type="${inputType}" name="qz_${step}" value="${oIdx}"
        ${isSelected ? 'checked' : ''}
        onchange="setQuizAnswer(${step}, ${oIdx}, ${isMulti})">
      <span>${escHtml(opt)}</span>
    </label>`;
  }).join('');

  const isLast = step === total - 1;
  const navHtml = `
    <div class="qz-step-nav">
      <button class="qz-nav-btn" onclick="quizStepBack('${moduleId}','${itemId}')" ${step === 0 ? 'disabled' : ''}>← Back</button>
      <span style="font-size:13px;color:#5f6368">${step + 1} / ${total}</span>
      ${isLast
        ? `<button class="qz-nav-btn primary" onclick="submitQuizTaking('${moduleId}','${itemId}')">Submit Quiz</button>`
        : `<button class="qz-nav-btn primary" onclick="quizStepNext('${moduleId}','${itemId}')">Next →</button>`}
    </div>`;

  const typeBadge = isMulti ? `<span class="qz-type-badge">Select all that apply</span>` : '';
  const imageSrc = getQuizImageSrc(q.image_url || '');
  const imageHtml = imageSrc ? `<div class="qz-question-image-wrap"><img class="qz-question-image" src="${escHtml(imageSrc)}" alt="Quiz question image"></div>` : '';

  document.getElementById('qz-step-content').innerHTML = `
    <div class="qz-progress-bar-wrap">
      <div class="qz-progress-label">
        <span>Question ${step + 1} of ${total}</span>
        <span>${pct}% complete</span>
      </div>
      <div class="qz-progress-track"><div class="qz-progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="qz-step-card">
      <div class="qz-question">
        <div class="qz-qtext">${escHtml(q.question)}${typeBadge}</div>
        ${imageHtml}
        <div class="qz-options">${optionsHtml}</div>
      </div>
    </div>
    ${navHtml}`;
}

function quizStepNext(moduleId, itemId) {
  const questions = _quizShuffledData;
  if (!questions) return;
  const ansKey = 'q' + _quizCurrentStep;
  const ans = _currentQuizAnswers[ansKey];
  const hasAnswer = ans !== undefined && !(Array.isArray(ans) && ans.length === 0);
  if (!hasAnswer) {
    document.getElementById('quiz-result-msg').innerHTML =
      '<span style="color:red">Please select an answer before continuing.</span>';
    return;
  }
  document.getElementById('quiz-result-msg').innerHTML = '';
  _quizCurrentStep++;
  renderQuizStep(moduleId, itemId);
}

function quizStepBack(moduleId, itemId) {
  if (_quizCurrentStep === 0) return;
  document.getElementById('quiz-result-msg').innerHTML = '';
  _quizCurrentStep--;
  renderQuizStep(moduleId, itemId);
}

// Grade answer for one question. Returns true if correct.
function gradeAnswer(q, answer) {
  const correct = q.correct;
  if (q.type === 'multi') {
    const correctSet = Array.isArray(correct) ? correct.slice().sort() : [correct];
    const givenSet = Array.isArray(answer) ? answer.slice().sort() : [];
    return correctSet.length === givenSet.length && correctSet.every((v, i) => v === givenSet[i]);
  }
  return parseInt(answer) === correct;
}

function submitQuizTaking(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item || !item.quiz_data || !item.quiz_data.questions) return;

  const questions = _quizShuffledData || item.quiz_data.questions;

  // Validate last question is answered
  const lastKey = 'q' + (questions.length - 1);
  const lastAns = _currentQuizAnswers[lastKey];
  const lastAnswered = lastAns !== undefined && !(Array.isArray(lastAns) && lastAns.length === 0);
  if (!lastAnswered) {
    document.getElementById('quiz-result-msg').innerHTML =
      '<span style="color:red">Please select an answer before submitting.</span>';
    return;
  }

  // Client-side grading (correct answers are already in the loaded quiz data)
  let numCorrect = 0;
  const reviewItems = questions.map((q, qIdx) => {
    const answer = _currentQuizAnswers['q' + qIdx];
    const correct = gradeAnswer(q, answer);
    if (correct) numCorrect++;
    return { q, answer, correct };
  });
  const total = questions.length;
  const score = Math.round((numCorrect / total) * 100);
  const passThreshold = item.pass_threshold || 80;
  const passed = score >= passThreshold;

  // Collect stable content-based keys for wrong answers so Final Quiz tracking
  // survives admin edits or question reordering in the source quiz.
  const wrongSourceIndices = reviewItems
    .filter(ri => !ri.correct)
    .map(ri => ri.q._qkey || questionKey_(ri.q))
    .filter(Boolean);

  // Update local progress
  const key = `${moduleId}::${itemId}`;
  const prevAttempts = _trProgress[key] ? (_trProgress[key].quiz_attempts || 0) : 0;
  // Merge (union) wrong indices across all attempts so Final Quiz targets all-time weak spots
  // Filter out legacy numeric indices (pre-stable-key era) — they can't be
  // matched to questions anymore and will be replaced by string keys on this attempt.
  const prevWrong = (_trProgress[key] ? (_trProgress[key].wrong_question_ids || []) : [])
    .filter(k => typeof k === 'string');
  const mergedWrong = [...new Set([...prevWrong, ...wrongSourceIndices])];
  _trProgress[key] = {
    status: passed ? 'completed' : 'in_progress',
    quiz_score: score,
    quiz_attempts: prevAttempts + 1,
    wrong_question_ids: mergedWrong,
    updated_at: new Date().toISOString()
  };

  // Persist completion to backend
  const newAttempts = prevAttempts + 1;
  if (passed) {
    api({ action: 'upsert_training_progress', secret: SEC, token: _s.token,
          module_id: moduleId, content_id: itemId, status: 'completed',
          quiz_score: score, quiz_attempts: newAttempts,
          wrong_question_ids: mergedWrong }).catch(() => {});
    checkGraduation(moduleId);
  } else {
    api({ action: 'upsert_training_progress', secret: SEC, token: _s.token,
          module_id: moduleId, content_id: itemId, status: 'in_progress',
          quiz_score: score, quiz_attempts: newAttempts,
          wrong_question_ids: mergedWrong }).catch(() => {});
  }

  // Build review HTML
  const reviewHtml = reviewItems.map((ri, i) => {
    const q = ri.q;
    const isMulti = q.type === 'multi';
    const correctAnswers = Array.isArray(q.correct) ? q.correct : [q.correct];
    const correctLabels = correctAnswers.map(c => escHtml(q.options[c])).join(', ');
    const givenIndices = Array.isArray(ri.answer) ? ri.answer : (ri.answer !== undefined ? [ri.answer] : []);
    const givenLabels = givenIndices.map(c => escHtml(q.options[c])).join(', ') || '(no answer)';
    const expHtml = q.explanation
      ? `<div class="qz-explanation"><span class="exp-label">Why?</span>${escHtml(q.explanation)}</div>` : '';
    const imageSrc = getQuizImageSrc(q.image_url || '');
    const imageHtml = imageSrc ? `<div class="qz-question-image-wrap"><img class="qz-question-image" src="${escHtml(imageSrc)}" alt="Question ${i + 1} image"></div>` : '';
    return `
      <div class="qz-review-item ${ri.correct ? 'correct' : 'incorrect'}">
        <div class="qz-review-qnum">${ri.correct ? '✓ Correct' : '✗ Incorrect'} — Q${i + 1}</div>
        <div class="qz-review-qtext">${escHtml(q.question)}</div>
        ${imageHtml}
        ${!ri.correct ? `<div class="qz-review-answer"><span class="lbl">Your answer: </span><span class="val-wrong">${givenLabels}</span></div>` : ''}
        <div class="qz-review-answer"><span class="lbl">Correct answer: </span><span class="val-correct">${correctLabels}</span></div>
        ${expHtml}
      </div>`;
  }).join('');

  const resultColor = passed ? 'var(--ok)' : 'var(--severe)';
  const resultIcon = passed ? '✓ Passed!' : '✗ Failed.';

  document.getElementById('qz-step-content').innerHTML = `
    <div class="qz-review">
      <div class="qz-review-header">
        <span style="color:${resultColor};font-size:18px">${resultIcon}</span>
        &nbsp; You scored <strong>${score}%</strong> (${numCorrect}/${total} correct).
        ${!passed ? `<div style="font-size:13px;color:#5f6368;font-weight:400;margin-top:.3rem">Pass threshold is ${passThreshold}%. Please review and try again.</div>` : ''}
      </div>
      ${reviewHtml}
      ${!passed ? `<div style="text-align:center;margin-top:1rem">
        <button class="qz-nav-btn primary" onclick="retryQuizTaking('${moduleId}','${itemId}')">Try Again</button>
      </div>` : ''}
    </div>`;
  document.getElementById('quiz-result-msg').innerHTML = '';

  if (passed) setTimeout(() => closeVideoDetail(), 3500);
}

function retryQuizTaking(moduleId, itemId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!mod) return;
  const item = (mod.items || []).find(v => v.id === itemId);
  if (!item || !item.quiz_data) return;
  _currentQuizAnswers = {};
  _quizCurrentStep = 0;
  // For final quizzes, regenerate the personalized question set on retry
  if (item.content_type === 'final_quiz') {
    const generated = buildFinalQuizQuestions(item);
    if (!generated || !generated.length) return;
    _quizShuffledData = buildShuffledQuiz(generated);
  } else {
    _quizShuffledData = buildShuffledQuiz(item.quiz_data.questions);
  }
  renderQuizStep(moduleId, itemId);
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
    checkGraduation(moduleId);
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
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function getQuizImageSrc(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';
  const driveId = extractDriveId(clean);
  return driveId ? `https://drive.google.com/uc?export=view&id=${driveId}` : clean;
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
    document.getElementById('mod-is-graduation').checked = mod ? !!mod.is_graduation_module : false;
  } else {
    document.getElementById('mod-title').value = '';
    document.getElementById('mod-desc').value = '';
    document.getElementById('mod-order').value = (_trModules.length + 1);
    document.getElementById('mod-require-prev').checked = false;
    document.getElementById('mod-is-graduation').checked = false;
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
  const isGrad  = document.getElementById('mod-is-graduation').checked;
  if (!title) { showDrawerMsg(msgEl, 'err', 'Title is required.'); return; }
  btn.disabled = true; btn.textContent = 'Saving...';
  msgEl.className = 'mod-drawer-msg'; msgEl.textContent = '';

  api({
    action: modId ? 'update_module' : 'create_module', token: _s.token,
    module_id: modId, title, description: desc, order, require_prev_module: reqPrev,
    is_graduation_module: isGrad
  }).then(res => {
    btn.disabled = false; btn.textContent = 'Save Module';
    if (res.ok) { _trLoaded = false; closeModuleDrawer(); loadTraining(); }
    else showDrawerMsg(msgEl, 'err', res.error || 'Error saving module.');
  }).catch(() => { btn.disabled=false; btn.textContent='Save Module'; showDrawerMsg(msgEl,'err','Network error.'); });
}

function deleteModule(moduleId) {
  const mod = _trModules.find(m => m.id === moduleId);
  if (!confirm(`Delete module "${mod ? mod.title : moduleId}"?\n\nThis will also delete all items inside it.`)) return;
  api({action:'delete_module', token:_s.token, module_id:moduleId})
    .then(res => { if (res.ok) { _trLoaded=false; loadTraining(); } else alert('Error: '+(res.error||'Unknown')); })
    .catch(() => alert('Network error.'));
}

// ── Content Drawer (Video/Doc/Quiz) ─────────────────────────────────────────
function selectContentType(type) {
  _activeContentType = type;
  document.querySelectorAll('.ct-pill').forEach(el => el.classList.remove('ct-active'));
  const pill = document.querySelector(`.ct-pill[data-type="${type}"]`);
  if (pill) pill.classList.add('ct-active');

  const urlGroup = document.getElementById('content-url-group');
  const quizGroup = document.getElementById('quiz-builder-group');
  const finalQuizGroup = document.getElementById('final-quiz-config-group');
  const passReqCheck = document.getElementById('content-pass-required');
  const gateGroup = document.getElementById('content-gate-group');
  const urlLabel = document.getElementById('content-url-label');
  const urlHint = document.getElementById('content-url-hint');

  // Hide all type-specific groups first, then show the relevant one
  urlGroup.style.display = 'none';
  quizGroup.style.display = 'none';
  finalQuizGroup.style.display = 'none';

  if (type === 'quiz') {
    quizGroup.style.display = 'flex';
    gateGroup.style.display = 'flex';
    passReqCheck.checked = true;
  } else if (type === 'final_quiz') {
    finalQuizGroup.style.display = 'flex';
    gateGroup.style.display = 'flex';
    passReqCheck.checked = true;
    renderFinalQuizSourceList();
  } else if (type === 'submodule') {
    gateGroup.style.display = 'none';
    passReqCheck.checked = false;
  } else {
    urlGroup.style.display = 'flex';
    gateGroup.style.display = 'flex';
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
  const showThres = document.getElementById('content-pass-required').checked &&
    (_activeContentType === 'quiz' || _activeContentType === 'final_quiz');
  document.getElementById('content-threshold-group').style.display = showThres ? 'flex' : 'none';
}

// Render a grouped checklist of all available quizzes (from all modules) for the Final Quiz source selector.
// preSelected is an array of content IDs that should be pre-checked (for editing).
// Automatically excludes the item currently being edited (self-reference guard) and
// any final_quiz items (prevents nested final quizzes).
function renderFinalQuizSourceList(preSelected) {
  const container = document.getElementById('final-quiz-source-list');
  if (!container) return;
  const selected = preSelected || getSelectedFinalQuizSourceIds();
  // Exclude the item being edited to prevent self-reference
  const selfId = document.getElementById('vid-id') ? document.getElementById('vid-id').value : '';

  let html = '';
  (_trModules || []).forEach(mod => {
    // Only regular quizzes — final_quiz items are excluded to prevent nesting
    const quizItems = (mod.items || []).filter(it => it.content_type === 'quiz' && it.id !== selfId);
    if (!quizItems.length) return;
    html += `<div class="fq-module-group">
      <div class="fq-module-label">${escHtml(mod.title)}</div>`;
    quizItems.forEach(it => {
      const checked = selected.includes(it.id) ? 'checked' : '';
      html += `<label class="fq-source-item">
        <input type="checkbox" class="fq-source-cb" value="${escHtml(it.id)}" ${checked}>
        <span>${escHtml(it.title)}</span>
      </label>`;
    });
    html += `</div>`;
  });

  if (!html) html = '<div class="hint">No quizzes found. Create regular quizzes first.</div>';
  container.innerHTML = html;
}

// Returns array of currently checked source quiz IDs from the Final Quiz config group.
function getSelectedFinalQuizSourceIds() {
  return Array.from(document.querySelectorAll('#final-quiz-source-list .fq-source-cb:checked'))
    .map(cb => cb.value);
}

function openVideoDrawer(moduleId, itemId) {
  const isEdit = !!itemId;
  document.getElementById('vid-drawer-title').textContent = isEdit ? 'Edit Content' : 'Add Content';
  document.getElementById('vid-id').value = itemId || '';
  document.getElementById('vid-module-id').value = moduleId || '';
  document.getElementById('vid-drawer-msg').className = 'mod-drawer-msg';
  document.getElementById('vid-drawer-msg').textContent = '';
  populateParentSubmoduleOptions(moduleId, itemId);
  
  if (isEdit) {
    const mod = _trModules.find(m => m.id === moduleId);
    const item = mod ? (mod.items||[]).find(v => v.id === itemId) : null;
    document.getElementById('vid-title').value = item ? item.title : '';
    document.getElementById('vid-url').value = item ? (item.content_url || item.drive_url || item.url || '') : '';
    document.getElementById('vid-desc').value = item ? (item.description || '') : '';
    document.getElementById('vid-order').value = item ? (item.order || '') : '';
    document.getElementById('content-pass-required').checked = item ? !!item.pass_required : false;
    document.getElementById('content-pass-threshold').value = item ? (item.pass_threshold || 80) : 80;
    document.getElementById('content-parent-id').value = item ? (item.parent_content_id || '') : '';
    
    _quizQuestions = [];
    if (item && item.content_type === 'quiz' && item.quiz_data && item.quiz_data.questions) {
      _quizQuestions = JSON.parse(JSON.stringify(item.quiz_data.questions));
    }
    updateQuizSummary();
    selectContentType(item ? (item.content_type || 'video') : 'video');
    // For final quiz editing: pre-populate source IDs and question count after the type is selected
    if (item && item.content_type === 'final_quiz' && item.quiz_data) {
      const preSelected = item.quiz_data.source_quiz_ids || [];
      renderFinalQuizSourceList(preSelected);
      document.getElementById('final-quiz-question-count').value = item.quiz_data.question_count || 20;
    }
  } else {
    document.getElementById('vid-title').value = '';
    document.getElementById('vid-url').value = '';
    document.getElementById('vid-desc').value = '';
    const mod = _trModules.find(m => m.id === moduleId);
    document.getElementById('vid-order').value = mod ? ((mod.items||[]).length + 1) : 1;
    document.getElementById('content-pass-required').checked = false;
    document.getElementById('content-pass-threshold').value = 80;
    document.getElementById('content-parent-id').value = '';
    _quizQuestions = [];
    updateQuizSummary();
    selectContentType('video');
  }
  
  document.getElementById('vid-backdrop').classList.add('open');
  document.getElementById('vid-drawer').classList.add('open');
}

function populateParentSubmoduleOptions(moduleId, currentItemId) {
  const sel = document.getElementById('content-parent-id');
  const mod = _trModules.find(m => m.id === moduleId);
  const items = mod ? (mod.items || []) : [];

  const childrenByParent = {};
  items.forEach((item, idx) => {
    const parentId = item.parent_content_id || '';
    if (!childrenByParent[parentId]) childrenByParent[parentId] = [];
    childrenByParent[parentId].push({ item, idx });
  });

  const sortSiblings = (a, b) => {
    const aOrder = Number(a.item.order);
    const bOrder = Number(b.item.order);
    const aOrderValid = Number.isFinite(aOrder);
    const bOrderValid = Number.isFinite(bOrder);
    if (aOrderValid && bOrderValid && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrderValid !== bOrderValid) return aOrderValid ? -1 : 1;

    const aTitle = (a.item.title || '').toLowerCase();
    const bTitle = (b.item.title || '').toLowerCase();
    if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);

    return a.idx - b.idx;
  };

  const orderedSubmodules = [];
  const seen = new Set();
  const walk = (parentId = '', depth = 0) => {
    const children = (childrenByParent[parentId] || []).slice().sort(sortSiblings);
    children.forEach(({ item }) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);

      if (item.content_type === 'submodule' && item.id !== currentItemId) {
        orderedSubmodules.push({ item, depth });
      }

      walk(item.id, depth + 1);
    });
  };

  walk('');

  sel.innerHTML = `<option value="">${escHtml('Top level (no parent)')}</option>` +
    orderedSubmodules
      .map(({ item, depth }) => {
        const indent = depth > 0 ? `${'— '.repeat(depth)}↳ ` : '';
        return `<option value="${item.id}">${escHtml(`${indent}${item.title || ''}`)}</option>`;
      })
      .join('');
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
  const parentContentId = document.getElementById('content-parent-id').value || '';
  
  if (!title) { showDrawerMsg(msgEl, 'err', 'Title is required.'); return; }
  
  if (_activeContentType === 'video' || _activeContentType === 'document') {
    if (!url) { showDrawerMsg(msgEl, 'err', 'URL is required.'); return; }
    if (!extractDriveId(url)) { showDrawerMsg(msgEl, 'err', 'Could not parse a Google Drive file ID from this URL.'); return; }
  } else if (_activeContentType === 'quiz') {
    if (_quizQuestions.length === 0) { showDrawerMsg(msgEl, 'err', 'Add at least one quiz question.'); return; }
  } else if (_activeContentType === 'final_quiz') {
    if (getSelectedFinalQuizSourceIds().length === 0) { showDrawerMsg(msgEl, 'err', 'Select at least one source quiz.'); return; }
  }

  btn.disabled = true; btn.textContent = 'Saving...';
  msgEl.className = 'mod-drawer-msg'; msgEl.textContent = '';

  // final_quiz is stored as 'quiz' in the backend; the is_final_quiz flag inside quiz_data distinguishes it
  const backendContentType = _activeContentType === 'final_quiz' ? 'quiz'
    : _activeContentType === 'submodule' ? 'document'
    : _activeContentType;
  const backendContentUrl = _activeContentType === 'submodule' ? TR_SUBMODULE_URL_MARKER : url;

  let quizDataPayload = '';
  if (_activeContentType === 'quiz') {
    quizDataPayload = JSON.stringify({ questions: _quizQuestions });
  } else if (_activeContentType === 'final_quiz') {
    const sourceIds = getSelectedFinalQuizSourceIds();
    const questionCount = parseInt(document.getElementById('final-quiz-question-count').value) || 20;
    quizDataPayload = JSON.stringify({ is_final_quiz: true, source_quiz_ids: sourceIds, question_count: questionCount });
  }

  const payload = {
    action: itemId ? 'update_content' : 'create_content', token: _s.token,
    content_id: itemId, module_id: moduleId, title, content_url: backendContentUrl,
    description: trComposeDescriptionWithParent_(desc, parentContentId), order, content_type: backendContentType,
    pass_required: passReq, pass_threshold: passThres,
    parent_content_id: parentContentId,
    quiz_data: quizDataPayload
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
    const imageUrl = div.querySelector('.qw-img-input') ? div.querySelector('.qw-img-input').value.trim() : '';
    const isMulti = _quizQuestions[idx] && _quizQuestions[idx].type === 'multi';
    const opts = [];
    let correct = isMulti ? [] : 0;
    let optOrigIdx = 0;  // track which option index in the final opts[] list
    div.querySelectorAll('.qw-o-text').forEach((inp, oIdx) => {
      const txt = inp.value.trim();
      if (!txt) return;
      const inpChecked = div.querySelector(`input[name="qw-r-${idx}"][value="${oIdx}"]`);
      if (isMulti) {
        if (inpChecked && inpChecked.checked) correct.push(optOrigIdx);
      } else {
        if (inpChecked && inpChecked.checked) correct = optOrigIdx;
      }
      opts.push(txt);
      optOrigIdx++;
    });
    if (opts.length < 2) { valid = false; return; }
    const explanation = div.querySelector('.qw-exp-input') ? div.querySelector('.qw-exp-input').value.trim() : '';
    const type = isMulti ? 'multi' : 'single';
    tempArr.push({ question: qText, image_url: imageUrl, options: opts, correct: correct, type: type, explanation: explanation });
  });

  if (!valid) { alert('Each question needs at least 2 options.'); return; }
  _quizQuestions = tempArr;
  closeQuizWizard();
}

function renderQuizWizard() {
  const cont = document.getElementById('qw-questions');
  if (!_quizQuestions.length) _quizQuestions.push({ question: '', image_url: '', options: ['',''], correct: 0 }); // init with 1 blank
  
  cont.innerHTML = _quizQuestions.map((q, qIdx) => {
    const qType = q.type || 'single';
    const isMulti = qType === 'multi';
    const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
    return `
    <div class="qw-q-card">
      <div style="display:flex;justify-content:space-between;margin-bottom:.5rem;">
        <strong>Question ${qIdx + 1}</strong>
        <button class="v-act-btn danger" onclick="removeQuizQuestion(${qIdx})">🗑</button>
      </div>
      <input type="text" class="qw-q-text" value="${escHtml(q.question)}" placeholder="Enter your question here..." style="width:100%;padding:.5rem;margin-bottom:.5rem;">
      <input type="text" class="qw-img-input" value="${escHtml(q.image_url || '')}" placeholder="Optional image URL (Google Drive or direct image link)">
      <div class="qw-type-row">
        <span class="qw-type-label">Answer type:</span>
        <div class="qw-type-toggle">
          <button class="qw-type-btn${!isMulti ? ' active' : ''}" onclick="setQwType(${qIdx},'single')">Single choice</button>
          <button class="qw-type-btn${isMulti ? ' active' : ''}" onclick="setQwType(${qIdx},'multi')">Multiple choice</button>
        </div>
      </div>
      <div style="font-size:.8rem;color:#666;margin-bottom:.25rem;">${isMulti ? 'Check all correct answers:' : 'Select the radio button next to the correct answer:'}</div>
      <div id="qw-opts-${qIdx}">
        ${q.options.map((opt, oIdx) => {
          const isCorrect = isMulti ? correctArr.includes(oIdx) : q.correct == oIdx;
          return `
          <div style="display:flex;align-items:center;margin-bottom:.25rem;gap:.5rem;">
            <input type="${isMulti ? 'checkbox' : 'radio'}" name="qw-r-${qIdx}" value="${oIdx}" ${isCorrect ? 'checked' : ''}>
            <input type="text" class="qw-o-text" value="${escHtml(opt)}" placeholder="Option ${oIdx+1}" style="flex:1;padding:.4rem;">
            <button class="v-act-btn" onclick="removeQuizOption(${qIdx}, ${oIdx})">✕</button>
          </div>`;
        }).join('')}
      </div>
      <button class="mod-act-btn" style="margin-top:.5rem" onclick="addQuizOption(${qIdx})">+ Add Option</button>
      <textarea class="qw-exp-input" rows="2" placeholder="Optional: Explain why the correct answer is right (shown to technicians after they complete the quiz)...">${escHtml(q.explanation || '')}</textarea>
    </div>`;
  }).join('');
}

function setQwType(qIdx, type) {
  savePartialQuizState();
  _quizQuestions[qIdx].type = type;
  // Reset correct to appropriate default when switching types
  if (type === 'multi') {
    if (!Array.isArray(_quizQuestions[qIdx].correct)) _quizQuestions[qIdx].correct = [0];
  } else {
    if (Array.isArray(_quizQuestions[qIdx].correct)) _quizQuestions[qIdx].correct = _quizQuestions[qIdx].correct[0] || 0;
  }
  renderQuizWizard();
}

function addQuizQuestion() {
  savePartialQuizState();
  _quizQuestions.push({ question: '', image_url: '', options: ['',''], correct: 0, type: 'single', explanation: '' });
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
    const imageUrl = div.querySelector('.qw-img-input') ? div.querySelector('.qw-img-input').value : '';
    const isMulti = _quizQuestions[idx] && _quizQuestions[idx].type === 'multi';
    const opts = [];
    let correct = isMulti ? [] : 0;
    div.querySelectorAll('.qw-o-text').forEach((inp, oIdx) => {
      opts.push(inp.value);
      const inpChecked = div.querySelector(`input[name="qw-r-${idx}"][value="${oIdx}"]`);
      if (isMulti) {
        if (inpChecked && inpChecked.checked) correct.push(oIdx);
      } else {
        if (inpChecked && inpChecked.checked) correct = oIdx;
      }
    });
    const explanation = div.querySelector('.qw-exp-input') ? div.querySelector('.qw-exp-input').value : '';
    tempArr.push({ question: qText, image_url: imageUrl, options: opts, correct: correct,
                   type: isMulti ? 'multi' : 'single', explanation: explanation });
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
      <div style="font-weight:600;margin-bottom:1rem;color:var(--mcps-blue);">Student Preview (correct answers highlighted):</div>
      ${_quizQuestions.map((q, qIdx) => {
        const isMulti = q.type === 'multi';
        const correctArr = Array.isArray(q.correct) ? q.correct : [q.correct];
        const typeBadge = isMulti ? `<span class="qz-type-badge">Select all that apply</span>` : '';
        const expHtml = q.explanation ? `<div class="qz-explanation"><span class="exp-label">Why?</span>${escHtml(q.explanation)}</div>` : '';
        const imgSrc = getQuizImageSrc(q.image_url || '');
        const imgHtml = imgSrc ? `<div class="qz-question-image-wrap"><img class="qz-question-image" src="${escHtml(imgSrc)}" alt="Question ${qIdx + 1} reference image"></div>` : '';
        return `
        <div class="qz-question" style="background:#f1f3f4;padding:1rem;border-radius:4px;margin-bottom:1rem;">
          <div class="qz-qtext">${qIdx + 1}. ${escHtml(q.question) || '<i>[Empty Question]</i>'}${typeBadge}</div>
          ${imgHtml}
          <div class="qz-options">
            ${q.options.map((opt, oIdx) => {
              const isCorrect = correctArr.includes(oIdx);
              return `<label class="qz-option-label${isCorrect ? ' qz-selected' : ''}">
                <input type="${isMulti ? 'checkbox' : 'radio'}" disabled ${isCorrect ? 'checked' : ''}>
                <span style="${isCorrect ? 'color:var(--ok);font-weight:bold;' : ''}">${escHtml(opt) || '<i>[Empty Option]</i>'}</span>
              </label>`;
            }).join('')}
          </div>
          ${expHtml}
        </div>`;
      }).join('')}
    `;
  } else {
    btn.innerHTML = '👁 Preview Quiz';
    pre.style.display = 'none';
    bdy.style.display = 'block';
  }
}

// ── Heads-up SMS ──────────────────────────────────────────────────────────────
function headsUp(e, btn) {
  e.stopPropagation();
  if (btn.classList.contains('sending') || btn.classList.contains('sent')) return;
  const poolId = btn.dataset.poolId;
  const custName = btn.dataset.custName;
  btn.classList.add('sending');
  api({ action: 'send_heads_up', token: _s.token, pool_id: poolId, customer_name: custName })
    .then(function(res) {
      btn.classList.remove('sending');
      if (res.ok) {
        btn.classList.add('sent');
        btn.title = 'Heads up sent!';
        huToast('\u2705 Heads up sent to ' + res.customer + '!');
        setTimeout(function() {
          btn.classList.remove('sent');
          btn.title = 'Send heads up SMS';
        }, 5000);
      } else {
        huToast('\u26a0\ufe0f ' + (res.error || 'Could not send heads up'), true);
      }
    })
    .catch(function() {
      btn.classList.remove('sending');
      huToast('\u26a0\ufe0f Network error — could not send heads up', true);
    });
}

function huToast(msg, isErr) {
  var t = document.getElementById('hu-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'hu-toast';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);'
      + 'background:#1a1a1a;color:#fff;padding:.6rem 1.1rem;border-radius:10px;font-size:.85rem;'
      + 'font-family:Barlow,sans-serif;z-index:9999;opacity:0;transition:all .25s;pointer-events:none;'
      + 'white-space:nowrap;max-width:90vw;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = isErr ? '#7f1d1d' : '#1a1a1a';
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._timer);
  t._timer = setTimeout(function() {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(20px)';
  }, 4000);
}

