/**
 * JLPT MASTER - Core Application Logic
 * Interactive Quiz & Smart Self-Updating Mistake Notebook
 */

(function () {
  'use strict';

  // --- Sound Effects using Web Audio API (Offline & Zero-dependency) ---
  class SoundFX {
    constructor() {
      this.ctx = null;
    }

    init() {
      if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
    }

    playCorrect() {
      if (!state.sound) return;
      this.init();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 (Bright chime)
      notes.forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);

        gain.gain.setValueAtTime(0.12, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.35);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.35);
      });
    }

    playWrong() {
      if (!state.sound) return;
      this.init();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.28);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    }
  }

  const sound = new SoundFX();

  // --- Local Storage Keys ---
  const STORAGE_KEYS = {
    STATE: 'jlpt_state_v1',
    MISTAKES: 'jlpt_mistakes_v1',
    HISTORY: 'jlpt_history_v1',
    BOOKMARKS: 'jlpt_bookmarks_v1'
  };

  // --- Global Application State ---
  let state = {
    theme: 'dark',
    furigana: true,
    showTrans: false, // false: hidden by default (peek on click/press), true: always visible
    sound: true,
    currentTab: 'quiz',
    level: 'N1',
    type: 'ALL',
    mode: 'drill', // 'drill' (instant feedback) | 'exam' (mock test) | 'mistake-drill'
    currentIndex: 0,
    isShuffled: false,
    answered: false,
    selectedOption: null,
    // Exam mode state
    exam: {
      active: false,
      questions: [],
      userAnswers: {},
      startTime: null,
      timerInterval: null
    }
  };

  // User persistent data
  let mistakes = {}; // id -> mistake object
  let history = {};  // id -> { solved: 0, correct: 0, lastResult: true/false }
  let bookmarks = new Set();

  // Active question set based on level & filters
  let currentQuestions = [];

  // --- Google Drive Sync Manager ---
  const syncManager = {
    connected: false,
    syncUrl: window.location.origin.includes('localhost:3000') ? '' : 'http://localhost:3000',
    debounceTimer: null,

    async init() {
      const syncDot = document.getElementById('sync-dot');
      const syncText = document.getElementById('sync-text');
      const syncBadge = document.getElementById('sync-status-badge');

      try {
        const res = await fetch(`${this.syncUrl}/api/sync-data`, {
          method: 'GET',
          cache: 'no-cache'
        });

        if (res.ok) {
          const driveData = await res.json();
          this.connected = true;
          if (syncDot) syncDot.className = 'sync-dot connected';
          if (syncText) syncText.textContent = '구글 드라이브 실시간 동기화';
          if (syncBadge) syncBadge.title = '구글 드라이브 "일취" 폴더와 실시간 자동 동기화 중입니다.';

          // Merge drive data with local data
          this.mergeDriveData(driveData);
          console.log('[Sync] Connected to Google Drive sync server!');
          return;
        }
      } catch (err) {
        // Server not running, running in offline/file mode
      }

      this.connected = false;
      if (syncDot) syncDot.className = 'sync-dot offline';
      if (syncText) syncText.textContent = '로컬 브라우저 저장 모드';
      if (syncBadge) syncBadge.title = '로컬 저장소에 저장 중입니다. "동기화_학습기_실행.bat"을 실행하면 구글 드라이브와 실시간 동기화됩니다.';
    },

    mergeDriveData(driveData) {
      let updated = false;
      if (driveData.mistakes) {
        for (const [id, m] of Object.entries(driveData.mistakes)) {
          if (!mistakes[id] || (m.lastWrongDate || 0) > (mistakes[id].lastWrongDate || 0)) {
            mistakes[id] = m;
            updated = true;
          }
        }
      }
      if (driveData.history) {
        for (const [id, h] of Object.entries(driveData.history)) {
          if (!history[id] || (h.lastDate || 0) > (history[id].lastDate || 0)) {
            history[id] = h;
            updated = true;
          }
        }
      }
      if (driveData.bookmarks && Array.isArray(driveData.bookmarks)) {
        driveData.bookmarks.forEach(bId => bookmarks.add(bId));
        updated = true;
      }

      if (updated) {
        localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
        localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(Array.from(bookmarks)));
        updateMistakeBadge();
      }
    },

    scheduleSync() {
      if (!this.connected) return;
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.pushToDrive(), 400);
    },

    async pushToDrive() {
      if (!this.connected) return;
      try {
        const payload = {
          mistakes,
          history,
          bookmarks: Array.from(bookmarks),
          clientTimestamp: Date.now()
        };

        const res = await fetch(`${this.syncUrl}/api/sync-data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const syncText = document.getElementById('sync-text');
          if (syncText) {
            syncText.textContent = '구글 드라이브 동기화됨 ✓';
            setTimeout(() => {
              if (syncText) syncText.textContent = '구글 드라이브 실시간 동기화';
            }, 1500);
          }
        }
      } catch (err) {
        console.warn('[Sync] Failed to push to Google Drive sync server:', err);
      }
    }
  };

  // --- Initialization ---
  function init() {
    loadPersistentData();
    applyTheme(state.theme);
    setupEventListeners();
    updateMistakeBadge();
    loadLevelQuestions(state.level);
    renderTypeFilterChips();
    renderCurrentQuestion();
    renderStats();
    syncManager.init();
  }

  // --- Persistence Handlers ---
  function loadPersistentData() {
    try {
      const savedState = localStorage.getItem(STORAGE_KEYS.STATE);
      if (savedState) {
        const parsed = JSON.parse(savedState);
        state.theme = parsed.theme || 'dark';
        state.furigana = parsed.furigana !== undefined ? parsed.furigana : true;
        state.showTrans = parsed.showTrans !== undefined ? parsed.showTrans : false;
        state.sound = parsed.sound !== undefined ? parsed.sound : true;
        state.level = parsed.level || 'N1';
        state.type = parsed.type || 'ALL';
        state.mode = parsed.mode || 'drill';
      }

      const savedMistakes = localStorage.getItem(STORAGE_KEYS.MISTAKES);
      if (savedMistakes) mistakes = JSON.parse(savedMistakes);

      const savedHistory = localStorage.getItem(STORAGE_KEYS.HISTORY);
      if (savedHistory) history = JSON.parse(savedHistory);

      const savedBookmarks = localStorage.getItem(STORAGE_KEYS.BOOKMARKS);
      if (savedBookmarks) bookmarks = new Set(JSON.parse(savedBookmarks));
    } catch (e) {
      console.warn('Failed to parse saved state from localStorage:', e);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEYS.STATE, JSON.stringify({
      theme: state.theme,
      furigana: state.furigana,
      showTrans: state.showTrans,
      sound: state.sound,
      level: state.level,
      type: state.type,
      mode: state.mode
    }));
  }

  function saveMistakes() {
    localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
    updateMistakeBadge();
    if (state.currentTab === 'mistakes') {
      renderMistakesList();
    }
    syncManager.scheduleSync();
  }

  function saveHistory() {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    if (state.currentTab === 'stats') {
      renderStats();
    }
    syncManager.scheduleSync();
  }

  function saveBookmarks() {
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(Array.from(bookmarks)));
    syncManager.scheduleSync();
  }

  // --- Level & Questions Management ---
  function loadLevelQuestions(level) {
    state.level = level;
    saveState();

    const rawQuestions = (window.JLPT_DATA && window.JLPT_DATA[level]) || [];
    
    // Filter by type
    if (state.type === 'ALL') {
      currentQuestions = [...rawQuestions];
    } else {
      currentQuestions = rawQuestions.filter(q => q.typeName === state.type);
    }

    if (state.isShuffled) {
      shuffleArray(currentQuestions);
    }

    state.currentIndex = 0;
    state.answered = false;
    state.selectedOption = null;

    updateLevelTabsUI();
    renderTypeFilterChips();
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function updateLevelTabsUI() {
    document.querySelectorAll('.level-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === state.level);
    });

    // Update counts on buttons if available
    ['N1', 'N2', 'N3', 'N4', 'N5'].forEach(lvl => {
      const cntEl = document.getElementById(`count-${lvl.toLowerCase()}`);
      if (cntEl && window.JLPT_DATA && window.JLPT_DATA[lvl]) {
        cntEl.textContent = window.JLPT_DATA[lvl].length.toLocaleString();
      }
    });
  }

  function renderTypeFilterChips() {
    const container = document.getElementById('type-filter-container');
    if (!container) return;

    const rawQuestions = (window.JLPT_DATA && window.JLPT_DATA[state.level]) || [];
    const typeCounts = { ALL: rawQuestions.length };

    rawQuestions.forEach(q => {
      typeCounts[q.typeName] = (typeCounts[q.typeName] || 0) + 1;
    });

    let html = `<button class="type-chip ${state.type === 'ALL' ? 'active' : ''}" data-type="ALL">전체 (${typeCounts.ALL})</button>`;
    
    for (const [tName, count] of Object.entries(typeCounts)) {
      if (tName === 'ALL') continue;
      html += `<button class="type-chip ${state.type === tName ? 'active' : ''}" data-type="${tName}">${tName} (${count})</button>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('.type-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.type = chip.dataset.type;
        loadLevelQuestions(state.level);
        renderCurrentQuestion();
      });
    });
  }

  // --- Question Rendering & Interaction ---
  function renderCurrentQuestion() {
    const qTextEl = document.getElementById('q-text');
    const qTransEl = document.getElementById('q-translation');
    const qInstructEl = document.getElementById('q-instruction');
    const badgeLevel = document.getElementById('q-badge-level');
    const badgeType = document.getElementById('q-badge-type');
    const indicator = document.getElementById('q-index-indicator');
    const mistakeBadge = document.getElementById('q-mistake-status');
    const btnBookmark = document.getElementById('btn-bookmark');
    const explBox = document.getElementById('explanation-box');
    const optionsContainer = document.getElementById('options-container');

    if (!currentQuestions || currentQuestions.length === 0) {
      qTextEl.innerHTML = '<div style="color:var(--text-muted); font-size:1.1rem;">해당 조건에 맞는 문제가 없습니다. 다른 필터를 선택해 주세요.</div>';
      qTransEl.textContent = '';
      optionsContainer.innerHTML = '';
      explBox.classList.add('hidden');
      return;
    }

    // Bounds checking
    if (state.currentIndex >= currentQuestions.length) state.currentIndex = 0;
    if (state.currentIndex < 0) state.currentIndex = currentQuestions.length - 1;

    const q = currentQuestions[state.currentIndex];
    state.answered = false;
    state.selectedOption = null;

    // Header info
    badgeLevel.textContent = q.level;
    badgeType.textContent = q.typeName;
    indicator.textContent = `# ${state.currentIndex + 1} / ${currentQuestions.length.toLocaleString()}`;
    qInstructEl.textContent = q.instruction || '문제를 잘 읽고 알맞은 것을 고르세요.';

    // Bookmark state
    const isBookmarked = bookmarks.has(q.id);
    btnBookmark.classList.toggle('active', isBookmarked);

    // Mistake badge
    const m = mistakes[q.id];
    if (m && !m.isMastered) {
      mistakeBadge.classList.remove('hidden');
      mistakeBadge.textContent = `⚠️ 오답 ${m.count}회`;
    } else if (m && m.isMastered) {
      mistakeBadge.classList.remove('hidden');
      mistakeBadge.style.color = 'var(--success)';
      mistakeBadge.style.borderColor = 'var(--success-border)';
      mistakeBadge.style.background = 'var(--success-bg)';
      mistakeBadge.textContent = '✨ 정복 완료';
    } else {
      mistakeBadge.classList.add('hidden');
    }

    // Text rendering with furigana toggle
    let displayedQuestion = state.furigana ? q.qRuby : q.qPlain;
    qTextEl.innerHTML = formatQuestionDisplay(displayedQuestion, q.typeCode);
    
    // Question Translation
    qTransEl.textContent = q.qTrans || '';
    if (state.showTrans || state.answered) {
      qTransEl.classList.remove('hidden');
    } else {
      qTransEl.classList.add('hidden');
    }

    // Question text interaction (Long-press or click toggles question translation)
    if (qTextEl) {
      let qPressTimer = null;
      let qMoved = false;
      let qStartX = 0;
      let qStartY = 0;
      let isQLongPress = false;

      qTextEl.onpointerdown = (e) => {
        qMoved = false;
        isQLongPress = false;
        qStartX = e.clientX;
        qStartY = e.clientY;

        qPressTimer = setTimeout(() => {
          if (!qMoved && q.qTrans) {
            isQLongPress = true;
            qTransEl.classList.toggle('hidden');
            if (navigator.vibrate) navigator.vibrate(30);
          }
        }, 250);
      };

      qTextEl.onpointermove = (e) => {
        if (Math.abs(e.clientX - qStartX) > 8 || Math.abs(e.clientY - qStartY) > 8) {
          qMoved = true;
          clearTimeout(qPressTimer);
        }
      };

      qTextEl.onpointerup = () => clearTimeout(qPressTimer);
      qTextEl.onpointercancel = () => clearTimeout(qPressTimer);

      qTextEl.onclick = () => {
        if (!isQLongPress && q.qTrans) {
          qTransEl.classList.toggle('hidden');
        }
        isQLongPress = false;
      };
    }

    // Render Options (Clean display with hidden inline translation)
    let optionsHtml = '';
    const isTransVisible = state.showTrans || state.answered;

    q.options.forEach((opt, idx) => {
      const copyDisplay = state.furigana ? opt.copy : (opt.copyNoRuby || opt.copy);
      
      let transHtml = '';
      if (opt.trans) {
        transHtml = `<div class="opt-trans-text ${isTransVisible ? '' : 'hidden'}" id="opt-trans-${idx}">${escapeHtml(opt.trans)}</div>`;
      }

      optionsHtml += `
        <button class="option-btn" data-index="${idx}" id="opt-${idx}">
          <span class="opt-marker">${opt.marker || (idx + 1)}</span>
          <div class="opt-content">
            <span class="opt-text">${copyDisplay}</span>
            ${transHtml}
          </div>
        </button>
      `;
    });
    optionsContainer.innerHTML = optionsHtml;

    // Attach long-press (reveal Korean translation) and click (submit answer) to option buttons
    optionsContainer.querySelectorAll('.option-btn').forEach((btn, idx) => {
      let optPressTimer = null;
      let isLongPress = false;
      let pointerMoved = false;
      let startX = 0;
      let startY = 0;

      btn.addEventListener('pointerdown', (e) => {
        isLongPress = false;
        pointerMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        btn.classList.add('pressing');

        optPressTimer = setTimeout(() => {
          if (!pointerMoved && q.options[idx]) {
            isLongPress = true;
            btn.classList.remove('pressing');
            btn.classList.add('long-pressing');

            // Reveal/toggle this option's Korean translation
            const transEl = document.getElementById(`opt-trans-${idx}`);
            if (transEl) {
              transEl.classList.toggle('hidden');
            }
            if (navigator.vibrate) navigator.vibrate(35);

            setTimeout(() => btn.classList.remove('long-pressing'), 350);
          }
        }, 250); // 250ms long-press threshold
      });

      btn.addEventListener('pointermove', (e) => {
        if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
          pointerMoved = true;
          clearTimeout(optPressTimer);
          btn.classList.remove('pressing', 'long-pressing');
        }
      });

      btn.addEventListener('pointerup', () => {
        clearTimeout(optPressTimer);
        btn.classList.remove('pressing');
      });

      btn.addEventListener('pointercancel', () => {
        clearTimeout(optPressTimer);
        btn.classList.remove('pressing', 'long-pressing');
      });

      // Click listener: Only submit if this was a quick click, NOT a long-press!
      btn.addEventListener('click', (e) => {
        if (isLongPress) {
          e.preventDefault();
          e.stopPropagation();
          isLongPress = false;
          return; // Do NOT submit answer on long-press!
        }
        btn.classList.remove('pressing', 'long-pressing');
        const optIdx = parseInt(btn.dataset.index, 10);
        handleOptionSelect(optIdx);
      });
    });

    // Hide explanation initially
    explBox.classList.add('hidden');
  }

  function formatQuestionDisplay(text, typeCode) {
    if (!text) return '';
    return text
      .replace(/\(　\)/g, '<span class="question-blank">(　)</span>')
      .replace(/\[(.*?)\]/g, '<span class="question-target-word">【$1】</span>');
  }

  function handleOptionSelect(optIndex) {
    if (state.answered && state.mode === 'drill') return;

    const q = currentQuestions[state.currentIndex];
    const selectedOpt = q.options[optIndex];
    if (!selectedOpt) return;

    state.answered = true;
    state.selectedOption = optIndex;

    const isCorrect = selectedOpt.isCorrect;
    const optionBtns = document.querySelectorAll('.option-btn');

    // Auto-reveal all translations upon answering
    const qTransEl = document.getElementById('q-translation');
    if (qTransEl) qTransEl.classList.remove('hidden');
    document.querySelectorAll('.opt-trans-text').forEach(el => el.classList.remove('hidden'));

    // Update button visual states
    optionBtns.forEach((btn, idx) => {
      btn.classList.add('disabled');
      if (q.options[idx].isCorrect) {
        btn.classList.add('state-correct');
      }
      if (idx === optIndex && !isCorrect) {
        btn.classList.add('state-wrong');
      }
    });

    // Update History stats
    if (!history[q.id]) {
      history[q.id] = { solved: 0, correct: 0, lastResult: isCorrect, lastDate: Date.now() };
    }
    history[q.id].solved++;
    if (isCorrect) history[q.id].correct++;
    history[q.id].lastResult = isCorrect;
    history[q.id].lastDate = Date.now();
    saveHistory();

    // Auto-update Mistake Notebook
    if (!isCorrect) {
      sound.playWrong();
      if (!mistakes[q.id]) {
        mistakes[q.id] = {
          ...q,
          count: 1,
          firstWrongDate: Date.now(),
          lastWrongDate: Date.now(),
          wrongChoice: selectedOpt.copy,
          isMastered: false,
          isBookmarked: bookmarks.has(q.id)
        };
      } else {
        mistakes[q.id].count++;
        mistakes[q.id].lastWrongDate = Date.now();
        mistakes[q.id].wrongChoice = selectedOpt.copy;
        mistakes[q.id].isMastered = false;
      }
      saveMistakes();
      showToast('⚠️ 오답노트에 자동 등록되었습니다.');
    } else {
      sound.playCorrect();
      // If this was an existing mistake, celebrate mastery!
      if (mistakes[q.id] && !mistakes[q.id].isMastered) {
        mistakes[q.id].isMastered = true;
        mistakes[q.id].masteredDate = Date.now();
        saveMistakes();
        showToast('🎉 오답노트 문제 정복(마스터) 완료!');
      }
    }

    // Reveal Explanation Drawer in drill mode
    if (state.mode === 'drill' || state.mode === 'mistake-drill') {
      revealExplanation(q, isCorrect);
    }
  }

  function revealExplanation(q, isCorrect) {
    const explBox = document.getElementById('explanation-box');
    const resultBanner = document.getElementById('result-banner');
    const resultIcon = document.getElementById('result-icon');
    const resultText = document.getElementById('result-text');
    const autoNoteTag = document.getElementById('auto-note-tag');
    const autoNoteText = document.getElementById('auto-note-text');
    const csJa = document.getElementById('cs-ja');
    const csKo = document.getElementById('cs-ko');
    const csCard = document.getElementById('completed-sentence-card');
    const explMain = document.getElementById('expl-main-text');
    const choiceNotesList = document.getElementById('choice-notes-list');

    explBox.classList.remove('hidden');

    if (isCorrect) {
      resultBanner.className = 'result-banner is-correct';
      resultIcon.textContent = '✓';
      resultText.textContent = '정답입니다! 잘하셨습니다.';
      autoNoteTag.classList.add('hidden');
    } else {
      resultBanner.className = 'result-banner is-wrong';
      resultIcon.textContent = '✗';
      resultText.textContent = '아쉽습니다. 오답입니다.';
      autoNoteTag.classList.remove('hidden');
      autoNoteText.textContent = `오답노트에 기록됨 (총 ${mistakes[q.id] ? mistakes[q.id].count : 1}회 오답)`;
    }

    // Complete sentence display
    if (q.ansJa && q.typeCode !== 'kanji_reading') {
      csCard.classList.remove('hidden');
      csJa.textContent = q.ansJa;
      csKo.textContent = q.ansKo || '';
    } else {
      csCard.classList.add('hidden');
    }

    // Core explanation
    explMain.textContent = q.expl && q.expl.main ? q.expl.main : '정답과 해설을 확인하고 복습하세요.';

    // Choice notes breakdown
    if (q.expl && q.expl.choices && q.expl.choices.length > 0) {
      let choicesHtml = '';
      q.expl.choices.forEach(c => {
        choicesHtml += `
          <div class="choice-note-item">
            <span class="choice-note-marker">${c.marker}</span>
            <span>${escapeHtml(c.note)}</span>
          </div>
        `;
      });
      choiceNotesList.innerHTML = choicesHtml;
      document.getElementById('expl-choices-section').classList.remove('hidden');
    } else {
      document.getElementById('expl-choices-section').classList.add('hidden');
    }

    // Scroll to explanation smoothly
    explBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function nextQuestion() {
    if (state.currentIndex < currentQuestions.length - 1) {
      state.currentIndex++;
    } else {
      state.currentIndex = 0;
      showToast('한 바퀴를 모두 풀었습니다! 처음 문제로 돌아갑니다.');
    }
    renderCurrentQuestion();
  }

  function prevQuestion() {
    if (state.currentIndex > 0) {
      state.currentIndex--;
    } else {
      state.currentIndex = currentQuestions.length - 1;
    }
    renderCurrentQuestion();
  }

  // --- Mistakes Notebook Tab Rendering ---
  function renderMistakesList() {
    const listContainer = document.getElementById('mistakes-list');
    const emptyState = document.getElementById('mistakes-empty-state');
    const nbTotal = document.getElementById('nb-total-mistakes');
    const nbMastered = document.getElementById('nb-mastered-count');
    const nbAccuracy = document.getElementById('nb-accuracy-rate');

    const searchKeyword = (document.getElementById('input-mistake-search').value || '').trim().toLowerCase();
    const filterLevel = document.getElementById('select-mistake-level').value;
    const filterType = document.getElementById('select-mistake-type').value;
    const filterStatus = document.getElementById('select-mistake-status').value;

    const allMistakes = Object.values(mistakes);
    const masteredCount = allMistakes.filter(m => m.isMastered).length;
    const activeCount = allMistakes.length - masteredCount;

    nbTotal.textContent = activeCount;
    nbMastered.textContent = masteredCount;
    const recoveryRate = allMistakes.length > 0 ? Math.round((masteredCount / allMistakes.length) * 100) : 0;
    nbAccuracy.textContent = `${recoveryRate}%`;

    // Filter items
    let filtered = allMistakes.filter(m => {
      if (filterLevel !== 'ALL' && m.level !== filterLevel) return false;
      if (filterType !== 'ALL' && m.typeName !== filterType) return false;
      if (filterStatus === 'active' && m.isMastered) return false;
      if (filterStatus === 'mastered' && !m.isMastered) return false;
      if (filterStatus === 'bookmarked' && !bookmarks.has(m.id)) return false;

      if (searchKeyword) {
        const text = `${m.qPlain} ${m.qTrans} ${m.ansJa} ${m.ansKo} ${m.expl?.main || ''}`.toLowerCase();
        if (!text.includes(searchKeyword)) return false;
      }
      return true;
    });

    // Sort by latest wrong date descending
    // Sort: 1) Most frequent mistakes first (많이 틀린 순), 2) Latest date
    filtered.sort((a, b) => {
      if ((b.count || 1) !== (a.count || 1)) {
        return (b.count || 1) - (a.count || 1);
      }
      return (b.lastWrongDate || 0) - (a.lastWrongDate || 0);
    });

    if (filtered.length === 0) {
      listContainer.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    let html = '';
    filtered.forEach(m => {
      const isBookmarked = bookmarks.has(m.id);
      const isMastered = m.isMastered;
      const correctOpt = m.options.find(o => o.isCorrect);

      html += `
        <div class="mistake-card-item ${isMastered ? 'is-mastered' : ''}" data-id="${m.id}">
          <div class="mc-header">
            <div class="mc-meta">
              <span class="badge badge-level">${m.level}</span>
              <span class="badge badge-type">${m.typeName}</span>
              <span class="badge badge-mistake">⚠️ 오답 ${m.count}회</span>
              ${isMastered ? '<span class="badge" style="background:var(--success); color:#fff;">✨ 정복됨</span>' : ''}
            </div>
            <div class="mc-actions">
              <button class="btn btn-ghost btn-sm btn-mc-bookmark ${isBookmarked ? 'active' : ''}" data-id="${m.id}" title="북마크">
                ★
              </button>
              <button class="btn btn-secondary btn-sm btn-mc-master" data-id="${m.id}">
                ${isMastered ? '마스터 취소' : '✓ 정복 완료'}
              </button>
              <button class="btn btn-danger-ghost btn-sm btn-mc-delete" data-id="${m.id}" title="오답노트에서 영구 삭제">
                ✕
              </button>
            </div>
          </div>

          <div class="mc-question">${escapeHtml(m.qPlain)}</div>
          <div class="mc-trans">${escapeHtml(m.qTrans || '')}</div>

          <div class="mc-details">
            <div class="mc-ans-row">
              <span class="mc-ans-badge">정답:</span>
              <span>${correctOpt ? escapeHtml(correctOpt.copy) : ''} ${correctOpt && correctOpt.trans ? '(' + escapeHtml(correctOpt.trans) + ')' : ''}</span>
              ${m.wrongChoice ? `<span style="color:var(--danger); font-size:0.8rem; margin-left:auto;">(내가 찍은 답: ${escapeHtml(m.wrongChoice)})</span>` : ''}
            </div>
            ${m.ansJa && m.typeCode !== 'kanji_reading' ? `<div style="color:var(--text-secondary); font-size:0.85rem;">완성문: ${escapeHtml(m.ansJa)}</div>` : ''}
            <div class="mc-expl-preview">💡 ${escapeHtml(m.expl?.main || '')}</div>
          </div>
        </div>
      `;
    });

    listContainer.innerHTML = html;

    // Attach listeners for card actions
    listContainer.querySelectorAll('.btn-mc-master').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('button').dataset.id;
        if (mistakes[id]) {
          mistakes[id].isMastered = !mistakes[id].isMastered;
          saveMistakes();
          renderMistakesList();
        }
      });
    });

    listContainer.querySelectorAll('.btn-mc-bookmark').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('button').dataset.id;
        if (bookmarks.has(id)) {
          bookmarks.delete(id);
        } else {
          bookmarks.add(id);
        }
        saveBookmarks();
        renderMistakesList();
      });
    });

    listContainer.querySelectorAll('.btn-mc-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('button').dataset.id;
        if (confirm('이 문제를 오답노트에서 삭제하시겠습니까?')) {
          delete mistakes[id];
          saveMistakes();
          renderMistakesList();
        }
      });
    });
  }

  // --- Export Mistakes to Markdown for NotebookLM ---
  function exportMistakesToMarkdown() {
    const allMistakes = Object.values(mistakes);
    if (allMistakes.length === 0) {
      showToast('내보낼 오답노트가 비어 있습니다.');
      return;
    }

    let md = `# 📓 JLPT 실전 오답노트 (${allMistakes.length}문제)\n\n`;
    md += `> 생성 일자: ${new Date().toLocaleDateString('ko-KR')} | JLPT Master 자동 수집 오답노트\n\n`;
    md += `---\n\n`;

    allMistakes.forEach((m, idx) => {
      const correctOpt = m.options.find(o => o.isCorrect);
      md += `### [오답 ${idx + 1}] ${m.level} ${m.typeName} (총 ${m.count}회 오답)\n\n`;
      md += `- **지시사항**: ${m.instruction || ''}\n`;
      md += `- **문제**: ${m.qPlain}\n`;
      if (m.qTrans) md += `- **해석**: ${m.qTrans}\n`;
      md += `- **보기**:\n`;
      m.options.forEach(o => {
        const mark = o.isCorrect ? ' **[정답]**' : '';
        const tr = o.trans ? ` (${o.trans})` : '';
        md += `  - ${o.marker} ${o.copy}${tr}${mark}\n`;
      });
      if (correctOpt) {
        md += `- **정답**: ${correctOpt.marker} ${correctOpt.copy} ${correctOpt.trans ? '(' + correctOpt.trans + ')' : ''}\n`;
      }
      if (m.ansJa && m.typeCode !== 'kanji_reading') {
        md += `- **완성 문장**: ${m.ansJa}\n`;
        if (m.ansKo) md += `- **완성 해석**: ${m.ansKo}\n`;
      }
      if (m.expl && m.expl.main) {
        md += `- **정답 해설**: ${m.expl.main}\n`;
        if (m.expl.choices && m.expl.choices.length > 0) {
          m.expl.choices.forEach(c => {
            md += `  - ${c.marker}: ${c.note}\n`;
          });
        }
      }
      md += `\n---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `JLPT_오답노트_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('📥 오답노트 마크다운 파일이 다운로드되었습니다.');
  }

  // --- Start Quiz with Mistakes Only ---
  function startMistakesQuiz() {
    const allMistakes = Object.values(mistakes).filter(m => !m.isMastered);
    if (allMistakes.length === 0) {
      showToast('복습할 미완료 오답이 없습니다. 훌륭합니다!');
      return;
    }

    currentQuestions = [...allMistakes];
    state.currentIndex = 0;
    state.mode = 'mistake-drill';
    state.isShuffled = true;
    shuffleArray(currentQuestions);

    switchTab('quiz');
    showToast(`총 ${currentQuestions.length}개의 오답 문제로 집중 테스트를 시작합니다.`);
    renderCurrentQuestion();
  }

  // --- Analytics & Stats Rendering ---
  function renderStats() {
    const totalSolvedEl = document.getElementById('stat-total-solved');
    const accuracyRateEl = document.getElementById('stat-accuracy-rate');
    const currentMistakesEl = document.getElementById('stat-current-mistakes');
    const conqueredEl = document.getElementById('stat-conquered-count');
    const levelProgressList = document.getElementById('level-progress-list');
    const typeWeaknessList = document.getElementById('type-weakness-list');

    let totalSolved = 0;
    let totalCorrect = 0;
    for (const h of Object.values(history)) {
      totalSolved += h.solved || 0;
      totalCorrect += h.correct || 0;
    }

    const accuracy = totalSolved > 0 ? Math.round((totalCorrect / totalSolved) * 100) : 0;
    const activeMistakes = Object.values(mistakes).filter(m => !m.isMastered).length;
    const masteredMistakes = Object.values(mistakes).filter(m => m.isMastered).length;

    totalSolvedEl.textContent = totalSolved.toLocaleString();
    accuracyRateEl.textContent = `${accuracy}%`;
    currentMistakesEl.textContent = activeMistakes.toLocaleString();
    conqueredEl.textContent = masteredMistakes.toLocaleString();

    // Level breakdown
    const levelStats = { N1: { s: 0, c: 0 }, N2: { s: 0, c: 0 }, N3: { s: 0, c: 0 }, N4: { s: 0, c: 0 }, N5: { s: 0, c: 0 } };
    const typeStats = {};

    for (const [id, h] of Object.entries(history)) {
      const lvl = id.split('-')[0];
      if (levelStats[lvl]) {
        levelStats[lvl].s += h.solved;
        levelStats[lvl].c += h.correct;
      }
    }

    // Calculate mistakes per type for weakness analysis
    for (const m of Object.values(mistakes)) {
      if (!typeStats[m.typeName]) {
        typeStats[m.typeName] = { wrongCount: 0 };
      }
      typeStats[m.typeName].wrongCount += m.count;
    }

    // Render level progress
    let levelHtml = '';
    ['N1', 'N2', 'N3', 'N4', 'N5'].forEach(lvl => {
      const s = levelStats[lvl].s;
      const c = levelStats[lvl].c;
      const rate = s > 0 ? Math.round((c / s) * 100) : 0;
      const totalInLevel = (window.JLPT_DATA && window.JLPT_DATA[lvl]) ? window.JLPT_DATA[lvl].length : 0;

      levelHtml += `
        <div class="progress-item">
          <div class="pi-header">
            <span>${lvl} 종합 실전 (${s} / ${totalInLevel}문제 완료)</span>
            <span style="color:var(--primary); font-weight:700;">정답률 ${rate}%</span>
          </div>
          <div class="pi-bar-bg">
            <div class="pi-bar-fill" style="width: ${rate}%; background: var(--primary-gradient);"></div>
          </div>
        </div>
      `;
    });
    levelProgressList.innerHTML = levelHtml;

    // Render type weakness ranking
    const typeEntries = Object.entries(typeStats).sort((a, b) => b[1].wrongCount - a[1].wrongCount);
    if (typeEntries.length === 0) {
      typeWeaknessList.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem;">아직 오답 데이터가 충분하지 않습니다. 문제를 풀면 취약 유형 순위가 표시됩니다.</div>';
    } else {
      let typeHtml = '';
      const maxWrong = Math.max(...typeEntries.map(e => e[1].wrongCount), 1);
      typeEntries.forEach(([tName, data]) => {
        const percent = Math.round((data.wrongCount / maxWrong) * 100);
        typeHtml += `
          <div class="progress-item">
            <div class="pi-header">
              <span>${tName}</span>
              <span style="color:var(--danger); font-weight:700;">오답 ${data.wrongCount}회</span>
            </div>
            <div class="pi-bar-bg">
              <div class="pi-bar-fill" style="width: ${percent}%; background: var(--danger);"></div>
            </div>
          </div>
        `;
      });
      typeWeaknessList.innerHTML = typeHtml;
    }
  }

  // --- Tab Navigation ---
  function switchTab(tabName) {
    state.currentTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
      tab.setAttribute('aria-selected', tab.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.toggle('active', view.id === `view-${tabName}`);
    });

    if (tabName === 'mistakes') {
      renderMistakesList();
    } else if (tabName === 'stats') {
      renderStats();
    }
  }

  // --- UI Helpers & Event Listeners ---
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('icon-moon').classList.toggle('hidden', theme === 'light');
    document.getElementById('icon-sun').classList.toggle('hidden', theme === 'dark');
    saveState();
  }

  function updateMistakeBadge() {
    const badge = document.getElementById('header-mistake-count');
    if (!badge) return;
    const activeCount = Object.values(mistakes).filter(m => !m.isMastered).length;
    badge.textContent = activeCount.toLocaleString();
    badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
  }

  function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(15px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setupEventListeners() {
    // Nav tabs
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Level buttons
    document.querySelectorAll('.level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        loadLevelQuestions(btn.dataset.level);
        renderCurrentQuestion();
      });
    });

    // Mode buttons
    document.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        saveState();
        if (state.mode === 'exam') {
          showToast('⏱️ 모의고사 모드가 켜졌습니다. 문제를 풀고 "시험 종료 및 채점"을 누르세요.');
          document.getElementById('btn-finish-exam').classList.remove('hidden');
          document.getElementById('exam-status-bar').classList.remove('hidden');
        } else {
          document.getElementById('btn-finish-exam').classList.add('hidden');
          document.getElementById('exam-status-bar').classList.add('hidden');
        }
      });
    });

    // Shuffle button
    document.getElementById('btn-shuffle').addEventListener('click', () => {
      state.isShuffled = !state.isShuffled;
      document.getElementById('btn-shuffle').classList.toggle('btn-primary', state.isShuffled);
      loadLevelQuestions(state.level);
      renderCurrentQuestion();
      showToast(state.isShuffled ? '🔀 문제 순서를 무작위로 섞었습니다.' : '정렬 순서를 원래대로 복원했습니다.');
    });

    // Next / Prev buttons
    document.getElementById('btn-next-question').addEventListener('click', nextQuestion);
    document.getElementById('btn-prev-question').addEventListener('click', prevQuestion);

    // Bookmark button
    document.getElementById('btn-bookmark').addEventListener('click', () => {
      const q = currentQuestions[state.currentIndex];
      if (!q) return;

      if (bookmarks.has(q.id)) {
        bookmarks.delete(q.id);
        document.getElementById('btn-bookmark').classList.remove('active');
        showToast('북마크가 해제되었습니다.');
      } else {
        bookmarks.add(q.id);
        document.getElementById('btn-bookmark').classList.add('active');
        showToast('★ 북마크에 추가되었습니다.');
      }
      saveBookmarks();
    });

    // Furigana toggle
    const toggleFurigana = document.getElementById('toggle-furigana');
    toggleFurigana.checked = state.furigana;
    toggleFurigana.addEventListener('change', (e) => {
      state.furigana = e.target.checked;
      saveState();
      renderCurrentQuestion();
    });

    // Translation toggle
    const toggleTrans = document.getElementById('toggle-trans');
    if (toggleTrans) {
      toggleTrans.checked = state.showTrans;
      toggleTrans.addEventListener('change', (e) => {
        state.showTrans = e.target.checked;
        saveState();
        renderCurrentQuestion();
        showToast(state.showTrans ? '👁️ 한글 뜻 항상 표시 ON' : '🙈 한글 뜻 숨김 모드 (글 길게 눌러 확인)');
      });
    }

    // Sound toggle
    const btnSound = document.getElementById('btn-sound-toggle');
    btnSound.addEventListener('click', () => {
      state.sound = !state.sound;
      document.getElementById('icon-sound-on').classList.toggle('hidden', !state.sound);
      document.getElementById('icon-sound-off').classList.toggle('hidden', state.sound);
      saveState();
      showToast(state.sound ? '🔔 효과음이 켜졌습니다.' : '🔕 효과음이 꺼졌습니다.');
    });

    // Theme toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });

    // Shortcuts modal
    
    // Mobile Connect Modal
    const btnMobileModal = document.getElementById('btn-mobile-modal');
    const modalMobile = document.getElementById('modal-mobile');
    const btnCloseMobile = document.getElementById('btn-close-mobile');
    const qrImg = document.getElementById('mobile-qr-img');
    const inputMobileUrl = document.getElementById('input-mobile-url');
    const btnCopyMobileUrl = document.getElementById('btn-copy-mobile-url');

    if (btnMobileModal) {
      btnMobileModal.addEventListener('click', async () => {
        let mobileUrl = 'http://192.168.8.152:3000';
        try {
          const res = await fetch('/api/network-info');
          if (res.ok) {
            const data = await res.json();
            if (data.mobileUrl) mobileUrl = data.mobileUrl;
          }
        } catch (e) {
          if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            mobileUrl = window.location.origin;
          }
        }

        if (inputMobileUrl) inputMobileUrl.value = mobileUrl;
        if (qrImg) {
          qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(mobileUrl);
        }
        if (modalMobile) modalMobile.classList.remove('hidden');
      });
    }

    if (btnCloseMobile) {
      btnCloseMobile.addEventListener('click', () => {
        if (modalMobile) modalMobile.classList.add('hidden');
      });
    }

    if (btnCopyMobileUrl) {
      btnCopyMobileUrl.addEventListener('click', () => {
        if (inputMobileUrl) {
          navigator.clipboard.writeText(inputMobileUrl.value).then(() => {
            showToast('📋 모바일 접속 주소가 복사되었습니다.');
          });
        }
      });
    }

    document.getElementById('btn-shortcuts').addEventListener('click', () => {
      document.getElementById('modal-shortcuts').classList.remove('hidden');
    });
    document.getElementById('btn-close-shortcuts').addEventListener('click', () => {
      document.getElementById('modal-shortcuts').classList.add('hidden');
    });

    // Mistakes toolbar
    document.getElementById('input-mistake-search').addEventListener('input', renderMistakesList);
    document.getElementById('select-mistake-level').addEventListener('change', renderMistakesList);
    document.getElementById('select-mistake-type').addEventListener('change', renderMistakesList);
    document.getElementById('select-mistake-status').addEventListener('change', renderMistakesList);

    document.getElementById('btn-export-markdown').addEventListener('click', exportMistakesToMarkdown);
    const btnPdf = document.getElementById('btn-export-pdf');
    if (btnPdf) {
      btnPdf.addEventListener('click', () => {
        window.open('오답노트_보고서.html?print=true', '_blank');
      });
    }
    document.getElementById('btn-quiz-mistakes').addEventListener('click', startMistakesQuiz);

    document.getElementById('btn-clear-mastered').addEventListener('click', () => {
      if (confirm('정복 완료(마스터)된 오답들을 오답노트에서 모두 삭제하시겠습니까?')) {
        for (const [id, m] of Object.entries(mistakes)) {
          if (m.isMastered) delete mistakes[id];
        }
        saveMistakes();
        renderMistakesList();
        showToast('정복 완료된 오답들이 정리되었습니다.');
      }
    });

    // Backup & Restore
    document.getElementById('btn-export-backup').addEventListener('click', () => {
      const backupData = {
        version: '1.0',
        timestamp: Date.now(),
        history,
        mistakes,
        bookmarks: Array.from(bookmarks)
      };
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `JLPT_학습데이터_백업_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('input-import-backup').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          if (parsed.mistakes) mistakes = parsed.mistakes;
          if (parsed.history) history = parsed.history;
          if (parsed.bookmarks) bookmarks = new Set(parsed.bookmarks);

          saveMistakes();
          saveHistory();
          saveBookmarks();
          renderStats();
          showToast('✅ 백업 데이터가 성공적으로 복원되었습니다.');
        } catch (err) {
          alert('올바른 백업 JSON 파일이 아닙니다.');
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('btn-reset-data').addEventListener('click', () => {
      if (confirm('모든 풀이 이력, 정답률, 오답노트가 완전히 초기화됩니다. 계속하시겠습니까?')) {
        mistakes = {};
        history = {};
        bookmarks = new Set();
        saveMistakes();
        saveHistory();
        saveBookmarks();
        renderStats();
        renderCurrentQuestion();
        showToast('데이터가 초기화되었습니다.');
      }
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Don't trigger shortcuts if user is typing in search input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        return;
      }

      if (state.currentTab === 'quiz') {
        if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
          const optIdx = parseInt(e.key, 10) - 1;
          handleOptionSelect(optIdx);
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (state.answered) {
            nextQuestion();
          } else {
            // reveal or skip
            nextQuestion();
          }
        } else if (e.key === 'p' || e.key === 'P' || e.key === 'ArrowLeft') {
          prevQuestion();
        } else if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowRight') {
          nextQuestion();
        } else if (e.key === 'f' || e.key === 'F') {
          const toggle = document.getElementById('toggle-furigana');
          toggle.checked = !toggle.checked;
          toggle.dispatchEvent(new Event('change'));
        } else if (e.key === 't' || e.key === 'T') {
          const toggle = document.getElementById('toggle-trans');
          if (toggle) {
            toggle.checked = !toggle.checked;
            toggle.dispatchEvent(new Event('change'));
          }
        } else if (e.key === 'b' || e.key === 'B') {
          document.getElementById('btn-bookmark').click();
        }
      }
    });
  }

  // Expose global app object for inline handlers
  window.app = {
    init,
    switchTab,
    nextQuestion,
    prevQuestion,
    handleOptionSelect
  };

  // Launch when DOM is ready
  document.addEventListener('DOMContentLoaded', init);
})();
