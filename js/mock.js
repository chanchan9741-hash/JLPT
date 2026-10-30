/**
 * JLPT MASTER - Mock Exam (JLPT 模擬試験) Engine & UI Module
 * Comprehensive JLPT Mock Exam combining Vocabulary, Grammar, and Reading Comprehension
 */

(function () {
  'use strict';

  const STORAGE_KEYS = {
    MOCK_HISTORY: 'jlpt_mock_history_v1',
    MOCK_STATE: 'jlpt_mock_state_v1',
    MISTAKES: 'jlpt_mistakes_v1',
    SRS: 'jlpt_srs_v1'
  };

  // State
  let mState = {
    view: 'lobby', // 'lobby' | 'exam' | 'result'
    level: 'N2',   // 'N1' | 'N2' | 'N3' | 'N4' | 'N5'
    mode: 'full',  // 'full' | 'mini' | 'custom'
    customConfig: {
      includeVocab: true,
      includeGrammar: true,
      includeReading: true,
      qCount: 30,
      timeLimitMinutes: 45,
      showRuby: true
    },
    currentQuestions: [],
    currentIndex: 0,
    userAnswers: {},     // { [mockQNum]: { selectedIndex: number, answeredAt: number } }
    flaggedQuestions: new Set(), // Set of mockQNum
    timer: {
      totalSeconds: 3600,
      remainingSeconds: 3600,
      intervalId: null,
      isPaused: false
    },
    startTime: 0,
    endTime: 0,
    lastResult: null,
    reviewFilter: 'all', // 'all' | 'wrong' | 'flagged'
    history: []
  };

  // Helper: Ruby formatting
  function formatRuby(text) {
    if (!text) return '';
    if (text.includes('<ruby>') || text.includes('<rt>')) return text;
    return text.replace(/([\u4E00-\u9FAF\u3400-\u4DBF々ヶ]+)[(（]([\u3040-\u309F\u30A0-\u30FF]+)[)）]/g, 
      (match, kanji, ruby) => '<ruby>' + kanji + '<rt>' + ruby + '</rt></ruby>');
  }

  function removeRuby(text) {
    if (!text) return '';
    return text.replace(/[(（][\u3040-\u309F\u30A0-\u30FF]+[)）]/g, '');
  }

  function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Load Saved History
  function loadHistory() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.MOCK_HISTORY);
      if (saved) {
        mState.history = JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load mock history:', e);
      mState.history = [];
    }
  }

  function saveHistory() {
    try {
      // Keep up to 20 records
      const trimmed = mState.history.slice(0, 20);
      localStorage.setItem(STORAGE_KEYS.MOCK_HISTORY, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('Failed to save mock history:', e);
    }
  }

  // --- Mock Exam Question Generator ---
  function generateMockExam(level, mode, customConfig) {
    const vocabData = (window.JLPT_DATA && window.JLPT_DATA[level]) ? window.JLPT_DATA[level] : [];
    const grammarData = (window.JLPT_GRAMMAR_DATA || []).filter(g => g.level === level);
    
    // Fallback if grammar data has no items for specific level
    const availGrammar = grammarData.length > 0 ? grammarData : (window.JLPT_GRAMMAR_DATA || []);
    
    // Reading data
    let readingData = (window.JLPT_READING_DATA || []).filter(r => r.level === level);
    if (readingData.length === 0) {
      readingData = window.JLPT_READING_DATA || [];
    }

    let targetVocabCount = 0;
    let targetGrammarCount = 0;
    let targetReadingPassages = 0;
    let timeLimitMinutes = 60;

    if (mode === 'full') {
      if (level === 'N1' || level === 'N2') {
        targetVocabCount = 20;
        targetGrammarCount = 15;
        targetReadingPassages = 2; // ~5-7 sub questions
        timeLimitMinutes = 60;
      } else if (level === 'N3') {
        targetVocabCount = 16;
        targetGrammarCount = 12;
        targetReadingPassages = 2;
        timeLimitMinutes = 50;
      } else { // N4, N5
        targetVocabCount = 14;
        targetGrammarCount = 10;
        targetReadingPassages = 1;
        timeLimitMinutes = 40;
      }
    } else if (mode === 'mini') {
      targetVocabCount = 10;
      targetGrammarCount = 7;
      targetReadingPassages = 1;
      timeLimitMinutes = 25;
    } else if (mode === 'custom') {
      const cfg = customConfig || mState.customConfig;
      timeLimitMinutes = cfg.timeLimitMinutes || 45;
      const total = cfg.qCount || 30;

      const activeTypes = [];
      if (cfg.includeVocab) activeTypes.push('vocab');
      if (cfg.includeGrammar) activeTypes.push('grammar');
      if (cfg.includeReading) activeTypes.push('reading');

      if (activeTypes.length === 0) {
        activeTypes.push('vocab', 'grammar');
      }

      const countPerType = Math.floor(total / activeTypes.length);
      if (cfg.includeVocab) targetVocabCount = countPerType;
      if (cfg.includeGrammar) targetGrammarCount = countPerType;
      if (cfg.includeReading) {
        targetReadingPassages = Math.max(1, Math.floor(countPerType / 3));
      }
    }

    // 1. Pick Vocab Questions
    const shuffledVocab = shuffle(vocabData).slice(0, targetVocabCount);

    // 2. Pick Grammar Questions
    const shuffledGrammar = shuffle(availGrammar).slice(0, targetGrammarCount);

    // 3. Pick Reading Passages
    const shuffledReading = shuffle(readingData).slice(0, targetReadingPassages);

    // Assemble Unified Questions Array
    const unified = [];
    let qNumber = 1;

    // A. Add Vocab
    shuffledVocab.forEach(v => {
      const correctIdx = v.options.findIndex(o => o.isCorrect);
      unified.push({
        mockQNum: qNumber++,
        section: 'vocab',
        sectionName: '문자·어휘 (文字・語彙)',
        typeName: v.typeName || '문맥 규정',
        id: v.id,
        level: v.level || level,
        instruction: v.instruction || '빈칸에 들어갈 가장 알맞은 표현을 고르세요.',
        instructionTrans: '',
        passage: null,
        qPlain: v.qPlain,
        qRuby: v.qRuby || v.qPlain,
        qTrans: v.qTrans || '',
        options: v.options.map((opt, idx) => ({
          marker: opt.marker || ['①', '②', '③', '④'][idx],
          text: opt.copy || opt.copyNoRuby || opt.text,
          textNoRuby: opt.copyNoRuby || removeRuby(opt.copy || opt.text),
          trans: opt.trans || '',
          isCorrect: !!opt.isCorrect,
          note: (v.expl && v.expl.choices && v.expl.choices[idx]) ? v.expl.choices[idx].note : ''
        })),
        correctIndex: correctIdx >= 0 ? correctIdx : 0,
        ansJa: v.ansJa || '',
        ansKo: v.ansKo || '',
        expl: v.expl || {},
        rawItem: v
      });
    });

    // B. Add Grammar
    shuffledGrammar.forEach(g => {
      const correctIdx = g.options.findIndex(o => o.isCorrect);
      unified.push({
        mockQNum: qNumber++,
        section: 'grammar',
        sectionName: '문법 (文法)',
        typeName: '문법 형식 판단',
        id: g.id,
        level: g.level || level,
        instruction: g.instruction || '빈칸에 들어갈 가장 알맞은 문법 표현을 고르세요.',
        instructionTrans: '',
        passage: null,
        qPlain: g.qPlain,
        qRuby: g.qRuby || g.qPlain,
        qTrans: g.qTrans || '',
        options: g.options.map((opt, idx) => ({
          marker: opt.marker || ['①', '②', '③', '④'][idx],
          text: opt.copy || opt.copyNoRuby || opt.text,
          textNoRuby: opt.copyNoRuby || removeRuby(opt.copy || opt.text),
          trans: opt.trans || '',
          isCorrect: !!opt.isCorrect,
          note: opt.note || ((g.expl && g.expl.choices && g.expl.choices[idx]) ? g.expl.choices[idx].note : '')
        })),
        correctIndex: correctIdx >= 0 ? correctIdx : 0,
        ansJa: g.ansJa || '',
        ansKo: g.ansKo || '',
        expl: g.expl || {},
        rawItem: g
      });
    });

    // C. Add Reading
    shuffledReading.forEach(r => {
      const subQuestions = r.questions || [];
      subQuestions.forEach(sq => {
        const correctIdx = sq.options.findIndex(o => o.isCorrect);
        unified.push({
          mockQNum: qNumber++,
          section: 'reading',
          sectionName: '독해 (読解)',
          typeName: r.typeName || '독해 지문',
          id: sq.qId || `${r.id}-Q${sq.qNum}`,
          level: r.level || level,
          instruction: sq.instruction || '지문을 읽고 질문에 가장 알맞은 답을 고르세요.',
          instructionTrans: sq.instructionTrans || '',
          passage: {
            title: r.title || '독해 본문',
            passageRuby: r.passageRuby || r.passagePlain,
            passagePlain: r.passagePlain,
            passageTrans: r.passageTrans || '',
            vocabList: r.vocabList || []
          },
          qPlain: sq.instruction,
          qRuby: sq.instruction,
          qTrans: sq.instructionTrans || '',
          options: sq.options.map((opt, idx) => ({
            marker: opt.marker || ['①', '②', '③', '④'][idx],
            text: opt.text || opt.copy,
            textNoRuby: removeRuby(opt.text || opt.copy),
            trans: opt.trans || '',
            isCorrect: !!opt.isCorrect,
            note: opt.note || ''
          })),
          correctIndex: correctIdx >= 0 ? correctIdx : 0,
          ansJa: '',
          ansKo: sq.ansKo || '',
          expl: sq.expl || (r.expl || {}),
          rawItem: { ...r, ...sq }
        });
      });
    });

    return {
      questions: unified,
      timeLimitMinutes: timeLimitMinutes
    };
  }

  // --- Render Router ---
  function render() {
    const container = document.getElementById('view-mock');
    if (!container) return;

    if (mState.view === 'lobby') {
      renderLobby(container);
    } else if (mState.view === 'exam') {
      renderExam(container);
    } else if (mState.view === 'result') {
      renderResult(container);
    }
  }

  // =========================================================================
  // 1. LOBBY VIEW
  // =========================================================================
  function renderLobby(container) {
    loadHistory();

    // Calculate quick counts
    const curLevel = mState.level;
    const vocabCount = (window.JLPT_DATA && window.JLPT_DATA[curLevel]) ? window.JLPT_DATA[curLevel].length : 0;
    const grammarCount = (window.JLPT_GRAMMAR_DATA || []).filter(g => g.level === curLevel).length;
    const readingCount = (window.JLPT_READING_DATA || []).filter(r => r.level === curLevel).length;

    const recentRecords = mState.history.slice(0, 5);

    container.innerHTML = `
      <div class="mock-container mock-lobby-view">
        <!-- Hero Card -->
        <div class="mock-hero-card">
          <div class="mock-hero-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span>JLPT 실전 모의고사 시스템</span>
          </div>
          <h1 class="mock-hero-title">실제 시험처럼 완벽하게 치르는 <span class="gradient-text">JLPT 모의시험</span></h1>
          <p class="mock-hero-desc">
            문자·어휘, 문법, 독해 문제를 실전 비율로 균형 있게 자동 조합하여, 실시간 타이머와 OMR 마킹 시트로 실제 시험장과 동일한 환경을 제공합니다.
          </p>

          <div class="mock-stats-quick-bar">
            <div class="mock-quick-stat-item">
              <div class="mock-quick-stat-icon">📝</div>
              <div class="mock-quick-stat-content">
                <span class="mock-quick-stat-label">${curLevel} 언어지식(어휘)</span>
                <span class="mock-quick-stat-value">${vocabCount.toLocaleString()}문항</span>
              </div>
            </div>
            <div class="mock-quick-stat-item">
              <div class="mock-quick-stat-icon">📖</div>
              <div class="mock-quick-stat-content">
                <span class="mock-quick-stat-label">${curLevel} 문법 데이터</span>
                <span class="mock-quick-stat-value">${grammarCount.toLocaleString()}문항</span>
              </div>
            </div>
            <div class="mock-quick-stat-item">
              <div class="mock-quick-stat-icon">📑</div>
              <div class="mock-quick-stat-content">
                <span class="mock-quick-stat-label">${curLevel} 독해 지문</span>
                <span class="mock-quick-stat-value">${readingCount}지문</span>
              </div>
            </div>
            <div class="mock-quick-stat-item">
              <div class="mock-quick-stat-icon">🏆</div>
              <div class="mock-quick-stat-content">
                <span class="mock-quick-stat-label">누적 응시 횟수</span>
                <span class="mock-quick-stat-value">${mState.history.length}회</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Setup Card -->
        <div class="mock-setup-card">
          <div class="mock-section-title">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>모의고사 시험 설정</span>
          </div>

          <!-- 1. Level Selection -->
          <div class="mock-form-group">
            <label class="mock-form-label">① 응시 급수 선택</label>
            <div class="mock-level-grid">
              ${['N1', 'N2', 'N3', 'N4', 'N5'].map(lvl => `
                <button class="mock-level-btn ${lvl === mState.level ? 'active' : ''}" data-level="${lvl}">
                  <span class="level-tag">${lvl}</span>
                  <span class="level-sub">${lvl === 'N1' ? '최고급' : lvl === 'N2' ? '실전상급' : lvl === 'N3' ? '중급실전' : lvl === 'N4' ? '초중급' : '기초입문'}</span>
                </button>
              `).join('')}
            </div>
          </div>

          <!-- 2. Exam Mode Selection -->
          <div class="mock-form-group">
            <label class="mock-form-label">② 모의시험 유형 선택</label>
            <div class="mock-modes-grid">
              <!-- Full Mock -->
              <div class="mock-mode-card ${mState.mode === 'full' ? 'active' : ''}" data-mode="full">
                <div class="mock-mode-header">
                  <span class="mock-mode-icon">🏆</span>
                  <span class="mock-mode-badge">실전 표준 추천</span>
                </div>
                <div class="mock-mode-title">실전 정규 모의고사</div>
                <div class="mock-mode-desc">
                  실제 JLPT와 가장 유사한 구성! 문자·어휘, 문법, 독해를 표준 비율로 균형 있게 출제하여 실전 감각을 끌어올립니다.
                </div>
                <div class="mock-mode-meta">
                  <span>⏱️ 50~60분 제한</span>
                  <span>📄 약 35~45문항</span>
                </div>
              </div>

              <!-- Mini Mock -->
              <div class="mock-mode-card ${mState.mode === 'mini' ? 'active' : ''}" data-mode="mini">
                <div class="mock-mode-header">
                  <span class="mock-mode-icon">⚡</span>
                  <span class="mock-mode-badge">단기 집중</span>
                </div>
                <div class="mock-mode-title">스피드 미니 모의고사</div>
                <div class="mock-mode-desc">
                  자투리 시간이나 집중 훈련에 최적화! 핵심 20문항(어휘 10 + 문법 7 + 독해 1지문 3문제)을 빠르게 테스트합니다.
                </div>
                <div class="mock-mode-meta">
                  <span>⏱️ 25분 제한</span>
                  <span>📄 20문항</span>
                </div>
              </div>

              <!-- Custom Mock -->
              <div class="mock-mode-card ${mState.mode === 'custom' ? 'active' : ''}" data-mode="custom">
                <div class="mock-mode-header">
                  <span class="mock-mode-icon">🛠️</span>
                  <span class="mock-mode-badge">자유 맞춤</span>
                </div>
                <div class="mock-mode-title">맞춤 커스텀 모의고사</div>
                <div class="mock-mode-desc">
                  내가 원하는 영역(어휘, 문법, 독해)만 쏙 골라서 문항 수와 제한 시간을 직접 세밀하게 설정하여 시험을 치릅니다.
                </div>
                <div class="mock-mode-meta">
                  <span>⏱️ 직접 지정</span>
                  <span>📄 10~50문항</span>
                </div>
              </div>
            </div>

            <!-- Custom Options Expandable -->
            <div class="mock-custom-options ${mState.mode === 'custom' ? '' : 'hidden'}" id="mock-custom-panel">
              <div class="mock-custom-grid">
                <div>
                  <label class="mock-form-label" style="font-size:0.85rem;">출제 영역 선택</label>
                  <div class="mock-checkbox-group">
                    <label class="mock-checkbox-item">
                      <input type="checkbox" id="cfg-include-vocab" ${mState.customConfig.includeVocab ? 'checked' : ''}>
                      <span>문자·어휘 (文字・語彙)</span>
                    </label>
                    <label class="mock-checkbox-item">
                      <input type="checkbox" id="cfg-include-grammar" ${mState.customConfig.includeGrammar ? 'checked' : ''}>
                      <span>문법 (文法)</span>
                    </label>
                    <label class="mock-checkbox-item">
                      <input type="checkbox" id="cfg-include-reading" ${mState.customConfig.includeReading ? 'checked' : ''}>
                      <span>독해 (読解)</span>
                    </label>
                  </div>
                </div>

                <div>
                  <label class="mock-form-label" style="font-size:0.85rem;">출제 문항 수</label>
                  <select class="mock-select" id="cfg-qcount">
                    <option value="15" ${mState.customConfig.qCount === 15 ? 'selected' : ''}>15문항</option>
                    <option value="20" ${mState.customConfig.qCount === 20 ? 'selected' : ''}>20문항</option>
                    <option value="30" ${mState.customConfig.qCount === 30 ? 'selected' : ''}>30문항 (추천)</option>
                    <option value="40" ${mState.customConfig.qCount === 40 ? 'selected' : ''}>40문항</option>
                    <option value="50" ${mState.customConfig.qCount === 50 ? 'selected' : ''}>50문항</option>
                  </select>
                </div>

                <div>
                  <label class="mock-form-label" style="font-size:0.85rem;">제한 시간</label>
                  <select class="mock-select" id="cfg-timelimit">
                    <option value="15" ${mState.customConfig.timeLimitMinutes === 15 ? 'selected' : ''}>15분</option>
                    <option value="25" ${mState.customConfig.timeLimitMinutes === 25 ? 'selected' : ''}>25분</option>
                    <option value="35" ${mState.customConfig.timeLimitMinutes === 35 ? 'selected' : ''}>35분</option>
                    <option value="45" ${mState.customConfig.timeLimitMinutes === 45 ? 'selected' : ''}>45분 (추천)</option>
                    <option value="60" ${mState.customConfig.timeLimitMinutes === 60 ? 'selected' : ''}>60분</option>
                    <option value="90" ${mState.customConfig.timeLimitMinutes === 90 ? 'selected' : ''}>90분</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <!-- Start CTA Button -->
          <div class="mock-start-actions">
            <div class="mock-start-info">
              <span>준비 급수: <b>${mState.level}</b></span>
              <span>•</span>
              <span>유형: <b>${mState.mode === 'full' ? '실전 정규 모의고사' : mState.mode === 'mini' ? '스피드 미니' : '맞춤 커스텀'}</b></span>
              <span>•</span>
              <span id="start-time-info">예상 시간: <b>${mState.mode === 'full' ? (mState.level === 'N1' || mState.level === 'N2' ? '60분' : '50분') : mState.mode === 'mini' ? '25분' : mState.customConfig.timeLimitMinutes + '분'}</b></span>
            </div>

            <button class="btn-start-exam" id="btn-start-mock-exam">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>모의고사 시작하기</span>
            </button>
          </div>
        </div>

        <!-- History Card -->
        <div class="mock-history-card">
          <div class="mock-history-header">
            <div class="mock-section-title" style="margin-bottom:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>최근 모의고사 응시 기록 (${mState.history.length})</span>
            </div>
            ${mState.history.length > 0 ? `
              <button class="btn btn-secondary btn-sm" id="btn-clear-mock-history" style="font-size:0.78rem;">기록 비우기</button>
            ` : ''}
          </div>

          ${recentRecords.length === 0 ? `
            <div style="text-align:center; padding:2.5rem 1rem; color:var(--text-muted); font-size:0.95rem;">
              아직 치른 모의고사가 없습니다. 위의 <b>[모의고사 시작하기]</b> 버튼을 눌러 첫 시험을 치러보세요!
            </div>
          ` : `
            <div class="mock-history-list">
              ${recentRecords.map((rec, idx) => `
                <div class="mock-history-item">
                  <div class="mock-history-left">
                    <span class="mock-history-badge ${rec.isPass ? 'pass' : 'fail'}">
                      ${rec.isPass ? '합격 (合格)' : '불합격'}
                    </span>
                    <div class="mock-history-meta">
                      <span class="mock-history-name">${rec.level} ${rec.modeName} (${rec.score}/${rec.totalQuestions}문항 정답)</span>
                      <span class="mock-history-date">${new Date(rec.date).toLocaleDateString()} ${new Date(rec.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • 소요 시간 ${rec.durationText}</span>
                    </div>
                  </div>
                  <div class="mock-history-right">
                    <div class="mock-history-score">
                      ${rec.jlptScore}<span> / 180점</span>
                    </div>
                    <button class="btn btn-secondary btn-sm btn-re-view-record" data-index="${idx}" style="font-size:0.8rem; font-weight:700;">
                      성적표 보기
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;

    bindLobbyEvents(container);
  }

  function bindLobbyEvents(container) {
    // Level Switch
    container.querySelectorAll('.mock-level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        mState.level = btn.dataset.level;
        renderLobby(container);
      });
    });

    // Mode Switch
    container.querySelectorAll('.mock-mode-card').forEach(card => {
      card.addEventListener('click', () => {
        mState.mode = card.dataset.mode;
        renderLobby(container);
      });
    });

    // Custom Checkboxes & Selects
    const chkVocab = container.querySelector('#cfg-include-vocab');
    const chkGrammar = container.querySelector('#cfg-include-grammar');
    const chkReading = container.querySelector('#cfg-include-reading');
    const selQCount = container.querySelector('#cfg-qcount');
    const selTimeLimit = container.querySelector('#cfg-timelimit');

    if (chkVocab) chkVocab.addEventListener('change', (e) => mState.customConfig.includeVocab = e.target.checked);
    if (chkGrammar) chkGrammar.addEventListener('change', (e) => mState.customConfig.includeGrammar = e.target.checked);
    if (chkReading) chkReading.addEventListener('change', (e) => mState.customConfig.includeReading = e.target.checked);
    if (selQCount) selQCount.addEventListener('change', (e) => mState.customConfig.qCount = parseInt(e.target.value, 10));
    if (selTimeLimit) selTimeLimit.addEventListener('change', (e) => mState.customConfig.timeLimitMinutes = parseInt(e.target.value, 10));

    // Clear History
    const btnClear = container.querySelector('#btn-clear-mock-history');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        if (confirm('모의고사 응시 기록을 모두 삭제하시겠습니까?')) {
          mState.history = [];
          saveHistory();
          renderLobby(container);
        }
      });
    }

    // View Past Record
    container.querySelectorAll('.btn-re-view-record').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        if (mState.history[idx]) {
          mState.lastResult = mState.history[idx];
          mState.view = 'result';
          render();
        }
      });
    });

    // Start Exam Button
    const btnStart = container.querySelector('#btn-start-mock-exam');
    if (btnStart) {
      btnStart.addEventListener('click', () => {
        startExam();
      });
    }
  }

  // =========================================================================
  // 2. START & MANAGE EXAM
  // =========================================================================
  function startExam() {
    const examPackage = generateMockExam(mState.level, mState.mode, mState.customConfig);
    if (!examPackage.questions || examPackage.questions.length === 0) {
      alert('해당 급수의 문제 데이터를 불러올 수 없습니다.');
      return;
    }

    mState.currentQuestions = examPackage.questions;
    mState.currentIndex = 0;
    mState.userAnswers = {};
    mState.flaggedQuestions = new Set();
    mState.startTime = Date.now();
    mState.endTime = 0;

    // Setup Timer
    const totalSecs = examPackage.timeLimitMinutes * 60;
    mState.timer.totalSeconds = totalSecs;
    mState.timer.remainingSeconds = totalSecs;
    mState.timer.isPaused = false;

    if (mState.timer.intervalId) {
      clearInterval(mState.timer.intervalId);
    }

    mState.timer.intervalId = setInterval(() => {
      if (!mState.timer.isPaused && mState.view === 'exam') {
        mState.timer.remainingSeconds--;
        updateTimerDisplay();

        if (mState.timer.remainingSeconds <= 0) {
          clearInterval(mState.timer.intervalId);
          alert('⏰ 시험 제한 시간이 종료되었습니다! 자동으로 채점합니다.');
          finishExam();
        }
      }
    }, 1000);

    mState.view = 'exam';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function updateTimerDisplay() {
    const timerEl = document.getElementById('mock-timer-text');
    if (timerEl) {
      timerEl.textContent = formatTime(mState.timer.remainingSeconds);
      if (mState.timer.remainingSeconds <= 300) {
        timerEl.parentElement.classList.add('urgent');
      } else {
        timerEl.parentElement.classList.remove('urgent');
      }
    }
  }

  // =========================================================================
  // 3. EXAM ACTIVE VIEW
  // =========================================================================
  function renderExam(container) {
    const qList = mState.currentQuestions;
    const curIdx = mState.currentIndex;
    const q = qList[curIdx];
    if (!q) return;

    const answeredCount = Object.keys(mState.userAnswers).length;
    const progressPercent = Math.round((answeredCount / qList.length) * 100);

    const isFlagged = mState.flaggedQuestions.has(q.mockQNum);
    const userAnswer = mState.userAnswers[q.mockQNum];
    const selectedOptIdx = userAnswer !== undefined ? userAnswer.selectedIndex : null;

    container.innerHTML = `
      <div class="mock-container mock-exam-view">
        <!-- Sticky Exam Header -->
        <div class="mock-exam-sticky-bar">
          <div class="mock-exam-title-group">
            <span class="mock-exam-level-pill">${mState.level}</span>
            <span class="mock-exam-name">
              ${mState.mode === 'full' ? '실전 정규 모의고사' : mState.mode === 'mini' ? '스피드 미니 모의고사' : '맞춤 모의고사'}
            </span>
          </div>

          <!-- Timer -->
          <div class="mock-exam-timer-wrapper">
            <div class="mock-exam-timer ${mState.timer.remainingSeconds <= 300 ? 'urgent' : ''}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span id="mock-timer-text">${formatTime(mState.timer.remainingSeconds)}</span>
            </div>
            <button class="btn-mock-pause" id="btn-toggle-pause">
              ${mState.timer.isPaused ? '▶️ 계속하기' : '⏸️ 일시정지'}
            </button>
          </div>

          <!-- Actions -->
          <div class="mock-exam-actions">
            <button class="btn-flag-toggle ${isFlagged ? 'flagged' : ''}" id="btn-flag-cur-q">
              <span>${isFlagged ? '🚩 검토 표시됨' : '🚩 나중에 검토'}</span>
            </button>
            <button class="btn-submit-exam" id="btn-submit-exam">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>답안 제출</span>
            </button>
          </div>
        </div>

        <!-- Progress Bar -->
        <div class="mock-progress-container">
          <div class="mock-progress-bar" style="width: ${progressPercent}%;"></div>
        </div>

        <!-- 2-Column Workspace -->
        <div class="mock-exam-workspace">
          <!-- Question Main Panel -->
          <div class="mock-question-panel">
            <div class="mock-q-header">
              <div class="mock-q-meta">
                <span class="mock-q-number">Q.${q.mockQNum}</span>
                <span class="mock-q-type-badge">${q.sectionName}</span>
                <span class="mock-q-type-badge">${q.typeName}</span>
              </div>
              <div style="font-size:0.85rem; font-weight:700; color:var(--text-muted);">
                ${curIdx + 1} / ${qList.length}
              </div>
            </div>

            <div class="mock-q-instruction">${q.instruction}</div>

            <!-- Reading Split View if Passage exists -->
            ${q.passage ? `
              <div class="mock-reading-split">
                <div class="mock-passage-box">
                  <div class="mock-passage-title">📖 ${q.passage.title}</div>
                  <div class="mock-passage-text">${formatRuby(q.passage.passageRuby)}</div>
                  ${(q.passage.vocabList && q.passage.vocabList.length > 0) ? `
                    <div class="mock-passage-vocab">
                      <b>[핵심 단어]</b> ${q.passage.vocabList.map(v => `${v.word}(${v.reading}): ${v.mean}`).join(' • ')}
                    </div>
                  ` : ''}
                </div>
                <div>
                  <div class="mock-q-body" style="font-size:1.1rem; padding:1.2rem; margin-bottom:1.2rem;">
                    ${formatRuby(q.qRuby)}
                  </div>
                  <div class="mock-options-list">
                    ${q.options.map((opt, oIdx) => `
                      <button class="mock-option-btn ${selectedOptIdx === oIdx ? 'selected' : ''}" data-opt-index="${oIdx}">
                        <span class="mock-opt-marker">${opt.marker}</span>
                        <span class="mock-opt-text">${opt.text}</span>
                      </button>
                    `).join('')}
                  </div>
                </div>
              </div>
            ` : `
              <!-- Standard Vocab & Grammar Question -->
              <div class="mock-q-body">
                ${formatRuby(q.qRuby)}
              </div>

              <div class="mock-options-list">
                ${q.options.map((opt, oIdx) => `
                  <button class="mock-option-btn ${selectedOptIdx === oIdx ? 'selected' : ''}" data-opt-index="${oIdx}">
                    <span class="mock-opt-marker">${opt.marker}</span>
                    <span class="mock-opt-text">${opt.text}</span>
                  </button>
                `).join('')}
              </div>
            `}

            <!-- Footer Navigation -->
            <div class="mock-q-footer">
              <button class="btn-q-nav" id="btn-prev-q" ${curIdx === 0 ? 'disabled' : ''}>
                <span>◀ 이전 문제 (P)</span>
              </button>

              <div style="font-size:0.85rem; color:var(--text-muted); font-weight:600;">
                숫자키 <b>1, 2, 3, 4</b>로 정답 선택 가능
              </div>

              <button class="btn-q-nav" id="btn-next-q" ${curIdx === qList.length - 1 ? 'disabled' : ''}>
                <span>다음 문제 ▶ (N)</span>
              </button>
            </div>
          </div>

          <!-- OMR Sidebar -->
          <div class="mock-omr-sidebar">
            <div class="mock-omr-header">
              <div class="mock-omr-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                <span>OMR 답안지</span>
              </div>
              <div style="font-size:0.8rem; font-weight:700; color:var(--primary);">
                ${answeredCount}/${qList.length} 마킹
              </div>
            </div>

            <div class="mock-omr-counts">
              <div class="mock-omr-count-item">
                <span class="dot-answered"></span>
                <span>마킹: ${answeredCount}</span>
              </div>
              <div class="mock-omr-count-item">
                <span class="dot-flagged"></span>
                <span>검토: ${mState.flaggedQuestions.size}</span>
              </div>
              <div class="mock-omr-count-item">
                <span class="dot-unanswered"></span>
                <span>남음: ${qList.length - answeredCount}</span>
              </div>
            </div>

            <!-- OMR Grid -->
            <div class="mock-omr-grid">
              ${qList.map((item, idx) => {
                const ans = mState.userAnswers[item.mockQNum];
                const isCurrent = idx === curIdx;
                const isItemFlagged = mState.flaggedQuestions.has(item.mockQNum);
                const isAnswered = ans !== undefined;
                const marker = isAnswered ? ['①', '②', '③', '④'][ans.selectedIndex] : '';

                return `
                  <div class="mock-omr-cell ${isCurrent ? 'current' : ''} ${isAnswered ? 'answered' : ''} ${isItemFlagged ? 'flagged' : ''}" data-goto-index="${idx}">
                    <span>${item.mockQNum}</span>
                    ${isAnswered ? `<span class="mock-omr-cell-ans">${marker}</span>` : ''}
                  </div>
                `;
              }).join('')}
            </div>

            <button class="btn-submit-exam" id="btn-omr-submit" style="width:100%; justify-content:center; padding:0.85rem; margin-top:0.5rem;">
              <span>🏁 시험 종료 및 채점</span>
            </button>
          </div>
        </div>

        <!-- Custom In-App Submit Confirmation Modal -->
        <div class="mock-modal-overlay hidden" id="mock-submit-modal">
          <div class="mock-modal-card">
            <div class="mock-modal-header">
              <h3>🏁 모의고사 답안 제출 및 채점</h3>
              <button class="mock-modal-close" id="btn-close-submit-modal">&times;</button>
            </div>
            <div class="mock-modal-body">
              <p style="font-size:1.05rem; line-height:1.6; margin-bottom:1rem;">
                총 <b>${qList.length}문항</b> 중 <b>${answeredCount}문항</b>에 답안을 마킹하셨습니다.
              </p>
              ${(qList.length - answeredCount) > 0 ? `
                <div style="background:var(--warning-bg); border:1px solid var(--warning); border-radius:var(--radius-md); padding:0.85rem 1rem; color:var(--warning); font-size:0.9rem; font-weight:700; margin-bottom:1.25rem;">
                  ⚠️ 아직 풀지 않은 문제가 ${qList.length - answeredCount}개 있습니다!
                </div>
              ` : `
                <div style="background:var(--success-bg); border:1px solid var(--success-border); border-radius:var(--radius-md); padding:0.85rem 1rem; color:var(--success); font-size:0.9rem; font-weight:700; margin-bottom:1.25rem;">
                  ✨ 모든 문제의 답안 마킹을 완료했습니다!
                </div>
              `}
              <p style="font-size:0.9rem; color:var(--text-secondary); line-height:1.5;">
                제출 후에는 즉시 JLPT 환산 점수 및 영역별 성적표가 제공되며, 틀린 문제는 오답노트에 자동 등록할 수 있습니다.
              </p>
            </div>
            <div class="mock-modal-footer">
              <button class="btn btn-secondary" id="btn-cancel-submit-modal">계속 풀기</button>
              <button class="btn btn-primary" id="btn-confirm-submit-modal" style="background:var(--danger); border:none; font-weight:800;">
                답안 제출 및 채점하기
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    bindExamEvents(container);
  }

  function bindExamEvents(container) {
    const qList = mState.currentQuestions;
    const curIdx = mState.currentIndex;
    const curQ = qList[curIdx];

    // Option Selection
    container.querySelectorAll('.mock-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const optIdx = parseInt(btn.dataset.optIndex, 10);
        selectOption(curQ.mockQNum, optIdx);
      });
    });

    // Navigation buttons
    const btnPrev = container.querySelector('#btn-prev-q');
    const btnNext = container.querySelector('#btn-next-q');

    if (btnPrev) {
      btnPrev.addEventListener('click', () => {
        if (mState.currentIndex > 0) {
          mState.currentIndex--;
          renderExam(container);
        }
      });
    }

    if (btnNext) {
      btnNext.addEventListener('click', () => {
        if (mState.currentIndex < qList.length - 1) {
          mState.currentIndex++;
          renderExam(container);
        }
      });
    }

    // Flag toggle
    const btnFlag = container.querySelector('#btn-flag-cur-q');
    if (btnFlag) {
      btnFlag.addEventListener('click', () => {
        if (mState.flaggedQuestions.has(curQ.mockQNum)) {
          mState.flaggedQuestions.delete(curQ.mockQNum);
        } else {
          mState.flaggedQuestions.add(curQ.mockQNum);
        }
        renderExam(container);
      });
    }

    // Pause toggle
    const btnPause = container.querySelector('#btn-toggle-pause');
    if (btnPause) {
      btnPause.addEventListener('click', () => {
        mState.timer.isPaused = !mState.timer.isPaused;
        if (mState.timer.isPaused) {
          alert('시험이 일시정지되었습니다. 확인을 누르면 계속 진행됩니다.');
          mState.timer.isPaused = false;
        }
        renderExam(container);
      });
    }

    // OMR Click Navigate
    container.querySelectorAll('.mock-omr-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const targetIdx = parseInt(cell.dataset.gotoIndex, 10);
        mState.currentIndex = targetIdx;
        renderExam(container);
      });
    });

    // Submit Modal Handling
    const submitModal = container.querySelector('#mock-submit-modal');
    const handleOpenSubmitModal = () => {
      if (submitModal) submitModal.classList.remove('hidden');
    };
    const handleCloseSubmitModal = () => {
      if (submitModal) submitModal.classList.add('hidden');
    };

    const btnSubmit = container.querySelector('#btn-submit-exam');
    const btnOmrSubmit = container.querySelector('#btn-omr-submit');
    const btnCloseModal = container.querySelector('#btn-close-submit-modal');
    const btnCancelModal = container.querySelector('#btn-cancel-submit-modal');
    const btnConfirmSubmit = container.querySelector('#btn-confirm-submit-modal');

    if (btnSubmit) btnSubmit.addEventListener('click', handleOpenSubmitModal);
    if (btnOmrSubmit) btnOmrSubmit.addEventListener('click', handleOpenSubmitModal);
    if (btnCloseModal) btnCloseModal.addEventListener('click', handleCloseSubmitModal);
    if (btnCancelModal) btnCancelModal.addEventListener('click', handleCloseSubmitModal);
    if (btnConfirmSubmit) {
      btnConfirmSubmit.addEventListener('click', () => {
        handleCloseSubmitModal();
        finishExam();
      });
    }
  }

  function selectOption(mockQNum, optIndex) {
    mState.userAnswers[mockQNum] = {
      selectedIndex: optIndex,
      answeredAt: Date.now()
    };
    
    // Play subtle click sound if app sound available
    if (window.sound && typeof window.sound.playClick === 'function') {
      window.sound.playClick();
    }

    // Re-render current exam view
    render();
  }

  // Keyboard Shortcuts while in Exam
  window.addEventListener('keydown', (e) => {
    if (mState.view !== 'exam') return;

    // Do not trigger if typing in an input/textarea
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    const qList = mState.currentQuestions;
    const curIdx = mState.currentIndex;
    const curQ = qList[curIdx];
    if (!curQ) return;

    if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      const optIdx = parseInt(e.key, 10) - 1;
      selectOption(curQ.mockQNum, optIdx);
    } else if (e.key === 'p' || e.key === 'P' || e.key === 'ArrowLeft') {
      if (curIdx > 0) {
        e.preventDefault();
        mState.currentIndex--;
        render();
      }
    } else if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowRight' || e.key === ' ') {
      if (curIdx < qList.length - 1) {
        e.preventDefault();
        mState.currentIndex++;
        render();
      }
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (mState.flaggedQuestions.has(curQ.mockQNum)) {
        mState.flaggedQuestions.delete(curQ.mockQNum);
      } else {
        mState.flaggedQuestions.add(curQ.mockQNum);
      }
      render();
    }
  });

  // =========================================================================
  // 4. FINISH EXAM & GRADING (RESULT VIEW)
  // =========================================================================
  function finishExam() {
    if (mState.timer.intervalId) {
      clearInterval(mState.timer.intervalId);
      mState.timer.intervalId = null;
    }

    mState.endTime = Date.now();
    const durationSeconds = Math.max(1, Math.round((mState.endTime - mState.startTime) / 1000));
    const durationMinutes = Math.floor(durationSeconds / 60);
    const durationRemSec = durationSeconds % 60;
    const durationText = `${durationMinutes}분 ${durationRemSec}초`;

    const qList = mState.currentQuestions;
    let correctCount = 0;

    const sectionStats = {
      vocab: { total: 0, correct: 0, name: '문자·어휘' },
      grammar: { total: 0, correct: 0, name: '문법' },
      reading: { total: 0, correct: 0, name: '독해' }
    };

    const gradedQuestions = qList.map(q => {
      const uAns = mState.userAnswers[q.mockQNum];
      const userSelected = uAns !== undefined ? uAns.selectedIndex : null;
      const isCorrect = userSelected === q.correctIndex;

      if (isCorrect) correctCount++;

      if (sectionStats[q.section]) {
        sectionStats[q.section].total++;
        if (isCorrect) sectionStats[q.section].correct++;
      }

      return {
        ...q,
        userSelected,
        isCorrect,
        isFlagged: mState.flaggedQuestions.has(q.mockQNum)
      };
    });

    // JLPT 180-Score Scaling Calculation
    // Total 180 points. Section passing minimum: 19 points per section. Total passing score:
    // N1: 100/180 | N2: 90/180 | N3: 95/180 | N4: 90/180 | N5: 80/180
    const passThresholds = {
      'N1': { total: 100, sectionMin: 19 },
      'N2': { total: 90, sectionMin: 19 },
      'N3': { total: 95, sectionMin: 19 },
      'N4': { total: 90, sectionMin: 19 },
      'N5': { total: 80, sectionMin: 19 }
    };

    const targetThreshold = passThresholds[mState.level] || { total: 90, sectionMin: 19 };

    // Section Scaling to 60 points each (언어지식(어휘+문법) 60점, 독해 60점, 청해 60점 가상)
    const vocabRate = sectionStats.vocab.total > 0 ? (sectionStats.vocab.correct / sectionStats.vocab.total) : 0;
    const grammarRate = sectionStats.grammar.total > 0 ? (sectionStats.grammar.correct / sectionStats.grammar.total) : 0;
    const readingRate = sectionStats.reading.total > 0 ? (sectionStats.reading.correct / sectionStats.reading.total) : 0;

    // Combined Language Knowledge (어휘+문법) 60점 환산
    const langKnowledgeRate = (sectionStats.vocab.total + sectionStats.grammar.total) > 0 
      ? ((sectionStats.vocab.correct + sectionStats.grammar.correct) / (sectionStats.vocab.total + sectionStats.grammar.total))
      : 0;
    const langScore = Math.round(langKnowledgeRate * 60);
    const readingScore = Math.round(readingRate * 60);
    
    // Total scaled score out of 180 (독해/언어지식 가중치 환산)
    const overallRate = qList.length > 0 ? (correctCount / qList.length) : 0;
    const jlptScaledScore = Math.min(180, Math.round(overallRate * 180));

    const isPass = (jlptScaledScore >= targetThreshold.total) && 
                   (langScore >= targetThreshold.sectionMin) && 
                   (sectionStats.reading.total === 0 || readingScore >= targetThreshold.sectionMin);

    const resultObj = {
      date: Date.now(),
      level: mState.level,
      mode: mState.mode,
      modeName: mState.mode === 'full' ? '정규 모의고사' : mState.mode === 'mini' ? '스피드 미니' : '맞춤 모의고사',
      score: correctCount,
      totalQuestions: qList.length,
      accuracyPercent: Math.round(overallRate * 100),
      jlptScore: jlptScaledScore,
      isPass: isPass,
      durationText: durationText,
      sectionStats: sectionStats,
      langScore: langScore,
      readingScore: readingScore,
      gradedQuestions: gradedQuestions
    };

    mState.lastResult = resultObj;

    // Add to history
    mState.history.unshift(resultObj);
    saveHistory();

    // Record to daily stats
    if (typeof window.recordDailyActivity === 'function') {
      if (correctCount > 0) {
        window.recordDailyActivity({ category: 'quiz', isCorrect: true, count: correctCount });
      }
      const wrongCount = qList.length - correctCount;
      if (wrongCount > 0) {
        window.recordDailyActivity({ category: 'quiz', isCorrect: false, count: wrongCount });
      }
    }

    // Sound effect
    if (window.app) {
      if (isPass) {
        window.app.playCorrectSound();
      } else {
        window.app.playWrongSound();
      }
    }

    mState.view = 'result';
    mState.reviewFilter = 'all';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // =========================================================================
  // 5. RESULT & REVIEW VIEW
  // =========================================================================
  function renderResult(container) {
    const res = mState.lastResult;
    if (!res) {
      mState.view = 'lobby';
      renderLobby(container);
      return;
    }

    const wrongList = res.gradedQuestions.filter(q => !q.isCorrect);

    // Filter questions for review
    let displayList = res.gradedQuestions;
    if (mState.reviewFilter === 'wrong') {
      displayList = res.gradedQuestions.filter(q => !q.isCorrect);
    } else if (mState.reviewFilter === 'flagged') {
      displayList = res.gradedQuestions.filter(q => q.isFlagged);
    }

    container.innerHTML = `
      <div class="mock-container mock-result-view">
        <!-- Result Hero Banner -->
        <div class="mock-result-hero ${res.isPass ? 'pass' : 'fail'}">
          <div class="mock-result-badge ${res.isPass ? 'pass' : 'fail'}">
            <span>${res.isPass ? '🎉 축하합니다! 합격 기준 도달 (合格)' : '💪 아쉽습니다! 보완 학습 권장'}</span>
          </div>

          <div class="mock-score-display">
            <span class="mock-score-num">${res.jlptScore}</span>
            <span class="mock-score-total">/ 180점</span>
          </div>

          <p class="mock-score-comment">
            ${res.isPass 
              ? `훌륭합니다! ${res.level} 실전 시험의 합격 기준선을 여유 있게 돌파했습니다. 이 감각을 실전 시험장까지 유지하세요!` 
              : `합격선까지 조금 더 집중이 필요합니다. 아래의 오답 문제들을 오답노트에 등록하고 틀린 원인을 꼼꼼히 점검해 보세요.`}
          </p>

          <div style="font-size:0.95rem; font-weight:700; color:var(--text-secondary);">
            총 정답: <b>${res.score} / ${res.totalQuestions}문항 (${res.accuracyPercent}%)</b> • 풀이 소요 시간: <b>${res.durationText}</b>
          </div>
        </div>

        <!-- Section Analysis Cards -->
        <div class="mock-result-grid">
          <!-- Vocab -->
          <div class="mock-result-card">
            <div class="mock-rc-header">
              <span class="mock-rc-title">📝 문자·어휘 (文字・語彙)</span>
              <span class="mock-rc-score">
                ${res.sectionStats.vocab.total > 0 ? Math.round((res.sectionStats.vocab.correct / res.sectionStats.vocab.total) * 100) : 0}%
              </span>
            </div>
            <div class="mock-rc-bar">
              <div class="mock-rc-fill" style="width: ${res.sectionStats.vocab.total > 0 ? Math.round((res.sectionStats.vocab.correct / res.sectionStats.vocab.total) * 100) : 0}%;"></div>
            </div>
            <div class="mock-rc-meta">
              <span>맞힌 개수: ${res.sectionStats.vocab.correct} / ${res.sectionStats.vocab.total}</span>
              <span>${res.sectionStats.vocab.correct === res.sectionStats.vocab.total ? '완벽 정복' : '오답 복습 필요'}</span>
            </div>
          </div>

          <!-- Grammar -->
          <div class="mock-result-card">
            <div class="mock-rc-header">
              <span class="mock-rc-title">📖 문법 (文法)</span>
              <span class="mock-rc-score">
                ${res.sectionStats.grammar.total > 0 ? Math.round((res.sectionStats.grammar.correct / res.sectionStats.grammar.total) * 100) : 0}%
              </span>
            </div>
            <div class="mock-rc-bar">
              <div class="mock-rc-fill" style="width: ${res.sectionStats.grammar.total > 0 ? Math.round((res.sectionStats.grammar.correct / res.sectionStats.grammar.total) * 100) : 0}%;"></div>
            </div>
            <div class="mock-rc-meta">
              <span>맞힌 개수: ${res.sectionStats.grammar.correct} / ${res.sectionStats.grammar.total}</span>
              <span>${res.sectionStats.grammar.correct === res.sectionStats.grammar.total ? '완벽 정복' : '문법 포인트 점검'}</span>
            </div>
          </div>

          <!-- Reading -->
          <div class="mock-result-card">
            <div class="mock-rc-header">
              <span class="mock-rc-title">📑 독해 (読解)</span>
              <span class="mock-rc-score">
                ${res.sectionStats.reading.total > 0 ? Math.round((res.sectionStats.reading.correct / res.sectionStats.reading.total) * 100) : 0}%
              </span>
            </div>
            <div class="mock-rc-bar">
              <div class="mock-rc-fill" style="width: ${res.sectionStats.reading.total > 0 ? Math.round((res.sectionStats.reading.correct / res.sectionStats.reading.total) * 100) : 0}%;"></div>
            </div>
            <div class="mock-rc-meta">
              <span>맞힌 개수: ${res.sectionStats.reading.correct} / ${res.sectionStats.reading.total}</span>
              <span>${res.sectionStats.reading.total === 0 ? '미포함' : (res.sectionStats.reading.correct === res.sectionStats.reading.total ? '완벽 이해' : '지문 분석 권장')}</span>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="mock-result-actions">
          ${wrongList.length > 0 ? `
            <button class="btn-result-action danger" id="btn-save-all-mistakes">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <span>❌ 틀린 문제(${wrongList.length}) 일괄 오답노트 & Anki 등록</span>
            </button>
          ` : ''}

          <button class="btn-result-action primary" id="btn-restart-mock">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            <span>새 모의고사 치르기</span>
          </button>

          <button class="btn-result-action secondary" id="btn-print-mock-result">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            <span>성적표 인쇄 / PDF 저장</span>
          </button>

          <button class="btn-result-action secondary" id="btn-goto-lobby">
            <span>대기실로 나가기</span>
          </button>
        </div>

        <!-- Detailed Review Section -->
        <div class="mock-review-container">
          <div class="mock-review-header">
            <div class="mock-section-title" style="margin-bottom:0;">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
              <span>전체 문항 상세 해설 & 오답 리뷰 (${res.gradedQuestions.length}문항)</span>
            </div>

            <div class="mock-review-filters">
              <button class="mock-filter-btn ${mState.reviewFilter === 'all' ? 'active' : ''}" data-filter="all">
                전체 문항 (${res.gradedQuestions.length})
              </button>
              <button class="mock-filter-btn ${mState.reviewFilter === 'wrong' ? 'active' : ''}" data-filter="wrong">
                ❌ 틀린 문제 (${wrongList.length})
              </button>
              <button class="mock-filter-btn ${mState.reviewFilter === 'flagged' ? 'active' : ''}" data-filter="flagged">
                🚩 검토 표시 (${res.gradedQuestions.filter(q => q.isFlagged).length})
              </button>
            </div>
          </div>

          <!-- Review List -->
          <div class="mock-review-list">
            ${displayList.length === 0 ? `
              <div style="text-align:center; padding:3rem; color:var(--text-muted);">
                해당 필터에 일치하는 문제가 없습니다.
              </div>
            ` : displayList.map(q => {
              const userOpt = q.userSelected !== null ? q.options[q.userSelected] : null;
              const correctOpt = q.options[q.correctIndex];

              return `
                <div class="mock-review-card ${q.isCorrect ? 'correct' : 'wrong'}">
                  <div class="mock-rev-header">
                    <div style="display:flex; align-items:center; gap:0.6rem;">
                      <span class="mock-q-number" style="font-size:1.15rem;">Q.${q.mockQNum}</span>
                      <span class="mock-q-type-badge">${q.sectionName}</span>
                      <span class="mock-q-type-badge">${q.typeName}</span>
                      ${q.isFlagged ? '<span style="font-size:0.8rem;">🚩</span>' : ''}
                    </div>

                    <div class="mock-rev-badge ${q.isCorrect ? 'correct' : 'wrong'}">
                      ${q.isCorrect ? '✓ 정답' : '✕ 오답'}
                    </div>
                  </div>

                  <!-- Instruction -->
                  <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:0.6rem;">
                    ${q.instruction}
                  </div>

                  <!-- Passage toggle for reading -->
                  ${q.passage ? `
                    <div style="margin-bottom:0.75rem;">
                      <details style="background:var(--bg-elevated); padding:0.75rem 1rem; border-radius:var(--radius-md); font-size:0.95rem;">
                        <summary style="cursor:pointer; font-weight:700; color:var(--primary);">📖 지문 본문 다시 보기 (${q.passage.title})</summary>
                        <div style="margin-top:0.75rem; line-height:1.8; font-family:'Noto Sans JP', sans-serif; white-space:pre-wrap;">
                          ${formatRuby(q.passage.passageRuby)}
                        </div>
                        ${q.passage.passageTrans ? `
                          <div style="margin-top:0.75rem; padding-top:0.75rem; border-top:1px dashed var(--border-subtle); font-size:0.88rem; color:var(--text-secondary); line-height:1.6;">
                            <b>[지문 한글 해석]</b><br>${q.passage.passageTrans}
                          </div>
                        ` : ''}
                      </details>
                    </div>
                  ` : ''}

                  <!-- Question Text -->
                  <div class="mock-rev-body">
                    ${formatRuby(q.qRuby)}
                  </div>

                  <!-- 4 Choices with highlight -->
                  <div class="mock-rev-choices">
                    ${q.options.map((opt, optIdx) => {
                      const isUserPick = q.userSelected === optIdx;
                      const isAns = q.correctIndex === optIdx;

                      let extraClass = '';
                      let badge = '';

                      if (isAns) {
                        extraClass = 'correct-ans';
                        badge = ' (정답)';
                      } else if (isUserPick) {
                        extraClass = 'user-wrong';
                        badge = ' (내 선택)';
                      }

                      return `
                        <div class="mock-rev-choice-item ${extraClass}">
                          <b>${opt.marker}</b> ${opt.text} ${badge}
                          ${opt.trans ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${opt.trans}</div>` : ''}
                        </div>
                      `;
                    }).join('')}
                  </div>

                  <!-- Explanation Box -->
                  <div class="mock-rev-expl">
                    <div class="mock-rev-expl-title">💡 상세 해설 & 핵심 분석</div>
                    ${q.ansJa ? `<div style="margin-bottom:0.4rem; color:var(--text-primary); font-weight:600;"><b>정답 완성문:</b> ${q.ansJa}</div>` : ''}
                    ${q.ansKo ? `<div style="margin-bottom:0.4rem; color:var(--text-secondary);"><b>한국어 번역:</b> ${q.ansKo}</div>` : ''}
                    ${(q.expl && q.expl.main) ? `<div style="margin-top:0.5rem; line-height:1.5;">${q.expl.main}</div>` : ''}

                    <!-- Choices individual notes -->
                    ${(q.expl && q.expl.choices && q.expl.choices.length > 0) ? `
                      <div style="margin-top:0.75rem; padding-top:0.5rem; border-top:1px solid var(--border-subtle); font-size:0.82rem; color:var(--text-muted);">
                        ${q.expl.choices.map(c => `<div><b>${c.marker}</b>: ${c.note}</div>`).join('')}
                      </div>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;

    bindResultEvents(container);
  }

  function bindResultEvents(container) {
    const res = mState.lastResult;
    if (!res) return;

    // Filter Buttons
    container.querySelectorAll('.mock-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        mState.reviewFilter = btn.dataset.filter;
        renderResult(container);
      });
    });

    // Save All Mistakes
    const btnSaveMistakes = container.querySelector('#btn-save-all-mistakes');
    if (btnSaveMistakes) {
      btnSaveMistakes.addEventListener('click', () => {
        saveAllMockMistakes(res.gradedQuestions.filter(q => !q.isCorrect));
      });
    }

    // Restart Button
    const btnRestart = container.querySelector('#btn-restart-mock');
    if (btnRestart) {
      btnRestart.addEventListener('click', () => {
        startExam();
      });
    }

    // Go to Lobby
    const btnLobby = container.querySelector('#btn-goto-lobby');
    if (btnLobby) {
      btnLobby.addEventListener('click', () => {
        mState.view = 'lobby';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // Print
    const btnPrint = container.querySelector('#btn-print-mock-result');
    if (btnPrint) {
      btnPrint.addEventListener('click', () => {
        window.print();
      });
    }
  }

  // --- Save All Mistakes into Main Mistake Note & SRS ---
  function saveAllMockMistakes(wrongQuestions) {
    if (!wrongQuestions || wrongQuestions.length === 0) return;

    try {
      if (window.app && typeof window.app.recordMockMistakes === 'function') {
        window.app.recordMockMistakes(wrongQuestions);
        if (window.app.showToast) {
          window.app.showToast(`🎉 모의고사 오답 ${wrongQuestions.length}문항이 오답노트 및 Anki 복습 덱에 등록되었습니다!`);
        } else {
          alert(`오답 ${wrongQuestions.length}문항이 오답노트에 자동 등록되었습니다!`);
        }
        return;
      }

      let mistakes = {};
      const saved = localStorage.getItem(STORAGE_KEYS.MISTAKES);
      if (saved) mistakes = JSON.parse(saved);

      let srs = {};
      const savedSrs = localStorage.getItem(STORAGE_KEYS.SRS);
      if (savedSrs) srs = JSON.parse(savedSrs);

      const now = Date.now();
      wrongQuestions.forEach(q => {
        const userChoiceText = q.userSelected !== null && q.options && q.options[q.userSelected] ? q.options[q.userSelected].text : '미응답';

        if (!mistakes[q.id]) {
          mistakes[q.id] = {
            id: q.id,
            level: q.level,
            typeCode: q.section,
            typeName: q.sectionName,
            instruction: q.instruction,
            qPlain: q.qPlain,
            qRuby: q.qRuby,
            qTrans: q.qTrans,
            options: q.options,
            ansJa: q.ansJa,
            ansKo: q.ansKo,
            expl: q.expl,
            count: 1,
            firstWrongDate: now,
            lastWrongDate: now,
            lastModified: now,
            wrongChoice: userChoiceText,
            isMastered: false,
            isBookmarked: false,
            source: '모의고사'
          };
        } else {
          mistakes[q.id].count = (mistakes[q.id].count || 1) + 1;
          mistakes[q.id].lastWrongDate = now;
          mistakes[q.id].lastModified = now;
          mistakes[q.id].wrongChoice = userChoiceText;
          mistakes[q.id].isMastered = false;
        }

        // Enroll in Anki SRS
        if (!srs[q.id]) {
          srs[q.id] = {
            id: q.id,
            level: q.level,
            repetitions: 0,
            interval: 1,
            easeFactor: 2.5,
            dueDate: now + 86400000,
            lastReviewed: now,
            state: 'learning',
            lapses: 1
          };
        } else {
          srs[q.id].repetitions = 0;
          srs[q.id].interval = 1;
          srs[q.id].dueDate = now + 86400000;
          srs[q.id].lastReviewed = now;
          srs[q.id].lapses = (srs[q.id].lapses || 0) + 1;
        }
      });

      localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));
      localStorage.setItem(STORAGE_KEYS.SRS, JSON.stringify(srs));

      if (window.JLPT_FIREBASE && window.JLPT_FIREBASE.scheduleCloudUpload) {
        window.JLPT_FIREBASE.scheduleCloudUpload();
      }

      // Trigger app badges
      if (window.app && typeof window.app.showToast === 'function') {
        window.app.showToast(`🎉 모의고사 오답 ${wrongQuestions.length}문항이 오답노트 및 Anki 복습 덱에 등록되었습니다!`);
      } else {
        alert(`오답 ${wrongQuestions.length}문항이 오답노트에 자동 등록되었습니다!`);
      }

      // Update badge if app available
      if (typeof window.updateMistakeBadge === 'function') {
        window.updateMistakeBadge();
      }
    } catch (e) {
      console.warn('Failed to save mock mistakes:', e);
      alert('오답노트 등록 중 오류가 발생했습니다.');
    }
  }

  // --- Initialize Module ---
  function init() {
    loadHistory();
    // Expose global mockApp object
    window.mockApp = {
      init,
      render,
      startExam,
      generateMockExam,
      getHistory: () => mState.history
    };
  }

  // DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
