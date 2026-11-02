/**
 * JLPT MASTER - Firebase Real-time Cloud Sync & Google Auth
 * Enables multi-user isolated databases and cross-device instant synchronization.
 */

window.JLPT_FIREBASE = (function () {
  'use strict';

  // [USER CONFIGURATION]
  // Default placeholder or dynamically injected
  let firebaseConfig = window.__FIREBASE_CONFIG__ || {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
  };

  const MAX_SINGLE_DOC_BYTES = 820000; // Safe margin under Firestore 1,048,576 bytes (1 MiB) limit
  const CHUNK_STRING_SIZE = 240000;    // ~240k chars (~450-700 KB UTF-8) per overflow chunk doc

  let isInitialized = false;
  let currentUser = null;
  let unsubscribeSnapshot = null;
  let isSyncingToCloud = false;
  let hasReceivedInitialSnapshot = false;
  let lastSyncError = null;

  function isConfigured() {
    return firebaseConfig &&
      firebaseConfig.apiKey &&
      !firebaseConfig.apiKey.startsWith("YOUR_");
  }

  function getUtf8ByteLength(str) {
    if (!str) return 0;
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length;
    }
    return unescape(encodeURIComponent(str)).length;
  }

  /**
   * Splits any string into chunks where EVERY chunk is strictly <= maxBytes in UTF-8
   * without breaking surrogate pairs or multi-byte Korean/Japanese characters.
   */
  function splitStringByMaxUtf8Bytes(str, maxBytes) {
    if (!str) return [''];
    if (getUtf8ByteLength(str) <= maxBytes) return [str];
    const chunks = [];
    let start = 0;
    const len = str.length;
    while (start < len) {
      // Worst-case UTF-8 is 3 bytes per BMP char (4 for astral), start conservatively and expand
      let step = Math.max(1, Math.floor(maxBytes / 3));
      let end = Math.min(len, start + step);
      // Avoid splitting UTF-16 surrogate pair
      if (end < len) {
        const code = str.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end--;
      }
      while (end < len) {
        const nextStep = Math.min(len - end, Math.floor((maxBytes - getUtf8ByteLength(str.slice(start, end))) / 3));
        if (nextStep < 1024) break;
        end += nextStep;
        if (end < len) {
          const code = str.charCodeAt(end - 1);
          if (code >= 0xD800 && code <= 0xDBFF) end--;
        }
      }
      while (getUtf8ByteLength(str.slice(start, end)) > maxBytes && end > start + 1) {
        end = Math.max(start + 1, end - 2048);
      }
      chunks.push(str.slice(start, end));
      start = end;
    }
    return chunks;
  }

  function safeJsonParse(str, fallback) {
    if (typeof str !== 'string' || !str) return fallback;
    try {
      return JSON.parse(str);
    } catch (e) {
      console.error('[Firebase] JSON parse error:', e);
      return fallback;
    }
  }

  /**
   * Slims built-in mistakes and deduplicates identical ruby fields on external mistakes
   * to keep payload compact while preserving 100% of external question content.
   */
  function buildCompactMistakes(mistakes) {
    const cloudMistakes = {};
    for (const id in (mistakes || {})) {
      const m = mistakes[id];
      if (!m) continue;
      const isBuiltIn = id.match(/^(N[1-5]-|GM-|SN-|R-|G-)/i) &&
        !id.startsWith('NH-') &&
        m.typeCode !== 'external' &&
        m.source !== 'nihonez';

      if (!isBuiltIn) {
        const copyObj = {
          ...m,
          lastModified: m.lastModified || m.masteredDate || m.lastWrongDate || Date.now()
        };
        if (copyObj.qRuby && copyObj.qPlain && copyObj.qRuby === copyObj.qPlain) {
          delete copyObj.qRuby;
        }
        if (Array.isArray(copyObj.options)) {
          copyObj.options = copyObj.options.map(opt => {
            if (!opt || typeof opt !== 'object') return opt;
            const o = { ...opt };
            if (o.copyNoRuby && o.copy && o.copyNoRuby === o.copy) {
              delete o.copyNoRuby;
            }
            return o;
          });
        }
        cloudMistakes[id] = copyObj;
      } else {
        cloudMistakes[id] = {
          id: m.id || id,
          level: m.level || 'N1',
          typeCode: m.typeCode || 'grammar',
          typeName: m.typeName || '',
          count: m.count || 1,
          firstWrongDate: m.firstWrongDate || Date.now(),
          lastWrongDate: m.lastWrongDate || Date.now(),
          wrongChoice: m.wrongChoice || '',
          isMastered: !!m.isMastered,
          isBookmarked: !!m.isBookmarked,
          lastModified: m.lastModified || m.masteredDate || m.lastWrongDate || Date.now(),
          masteredDate: m.masteredDate || null
        };
      }
    }
    return cloudMistakes;
  }

  function restoreMistakesFields(mistakesMap) {
    const out = {};
    for (const id in (mistakesMap || {})) {
      const m = mistakesMap[id];
      if (!m || typeof m !== 'object') continue;
      const restored = { ...m };
      if (!restored.qRuby && restored.qPlain) {
        restored.qRuby = restored.qPlain;
      }
      if (Array.isArray(restored.options)) {
        restored.options = restored.options.map(opt => {
          if (!opt || typeof opt !== 'object') return opt;
          return {
            ...opt,
            copyNoRuby: opt.copyNoRuby || opt.copy || ''
          };
        });
      }
      out[id] = restored;
    }
    return out;
  }

  /**
   * Unpacks both legacy nested-map Firestore documents (v1) AND serialized JSON documents (json_v2),
   * including multi-document overflow chunks if present.
   */
  async function unpackCloudDoc(rawDoc, dataCollectionRef) {
    if (!rawDoc) return null;

    // Multi-document UTF-8 byte-capped chunked bundle (> 780 KB total)
    if (rawDoc.storageFormat === 'json_v2_chunked') {
      const chunkCount = Number(rawDoc.bundleChunkCount || 1);
      const parts = [rawDoc.bundleChunk0 || ''];
      if (chunkCount > 1 && dataCollectionRef) {
        for (let i = 1; i < chunkCount; i++) {
          const chunkSnap = await dataCollectionRef.doc(`jlpt_chunk_${i}`).get();
          if (chunkSnap.exists) {
            const chunkData = chunkSnap.data();
            parts.push((chunkData && chunkData.data) ? chunkData.data : '');
          }
        }
      }
      const bundle = safeJsonParse(parts.join(''), {});
      return {
        mistakes: restoreMistakesFields(bundle.mistakes || {}),
        deletedMistakes: bundle.deletedMistakes || {},
        history: bundle.history || {},
        bookmarks: bundle.bookmarks || [],
        srs: bundle.srs || {},
        dailyStats: bundle.dailyStats || {},
        grammarHistory: bundle.grammarHistory || {},
        grammarBookmarks: bundle.grammarBookmarks || [],
        lastUpdatedClient: rawDoc.lastUpdatedClient || 0,
        userEmail: rawDoc.userEmail || '',
        userName: rawDoc.userName || ''
      };
    }

    // Legacy v1 format (nested Firestore maps)
    if (rawDoc.storageFormat !== 'json_v2' && typeof rawDoc.mistakesJson !== 'string') {
      return rawDoc;
    }

    let mistakesJsonStr = rawDoc.mistakesJson || '{}';
    const chunkCount = Number(rawDoc.mistakesChunkCount || 0);
    if (chunkCount > 1 && dataCollectionRef) {
      const parts = [mistakesJsonStr];
      for (let i = 1; i < chunkCount; i++) {
        const chunkSnap = await dataCollectionRef.doc(`jlpt_chunk_${i}`).get();
        if (chunkSnap.exists) {
          const chunkData = chunkSnap.data();
          parts.push((chunkData && chunkData.data) ? chunkData.data : '');
        }
      }
      mistakesJsonStr = parts.join('');
    }

    const parsedMistakes = restoreMistakesFields(safeJsonParse(mistakesJsonStr, {}));

    return {
      mistakes: parsedMistakes,
      deletedMistakes: safeJsonParse(rawDoc.deletedMistakesJson, rawDoc.deletedMistakes || {}),
      history: safeJsonParse(rawDoc.historyJson, rawDoc.history || {}),
      bookmarks: safeJsonParse(rawDoc.bookmarksJson, rawDoc.bookmarks || []),
      srs: safeJsonParse(rawDoc.srsJson, rawDoc.srs || {}),
      dailyStats: safeJsonParse(rawDoc.dailyStatsJson, rawDoc.dailyStats || {}),
      grammarHistory: safeJsonParse(rawDoc.grammarHistoryJson, rawDoc.grammarHistory || {}),
      grammarBookmarks: safeJsonParse(rawDoc.grammarBookmarksJson, rawDoc.grammarBookmarks || []),
      lastUpdatedClient: rawDoc.lastUpdatedClient || 0,
      userEmail: rawDoc.userEmail || '',
      userName: rawDoc.userName || ''
    };
  }

  function formatSyncError(err) {
    if (!err) return '알 수 없는 오류';
    const code = err.code || '';
    const msg = err.message || String(err);
    if (code === 'permission-denied' || /Missing or insufficient permissions/i.test(msg)) {
      return 'Firebase 보안 규칙 승인 필요 (권한 만료/차단)';
    }
    if (code === 'invalid-argument' && /index entries/i.test(msg)) {
      return '인덱스 한도 초과 (자동 압축 적용 필요)';
    }
    if (code === 'invalid-argument' && /exceeds the maximum allowed size/i.test(msg)) {
      return '문서 용량 1MB 초과';
    }
    if (code === 'resource-exhausted') {
      return 'Firebase 일일 무료 할당량 초과';
    }
    if (code === 'unavailable' || /network|offline/i.test(msg)) {
      return '네트워크 연결 불안정';
    }
    return `클라우드 업로드 실패 (${code || '오류'})`;
  }

  function init() {
    if (!window.firebase) {
      console.warn('[Firebase] SDK not loaded.');
      return;
    }

    // Check saved config in localStorage
    try {
      const saved = localStorage.getItem('JLPT_FIREBASE_CONFIG');
      if (saved) {
        firebaseConfig = JSON.parse(saved);
      }
    } catch (e) { }

    if (!isConfigured()) {
      console.log('[Firebase] Waiting for valid firebaseConfig from user.');
      renderAuthUI(null);
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      isInitialized = true;
      console.log('[Firebase] App initialized successfully.');

      // Check redirect result on load (crucial for mobile devices!)
      firebase.auth().getRedirectResult().then((result) => {
        if (result && result.user) {
          console.log('[Firebase] Mobile redirect login successful:', result.user.email);
          handleAuthStateChanged(result.user);
          if (window.showToast) window.showToast('✅ Google 로그인 완료: ' + (result.user.displayName || result.user.email));
        }
      }).catch((err) => {
        console.error('[Firebase] Redirect result error:', err);
        if (err.code === 'auth/unauthorized-domain') {
          alert('⚠️ [도메인 미승인 오류]\nFirebase 콘솔의 [Authentication] > [설정] > [승인된 도메인]에\nchanchan9741-hash.github.io\n를 추가해 주셔야 로그인할 수 있습니다!');
        } else if (err.code && err.code !== 'auth/null-user') {
          alert('로그인 오류: ' + err.message);
        }
      });

      // Listen for auth state changes
      firebase.auth().onAuthStateChanged(handleAuthStateChanged);
    } catch (err) {
      console.error('[Firebase] Initialization error:', err);
    }
  }

  // Set config dynamically
  function setConfig(newConfig) {
    if (newConfig && newConfig.apiKey) {
      firebaseConfig = newConfig;
      localStorage.setItem('JLPT_FIREBASE_CONFIG', JSON.stringify(newConfig));
      init();
    }
  }

  async function handleAuthStateChanged(user) {
    currentUser = user;
    hasReceivedInitialSnapshot = false;
    lastSyncError = null;
    renderAuthUI(user);

    if (user) {
      console.log('[Firebase] Logged in as:', user.displayName, user.email, user.uid);
      updateSyncStatusUI('connected', '클라우드 동기화 중 (' + (user.displayName || user.email.split('@')[0]) + ')');

      // Start realtime listening (will merge cloud first, then upload any unsaved/newer local records)
      startRealtimeSync(user.uid);
    } else {
      console.log('[Firebase] User logged out.');
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }
      updateSyncStatusUI('offline', '로컬 저장 모드 (게스트)');
    }
  }

  function startRealtimeSync(uid) {
    if (!isInitialized || !currentUser) return;
    const db = firebase.firestore();
    const dataColRef = db.collection('users').doc(uid).collection('data');
    const docRef = dataColRef.doc('jlpt');

    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
    }

    unsubscribeSnapshot = docRef.onSnapshot(async (doc) => {
      if (isSyncingToCloud) return; // Prevent echo loop
      if (doc.metadata && doc.metadata.hasPendingWrites) return; // Prevent local write echo loop

      hasReceivedInitialSnapshot = true;
      lastSyncError = null;
      renderAuthUI(currentUser);

      if (doc.exists) {
        const rawDoc = doc.data();
        const needsLegacyUpgrade = (rawDoc.storageFormat !== 'json_v2' && rawDoc.storageFormat !== 'json_v2_chunked');
        const cloudData = await unpackCloudDoc(rawDoc, dataColRef);
        console.log('[Firebase] Received cloud update (format=' + (rawDoc.storageFormat || 'legacy_v1') + ')');
        updateSyncStatusUI('connected', '클라우드 실시간 동기화 중');

        // Store pending cloud data so app can pick it up if not ready yet
        window.__PENDING_CLOUD_DATA__ = cloudData;

        // Merge cloud data into current app state
        if (window.app && typeof window.app.mergeExternalData === 'function') {
          window.app.mergeExternalData(cloudData);
        }
        if (window.grammarApp && typeof window.grammarApp.mergeGrammarData === 'function') {
          window.grammarApp.mergeGrammarData(cloudData);
        }

        // Automatic two-way sync: If local has more data, unsaved mistakes, or legacy v1 doc needs json_v2 upgrade
        try {
          let localPayload = window.app && window.app.getAppData ? window.app.getAppData() : null;
          if (!localPayload) {
            try {
              localPayload = {
                mistakes: JSON.parse(localStorage.getItem('jlpt_mistakes_v1') || '{}'),
                srs: JSON.parse(localStorage.getItem('jlpt_srs_v1') || '{}'),
                history: JSON.parse(localStorage.getItem('jlpt_history_v1') || '{}'),
                dailyStats: JSON.parse(localStorage.getItem('jlpt_daily_stats_v1') || '{}'),
                grammarHistory: JSON.parse(localStorage.getItem('jlpt_grammar_history_v1') || '{}')
              };
            } catch (e) {}
          }
          if (localPayload) {
            const localMistakes = localPayload.mistakes || {};
            const cloudMistakes = cloudData.mistakes || {};
            const localMistakesKeys = Object.keys(localMistakes);
            const localDeleted = (window.app && typeof window.app.getDeletedMistakes === 'function')
              ? window.app.getDeletedMistakes()
              : JSON.parse(localStorage.getItem('jlpt_deleted_mistakes_v1') || '{}');
            const cloudDeleted = cloudData.deletedMistakes || {};

            const hasMissingMistakesInCloud = localMistakesKeys.some(id => !cloudMistakes[id] && !cloudDeleted[id] && !localDeleted[id]);
            const hasMissingSrsInCloud = Object.keys(localPayload.srs || {}).some(id => (!cloudData.srs || !cloudData.srs[id]) && !cloudDeleted[id] && !localDeleted[id]);
            const hasUnsyncedTombstones = Object.keys(localDeleted).some(id => !cloudDeleted[id]);
            const localHistCount = Object.keys(localPayload.history || {}).length;
            const cloudHistCount = Object.keys(cloudData.history || {}).length;
            const localGramCount = Object.keys(localPayload.grammarHistory || {}).length;
            const cloudGramCount = Object.keys(cloudData.grammarHistory || {}).length;
            const now = new Date();
            const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const localTodaySolved = localPayload.dailyStats && localPayload.dailyStats[todayStr] ? (localPayload.dailyStats[todayStr].solved || 0) : 0;
            const cloudTodaySolved = cloudData.dailyStats && cloudData.dailyStats[todayStr] ? (cloudData.dailyStats[todayStr].solved || 0) : 0;

            if (needsLegacyUpgrade || window.__HAS_UNSAVED_LOCAL_CHANGES__ || hasMissingMistakesInCloud || hasMissingSrsInCloud || hasUnsyncedTombstones || localHistCount > cloudHistCount || localGramCount > cloudGramCount || localTodaySolved > cloudTodaySolved) {
              console.log('[Firebase] Syncing merged/upgraded data back to cloud...');
              scheduleCloudUpload(600);
            }
          }
        } catch (syncErr) {
          console.error('[Firebase] Auto-sync comparison error:', syncErr);
        }
      } else {
        // Document does not exist yet for this user: upload current local data
        console.log('[Firebase] First time login, pushing initial local data to cloud.');
        uploadCurrentDataToCloud();
      }
    }, (err) => {
      console.error('[Firebase] Snapshot error:', err);
      lastSyncError = err;
      renderAuthUI(currentUser);
      if (err.code === 'permission-denied') {
        updateSyncStatusUI('offline', 'Firebase 보안 규칙 승인 필요');
        console.warn('[Firebase] Firestore rules must allow authenticated user access to /users/{uid}/data/{docId}');
        if (window.showToast) window.showToast('⚠️ Firebase 보안 규칙이 만료되었거나 권한이 없습니다. 상단 배지를 눌러 해결 방법을 확인하세요.');
      } else {
        updateSyncStatusUI('offline', formatSyncError(err));
      }
    });
  }

  let debounceTimer = null;
  function scheduleCloudUpload(delay = 300) {
    if (!currentUser || !isInitialized) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      uploadCurrentDataToCloud();
    }, delay);
  }

  async function uploadCurrentDataToCloud() {
    if (!currentUser || !isInitialized) return;
    try {
      isSyncingToCloud = true;
      const db = firebase.firestore();
      const dataColRef = db.collection('users').doc(currentUser.uid).collection('data');
      const docRef = dataColRef.doc('jlpt');

      let payload = null;
      if (window.app && typeof window.app.getAppData === 'function') {
        payload = window.app.getAppData();
      }

      let mistakes = (payload && payload.mistakes) ? payload.mistakes : null;
      let history = (payload && payload.history) ? payload.history : null;
      let bookmarks = (payload && payload.bookmarks) ? payload.bookmarks : null;
      let srs = (payload && payload.srs) ? payload.srs : null;
      let dailyStats = (payload && payload.dailyStats) ? payload.dailyStats : null;
      let grammarHistory = (payload && payload.grammarHistory) ? payload.grammarHistory : null;
      let grammarBookmarks = (payload && payload.grammarBookmarks) ? payload.grammarBookmarks : null;

      if (!mistakes) {
        mistakes = JSON.parse(localStorage.getItem('jlpt_mistakes_v1') || localStorage.getItem('jlpt_mistakes_v2') || '{}');
      }
      if (!history) {
        history = JSON.parse(localStorage.getItem('jlpt_history_v1') || localStorage.getItem('jlpt_history_v2') || '{}');
      }
      if (!bookmarks) {
        bookmarks = JSON.parse(localStorage.getItem('jlpt_bookmarks_v1') || localStorage.getItem('jlpt_bookmarks_v2') || '[]');
      }
      if (!srs) {
        srs = JSON.parse(localStorage.getItem('jlpt_srs_v1') || '{}');
      }
      if (!dailyStats) {
        dailyStats = JSON.parse(localStorage.getItem('jlpt_daily_stats_v1') || '{}');
      }
      if (!grammarHistory) {
        grammarHistory = JSON.parse(localStorage.getItem('jlpt_grammar_history_v1') || '{}');
      }
      if (!grammarBookmarks) {
        grammarBookmarks = JSON.parse(localStorage.getItem('jlpt_grammar_bookmarks_v1') || '[]');
      }

      // If local data is empty, check window.JLPT_INITIAL_SYNC
      if (Object.keys(history).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.history) {
        history = { ...window.JLPT_INITIAL_SYNC.history };
      }
      if (Object.keys(mistakes).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.mistakes) {
        mistakes = { ...window.JLPT_INITIAL_SYNC.mistakes };
      }
      if (Object.keys(srs).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.srs) {
        srs = { ...window.JLPT_INITIAL_SYNC.srs };
      }
      if (Object.keys(dailyStats).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.dailyStats) {
        dailyStats = { ...window.JLPT_INITIAL_SYNC.dailyStats };
      }
      if (Object.keys(grammarHistory).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.grammarHistory) {
        grammarHistory = { ...window.JLPT_INITIAL_SYNC.grammarHistory };
      }

      const cloudMistakes = buildCompactMistakes(mistakes);
      const deletedMistakes = (window.app && typeof window.app.getDeletedMistakes === 'function')
        ? window.app.getDeletedMistakes()
        : JSON.parse(localStorage.getItem('jlpt_deleted_mistakes_v1') || '{}');

      // Serialize maps into JSON strings (json_v2) so Firestore creates ~30 index entries instead of 40,000+!
      const fullMistakesJson = JSON.stringify(cloudMistakes);
      const deletedMistakesJson = JSON.stringify(deletedMistakes || {});
      const historyJson = JSON.stringify(history || {});
      const bookmarksJson = JSON.stringify(bookmarks || []);
      const srsJson = JSON.stringify(srs || {});
      const dailyStatsJson = JSON.stringify(dailyStats || {});
      const grammarHistoryJson = JSON.stringify(grammarHistory || {});
      const grammarBookmarksJson = JSON.stringify(grammarBookmarks || []);

      const totalMistakesCount = Object.keys(cloudMistakes).length;
      const activeMistakesCount = Object.values(cloudMistakes).filter(m => !m.isMastered).length;

      const countsMeta = {
        totalMistakes: totalMistakesCount,
        activeMistakes: activeMistakesCount,
        historyCount: Object.keys(history || {}).length,
        srsCount: Object.keys(srs || {}).length,
        grammarHistoryCount: Object.keys(grammarHistory || {}).length
      };

      const estimatedTotalBytes =
        getUtf8ByteLength(fullMistakesJson) +
        getUtf8ByteLength(deletedMistakesJson) +
        getUtf8ByteLength(historyJson) +
        getUtf8ByteLength(bookmarksJson) +
        getUtf8ByteLength(srsJson) +
        getUtf8ByteLength(dailyStatsJson) +
        getUtf8ByteLength(grammarHistoryJson) +
        getUtf8ByteLength(grammarBookmarksJson) + 2048;

      if (estimatedTotalBytes > MAX_SINGLE_DOC_BYTES) {
        // Universal UTF-8 byte-capped multi-document split (each doc strictly <= 650 KB < 1 MiB limit!)
        const fullBundleStr = JSON.stringify({
          mistakes: cloudMistakes,
          deletedMistakes: deletedMistakes || {},
          history: history || {},
          bookmarks: bookmarks || [],
          srs: srs || {},
          dailyStats: dailyStats || {},
          grammarHistory: grammarHistory || {},
          grammarBookmarks: grammarBookmarks || []
        });
        const bundleChunks = splitStringByMaxUtf8Bytes(fullBundleStr, 650000);

        // Write overflow chunks 1..N-1 FIRST so when main doc 'jlpt' triggers onSnapshot, all chunks exist!
        for (let idx = 1; idx < bundleChunks.length; idx++) {
          await dataColRef.doc(`jlpt_chunk_${idx}`).set({
            chunkIndex: idx,
            data: bundleChunks[idx],
            updatedAt: Date.now()
          });
        }

        await docRef.set({
          storageFormat: 'json_v2_chunked',
          bundleChunk0: bundleChunks[0] || '',
          bundleChunkCount: bundleChunks.length,
          counts: countsMeta,
          lastUpdatedClient: Date.now(),
          userEmail: currentUser.email || '',
          userName: currentUser.displayName || '',
          lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Single-document json_v2 (<= 820 KB, ~38 index entries instead of 40,000+)
        await docRef.set({
          storageFormat: 'json_v2',
          mistakesJson: fullMistakesJson,
          mistakesChunkCount: 1,
          deletedMistakesJson,
          historyJson,
          bookmarksJson,
          srsJson,
          dailyStatsJson,
          grammarHistoryJson,
          grammarBookmarksJson,
          counts: countsMeta,
          lastUpdatedClient: Date.now(),
          userEmail: currentUser.email || '',
          userName: currentUser.displayName || '',
          lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        });
      }

      window.__HAS_UNSAVED_LOCAL_CHANGES__ = false;
      lastSyncError = null;
      renderAuthUI(currentUser);

      console.log('[Firebase] Cloud data updated (json_v2). Total Mistakes:', totalMistakesCount, 'Active:', activeMistakesCount, 'Bytes:', estimatedTotalBytes);
      updateSyncStatusUI('connected', `클라우드 동기화됨 (오답 ${activeMistakesCount}개) ✓`);
      if (window.showToast) window.showToast(`☁️ 클라우드 동기화 완료: 미완료 오답 ${activeMistakesCount}개 반영됨`);
      setTimeout(() => {
        if (!lastSyncError) {
          updateSyncStatusUI('connected', '클라우드 실시간 동기화 중');
        }
      }, 2500);
    } catch (err) {
      console.error('[Firebase] Upload failed:', err);
      lastSyncError = err;
      renderAuthUI(currentUser);
      const friendlyStatus = formatSyncError(err);
      updateSyncStatusUI('offline', friendlyStatus);
      if (window.showToast) window.showToast('⚠️ ' + friendlyStatus + ': ' + err.message);
    } finally {
      setTimeout(() => { isSyncingToCloud = false; }, 2000);
    }
  }

  async function forceCloudSync() {
    if (!currentUser || !isInitialized) {
      if (window.showToast) window.showToast('⚠️ Google 계정 로그인이 필요합니다.');
      return;
    }

    try {
      updateSyncStatusUI('connected', '동기화 진행 중...');
      const db = firebase.firestore();
      const dataColRef = db.collection('users').doc(currentUser.uid).collection('data');
      const docRef = dataColRef.doc('jlpt');

      const doc = await docRef.get();
      hasReceivedInitialSnapshot = true;
      if (doc.exists) {
        const cloudData = await unpackCloudDoc(doc.data(), dataColRef);
        if (window.app && typeof window.app.mergeExternalData === 'function') {
          window.app.mergeExternalData(cloudData);
        }
        if (window.grammarApp && typeof window.grammarApp.mergeGrammarData === 'function') {
          window.grammarApp.mergeGrammarData(cloudData);
        }
        await uploadCurrentDataToCloud();
        if (!lastSyncError && window.showToast) window.showToast('✅ 클라우드 대시보드 동기화 완료!');
      } else {
        await uploadCurrentDataToCloud();
        if (!lastSyncError && window.showToast) window.showToast('✅ 로컬 기록을 클라우드에 새로 등록했습니다!');
      }
    } catch (err) {
      console.error('[Firebase] Force sync failed:', err);
      lastSyncError = err;
      renderAuthUI(currentUser);
      updateSyncStatusUI('offline', formatSyncError(err));
      alert('동기화 오류: ' + err.message);
    }
  }

  function checkInAppBrowser() {
    const ua = navigator.userAgent || navigator.vendor || window.opera || '';
    return /KAKAOTALK|NAVER|Instagram|Line|FBAN|FBAV/i.test(ua);
  }

  function handleAuthError(err) {
    if (!err) return;
    console.error('[Firebase Auth Error]', err);
    if (err.code === 'auth/unauthorized-domain') {
      alert('⚠️ [승인되지 않은 도메인 오류]\n\nFirebase 콘솔 > Authentication > 설정(Settings) > [승인된 도메인]에\n\n👉 chanchan9741-hash.github.io\n\n를 등록해 주셔야 로그인할 수 있습니다!');
    } else if (err.code === 'auth/operation-not-allowed') {
      alert('⚠️ [Google 로그인 공급자 비활성화]\n\nFirebase 콘솔 > Authentication > [Sign-in method] 탭에서 [Google]을 클릭하여 [사용 설정]을 켜주세요!');
    } else if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
      // User cancelled
    } else if (err.code === 'auth/network-request-failed') {
      alert('⚠️ 네트워크 연결이 불안정합니다. 인터넷 연결을 확인해 주세요.');
    } else {
      alert(`⚠️ 로그인 오류 (${err.code || 'UNKNOWN'}):\n${err.message}`);
    }
  }

  async function loginWithGoogle() {
    if (window.location && window.location.protocol === 'file:') {
      alert('⚠️ [로컬 파일 실행 모드 안내]\n\nfile:// 경로에서는 Google 보안 정책상 계정 로그인이 제한됩니다.\n\nPC에서도 웹 주소:\n👉 https://chanchan9741-hash.github.io/JLPT/\n로 접속하시면 휴대폰과 100% 동일하게 로그인 및 양방향 실시간 동기화가 진행됩니다!');
      return;
    }

    if (!isConfigured()) {
      showConfigModal();
      return;
    }

    // 1. Check In-App Browser (KakaoTalk, Naver, etc.)
    if (checkInAppBrowser()) {
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) {
        location.href = 'intent://' + location.href.replace(/https?:\/\//i, '') + '#Intent;scheme=https;package=com.android.chrome;end';
        return;
      } else {
        alert('⚠️ [외부 브라우저 필요]\n\n카카오톡/네이버 등 인앱 브라우저에서는 Google의 보안 정책상 로그인이 제한됩니다.\n\n화면 우측 상단/하단의 [⋮] 버튼을 눌러 [Safari 또는 Chrome으로 열기]를 선택해 주세요!');
        return;
      }
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    try {
      const result = await firebase.auth().signInWithPopup(provider);
      if (result && result.user) {
        console.log('[Firebase] Popup login successful:', result.user.email);
        handleAuthStateChanged(result.user);
        if (window.showToast) window.showToast('✅ Google 로그인 완료: ' + (result.user.displayName || result.user.email));
      }
    } catch (err) {
      if (err.code === 'auth/popup-blocked') {
        console.warn('[Firebase] Popup blocked, attempting redirect fallback...');
        try {
          await firebase.auth().signInWithRedirect(provider);
        } catch (redirectErr) {
          handleAuthError(redirectErr);
        }
      } else {
        handleAuthError(err);
      }
    }
  }

  async function logout() {
    if (!isInitialized) return;
    try {
      await firebase.auth().signOut();
      if (window.showToast) window.showToast('로그아웃되었습니다.');
    } catch (err) {
      alert('로그아웃 실패: ' + err.message);
    }
  }

  function updateSyncStatusUI(status, text) {
    const syncDot = document.getElementById('sync-dot');
    const syncText = document.getElementById('sync-text');
    const syncBadge = document.getElementById('sync-status-badge');

    if (syncDot) {
      syncDot.className = 'sync-dot ' + status;
    }
    if (syncText) {
      syncText.textContent = text;
    }
    if (syncBadge) {
      syncBadge.title = text + ' (클릭하여 동기화 상태/설정 열기)';
    }
  }

  function renderAuthUI(user) {
    const container = document.getElementById('auth-user-container');
    const modalArea = document.getElementById('modal-auth-btn-area');

    if (user) {
      const avatarUrl = user.photoURL || '';
      const name = user.displayName || user.email.split('@')[0];

      if (container) {
        container.innerHTML = `
          <div class="user-profile-badge" id="user-profile-btn" title="${user.email}" style="display:inline-flex; align-items:center; gap:0.4rem; padding:0.22rem 0.5rem; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:20px; white-space:nowrap; flex-shrink:0;">
            ${avatarUrl ? `<img src="${avatarUrl}" style="width:22px; height:22px; border-radius:50%; flex-shrink:0;" alt="${name}">` : `<span style="width:22px; height:22px; border-radius:50%; background:var(--primary); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700; flex-shrink:0;">${name.charAt(0)}</span>`}
            <span style="font-size:0.82rem; font-weight:600; color:var(--text-primary); max-width:72px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>
            <button class="btn-logout-small" id="btn-do-logout" style="border:none; background:transparent; color:var(--text-muted); font-size:0.75rem; cursor:pointer; padding:0.1rem 0.25rem; white-space:nowrap;" title="로그아웃">로그아웃</button>
          </div>
        `;
        const logoutBtn = document.getElementById('btn-do-logout');
        if (logoutBtn) logoutBtn.onclick = logout;
      }

      if (modalArea) {
        const isPermDenied = lastSyncError && (lastSyncError.code === 'permission-denied' || /Missing or insufficient permissions/i.test(lastSyncError.message || ''));
        const rulesSnippet = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{userId}/{document=**} {\n      allow read, write: if request.auth != null && request.auth.uid == userId;\n    }\n  }\n}`;
        const projectId = (firebaseConfig && firebaseConfig.projectId) ? firebaseConfig.projectId : 'oval-precept-462304-v7';
        const rulesUrl = `https://console.firebase.google.com/project/${projectId}/firestore/databases/-default-/rules`;

        let errorHtml = '';
        if (lastSyncError) {
          errorHtml = `
            <div style="background:rgba(244,63,94,0.12); border:1px solid rgba(244,63,94,0.4); border-radius:8px; padding:0.75rem; font-size:0.82rem; line-height:1.5; color:var(--text-primary);">
              <div style="font-weight:800; color:#f43f5e; margin-bottom:0.25rem;">⚠️ 동기화 오류 감지: ${formatSyncError(lastSyncError)}</div>
              <div style="color:var(--text-secondary); word-break:break-all; margin-bottom:${isPermDenied ? '0.6rem' : '0'};">${lastSyncError.message || ''}</div>
              ${isPermDenied ? `
                <div style="background:rgba(0,0,0,0.25); padding:0.6rem; border-radius:6px; margin-bottom:0.5rem;">
                  <div style="font-weight:700; margin-bottom:0.3rem; color:#fbbf24;">🔧 1분 해결 방법 (Firestore 30일 테스트 모드 만료 시):</div>
                  <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.45rem;">아래 [보안 규칙 복사] 후 Firebase 규칙 탭에 붙여넣고 <b>[게시(Publish)]</b>를 눌러주세요.</div>
                  <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                    <button type="button" class="btn btn-primary btn-sm" id="btn-copy-firestore-rules" style="font-size:0.76rem; padding:0.3rem 0.65rem;">📋 보안 규칙 코드 복사</button>
                    <a href="${rulesUrl}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="font-size:0.76rem; padding:0.3rem 0.65rem; text-decoration:none;">🔗 Firebase 규칙 콘솔 열기</a>
                  </div>
                </div>
              ` : ''}
            </div>
          `;
        }

        modalArea.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:0.6rem;">
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.25); padding:0.5rem 0.75rem; border-radius:8px;">
              <span style="color:var(--success); font-weight:700; font-size:0.86rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">✅ ${user.email} (로그인됨)</span>
              <button class="btn btn-secondary btn-sm" id="btn-modal-logout" style="font-size:0.75rem; padding:0.2rem 0.5rem; flex-shrink:0;">로그아웃</button>
            </div>
            ${errorHtml}
            <button class="btn btn-primary btn-sm" id="btn-force-cloud-sync" style="font-weight:700; display:inline-flex; align-items:center; justify-content:center; gap:0.4rem; padding:0.5rem; width:100%;">
              <span>🔄 클라우드 실시간 데이터 즉시 동기화</span>
            </button>
          </div>
        `;
        const modalLogoutBtn = document.getElementById('btn-modal-logout');
        if (modalLogoutBtn) modalLogoutBtn.onclick = logout;
        const forceSyncBtn = document.getElementById('btn-force-cloud-sync');
        if (forceSyncBtn) forceSyncBtn.onclick = forceCloudSync;
        const copyRulesBtn = document.getElementById('btn-copy-firestore-rules');
        if (copyRulesBtn) {
          copyRulesBtn.onclick = () => {
            navigator.clipboard.writeText(rulesSnippet).then(() => {
              if (window.showToast) window.showToast('📋 Firestore 보안 규칙이 클립보드에 복사되었습니다!');
            });
          };
        }
      }
    } else {
      if (container) {
        container.innerHTML = `
          <button class="btn btn-primary btn-sm btn-google-login" id="btn-do-login" style="display:inline-flex; align-items:center; gap:0.35rem; font-weight:700; white-space:nowrap;">
            <svg width="15" height="15" viewBox="0 0 24 24"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
            <span class="google-login-text">Google 로그인</span>
          </button>
        `;
        const loginBtn = document.getElementById('btn-do-login');
        if (loginBtn) loginBtn.onclick = loginWithGoogle;
      }

      if (modalArea) {
        modalArea.innerHTML = `
          <button class="btn btn-primary btn-sm btn-google-login" id="btn-modal-do-login" style="display:inline-flex; align-items:center; gap:0.4rem; font-weight:700;">
            <svg width="15" height="15" viewBox="0 0 24 24"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
            <span>Google 계정으로 동기화 시작</span>
          </button>
        `;
        const modalLoginBtn = document.getElementById('btn-modal-do-login');
        if (modalLoginBtn) modalLoginBtn.onclick = loginWithGoogle;
      }
    }
  }

  function showConfigModal() {
    let modal = document.getElementById('modal-firebase-config');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal-firebase-config';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-card" style="max-width:520px; background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:14px; padding:1.5rem; box-shadow:var(--shadow-xl); color:var(--text-primary);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <h3 style="margin:0; font-size:1.15rem; font-weight:800;">🔥 Firebase 클라우드 DB 연동 설정</h3>
            <button class="btn-close-modal" id="btn-close-fb-modal" style="border:none; background:transparent; font-size:1.5rem; cursor:pointer; color:var(--text-muted);">&times;</button>
          </div>
          <div>
            <p style="font-size:0.9rem; color:var(--text-muted); line-height:1.5; margin-bottom:0.75rem;">
              Firebase 콘솔에서 발급받은 <code>firebaseConfig</code> 코드를 아래에 붙여넣어 주세요.
            </p>
            <textarea id="txt-firebase-config" placeholder='{\n  "apiKey": "AIzaSy...",\n  "authDomain": "...firebaseapp.com",\n  "projectId": "...",\n  "storageBucket": "...",\n  "messagingSenderId": "...",\n  "appId": "..."\n}' style="width:100%; height:140px; font-family:monospace; font-size:0.82rem; padding:0.75rem; border-radius:8px; border:1px solid var(--border-subtle); background:var(--bg-elevated); color:var(--text-primary); resize:vertical; box-sizing:border-box;"></textarea>
            <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1rem;">
              <button class="btn btn-secondary btn-sm" id="btn-cancel-fb-modal">취소</button>
              <button class="btn btn-primary btn-sm" id="btn-save-fb-config" style="font-weight:700;">연동 저장하기</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('btn-close-fb-modal').onclick = () => modal.classList.add('hidden');
      document.getElementById('btn-cancel-fb-modal').onclick = () => modal.classList.add('hidden');
      document.getElementById('btn-save-fb-config').onclick = () => {
        const val = document.getElementById('txt-firebase-config').value.trim();
        try {
          let cfg = null;
          if (val.startsWith('{')) {
            cfg = JSON.parse(val);
          } else {
            const match = val.match(/\{[\s\S]*\}/);
            if (match) {
              cfg = new Function(`return ${match[0]};`)();
            }
          }
          if (cfg && cfg.apiKey) {
            setConfig(cfg);
            modal.classList.add('hidden');
            if (window.showToast) window.showToast('🔥 Firebase 연동 설정이 완료되었습니다!');
          } else {
            alert('올바른 Firebase Config 형식(apiKey 등이 포함된 코드)을 붙여넣어 주세요.');
          }
        } catch (e) {
          alert('설정값 파싱 실패: ' + e.message);
        }
      };
    }
    modal.classList.remove('hidden');
  }

  // Auto init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Lifecycle listeners to flush unsaved sync on mobile app switch or screen lock
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && currentUser && isInitialized && hasReceivedInitialSnapshot) {
        uploadCurrentDataToCloud();
      }
    });
    window.addEventListener('pagehide', () => {
      if (currentUser && isInitialized && hasReceivedInitialSnapshot) {
        uploadCurrentDataToCloud();
      }
    });
  }

  function checkAndSyncWithCloud() {
    if (!currentUser || !isInitialized) return;
    // Wait until initial Firestore snapshot has arrived so we never compare against empty cloud data
    if (!hasReceivedInitialSnapshot) {
      console.log('[Firebase] Waiting for initial cloud snapshot before bidirectional sync check...');
      return;
    }
    try {
      let localMistakes = {};
      if (window.app && typeof window.app.getAppData === 'function') {
        const d = window.app.getAppData();
        localMistakes = d.mistakes || {};
      } else {
        localMistakes = JSON.parse(localStorage.getItem('jlpt_mistakes_v1') || '{}');
      }

      const cloudData = window.__PENDING_CLOUD_DATA__;
      const cloudMistakes = (cloudData && cloudData.mistakes) ? cloudData.mistakes : {};
      const localCount = Object.keys(localMistakes).length;
      const cloudCount = Object.keys(cloudMistakes).length;

      console.log(`[Firebase] checkAndSyncWithCloud: Local mistakes=${localCount}, Cloud mistakes=${cloudCount}`);

      if (localCount > cloudCount || window.__HAS_UNSAVED_LOCAL_CHANGES__) {
        console.log('[Firebase] Local has more records than cloud. Uploading to cloud...');
        uploadCurrentDataToCloud();
      } else if (cloudCount > localCount && cloudData) {
        console.log('[Firebase] Cloud has more records than local. Merging into local...');
        if (window.app && typeof window.app.mergeExternalData === 'function') {
          window.app.mergeExternalData(cloudData);
        }
      }
    } catch (e) {
      console.error('[Firebase] checkAndSyncWithCloud error:', e);
    }
  }

  return {
    init,
    setConfig,
    isConfigured,
    getCurrentUser: () => currentUser,
    getLastSyncError: () => lastSyncError,
    loginWithGoogle,
    logout,
    scheduleCloudUpload,
    uploadCurrentDataToCloud,
    forceCloudSync,
    checkAndSyncWithCloud,
    showConfigModal
  };
})();
