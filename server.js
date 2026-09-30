const os = require('os');
/**
 * JLPT Master - Google Drive Real-time Sync Server
 * Zero dependencies, uses only Node.js standard libraries (http, fs, path).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;
const SYNC_DATA_FILE = path.join(BASE_DIR, 'jlpt_sync_data.json');
const MISTAKES_MD_FILE = path.join(BASE_DIR, '오답노트_자동동기화.md');


function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const lname = name.toLowerCase();
    if (lname.includes('wi-fi') || lname.includes('wifi') || lname.includes('무선') || lname.includes('wireless') || lname.includes('wlan')) {
      for (const a of ifaces[name]) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
  }
  for (const name of Object.keys(ifaces)) {
    const lname = name.toLowerCase();
    if (lname.includes('virtual') || lname.includes('vbox') || lname.includes('vmware') || lname.includes('loopback')) continue;
    for (const a of ifaces[name]) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('192.168.56.')) {
        return a.address;
      }
    }
  }
  return 'localhost';
}
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};


function generateMistakesHtml(mistakes) {
  const list = Object.values(mistakes || {});
  const activeMistakes = list.filter(m => !m.isMastered);
  const masteredMistakes = list.filter(m => m.isMastered);

  let cardsHtml = '';
  if (activeMistakes.length === 0) {
    cardsHtml = '<div style="text-align:center; padding:3rem; color:#64748b; font-size:1.1rem;">🎉 현재 복습할 미완료 오답이 없습니다! 문제를 풀다 틀린 문제가 생기면 자동으로 이곳에 정리됩니다.</div>';
  } else {
    activeMistakes.forEach((m, idx) => {
      const correctOpt = m.options ? m.options.find(o => o.isCorrect) : null;
      let optionsRows = '';
      if (m.options) {
        m.options.forEach(o => {
          const isCorrect = o.isCorrect;
          const isWrongPicked = m.wrongChoice && (m.wrongChoice === o.copy || m.wrongChoice.includes(o.copy));
          let rowClass = isCorrect ? 'opt-correct' : (isWrongPicked ? 'opt-wrong-picked' : '');
          let badge = isCorrect ? '<span class="tag-correct">정답</span>' : (isWrongPicked ? '<span class="tag-wrong">내가 고른 오답</span>' : '');
          let tr = o.trans ? `<span style="color:#64748b; font-size:0.9em; margin-left:6px;">(${o.trans})</span>` : '';
          optionsRows += `<tr class="${rowClass}">
            <td style="width:36px; text-align:center; font-weight:700;">${o.marker}</td>
            <td>${o.copy}${tr}${badge}</td>
          </tr>`;
        });
      }

      let csHtml = '';
      if (m.ansJa && m.typeCode !== 'kanji_reading') {
        csHtml = `<div class="cs-box">
          <div class="cs-label">정답 완성 문장</div>
          <div class="cs-ja">${m.ansJa}</div>
          ${m.ansKo ? `<div class="cs-ko">${m.ansKo}</div>` : ''}
        </div>`;
      }

      let explHtml = '';
      if (m.expl && m.expl.main) {
        explHtml = `<div class="expl-box">
          <div class="expl-label">💡 핵심 출제 포인트 및 해설</div>
          <div>${m.expl.main}</div>
        </div>`;
      }

      cardsHtml += `
      <div class="mistake-card">
        <div class="card-top">
          <div class="card-badges">
            <span class="badge badge-level">${m.level}</span>
            <span class="badge badge-type">${m.typeName}</span>
            <span class="badge badge-count">오답 ${m.count}회</span>
          </div>
          <span style="font-size:0.85rem; color:#94a3b8; font-weight:700;"># ${idx + 1}</span>
        </div>
        <div class="q-text">${m.qPlain}</div>
        ${m.qTrans ? `<div class="q-trans">${m.qTrans}</div>` : ''}
        <table class="options-table">
          ${optionsRows}
        </table>
        ${csHtml}
        ${explHtml}
      </div>
      `;
    });
  }

  let masteredRows = '';
  if (masteredMistakes.length > 0) {
    masteredRows = '<div style="margin-top:2.5rem;"><h2 style="font-size:1.25rem; font-weight:700; color:#15803d; margin-bottom:1rem;">✨ 완전 정복(마스터) 목록 (' + masteredMistakes.length + '문항)</h2><ul style="padding-left:1.5rem; color:#334155; line-height:1.8;">';
    masteredMistakes.forEach((m, idx) => {
      const correctOpt = m.options ? m.options.find(o => o.isCorrect) : null;
      masteredRows += `<li><b>[${m.level} ${m.typeName}]</b> ${m.qPlain} ➔ 정답: <b style="color:#15803d;">${correctOpt ? correctOpt.copy : ''}</b></li>`;
    });
    masteredRows += '</ul></div>';
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>JLPT 실시간 스마트 오답노트 (PDF 출력 및 독스 리포트)</title>
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
      gap: 0.75rem;
      margin-top: 0.75rem;
    }
    .pill {
      font-size: 0.85rem;
      font-weight: 700;
      padding: 0.3rem 0.85rem;
      border-radius: 9999px;
    }
    .pill-wrong { background: #fee2e2; color: #dc2626; }
    .pill-master { background: #dcfce7; color: #16a34a; }
    
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
      font-size: 1.18rem;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.5;
      margin-bottom: 0.35rem;
    }
    .q-trans {
      font-size: 0.96rem;
      color: #64748b;
      margin-bottom: 1rem;
    }

    .options-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1rem;
      font-size: 0.95rem;
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
    .opt-wrong-picked {
      background: #fef2f2;
      color: #b91c1c;
      text-decoration: line-through;
    }
    .tag-correct {
      background: #16a34a;
      color: #fff;
      font-size: 0.72rem;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      margin-left: 0.4rem;
    }
    .tag-wrong {
      background: #ef4444;
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
        <h1>📓 JLPT 실시간 오답노트 보고서</h1>
        <div class="meta-date">최근 동기화: ${new Date().toLocaleString('ko-KR')}</div>
        <div class="summary-pills">
          <span class="pill pill-wrong">⚠️ 복습 필요: ${activeMistakes.length}문항</span>
          <span class="pill pill-master">✨ 정복 완료: ${masteredMistakes.length}문항</span>
        </div>
      </div>
      <div class="actions-bar">
        <button class="btn-action" onclick="window.print()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/></svg>
          <span>PDF 인쇄 / 저장</span>
        </button>
      </div>
    </div>
    ${cardsHtml}
    ${masteredRows}
  </div>

  <script>
    if (window.location.search.includes('print=true')) {
      window.addEventListener('load', () => setTimeout(() => window.print(), 350));
    }
  </script>
</body>
</html>`;
}

function generateMistakesMarkdown(mistakes) {
  const list = Object.values(mistakes || {});
  
  // 1. Sort active mistakes by: 1) Most mistakes first (count desc), 2) Most recent date
  const activeMistakes = list.filter(m => !m.isMastered).sort((a, b) => {
    return (b.count || 1) - (a.count || 1) || (b.lastWrongDate || 0) - (a.lastWrongDate || 0);
  });
  
  const masteredMistakes = list.filter(m => m.isMastered).sort((a, b) => {
    return (b.lastWrongDate || 0) - (a.lastWrongDate || 0);
  });

  // Calculate statistics by Type (동일 유형/파트별 오답 집중도 집계)
  const typeStats = {};
  activeMistakes.forEach(m => {
    const key = `[${m.level}] ${m.typeName}`;
    typeStats[key] = (typeStats[key] || 0) + (m.count || 1);
  });
  const sortedTypes = Object.entries(typeStats).sort((a, b) => b[1] - a[1]);

  let md = `# 📓 구글 드라이브 실시간 연동 JLPT 오답노트 (구글 독스 열람용)\n\n`;
  md += `> **마지막 동기화**: ${new Date().toLocaleString('ko-KR')}\n`;
  md += `> **복습 대기 오답**: ${activeMistakes.length}문항 | **정복 완료**: ${masteredMistakes.length}문항\n`;
  md += `> **정렬 방식**: **다빈도 오답 우선 정렬 (많이 틀린 문제가 가장 위에 올라옵니다)**\n\n`;
  md += `---\n\n`;

  if (activeMistakes.length === 0) {
    md += `## 🎉 현재 복습할 미완료 오답이 없습니다!\n\n문제를 풀다 틀린 문제가 생기면 이곳에 자동으로 추가됩니다.\n\n`;
  } else {
    // 1. 파트별 오답 누적 순위 요약표 (구글 독스 서식 최적화)
    if (sortedTypes.length > 0) {
      md += `## 📊 파트별 취약도 집중 분석 표\n\n`;
      md += `오답이 자주 발생하는 취약 파트 순서대로 정렬된 요약표입니다.\n\n`;
      md += `| 취약 순위 | 급수 및 문제 유형 | 누적 오답 횟수 | 취약 경고도 |\n`;
      md += `| :--- | :--- | :--- | :--- |\n`;
      sortedTypes.forEach(([typeName, count], i) => {
        let medal = i === 0 ? '🥇 1위' : (i === 1 ? '🥈 2위' : (i === 2 ? '🥉 3위' : `${i + 1}위`));
        let warning = count >= 3 ? '🚨 위험 (집중 반복 필요)' : (count >= 2 ? '⚠️ 주의 (다빈도 오답)' : '📌 확인 필요');
        md += `| ${medal} | **${typeName}** | **총 ${count}회 틀림** | ${warning} |\n`;
      });
      md += `\n---\n\n`;
    }

    // 2. 많이 틀린 순서대로 상세 오답 카드 목록
    md += `## ⚠️ 다빈도 오답 집중 분석 목록 (많이 틀린 순 정렬)\n\n`;
    activeMistakes.forEach((m, idx) => {
      const correctOpt = m.options ? m.options.find(o => o.isCorrect) : null;
      const count = m.count || 1;
      let badge = count >= 3 ? `🚨 [집중 오답] 총 ${count}회 틀림` : (count >= 2 ? `⚠️ [반복 오답] 총 ${count}회 틀림` : `총 1회 틀림`);

      md += `### [${idx + 1}위 | ${badge}] ${m.level} ${m.typeName}\n\n`;
      md += `- **오답 누적 횟수**: **${count}회**\n`;
      md += `- **지시사항**: ${m.instruction || ''}\n`;
      md += `- **문제**: **${m.qPlain}**\n`;
      if (m.qTrans) md += `- **문제 해석**: ${m.qTrans}\n`;
      if (m.options) {
        md += `- **선택지 및 정오답 분석**:\n`;
        m.options.forEach(o => {
          const isCorrect = o.isCorrect;
          const isWrongPicked = m.wrongChoice && (m.wrongChoice === o.copy || m.wrongChoice.includes(o.copy));
          let status = isCorrect ? ' ➔ **[정답]**' : (isWrongPicked ? ' ➔ **[내가 찍은 오답 ❌]**' : '');
          const tr = o.trans ? ` (${o.trans})` : '';
          md += `  - ${o.marker} ${o.copy}${tr}${status}\n`;
        });
      }
      if (correctOpt) {
        md += `- **정답**: **${correctOpt.marker} ${correctOpt.copy}** ${correctOpt.trans ? '(' + correctOpt.trans + ')' : ''}\n`;
      }
      if (m.wrongChoice) {
        md += `- **내가 선택했던 오답**: ~~${m.wrongChoice}~~\n`;
      }
      if (m.ansJa && m.typeCode !== 'kanji_reading') {
        md += `- **정답 완성 문장**: ${m.ansJa}\n`;
        if (m.ansKo) md += `- **완성 해석**: ${m.ansKo}\n`;
      }
      if (m.expl && m.expl.main) {
        md += `- **출제 포인트 및 상세 해설**: ${m.expl.main}\n`;
      }
      md += `\n---\n\n`;
    });
  }

  if (masteredMistakes.length > 0) {
    md += `## ✨ 완전 정복(마스터) 목록 (${masteredMistakes.length}문항)\n\n`;
    masteredMistakes.forEach((m, idx) => {
      const correctOpt = m.options ? m.options.find(o => o.isCorrect) : null;
      md += `- **[정복 ${idx + 1}]** [${m.level} ${m.typeName}] ${m.qPlain} ➔ 정답: **${correctOpt ? correctOpt.copy : ''}**\n`;
    });
    md += `\n---\n\n`;
  }

  return md;
}

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // API 1: GET /api/sync-data (Load saved Google Drive data)
    if (req.method === 'GET' && pathname === '/api/network-info') {
    const localIp = getLocalIp();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      localIp,
      port: PORT,
      mobileUrl: 'http://' + localIp + ':' + PORT
    }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sync-data') {
    if (fs.existsSync(SYNC_DATA_FILE)) {
      try {
        const data = fs.readFileSync(SYNC_DATA_FILE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
        return;
      } catch (err) {
        console.error('Error reading sync file:', err);
      }
    }
    // Default empty
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ mistakes: {}, history: {}, bookmarks: [] }));
    return;
  }

  // API 2: POST /api/sync-data (Save updated data to Google Drive)
  if (req.method === 'POST' && pathname === '/api/sync-data') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        payload.lastSyncTime = Date.now();
        payload.lastSyncDate = new Date().toISOString();

        // 1. Write JSON sync file
        fs.writeFileSync(SYNC_DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');

        // 2. Automatically generate & write human-readable Markdown file for Google Drive
        const mdContent = generateMistakesMarkdown(payload.mistakes || {});
        const reportHtml = generateMistakesHtml(payload.mistakes || {});

        // Save HTML report for clean web & 1-click PDF viewing
        const REPORT_HTML_FILE = path.join(BASE_DIR, '오답노트_보고서.html');
        fs.writeFileSync(REPORT_HTML_FILE, reportHtml, 'utf-8');
        try {
          const parentHtml = path.join(BASE_DIR, '..', '오답노트_보고서.html');
          fs.writeFileSync(parentHtml, reportHtml, 'utf-8');
        } catch (e) {}
        fs.writeFileSync(MISTAKES_MD_FILE, mdContent, 'utf-8');
        try {
          const parentMd = path.join(BASE_DIR, '..', '오답노트_자동동기화.md');
          fs.writeFileSync(parentMd, mdContent, 'utf-8');
        } catch (e) {}

        console.log(`[Google Drive Sync] Successfully updated at ${new Date().toLocaleTimeString()}!`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          message: 'Google Drive sync completed',
          syncTime: payload.lastSyncTime
        }));
      } catch (e) {
        console.error('Failed to parse sync payload:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static File Serving
  let filePath = path.join(BASE_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security check to stay inside BASE_DIR
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[안내] 서버가 이미 가동 중입니다 (http://localhost:${PORT}). 브라우저를 엽니다...`);
    try {
      const { exec } = require('child_process');
      exec(`start http://localhost:${PORT}`);
    } catch (e) {}
  } else {
    console.error('서버 에러:', err);
  }
});

const localIp = getLocalIp();
server.listen(PORT, '0.0.0.0', () => {
  console.log('================================================================');
  console.log(`🚀 JLPT Master - 구글 드라이브 실시간 동기화 서버 가동 중!`);
  console.log(`📁 동기화 위치: ${BASE_DIR}`);
  console.log(`💻 PC 접속 주소:   http://localhost:${PORT}`);
  console.log(`📱 모바일 접속 주소: http://${localIp}:${PORT}  (동일 Wi-Fi 연결 시)`);
  console.log('================================================================');

  // Launch browser automatically to http://localhost:PORT
  try {
    const { exec } = require('child_process');
    exec(`start http://localhost:${PORT}`);
  } catch (e) {
    console.error('브라우저 실행 실패:', e);
  }
});
