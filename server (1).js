// ============================================================
// 나만의 링크 모음 사이트 - 꾸미기 기능 포함 버전 (Supabase 사용)
//
// 이번 버전에서 추가된 기능
//  1) 프로필 사진
//  2) 배경 꾸미기 (색 / 그라데이션 / 사진), 버튼 색, 카드 배경
//  3) 설명글을 여러 개의 "섹션"으로 나누기
//  4) PNG 스티커 붙이기 (미리보기에서 끌어서 위치 옮기기)
//
// 사진 파일은 Supabase Storage(파일 보관함)의 "images" 보관함에 저장돼요.
// 비밀 정보(Supabase 주소와 키)는 코드가 아니라 환경변수에 넣어요.
// ============================================================

const http = require('http');
const crypto = require('crypto');

// ----- 설정 -----
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const IMAGE_BUCKET = 'images';                       // Supabase Storage 보관함 이름
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;            // 사진 한 장 최대 2MB
const MAX_CREATES_PER_DAY = 5;                       // 한 사람이 하루에 만들 수 있는 페이지 수
const MAX_UPLOADS_PER_PAGE_PER_DAY = 40;             // 페이지 하나당 하루 사진 업로드 수
const RESERVED = ['edit', 'api', 'create', 'admin', 'static', 'favicon.ico'];

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL 과 SUPABASE_KEY 환경변수를 설정해 주세요. (README.md 참고)');
  process.exit(1);
}

// ------------------------------------------------------------
// Supabase(데이터베이스, 파일 보관함)와 대화하는 함수들
// ------------------------------------------------------------

// 새 방식 키(sb_secret_...)는 apikey 헤더만, 예전 방식 키(eyJ...)는 Authorization도 필요해요.
function supabaseHeaders(extra) {
  const headers = Object.assign({ apikey: SUPABASE_KEY }, extra);
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY;
  return headers;
}

// 데이터베이스(표)에 요청 보내기
async function supabase(path, options) {
  options = options || {};
  const headers = supabaseHeaders(Object.assign({ 'Content-Type': 'application/json' }, options.headers));
  return fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, options, { headers: headers }));
}

const PAGE_COLUMNS = 'slug,title,bio,links,design'; // 페이지에서 읽어올 열 목록

async function getPageBySlug(slug) {
  const res = await supabase('pages?slug=eq.' + encodeURIComponent(slug) + '&select=' + PAGE_COLUMNS);
  if (!res.ok) throw new Error('DB 읽기 실패: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

async function getPageByToken(token) {
  const res = await supabase('pages?token_hash=eq.' + hash(token) + '&select=' + PAGE_COLUMNS);
  if (!res.ok) throw new Error('DB 읽기 실패: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

// 새 페이지 저장. 상태 숫자를 돌려줘요. (409 = 이미 있는 주소)
async function createPage(row) {
  const res = await supabase('pages', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row)
  });
  return res.status;
}

async function updatePage(slug, changes) {
  const res = await supabase('pages?slug=eq.' + encodeURIComponent(slug), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(changes)
  });
  if (!res.ok) throw new Error('DB 저장 실패: ' + res.status);
}

// 사진 파일을 Supabase 파일 보관함에 올리기
async function uploadToStorage(path, buffer, contentType) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + IMAGE_BUCKET + '/' + path, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': contentType }),
    body: buffer
  });
  if (!res.ok) throw new Error('사진 저장 실패: ' + res.status + ' ' + (await res.text()));
}

// 보관함에 올린 사진을 누구나 볼 수 있는 주소
function publicImageUrl(path) {
  return SUPABASE_URL + '/storage/v1/object/public/' + IMAGE_BUCKET + '/' + path;
}

// ------------------------------------------------------------
// 스팸 방지: "누가 / 얼마나 자주" 요청했는지 기억해 둬요.
// (서버 메모리에 저장하므로 서버가 재시작되면 초기화돼요. 기본 보호용이에요.)
// ------------------------------------------------------------
const logs = {}; // { "create:IP": [시각, 시각...], "upload-slug:mypage": [...] }
const DAY = 24 * 60 * 60 * 1000;

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function isLimited(key, max) {
  const now = Date.now();
  const recent = (logs[key] || []).filter(function (t) { return now - t < DAY; });
  logs[key] = recent;
  return recent.length >= max;
}

function recordHit(key) {
  (logs[key] = logs[key] || []).push(Date.now());
}

// ------------------------------------------------------------
// 도우미 함수들
// ------------------------------------------------------------
function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 위험한 문자(<script> 등)를 무해한 글자로 바꿔요.
// ※ 이 함수는 브라우저(수정 화면 미리보기)에서도 똑같이 쓰여요.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function isSafeUrl(url) {
  return /^https?:\/\//i.test(url);
}

function isValidToken(token) {
  return /^[a-f0-9]{48}$/.test(token);
}

function getOrigin(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

// 글자 데이터 받기
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (chunk) {
      data += chunk;
      if (data.length > 200000) {
        reject(new Error('요청이 너무 커요'));
        req.destroy();
      }
    });
    req.on('end', function () { resolve(data); });
  });
}

