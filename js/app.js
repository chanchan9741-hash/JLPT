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
    BOOKMARKS: 'jlpt_bookmarks_v1',
    SRS: 'jlpt_srs_v1'
  };

  // --- Global Application State ---
  let state = {
    theme: 'light',
    furigana: true,
    showTrans: false, // false: hidden by default (peek on click/press), true: always visible
    sound: true,
    currentTab: 'quiz',
    level: 'N1',
    type: 'ALL',
    mode: 'drill', // 'drill' (instant feedback) | 'exam' (mock test) | 'mistake-drill'
    currentIndex: 0,
    levelIndices: {},
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

  // Anki Spaced Repetition (SRS) State
  let ankiState = {
    level: 'ALL',
    source: 'due', // 'due' | 'mistakes' | 'all_srs' | 'history' | 'bookmarks'
    mode: 'flashcard', // 'flashcard' | 'quiz'
    currentQueue: [],
    queueIndex: 0,
    isFlipped: false,
    sessionSolvedCount: 0
  };

  // User persistent data
  let mistakes = {}; // id -> mistake object
  let history = {};  // id -> { solved: 0, correct: 0, lastResult: true/false }
  let bookmarks = new Set();
  let srs = {};      // id -> { id, level, repetitions, interval, easeFactor, dueDate, lastReviewed, state, lapses }

  // Active question set based on level & filters
  let currentQuestions = [];

  // --- Google Drive Sync Manager ---
  const syncManager = {
    connected: false,
    syncUrl: '',
    debounceTimer: null,

    getComputedSyncUrl() {
      if (window.location.protocol.startsWith('http')) {
        if (window.location.port === '3000' || 
            window.location.hostname === 'localhost' || 
            window.location.hostname === '127.0.0.1' ||
            window.location.hostname.startsWith('192.168.')) {
          return ''; // Same origin (localhost:3000 or 192.168.8.152:3000)
        }
        if (window.location.protocol === 'http:') {
          return 'http://192.168.8.152:3000';
        }
      } else if (window.location.protocol === 'file:') {
        return 'http://localhost:3000';
      }
      return '';
    },

    async init() {
      this.syncUrl = this.getComputedSyncUrl();
      const syncDot = document.getElementById('sync-dot');
      const syncText = document.getElementById('sync-text');
      const syncBadge = document.getElementById('sync-status-badge');

      // If Firebase Auth is already active/connected, do not overwrite status badge
      if (window.JLPT_FIREBASE && window.JLPT_FIREBASE.getCurrentUser && window.JLPT_FIREBASE.getCurrentUser()) {
        return;
      }

      if (!this.syncUrl && window.location.protocol === 'https:') {
        this.connected = false;
        if (syncDot) syncDot.className = 'sync-dot cloud';
        if (syncText) syncText.textContent = '드라이브 동기화';
        if (syncBadge) syncBadge.title = '클릭하여 구글 드라이브 파일 백업 및 복원을 진행하세요.';
        return;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${this.syncUrl}/api/sync-data`, {
          method: 'GET',
          cache: 'no-cache',
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const driveData = await res.json();
          this.connected = true;
          if (syncDot) syncDot.className = 'sync-dot connected';
          if (syncText) syncText.textContent = '구글 드라이브 실시간 연동 중';
          if (syncBadge) syncBadge.title = 'PC 구글 드라이브와 실시간으로 오답노트가 자동 연동됩니다.';

          this.mergeDriveData(driveData);
          console.log('[Sync] Connected to Google Drive sync server!');
          return;
        }
      } catch (err) {
        // Server offline
      }

      this.connected = false;
      if (syncDot) syncDot.className = 'sync-dot offline';
      if (syncText) syncText.textContent = '드라이브 동기화';
      if (syncBadge) syncBadge.title = '클릭하여 구글 드라이브 동기화 및 백업을 진행하세요.';
    },

    mergeDriveData(driveData) {
      let updated = false;
      if (driveData.mistakes) {
        for (const [id, m] of Object.entries(driveData.mistakes)) {
          if (!mistakes[id] || (m.lastWrongDate || 0) > (mistakes[id].lastWrongDate || 0) || (m.count || 1) >= (mistakes[id].count || 1)) {
            mistakes[id] = m;
            updated = true;
          }
        }
      }
      if (driveData.history) {
        for (const [id, h] of Object.entries(driveData.history)) {
          if (!history[id] || (h.lastDate || 0) > (history[id].lastDate || 0) || (h.solved || 0) > (history[id].solved || 0)) {
            history[id] = h;
            updated = true;
          }
        }
      }
      if (driveData.bookmarks && Array.isArray(driveData.bookmarks)) {
        driveData.bookmarks.forEach(bId => {
          if (!bookmarks.has(bId)) {
            bookmarks.add(bId);
            updated = true;
          }
        });
      }

      if (updated) {
        localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
        localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(Array.from(bookmarks)));
        updateMistakeBadge();
        renderStats();
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
              if (syncText) syncText.textContent = '구글 드라이브 실시간 연동 중';
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
    document.querySelectorAll('#mode-segmented .seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });
    updateMistakeBadge();
    updateAnkiBadge();
    loadLevelQuestions(state.level);
    renderTypeFilterChips();
    renderCurrentQuestion();
    renderStats();
    syncManager.init();

    // Check for pending cloud data received before app was ready
    if (window.__PENDING_CLOUD_DATA__) {
      console.log('[App] Applying pending cloud data received before init');
      mergeExternalData(window.__PENDING_CLOUD_DATA__);
    }
  }

  // --- Persistence Handlers ---
  function loadPersistentData() {
    try {
      const savedState = localStorage.getItem(STORAGE_KEYS.STATE);
      const themeVersion = localStorage.getItem('jlpt_theme_v3');
      if (savedState) {
        const parsed = JSON.parse(savedState);
        // Default to 'light' as requested. If theme version 3 hasn't been set, apply light default
        if (!themeVersion) {
          state.theme = 'light';
          localStorage.setItem('jlpt_theme_v3', 'applied');
        } else {
          state.theme = parsed.theme || 'light';
        }
        state.furigana = parsed.furigana !== undefined ? parsed.furigana : true;
        state.showTrans = parsed.showTrans !== undefined ? parsed.showTrans : false;
        state.sound = parsed.sound !== undefined ? parsed.sound : true;
        state.level = parsed.level || 'N1';
        state.type = parsed.type || 'ALL';
        state.levelIndices = parsed.levelIndices || {};
        state.mode = (parsed.mode === 'srs-drill' || parsed.mode === 'new-drill') ? 'new-drill' : (parsed.mode || 'drill');
      } else {
        state.theme = 'light';
        localStorage.setItem('jlpt_theme_v3', 'applied');
      }

      const savedMistakes = localStorage.getItem(STORAGE_KEYS.MISTAKES);
      if (savedMistakes) mistakes = JSON.parse(savedMistakes);

      const savedHistory = localStorage.getItem(STORAGE_KEYS.HISTORY);
      if (savedHistory) history = JSON.parse(savedHistory);

      const savedBookmarks = localStorage.getItem(STORAGE_KEYS.BOOKMARKS);
      if (savedBookmarks) bookmarks = new Set(JSON.parse(savedBookmarks));

      const savedSrs = localStorage.getItem(STORAGE_KEYS.SRS);
      if (savedSrs) {
        srs = JSON.parse(savedSrs);
      }

      // Auto-migration & seeding of SRS from mistakes if SRS is empty
      if (Object.keys(srs).length === 0 && Object.keys(mistakes).length > 0) {
        for (const [id, m] of Object.entries(mistakes)) {
          srs[id] = {
            id: m.id || id,
            level: m.level || id.split('-')[0] || 'N1',
            repetitions: m.isMastered ? 3 : 0,
            interval: m.isMastered ? 21 : 1,
            easeFactor: 2.5,
            dueDate: m.isMastered ? Date.now() + 21 * 86400000 : Date.now(),
            lastReviewed: m.lastWrongDate || Date.now(),
            state: m.isMastered ? 'mastered' : 'learning',
            lapses: m.count || 1
          };
        }
        localStorage.setItem(STORAGE_KEYS.SRS, JSON.stringify(srs));
      }

      // Always merge preloaded initial sync data (from PC / sync_init.js)
      if (window.JLPT_INITIAL_SYNC) {
        let changed = false;
        if (window.JLPT_INITIAL_SYNC.history) {
          for (const [id, h] of Object.entries(window.JLPT_INITIAL_SYNC.history)) {
            if (!history[id] || (h.solved || 0) > (history[id].solved || 0)) {
              history[id] = { ...h };
              changed = true;
            }
          }
        }
        if (window.JLPT_INITIAL_SYNC.mistakes) {
          for (const [id, m] of Object.entries(window.JLPT_INITIAL_SYNC.mistakes)) {
            if (!mistakes[id] || (m.count || 1) >= (mistakes[id].count || 1)) {
              mistakes[id] = { ...m };
              changed = true;
            }
          }
        }
        if (window.JLPT_INITIAL_SYNC.bookmarks && Array.isArray(window.JLPT_INITIAL_SYNC.bookmarks)) {
          window.JLPT_INITIAL_SYNC.bookmarks.forEach(bId => {
            if (!bookmarks.has(bId)) {
              bookmarks.add(bId);
              changed = true;
            }
          });
        }
        if (changed) {
          localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
          localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
          localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(Array.from(bookmarks)));
        }
      }
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
      mode: state.mode,
      currentIndex: state.currentIndex,
      levelIndices: state.levelIndices || {}
    }));
  }

  function saveMistakes() {
    localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
    updateMistakeBadge();
    renderStats();
    if (state.currentTab === 'mistakes') {
      renderMistakesList();
    }
    syncManager.scheduleSync();
    if (window.JLPT_FIREBASE) window.JLPT_FIREBASE.scheduleCloudUpload();
  }

  function saveHistory() {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    renderStats();
    syncManager.scheduleSync();
    if (window.JLPT_FIREBASE) window.JLPT_FIREBASE.scheduleCloudUpload();
  }

  function saveBookmarks() {
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(Array.from(bookmarks)));
    syncManager.scheduleSync();
    if (window.JLPT_FIREBASE) window.JLPT_FIREBASE.scheduleCloudUpload();
  }

  function saveSrs() {
    localStorage.setItem(STORAGE_KEYS.SRS, JSON.stringify(srs));
    updateAnkiBadge();
    renderStats();
    syncManager.scheduleSync();
    if (window.JLPT_FIREBASE) window.JLPT_FIREBASE.scheduleCloudUpload();
  }

  // Resume from the user's last solved question or next question in line
  function getResumeIndex(level, questions) {
    if (!questions || questions.length === 0) return 0;

    // 1. Check if user was previously viewing a specific question in this level
    if (state.levelIndices && state.levelIndices[level] !== undefined) {
      const idx = state.levelIndices[level];
      if (idx >= 0 && idx < questions.length) {
        const qAtIdx = questions[idx];
        // If this question is NOT yet solved, resume right here (user was reading this question)
        if (!history[qAtIdx.id] || (history[qAtIdx.id].solved || 0) === 0) {
          return idx;
        }
        // If this question WAS already solved, advance to next question
        if (idx + 1 < questions.length) {
          return idx + 1;
        }
      }
    }

    // 2. Find the question right after the most recently solved question in this level
    let mostRecentId = null;
    let maxDate = 0;
    for (const q of questions) {
      if (history[q.id] && (history[q.id].lastDate || 0) > maxDate) {
        maxDate = history[q.id].lastDate;
        mostRecentId = q.id;
      }
    }

    if (mostRecentId) {
      const solvedIdx = questions.findIndex(q => q.id === mostRecentId);
      if (solvedIdx !== -1) {
        if (solvedIdx + 1 < questions.length) {
          return solvedIdx + 1;
        }
        return solvedIdx;
      }
    }

    // 3. Otherwise find the first unsolved question
    const firstUnsolved = questions.findIndex(q => !history[q.id] || (history[q.id].solved || 0) === 0);
    if (firstUnsolved !== -1) {
      return firstUnsolved;
    }

    return 0;
  }

  // --- Anki-style Weighted Repetition Queue Builder ---
  function buildSrsDrillQueue(questions) {
    if (!questions || questions.length === 0) return [];

    const now = Date.now();
    const highMistakes = [];
    const regularMistakes = [];
    const dueQuestions = [];
    const unseenQuestions = [];
    const solvedQuestions = [];

    questions.forEach(q => {
      const m = mistakes[q.id];
      const s = srs[q.id];
      const h = history[q.id];

      if (m && !m.isMastered) {
        if (m.count >= 2) {
          highMistakes.push(q);
        } else {
          regularMistakes.push(q);
        }
      } else if (s && (s.dueDate || 0) <= now + 60000) {
        dueQuestions.push(q);
      } else if (!h || h.solved === 0) {
        unseenQuestions.push(q);
      } else {
        solvedQuestions.push(q);
      }
    });

    // Sort high-frequency mistakes by highest wrong count descending
    highMistakes.sort((a, b) => (mistakes[b.id].count || 1) - (mistakes[a.id].count || 1));
    shuffleArray(regularMistakes);
    shuffleArray(dueQuestions);
    shuffleArray(unseenQuestions);
    shuffleArray(solvedQuestions);

    const queue = [];

    // 1. High-frequency mistakes appear multiple times (up to 3 times) throughout the queue
    highMistakes.forEach(q => {
      const count = mistakes[q.id].count || 2;
      const repeats = Math.min(3, count);
      for (let r = 0; r < repeats; r++) {
        queue.push({ ...q, isWeightedRepeat: true });
      }
    });

    // 2. Regular mistakes (1~2 times)
    regularMistakes.forEach(q => {
      queue.push({ ...q, isWeightedRepeat: true });
    });

    // 3. Due spaced repetition cards
    dueQuestions.forEach(q => {
      queue.push({ ...q, isDueReview: true });
    });

    // 4. Mix in fresh unseen questions
    unseenQuestions.forEach(q => {
      queue.push({ ...q });
    });

    // 5. Already solved questions
    solvedQuestions.forEach(q => {
      queue.push({ ...q });
    });

    return interleaveQueue(queue);
  }

  function interleaveQueue(items) {
    if (items.length <= 3) return items;
    const result = [];
    const pool = [...items];

    while (pool.length > 0) {
      let foundIdx = -1;
      for (let i = 0; i < pool.length; i++) {
        const id = pool[i].id;
        const recent = result.slice(-3).map(x => x.id);
        if (!recent.includes(id)) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx === -1) foundIdx = 0;
      result.push(pool.splice(foundIdx, 1)[0]);
    }
    return result;
  }

  // --- Level & Questions Management ---
  function loadLevelQuestions(level, preserveIndex = false) {
    state.level = level;

    const rawQuestions = (window.JLPT_DATA && window.JLPT_DATA[level]) || [];
    
    // Filter by type (fallback to ALL if current type doesn't exist in this level)
    if (state.type !== 'ALL' && !rawQuestions.some(q => q.typeName === state.type)) {
      state.type = 'ALL';
    }

    if (state.type === 'ALL') {
      currentQuestions = [...rawQuestions];
    } else {
      currentQuestions = rawQuestions.filter(q => q.typeName === state.type);
    }

    if (state.mode === 'new-drill' || state.mode === 'srs-drill') {
      // 새로운 문제 풀기: 아직 풀지 않은(미풀이) 문제만 추출
      const unseen = currentQuestions.filter(q => !history[q.id] || (history[q.id].solved || 0) === 0);
      currentQuestions = unseen;
      if (state.isShuffled) {
        shuffleArray(currentQuestions);
      }
      if (!preserveIndex) {
        state.currentIndex = 0;
      }
    } else {
      if (state.isShuffled) {
        shuffleArray(currentQuestions);
      }
      if (!preserveIndex) {
        state.currentIndex = getResumeIndex(level, currentQuestions);
      }
    }

    state.answered = false;
    state.selectedOption = null;

    saveState();
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
      if (state.mode === 'new-drill' || state.mode === 'srs-drill') {
        qTextEl.innerHTML = `
          <div style="text-align:center; padding:2.5rem 1rem;">
            <div style="font-size:2.5rem; margin-bottom:0.75rem;">🎉</div>
            <div style="font-size:1.2rem; font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">
              새로운 문제를 모두 풀었습니다!
            </div>
            <div style="font-size:0.95rem; color:var(--text-muted); line-height:1.6;">
              해당 레벨(${state.level}) 및 유형(${state.type})의 미풀이 문제를 전부 완주하셨습니다.<br>
              <strong>[⚡ 즉시 풀기]</strong>로 복습하거나 다른 레벨/유형을 선택해 보세요.
            </div>
          </div>
        `;
      } else {
        qTextEl.innerHTML = '<div style="color:var(--text-muted); font-size:1.1rem;">해당 조건에 맞는 문제가 없습니다. 다른 필터를 선택해 주세요.</div>';
      }
      qTransEl.textContent = '';
      optionsContainer.innerHTML = '';
      explBox.classList.add('hidden');
      if (indicator) indicator.textContent = '0 / 0';
      return;
    }

    // Bounds checking
    if (state.currentIndex >= currentQuestions.length) state.currentIndex = 0;
    if (state.currentIndex < 0) state.currentIndex = currentQuestions.length - 1;

    state.levelIndices[state.level] = state.currentIndex;

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

    // Quick Yomigana and Korean Translation toggle buttons
    const btnQuickFurigana = document.getElementById('btn-quick-furigana');
    if (btnQuickFurigana) {
      btnQuickFurigana.classList.toggle('active', state.furigana);
      const dot = btnQuickFurigana.querySelector('.pill-dot');
      if (dot) dot.classList.toggle('active', state.furigana);
    }

    const btnQuickTrans = document.getElementById('btn-quick-trans');
    if (btnQuickTrans) {
      btnQuickTrans.classList.toggle('active', state.showTrans);
      const dot = btnQuickTrans.querySelector('.pill-dot');
      if (dot) dot.classList.toggle('active', state.showTrans);
    }

    // Mistake badge & Anki frequency indicators
    const m = mistakes[q.id];
    mistakeBadge.style.color = '';
    mistakeBadge.style.borderColor = '';
    mistakeBadge.style.background = '';
    if (q.isRequeued) {
      mistakeBadge.classList.remove('hidden');
      mistakeBadge.style.color = '#ef4444';
      mistakeBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      mistakeBadge.style.background = 'rgba(239, 68, 68, 0.12)';
      mistakeBadge.textContent = '🔄 방금 틀린 문제 재도전 (안키 반복)';
    } else if (m && !m.isMastered) {
      mistakeBadge.classList.remove('hidden');
      if (m.count >= 2) {
        mistakeBadge.style.color = '#dc2626';
        mistakeBadge.style.borderColor = 'rgba(220, 38, 38, 0.4)';
        mistakeBadge.style.background = 'rgba(220, 38, 38, 0.15)';
        mistakeBadge.textContent = `🔥 누적 오답 ${m.count}회 (빈도 집중)`;
      } else {
        mistakeBadge.textContent = `⚠️ 오답 ${m.count}회`;
      }
    } else if (m && m.isMastered) {
      mistakeBadge.classList.remove('hidden');
      mistakeBadge.style.color = 'var(--success)';
      mistakeBadge.style.borderColor = 'var(--success-border)';
      mistakeBadge.style.background = 'var(--success-bg)';
      mistakeBadge.textContent = '✨ 정복 완료';
    } else if (state.mode === 'new-drill' || state.mode === 'srs-drill') {
      mistakeBadge.classList.remove('hidden');
      mistakeBadge.style.color = '#3b82f6';
      mistakeBadge.style.borderColor = 'rgba(59, 130, 246, 0.3)';
      mistakeBadge.style.background = 'rgba(59, 130, 246, 0.1)';
      mistakeBadge.textContent = '✨ 새로운 문제 풀기';
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
    if (state.answered && (state.mode === 'drill' || state.mode === 'new-drill' || state.mode === 'srs-drill' || state.mode === 'mistake-drill')) return;

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

    // Auto-update Mistake Notebook & Anki SRS
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

      // Automatically enroll or update in Anki SRS with 'again' (1 day interval)
      const curSrs = srs[q.id] || {
        id: q.id,
        level: q.level || state.level,
        repetitions: 0,
        interval: 1,
        easeFactor: 2.5,
        state: 'learning',
        lapses: 0
      };
      srs[q.id] = calculateNextSrs(curSrs, 'again');
      saveSrs();

      if (state.mode === 'srs-drill') {
        const offset = Math.min(3, Math.max(2, currentQuestions.length - state.currentIndex - 1));
        const targetIndex = state.currentIndex + offset + 1;
        currentQuestions.splice(targetIndex, 0, { ...q, isRequeued: true });
        showToast(`🔁 [안키 빈도 반복] ${offset + 1}문제 뒤에 다시 출제됩니다! (누적 오답 ${mistakes[q.id].count}회)`);
      } else {
        showToast('⚠️ 오답노트 & 안키 복습 덱에 자동 등록되었습니다.');
      }
    } else {
      sound.playCorrect();
      // If this was an existing mistake, celebrate mastery!
      if (mistakes[q.id] && !mistakes[q.id].isMastered) {
        mistakes[q.id].isMastered = true;
        mistakes[q.id].masteredDate = Date.now();
        saveMistakes();
        if (state.mode === 'srs-drill' && q.isRequeued) {
          showToast('🎉 재도전 성공! 오답을 완전히 극복했습니다.');
        } else {
          showToast('🎉 오답노트 문제 정복(마스터) 완료!');
        }
      }

      // If card was in Anki SRS deck, reward with 'good'
      if (srs[q.id]) {
        srs[q.id] = calculateNextSrs(srs[q.id], 'good');
        saveSrs();
      }
    }

    state.levelIndices[state.level] = state.currentIndex;
    saveState();

    // Reveal Explanation Drawer in drill mode
    if (state.mode === 'drill' || state.mode === 'new-drill' || state.mode === 'srs-drill' || state.mode === 'mistake-drill') {
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

    // Update Quiz Anki SRS Bar
    const quizAnkiStatusTag = document.getElementById('quiz-anki-status-tag');
    if (quizAnkiStatusTag) {
      const card = srs[q.id];
      if (card) {
        const stateName = card.state === 'mastered' ? '✨ 마스터' : (card.state === 'review' ? '복습' : '학습중');
        const dueText = getCardDueDateText(card);
        quizAnkiStatusTag.textContent = `${stateName} (${card.interval}일 간격 · ${dueText})`;
      } else {
        quizAnkiStatusTag.textContent = '새 카드 (클릭하여 안키 복습 주기 지정)';
      }

      ['again', 'hard', 'good', 'easy'].forEach(grade => {
        const btn = document.getElementById(`quiz-btn-anki-${grade}`);
        if (btn) {
          btn.onclick = () => {
            const currentCard = srs[q.id] || {
              id: q.id,
              level: q.level || state.level,
              repetitions: 0,
              interval: 1,
              easeFactor: 2.5,
              state: 'learning',
              lapses: 0
            };
            const next = calculateNextSrs(currentCard, grade);
            srs[q.id] = next;
            saveSrs();
            showToast(`🔁 안키: ${next.interval}일 후 복습으로 저장되었습니다.`);
            const stateName = next.state === 'mastered' ? '✨ 마스터' : (next.state === 'review' ? '복습' : '학습중');
            quizAnkiStatusTag.textContent = `${stateName} (${next.interval}일 간격 · ${getCardDueDateText(next)})`;
          };
        }
      });
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
    state.levelIndices[state.level] = state.currentIndex;
    saveState();
    renderCurrentQuestion();
  }

  function prevQuestion() {
    if (state.currentIndex > 0) {
      state.currentIndex--;
    } else {
      state.currentIndex = currentQuestions.length - 1;
    }
    state.levelIndices[state.level] = state.currentIndex;
    saveState();
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

  // --- Export Mistakes to CSV (Excel compatible with UTF-8 BOM) ---
  function exportMistakesToCsv() {
    const allMistakes = Object.values(mistakes);
    if (allMistakes.length === 0) {
      showToast('내보낼 오답노트가 비어 있습니다.');
      return;
    }

    const headers = [
      '번호', '급수', '문제유형', '오답횟수', '정복여부', '지시사항',
      '문제(일본어)', '문제해석',
      '보기1', '보기2', '보기3', '보기4',
      '정답', '정답해석', '정답완성문장', '완성문장해석', '해설'
    ];

    function escapeCsv(cell) {
      if (cell === null || cell === undefined) return '""';
      const str = String(cell).replace(/"/g, '""').replace(/\r?\n/g, ' ');
      return `"${str}"`;
    }

    const rows = [headers.join(',')];

    allMistakes.forEach((m, idx) => {
      const correctOpt = m.options ? m.options.find(o => o.isCorrect) : null;
      const optTexts = (m.options || []).map(o => {
        let t = `${o.marker || ''} ${o.copy || ''}`;
        if (o.trans) t += ` (${o.trans})`;
        if (o.isCorrect) t += ' [정답]';
        return t;
      });
      while (optTexts.length < 4) optTexts.push('');

      let explText = '';
      if (m.expl && m.expl.main) {
        explText = m.expl.main;
        if (m.expl.choices && m.expl.choices.length > 0) {
          explText += ' | ' + m.expl.choices.map(c => `${c.marker}: ${c.note}`).join('; ');
        }
      }

      const row = [
        idx + 1,
        escapeCsv(m.level || ''),
        escapeCsv(m.typeName || ''),
        m.count || 1,
        escapeCsv(m.isMastered ? '정복완료' : '복습대기'),
        escapeCsv(m.instruction || ''),
        escapeCsv(m.qPlain || ''),
        escapeCsv(m.qTrans || ''),
        escapeCsv(optTexts[0]),
        escapeCsv(optTexts[1]),
        escapeCsv(optTexts[2]),
        escapeCsv(optTexts[3]),
        escapeCsv(correctOpt ? `${correctOpt.marker || ''} ${correctOpt.copy || ''}` : ''),
        escapeCsv(correctOpt && correctOpt.trans ? correctOpt.trans : ''),
        escapeCsv(m.ansJa || ''),
        escapeCsv(m.ansKo || ''),
        escapeCsv(explText)
      ];
      rows.push(row.join(','));
    });

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `JLPT_오답노트_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('📊 오답노트 엑셀/CSV 파일이 다운로드되었습니다.');
  }

  // --- Export Mistakes to Clean Printable PDF Report ---
  function exportMistakesToPdf() {
    const allMistakes = Object.values(mistakes);
    if (allMistakes.length === 0) {
      showToast('인쇄/저장할 오답노트가 비어 있습니다.');
      return;
    }

    const activeCount = allMistakes.filter(m => !m.isMastered).length;
    const masteredCount = allMistakes.filter(m => m.isMastered).length;

    const reportHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>JLPT 스마트 오답노트 & 학습 보고서</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700&family=Noto+Sans+KR:wght@400;600;700&family=Outfit:wght@600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Noto Sans KR', 'Noto Sans JP', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.6;
      padding: 2.5rem 1.5rem;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
      background: #ffffff;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }
    .title-area h1 {
      font-size: 1.65rem;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.02em;
    }
    .meta-date {
      font-size: 0.88rem;
      color: #64748b;
      margin-top: 0.25rem;
    }
    .summary-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      margin-top: 0.75rem;
    }
    .pill {
      font-size: 0.82rem;
      font-weight: 700;
      padding: 0.3rem 0.8rem;
      border-radius: 9999px;
    }
    .pill-blue { background: #e0e7ff; color: #4338ca; }
    .pill-green { background: #dcfce7; color: #15803d; }
    .pill-wrong { background: #fee2e2; color: #dc2626; }
    
    .actions-bar {
      display: flex;
      gap: 0.5rem;
    }
    .btn-action {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: #4f46e5;
      color: #ffffff;
      border: none;
      padding: 0.65rem 1.25rem;
      border-radius: 8px;
      font-size: 0.92rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(79, 70, 229, 0.3);
      transition: all 0.2s;
    }
    .btn-action:hover { background: #4338ca; }

    .mistake-card {
      background: #ffffff;
      border: 1.5px solid #e2e8f0;
      border-radius: 12px;
      padding: 1.4rem;
      margin-bottom: 1.5rem;
      page-break-inside: avoid;
    }
    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .card-badges {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
    }
    .badge-level { background: #e0e7ff; color: #4338ca; }
    .badge-type { background: #f1f5f9; color: #475569; }
    .badge-count { background: #fef2f2; color: #ef4444; border: 1px solid #fecaca; }

    .q-text {
      font-size: 1.15rem;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.6;
      margin-bottom: 0.35rem;
    }
    .q-trans {
      font-size: 0.92rem;
      color: #64748b;
      margin-bottom: 1rem;
    }

    .options-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1rem;
      font-size: 0.93rem;
    }
    .options-table td {
      padding: 0.5rem 0.75rem;
      border: 1px solid #edf2f7;
    }
    .opt-correct {
      background: #f0fdf4;
      font-weight: 700;
      color: #15803d;
    }
    .tag-correct {
      background: #16a34a;
      color: #fff;
      font-size: 0.72rem;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      margin-left: 0.4rem;
    }

    .cs-box {
      background: #f8fafc;
      border-left: 4px solid #4f46e5;
      padding: 0.75rem 1rem;
      border-radius: 0 8px 8px 0;
      margin-bottom: 0.85rem;
    }
    .cs-label { font-size: 0.75rem; font-weight: 700; color: #4f46e5; margin-bottom: 0.2rem; }
    .cs-ja { font-size: 0.98rem; font-weight: 700; color: #1e293b; }
    .cs-ko { font-size: 0.88rem; color: #64748b; }

    .expl-box {
      background: #fffbeb;
      border: 1px solid #fef3c7;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.92rem;
      color: #92400e;
    }
    .expl-label { font-weight: 700; margin-bottom: 0.2rem; }

    @media print {
      body { background: #ffffff; padding: 0; }
      .container { max-width: 100%; box-shadow: none; padding: 0; }
      .actions-bar { display: none !important; }
      .mistake-card { border: 1px solid #cbd5e1; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="title-area">
        <h1>📓 JLPT 실시간 스마트 오답노트 & 학습 보고서</h1>
        <div class="meta-date">생성 일시: ${new Date().toLocaleString('ko-KR')}</div>
        <div class="summary-pills">
          <span class="pill pill-blue">총 오답 문항: ${allMistakes.length}개</span>
          <span class="pill pill-wrong">⚠️ 복습 대기: ${activeCount}문항</span>
          <span class="pill pill-green">✨ 정복 완료: ${masteredCount}문항</span>
        </div>
      </div>
      <div class="actions-bar">
        <button class="btn-action" onclick="window.print()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/></svg>
          <span>PDF 인쇄 / 저장</span>
        </button>
      </div>
    </div>

    <h2 style="font-size:1.15rem; font-weight:700; color:#0f172a; margin-bottom:1rem;">⚠️ 오답 상세 분석 및 복습 노트 (${allMistakes.length}문항)</h2>
    
    ${allMistakes.map((m, idx) => {
      const correctOpt = (m.options || []).find(o => o.isCorrect);
      return `
      <div class="mistake-card">
        <div class="card-top">
          <div class="card-badges">
            <span class="badge badge-level">${m.level}</span>
            <span class="badge badge-type">${m.typeName}</span>
            <span class="badge badge-count">${m.count || 1}회 오답</span>
            ${m.isMastered ? '<span class="badge" style="background:#dcfce7; color:#15803d;">✨ 마스터</span>' : ''}
          </div>
          <span style="font-size:0.85rem; color:#64748b; font-weight:700;">#${idx + 1}</span>
        </div>

        <div class="q-text">${m.qRuby || m.qPlain}</div>
        ${m.qTrans ? `<div class="q-trans">${m.qTrans}</div>` : ''}

        <table class="options-table">
          ${(m.options || []).map(o => {
            const isCorr = o.isCorrect;
            return `
            <tr class="${isCorr ? 'opt-correct' : ''}">
              <td style="width:30px; text-align:center; font-weight:700;">${o.marker}</td>
              <td>${o.copy} ${o.trans ? `<span style="color:#64748b; font-size:0.88rem;">(${o.trans})</span>` : ''}</td>
              <td style="width:70px; text-align:right;">
                ${isCorr ? '<span class="tag-correct">정답</span>' : ''}
              </td>
            </tr>
            `;
          }).join('')}
        </table>

        ${m.ansJa ? `
        <div class="cs-box">
          <div class="cs-label">정답 완성 문장</div>
          <div class="cs-ja">${m.ansJa}</div>
          ${m.ansKo ? `<div class="cs-ko">${m.ansKo}</div>` : ''}
        </div>
        ` : ''}

        ${m.expl && m.expl.main ? `
        <div class="expl-box">
          <div class="expl-label">💡 핵심 해설</div>
          <div>${m.expl.main}</div>
          ${m.expl.choices && m.expl.choices.length > 0 ? `
            <div style="margin-top:0.4rem; font-size:0.88rem; line-height:1.5;">
              ${m.expl.choices.map(c => `<div><b>${c.marker}</b>: ${c.note}</div>`).join('')}
            </div>
          ` : ''}
        </div>
        ` : ''}
      </div>
      `;
    }).join('')}
  </div>
  <script>
    window.addEventListener('load', () => {
      setTimeout(() => window.print(), 350);
    });
  <\/script>
</body>
</html>`;

    const blob = new Blob([reportHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
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

  // ==========================================================================
  // Anki Spaced Repetition (SRS) Engine
  // ==========================================================================

  // Helper: Find Question by ID across datasets
  function getQuestionById(id) {
    if (!id) return null;
    if (mistakes[id]) return mistakes[id];
    const lvl = id.split('-')[0];
    if (window.JLPT_DATA && window.JLPT_DATA[lvl]) {
      const found = window.JLPT_DATA[lvl].find(q => q.id === id);
      if (found) return found;
    }
    for (const l of ['N1', 'N2', 'N3', 'N4', 'N5']) {
      if (window.JLPT_DATA && window.JLPT_DATA[l]) {
        const found = window.JLPT_DATA[l].find(q => q.id === id);
        if (found) return found;
      }
    }
    return null;
  }

  // Helper: Format Due Date for cards
  function getCardDueDateText(card) {
    if (!card || !card.dueDate) return '오늘 복습';
    const now = Date.now();
    const diffDays = Math.ceil((card.dueDate - now) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return '🚨 오늘 복습 대기';
    if (diffDays === 1) return '내일 복습';
    return `${diffDays}일 후 복습`;
  }

  // SM-2 Spaced Repetition Algorithm
  function calculateNextSrs(card, grade) {
    let repetitions = card.repetitions || 0;
    let interval = card.interval || 1;
    let easeFactor = card.easeFactor || 2.5;
    let lapses = card.lapses || 0;
    let state = card.state || 'learning';

    if (grade === 'again') {
      repetitions = 0;
      interval = 1;
      easeFactor = Math.max(1.3, easeFactor - 0.2);
      lapses++;
      state = 'learning';
    } else if (grade === 'hard') {
      if (repetitions === 0) interval = 1;
      else if (repetitions === 1) interval = 2;
      else interval = Math.max(interval + 1, Math.round(interval * 1.2));
      easeFactor = Math.max(1.3, easeFactor - 0.15);
      state = interval >= 21 ? 'mastered' : (interval >= 4 ? 'review' : 'learning');
    } else if (grade === 'good') {
      if (repetitions === 0) interval = 1;
      else if (repetitions === 1) interval = 3;
      else interval = Math.max(interval + 1, Math.round(interval * easeFactor));
      repetitions++;
      easeFactor = Math.min(2.8, easeFactor);
      state = interval >= 21 ? 'mastered' : (interval >= 4 ? 'review' : 'learning');
    } else if (grade === 'easy') {
      if (repetitions === 0) interval = 4;
      else if (repetitions === 1) interval = 7;
      else interval = Math.max(interval + 3, Math.round(interval * easeFactor * 1.35));
      repetitions++;
      easeFactor = Math.min(2.8, easeFactor + 0.15);
      state = interval >= 14 ? 'mastered' : 'review';
    }

    const now = Date.now();
    const targetDate = new Date(now + interval * 24 * 60 * 60 * 1000);
    targetDate.setHours(4, 0, 0, 0); // 4 AM reset
    const dueDate = targetDate.getTime();

    return {
      ...card,
      repetitions,
      interval,
      easeFactor: Number(easeFactor.toFixed(2)),
      lapses,
      state,
      lastReviewed: now,
      dueDate
    };
  }

  // Native Speech Synthesis Helper
  function speakJapanese(text) {
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const clean = text.replace(/<[^>]*>/g, '').replace(/[（()）]/g, '');
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = 'ja-JP';
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.warn('TTS error:', e);
    }
  }

  function toggleBookmarkById(id) {
    if (!id) return;
    if (bookmarks.has(id)) {
      bookmarks.delete(id);
      showToast('북마크가 해제되었습니다.');
    } else {
      bookmarks.add(id);
      showToast('★ 북마크에 추가되었습니다.');
    }
    saveBookmarks();
    if (state.currentTab === 'anki') {
      renderAnkiCard(ankiState.currentQueue[ankiState.queueIndex]);
    }
  }

  // Anki Badges & Counters
  function updateAnkiBadge() {
    const dueCountBadgeHeader = document.getElementById('header-anki-due-count');
    const dueCountBadgeMobile = document.getElementById('mobile-anki-due-count');

    const now = Date.now();
    const dueCards = Object.values(srs).filter(c => (c.dueDate || 0) <= now + 60000);
    const dueCount = dueCards.length;

    if (dueCountBadgeHeader) {
      dueCountBadgeHeader.textContent = dueCount.toLocaleString();
      dueCountBadgeHeader.style.display = dueCount > 0 ? 'inline-flex' : 'none';
    }
    if (dueCountBadgeMobile) {
      dueCountBadgeMobile.textContent = dueCount.toLocaleString();
      dueCountBadgeMobile.style.display = dueCount > 0 ? 'inline-flex' : 'none';
    }

    // Hero stat numbers
    const statDue = document.getElementById('anki-stat-due');
    const statLearning = document.getElementById('anki-stat-learning');
    const statReview = document.getElementById('anki-stat-review');
    const statMastered = document.getElementById('anki-stat-mastered');

    const allSrs = Object.values(srs);
    const learningCount = allSrs.filter(c => c.state === 'learning').length;
    const reviewCount = allSrs.filter(c => c.state === 'review').length;
    const masteredCount = allSrs.filter(c => c.state === 'mastered').length;

    if (statDue) statDue.textContent = dueCount.toLocaleString();
    if (statLearning) statLearning.textContent = learningCount.toLocaleString();
    if (statReview) statReview.textContent = reviewCount.toLocaleString();
    if (statMastered) statMastered.textContent = masteredCount.toLocaleString();
  }

  // Anki Queue Builder
  function buildAnkiQueue(forceEarly = false) {
    const now = Date.now();
    let cardIds = [];

    if (ankiState.source === 'due') {
      cardIds = Object.values(srs)
        .filter(c => {
          if (forceEarly) {
            return (c.dueDate || 0) <= now + 3 * 86400000;
          }
          return (c.dueDate || 0) <= now + 60000;
        })
        .map(c => c.id);
    } else if (ankiState.source === 'frequent') {
      const mistakeList = Object.values(mistakes).filter(m => !m.isMastered || (m.count && m.count > 1));
      mistakeList.sort((a, b) => (b.count || 1) - (a.count || 1));
      const frequentIds = [];
      mistakeList.forEach(m => {
        const repeats = Math.min(3, Math.max(1, m.count || 1));
        for (let r = 0; r < repeats; r++) {
          frequentIds.push(m.id);
        }
      });
      cardIds = interleaveQueue(frequentIds.map(id => ({ id }))).map(x => x.id);
    } else if (ankiState.source === 'mistakes') {
      cardIds = Object.keys(mistakes);
    } else if (ankiState.source === 'all_srs') {
      cardIds = Object.keys(srs);
    } else if (ankiState.source === 'history') {
      cardIds = Object.keys(history);
    } else if (ankiState.source === 'bookmarks') {
      cardIds = Array.from(bookmarks);
    }

    // Filter by level
    if (ankiState.level !== 'ALL') {
      cardIds = cardIds.filter(id => id.startsWith(ankiState.level));
    }

    // If still empty and in 'due' mode, automatically offer un-reviewed mistakes if available
    if (cardIds.length === 0 && ankiState.source === 'due' && Object.keys(mistakes).length > 0 && !forceEarly) {
      cardIds = Object.keys(mistakes).filter(id => ankiState.level === 'ALL' || id.startsWith(ankiState.level));
    }

    return cardIds;
  }

  let ankiInitialized = false;

  function initAnkiTab() {
    updateAnkiBadge();

    if (ankiInitialized) {
      ankiState.currentQueue = buildAnkiQueue();
      ankiState.queueIndex = 0;
      return;
    }
    ankiInitialized = true;

    // Filter level
    const selectLevel = document.getElementById('select-anki-level');
    if (selectLevel) {
      selectLevel.value = ankiState.level;
      selectLevel.addEventListener('change', (e) => {
        ankiState.level = e.target.value;
        ankiState.currentQueue = buildAnkiQueue();
        ankiState.queueIndex = 0;
        renderAnkiSession();
      });
    }

    // Filter source
    const selectSource = document.getElementById('select-anki-source');
    if (selectSource) {
      selectSource.value = ankiState.source;
      selectSource.addEventListener('change', (e) => {
        ankiState.source = e.target.value;
        ankiState.currentQueue = buildAnkiQueue();
        ankiState.queueIndex = 0;
        renderAnkiSession();
      });
    }

    // Mode segmented control
    document.querySelectorAll('#anki-mode-segmented .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#anki-mode-segmented .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ankiState.mode = btn.dataset.ankiMode;
        renderAnkiSession();
      });
    });

    // Flip card button
    const btnFlipCard = document.getElementById('btn-flip-card');
    if (btnFlipCard) {
      btnFlipCard.addEventListener('click', () => flipAnkiCard(true));
    }

    const btnFlipBack = document.getElementById('btn-flip-back');
    if (btnFlipBack) {
      btnFlipBack.addEventListener('click', () => flipAnkiCard(false));
    }

    // 4 Evaluation Buttons
    ['again', 'hard', 'good', 'easy'].forEach(grade => {
      const btn = document.getElementById(`btn-eval-${grade}`);
      if (btn) {
        btn.addEventListener('click', () => rateAnkiCard(grade));
      }
    });

    // Audio & Bookmark buttons
    const btnAudio = document.getElementById('btn-anki-audio');
    if (btnAudio) {
      btnAudio.addEventListener('click', () => {
        const cardId = ankiState.currentQueue[ankiState.queueIndex];
        const q = getQuestionById(cardId);
        if (q) speakJapanese(q.ansJa || q.qPlain);
      });
    }

    const btnBookmark = document.getElementById('btn-anki-bookmark');
    if (btnBookmark) {
      btnBookmark.addEventListener('click', () => {
        const cardId = ankiState.currentQueue[ankiState.queueIndex];
        if (cardId) toggleBookmarkById(cardId);
      });
    }

    // Early Review Button
    const btnEarly = document.getElementById('btn-anki-early-review');
    if (btnEarly) {
      btnEarly.addEventListener('click', () => {
        ankiState.currentQueue = buildAnkiQueue(true);
        ankiState.queueIndex = 0;
        renderAnkiSession();
        showToast('⚡ 내일 이후 복습 카드를 미리 당겨왔습니다!');
      });
    }

    const btnCompletedEarly = document.getElementById('btn-completed-early');
    if (btnCompletedEarly) {
      btnCompletedEarly.addEventListener('click', () => {
        ankiState.currentQueue = buildAnkiQueue(true);
        ankiState.queueIndex = 0;
        renderAnkiSession();
        showToast('⚡ 내일 이후 복습 카드를 미리 당겨왔습니다!');
      });
    }

    // Schedule section toggle
    const btnToggleSchedule = document.getElementById('btn-toggle-anki-schedule');
    const scheduleSection = document.getElementById('anki-schedule-section');
    if (btnToggleSchedule && scheduleSection) {
      btnToggleSchedule.addEventListener('click', () => {
        scheduleSection.classList.toggle('hidden');
        if (!scheduleSection.classList.contains('hidden')) {
          renderAnkiSchedule();
          scheduleSection.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }

    const btnCompletedSchedule = document.getElementById('btn-completed-view-schedule');
    if (btnCompletedSchedule && scheduleSection) {
      btnCompletedSchedule.addEventListener('click', () => {
        scheduleSection.classList.remove('hidden');
        renderAnkiSchedule();
        scheduleSection.scrollIntoView({ behavior: 'smooth' });
      });
    }

    // Schedule search
    const inputSearch = document.getElementById('input-anki-search');
    if (inputSearch) {
      inputSearch.addEventListener('input', () => renderAnkiSchedule());
    }

    // Add cards modal triggers
    setupAddAnkiModal();

    // Initial queue build
    ankiState.currentQueue = buildAnkiQueue();
    ankiState.queueIndex = 0;
  }

  function setupAddAnkiModal() {
    const btnAddDeck = document.getElementById('btn-anki-add-deck');
    const modalAddAnki = document.getElementById('modal-add-anki');
    const btnClose = document.getElementById('btn-close-add-anki');
    const btnCancel = document.getElementById('btn-cancel-add-anki');
    const btnConfirm = document.getElementById('btn-confirm-add-anki');
    let selectedCount = 10;

    if (btnAddDeck && modalAddAnki) {
      btnAddDeck.addEventListener('click', () => {
        modalAddAnki.classList.remove('hidden');
      });
    }

    if (btnClose && modalAddAnki) {
      btnClose.addEventListener('click', () => modalAddAnki.classList.add('hidden'));
    }
    if (btnCancel && modalAddAnki) {
      btnCancel.addEventListener('click', () => modalAddAnki.classList.add('hidden'));
    }

    // Count selector buttons
    document.querySelectorAll('#modal-add-anki-count-group .modal-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#modal-add-anki-count-group .modal-count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedCount = parseInt(btn.dataset.count, 10);
      });
    });

    if (btnConfirm && modalAddAnki) {
      btnConfirm.addEventListener('click', () => {
        const lvl = document.getElementById('modal-add-anki-level').value;
        const type = document.getElementById('modal-add-anki-type').value;
        const pool = document.getElementById('modal-add-anki-pool').value;

        const rawQuestions = (window.JLPT_DATA && window.JLPT_DATA[lvl]) || [];
        let candidates = [];

        if (pool === 'mistakes') {
          candidates = Object.keys(mistakes).map(id => getQuestionById(id)).filter(q => q && q.level === lvl);
        } else if (pool === 'bookmarks') {
          candidates = Array.from(bookmarks).map(id => getQuestionById(id)).filter(q => q && q.level === lvl);
        } else if (pool === 'new') {
          candidates = rawQuestions.filter(q => !history[q.id] && !srs[q.id]);
        } else {
          candidates = rawQuestions.slice();
        }

        if (type !== 'ALL') {
          candidates = candidates.filter(q => q.typeName === type);
        }

        if (candidates.length === 0) {
          showToast('선택한 조건에 해당하는 문제가 없습니다.');
          return;
        }

        // Shuffle candidates and pick selectedCount
        candidates.sort(() => Math.random() - 0.5);
        const picked = candidates.slice(0, selectedCount);

        let addedCount = 0;
        picked.forEach(q => {
          if (!srs[q.id]) {
            srs[q.id] = {
              id: q.id,
              level: q.level,
              repetitions: 0,
              interval: 1,
              easeFactor: 2.5,
              dueDate: Date.now(),
              lastReviewed: Date.now(),
              state: 'learning',
              lapses: 0
            };
            addedCount++;
          }
        });

        saveSrs();
        modalAddAnki.classList.add('hidden');
        showToast(`✅ ${picked.length}문제가 안키 복습 덱에 추가되었습니다!`);

        ankiState.level = lvl;
        ankiState.source = 'due';
        const selectLevel = document.getElementById('select-anki-level');
        if (selectLevel) selectLevel.value = lvl;
        const selectSource = document.getElementById('select-anki-source');
        if (selectSource) selectSource.value = 'due';

        ankiState.currentQueue = buildAnkiQueue();
        ankiState.queueIndex = 0;
        renderAnkiSession();
      });
    }
  }

  function renderAnkiSession() {
    const arena = document.getElementById('anki-arena');
    const cardWrapper = document.getElementById('anki-card-wrapper');
    const sessionHeader = document.getElementById('anki-session-header');
    const completedState = document.getElementById('anki-completed-state');

    if (!arena) return;

    if (!ankiState.currentQueue || ankiState.currentQueue.length === 0 || ankiState.queueIndex >= ankiState.currentQueue.length) {
      // Completed state
      if (cardWrapper) cardWrapper.classList.add('hidden');
      if (sessionHeader) sessionHeader.classList.add('hidden');
      if (completedState) {
        completedState.classList.remove('hidden');

        // Summary pills
        const summaryContainer = document.getElementById('anki-completed-summary');
        if (summaryContainer) {
          const totalSrs = Object.keys(srs).length;
          const masteredCount = Object.values(srs).filter(c => c.state === 'mastered').length;
          summaryContainer.innerHTML = `
            <div class="completed-stat-item">
              <span class="completed-stat-num color-indigo">${ankiState.sessionSolvedCount}</span>
              <span class="completed-stat-lbl">이번 세션 복습 완료</span>
            </div>
            <div class="completed-stat-item">
              <span class="completed-stat-num color-amber">${totalSrs}</span>
              <span class="completed-stat-lbl">현재 보존 덱 총 카드</span>
            </div>
            <div class="completed-stat-item">
              <span class="completed-stat-num color-emerald">${masteredCount}</span>
              <span class="completed-stat-lbl">망각곡선 정복 완료</span>
            </div>
          `;
        }
      }
      return;
    }

    // Active session
    if (completedState) completedState.classList.add('hidden');
    if (cardWrapper) cardWrapper.classList.remove('hidden');
    if (sessionHeader) sessionHeader.classList.remove('hidden');

    const total = ankiState.currentQueue.length;
    const current = ankiState.queueIndex + 1;
    const progressPercent = Math.round((current / total) * 100);

    const counterEl = document.getElementById('anki-session-counter');
    if (counterEl) counterEl.textContent = `복습 진행: ${current} / ${total} (${progressPercent}%)`;

    const fillEl = document.getElementById('anki-progress-fill');
    if (fillEl) fillEl.style.width = `${progressPercent}%`;

    const cardId = ankiState.currentQueue[ankiState.queueIndex];
    renderAnkiCard(cardId);
  }

  function renderAnkiCard(cardId) {
    const q = getQuestionById(cardId);
    if (!q) {
      ankiState.queueIndex++;
      renderAnkiSession();
      return;
    }

    const card = srs[cardId] || {
      id: cardId,
      level: q.level || 'N1',
      repetitions: 0,
      interval: 1,
      easeFactor: 2.5,
      state: 'learning'
    };

    // Header Badges
    const badgeLevel = document.getElementById('anki-card-level');
    if (badgeLevel) badgeLevel.textContent = q.level;

    const badgeType = document.getElementById('anki-card-type');
    if (badgeType) badgeType.textContent = q.typeName || '문제';

    const badgeSrs = document.getElementById('anki-card-srs-status');
    if (badgeSrs) {
      const stateName = card.state === 'mastered' ? '✨ 마스터' : (card.state === 'review' ? '복습 안정권' : '학습 중');
      badgeSrs.textContent = `${stateName} · 간격: ${card.interval || 1}일 (${card.repetitions || 0}회 연속 정답)`;
    }

    const btnBookmark = document.getElementById('btn-anki-bookmark');
    if (btnBookmark) {
      btnBookmark.classList.toggle('active', bookmarks.has(cardId));
    }

    // Instruction & Question
    const instEl = document.getElementById('anki-instruction');
    if (instEl) instEl.textContent = q.instruction || '빈칸에 들어갈 가장 알맞은 표현을 고르세요.';

    const qTextEl = document.getElementById('anki-question-text');
    if (qTextEl) {
      qTextEl.innerHTML = state.furigana ? (q.qRuby || q.qPlain) : q.qPlain;
    }

    const qTransEl = document.getElementById('anki-question-trans');
    if (qTransEl) {
      qTransEl.textContent = q.qTrans || '';
      qTransEl.classList.toggle('hidden', !state.showTrans);
    }

    // Render options
    const optionsGrid = document.getElementById('anki-options-grid');
    if (optionsGrid) {
      optionsGrid.innerHTML = '';
      (q.options || []).forEach((opt, idx) => {
        const item = document.createElement('div');
        item.className = 'anki-option-item';
        item.dataset.index = idx;

        const copyText = state.furigana ? (opt.copy || '') : (opt.copyNoRuby || opt.copy || '');
        item.innerHTML = `
          <span class="anki-option-marker">${opt.marker || `(${idx + 1})`}</span>
          <span class="anki-option-copy">${copyText}</span>
          ${opt.trans && state.showTrans ? `<span style="font-size:0.85rem; color:var(--text-muted); margin-left:auto;">${opt.trans}</span>` : ''}
        `;

        item.addEventListener('click', () => {
          if (ankiState.mode === 'quiz' && !ankiState.isFlipped) {
            handleAnkiQuizSelect(idx);
          } else {
            flipAnkiCard(true);
          }
        });

        optionsGrid.appendChild(item);
      });
    }

    // Back card content
    const csJa = document.getElementById('anki-cs-ja');
    if (csJa) csJa.textContent = q.ansJa || q.qPlain;

    const csKo = document.getElementById('anki-cs-ko');
    if (csKo) csKo.textContent = q.ansKo || q.qTrans || '';

    const explMain = document.getElementById('anki-expl-main');
    if (explMain) explMain.textContent = q.expl?.main || '정답과 해설을 확인하세요.';

    const choiceNotes = document.getElementById('anki-choice-notes');
    if (choiceNotes) {
      if (q.expl && q.expl.choices && q.expl.choices.length > 0) {
        choiceNotes.innerHTML = q.expl.choices.map(c => `
          <div class="choice-note-item">
            <span class="choice-note-marker">${c.marker}</span>
            <span>${escapeHtml(c.note)}</span>
          </div>
        `).join('');
        choiceNotes.classList.remove('hidden');
      } else {
        choiceNotes.innerHTML = '';
        choiceNotes.classList.add('hidden');
      }
    }

    // Preview intervals for the 4 buttons
    const prevAgain = calculateNextSrs(card, 'again');
    const prevHard = calculateNextSrs(card, 'hard');
    const prevGood = calculateNextSrs(card, 'good');
    const prevEasy = calculateNextSrs(card, 'easy');

    const intAgain = document.getElementById('eval-interval-again');
    if (intAgain) intAgain.textContent = `${prevAgain.interval}일`;

    const intHard = document.getElementById('eval-interval-hard');
    if (intHard) intHard.textContent = `${prevHard.interval}일`;

    const intGood = document.getElementById('eval-interval-good');
    if (intGood) intGood.textContent = `${prevGood.interval}일`;

    const intEasy = document.getElementById('eval-interval-easy');
    if (intEasy) intEasy.textContent = `${prevEasy.interval}일`;

    // Reset flip state to front
    flipAnkiCard(false);
  }

  function flipAnkiCard(toBack = true) {
    ankiState.isFlipped = toBack;
    const cardFront = document.getElementById('anki-card-front');
    const cardBack = document.getElementById('anki-card-back');

    if (toBack) {
      if (cardFront) cardFront.classList.add('hidden');
      if (cardBack) cardBack.classList.remove('hidden');

      // Reveal translations on back
      const qTransEl = document.getElementById('anki-question-trans');
      if (qTransEl) qTransEl.classList.remove('hidden');
    } else {
      if (cardFront) cardFront.classList.remove('hidden');
      if (cardBack) cardBack.classList.add('hidden');
    }
  }

  function handleAnkiQuizSelect(optIdx) {
    const cardId = ankiState.currentQueue[ankiState.queueIndex];
    const q = getQuestionById(cardId);
    if (!q || !q.options) return;

    const selectedOpt = q.options[optIdx];
    const isCorrect = selectedOpt && selectedOpt.isCorrect;

    // Visual highlights
    const items = document.querySelectorAll('#anki-options-grid .anki-option-item');
    items.forEach((item, idx) => {
      if (q.options[idx].isCorrect) {
        item.classList.add('selected-correct');
      }
      if (idx === optIdx && !isCorrect) {
        item.classList.add('selected-wrong');
      }
    });

    if (isCorrect) {
      sound.playCorrect();
    } else {
      sound.playWrong();
    }

    setTimeout(() => {
      flipAnkiCard(true);
    }, 280);
  }

  function rateAnkiCard(grade) {
    const cardId = ankiState.currentQueue[ankiState.queueIndex];
    if (!cardId) return;

    const q = getQuestionById(cardId);
    const existing = srs[cardId] || {
      id: cardId,
      level: q ? q.level : 'N1',
      repetitions: 0,
      interval: 1,
      easeFactor: 2.5,
      state: 'learning',
      lapses: 0
    };

    const next = calculateNextSrs(existing, grade);
    srs[cardId] = next;
    saveSrs();

    if (grade === 'again') {
      sound.playWrong();
      showToast('🔴 [다시] 3문제 뒤에 다시 출제됩니다.');
      // Re-queue card 3~4 positions ahead for immediate retention loop!
      const targetPos = Math.min(ankiState.currentQueue.length, ankiState.queueIndex + 4);
      ankiState.currentQueue.splice(targetPos, 0, cardId);
    } else if (grade === 'hard') {
      showToast(`🟠 [어려움] ${next.interval}일 후 복습으로 예약되었습니다.`);
    } else if (grade === 'good') {
      sound.playCorrect();
      showToast(`🟢 [알맞음] ${next.interval}일 후 복습으로 예약되었습니다.`);
    } else if (grade === 'easy') {
      sound.playCorrect();
      showToast(`🔵 [쉬움] ${next.interval}일 후 복습으로 예약되었습니다.`);
    }

    ankiState.sessionSolvedCount++;
    ankiState.queueIndex++;
    renderAnkiSession();
  }

  function renderAnkiSchedule() {
    const container = document.getElementById('anki-schedule-list');
    const totalCountEl = document.getElementById('anki-total-deck-count');
    const searchInput = document.getElementById('input-anki-search');
    if (!container) return;

    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const now = Date.now();
    const allCards = Object.values(srs);

    if (totalCountEl) totalCountEl.textContent = allCards.length.toLocaleString();

    let filtered = allCards.filter(c => {
      if (!query) return true;
      const q = getQuestionById(c.id);
      if (!q) return c.id.toLowerCase().includes(query);
      return c.id.toLowerCase().includes(query) ||
             (q.qPlain && q.qPlain.toLowerCase().includes(query)) ||
             (q.ansJa && q.ansJa.toLowerCase().includes(query)) ||
             (q.ansKo && q.ansKo.toLowerCase().includes(query));
    });

    // Sort: due cards first, then by next due date
    filtered.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));

    if (filtered.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:1.5rem;">검색된 카드가 없습니다.</div>';
      return;
    }

    let html = '';
    filtered.forEach(c => {
      const q = getQuestionById(c.id);
      const isDue = (c.dueDate || 0) <= now + 60000;
      const dueText = getCardDueDateText(c);
      const questionSnippet = q ? q.qPlain : c.id;

      html += `
        <div class="schedule-card-row">
          <div class="sched-left">
            <span class="badge badge-level" style="font-size:0.72rem;">${c.level || (q ? q.level : 'N1')}</span>
            <span class="sched-text" title="${escapeHtml(questionSnippet)}">${escapeHtml(questionSnippet)}</span>
          </div>
          <div class="sched-right">
            <span class="sched-due-pill ${isDue ? 'is-due' : 'is-future'}">${dueText}</span>
            <span style="font-size:0.75rem; color:var(--text-muted);">간격 ${c.interval || 1}일</span>
            <button class="btn btn-secondary btn-sm" onclick="window.app.startAnkiSingleCard('${c.id}')" style="padding:0.25rem 0.5rem; font-size:0.75rem;">복습</button>
            <button class="btn btn-ghost btn-sm" onclick="window.app.resetAnkiCard('${c.id}')" title="간격 1일로 초기화" style="padding:0.25rem 0.4rem; font-size:0.75rem;">↺</button>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
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

    if (tabName === 'anki') {
      initAnkiTab();
      renderAnkiSession();
    } else if (tabName === 'mistakes') {
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
    const badges = document.querySelectorAll('.mistake-count-badge');
    if (!badges || badges.length === 0) return;
    const activeCount = Object.values(mistakes).filter(m => !m.isMastered).length;
    badges.forEach(badge => {
      badge.textContent = activeCount.toLocaleString();
      badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
    });
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

    // Quiz Mode buttons (#mode-segmented)
    document.querySelectorAll('#mode-segmented .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mode-segmented .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        saveState();
        if (state.mode === 'exam') {
          showToast('⏱️ 모의고사 모드가 켜졌습니다. 문제를 풀고 "시험 종료 및 채점"을 누르세요.');
          document.getElementById('btn-finish-exam').classList.remove('hidden');
          document.getElementById('exam-status-bar').classList.remove('hidden');
        } else if (state.mode === 'new-drill' || state.mode === 'srs-drill') {
          document.getElementById('btn-finish-exam').classList.add('hidden');
          document.getElementById('exam-status-bar').classList.add('hidden');
          loadLevelQuestions(state.level, false);
          renderCurrentQuestion();
          if (currentQuestions.length > 0) {
            showToast(`✨ [새로운 문제 풀기] 아직 풀지 않은 ${currentQuestions.length.toLocaleString()}개의 새로운 문제를 시작합니다!`);
          } else {
            showToast('🎉 [새로운 문제 풀기] 해당 조건의 모든 문제를 이미 풀었습니다!');
          }
        } else {
          document.getElementById('btn-finish-exam').classList.add('hidden');
          document.getElementById('exam-status-bar').classList.add('hidden');
          loadLevelQuestions(state.level, false);
          renderCurrentQuestion();
          showToast('⚡ 즉시 풀기 모드로 전환되었습니다.');
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

    // Furigana toggle (Header toggle & Quick button)
    const toggleFurigana = document.getElementById('toggle-furigana');
    if (toggleFurigana) {
      toggleFurigana.checked = state.furigana;
      toggleFurigana.addEventListener('change', (e) => {
        state.furigana = e.target.checked;
        saveState();
        renderCurrentQuestion();
      });
    }

    const btnQuickFurigana = document.getElementById('btn-quick-furigana');
    if (btnQuickFurigana) {
      btnQuickFurigana.addEventListener('click', () => {
        state.furigana = !state.furigana;
        if (toggleFurigana) toggleFurigana.checked = state.furigana;
        saveState();
        renderCurrentQuestion();
        showToast(state.furigana ? 'あ 요미가나(후리가나) 표시 ON' : 'あ 요미가나(후리가나) 숨김');
      });
    }

    // Translation toggle (Header toggle & Quick button)
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

    const btnQuickTrans = document.getElementById('btn-quick-trans');
    if (btnQuickTrans) {
      btnQuickTrans.addEventListener('click', () => {
        state.showTrans = !state.showTrans;
        if (toggleTrans) toggleTrans.checked = state.showTrans;
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
    const btnCsv = document.getElementById('btn-export-csv');
    if (btnCsv) {
      btnCsv.addEventListener('click', exportMistakesToCsv);
    }
    const btnPdf = document.getElementById('btn-export-pdf');
    if (btnPdf) {
      btnPdf.addEventListener('click', exportMistakesToPdf);
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
        bookmarks: Array.from(bookmarks),
        srs
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
          if (parsed.srs) srs = parsed.srs;

          saveMistakes();
          saveHistory();
          saveBookmarks();
          saveSrs();
          renderStats();
          showToast('✅ 백업 데이터가 성공적으로 복원되었습니다.');
        } catch (err) {
          alert('올바른 백업 JSON 파일이 아닙니다.');
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('btn-reset-data').addEventListener('click', () => {
      if (confirm('모든 풀이 이력, 정답률, 오답노트, 안키 복습 기록이 완전히 초기화됩니다. 계속하시겠습니까?')) {
        mistakes = {};
        history = {};
        bookmarks = new Set();
        srs = {};
        saveMistakes();
        saveHistory();
        saveBookmarks();
        saveSrs();
        renderStats();
        renderCurrentQuestion();
        showToast('데이터가 초기화되었습니다.');
      }
    });

    
    // --- Google Drive Sync Modal & Data Merge ---
    function mergeSyncPayload(payload) {
      let updated = false;

      if (payload.history) {
        for (const [id, h] of Object.entries(payload.history)) {
          if (!history[id]) {
            history[id] = h;
            updated = true;
          } else {
            history[id].solved = Math.max(history[id].solved || 0, h.solved || 0);
            history[id].correct = Math.max(history[id].correct || 0, h.correct || 0);
            if ((h.lastDate || 0) > (history[id].lastDate || 0)) {
              history[id].lastResult = h.lastResult;
              history[id].lastDate = h.lastDate;
            }
            updated = true;
          }
        }
      }

      if (payload.mistakes) {
        for (const [id, m] of Object.entries(payload.mistakes)) {
          if (!mistakes[id]) {
            mistakes[id] = m;
            updated = true;
          } else {
            mistakes[id].count = Math.max(mistakes[id].count || 1, m.count || 1);
            if (m.isMastered && !mistakes[id].isMastered) mistakes[id].isMastered = true;
            if ((m.lastWrongDate || 0) > (mistakes[id].lastWrongDate || 0)) {
              mistakes[id].wrongChoice = m.wrongChoice;
              mistakes[id].lastWrongDate = m.lastWrongDate;
            }
            updated = true;
          }
        }
      }

      if (payload.bookmarks && Array.isArray(payload.bookmarks)) {
        payload.bookmarks.forEach(b => bookmarks.add(b));
        updated = true;
      }

      if (payload.srs) {
        for (const [id, s] of Object.entries(payload.srs)) {
          if (!srs[id] || (s.lastReviewed || 0) > (srs[id].lastReviewed || 0)) {
            srs[id] = { ...s };
            updated = true;
          }
        }
      }

      if (updated) {
        saveState();
        saveHistory();
        saveMistakes();
        saveBookmarks();
        saveSrs();
        renderStats();
        updateMistakeBadge();
        updateAnkiBadge();
        renderCurrentQuestion();
        const totalSolved = Object.keys(history).length;
        showToast(`✅ 구글 드라이브 동기화 완료! (총 ${totalSolved}문제 푼 기록 반영됨)`);
      }
    }

    function updateSyncModalStats() {
      const statSolvedEl = document.getElementById('sync-stat-solved');
      const statMistakesEl = document.getElementById('sync-stat-mistakes');
      if (statSolvedEl) statSolvedEl.textContent = Object.keys(history).length + '문제';
      if (statMistakesEl) statMistakesEl.textContent = Object.keys(mistakes).length + '문항';
    }

    const badgeSync = document.getElementById('sync-status-badge');
    const modalDriveSync = document.getElementById('modal-drive-sync');
    const btnCloseSyncModal = document.getElementById('btn-close-sync-modal');
    const inputDriveImport = document.getElementById('input-drive-import');
    const btnDriveExport = document.getElementById('btn-drive-export');
    const btnForceInitialSync = document.getElementById('btn-force-initial-sync');

    if (badgeSync && modalDriveSync) {
      badgeSync.addEventListener('click', () => {
        updateSyncModalStats();
        modalDriveSync.classList.remove('hidden');
      });
    }

    if (btnCloseSyncModal && modalDriveSync) {
      btnCloseSyncModal.addEventListener('click', () => {
        modalDriveSync.classList.add('hidden');
      });
    }

    if (btnForceInitialSync) {
      btnForceInitialSync.addEventListener('click', () => {
        if (window.JLPT_INITIAL_SYNC) {
          mergeSyncPayload(window.JLPT_INITIAL_SYNC);
          updateSyncModalStats();
          renderStats();
          if (window.JLPT_FIREBASE && window.JLPT_FIREBASE.scheduleCloudUpload) {
            window.JLPT_FIREBASE.scheduleCloudUpload();
          }
          const count = window.JLPT_INITIAL_SYNC.history ? Object.keys(window.JLPT_INITIAL_SYNC.history).length : 4;
          showToast(`⚡ PC 학습 기록 (${count}문제 풀이)이 성공적으로 반영되었습니다!`);
        } else {
          showToast('초기 동기화 데이터가 없습니다.');
        }
      });
    }

    if (inputDriveImport) {
      inputDriveImport.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const parsed = JSON.parse(event.target.result);
            mergeSyncPayload(parsed);
            updateSyncModalStats();
            if (modalDriveSync) modalDriveSync.classList.add('hidden');
          } catch (err) {
            alert('올바른 jlpt_sync_data.json 파일이 아닙니다.');
          }
        };
        reader.readAsText(file);
      });
    }

    if (btnDriveExport) {
      btnDriveExport.addEventListener('click', () => {
        const payload = {
          lastSyncTime: Date.now(),
          lastSyncDate: new Date().toISOString(),
          history,
          mistakes,
          bookmarks: Array.from(bookmarks),
          srs
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'jlpt_sync_data.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('💾 jlpt_sync_data.json 저장 완료! 구글 드라이브에 넣어주세요.');
      });
    }

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Don't trigger shortcuts if user is typing in search input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        return;
      }

      // Escape key closes Question Picker if open
      if (e.key === 'Escape') {
        const pickerModal = document.getElementById('modal-question-picker');
        if (pickerModal && !pickerModal.classList.contains('hidden')) {
          closeQuestionPicker();
          return;
        }
      }

      if (state.currentTab === 'quiz') {
        if (e.key === 'g' || e.key === 'G') {
          openQuestionPicker();
          return;
        } else if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
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
      } else if (state.currentTab === 'anki') {
        if (!ankiState.isFlipped) {
          if (ankiState.mode === 'quiz' && (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4')) {
            const optIdx = parseInt(e.key, 10) - 1;
            handleAnkiQuizSelect(optIdx);
          } else if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            flipAnkiCard(true);
          }
        } else {
          // Card is flipped: 1 Again, 2 Hard, 3 Good, 4 Easy
          if (e.key === '1') {
            rateAnkiCard('again');
          } else if (e.key === '2') {
            rateAnkiCard('hard');
          } else if (e.key === '3') {
            rateAnkiCard('good');
          } else if (e.key === '4') {
            rateAnkiCard('easy');
          } else if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            rateAnkiCard('good');
          }
        }

        if (e.key === 'f' || e.key === 'F') {
          state.furigana = !state.furigana;
          saveState();
          renderAnkiSession();
          showToast(state.furigana ? 'あ 요미가나 ON' : 'あ 요미가나 숨김');
        } else if (e.key === 't' || e.key === 'T') {
          const transEl = document.getElementById('anki-question-trans');
          if (transEl) transEl.classList.toggle('hidden');
        } else if (e.key === 'b' || e.key === 'B') {
          const cardId = ankiState.currentQueue[ankiState.queueIndex];
          if (cardId) toggleBookmarkById(cardId);
        }
      }
    });

    // Initialize Question Picker Events
    setupQuestionPickerEvents();
  }

  // --- Question Picker (문제 바로가기 및 선택 창) Logic ---
  const pickerState = {
    statusFilter: 'all', // 'all' | 'unsolved' | 'correct' | 'wrong' | 'bookmarked'
    searchQuery: '',
    rangeIndex: 0,
    viewMode: 'grid', // 'grid' | 'list'
    chunkSize: 50
  };

  function openQuestionPicker() {
    if (!currentQuestions || currentQuestions.length === 0) {
      showToast('⚠️ 선택할 수 있는 문제가 없습니다.');
      return;
    }

    const modal = document.getElementById('modal-question-picker');
    if (!modal) return;

    // Set level badge
    const badge = document.getElementById('picker-level-badge');
    if (badge) {
      badge.textContent = `${state.level} (${state.type === 'ALL' ? '전체' : state.type}) 총 ${currentQuestions.length.toLocaleString()}문항`;
    }

    // Determine current range
    pickerState.rangeIndex = Math.floor(state.currentIndex / pickerState.chunkSize);
    pickerState.searchQuery = '';
    pickerState.statusFilter = 'all';

    const searchInput = document.getElementById('picker-search-input');
    if (searchInput) searchInput.value = '';

    const jumpInput = document.getElementById('picker-jump-input');
    if (jumpInput) {
      jumpInput.value = state.currentIndex + 1;
      jumpInput.max = currentQuestions.length;
    }

    // Populate Range Select Dropdown
    updatePickerRangeSelect();

    // Update Counts on Filter Chips
    updatePickerFilterCounts();

    // Reset status filter chips active UI
    document.querySelectorAll('#picker-status-chips .chip-sm').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === 'all');
    });

    renderPickerItems();

    modal.classList.remove('hidden');

    // Focus jump input for instant typing
    setTimeout(() => {
      if (jumpInput) {
        jumpInput.focus();
        jumpInput.select();
      }
    }, 100);
  }

  function closeQuestionPicker() {
    const modal = document.getElementById('modal-question-picker');
    if (modal) modal.classList.add('hidden');
  }

  function updatePickerRangeSelect() {
    const select = document.getElementById('picker-range-select');
    if (!select) return;

    const total = currentQuestions.length;
    const chunk = pickerState.chunkSize;
    const numChunks = Math.ceil(total / chunk);

    let html = '';
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunk + 1;
      const end = Math.min((i + 1) * chunk, total);
      html += `<option value="${i}">#${start} ~ #${end}번 (${end - start + 1}문항)</option>`;
    }
    select.innerHTML = html;
    select.value = pickerState.rangeIndex;
  }

  function updatePickerFilterCounts() {
    let countUnsolved = 0;
    let countCorrect = 0;
    let countWrong = 0;
    let countBookmarked = 0;

    currentQuestions.forEach(q => {
      const h = history[q.id];
      const m = mistakes[q.id];
      const isSolved = h && (h.solved || 0) > 0;
      if (!isSolved) countUnsolved++;
      if (h && (h.correct || 0) > 0) countCorrect++;
      if ((m && !m.isMastered) || (h && (h.wrong || 0) > 0)) countWrong++;
      if (bookmarks.has(q.id)) countBookmarked++;
    });

    const elAll = document.getElementById('cnt-picker-all');
    const elUnsolved = document.getElementById('cnt-picker-unsolved');
    const elCorrect = document.getElementById('cnt-picker-correct');
    const elWrong = document.getElementById('cnt-picker-wrong');
    const elBm = document.getElementById('cnt-picker-bookmarked');

    if (elAll) elAll.textContent = currentQuestions.length.toLocaleString();
    if (elUnsolved) elUnsolved.textContent = countUnsolved.toLocaleString();
    if (elCorrect) elCorrect.textContent = countCorrect.toLocaleString();
    if (elWrong) elWrong.textContent = countWrong.toLocaleString();
    if (elBm) elBm.textContent = countBookmarked.toLocaleString();
  }

  function renderPickerItems() {
    const gridContainer = document.getElementById('picker-grid');
    const listContainer = document.getElementById('picker-list');
    const emptyState = document.getElementById('picker-empty-state');
    if (!gridContainer || !listContainer) return;

    const query = pickerState.searchQuery.trim().toLowerCase();
    const filter = pickerState.statusFilter;
    const chunk = pickerState.chunkSize;
    const rangeStart = pickerState.rangeIndex * chunk;
    const rangeEnd = (pickerState.rangeIndex + 1) * chunk;

    // Filter questions
    const filtered = [];
    currentQuestions.forEach((q, idx) => {
      // 1. Status Filter Check
      const h = history[q.id];
      const m = mistakes[q.id];
      const isSolved = h && (h.solved || 0) > 0;
      const isCorrect = h && (h.correct || 0) > 0;
      const isWrong = (m && !m.isMastered) || (h && (h.wrong || 0) > 0);
      const isBm = bookmarks.has(q.id);

      if (filter === 'unsolved' && isSolved) return;
      if (filter === 'correct' && !isCorrect) return;
      if (filter === 'wrong' && !isWrong) return;
      if (filter === 'bookmarked' && !isBm) return;

      // 2. Search Query Check
      if (query) {
        const plain = (q.qPlain || '').toLowerCase();
        const type = (q.typeName || '').toLowerCase();
        const trans = (q.qTrans || '').toLowerCase();
        const numMatch = (idx + 1).toString() === query || ('#' + (idx + 1)) === query;
        if (!plain.includes(query) && !type.includes(query) && !trans.includes(query) && !numMatch) {
          return;
        }
      } else {
        // If no search query and status is 'all', restrict to selected range chunk
        if (filter === 'all' && (idx < rangeStart || idx >= rangeEnd)) {
          return;
        }
      }

      filtered.push({
        q,
        originalIndex: idx,
        isCurrent: idx === state.currentIndex,
        isCorrect,
        isWrong,
        isBm
      });
    });

    if (filtered.length === 0) {
      gridContainer.innerHTML = '';
      listContainer.innerHTML = '';
      gridContainer.classList.add('hidden');
      listContainer.classList.add('hidden');
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    if (pickerState.viewMode === 'grid') {
      gridContainer.classList.remove('hidden');
      listContainer.classList.add('hidden');

      let gridHtml = '';
      filtered.forEach(item => {
        let cls = 'picker-num-btn';
        if (item.isCurrent) cls += ' current';
        else if (item.isWrong) cls += ' wrong';
        else if (item.isCorrect) cls += ' correct';

        const star = item.isBm ? '<span class="star-mark">★</span>' : '';
        gridHtml += `
          <button class="${cls}" data-idx="${item.originalIndex}" title="#${item.originalIndex + 1}번 문제로 이동">
            ${star}
            <span>${item.originalIndex + 1}</span>
          </button>
        `;
      });
      gridContainer.innerHTML = gridHtml;

      gridContainer.querySelectorAll('.picker-num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          selectQuestionFromPicker(idx);
        });
      });
    } else {
      gridContainer.classList.add('hidden');
      listContainer.classList.remove('hidden');

      let listHtml = '';
      filtered.forEach(item => {
        let statusTag = '';
        if (item.isCurrent) statusTag = '<span style="color:#2563eb; font-weight:800;">현재 문제</span>';
        else if (item.isWrong) statusTag = '<span style="color:#dc2626; font-weight:700;">오답</span>';
        else if (item.isCorrect) statusTag = '<span style="color:#059669; font-weight:700;">정답 ✓</span>';
        else statusTag = '<span style="color:var(--text-muted);">미풀이</span>';

        const star = item.isBm ? '<span style="color:#f59e0b; margin-right:4px;">★</span>' : '';
        const preview = (item.q.qPlain || '').replace(/[\r\n]+/g, ' ');

        listHtml += `
          <div class="picker-list-item ${item.isCurrent ? 'current' : ''}" data-idx="${item.originalIndex}">
            <div class="picker-list-left">
              <span class="picker-list-num">#${item.originalIndex + 1}</span>
              <span class="picker-list-type">${item.q.typeName || '문제'}</span>
              <span class="picker-list-text">${star}${preview}</span>
            </div>
            <div class="picker-list-status">
              ${statusTag}
            </div>
          </div>
        `;
      });
      listContainer.innerHTML = listHtml;

      listContainer.querySelectorAll('.picker-list-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.dataset.idx, 10);
          selectQuestionFromPicker(idx);
        });
      });
    }
  }

  function selectQuestionFromPicker(index) {
    if (index < 0 || index >= currentQuestions.length) return;

    state.currentIndex = index;
    state.levelIndices[state.level] = index;
    state.answered = false;
    state.selectedOption = null;

    saveState();
    renderCurrentQuestion();
    closeQuestionPicker();

    showToast(`📌 #${index + 1}번 문제로 이동했습니다.`);
  }

  function setupQuestionPickerEvents() {
    // Open Trigger 1: #btn-open-picker
    const btnOpen = document.getElementById('btn-open-picker');
    if (btnOpen) {
      btnOpen.addEventListener('click', openQuestionPicker);
    }

    // Open Trigger 2: #q-index-indicator click
    const indicator = document.getElementById('q-index-indicator');
    if (indicator) {
      indicator.addEventListener('click', openQuestionPicker);
    }

    // Close buttons
    const btnClose = document.getElementById('btn-close-picker');
    if (btnClose) btnClose.addEventListener('click', closeQuestionPicker);

    const btnCloseFooter = document.getElementById('btn-close-picker-footer');
    if (btnCloseFooter) btnCloseFooter.addEventListener('click', closeQuestionPicker);

    // Overlay click to close
    const modal = document.getElementById('modal-question-picker');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeQuestionPicker();
      });
    }

    // Jump by number form
    const jumpInput = document.getElementById('picker-jump-input');
    const btnJump = document.getElementById('btn-picker-jump');
    const handleJump = () => {
      const val = parseInt(jumpInput.value, 10);
      if (isNaN(val) || val < 1 || val > currentQuestions.length) {
        showToast(`⚠️ 1부터 ${currentQuestions.length.toLocaleString()} 사이의 번호를 입력해주세요.`);
        if (jumpInput) jumpInput.focus();
        return;
      }
      selectQuestionFromPicker(val - 1);
    };

    if (btnJump) btnJump.addEventListener('click', handleJump);
    if (jumpInput) {
      jumpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleJump();
        }
      });
    }

    // Search input
    const searchInput = document.getElementById('picker-search-input');
    if (searchInput) {
      let debounceTimer = null;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          pickerState.searchQuery = e.target.value;
          renderPickerItems();
        }, 150);
      });
    }

    // Status filter chips
    document.querySelectorAll('#picker-status-chips .chip-sm').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#picker-status-chips .chip-sm').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        pickerState.statusFilter = chip.dataset.filter;
        renderPickerItems();
      });
    });

    // Range selector change
    const rangeSelect = document.getElementById('picker-range-select');
    if (rangeSelect) {
      rangeSelect.addEventListener('change', (e) => {
        pickerState.rangeIndex = parseInt(e.target.value, 10);
        renderPickerItems();
      });
    }

    // View toggle buttons (Grid / List)
    const btnGrid = document.getElementById('btn-picker-view-grid');
    const btnList = document.getElementById('btn-picker-view-list');
    if (btnGrid && btnList) {
      btnGrid.addEventListener('click', () => {
        pickerState.viewMode = 'grid';
        btnGrid.classList.add('active');
        btnList.classList.remove('active');
        renderPickerItems();
      });
      btnList.addEventListener('click', () => {
        pickerState.viewMode = 'list';
        btnList.classList.add('active');
        btnGrid.classList.remove('active');
        renderPickerItems();
      });
    }
  }

  function mergeExternalData(cloudData) {
    if (!cloudData) return;
    let changed = false;

    if (cloudData.history) {
      for (const [id, h] of Object.entries(cloudData.history)) {
        if (!history[id]) {
          history[id] = { ...h };
          changed = true;
        } else {
          const cloudSolved = h.solved || 0;
          const localSolved = history[id].solved || 0;
          const cloudCorrect = h.correct || 0;
          const localCorrect = history[id].correct || 0;
          if (cloudSolved > localSolved || cloudCorrect > localCorrect || (h.lastDate || 0) > (history[id].lastDate || 0)) {
            history[id] = {
              solved: Math.max(localSolved, cloudSolved),
              correct: Math.max(localCorrect, cloudCorrect),
              lastResult: (h.lastDate || 0) >= (history[id].lastDate || 0) ? h.lastResult : history[id].lastResult,
              lastDate: Math.max(h.lastDate || 0, history[id].lastDate || 0)
            };
            changed = true;
          }
        }
      }
    }

    if (cloudData.mistakes) {
      for (const [id, m] of Object.entries(cloudData.mistakes)) {
        if (!mistakes[id]) {
          mistakes[id] = { ...m };
          changed = true;
        } else {
          const cloudCount = m.count || 1;
          const localCount = mistakes[id].count || 1;
          if (cloudCount >= localCount || (m.lastWrongDate || 0) > (mistakes[id].lastWrongDate || 0)) {
            mistakes[id] = { ...m };
            changed = true;
          }
        }
      }
    }

    if (cloudData.bookmarks && Array.isArray(cloudData.bookmarks)) {
      cloudData.bookmarks.forEach(b => {
        if (!bookmarks.has(b)) {
          bookmarks.add(b);
          changed = true;
        }
      });
    }

    if (cloudData.srs) {
      for (const [id, s] of Object.entries(cloudData.srs)) {
        if (!srs[id] || (s.lastReviewed || 0) > (srs[id].lastReviewed || 0)) {
          srs[id] = { ...s };
          changed = true;
        }
      }
    }

    if (changed) {
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
      localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
      localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(Array.from(bookmarks)));
      localStorage.setItem(STORAGE_KEYS.SRS, JSON.stringify(srs));
      updateMistakeBadge();
      updateAnkiBadge();
      if (state.currentTab === 'mistakes') {
        renderMistakesList();
      }
      if (state.currentTab === 'anki') {
        renderAnkiSession();
      }
      renderCurrentQuestion();
    }
    renderStats();
  }

  // Expose global app object for inline handlers
  window.app = {
    init,
    switchTab,
    nextQuestion,
    prevQuestion,
    handleOptionSelect,
    mergeExternalData,
    startAnkiSingleCard: (id) => {
      ankiState.currentQueue = [id];
      ankiState.queueIndex = 0;
      switchTab('anki');
    },
    resetAnkiCard: (id) => {
      if (srs[id]) {
        srs[id].repetitions = 0;
        srs[id].interval = 1;
        srs[id].dueDate = Date.now();
        srs[id].state = 'learning';
        saveSrs();
        renderAnkiSchedule();
        showToast('간격이 1일(내일 복습)로 초기화되었습니다.');
      }
    },
    getAppData: () => ({
      mistakes,
      history,
      bookmarks: Array.from(bookmarks),
      srs,
      clientTimestamp: Date.now()
    }),
    renderStats
  };

  // Launch when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
