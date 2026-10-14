/**
 * JLPT MASTER - 실전 일본어 문법(文法) 4지선다형 애플리케이션 모듈
 * Interactive 4-Choice JLPT Grammar Quiz Workspace
 */

(function () {
  'use strict';

  const STORAGE_KEYS = {
    GRAMMAR_STATE: 'jlpt_grammar_state_v1',
    GRAMMAR_HISTORY: 'jlpt_grammar_history_v1',
    GRAMMAR_BOOKMARKS: 'jlpt_grammar_bookmarks_v1',
    MISTAKES: 'jlpt_mistakes_v1',
    SRS: 'jlpt_srs_v1'
  };

  // State
  let gState = {
    level: 'ALL',          // 'ALL' | 'N1' | 'N2' | 'N3' | 'N4' | 'N5'
    filterType: 'all',     // 'all' | 'gangdok5' | 'wrong' | 'bookmarked'
    searchKeyword: '',
    currentIndex: 0,
    showRuby: true,
    showTrans: false,
    fontSize: 'md'
  };

  // User responses: { [qId]: { selectedIndex: number, isCorrect: boolean, answeredAt: number } }
  let userAnswers = {};
  let bookmarks = new Set();

  // Active filtered questions list
  let filteredList = [];

  // 강독5 (91~173) 주요 핵심 문법 패턴 목록
  const GANGDOK5_PATTERNS = [
    '～ついでに', '～とおり', '～どおり', '～にしたがって', '～にしたがい', '～にすぎない',
    '～おそれがある', '～かねない', '～かねる', '～つつある', '～反面', '～一方', '～ばかりか',
    '～にほかならない', '～に相違ない', '～ざるを得ない', '～べきだ', '～べきではない',
    '～まい', '～ものなら', '～ものの', '～ようがない', '～を契機に', '～を皮切りに',
    '～をはじめ', '～を通じて', '～を通して', '～をめぐって', '～をもとに', '～にかかわらず',
    '～に対して', '～に関して', '～について', '～にとって', '～によって', '～にわたって',
    '～あげく', '～末に', '～わりに', '～くせに', '～からには', '～うえで', '～うちに'
  ];

  // Ruby formatting helper
  function formatRuby(text) {
    if (!text) return '';
    if (text.includes('<ruby>') || text.includes('<rt>')) {
      return text;
    }
    return text.replace(/([\u4E00-\u9FAF\u3400-\u4DBF々ヶ]+)[(（]([\u3040-\u309F\u30A0-\u30FF]+)[)）]/g, 
      (match, kanji, ruby) => '<ruby>' + kanji + '<rt>' + ruby + '</rt></ruby>');
  }

  function removeRuby(text) {
    if (!text) return '';
    return text.replace(/[(（][\u3040-\u309F\u30A0-\u30FF]+[)）]/g, '');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getDynamicTrans(opt, q) {
    if (opt.trans) return opt.trans;
    if (opt.isCorrect && q.patternMeaning) {
      let clean = q.patternMeaning.replace(/<[^>]+>/g, ', ').replace(/[①②③④⑤]/g, '').replace(/\s+/g, ' ').trim();
      let parts = clean.split(/[,/·]/).map(p => p.trim()).filter(Boolean);
      return parts.slice(0, 2).join(', ');
    }
    return '';
  }

  function getDynamicChoices(q) {
    if (q.expl && q.expl.choices && q.expl.choices.length > 0) {
      return q.expl.choices;
    }
    return (q.options || []).map((opt, idx) => {
      const text = (opt.copyNoRuby || opt.copy).trim();
      const marker = opt.marker || `(${idx + 1})`;
      const trans = opt.trans || getDynamicTrans(opt, q);
      const isCorrect = !!opt.isCorrect;
      let note = '';
      if (isCorrect) {
        note = `「${text}」는 '${trans || q.patternMeaning}'을(를) 뜻하는 핵심 문형으로, 본 문맥("${q.qTrans}")에 자연스럽게 들어맞는 정답입니다.`;
      } else {
        const isEndOfSentence = /\(\s*\)[。?!]/.test(q.qPlain) || /\(\s*\)\s*$/.test(q.qPlain);
        let reason = '';
        if (text.endsWith('だです') || text.endsWith('であるです')) {
          reason = `「${text}」는 비문법적인 잘못된 활용 형태입니다. (문말 정중형 종결 시 'です'를 올바르게 접속해야 함)`;
        } else if (isEndOfSentence && (text.endsWith('ので') || text.endsWith('から') || text.endsWith('のに') || text.endsWith('ながら') || text.endsWith('ば') || text.endsWith('たら') || text.endsWith('ても') || text.endsWith('ことで'))) {
          reason = `'${trans}'의 절을 이어주는 연결형(접속형)이므로, 문장을 매듭짓는 종결 빈칸 위치에 올 수 없습니다.`;
        } else if (text.endsWith('かと思') || text.endsWith('に限') || text.endsWith('に対') || text.endsWith('をと') || text.endsWith('をめぐ')) {
          reason = `표현의 어간만 제시되었거나 불완전한 형태이며, 문맥의 접속 관계와 맞지 않습니다.`;
        } else if (trans) {
          reason = `'${trans}'(이)라는 뜻으로, 문제의 출제 의도 및 문맥 흐름("${q.qTrans}")과 맞지 않습니다.`;
        } else {
          reason = `문법적 접속 관계가 올바르지 않거나 본 문맥의 표현으로 부적절합니다.`;
        }
        note = `「${text}」: ${reason}`;
      }
      return { marker, text, trans, isCorrect, note };
    });
  }

  function loadStorage() {
    try {
      const savedState = localStorage.getItem(STORAGE_KEYS.GRAMMAR_STATE);
      if (savedState) {
        const parsed = JSON.parse(savedState);
        gState.level = parsed.level || 'ALL';
        gState.filterType = parsed.filterType || 'all';
        gState.currentIndex = parsed.currentIndex || 0;
        gState.showRuby = parsed.showRuby !== undefined ? parsed.showRuby : true;
        gState.showTrans = parsed.showTrans !== undefined ? parsed.showTrans : false;
      }
    } catch (e) {
      console.warn('Failed to load grammar state:', e);
    }

    try {
      const savedAnswers = localStorage.getItem(STORAGE_KEYS.GRAMMAR_HISTORY);
      if (savedAnswers) {
        userAnswers = JSON.parse(savedAnswers);
      }
    } catch (e) {
      userAnswers = {};
    }

    try {
      const savedBookmarks = localStorage.getItem(STORAGE_KEYS.GRAMMAR_BOOKMARKS);
      if (savedBookmarks) {
        bookmarks = new Set(JSON.parse(savedBookmarks));
      }
    } catch (e) {
      bookmarks = new Set();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEYS.GRAMMAR_STATE, JSON.stringify({
        level: gState.level,
        filterType: gState.filterType,
        currentIndex: gState.currentIndex,
        showRuby: gState.showRuby,
        showTrans: gState.showTrans
      }));
    } catch (e) {}
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEYS.GRAMMAR_HISTORY, JSON.stringify(userAnswers));
    } catch (e) {}
  }

  function saveBookmarks() {
    try {
      localStorage.setItem(STORAGE_KEYS.GRAMMAR_BOOKMARKS, JSON.stringify([...bookmarks]));
    } catch (e) {}
  }

  // Play Sound Helper
  function playSound(type) {
    if (window.sound) {
      if (type === 'correct' && window.sound.playCorrect) window.sound.playCorrect();
      else if (type === 'wrong' && window.sound.playWrong) window.sound.playWrong();
      else if (type === 'tap' && window.sound.playTap) window.sound.playTap();
    }
  }

  // Toast Helper
  function showToast(msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
      return;
    }
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

  // Filter Questions
  function applyFilters() {
    const allQuestions = window.JLPT_GRAMMAR_DATA || [];
    const kw = gState.searchKeyword.trim().toLowerCase();

    filteredList = allQuestions.filter(q => {
      // 1. Level Filter
      if (gState.level !== 'ALL' && q.level !== gState.level) {
        return false;
      }

      // 2. Filter Type
      if (gState.filterType === 'new') {
        const ans = userAnswers[q.id];
        if (ans) return false; // 아직 풀지 않은 새로운 문제만
      } else if (gState.filterType === 'gangdok5') {
        const isGangdok = GANGDOK5_PATTERNS.some(p => q.pattern.includes(p) || p.includes(q.pattern));
        if (!isGangdok) return false;
      } else if (gState.filterType === 'wrong') {
        const ans = userAnswers[q.id];
        if (!ans || ans.isCorrect) return false;
      } else if (gState.filterType === 'bookmarked') {
        if (!bookmarks.has(q.id)) return false;
      }

      // 3. Search Keyword Filter
      if (kw) {
        const pat = (q.pattern || '').toLowerCase();
        const mean = (q.patternMeaning || '').toLowerCase();
        const target = (q.target || '').toLowerCase();
        const qPlain = (q.qPlain || '').toLowerCase();
        const qTrans = (q.qTrans || '').toLowerCase();
        if (!pat.includes(kw) && !mean.includes(kw) && !target.includes(kw) && !qPlain.includes(kw) && !qTrans.includes(kw)) {
          return false;
        }
      }

      return true;
    });

    if (gState.currentIndex >= filteredList.length) {
      gState.currentIndex = Math.max(0, filteredList.length - 1);
    }
  }

  // Trigger real-time sync with Firebase and Google Drive
  function triggerSync() {
    try {
      if (window.JLPT_FIREBASE && typeof window.JLPT_FIREBASE.scheduleCloudUpload === 'function') {
        window.JLPT_FIREBASE.scheduleCloudUpload(300);
      }
      if (window.syncManager && typeof window.syncManager.scheduleSync === 'function') {
        window.syncManager.scheduleSync();
      }
    } catch (e) {
      console.warn('[Grammar] Sync trigger error:', e);
    }
  }

  // Record Answer & sync with Mistakes Notebook
  function recordAnswer(question, selectedOptIndex) {
    const opt = question.options[selectedOptIndex];
    const isCorrect = !!opt.isCorrect;

    userAnswers[question.id] = {
      selectedIndex: selectedOptIndex,
      isCorrect: isCorrect,
      answeredAt: Date.now()
    };
    saveHistory();

    // Record daily activity tracking
    if (typeof window.recordDailyActivity === 'function') {
      window.recordDailyActivity({ category: 'grammar', isCorrect: isCorrect, count: 1 });
    }

    // Trigger Cloud & Google Drive auto-sync
    triggerSync();

    // Sound
    if (isCorrect) {
      playSound('correct');
    } else {
      playSound('wrong');
    }

    // Update Mistakes Notebook
    if (!isCorrect) {
      recordMistake(question, opt.copy);
    }

    updateLevelCounts();
    renderCard();
  }

  function recordMistake(q, wrongText) {
    try {
      let mistakes = {};
      const saved = localStorage.getItem(STORAGE_KEYS.MISTAKES);
      if (saved) mistakes = JSON.parse(saved);

      if (!mistakes[q.id]) {
        mistakes[q.id] = {
          id: q.id,
          level: q.level,
          typeCode: 'grammar',
          typeName: '문법 (文法)',
          instruction: q.instruction,
          qPlain: q.qPlain,
          qRuby: q.qRuby,
          qTrans: q.qTrans,
          options: q.options,
          ansJa: q.ansJa,
          ansKo: q.ansKo,
          expl: q.expl,
          count: 1,
          firstWrongDate: Date.now(),
          lastWrongDate: Date.now(),
          wrongChoice: wrongText,
          isMastered: false,
          isBookmarked: bookmarks.has(q.id)
        };
      } else {
        mistakes[q.id].count = (mistakes[q.id].count || 1) + 1;
        mistakes[q.id].lastWrongDate = Date.now();
        mistakes[q.id].wrongChoice = wrongText;
        mistakes[q.id].isMastered = false;
      }

      localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(mistakes));

      // Also sync to window.app mistakes
      if (window.app && typeof window.app.recordGrammarMistake === 'function') {
        window.app.recordGrammarMistake(mistakes[q.id]);
      }

      // Update badge if available
      if (window.updateMistakeBadge) window.updateMistakeBadge();
    } catch (e) {
      console.warn('Failed to record grammar mistake:', e);
    }
  }

  // Toggle Bookmark
  function toggleBookmark(qId) {
    if (bookmarks.has(qId)) {
      bookmarks.delete(qId);
      showToast('북마크가 해제되었습니다.');
    } else {
      bookmarks.add(qId);
      showToast('⭐ 문법 문제가 북마크에 저장되었습니다.');
    }
    saveBookmarks();
    triggerSync();
    updateLevelCounts();
    renderCard();
  }

  // --- Render Functions ---

  function updateFilterChipCounts() {
    const all = window.JLPT_GRAMMAR_DATA || [];
    const lvl = gState.level;
    const questions = lvl === 'ALL' ? all : all.filter(q => q.level === lvl);

    let newCount = 0;
    let gangdok5Count = 0;
    let wrongCount = 0;
    let bookmarkedCount = 0;

    questions.forEach(q => {
      const ans = userAnswers[q.id];
      if (!ans) newCount++;
      else if (!ans.isCorrect) wrongCount++;

      if (GANGDOK5_PATTERNS.some(p => q.pattern.includes(p) || p.includes(q.pattern))) {
        gangdok5Count++;
      }
      if (bookmarks.has(q.id)) {
        bookmarkedCount++;
      }
    });

    const elAll = document.getElementById('g-filter-cnt-all');
    if (elAll) elAll.textContent = questions.length.toLocaleString();

    const elNew = document.getElementById('g-filter-cnt-new');
    if (elNew) elNew.textContent = newCount.toLocaleString();

    const elGangdok5 = document.getElementById('g-filter-cnt-gangdok5');
    if (elGangdok5) elGangdok5.textContent = gangdok5Count.toLocaleString();

    const elWrong = document.getElementById('g-filter-cnt-wrong');
    if (elWrong) elWrong.textContent = wrongCount.toLocaleString();

    const elBookmarked = document.getElementById('g-filter-cnt-bookmarked');
    if (elBookmarked) elBookmarked.textContent = bookmarkedCount.toLocaleString();
  }

  function updateLevelCounts() {
    const all = window.JLPT_GRAMMAR_DATA || [];
    const counts = { ALL: 0, N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 };
    all.forEach(q => {
      let matchesFilter = true;
      if (gState.filterType === 'new') {
        if (userAnswers[q.id]) matchesFilter = false;
      } else if (gState.filterType === 'gangdok5') {
        matchesFilter = GANGDOK5_PATTERNS.some(p => q.pattern.includes(p) || p.includes(q.pattern));
      } else if (gState.filterType === 'wrong') {
        const ans = userAnswers[q.id];
        matchesFilter = !!(ans && !ans.isCorrect);
      } else if (gState.filterType === 'bookmarked') {
        matchesFilter = bookmarks.has(q.id);
      }

      if (matchesFilter) {
        counts.ALL++;
        if (counts[q.level] !== undefined) counts[q.level]++;
      }
    });

    Object.keys(counts).forEach(lvl => {
      const el = document.getElementById(`g-count-${lvl.toLowerCase()}`);
      if (el) el.textContent = counts[lvl].toLocaleString();
    });

    const headerCount = document.getElementById('header-grammar-count');
    if (headerCount) headerCount.textContent = all.length.toLocaleString();

    updateFilterChipCounts();
  }

  function renderCard() {
    const container = document.getElementById('grammar-workspace');
    if (!container) return;

    if (filteredList.length === 0) {
      const isNewFilter = gState.filterType === 'new';
      container.innerHTML = `
        <div class="empty-state-card" style="padding:4rem 2rem; text-align:center; background:var(--bg-card); border-radius:var(--radius-lg); border:1px dashed var(--border-subtle);">
          <div style="font-size:3rem; margin-bottom:1rem;">${isNewFilter ? '🎉' : '🔍'}</div>
          <h3 style="font-size:1.25rem; font-weight:800; color:var(--text-primary); margin-bottom:0.5rem;">
            ${isNewFilter ? '새로운 문법 문제를 모두 풀었습니다!' : '선택한 조건의 문법 문제가 없습니다'}
          </h3>
          <p style="color:var(--text-secondary); font-size:0.95rem; margin-bottom:1.5rem; max-width:440px; margin-left:auto; margin-right:auto;">
            ${isNewFilter ? '선택한 조건의 아직 풀지 않은 문제를 모두 완료했습니다. 전체 문제를 다시 복습하거나 오답 노트를 풀어보세요.' : '검색어나 급수 필터를 변경해 보세요.'}
          </p>
          <div style="display:flex; justify-content:center; gap:0.75rem; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="btn-reset-grammar-filters">${isNewFilter ? '전체 문제 보기' : '필터 초기화'}</button>
            ${isNewFilter ? '<button class="btn btn-secondary btn-sm" id="btn-grammar-goto-wrong">❌ 오답만 모아 풀기</button>' : ''}
          </div>
        </div>
      `;
      const btnReset = document.getElementById('btn-reset-grammar-filters');
      if (btnReset) {
        btnReset.addEventListener('click', () => {
          gState.filterType = 'all';
          gState.searchKeyword = '';
          const searchInput = document.getElementById('grammar-search-input');
          if (searchInput) searchInput.value = '';
          applyFilters();
          render();
        });
      }
      const btnWrong = document.getElementById('btn-grammar-goto-wrong');
      if (btnWrong) {
        btnWrong.addEventListener('click', () => {
          gState.filterType = 'wrong';
          applyFilters();
          render();
        });
      }
      return;
    }

    const cur = filteredList[gState.currentIndex];
    const ans = userAnswers[cur.id];
    const isAnswered = !!ans;
    const isBookmarked = bookmarks.has(cur.id);

    // Question sentence with blank
    let sentenceHtml = '';
    const rawJa = cur.qRuby;
    // Replace (   ) with styled blank span
    const blankHtml = isAnswered
      ? `<span class="grammar-blank ${ans.isCorrect ? 'correct' : 'wrong'}">${formatRuby(cur.target)}</span>`
      : `<span class="grammar-blank">( &nbsp; ? &nbsp; )</span>`;

    const sentenceWithSpan = rawJa.replace(/\(\s*\)/g, blankHtml);
    sentenceHtml = formatRuby(sentenceWithSpan);

    // Progress bar percent
    const progressPct = Math.round(((gState.currentIndex + 1) / filteredList.length) * 100);

    // Options HTML
    let optionsHtml = '';
    const isTransVisible = gState.showTrans || isAnswered;

    cur.options.forEach((opt, idx) => {
      let stateClass = '';
      if (isAnswered) {
        stateClass = 'disabled ';
        if (opt.isCorrect) {
          stateClass += 'correct';
        } else if (ans.selectedIndex === idx) {
          stateClass += 'wrong';
        } else {
          stateClass += 'dimmed';
        }
      }

      const optTrans = opt.trans || getDynamicTrans(opt, cur);

      optionsHtml += `
        <div class="g-option-card ${stateClass}" data-opt-idx="${idx}" role="button" tabindex="0">
          <span class="g-option-marker">${opt.marker}</span>
          <div class="g-option-content">
            <span class="g-option-text">${formatRuby(opt.copy)}</span>
            <span class="g-option-trans ${isTransVisible && optTrans ? '' : 'hidden'}">${escapeHtml(optTrans)}</span>
          </div>
          <span class="g-option-kbd">${idx + 1}</span>
        </div>
      `;
    });

    // Explanation HTML
    let explHtml = '';
    if (isAnswered) {
      const choices = getDynamicChoices(cur);
      let choicesListHtml = '';
      choices.forEach(c => {
        const isCorrect = !!c.isCorrect;
        choicesListHtml += `
          <div class="g-choice-expl-item ${isCorrect ? 'is-correct' : 'is-wrong'}">
            <div class="g-choice-expl-top">
              <span class="g-choice-badge ${isCorrect ? 'correct' : 'wrong'}">
                ${c.marker} ${isCorrect ? '정답' : '오답'}
              </span>
              <span class="g-choice-text">${formatRuby(c.text || '')}</span>
              ${c.trans ? `<span class="g-choice-trans">(${escapeHtml(c.trans)})</span>` : ''}
            </div>
            <div class="g-choice-expl-note">${escapeHtml(c.note)}</div>
          </div>
        `;
      });

      explHtml = `
        <div class="grammar-expl-card">
          <div class="g-expl-status-bar">
            <span class="g-expl-badge ${ans.isCorrect ? 'correct' : 'wrong'}">
              ${ans.isCorrect ? '🎉 정답입니다!' : '⚠️ 아쉽습니다! 오답입니다'}
            </span>
            <div class="g-expl-actions">
              <button class="btn btn-ghost btn-sm" id="btn-expl-speak" title="일본어 완성 문장 듣기">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                <span>발음 듣기</span>
              </button>
            </div>
          </div>

          <div class="g-complete-sentence">
            <div class="g-complete-ja">
              ${formatRuby(cur.ansJa)}
            </div>
            <div class="g-complete-ko">${cur.ansKo}</div>
          </div>

          <div class="g-pattern-rule-box">
            <div class="g-rule-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <span>핵심 문법 포인트 : ${cur.pattern}</span>
            </div>
            <div class="g-rule-desc">
              <strong>의미:</strong> ${cur.patternMeaning}<br>
              ${cur.expl ? cur.expl.main : ''}
            </div>
          </div>

          <!-- 선택지별 상세 분석 및 오답 이유 -->
          <div class="g-choices-expl-section">
            <div class="g-rule-title" style="margin-bottom:0.75rem; color:var(--text-primary);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
              <span>선택지별 상세 분석 및 오답 이유</span>
            </div>
            <div class="g-choices-expl-list">
              ${choicesListHtml}
            </div>
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <!-- Progress Bar -->
      <div class="grammar-progress-card">
        <span class="g-progress-stat">진행 문항: ${gState.currentIndex + 1} / ${filteredList.length.toLocaleString()}${gState.filterType === 'new' ? ' (미풀이 새 문제)' : ''}</span>
        <div class="g-progress-bar-wrap">
          <div class="g-progress-bar-fill" style="width: ${progressPct}%;"></div>
        </div>
        <span class="g-progress-stat">${progressPct}%</span>
      </div>

      <!-- Main Question Card -->
      <div class="grammar-card">
        <div class="grammar-card-header">
          <div class="g-header-left">
            <span class="g-level-badge ${cur.level}">${cur.level} 문법</span>
            ${gState.filterType === 'new' ? '<span class="badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; font-size:0.75rem; font-weight:700; padding:0.2rem 0.6rem; border-radius:999px;">✨ 새로운 문제</span>' : ''}
            <span class="g-pattern-badge" id="btn-view-pattern" title="문법 항목: ${cur.pattern}">
              ${cur.pattern} (${cur.patternMeaning})
            </span>
            <span class="g-q-number">#${cur.id}</span>
          </div>

          <div class="g-header-right">
            <button class="icon-button ${isBookmarked ? 'active' : ''}" id="btn-grammar-bookmark" title="문법 문제 북마크">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
            <button class="icon-button" id="btn-grammar-picker" title="문법 문제 목록 열기">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
            </button>
          </div>
        </div>

        <div class="grammar-question-box">
          <div class="grammar-instruction">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
            <span>${cur.instruction || '빈칸에 들어갈 가장 알맞은 문법 표현을 고르세요.'}</span>
          </div>

          <div class="grammar-sentence ${isAnswered ? 'answered' : ''}">
            ${sentenceHtml}
          </div>

          <div class="grammar-trans-box ${gState.showTrans ? 'visible' : ''}" id="g-trans-box">
            💡 <strong>한국어 해석:</strong> ${cur.qTrans}
          </div>
        </div>

        <!-- 4 Options Grid -->
        <div class="grammar-options-grid">
          ${optionsHtml}
        </div>

        <!-- Explanation Slide Down -->
        ${explHtml}
      </div>

      <!-- Footer Navigation (Outside .grammar-card for true viewport docking) -->
      <div class="grammar-footer-nav">
        <div class="g-footer-left">
          <button class="btn btn-secondary btn-sm" id="btn-g-prev" ${gState.currentIndex === 0 ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
            <span>이전<span class="desktop-only-inline"> 문제</span></span>
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-g-random" title="무작위 문제 풀기">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.973a4 4 0 0 1 3.3 1.7l5.454 8.6a4 4 0 0 0 3.3 1.7H22"/></svg>
            <span>랜덤</span>
          </button>
        </div>

        <div class="g-footer-right">
          <button class="btn btn-primary btn-sm" id="btn-g-next">
            <span>다음<span class="desktop-only-inline"> 문제</span></span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      </div>
    `;

    // Event Listeners on Card
    const optionCards = container.querySelectorAll('.g-option-card');
    optionCards.forEach(card => {
      card.addEventListener('click', () => {
        if (isAnswered) return;
        const optIdx = parseInt(card.dataset.optIdx, 10);
        recordAnswer(cur, optIdx);
      });
    });

    const btnPrev = document.getElementById('btn-g-prev');
    if (btnPrev) {
      btnPrev.addEventListener('click', () => {
        if (gState.currentIndex > 0) {
          gState.currentIndex--;
          saveState();
          renderCard();
          if (window.innerWidth <= 900 || document.documentElement.classList.contains('is-mobile-device')) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        }
      });
    }

    const btnNext = document.getElementById('btn-g-next');
    if (btnNext) {
      btnNext.addEventListener('click', () => {
        if (gState.filterType === 'new') {
          // 새로운 문제 풀기 모드에서는 이미 푼 문제를 제외하고 다음 새 문제로 진행
          applyFilters();
          updateLevelCounts();
          if (filteredList.length === 0) {
            renderCard();
            return;
          }
          if (gState.currentIndex >= filteredList.length) {
            gState.currentIndex = 0;
          }
          saveState();
          renderCard();
        } else {
          if (gState.currentIndex < filteredList.length - 1) {
            gState.currentIndex++;
            saveState();
            renderCard();
          } else {
            showToast('마지막 문제입니다!');
          }
        }
        if (window.innerWidth <= 900 || document.documentElement.classList.contains('is-mobile-device')) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    const btnRandom = document.getElementById('btn-g-random');
    if (btnRandom) {
      btnRandom.addEventListener('click', () => {
        if (filteredList.length <= 1) {
          showToast('풀 수 있는 다른 문제가 없습니다.');
          return;
        }
        let randIdx = gState.currentIndex;
        while (randIdx === gState.currentIndex) {
          randIdx = Math.floor(Math.random() * filteredList.length);
        }
        gState.currentIndex = randIdx;
        saveState();
        renderCard();
        if (window.innerWidth <= 900 || document.documentElement.classList.contains('is-mobile-device')) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    const btnBookmark = document.getElementById('btn-grammar-bookmark');
    if (btnBookmark) {
      btnBookmark.addEventListener('click', () => {
        toggleBookmark(cur.id);
      });
    }

    const btnPicker = document.getElementById('btn-grammar-picker');
    if (btnPicker) {
      btnPicker.addEventListener('click', openQuestionPickerModal);
    }

    const btnPattern = document.getElementById('btn-view-pattern');
    if (btnPattern) {
      btnPattern.addEventListener('click', () => {
        // Quick filter by this pattern
        const searchInput = document.getElementById('grammar-search-input');
        if (searchInput) {
          searchInput.value = cur.pattern.replace('～', '');
          gState.searchKeyword = searchInput.value;
          applyFilters();
          gState.currentIndex = 0;
          render();
        }
      });
    }

    const btnSpeak = document.getElementById('btn-expl-speak');
    if (btnSpeak) {
      btnSpeak.addEventListener('click', () => {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const cleanText = removeRuby(cur.ansJa);
          const u = new SpeechSynthesisUtterance(cleanText);
          u.lang = 'ja-JP';
          u.rate = 0.95;
          window.speechSynthesis.speak(u);
        } else {
          showToast('음성 합성을 지원하지 않는 브라우저입니다.');
        }
      });
    }
  }

  // Question Picker Modal
  function openQuestionPickerModal() {
    let modal = document.getElementById('modal-grammar-picker');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal-grammar-picker';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-card" style="max-width:800px; width:92%;">
          <div class="modal-header">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <h3 style="font-size:1.15rem; font-weight:800;">📚 문법 문제 바로가기 목록</h3>
              <span class="badge" id="modal-g-count">0</span>
            </div>
            <button class="modal-close-btn" id="btn-close-g-picker">&times;</button>
          </div>
          <div class="modal-body" style="padding:1rem;">
            <div class="grammar-picker-grid" id="modal-g-grid"></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#btn-close-g-picker').addEventListener('click', () => {
        modal.classList.add('hidden');
      });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    }

    const countBadge = modal.querySelector('#modal-g-count');
    if (countBadge) countBadge.textContent = filteredList.length.toLocaleString() + '문항';

    const grid = modal.querySelector('#modal-g-grid');
    if (grid) {
      grid.innerHTML = filteredList.slice(0, 150).map((q, idx) => {
        const isAns = userAnswers[q.id];
        let statusBadge = '';
        if (isAns) {
          statusBadge = isAns.isCorrect 
            ? `<span style="color:#10b981; font-weight:700;">✓ 정답</span>`
            : `<span style="color:#ef4444; font-weight:700;">✕ 오답</span>`;
        }

        return `
          <div class="g-picker-item ${idx === gState.currentIndex ? 'active' : ''}" data-idx="${idx}">
            <div class="g-picker-top">
              <span class="g-level-badge ${q.level}" style="font-size:0.68rem; padding:0.15rem 0.45rem;">${q.level}</span>
              ${statusBadge}
            </div>
            <div class="g-picker-pat">${q.pattern}</div>
            <div class="g-picker-mean">${q.patternMeaning}</div>
          </div>
        `;
      }).join('');

      grid.querySelectorAll('.g-picker-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.dataset.idx, 10);
          gState.currentIndex = idx;
          saveState();
          modal.classList.add('hidden');
          renderCard();
        });
      });
    }

    modal.classList.remove('hidden');
  }

  // Full Render
  function render() {
    updateLevelCounts();

    // Update active level buttons
    document.querySelectorAll('.g-level-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === gState.level);
    });

    // Update active filter chips
    document.querySelectorAll('.grammar-filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === gState.filterType);
    });

    // Update furigana button
    const btnFurigana = document.getElementById('btn-g-furigana');
    if (btnFurigana) {
      btnFurigana.classList.toggle('active', gState.showRuby);
      const dot = btnFurigana.querySelector('.pill-dot');
      if (dot) dot.classList.toggle('active', gState.showRuby);
    }
    if (gState.showRuby) {
      document.body.classList.remove('hide-furigana');
    } else {
      document.body.classList.add('hide-furigana');
    }

    // Update trans button
    const btnTrans = document.getElementById('btn-g-trans');
    if (btnTrans) {
      btnTrans.classList.toggle('active', gState.showTrans);
      const dot = btnTrans.querySelector('.pill-dot');
      if (dot) dot.classList.toggle('active', gState.showTrans);
    }

    renderCard();
  }

  function setupGlobalListeners() {
    // Level button clicks
    document.querySelectorAll('.g-level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        gState.level = btn.dataset.level;
        gState.currentIndex = 0;
        saveState();
        applyFilters();
        render();
      });
    });

    // Filter chip clicks
    document.querySelectorAll('.grammar-filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        gState.filterType = chip.dataset.filter;
        gState.currentIndex = 0;
        saveState();
        applyFilters();
        render();
      });
    });

    // Search input
    const searchInput = document.getElementById('grammar-search-input');
    const searchClear = document.getElementById('grammar-search-clear');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        gState.searchKeyword = e.target.value;
        if (searchClear) {
          searchClear.classList.toggle('visible', !!e.target.value);
        }
        gState.currentIndex = 0;
        applyFilters();
        renderCard();
      });
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        gState.searchKeyword = '';
        searchClear.classList.remove('visible');
        gState.currentIndex = 0;
        applyFilters();
        renderCard();
      });
    }

    // Furigana Toggle
    const btnFurigana = document.getElementById('btn-g-furigana');
    if (btnFurigana) {
      btnFurigana.addEventListener('click', () => {
        gState.showRuby = !gState.showRuby;
        saveState();
        render();
      });
    }

    // Translation Toggle
    const btnTrans = document.getElementById('btn-g-trans');
    if (btnTrans) {
      btnTrans.addEventListener('click', () => {
        gState.showTrans = !gState.showTrans;
        saveState();
        const transBox = document.getElementById('g-trans-box');
        if (transBox) transBox.classList.toggle('visible', gState.showTrans);
        btnTrans.classList.toggle('active', gState.showTrans);
        const dot = btnTrans.querySelector('.pill-dot');
        if (dot) dot.classList.toggle('active', gState.showTrans);

        // Also update option translations visibility in real time
        document.querySelectorAll('.g-option-card').forEach(card => {
          const transEl = card.querySelector('.g-option-trans');
          if (!transEl) return;
          const isAnswered = card.classList.contains('disabled');
          if (gState.showTrans || isAnswered) {
            transEl.classList.remove('hidden');
          } else {
            transEl.classList.add('hidden');
          }
        });
      });
    }

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Only process when grammar tab is active
      const view = document.getElementById('view-grammar');
      if (!view || !view.classList.contains('active')) return;

      // Ignore if typing inside input/textarea
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const optIdx = parseInt(e.key, 10) - 1;
        if (filteredList.length > 0) {
          const cur = filteredList[gState.currentIndex];
          if (!userAnswers[cur.id]) {
            recordAnswer(cur, optIdx);
          }
        }
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const btnNext = document.getElementById('btn-g-next');
        if (btnNext) btnNext.click();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (btnFurigana) btnFurigana.click();
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        if (btnTrans) btnTrans.click();
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        const btnRandom = document.getElementById('btn-g-random');
        if (btnRandom) btnRandom.click();
      }
    });
  }

  // Initialize
  function init() {
    loadStorage();
    applyFilters();
    setupGlobalListeners();
    render();
  }

  // Public Interface
  window.grammarApp = {
    init: init,
    render: render,
    applyFilters: applyFilters,
    updateLevelCounts: updateLevelCounts,
    updateFilterChipCounts: updateFilterChipCounts,
    getGrammarData: function () {
      return {
        grammarHistory: userAnswers,
        grammarBookmarks: Array.from(bookmarks)
      };
    },
    mergeGrammarData: function (incoming) {
      if (!incoming) return;
      let changed = false;

      if (incoming.grammarHistory && typeof incoming.grammarHistory === 'object') {
        for (const [id, ans] of Object.entries(incoming.grammarHistory)) {
          if (!userAnswers[id]) {
            userAnswers[id] = ans;
            changed = true;
          } else if ((ans.answeredAt || 0) > (userAnswers[id].answeredAt || 0)) {
            userAnswers[id] = ans;
            changed = true;
          }
        }
      }

      if (incoming.grammarBookmarks && Array.isArray(incoming.grammarBookmarks)) {
        incoming.grammarBookmarks.forEach(id => {
          if (!bookmarks.has(id)) {
            bookmarks.add(id);
            changed = true;
          }
        });
      }

      if (changed) {
        saveHistory();
        saveBookmarks();
        applyFilters();
        render();
        console.log('[Grammar] External grammar data merged successfully. Answered count:', Object.keys(userAnswers).length);
      }
    },
    reloadStorage: function () {
      loadStorage();
      applyFilters();
      render();
    }
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
