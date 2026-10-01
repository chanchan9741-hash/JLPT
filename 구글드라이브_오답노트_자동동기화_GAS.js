/**
 * ====================================================================
 * JLPT Master - 구글 드라이브 전용 매일 오답노트 자동 동기화 스크립트
 * ====================================================================
 * 사용자: chanchan9741@gmail.com 전용
 * 기능: 매일 밤 정해진 시간(23:00)에 Firebase 클라우드에서 최신 오답노트를 가져와
 *       구글 드라이브 폴더에 마크다운(.md) 및 엑셀/CSV(.csv) 파일로 자동 저장합니다.
 * 특징: PC를 꺼두어도 구글 클라우드가 24시간 100% 완전 자동으로 실행합니다.
 */

// [설정]
const CONFIG = {
  // 구글 드라이브에 생성될 폴더 이름
  FOLDER_NAME: 'JLPT_오답노트_자동동기화',
  // 사용자 고유 식별자 및 Firebase 설정 (chanchan9741 전용)
  UID: 'yvsVIEAKHXMuhJnSbsYpVHt7vK82',
  API_KEY: 'AIzaSyBhsJfgGAdHu6bONlbbC2s3Lw-EIEczb4Y',
  PROJECT_ID: 'oval-precept-462304-v7'
};

/**
 * 1. 메인 동기화 함수
 * - 매일 밤 정해진 시간에 자동 실행되거나, [실행] 버튼으로 즉시 실행 가능
 */
