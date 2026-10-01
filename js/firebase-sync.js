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

  let isInitialized = false;
  let currentUser = null;
  let unsubscribeSnapshot = null;
  let isSyncingToCloud = false;

  function isConfigured() {
    return firebaseConfig &&
      firebaseConfig.apiKey &&
      !firebaseConfig.apiKey.startsWith("YOUR_");
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
    renderAuthUI(user);

    if (user) {
      console.log('[Firebase] Logged in as:', user.displayName, user.email, user.uid);
      updateSyncStatusUI('connected', '클라우드 동기화 중 (' + (user.displayName || user.email.split('@')[0]) + ')');

      // Start realtime listening
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
    const docRef = db.collection('users').doc(uid).collection('data').doc('jlpt');

    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
    }

    unsubscribeSnapshot = docRef.onSnapshot((doc) => {
      if (isSyncingToCloud) return; // Prevent echo loop

      if (doc.exists) {
        const cloudData = doc.data();
        console.log('[Firebase] Received cloud update:', cloudData);
        updateSyncStatusUI('connected', '클라우드 실시간 동기화 중');

        // Store pending cloud data so app can pick it up if not ready yet
        window.__PENDING_CLOUD_DATA__ = cloudData;

        // Merge cloud data into current app state
        if (window.app && typeof window.app.mergeExternalData === 'function') {
          window.app.mergeExternalData(cloudData);
        }
      } else {
        // Document does not exist yet for this user: upload current local data
        console.log('[Firebase] First time login, pushing initial local data to cloud.');
        uploadCurrentDataToCloud();
      }
    }, (err) => {
      console.error('[Firebase] Snapshot error:', err);
      if (err.code === 'permission-denied') {
        updateSyncStatusUI('offline', 'Firebase 보안 규칙 승인 필요');
        console.warn('[Firebase] Firestore rules must allow authenticated user access to /users/{uid}/data/jlpt');
      } else {
        updateSyncStatusUI('offline', '클라우드 연결 오류');
      }
    });
  }

  let debounceTimer = null;
  function scheduleCloudUpload() {
    if (!currentUser || !isInitialized) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      uploadCurrentDataToCloud();
    }, 1000);
  }

  async function uploadCurrentDataToCloud() {
    if (!currentUser || !isInitialized) return;
    try {
      isSyncingToCloud = true;
      const db = firebase.firestore();
      const docRef = db.collection('users').doc(currentUser.uid).collection('data').doc('jlpt');

      let payload = null;
      if (window.app && typeof window.app.getAppData === 'function') {
        payload = window.app.getAppData();
      }

      let mistakes = (payload && payload.mistakes) ? payload.mistakes : null;
      let history = (payload && payload.history) ? payload.history : null;
      let bookmarks = (payload && payload.bookmarks) ? payload.bookmarks : null;
      let srs = (payload && payload.srs) ? payload.srs : null;

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

      // If local data is empty, check window.JLPT_INITIAL_SYNC
      if (Object.keys(history).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.history) {
        history = { ...window.JLPT_INITIAL_SYNC.history };
      }
      if (Object.keys(mistakes).length === 0 && window.JLPT_INITIAL_SYNC && window.JLPT_INITIAL_SYNC.mistakes) {
        mistakes = { ...window.JLPT_INITIAL_SYNC.mistakes };
      }

      await docRef.set({
        mistakes,
        history,
        bookmarks,
        srs,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        lastUpdatedClient: Date.now(),
        userEmail: currentUser.email || '',
        userName: currentUser.displayName || ''
      }, { merge: true });

      console.log('[Firebase] Cloud data updated successfully. Solved count:', Object.keys(history).length);
      updateSyncStatusUI('connected', '클라우드 실시간 동기화 중');
    } catch (err) {
      console.error('[Firebase] Upload failed:', err);
    } finally {
      setTimeout(() => { isSyncingToCloud = false; }, 300);
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
      const docRef = db.collection('users').doc(currentUser.uid).collection('data').doc('jlpt');

      const doc = await docRef.get();
      if (doc.exists) {
        const cloudData = doc.data();
        if (window.app && typeof window.app.mergeExternalData === 'function') {
          window.app.mergeExternalData(cloudData);
        }
        await uploadCurrentDataToCloud();
        if (window.showToast) window.showToast('✅ 클라우드 대시보드 동기화 완료!');
      } else {
        await uploadCurrentDataToCloud();
        if (window.showToast) window.showToast('✅ 로컬 기록을 클라우드에 새로 등록했습니다!');
      }
      updateSyncStatusUI('connected', '클라우드 실시간 동기화 중');
    } catch (err) {
      console.error('[Firebase] Force sync failed:', err);
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
    if (!isConfigured()) {
      showConfigModal();
      return;
    }

    // 1. Check In-App Browser (KakaoTalk, Naver, etc.)
    if (checkInAppBrowser()) {
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) {
        // Auto-open in Chrome for Android KakaoTalk
        location.href = 'intent://' + location.href.replace(/https?:\/\//i, '') + '#Intent;scheme=https;package=com.android.chrome;end';
        return;
      } else {
        alert('⚠️ [외부 브라우저 필요]\n\n카카오톡/네이버 등 인앱 브라우저에서는 Google의 보안 정책상 로그인이 제한됩니다.\n\n화면 우측 상단/하단의 [⋮] 버튼을 눌러 [Safari 또는 Chrome으로 열기]를 선택해 주세요!');
        return;
      }
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    // 2. Try signInWithPopup first (Works reliably on mobile Chrome/Safari without ITP redirect loss!)
    try {
      const result = await firebase.auth().signInWithPopup(provider);
      if (result && result.user) {
        console.log('[Firebase] Popup login successful:', result.user.email);
        handleAuthStateChanged(result.user);
        if (window.showToast) window.showToast('✅ Google 로그인 완료: ' + (result.user.displayName || result.user.email));
      }
    } catch (err) {
      if (err.code === 'auth/popup-blocked') {
        // Fallback to redirect only if popup is strictly blocked by browser
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
      syncBadge.title = text;
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
          <div class="user-profile-badge" id="user-profile-btn" title="${user.email}" style="display:inline-flex; align-items:center; gap:0.4rem; padding:0.22rem 0.5rem; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:20px;">
            ${avatarUrl ? `<img src="${avatarUrl}" style="width:22px; height:22px; border-radius:50%;" alt="${name}">` : `<span style="width:22px; height:22px; border-radius:50%; background:var(--primary); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700;">${name.charAt(0)}</span>`}
            <span style="font-size:0.82rem; font-weight:600; color:var(--text-primary); max-width:85px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>
            <button class="btn-logout-small" id="btn-do-logout" style="border:none; background:transparent; color:var(--text-muted); font-size:0.75rem; cursor:pointer; padding:0.1rem 0.25rem;" title="로그아웃">로그아웃</button>
          </div>
        `;
        const logoutBtn = document.getElementById('btn-do-logout');
        if (logoutBtn) logoutBtn.onclick = logout;
      }

      if (modalArea) {
        modalArea.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:0.6rem;">
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.25); padding:0.5rem 0.75rem; border-radius:8px;">
              <span style="color:var(--success); font-weight:700; font-size:0.86rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">✅ ${user.email} (연동 완료)</span>
              <button class="btn btn-secondary btn-sm" id="btn-modal-logout" style="font-size:0.75rem; padding:0.2rem 0.5rem; flex-shrink:0;">로그아웃</button>
            </div>
            <button class="btn btn-primary btn-sm" id="btn-force-cloud-sync" style="font-weight:700; display:inline-flex; align-items:center; justify-content:center; gap:0.4rem; padding:0.5rem; width:100%;">
              <span>🔄 클라우드 실시간 데이터 즉시 동기화</span>
            </button>
          </div>
        `;
        const modalLogoutBtn = document.getElementById('btn-modal-logout');
        if (modalLogoutBtn) modalLogoutBtn.onclick = logout;
        const forceSyncBtn = document.getElementById('btn-force-cloud-sync');
        if (forceSyncBtn) forceSyncBtn.onclick = forceCloudSync;
      }
    } else {
      if (container) {
        container.innerHTML = `
          <button class="btn btn-primary btn-sm btn-google-login" id="btn-do-login" style="display:inline-flex; align-items:center; gap:0.35rem; font-weight:700;">
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

  return {
    init,
    setConfig,
    isConfigured,
    getCurrentUser: () => currentUser,
    loginWithGoogle,
    logout,
    scheduleCloudUpload,
    forceCloudSync,
    showConfigModal
  };
})();
