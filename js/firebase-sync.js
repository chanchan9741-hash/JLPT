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
      updateSyncStatusUI('offline', '클라우드 연결 오류');
    });
  }

  let debounceTimer = null;
  function scheduleCloudUpload() {
    if (!currentUser || !isInitialized) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      uploadCurrentDataToCloud();
    }, 1200);
  }

  async function uploadCurrentDataToCloud() {
    if (!currentUser || !isInitialized) return;
    try {
      isSyncingToCloud = true;
      const db = firebase.firestore();
      const docRef = db.collection('users').doc(currentUser.uid).collection('data').doc('jlpt');

      const mistakes = JSON.parse(localStorage.getItem('jlpt_mistakes_v2') || '{}');
      const history = JSON.parse(localStorage.getItem('jlpt_history_v2') || '{}');
      const bookmarks = JSON.parse(localStorage.getItem('jlpt_bookmarks_v2') || '[]');

      await docRef.set({
        mistakes,
        history,
        bookmarks,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        lastUpdatedClient: Date.now(),
        userEmail: currentUser.email || '',
        userName: currentUser.displayName || ''
      }, { merge: true });

      console.log('[Firebase] Cloud data updated successfully.');
      updateSyncStatusUI('connected', '클라우드 실시간 동기화 중');
    } catch (err) {
      console.error('[Firebase] Upload failed:', err);
    } finally {
      setTimeout(() => { isSyncingToCloud = false; }, 300);
    }
  }

  async function loginWithGoogle() {
    if (!isConfigured()) {
      showConfigModal();
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch (err) {
      if (err.code === 'auth/popup-blocked') {
        await firebase.auth().signInWithRedirect(provider);
      } else {
        alert('구글 로그인 오류: ' + err.message);
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
    if (!container) return;

    if (!isConfigured()) {
      container.innerHTML = `
        <button class="btn btn-secondary btn-sm" id="btn-open-firebase-config" style="display:inline-flex; align-items:center; gap:0.35rem; font-weight:700;">
          <span>🔥 클라우드 연동</span>
        </button>
      `;
      const btn = document.getElementById('btn-open-firebase-config');
      if (btn) btn.onclick = showConfigModal;
      return;
    }

    if (user) {
      const avatarUrl = user.photoURL || '';
      const name = user.displayName || user.email.split('@')[0];
      container.innerHTML = `
        <div class="user-profile-badge" id="user-profile-btn" title="${user.email}" style="display:inline-flex; align-items:center; gap:0.4rem; padding:0.25rem 0.5rem; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:20px;">
          ${avatarUrl ? `<img src="${avatarUrl}" style="width:24px; height:24px; border-radius:50%;" alt="${name}">` : `<span style="width:24px; height:24px; border-radius:50%; background:var(--primary); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700;">${name.charAt(0)}</span>`}
          <span style="font-size:0.85rem; font-weight:600; color:var(--text-primary); max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>
          <button class="btn-logout-small" id="btn-do-logout" style="border:none; background:transparent; color:var(--text-muted); font-size:0.78rem; cursor:pointer; padding:0.15rem 0.35rem;" title="로그아웃">로그아웃</button>
        </div>
      `;
      const logoutBtn = document.getElementById('btn-do-logout');
      if (logoutBtn) logoutBtn.onclick = logout;
    } else {
      container.innerHTML = `
        <button class="btn btn-primary btn-sm btn-google-login" id="btn-do-login" style="display:inline-flex; align-items:center; gap:0.4rem; font-weight:700;">
          <svg width="15" height="15" viewBox="0 0 24 24"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
          <span>Google 로그인</span>
        </button>
      `;
      const loginBtn = document.getElementById('btn-do-login');
      if (loginBtn) loginBtn.onclick = loginWithGoogle;
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
    showConfigModal
  };
})();
