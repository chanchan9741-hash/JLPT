/**
 * JLPT MASTER - Reading Comprehension (読解) Application Module
 * High-legibility 2-Panel Interactive Reading Workspace
 */

(function () {
  'use strict';

  const STORAGE_KEYS = {
    CUSTOM_READINGS: 'jlpt_custom_readings_v1',
    READING_STATE: 'jlpt_reading_state_v1',
    READING_ANSWERS: 'jlpt_reading_answers_v1'
  };

  // Module State
  let rState = {
    level: 'ALL',
    type: 'ALL',
    fontSize: 'md',
    furigana: true,
    showTrans: false,
    showVocab: false,
    currentPassageIndex: 0,
    currentSubQIndex: 0,
    mobileView: 'both' // 'both' | 'passage' | 'questions'
  };

  // User answers per question ID: { [qId]: { selectedIndex, isCorrect, answeredAt } }
  let userAnswers = {};

  // Active passages list filtered by level & type
  let filteredPassages = [];

  let cachedPassagePanelHtml = null;
  let cachedQuizPanelHtml = null;

  function formatRuby(text) {
    if (!text) return '';
    if (text.includes('<ruby>') || text.includes('<rt>')) {
      return text;
    }
    return text.replace(/([\u4E00-\u9FAF\u3400-\u4DBF々ヶ]+)[(（]([\u3040-\u309F\u30A0-\u30FF]+)[)）]/g, (match, kanji, ruby) => '<ruby>' + kanji + '<rt>' + ruby + '</rt></ruby>');
  }

  // All passages combined (default + custom)
  function getAllPassages() {
    const defaults = window.JLPT_READING_DATA || [];
    let customs = [];
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CUSTOM_READINGS);
      if (saved) customs = JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to load custom readings:', e);
    }
    return [...defaults, ...customs];
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.READING_STATE);
      if (saved) {
        const parsed = JSON.parse(saved);
        rState = { ...rState, ...parsed };
      }
      const answersSaved = localStorage.getItem(STORAGE_KEYS.READING_ANSWERS);
      if (answersSaved) {
        userAnswers = JSON.parse(answersSaved);
      }
    } catch (e) {
      console.warn('Failed to parse reading state:', e);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEYS.READING_STATE, JSON.stringify({
        level: rState.level,
        type: rState.type,
        fontSize: rState.fontSize,
        furigana: rState.furigana,
        showTrans: rState.showTrans,
        showVocab: rState.showVocab
      }));
      localStorage.setItem(STORAGE_KEYS.READING_ANSWERS, JSON.stringify(userAnswers));
    } catch (e) {
      console.warn('Failed to save reading state:', e);
    }
  }

  // --- Filter and Passage Selection ---
  function applyFilters() {
    const all = getAllPassages();
    filteredPassages = all.filter(p => {
      let matchType = rState.type === 'ALL';
      if (!matchType) {
        if (rState.type === p.typeCode) {
          matchType = true;
        } else if ((rState.type === 'integrated' || rState.type === 'comparison') && (p.typeCode === 'integrated' || p.typeCode === 'comparison')) {
          matchType = true;
        } else if ((rState.type === 'argument' || rState.type === 'assertion') && (p.typeCode === 'argument' || p.typeCode === 'assertion')) {
          matchType = true;
        } else if ((rState.type === 'grammar_text' || rState.type === 'grammar') && (p.typeCode === 'grammar_text' || p.typeCode === 'grammar')) {
          matchType = true;
        }
      }
      return matchType;
    });

    if (rState.currentPassageIndex >= filteredPassages.length) {
      rState.currentPassageIndex = Math.max(0, filteredPassages.length - 1);
    }
    rState.currentSubQIndex = 0;

    updateHeaderBadges();
    populatePassageSelect();
  }

  function updateHeaderBadges() {
    const all = getAllPassages();
    const countAll = all.length;

    // Header nav badge count
    const headerBadge = document.getElementById('header-reading-count');
    if (headerBadge) {
      headerBadge.textContent = countAll;
      headerBadge.style.display = countAll > 0 ? 'inline-flex' : 'none';
    }
  }

  function populatePassageSelect() {
    const select = document.getElementById('select-passage');
    const counter = document.getElementById('passage-counter');
    if (!select) return;

    select.innerHTML = '';
    if (filteredPassages.length === 0) {
      select.innerHTML = '<option value="">해당 조건의 독해 지문이 없습니다</option>';
      if (counter) counter.textContent = '0 / 0';
      return;
    }

    filteredPassages.forEach((p, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = `[${p.typeName}] ${p.title} (${p.questions.length}문항)`;
      if (idx === rState.currentPassageIndex) opt.selected = true;
      select.appendChild(opt);
    });

    if (counter) {
      counter.textContent = `지문 ${rState.currentPassageIndex + 1} / ${filteredPassages.length}`;
    }
  }

  // --- Render Active Passage & Questions ---
  function renderCurrentPassage() {
    const passagePanel = document.getElementById('reading-passage-panel');
    const quizPanel = document.getElementById('reading-quiz-panel');
    if (!passagePanel || !quizPanel) return;

    if (filteredPassages.length === 0) {
      passagePanel.innerHTML = `
        <div style="text-align:center; padding:3.5rem 1rem; color:var(--text-muted);">
          <div style="font-size:2.5rem; margin-bottom:0.75rem;">📖</div>
          <div style="font-size:1.15rem; font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">
            해당 조건의 독해 지문이 없습니다.
          </div>
          <p style="font-size:0.9rem;">상단의 급수 및 유형 필터를 변경하시거나, <b>[➕ 새 지문 등록]</b>으로 지문을 추가해 보세요.</p>
        </div>
      `;
      quizPanel.innerHTML = '';
      return;
    }

    // Restore cached panel structure if previously emptied
    if (!document.getElementById('r-passage-body') && cachedPassagePanelHtml) {
      passagePanel.innerHTML = cachedPassagePanelHtml;
      quizPanel.innerHTML = cachedQuizPanelHtml;
    }

    const passage = filteredPassages[rState.currentPassageIndex];
    if (!passage) return;

    // 1. Passage Header Info
    const badgeLevel = document.getElementById('r-badge-level');
    const badgeType = document.getElementById('r-badge-type');
    const badgeTime = document.getElementById('r-badge-time');
    const titleEl = document.getElementById('r-passage-title');

    if (badgeLevel) badgeLevel.textContent = 'N1';
    if (badgeType) badgeType.textContent = passage.typeName;
    if (badgeTime) {
      badgeTime.textContent = `약 ${passage.wordCount || 300}자 · 예상 ${passage.estimatedMinutes || 4}분`;
    }
    if (titleEl) titleEl.textContent = passage.title;

    // 2. Passage Body Text
    const bodyEl = document.getElementById('r-passage-body');
    if (bodyEl) {
      bodyEl.className = `passage-body-wrapper font-size-${rState.fontSize} ${rState.furigana ? '' : 'hide-ruby'}`;
      // Use Ruby text if available and enabled, otherwise plain text
      bodyEl.innerHTML = formatRuby(passage.passageRuby || passage.passagePlain);
    }

    // 3. Translation Box
    const transBox = document.getElementById('r-passage-translation');
    const transContent = document.getElementById('r-trans-content');
    if (transBox && transContent) {
      transContent.textContent = passage.passageTrans || '번역 정보가 등록되지 않았습니다.';
      transBox.classList.toggle('hidden', !rState.showTrans);
    }

    // 4. Vocabulary & Grammar Card
    const vocabCard = document.getElementById('r-passage-vocab');
    const vocabContent = document.getElementById('r-vocab-content');
    if (vocabCard && vocabContent) {
      let vHtml = '';
      if (passage.vocabList && passage.vocabList.length > 0) {
        vHtml += '<div class="vocab-chips-grid">';
        passage.vocabList.forEach(v => {
          vHtml += `
            <div class="vocab-chip">
              <div class="vocab-word-row">
                <span class="vocab-word">${escapeHtml(v.word)}</span>
                <span class="vocab-reading">(${escapeHtml(v.reading)})</span>
              </div>
              <span class="vocab-mean">${escapeHtml(v.mean)}</span>
            </div>
          `;
        });
        vHtml += '</div>';
      }

      if (passage.grammarNotes && passage.grammarNotes.length > 0) {
        vHtml += '<div class="grammar-notes-list">';
        passage.grammarNotes.forEach(g => {
          vHtml += `
            <div class="grammar-note-item">
              <span class="grammar-pattern">✦ ${escapeHtml(g.pattern)}</span>: ${escapeHtml(g.mean)}
            </div>
          `;
        });
        vHtml += '</div>';
      }

      vocabContent.innerHTML = vHtml || '<p style="color:var(--text-muted); font-size:0.85rem;">등록된 어휘/문법 팁이 없습니다.</p>';
      vocabCard.classList.toggle('hidden', !rState.showVocab);
    }

    // 5. Render Question Area
    renderQuestionArea(passage);
  }

  function renderQuestionArea(passage) {
    const questions = passage.questions || [];
    if (questions.length === 0) return;

    // Bounds checking
    if (rState.currentSubQIndex >= questions.length) rState.currentSubQIndex = 0;
    if (rState.currentSubQIndex < 0) rState.currentSubQIndex = questions.length - 1;

    // Render Sub-question Tabs
    const tabsContainer = document.getElementById('sub-q-tabs');
    if (tabsContainer) {
      if (questions.length > 1) {
        tabsContainer.classList.remove('hidden');
        let tHtml = '';
        questions.forEach((q, idx) => {
          const ans = userAnswers[q.qId];
          let statusCls = '';
          if (ans) {
            statusCls = ans.isCorrect ? 'correct' : 'wrong';
          }
          tHtml += `
            <button class="sub-q-tab-btn ${idx === rState.currentSubQIndex ? 'active' : ''}" data-idx="${idx}">
              <span>문항 ${idx + 1}</span>
              ${ans ? `<span class="sub-q-tab-status ${statusCls}"></span>` : ''}
            </button>
          `;
        });
        tabsContainer.innerHTML = tHtml;
        tabsContainer.querySelectorAll('.sub-q-tab-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            rState.currentSubQIndex = parseInt(btn.dataset.idx, 10);
            renderCurrentPassage();
          });
        });
      } else {
        tabsContainer.classList.add('hidden');
      }
    }

    const currentQ = questions[rState.currentSubQIndex];
    if (!currentQ) return;

    // Update Mobile Count
    const mobileCount = document.getElementById('mobile-q-count');
    if (mobileCount) mobileCount.textContent = questions.length;

    // Instruction Box
    const qNumEl = document.getElementById('r-q-num');
    const qInstEl = document.getElementById('r-q-instruction');
    const qInstTransEl = document.getElementById('r-q-instruction-trans');

    if (qNumEl) qNumEl.textContent = `문항 ${rState.currentSubQIndex + 1} / ${questions.length}`;
    if (qInstEl) qInstEl.textContent = currentQ.instruction;
    if (qInstTransEl) qInstTransEl.textContent = currentQ.instructionTrans || '';

    // Options List
    const optionsContainer = document.getElementById('r-options-list');
    if (optionsContainer) {
      const existingAnswer = userAnswers[currentQ.qId];
      let oHtml = '';

      currentQ.options.forEach((opt, idx) => {
        let optStateCls = '';
        if (existingAnswer) {
          optStateCls = 'disabled ';
          if (opt.isCorrect) optStateCls += 'state-correct';
          else if (existingAnswer.selectedIndex === idx) optStateCls += 'state-wrong';
        }

        oHtml += `
          <button class="reading-option-btn ${optStateCls}" data-idx="${idx}">
            <span class="r-opt-marker">${opt.marker}</span>
            <div class="r-opt-content">
              <span class="r-opt-ja">${escapeHtml(opt.text)}</span>
              <span class="r-opt-ko ${existingAnswer || rState.showTrans ? '' : 'hidden'}">${escapeHtml(opt.trans || '')}</span>
            </div>
          </button>
        `;
      });

      optionsContainer.innerHTML = oHtml;

      // Event listener for option click
      optionsContainer.querySelectorAll('.reading-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (userAnswers[currentQ.qId]) return; // already answered
          const optIdx = parseInt(btn.dataset.idx, 10);
          handleReadingOptionSelect(passage, currentQ, optIdx);
        });
      });
    }

    // Explanation Box
    const explBox = document.getElementById('r-expl-box');
    if (explBox) {
      const existingAnswer = userAnswers[currentQ.qId];
      if (existingAnswer) {
        explBox.classList.remove('hidden');
        renderReadingExplanation(passage, currentQ, existingAnswer);
      } else {
        explBox.classList.add('hidden');
      }
    }

    // Sub-question Bottom Counter
    const subQCounter = document.getElementById('sub-q-counter');
    if (subQCounter) {
      subQCounter.textContent = `문항 ${rState.currentSubQIndex + 1} / ${questions.length}`;
    }
  }

  function handleReadingOptionSelect(passage, q, optIndex) {
    const selectedOpt = q.options[optIndex];
    if (!selectedOpt) return;

    const isCorrect = selectedOpt.isCorrect;
    userAnswers[q.qId] = {
      selectedIndex: optIndex,
      isCorrect: isCorrect,
      answeredAt: Date.now()
    };
    saveState();

    // Sound effect
    if (window.app) {
      if (isCorrect && window.app.playCorrectSound) window.app.playCorrectSound();
      else if (!isCorrect && window.app.playWrongSound) window.app.playWrongSound();
    }

    // If wrong, automatically record in Global Mistake Notebook & Anki!
    if (!isCorrect && window.app) {
      const mistakeItem = {
        id: q.qId,
        level: passage.level,
        typeCode: `reading_${passage.typeCode}`,
        typeName: `독해 - ${passage.typeName}`,
        instruction: `[지문: ${passage.title}] ${q.instruction}`,
        qPlain: `【지문 요약】\n${passage.passagePlain.slice(0, 180)}...\n\n【문제】\n${q.instruction}`,
        qRuby: `【지문】\n${passage.title}\n\n【문제】\n${q.instruction}`,
        qTrans: `【해석】\n${passage.passageTrans ? passage.passageTrans.slice(0, 150) + '...' : ''}\n\n【질문】\n${q.instructionTrans || ''}`,
        options: q.options.map(o => ({
          marker: o.marker,
          copy: o.text,
          copyNoRuby: o.text,
          trans: o.trans,
          isCorrect: o.isCorrect
        })),
        ansJa: q.ansJa || `${q.options.find(o => o.isCorrect)?.marker} ${q.options.find(o => o.isCorrect)?.text}`,
        ansKo: q.ansKo || `${q.options.find(o => o.isCorrect)?.trans}`,
        expl: {
          main: `[정답 근거] ${q.evidenceText || ''}\n\n${q.expl?.main || ''}`,
          choices: q.expl?.choices || []
        },
        userAnswer: selectedOpt.marker,
        userAnswerText: selectedOpt.text
      };

      if (window.app.recordReadingMistake) {
        window.app.recordReadingMistake(mistakeItem);
      }
    }

    // Refresh Question Area to show feedback & explanation
    renderCurrentPassage();
  }

  function renderReadingExplanation(passage, q, ansRecord) {
    const banner = document.getElementById('r-result-banner');
    const bannerIcon = document.getElementById('r-result-icon');
    const bannerText = document.getElementById('r-result-text');
    const noteTag = document.getElementById('r-note-tag');

    if (banner && bannerIcon && bannerText) {
      if (ansRecord.isCorrect) {
        banner.className = 'result-banner correct';
        bannerIcon.textContent = '✓';
        bannerText.textContent = '정답입니다!';
        if (noteTag) noteTag.classList.add('hidden');
      } else {
        banner.className = 'result-banner wrong';
        bannerIcon.textContent = '✕';
        bannerText.textContent = '오답입니다. 해설과 지문 근거를 확인해 보세요.';
        if (noteTag) noteTag.classList.remove('hidden');
      }
    }

    // Evidence Quote
    const evidenceBox = document.getElementById('r-evidence-box');
    const evidenceText = document.getElementById('r-evidence-text');
    if (evidenceBox && evidenceText) {
      if (q.evidenceText) {
        evidenceBox.classList.remove('hidden');
        evidenceText.textContent = `“${q.evidenceText}”`;
        // Click on evidence -> highlight in passage
        evidenceBox.onclick = () => {
          highlightEvidenceInPassage(q.evidenceText);
        };
      } else {
        evidenceBox.classList.add('hidden');
      }
    }

    // Main Point
    const mainText = document.getElementById('r-expl-main');
    if (mainText) {
      mainText.textContent = q.expl?.main || '해설이 준비되어 있지 않습니다.';
    }

    // Choice Breakdown
    const choicesList = document.getElementById('r-choice-notes');
    if (choicesList) {
      let cHtml = '';
      if (q.expl && q.expl.choices) {
        q.expl.choices.forEach(c => {
          cHtml += `
            <div class="choice-note-item">
              <span class="choice-note-marker">${c.marker}</span>
              <span class="choice-note-text">${escapeHtml(c.note)}</span>
            </div>
          `;
        });
      }
      choicesList.innerHTML = cHtml;
    }
  }

  function highlightEvidenceInPassage(evidenceQuote) {
    const bodyEl = document.getElementById('r-passage-body');
    if (!bodyEl) return;

    // Scroll to passage panel on mobile
    if (window.innerWidth <= 1024) {
      if (rState.mobileView === 'questions') {
        switchMobileView('both');
      }
    }

    // Find snippet and wrap in highlight span
    const cleanQuote = evidenceQuote.replace(/[「」『』"]/g, '').trim().slice(0, 20);
    const text = bodyEl.innerHTML;

    // Flash animation on passage card
    const passagePanel = document.getElementById('reading-passage-panel');
    if (passagePanel) {
      passagePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      passagePanel.style.transition = 'box-shadow 0.4s ease';
      passagePanel.style.boxShadow = '0 0 25px rgba(245, 158, 11, 0.45)';
      setTimeout(() => {
        passagePanel.style.boxShadow = '';
      }, 1500);
    }

    if (window.app && window.app.showToast) {
      window.app.showToast('🎯 지문에서 정답의 핵심 근거 위치를 확인하세요.');
    }
  }

  // --- Mobile Floating Quick Passage Drawer ---
  function openPassageDrawer() {
    const overlay = document.getElementById('mobile-passage-drawer-overlay');
    const drawerTitle = document.getElementById('drawer-title');
    const drawerLevel = document.getElementById('drawer-badge-level');
    const drawerBody = document.getElementById('drawer-passage-body');
    const passage = filteredPassages[rState.currentPassageIndex];

    if (!overlay || !drawerBody || !passage) return;

    if (drawerTitle) drawerTitle.textContent = passage.title;
    if (drawerLevel) drawerLevel.textContent = 'N1';
    drawerBody.innerHTML = formatRuby(passage.passageRuby || passage.passagePlain);
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closePassageDrawer() {
    const overlay = document.getElementById('mobile-passage-drawer-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // --- Mobile View Switcher ---
  function switchMobileView(view) {
    rState.mobileView = view || 'both';
    const btnPassage = document.getElementById('btn-mobile-view-passage');
    const btnSplit = document.getElementById('btn-mobile-view-split');
    const btnQuestions = document.getElementById('btn-mobile-view-questions');
    const panelPassage = document.getElementById('reading-passage-panel');
    const panelQuiz = document.getElementById('reading-quiz-panel');
    const floatPeekBtn = document.getElementById('btn-float-peek-passage');

    if (btnPassage) btnPassage.classList.toggle('active', rState.mobileView === 'passage');
    if (btnSplit) btnSplit.classList.toggle('active', rState.mobileView === 'both');
    if (btnQuestions) btnQuestions.classList.toggle('active', rState.mobileView === 'questions');

    if (rState.mobileView === 'both') {
      if (panelPassage) panelPassage.classList.remove('mobile-hidden');
      if (panelQuiz) panelQuiz.classList.remove('mobile-hidden');
      if (floatPeekBtn) floatPeekBtn.classList.add('hidden');
    } else if (rState.mobileView === 'passage') {
      if (panelPassage) panelPassage.classList.remove('mobile-hidden');
      if (panelQuiz) panelQuiz.classList.add('mobile-hidden');
      if (floatPeekBtn) floatPeekBtn.classList.add('hidden');
    } else if (rState.mobileView === 'questions') {
      if (panelPassage) panelPassage.classList.add('mobile-hidden');
      if (panelQuiz) panelQuiz.classList.remove('mobile-hidden');
      if (floatPeekBtn && window.innerWidth <= 1024) {
        floatPeekBtn.classList.remove('hidden');
      }
    }
  }

  // --- Add Reading Passage Modal ---
  function setupAddReadingModal() {
    const btnOpen = document.getElementById('btn-open-add-reading');
    const modal = document.getElementById('modal-reading-add');
    const btnClose = document.getElementById('btn-close-reading-add');
    const btnCancel = document.getElementById('btn-cancel-reading-add');
    const btnSubmit = document.getElementById('btn-submit-reading-add');
    const btnLoadSample = document.getElementById('btn-load-sample-reading-json');
    const textarea = document.getElementById('textarea-reading-json');

    if (!modal) return;

    const closeModal = () => modal.classList.add('hidden');
    const openModal = () => {
      modal.classList.remove('hidden');
      if (textarea && !textarea.value) {
        textarea.placeholder = JSON.stringify(getSampleReadingJson(), null, 2);
      }
    };

    if (btnOpen) btnOpen.addEventListener('click', openModal);
    if (btnClose) btnClose.addEventListener('click', closeModal);
    if (btnCancel) btnCancel.addEventListener('click', closeModal);

    if (btnLoadSample && textarea) {
      btnLoadSample.addEventListener('click', () => {
        textarea.value = JSON.stringify(getSampleReadingJson(), null, 2);
      });
    }

    if (btnSubmit && textarea) {
      btnSubmit.addEventListener('click', () => {
        const val = textarea.value.trim();
        if (!val) {
          alert('독해 JSON 데이터를 입력해 주세요.');
          return;
        }

        try {
          const parsed = JSON.parse(val);
          const items = Array.isArray(parsed) ? parsed : [parsed];

          // Validate items
          for (const item of items) {
            if (!item.title || !item.passagePlain || !item.questions || item.questions.length === 0) {
              throw new Error('필수 속성(title, passagePlain, questions)이 누락되었습니다.');
            }
            if (!item.id) item.id = 'RD-CUSTOM-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
            if (!item.level) item.level = 'N1';
            if (!item.typeCode) item.typeCode = 'short';
            if (!item.typeName) item.typeName = '단문 독해';
          }

          // Save to LocalStorage
          const customs = [];
          try {
            const saved = localStorage.getItem(STORAGE_KEYS.CUSTOM_READINGS);
            if (saved) customs.push(...JSON.parse(saved));
          } catch (e) {}

          customs.push(...items);
          localStorage.setItem(STORAGE_KEYS.CUSTOM_READINGS, JSON.stringify(customs));

          // Set level filter to the new passage's level and switch to it
          rState.level = items[0].level;
          rState.type = 'ALL';
          applyFilters();
          rState.currentPassageIndex = filteredPassages.findIndex(p => p.id === items[0].id);
          if (rState.currentPassageIndex === -1) rState.currentPassageIndex = 0;
          renderCurrentPassage();

          closeModal();
          textarea.value = '';

          if (window.app && window.app.showToast) {
            window.app.showToast(`🎉 새로운 독해 지문 ${items.length}개가 등록되었습니다!`);
          }
        } catch (err) {
          alert('JSON 형식이 올바르지 않습니다: ' + err.message);
        }
      });
    }
  }

  function getSampleReadingJson() {
    return {
      level: "N1",
      typeCode: "short",
      typeName: "단문 독해",
      title: "스캔본으로 변환된 새 독해 지문 샘플",
      wordCount: 250,
      estimatedMinutes: 3,
      passagePlain: "ここに日本語の読解本文を入力します。段落ごとに改行を入れ、重要な文は下線タグ<u></u>で囲むことができます。",
      passageRuby: "ここに日本語(にほんご)の読解本文(どっかいほんぶん)を入力(にゅうりょく)します。",
      passageTrans: "여기에 본문의 한국어 전체 번역을 입력합니다.",
      vocabList: [
        { word: "読解", reading: "どっかい", mean: "독해" },
        { word: "重要", reading: "じゅうよう", mean: "중요" }
      ],
      grammarNotes: [
        { pattern: "〜ごとに", mean: "~마다" }
      ],
      questions: [
        {
          qId: "RD-SAMPLE-Q1",
          qNum: 1,
          instruction: "筆者が最も伝えたいことは何か。",
          instructionTrans: "필자가 가장 전달하고자 하는 바는 무엇인가?",
          options: [
            { marker: "①", text: "選択肢 1 番", trans: "선택지 1번 해석", isCorrect: false },
            { marker: "②", text: "選択肢 2 番（正解）", trans: "선택지 2번 해석 (정답)", isCorrect: true },
            { marker: "③", text: "選択肢 3 番", trans: "선택지 3번 해석", isCorrect: false },
            { marker: "④", text: "選択肢 4 番", trans: "선택지 4번 해석", isCorrect: false }
          ],
          evidenceText: "ここに正解の根拠となる本文の文を引用します。",
          expl: {
            main: "정답의 이유와 핵심 포인트를 설명합니다.",
            choices: [
              { marker: "①", note: "오답인 이유" },
              { marker: "②", note: "본문 내용과 일치하므로 정답" },
              { marker: "③", note: "오답인 이유" },
              { marker: "④", note: "오답인 이유" }
            ]
          }
        }
      ]
    };
  }

  // --- Keyboard Shortcuts & Event Listeners ---
  function setupEventListeners() {
    // Type Filter Chips
    document.querySelectorAll('#reading-type-filter .chip-sm').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#reading-type-filter .chip-sm').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        rState.type = chip.dataset.rType;
        rState.currentPassageIndex = 0;
        applyFilters();
        renderCurrentPassage();
        saveState();
      });
    });

    // Font Size Switcher
    document.querySelectorAll('.font-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.font-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        rState.fontSize = btn.dataset.size;
        const bodyEl = document.getElementById('r-passage-body');
        if (bodyEl) {
          bodyEl.className = `passage-body-wrapper font-size-${rState.fontSize} ${rState.furigana ? '' : 'hide-ruby'}`;
        }
        saveState();
      });
    });

    // Furigana Toggle
    const btnFurigana = document.getElementById('btn-reading-furigana');
    if (btnFurigana) {
      btnFurigana.addEventListener('click', () => {
        rState.furigana = !rState.furigana;
        btnFurigana.classList.toggle('active', rState.furigana);
        const dot = btnFurigana.querySelector('.pill-dot');
        if (dot) dot.classList.toggle('active', rState.furigana);
        const bodyEl = document.getElementById('r-passage-body');
        if (bodyEl) {
          bodyEl.classList.toggle('hide-ruby', !rState.furigana);
        }
        saveState();
      });
    }

    // Full Translation Toggle
    const btnTrans = document.getElementById('btn-reading-trans');
    const transBox = document.getElementById('r-passage-translation');
    const btnCloseTrans = document.getElementById('btn-close-trans');

    if (btnTrans) {
      btnTrans.addEventListener('click', () => {
        rState.showTrans = !rState.showTrans;
        btnTrans.classList.toggle('active', rState.showTrans);
        const dot = btnTrans.querySelector('.pill-dot');
        if (dot) dot.classList.toggle('active', rState.showTrans);
        if (transBox) transBox.classList.toggle('hidden', !rState.showTrans);
        // Show/hide options korean translations
        document.querySelectorAll('.r-opt-ko').forEach(el => {
          el.classList.toggle('hidden', !rState.showTrans);
        });
        saveState();
      });
    }

    if (btnCloseTrans) {
      btnCloseTrans.addEventListener('click', () => {
        rState.showTrans = false;
        if (btnTrans) btnTrans.classList.remove('active');
        const dot = btnTrans ? btnTrans.querySelector('.pill-dot') : null;
        if (dot) dot.classList.remove('active');
        if (transBox) transBox.classList.add('hidden');
        saveState();
      });
    }

    // Vocabulary Panel Toggle
    const btnVocab = document.getElementById('btn-reading-vocab-toggle');
    const vocabCard = document.getElementById('r-passage-vocab');
    const btnCloseVocab = document.getElementById('btn-close-vocab');

    if (btnVocab) {
      btnVocab.addEventListener('click', () => {
        rState.showVocab = !rState.showVocab;
        if (vocabCard) vocabCard.classList.toggle('hidden', !rState.showVocab);
        saveState();
      });
    }

    if (btnCloseVocab) {
      btnCloseVocab.addEventListener('click', () => {
        rState.showVocab = false;
        if (vocabCard) vocabCard.classList.add('hidden');
        saveState();
      });
    }

    // Passage Navigation
    const selectPassage = document.getElementById('select-passage');
    if (selectPassage) {
      selectPassage.addEventListener('change', (e) => {
        rState.currentPassageIndex = parseInt(e.target.value, 10) || 0;
        rState.currentSubQIndex = 0;
        renderCurrentPassage();
        const counter = document.getElementById('passage-counter');
        if (counter) counter.textContent = `지문 ${rState.currentPassageIndex + 1} / ${filteredPassages.length}`;
      });
    }

    const btnPrevPassage = document.getElementById('btn-prev-passage');
    const btnNextPassage = document.getElementById('btn-next-passage');

    if (btnPrevPassage) {
      btnPrevPassage.addEventListener('click', () => {
        if (filteredPassages.length === 0) return;
        rState.currentPassageIndex = (rState.currentPassageIndex - 1 + filteredPassages.length) % filteredPassages.length;
        rState.currentSubQIndex = 0;
        populatePassageSelect();
        renderCurrentPassage();
      });
    }

    if (btnNextPassage) {
      btnNextPassage.addEventListener('click', () => {
        if (filteredPassages.length === 0) return;
        rState.currentPassageIndex = (rState.currentPassageIndex + 1) % filteredPassages.length;
        rState.currentSubQIndex = 0;
        populatePassageSelect();
        renderCurrentPassage();
      });
    }

    // Sub-question Prev/Next Buttons
    const btnPrevSubQ = document.getElementById('btn-prev-sub-q');
    const btnNextSubQ = document.getElementById('btn-next-sub-q');

    if (btnPrevSubQ) {
      btnPrevSubQ.addEventListener('click', () => {
        const passage = filteredPassages[rState.currentPassageIndex];
        if (!passage || !passage.questions) return;
        if (rState.currentSubQIndex > 0) {
          rState.currentSubQIndex--;
          renderCurrentPassage();
        } else {
          // If on first question, move to previous passage!
          if (filteredPassages.length > 1) {
            rState.currentPassageIndex = (rState.currentPassageIndex - 1 + filteredPassages.length) % filteredPassages.length;
            const prevPassage = filteredPassages[rState.currentPassageIndex];
            rState.currentSubQIndex = (prevPassage && prevPassage.questions && prevPassage.questions.length > 0) ? prevPassage.questions.length - 1 : 0;
            populatePassageSelect();
            renderCurrentPassage();
            if (window.app && window.app.showToast) {
              window.app.showToast('⬅️ 이전 독해 지문으로 이동했습니다.');
            }
          }
        }
        if (window.innerWidth <= 820) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    if (btnNextSubQ) {
      btnNextSubQ.addEventListener('click', () => {
        const passage = filteredPassages[rState.currentPassageIndex];
        if (!passage || !passage.questions) return;
        if (rState.currentSubQIndex + 1 < passage.questions.length) {
          rState.currentSubQIndex++;
          renderCurrentPassage();
        } else {
          // If on last question, move to next passage!
          if (filteredPassages.length > 1) {
            rState.currentPassageIndex = (rState.currentPassageIndex + 1) % filteredPassages.length;
            rState.currentSubQIndex = 0;
            populatePassageSelect();
            renderCurrentPassage();
            if (window.app && window.app.showToast) {
              window.app.showToast('➡️ 다음 독해 지문으로 이동했습니다.');
            }
          }
        }
        if (window.innerWidth <= 820) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    // Mobile View Switcher Buttons
    const btnMobilePassage = document.getElementById('btn-mobile-view-passage');
    const btnMobileSplit = document.getElementById('btn-mobile-view-split');
    const btnMobileQuestions = document.getElementById('btn-mobile-view-questions');
    const btnFloatPeek = document.getElementById('btn-float-peek-passage');
    const btnCloseDrawer = document.getElementById('btn-close-drawer');
    const drawerOverlay = document.getElementById('mobile-passage-drawer-overlay');

    if (btnMobilePassage) {
      btnMobilePassage.addEventListener('click', () => switchMobileView('passage'));
    }
    if (btnMobileSplit) {
      btnMobileSplit.addEventListener('click', () => switchMobileView('both'));
    }
    if (btnMobileQuestions) {
      btnMobileQuestions.addEventListener('click', () => switchMobileView('questions'));
    }
    if (btnFloatPeek) {
      btnFloatPeek.addEventListener('click', openPassageDrawer);
    }
    if (btnCloseDrawer) {
      btnCloseDrawer.addEventListener('click', closePassageDrawer);
    }
    if (drawerOverlay) {
      drawerOverlay.addEventListener('click', (e) => {
        if (e.target === drawerOverlay) closePassageDrawer();
      });
    }

    // Keyboard Shortcuts (1~4 to select option when Reading Tab is active)
    document.addEventListener('keydown', (e) => {
      const readingView = document.getElementById('view-reading');
      if (!readingView || !readingView.classList.contains('active')) return;

      // Don't capture when typing in inputs/textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      const passage = filteredPassages[rState.currentPassageIndex];
      if (!passage || !passage.questions) return;
      const currentQ = passage.questions[rState.currentSubQIndex];
      if (!currentQ) return;

      const key = e.key;
      if (['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        const optIdx = parseInt(key, 10) - 1;
        if (!userAnswers[currentQ.qId]) {
          handleReadingOptionSelect(passage, currentQ, optIdx);
        }
      } else if (e.code === 'Space') {
        // Space advances sub question or passage
        e.preventDefault();
        if (btnNextSubQ) btnNextSubQ.click();
      }
    });

    setupAddReadingModal();
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

  // Initializer
  function init() {
    const passagePanel = document.getElementById('reading-passage-panel');
    const quizPanel = document.getElementById('reading-quiz-panel');
    if (passagePanel) cachedPassagePanelHtml = passagePanel.innerHTML;
    if (quizPanel) cachedQuizPanelHtml = quizPanel.innerHTML;

    loadState();
    setupEventListeners();
    applyFilters();
    renderCurrentPassage();
    switchMobileView(rState.mobileView || 'both');
  }

  // Public API
  window.readingApp = {
    init,
    render: () => {
      applyFilters();
      renderCurrentPassage();
      switchMobileView(rState.mobileView || 'both');
    },
    addNewPassages: (passages) => {
      const customs = [];
      try {
        const saved = localStorage.getItem(STORAGE_KEYS.CUSTOM_READINGS);
        if (saved) customs.push(...JSON.parse(saved));
      } catch (e) {}
      customs.push(...(Array.isArray(passages) ? passages : [passages]));
      localStorage.setItem(STORAGE_KEYS.CUSTOM_READINGS, JSON.stringify(customs));
      applyFilters();
      renderCurrentPassage();
    }
  };

  // Launch on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