function autoSyncMistakesToDrive() {
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/databases/(default)/documents/users/${CONFIG.UID}/data/jlpt?key=${CONFIG.API_KEY}`;
  
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('Firebase 요청 실패: ' + response.getContentText());
      return;
    }
    
    const doc = JSON.parse(response.getContentText());
    const data = unwrapFirestore(doc);
    
    if (!data.mistakes || Object.keys(data.mistakes).length === 0) {
      Logger.log('오답노트에 기록된 문제가 없습니다.');
      return;
    }

    const mistakesList = Object.values(data.mistakes);
    Logger.log(`총 ${mistakesList.length}개의 오답을 클라우드에서 가져왔습니다.`);

    // 1) 마크다운(.md) 문서 생성
    const mdContent = generateMarkdown(mistakesList);
    
    // 2) 엑셀/CSV(.csv) 스프레드시트 생성
    const csvContent = generateCsv(mistakesList);

    // 3) 구글 드라이브 폴더 찾기 또는 자동 생성
    const folder = getOrCreateFolder(CONFIG.FOLDER_NAME);
    
    // 4) 파일 저장 또는 덮어쓰기 (중복 파일 쌓임 방지)
    const todayStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    
    // 항상 최신 상태를 유지하는 파일
    saveOrUpdateFile(folder, 'JLPT_오답노트_최신.md', mdContent, 'text/markdown;charset=utf-8');
    saveOrUpdateFile(folder, 'JLPT_오답노트_최신.csv', csvContent, 'text/csv;charset=utf-8');
    
    // 날짜별 보관 기록 파일
    saveOrUpdateFile(folder, `JLPT_오답노트_${todayStr}.md`, mdContent, 'text/markdown;charset=utf-8');
    
    Logger.log(`✅ [성공] 구글 드라이브 '${CONFIG.FOLDER_NAME}' 폴더에 오답노트 저장 완료!`);
  } catch (e) {
    Logger.log('오류 발생: ' + e.toString());
  }
}

/**
 * 2. 매일 밤 23:00 자동 실행 트리거 등록 함수
 * - Google Apps Script 에디터에서 함수 선택 후 [실행]을 딱 1번만 누르면 영구 등록됩니다.
 */
function setupDailyTrigger() {
  // 기존 중복 트리거 정리
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoSyncMistakesToDrive') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // 매일 밤 23시(오후 11시) 자동 실행 등록
  ScriptApp.newTrigger('autoSyncMistakesToDrive')
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .create();

  Logger.log('⏰ [성공] 매일 밤 23:00 자동 동기화 예약이 완료되었습니다! 이제 컴퓨터를 끄셔도 매일 밤 실행됩니다.');
}

/**
 * ----------------------------------------------------
 * 내부 도우미 함수들
 * ----------------------------------------------------
 */

// Firestore 타입 JSON 객체 변환 함수
function unwrapFirestore(val) {
  if (!val || typeof val !== 'object') return val;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return parseFloat(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    var arr = val.arrayValue.values || [];
    return arr.map(unwrapFirestore);
  }
  if ('mapValue' in val) {
    var r = {};
    var f = val.mapValue.fields || {};
    for (var k in f) r[k] = unwrapFirestore(f[k]);
    return r;
  }
  if ('fields' in val) {
    var r = {};
    for (var k in val.fields) r[k] = unwrapFirestore(val.fields[k]);
    return r;
  }
  return val;
}

// 마크다운 형식 생성
function generateMarkdown(mistakesList) {
  var nowStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy년 MM월 dd일 HH:mm');
  var activeCount = mistakesList.filter(function(m) { return !m.isMastered; }).length;
  var masteredCount = mistakesList.filter(function(m) { return m.isMastered; }).length;

  var md = '# 📓 JLPT 실시간 스마트 오답노트 (구글 드라이브 자동 저장)\n\n';
  md += '> 📅 자동 갱신 일시: ' + nowStr + ' (KST)\n';
  md += '> 📊 오답 현황: 총 ' + mistakesList.length + '문항 | 복습 대기 ' + activeCount + '문항 | 완전 정복 ' + masteredCount + '문항\n\n';
  md += '---\n\n';

  mistakesList.forEach(function(m, idx) {
    var correctOpt = (m.options || []).filter(function(o) { return o.isCorrect; })[0];
    var status = m.isMastered ? '✨ [완전 정복]' : '⚠️ [복습 대기]';
    md += '### ' + (idx + 1) + '. ' + (m.level || '') + ' ' + (m.typeName || '') + ' ' + status + ' (오답 ' + (m.count || 1) + '회)\n\n';
    if (m.instruction) md += '- **지시문**: ' + m.instruction + '\n';
    md += '- **문제**: ' + (m.qPlain || '') + '\n';
    if (m.qTrans) md += '- **해석**: ' + m.qTrans + '\n';
    
    if (m.options && m.options.length > 0) {
      md += '- **보기**:\n';
      m.options.forEach(function(o) {
        var mark = o.isCorrect ? ' **[정답]**' : '';
        var tr = o.trans ? ' (' + o.trans + ')' : '';
        md += '  - ' + o.marker + ' ' + o.copy + tr + mark + '\n';
      });
    }

    if (correctOpt) {
      md += '- **정답**: ' + correctOpt.marker + ' ' + correctOpt.copy + (correctOpt.trans ? ' (' + correctOpt.trans + ')' : '') + '\n';
    }

    if (m.ansJa) {
      md += '- **완성 문장**: ' + m.ansJa + '\n';
      if (m.ansKo) md += '- **완성 해석**: ' + m.ansKo + '\n';
    }

    if (m.expl && m.expl.main) {
      md += '- **상세 해설**: ' + m.expl.main + '\n';
      if (m.expl.choices && m.expl.choices.length > 0) {
        m.expl.choices.forEach(function(c) {
          md += '  - ' + c.marker + ': ' + c.note + '\n';
        });
      }
    }

    md += '\n---\n\n';
  });

  return md;
}

// CSV 형식 생성 (UTF-8 BOM 포함)
function generateCsv(mistakesList) {
  var headers = [
    '번호', '급수', '문제유형', '오답횟수', '정복여부', '지시사항',
    '문제(일본어)', '문제해석',
    '보기1', '보기2', '보기3', '보기4',
    '정답', '정답해석', '정답완성문장', '완성문장해석', '해설'
  ];

  function escapeCsv(cell) {
    if (cell === null || cell === undefined) return '""';
    var str = String(cell).replace(/"/g, '""').replace(/\r?\n/g, ' ');
    return '"' + str + '"';
  }

  var rows = [headers.join(',')];

  mistakesList.forEach(function(m, idx) {
    var correctOpt = (m.options || []).filter(function(o) { return o.isCorrect; })[0];
    var optTexts = (m.options || []).map(function(o) {
      var t = (o.marker || '') + ' ' + (o.copy || '');
      if (o.trans) t += ' (' + o.trans + ')';
      if (o.isCorrect) t += ' [정답]';
      return t;
    });
    while (optTexts.length < 4) optTexts.push('');

    var explText = '';
    if (m.expl && m.expl.main) {
      explText = m.expl.main;
      if (m.expl.choices && m.expl.choices.length > 0) {
        explText += ' | ' + m.expl.choices.map(function(c) { return c.marker + ': ' + c.note; }).join('; ');
      }
    }

    var row = [
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
      escapeCsv(correctOpt ? ((correctOpt.marker || '') + ' ' + (correctOpt.copy || '')) : ''),
      escapeCsv(correctOpt && correctOpt.trans ? correctOpt.trans : ''),
      escapeCsv(m.ansJa || ''),
      escapeCsv(m.ansKo || ''),
      escapeCsv(explText)
    ];
    rows.push(row.join(','));
  });

  return '\uFEFF' + rows.join('\r\n');
}

// 구글 드라이브 폴더 찾기 또는 생성
function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

// 파일 업데이트 또는 생성
function saveOrUpdateFile(folder, fileName, content, mimeType) {
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    var file = files.next();
    file.setContent(content);
    return file;
  } else {
    return folder.createFile(fileName, content, mimeType);
  }
}