// 사진 같은 파일 데이터 받기 (limit 바이트를 넘으면 거절)
function readBodyBuffer(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) { tooBig = true; return; } // 넘치면 버리고 끝까지 받기만 해요
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (tooBig) reject(new Error('too big'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ------------------------------------------------------------
// 사진 검사: 파일 맨 앞 몇 글자(매직 바이트)를 보고 진짜 사진인지 확인해요.
// (파일 이름이나 보낸 사람의 말은 믿지 않아요!)
// ------------------------------------------------------------
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function detectImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

// ------------------------------------------------------------
// 꾸미기 정보(design) 다루기
// design 안에 들어있는 것: avatar(프로필 사진), bg(배경), accent(버튼 색),
//                          panel(카드 배경), textColor(글자색), sections(설명 섹션), stickers(스티커)
// ------------------------------------------------------------
function isHexColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}

// 우리 보관함에 있는, 이 페이지의 사진 주소인지 확인해요. (남의 사이트 이미지는 거절)
function isOurImageUrl(url, slug) {
  if (typeof url !== 'string') return false;
  const prefix = publicImageUrl(slug + '/');
  if (!url.startsWith(prefix)) return false;
  return /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(url.slice(prefix.length));
}

// 저장돼 있는 design에 빠진 값이 있으면 기본값으로 채워요.
function normalizeDesign(page) {
  const d = page.design || {};
  const bg = d.bg || {};
  return {
    avatar: d.avatar || '',
    bg: { type: bg.type || 'color', color1: bg.color1 || '#f3f0ff', color2: bg.color2 || '#d6ccff', image: bg.image || '' },
    accent: d.accent || '#6c5ce7',
    panel: d.panel !== false,
    textColor: d.textColor === 'light' ? 'light' : 'dark',
    sections: Array.isArray(d.sections) ? d.sections : (page.bio ? [{ heading: '', text: page.bio }] : []),
    stickers: Array.isArray(d.stickers) ? d.stickers : []
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// 사용자가 보낸 design을 꼼꼼히 검사하고 깨끗하게 정리해요. 문제가 있으면 { error } 를 돌려줘요.
function validateDesign(input, slug) {
  if (!input || typeof input !== 'object') return { error: '꾸미기 정보가 올바르지 않아요.' };
  const bg = input.bg || {};

  if (!['color', 'gradient', 'image'].includes(bg.type)) return { error: '배경 종류가 올바르지 않아요.' };
  if (!isHexColor(bg.color1) || !isHexColor(bg.color2) || !isHexColor(input.accent)) {
    return { error: '색 형식이 올바르지 않아요.' };
  }
  if (input.avatar && !isOurImageUrl(input.avatar, slug)) return { error: '프로필 사진 주소가 올바르지 않아요.' };
  if (bg.image && !isOurImageUrl(bg.image, slug)) return { error: '배경 사진 주소가 올바르지 않아요.' };
  if (!['dark', 'light'].includes(input.textColor)) return { error: '글자색이 올바르지 않아요.' };

  if (!Array.isArray(input.sections) || input.sections.length > 8) return { error: '섹션은 최대 8개까지예요.' };
  const sections = [];
  for (const s of input.sections) {
    if (!s || typeof s.heading !== 'string' || typeof s.text !== 'string') return { error: '섹션 형식이 잘못됐어요.' };
    if (s.heading.length > 30) return { error: '섹션 제목은 30자 이하여야 해요.' };
    if (s.text.length > 500) return { error: '섹션 내용은 500자 이하여야 해요.' };
    if (s.heading.trim() || s.text.trim()) sections.push({ heading: s.heading.trim(), text: s.text.trim() });
  }

  if (!Array.isArray(input.stickers) || input.stickers.length > 10) return { error: '스티커는 최대 10개까지예요.' };
  const stickers = [];
  for (const s of input.stickers) {
    if (!s || !isOurImageUrl(s.src, slug)) return { error: '스티커 사진 주소가 올바르지 않아요.' };
    if (![s.x, s.y, s.w].every(Number.isFinite)) return { error: '스티커 위치 정보가 올바르지 않아요.' };
    stickers.push({ src: s.src, x: Math.round(clamp(s.x, 0, 100) * 10) / 10, y: Math.round(clamp(s.y, 0, 3000)), w: Math.round(clamp(s.w, 30, 300)) });
  }

  return {
    design: {
      avatar: input.avatar || '',
      bg: { type: bg.type, color1: bg.color1, color2: bg.color2, image: bg.image || '' },
      accent: input.accent,
      panel: input.panel === true,
      textColor: input.textColor,
      sections: sections,
      stickers: stickers
    }
  };
}

// ------------------------------------------------------------
// 5) 화면(HTML) 만들기
// ------------------------------------------------------------

// 모든 페이지에 공통으로 들어가는 껍데기 (꾸밈 CSS 포함)
function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: sans-serif; background: #f3f0ff; margin: 0; padding: 40px 16px; }
    .card { max-width: 440px; margin: 0 auto; background: white; border-radius: 20px;
            padding: 32px 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    h1 { margin-top: 0; font-size: 24px; text-align: center; }
    p.bio { text-align: center; color: #666; }
    a.link-btn { display: block; background: #6c5ce7; color: white; text-decoration: none;
                 text-align: center; padding: 14px; border-radius: 12px; margin: 12px 0; font-weight: bold; }
    a.link-btn:hover { background: #5847d6; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 10px; margin: 6px 0;
                      border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
    button { background: #6c5ce7; color: white; border: none; padding: 12px 18px;
             border-radius: 10px; font-size: 15px; cursor: pointer; margin: 6px 4px 6px 0; }
    button.gray { background: #b2bec3; }
    button.red { background: #d63031; padding: 8px 12px; }
    .link-row { background: #f8f8f8; padding: 10px; border-radius: 10px; margin: 10px 0; }
    .box { background: #ffeaa7; padding: 14px; border-radius: 10px; word-break: break-all; }
    .small { color: #888; font-size: 13px; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

// 첫 화면: 페이지 만들기
function homePage(error) {
  return layout('내 링크 페이지 만들기', `
    <h1>🔗 내 링크 페이지 만들기</h1>
    <p class="bio">가입 없이 1분 만에 만들 수 있어요.</p>
    ${error ? `<p style="color:#d63031">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="/create">
      <label>원하는 주소 (영어 소문자, 숫자, -, _ / 3~20자)</label>
      <input name="slug" placeholder="예: mypage" required>
      <button type="submit">페이지 만들기</button>
    </form>
  `);
}

// ------------------------------------------------------------
// 페이지 그리기 (공개 페이지와 수정 화면 미리보기가 똑같은 코드를 써요)
// ※ 아래 readableText / bgCss / renderPage 함수는 브라우저로도 복사돼서 실행되므로,
//   서버 전용 기능(require, process 등)을 쓰면 안 돼요.
// ------------------------------------------------------------

// 배경색이 밝은지 어두운지 보고, 그 위에 올릴 글자색(검정/흰색)을 골라줘요.
function readableText(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#222222' : '#ffffff';
}

// 배경 설정(design.bg)을 CSS 글자로 바꿔요.
function bgCss(d) {
  const bg = d.bg;
  if (bg.type === 'image' && bg.image) return "background:#333 url('" + bg.image + "') center / cover no-repeat;";
  if (bg.type === 'gradient') return 'background:linear-gradient(160deg,' + bg.color1 + ',' + bg.color2 + ');';
  return 'background:' + bg.color1 + ';';
}

// 페이지 내용(프로필 사진, 제목, 섹션, 링크 버튼, 스티커)을 HTML로 만들어요.
function renderPage(page) {
  const d = page.design;
  const textColor = (d.panel || d.textColor === 'dark') ? '#222222' : '#ffffff';

  let html = '<div class="stage" style="color:' + textColor + '">';
  html += '<div class="panel' + (d.panel ? ' on' : '') + '">';
  if (d.avatar) html += '<img class="avatar" src="' + escapeHtml(d.avatar) + '" alt="">';
  html += '<h1>' + escapeHtml(page.title) + '</h1>';

  d.sections.forEach(function (s) {
    if (s.heading) html += '<h3>' + escapeHtml(s.heading) + '</h3>';
    if (s.text) html += '<p class="sec-text">' + escapeHtml(s.text) + '</p>';
  });

  page.links.forEach(function (l) {
    const btnBg = l.color || d.accent; // 버튼마다 정한 색이 있으면 그 색, 없으면 기본 버튼 색
    html += '<a class="link-btn" style="background:' + btnBg + ';color:' + readableText(btnBg) + '" href="' +
      escapeHtml(l.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(l.title) + '</a>';
  });
  html += '</div>';

  // 스티커: 가로 위치는 %, 세로 위치는 px (맨 위에서부터)
  d.stickers.forEach(function (s, i) {
    html += '<img class="sticker" data-i="' + i + '" src="' + escapeHtml(s.src) + '" alt="" style="left:' +
      Number(s.x) + '%;top:' + Number(s.y) + 'px;width:' + Number(s.w) + 'px">';
  });
  html += '</div>';
  return html;
}

// 페이지 꾸밈에 쓰는 CSS (공개 페이지와 미리보기 공통)
const PAGE_CSS = `
.stage { position: relative; max-width: 440px; margin: 0 auto; padding: 40px 16px 80px; min-height: 100vh; box-sizing: border-box; font-family: sans-serif; }
.panel { border-radius: 20px; padding: 28px 20px; text-align: center; }
.panel.on { background: rgba(255,255,255,0.88); box-shadow: 0 4px 20px rgba(0,0,0,0.12); }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 12px; }
.panel h1 { margin: 0 0 12px; font-size: 24px; word-break: break-word; }
.panel h3 { margin: 20px 0 4px; font-size: 16px; }
.sec-text { margin: 0 0 6px; white-space: pre-wrap; line-height: 1.5; word-break: break-word; }
.link-btn { display: block; text-decoration: none; text-align: center; padding: 14px; border-radius: 12px; margin: 12px 0; font-weight: bold; }
.link-btn:hover { filter: brightness(0.92); }
.sticker { position: absolute; transform: translateX(-50%); pointer-events: none; user-select: none; }
`;

// 방문자가 보는 공개 페이지
function publicPage(page) {
  const design = normalizeDesign(page);
  const view = { title: page.title, links: page.links || [], design: design };
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(page.title) + '</title>' +
    '<style>body{margin:0;overflow-x:hidden;min-height:100vh;' + bgCss(design) + '}' + PAGE_CSS + '</style>' +
    '</head><body>' + renderPage(view) + '</body></html>';
}

// 만들기 성공 후: 수정 주소를 딱 한 번 보여주는 화면
function createdPage(slug, editUrl, publicUrl) {
  return layout('만들기 완료', `
    <h1>🎉 페이지가 만들어졌어요!</h1>
    <p><b>공개 주소</b> (인스타 프로필 등에 붙여넣기)</p>
    <div class="box"><a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></div>
    <p><b>수정 주소</b> (나만 알아야 해요!)</p>
    <div class="box"><a href="${escapeHtml(editUrl)}">${escapeHtml(editUrl)}</a></div>
    <p style="color:#d63031"><b>⚠️ 수정 주소는 지금만 보여드려요. 꼭 복사해서 저장해 두세요!</b><br>
    잃어버리면 다시 수정할 수 없어요.</p>
    <a href="${escapeHtml(editUrl)}"><button>바로 수정하러 가기</button></a>
  `);
}

// 수정(꾸미기) 화면
function editPage(token, page) {
  const design = normalizeDesign(page);
  // 서버 데이터를 화면의 자바스크립트로 안전하게 넘겨주는 부분
  const initial = JSON.stringify({ title: page.title, links: page.links || [], design: design }).replace(/</g, '\\u003c');
  // 공개 페이지를 그리는 함수들을 브라우저에서도 쓸 수 있게 글자 그대로 복사해서 넣어요.
  const shared = [escapeHtml, readableText, bgCss, renderPage].map(String).join('\n\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>페이지 꾸미기</title>
<style>
  body { margin: 0; background: #eceaf7; font-family: sans-serif; color: #222; }
  .wrap { display: flex; flex-wrap: wrap; gap: 20px; max-width: 1000px; margin: 0 auto; padding: 20px 16px 100px; box-sizing: border-box; }
  .left { flex: 0 0 440px; max-width: 100%; }
  .sticky { position: sticky; top: 16px; }
  .right { flex: 1; min-width: 300px; }
  .preview { min-height: 620px; border: 1px solid #ccc; }
  .preview .stage { min-height: 620px; }
  .preview .sticker { pointer-events: auto; cursor: grab; touch-action: none; }
  .box { background: white; border-radius: 16px; padding: 16px; margin-bottom: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
  .box h2 { margin: 0 0 10px; font-size: 17px; }
  label { display: block; font-size: 14px; color: #555; margin-top: 8px; }
  input[type=text], input[type=url], textarea, select { width: 100%; box-sizing: border-box; padding: 10px; margin: 4px 0; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; }
  input[type=color] { width: 56px; height: 36px; border: 1px solid #ccc; border-radius: 8px; padding: 2px; background: white; }
  button { background: #6c5ce7; color: white; border: none; padding: 10px 14px; border-radius: 10px; font-size: 14px; cursor: pointer; margin: 4px 4px 4px 0; }
  button.gray { background: #b2bec3; }
  button.red { background: #d63031; }
  .item { background: #f8f8f8; border-radius: 10px; padding: 10px; margin: 8px 0; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .thumb { width: 56px; height: 56px; border-radius: 10px; object-fit: contain; background: #ddd; }
  .swatch { width: 40px; height: 40px; border-radius: 10px; border: 2px solid white; box-shadow: 0 0 0 1px #bbb; padding: 0; margin: 4px 6px 4px 0; }
  .hint, .small { color: #777; font-size: 13px; }
  .savebar { position: fixed; left: 0; right: 0; bottom: 0; background: white; border-top: 1px solid #ddd; padding: 10px 16px; text-align: center; }
  .savebar button { font-size: 16px; padding: 12px 32px; }
  ${PAGE_CSS}
</style>
</head>
<body>
<div class="wrap">
  <div class="left"><div class="sticky">
    <div id="preview" class="preview"></div>
    <p class="hint">✨ 스티커는 미리보기에서 손가락이나 마우스로 끌어서 옮길 수 있어요.</p>
  </div></div>

  <div class="right">
    <div class="box">
      <h2>✏️ 내 페이지 꾸미기</h2>
      <a href="/${escapeHtml(page.slug)}" target="_blank">내 페이지 열어보기 ↗</a>
    </div>

    <div class="box">
      <h2>기본 정보</h2>
      <label>제목</label>
      <input type="text" id="title" maxlength="50">
      <label>프로필 사진</label>
      <div class="row">
        <img id="avatarThumb" class="thumb" alt="">
        <input type="file" id="avatarFile" accept="image/png,image/jpeg,image/webp">
        <button class="gray" id="avatarDel">사진 지우기</button>
      </div>
    </div>

    <div class="box">
      <h2>배경과 색</h2>
      <div id="presets"></div>
      <label>배경 종류</label>
      <select id="bgType">
        <option value="color">한 가지 색</option>
        <option value="gradient">그라데이션 (두 가지 색)</option>
        <option value="image">내 사진</option>
      </select>
      <div class="row" id="rowColors">
        <label>색 1 <input type="color" id="bgColor1"></label>
        <label id="color2Label">색 2 <input type="color" id="bgColor2"></label>
      </div>
      <div id="rowImage">
        <label>배경 사진</label>
        <input type="file" id="bgFile" accept="image/png,image/jpeg,image/webp">
      </div>
      <label><input type="checkbox" id="panel"> 내용 뒤에 반투명 흰색 카드 깔기 (글자가 잘 보여요)</label>
      <div id="textColorRow">
        <label>글자색 (카드를 끄면 적용돼요)</label>
        <select id="textColor"><option value="dark">검정</option><option value="light">흰색</option></select>
      </div>
      <label>링크 버튼 기본 색 <input type="color" id="accent"></label>
      <p class="hint">버튼마다 다른 색을 쓰고 싶으면 아래 '링크' 칸에서 각 버튼의 "이 버튼만 다른 색"을 켜세요.</p>
    </div>

    <div class="box">
      <h2>설명 섹션</h2>
      <p class="hint">설명글을 제목이 있는 여러 덩어리로 나눌 수 있어요. (최대 8개)</p>
      <div id="sections"></div>
      <button class="gray" id="addSection">+ 섹션 추가</button>
    </div>

    <div class="box">
      <h2>링크</h2>
      <div id="links"></div>
      <button class="gray" id="addLink">+ 링크 추가</button>
    </div>

    <div class="box">
      <h2>스티커</h2>
      <p class="hint">PNG 파일을 올리면 미리보기에 붙어요. 배경이 투명한 PNG가 예쁘게 나와요. (최대 10개)</p>
      <input type="file" id="stickerFile" accept="image/png,image/webp,image/jpeg">
      <div id="stickers"></div>
    </div>
  </div>
</div>

<div class="savebar"><button id="saveBtn">저장하기</button> <span id="msg" class="small"></span></div>

<script>
// ===== 이 아래는 브라우저 안에서 움직이는 코드예요 =====
const token = ${JSON.stringify(token)};
const data = ${initial};      // 지금 저장되어 있는 내용 (이 안의 값을 고치면서 편집해요)
const design = data.design;
let dirty = false;            // 저장하지 않은 변경이 있는지

// ----- 공개 페이지를 그리는 함수들 (서버 코드에서 복사됨) -----
${shared}

function $(id) { return document.getElementById(id); }
const preview = $('preview');

function setMsg(text) { $('msg').textContent = text; }

// 미리보기를 다시 그려요.
function refresh() {
  preview.style.cssText = bgCss(design) + 'border-radius:16px;overflow:hidden;';
  preview.innerHTML = renderPage(data);
}

// 무언가 바뀌었을 때 부르는 함수
function changed() { dirty = true; refresh(); }
window.onbeforeunload = function () { return dirty ? '저장하지 않은 변경이 있어요.' : undefined; };

// 미리보기 안의 링크는 눌러도 이동하지 않게 해요.
preview.addEventListener('click', function (e) { if (e.target.closest('a')) e.preventDefault(); });

// ----- 사진을 줄여서 서버에 올리는 함수 -----
function shrinkImage(file, maxSize, outType) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function () {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (outType === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('사진을 변환하지 못했어요.'));
      }, outType, 0.85);
    };
    img.onerror = function () { reject(new Error('사진 파일을 읽을 수 없어요.')); };
    img.src = url;
  });
}

async function uploadImage(file, maxSize, outType) {
  setMsg('사진 올리는 중...');
  try {
    const blob = await shrinkImage(file, maxSize, outType);
    const res = await fetch('/api/upload/' + token, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error);
    setMsg('');
    return result.url;
  } catch (err) {
    setMsg('❌ ' + err.message);
    return null;
  }
}

// ----- 기본 정보 -----
$('title').value = data.title;
$('title').oninput = function () { data.title = $('title').value; changed(); };

function showAvatar() {
  $('avatarThumb').style.display = design.avatar ? 'block' : 'none';
  if (design.avatar) $('avatarThumb').src = design.avatar;
}
$('avatarFile').onchange = async function (e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const url = await uploadImage(file, 400, 'image/jpeg');
  if (url) { design.avatar = url; showAvatar(); changed(); }
};
$('avatarDel').onclick = function () { design.avatar = ''; showAvatar(); changed(); };

// ----- 배경과 색 -----
const PRESETS = [['#f3f0ff', '#f3f0ff'], ['#ffeaa7', '#fab1a0'], ['#a29bfe', '#74b9ff'], ['#55efc4', '#81ecec'], ['#fd79a8', '#fdcb6e'], ['#2d3436', '#636e72']];

function syncBgControls() {
  $('bgType').value = design.bg.type;
  $('bgColor1').value = design.bg.color1;
  $('bgColor2').value = design.bg.color2;
  $('rowColors').style.display = design.bg.type === 'image' ? 'none' : 'flex';
  $('color2Label').style.display = design.bg.type === 'gradient' ? 'block' : 'none';
  $('rowImage').style.display = design.bg.type === 'image' ? 'block' : 'none';
  $('panel').checked = design.panel;
  $('textColor').value = design.textColor;
  $('textColorRow').style.display = design.panel ? 'none' : 'block';
  $('accent').value = design.accent;
}

PRESETS.forEach(function (p) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.title = '추천 배경';
  b.style.background = p[0] === p[1] ? p[0] : 'linear-gradient(160deg,' + p[0] + ',' + p[1] + ')';
  b.onclick = function () {
    design.bg.type = p[0] === p[1] ? 'color' : 'gradient';
    design.bg.color1 = p[0]; design.bg.color2 = p[1];
    syncBgControls(); changed();
  };
  $('presets').appendChild(b);
});

$('bgType').onchange = function () { design.bg.type = $('bgType').value; syncBgControls(); changed(); };
$('bgColor1').oninput = function () { design.bg.color1 = $('bgColor1').value; changed(); };
$('bgColor2').oninput = function () { design.bg.color2 = $('bgColor2').value; changed(); };
$('bgFile').onchange = async function (e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const url = await uploadImage(file, 1200, 'image/jpeg');
  if (url) { design.bg.image = url; design.bg.type = 'image'; syncBgControls(); changed(); }
};
$('panel').onchange = function () { design.panel = $('panel').checked; syncBgControls(); changed(); };
$('textColor').onchange = function () { design.textColor = $('textColor').value; changed(); };
$('accent').oninput = function () { design.accent = $('accent').value; drawLinks(); changed(); };

// ----- 목록 편집 도우미: 위로/아래로 옮기기 -----
function move(list, i, dir, redraw) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const temp = list[i]; list[i] = list[j]; list[j] = temp;
  redraw(); changed();
}

function button(text, cls, onclick) {
  const b = document.createElement('button');
  b.textContent = text; b.className = cls; b.onclick = onclick;
  return b;
}

// ----- 설명 섹션 -----
function drawSections() {
  const box = $('sections'); box.innerHTML = '';
  design.sections.forEach(function (s, i) {
    const item = document.createElement('div'); item.className = 'item';
    const h = document.createElement('input'); h.type = 'text'; h.maxLength = 30; h.placeholder = '섹션 제목 (비워도 돼요)'; h.value = s.heading;
    h.oninput = function () { s.heading = h.value; changed(); };
    const t = document.createElement('textarea'); t.rows = 3; t.maxLength = 500; t.placeholder = '내용'; t.value = s.text;
    t.oninput = function () { s.text = t.value; changed(); };
    item.append(h, t,
      button('↑', 'gray', function () { move(design.sections, i, -1, drawSections); }),
      button('↓', 'gray', function () { move(design.sections, i, 1, drawSections); }),
      button('삭제', 'red', function () { design.sections.splice(i, 1); drawSections(); changed(); }));
    box.appendChild(item);
  });
}
$('addSection').onclick = function () {
  if (design.sections.length >= 8) { setMsg('섹션은 최대 8개까지예요.'); return; }
  design.sections.push({ heading: '', text: '' }); drawSections(); changed();
};

// ----- 링크 -----
function drawLinks() {
  const box = $('links'); box.innerHTML = '';
  data.links.forEach(function (l, i) {
    const item = document.createElement('div'); item.className = 'item';
    const t = document.createElement('input'); t.type = 'text'; t.placeholder = '버튼 이름 (예: 인스타그램)'; t.value = l.title;
    t.oninput = function () { l.title = t.value; changed(); };
    const u = document.createElement('input'); u.type = 'text'; u.placeholder = '주소 (https:// 로 시작)'; u.value = l.url;
    u.oninput = function () { l.url = u.value; changed(); };
    // 이 버튼만의 색 (체크하면 직접 고르고, 끄면 기본 버튼 색을 써요)
    const colorRow = document.createElement('label');
    const use = document.createElement('input'); use.type = 'checkbox'; use.checked = !!l.color;
    const col = document.createElement('input'); col.type = 'color'; col.value = l.color || design.accent; col.disabled = !l.color;
    use.onchange = function () {
      if (use.checked) { l.color = col.value; col.disabled = false; }
      else { l.color = ''; col.disabled = true; col.value = design.accent; }
      changed();
    };
    col.oninput = function () { l.color = col.value; changed(); };
    colorRow.append(use, ' 이 버튼만 다른 색 ', col);
    item.append(t, u, colorRow,
      button('↑', 'gray', function () { move(data.links, i, -1, drawLinks); }),
      button('↓', 'gray', function () { move(data.links, i, 1, drawLinks); }),
      button('삭제', 'red', function () { data.links.splice(i, 1); drawLinks(); changed(); }));
    box.appendChild(item);
  });
}
$('addLink').onclick = function () {
  if (data.links.length >= 30) { setMsg('링크는 최대 30개까지예요.'); return; }
  data.links.push({ title: '', url: '' }); drawLinks(); changed();
};

// ----- 스티커 -----
function drawStickers() {
  const box = $('stickers'); box.innerHTML = '';
  design.stickers.forEach(function (s, i) {
    const item = document.createElement('div'); item.className = 'item row';
    const img = document.createElement('img'); img.className = 'thumb'; img.src = s.src;
    const range = document.createElement('input'); range.type = 'range'; range.min = 30; range.max = 300; range.value = s.w; range.title = '크기';
    range.oninput = function () { s.w = Number(range.value); changed(); };
    item.append(img, range, button('삭제', 'red', function () { design.stickers.splice(i, 1); drawStickers(); changed(); }));
    box.appendChild(item);
  });
}
$('stickerFile').onchange = async function (e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (design.stickers.length >= 10) { setMsg('스티커는 최대 10개까지예요.'); return; }
  const url = await uploadImage(file, 400, 'image/png');   // PNG로 저장해서 투명 배경을 유지해요
  if (url) {
    design.stickers.push({ src: url, x: 50, y: 40 + design.stickers.length * 30, w: 120 });
    drawStickers(); changed();
  }
};

// 스티커 끌어서 옮기기 (마우스와 터치 모두 동작)
let drag = null;
preview.addEventListener('pointerdown', function (e) {
  const img = e.target.closest('.sticker');
  if (!img) return;
  e.preventDefault();
  const s = design.stickers[Number(img.dataset.i)];
  const rect = preview.querySelector('.stage').getBoundingClientRect();
  drag = { s: s, img: img, dx: e.clientX - (rect.left + s.x / 100 * rect.width), dy: e.clientY - (rect.top + s.y) };
  img.setPointerCapture(e.pointerId);
});
preview.addEventListener('pointermove', function (e) {
  if (!drag) return;
  const rect = preview.querySelector('.stage').getBoundingClientRect();
  const x = (e.clientX - drag.dx - rect.left) / rect.width * 100;
  const y = e.clientY - drag.dy - rect.top;
  drag.s.x = Math.round(Math.min(100, Math.max(0, x)) * 10) / 10;
  drag.s.y = Math.round(Math.min(3000, Math.max(0, y)));
  drag.img.style.left = drag.s.x + '%';
  drag.img.style.top = drag.s.y + 'px';
});
preview.addEventListener('pointerup', function () { if (drag) { drag = null; dirty = true; } });

// ----- 저장 -----
$('saveBtn').onclick = async function () {
  setMsg('저장 중...');
  try {
    const res = await fetch('/api/save/' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: data.title, links: data.links, design: design })
    });
    const result = await res.json();
    if (result.ok) { dirty = false; setMsg('✅ 저장됐어요!'); } else { setMsg('❌ ' + result.error); }
  } catch (err) {
    setMsg('❌ 저장하지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
};

// ----- 처음 화면 그리기 -----
showAvatar(); syncBgControls(); drawSections(); drawLinks(); drawStickers(); refresh();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------
// 서버 본체: 주소(URL)에 따라 할 일을 나눠요
// (await 는 "데이터베이스 대답이 올 때까지 기다려!" 라는 뜻이에요)
// ------------------------------------------------------------
const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean); // "/edit/abc" → ["edit", "abc"]

    // (가) 첫 화면:  GET /
    if (req.method === 'GET' && parts.length === 0) {
      return sendHtml(res, 200, homePage());
    }

    // (나) 페이지 만들기:  POST /create
    if (req.method === 'POST' && parts[0] === 'create') {
      const ip = getIp(req);
      if (isLimited('create:' + ip, MAX_CREATES_PER_DAY)) {
        return sendHtml(res, 429, homePage('오늘 만들 수 있는 페이지 수를 모두 사용했어요. 내일 다시 시도해 주세요.'));
      }

      const form = new URLSearchParams(await readBody(req));
      const slug = (form.get('slug') || '').trim().toLowerCase();

      if (!/^[a-z0-9_-]{3,20}$/.test(slug)) {
        return sendHtml(res, 400, homePage('주소는 영어 소문자, 숫자, -, _ 로 3~20자여야 해요.'));
      }
      if (RESERVED.includes(slug)) {
        return sendHtml(res, 400, homePage('이미 사용 중이거나 쓸 수 없는 주소예요.'));
      }

      // 길고 예측 불가능한 수정용 비밀번호(토큰) 만들기 (24바이트 = 48글자)
      const token = crypto.randomBytes(24).toString('hex');

      // 토큰 "원본"은 저장하지 않고 해시만 저장해요!
      const status = await createPage({ slug: slug, token_hash: hash(token), title: slug, bio: '', links: [] });
      if (status === 409) {
        return sendHtml(res, 400, homePage('이미 사용 중이거나 쓸 수 없는 주소예요.'));
      }
      if (status >= 300) throw new Error('페이지 만들기 실패: ' + status);

      recordHit('create:' + ip);
      const origin = getOrigin(req);
      return sendHtml(res, 200, createdPage(slug, origin + '/edit/' + token, origin + '/' + slug));
    }

    // (다) 수정 화면 보기:  GET /edit/토큰
    if (req.method === 'GET' && parts[0] === 'edit' && parts.length === 2) {
      const page = isValidToken(parts[1]) ? await getPageByToken(parts[1]) : null;
      if (!page) return sendHtml(res, 404, layout('없음', '<h1>잘못된 수정 주소예요.</h1>'));
      return sendHtml(res, 200, editPage(parts[1], page));
    }

    // (라) 사진 올리기:  POST /api/upload/토큰
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'upload' && parts.length === 3) {
      const page = isValidToken(parts[2]) ? await getPageByToken(parts[2]) : null;
      if (!page) return sendJson(res, 403, { ok: false, error: '수정 권한이 없어요.' });

      const ip = getIp(req);
      const slugKey = 'upload-slug:' + page.slug;
      const ipKey = 'upload-ip:' + ip;
      if (isLimited(slugKey, MAX_UPLOADS_PER_PAGE_PER_DAY) || isLimited(ipKey, 100)) {
        return sendJson(res, 429, { ok: false, error: '오늘 올릴 수 있는 사진 수를 모두 사용했어요.' });
      }

      let buf;
      try {
        buf = await readBodyBuffer(req, MAX_UPLOAD_BYTES);
      } catch (e) {
        return sendJson(res, 413, { ok: false, error: '사진이 너무 커요. (최대 2MB)' });
      }

      const type = detectImageType(buf); // 파일 내용을 직접 보고 PNG/JPG/WEBP인지 확인
      if (!type) return sendJson(res, 400, { ok: false, error: 'PNG, JPG, WEBP 사진만 올릴 수 있어요.' });

      // 파일 이름은 우리가 정해요: 주소/랜덤32글자.확장자
      const path = page.slug + '/' + crypto.randomBytes(16).toString('hex') + '.' + type;
      await uploadToStorage(path, buf, MIME[type]);

      recordHit(slugKey);
      recordHit(ipKey);
      return sendJson(res, 200, { ok: true, url: publicImageUrl(path) });
    }

    // (마) 저장하기:  POST /api/save/토큰
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'save' && parts.length === 3) {
      const page = isValidToken(parts[2]) ? await getPageByToken(parts[2]) : null;
      if (!page) return sendJson(res, 403, { ok: false, error: '수정 권한이 없어요.' });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: '보낸 데이터를 읽을 수 없어요.' });
      }

      // 받은 내용을 꼼꼼히 검사해요 (믿지 말고 항상 확인하기!)
      if (typeof body.title !== 'string' || body.title.length > 50) {
        return sendJson(res, 400, { ok: false, error: '제목은 50자 이하여야 해요.' });
      }
      if (!Array.isArray(body.links) || body.links.length > 30) {
        return sendJson(res, 400, { ok: false, error: '링크는 최대 30개까지예요.' });
      }
      const cleanLinks = [];
      for (const l of body.links) {
        if (!l || typeof l.title !== 'string' || typeof l.url !== 'string') {
          return sendJson(res, 400, { ok: false, error: '링크 형식이 잘못됐어요.' });
        }
        if (l.title.length > 50 || l.url.length > 500) {
          return sendJson(res, 400, { ok: false, error: '링크 이름 또는 주소가 너무 길어요.' });
        }
        if (!isSafeUrl(l.url.trim())) {
          return sendJson(res, 400, { ok: false, error: '주소는 http:// 또는 https:// 로 시작해야 해요.' });
        }
        const color = l.color || '';  // 비어 있으면 "기본 버튼 색을 쓴다"는 뜻
        if (color && !isHexColor(color)) {
          return sendJson(res, 400, { ok: false, error: '버튼 색 형식이 올바르지 않아요.' });
        }
        cleanLinks.push({ title: l.title.trim() || l.url.trim(), url: l.url.trim(), color: color });
      }

      const checked = validateDesign(body.design, page.slug); // 꾸미기 정보 검사
      if (checked.error) return sendJson(res, 400, { ok: false, error: checked.error });

      await updatePage(page.slug, {
        title: body.title.trim() || page.slug,
        links: cleanLinks,
        design: checked.design
      });
      return sendJson(res, 200, { ok: true });
    }

    // (바) 공개 페이지 보기:  GET /주소
    if (req.method === 'GET' && parts.length === 1 && /^[a-z0-9_-]{3,20}$/.test(parts[0])) {
      const page = await getPageBySlug(parts[0]);
      if (page) return sendHtml(res, 200, publicPage(page));
    }

    return sendHtml(res, 404, layout('없음', '<h1>페이지를 찾을 수 없어요.</h1><p class="bio"><a href="/">처음으로</a></p>'));

  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

server.listen(PORT, function () {
  console.log('서버가 켜졌어요! 포트 번호: ' + PORT);
});
