// ============================================================
// 나만의 링크 모음 사이트 - 꾸미기 기능 포함 버전 (Supabase 사용)
//
// 이번 버전에서 추가된 기능
//  1) 프로필 사진, 제목 아래 짧은 설명 (제목과 설명은 비워도 돼요)
//  2) 배경 꾸미기, 버튼 색/모양, 글자 크기, 글 정렬
//  3) 둥근 카드 블록: 글 / 토글 / 사진 갤러리 / 일정 캘린더
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
const MAX_UPLOADS_PER_PAGE_PER_DAY = 100;            // 페이지 하나당 하루 사진 업로드 수
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
// design 안에 들어있는 것:
//   avatar(프로필 사진), bg(배경), accent(버튼 기본 색), cardStyle(카드 모양), textColor(글자색),
//   header(머리글 배치/정렬), subtitle(제목 아래 짧은 설명), fonts(글자 크기들),
//   linkStyle/linkLayout(링크 버튼 모양/배열),
//   blocks(내용 블록: 글/토글/사진 갤러리/일정 캘린더), stickers(스티커)
// ------------------------------------------------------------
const FONT_LIMITS = { title: [14, 60, 26], sub: [10, 28, 14], body: [11, 28, 15], btn: [11, 28, 15] }; // [최소, 최대, 기본값]
const ALIGNS = ['left', 'center', 'right'];
const BLOCK_TYPES = ['text', 'toggle', 'gallery', 'calendar'];
const MAX_BLOCKS = 12;

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

// 진짜 있는 날짜인지 확인 (예: 2026-02-30 은 거절)
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// 허용 목록 안의 값이면 그대로, 아니면 기본값
function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// 저장돼 있는 design에 빠진 값이 있으면 기본값으로 채워요. (예전에 만든 페이지도 그대로 열려요)
function normalizeDesign(page) {
  const d = page.design || {};
  const bg = d.bg || {};
  const header = d.header || {};
  const fonts = {};
  for (const key in FONT_LIMITS) {
    fonts[key] = d.fonts && Number.isFinite(d.fonts[key]) ? d.fonts[key] : FONT_LIMITS[key][2];
  }

  let blocks;
  if (Array.isArray(d.blocks)) {
    blocks = d.blocks;
  } else if (Array.isArray(d.sections)) { // 예전 "설명 섹션"은 글 블록으로 바꿔요
    blocks = d.sections.map(function (s) { return { type: 'text', heading: s.heading || '', text: s.text || '', align: 'left' }; });
  } else {
    blocks = page.bio ? [{ type: 'text', heading: '', text: page.bio, align: 'left' }] : [];
  }

  return {
    avatar: d.avatar || '',
    bg: { type: bg.type || 'color', color1: bg.color1 || '#f3f0ff', color2: bg.color2 || '#d6ccff', image: bg.image || '' },
    accent: d.accent || '#6c5ce7',
    cardStyle: pick(d.cardStyle, ['gray', 'white', 'none'], 'gray'),
    textColor: d.textColor === 'light' ? 'light' : 'dark',
    header: { layout: pick(header.layout, ['stack', 'row'], 'stack'), align: pick(header.align, ALIGNS, 'center') },
    subtitle: typeof d.subtitle === 'string' ? d.subtitle : '',
    fonts: fonts,
    linkStyle: pick(d.linkStyle, ['fill', 'card', 'outline'], 'fill'),
    linkLayout: pick(d.linkLayout, ['stack', 'row'], 'stack'),
    blocks: blocks,
    stickers: Array.isArray(d.stickers) ? d.stickers : []
  };
}

// 블록 하나를 검사하고 정리해요. 결과: { block } 또는 { error } 또는 { skip: true }(빈 블록)
function validateBlock(b, slug) {
  if (!b || !BLOCK_TYPES.includes(b.type)) return { error: '블록 종류가 올바르지 않아요.' };
  const isStr = function (v, max) { return typeof v === 'string' && v.length <= max; };
  if (!isStr(b.heading, 30)) return { error: '소제목은 30자 이하여야 해요.' };
  const heading = b.heading.trim();

  if (b.type === 'text') {
    if (!isStr(b.text, 1000)) return { error: '글 내용은 1000자 이하여야 해요.' };
    const text = b.text.trim();
    if (!heading && !text) return { skip: true };
    return { block: { type: 'text', heading: heading, text: text, align: pick(b.align, ALIGNS, 'left') } };
  }

  if (b.type === 'toggle') {
    if (!isStr(b.title, 50) || !isStr(b.text, 1000)) return { error: '토글 제목은 50자, 내용은 1000자 이하여야 해요.' };
    const text = b.text.trim();
    if (!heading && !b.title.trim() && !text) return { skip: true };
    return { block: { type: 'toggle', heading: heading, title: b.title.trim() || '더 보기', text: text, align: pick(b.align, ALIGNS, 'left'), open: b.open === true } };
  }

  if (b.type === 'gallery') {
    if (!Array.isArray(b.images) || b.images.length > 12) return { error: '갤러리 하나에는 사진을 12장까지 넣을 수 있어요.' };
    for (const src of b.images) {
      if (!isOurImageUrl(src, slug)) return { error: '갤러리 사진 주소가 올바르지 않아요.' };
    }
    if (!heading && b.images.length === 0) return { skip: true };
    return { block: { type: 'gallery', heading: heading, images: b.images.slice(), columns: pick(Number(b.columns), [1, 2, 3], 2) } };
  }

  // calendar
  if (!Array.isArray(b.events) || b.events.length > 50) return { error: '일정은 캘린더 하나에 50개까지 넣을 수 있어요.' };
  const events = [];
  for (const ev of b.events) {
    if (!ev || !isValidDate(ev.date)) return { error: '일정의 날짜가 올바르지 않아요. 날짜를 골라 주세요.' };
    if (typeof ev.text !== 'string' || ev.text.length > 100) return { error: '일정 내용은 100자 이하여야 해요.' };
    if (ev.text.trim()) events.push({ date: ev.date, text: ev.text.trim() });
  }
  return { block: { type: 'calendar', heading: heading, events: events } };
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
  if (typeof input.subtitle !== 'string' || input.subtitle.length > 60) return { error: '제목 아래 설명은 60자 이하여야 해요.' };

  const fonts = {};
  for (const key in FONT_LIMITS) {
    const v = input.fonts && input.fonts[key];
    if (!Number.isFinite(v)) return { error: '글자 크기 값이 올바르지 않아요.' };
    fonts[key] = Math.round(clamp(v, FONT_LIMITS[key][0], FONT_LIMITS[key][1]));
  }

  if (!Array.isArray(input.blocks) || input.blocks.length > MAX_BLOCKS) return { error: '블록은 최대 ' + MAX_BLOCKS + '개까지예요.' };
  const blocks = [];
  for (const b of input.blocks) {
    const r = validateBlock(b, slug);
    if (r.error) return { error: r.error };
    if (r.block) blocks.push(r.block);
  }

  if (!Array.isArray(input.stickers) || input.stickers.length > 10) return { error: '스티커는 최대 10개까지예요.' };
  const stickers = [];
  for (const s of input.stickers) {
    if (!s || !isOurImageUrl(s.src, slug)) return { error: '스티커 사진 주소가 올바르지 않아요.' };
    if (![s.x, s.y, s.w].every(Number.isFinite)) return { error: '스티커 위치 정보가 올바르지 않아요.' };
    stickers.push({ src: s.src, x: Math.round(clamp(s.x, 0, 100) * 10) / 10, y: Math.round(clamp(s.y, 0, 3000)), w: Math.round(clamp(s.w, 30, 300)) });
  }

  const header = input.header || {};
  return {
    design: {
      avatar: input.avatar || '',
      bg: { type: bg.type, color1: bg.color1, color2: bg.color2, image: bg.image || '' },
      accent: input.accent,
      cardStyle: pick(input.cardStyle, ['gray', 'white', 'none'], 'gray'),
      textColor: pick(input.textColor, ['dark', 'light'], 'dark'),
      header: { layout: pick(header.layout, ['stack', 'row'], 'stack'), align: pick(header.align, ALIGNS, 'center') },
      subtitle: input.subtitle.trim(),
      fonts: fonts,
      linkStyle: pick(input.linkStyle, ['fill', 'card', 'outline'], 'fill'),
      linkLayout: pick(input.linkLayout, ['stack', 'row'], 'stack'),
      blocks: blocks,
      stickers: stickers
    }
  };
}

// ------------------------------------------------------------
// 화면(HTML) 만들기
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
// ※ readableText / bgCss / renderPage / 캘린더 함수들은 브라우저로도 복사돼서 실행되므로,
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

// 페이지 내용(머리글, 링크 버튼, 블록들, 스티커)을 HTML로 만들어요.
function renderPage(page) {
  const d = page.design;
  const oneOf = function (v, allowed, fallback) { return allowed.indexOf(v) >= 0 ? v : fallback; };
  const al = function (v) { return oneOf(v, ['left', 'center', 'right'], 'left'); };
  // 글 안에서 **이렇게** 쓰면 굵은 글씨가 돼요. (먼저 위험한 문자를 처리한 뒤에 바꿔요)
  const fmt = function (text) { return escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'); };
  const f = d.fonts;
  const stageColor = d.textColor === 'light' ? '#ffffff' : '#222222';

  let html = '<div class="stage" style="color:' + stageColor +
    ';--fs-title:' + Number(f.title) + 'px;--fs-sub:' + Number(f.sub) + 'px;--fs-body:' + Number(f.body) +
    'px;--fs-btn:' + Number(f.btn) + 'px;--accent:' + d.accent + ';--accent-text:' + readableText(d.accent) + '">';

  // ----- 머리글: 프로필 사진, 제목, 짧은 설명 (모두 없어도 돼요) -----
  if (d.avatar || page.title || d.subtitle) {
    html += '<header class="head head-' + oneOf(d.header.layout, ['stack', 'row'], 'stack') + ' ha-' + al(d.header.align) + '">';
    if (d.avatar) html += '<img class="avatar" src="' + escapeHtml(d.avatar) + '" alt="">';
    if (page.title || d.subtitle) {
      html += '<div class="head-text">';
      if (page.title) html += '<h1>' + escapeHtml(page.title) + '</h1>';
      if (d.subtitle) html += '<p class="subtitle">' + escapeHtml(d.subtitle) + '</p>';
      html += '</div>';
    }
    html += '</header>';
  }

  // ----- 링크 버튼 -----
  if (page.links.length) {
    const ls = oneOf(d.linkStyle, ['fill', 'card', 'outline'], 'fill');
    html += '<nav class="links links-' + oneOf(d.linkLayout, ['stack', 'row'], 'stack') + '">';
    page.links.forEach(function (l) {
      let style;
      if (ls === 'fill') {            // 색을 채운 버튼
        const bg = l.color || d.accent;
        style = 'background:' + bg + ';color:' + readableText(bg);
      } else if (ls === 'card') {     // 흰 카드 버튼 (그림자)
        const bg = l.color || '#ffffff';
        style = 'background:' + bg + ';color:' + readableText(bg);
      } else {                        // 테두리만 있는 버튼
        const c = l.color || d.accent;
        style = 'background:transparent;border:2px solid ' + c + ';color:' + c;
      }
      html += '<a class="link-btn ls-' + ls + '" style="' + style + '" href="' + escapeHtml(l.url) +
        '" target="_blank" rel="noopener noreferrer">' + escapeHtml(l.title) + '</a>';
    });
    html += '</nav>';
  }

  // ----- 블록들: 작은 소제목 + 둥근 카드 -----
  const cardClass = 'card cs-' + oneOf(d.cardStyle, ['gray', 'white', 'none'], 'gray');
  d.blocks.forEach(function (b, i) {
    html += '<section class="blk">';
    if (b.heading) html += '<div class="blk-label">' + escapeHtml(b.heading) + '</div>';
    html += '<div class="' + cardClass + '">';
    if (b.type === 'text') {
      html += '<div class="sec-text al-' + al(b.align) + '">' + fmt(b.text) + '</div>';
    } else if (b.type === 'toggle') {
      html += '<details class="toggle"' + (b.open ? ' open' : '') + '><summary>' + escapeHtml(b.title) +
        '</summary><div class="sec-text al-' + al(b.align) + '">' + fmt(b.text) + '</div></details>';
    } else if (b.type === 'gallery') {
      const cols = Math.min(3, Math.max(1, Number(b.columns) || 2));
      html += '<div class="gallery" style="--cols:' + cols + '">';
      (b.images || []).forEach(function (src) {
        html += '<a href="' + escapeHtml(src) + '" target="_blank" rel="noopener noreferrer"><img src="' + escapeHtml(src) + '" alt="" loading="lazy"></a>';
      });
      html += '</div>';
    } else if (b.type === 'calendar') {
      // 달력 모양은 브라우저에서 renderCalendars() 가 그려줘요.
      html += '<div class="cal" data-id="b' + i + '" data-events="' + escapeHtml(JSON.stringify(b.events || [])) + '"></div>';
    }
    html += '</div></section>';
  });

  // ----- 스티커: 가로 위치는 %, 세로 위치는 px (맨 위에서부터) -----
  d.stickers.forEach(function (s, i) {
    html += '<img class="sticker" data-i="' + i + '" src="' + escapeHtml(s.src) + '" alt="" style="left:' +
      Number(s.x) + '%;top:' + Number(s.y) + 'px;width:' + Number(s.w) + 'px">';
  });
  html += '</div>';
  return html;
}

// ------------------------------------------------------------
// 일정 캘린더 (브라우저에서 실행돼요)
// ------------------------------------------------------------

// 한 달짜리 달력 + 그 달의 일정 목록을 HTML로 만들어요. (m: 0~11)
function calendarHtml(events, y, m, today) {
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  const monthKey = y + '-' + pad(m + 1);
  const firstDay = new Date(y, m, 1).getDay();      // 1일이 무슨 요일인지 (0=일요일)
  const lastDate = new Date(y, m + 1, 0).getDate(); // 그 달이 며칠까지 있는지
  const hasEvent = {};
  events.forEach(function (ev) { hasEvent[ev.date] = true; });

  let h = '<div class="cal-head"><button type="button" class="cal-nav" data-dir="-1">‹</button><b>' +
    y + '년 ' + (m + 1) + '월</b><button type="button" class="cal-nav" data-dir="1">›</button></div>';
  h += '<div class="cal-grid">';
  ['일', '월', '화', '수', '목', '금', '토'].forEach(function (name) { h += '<div class="cal-dow">' + name + '</div>'; });
  for (let i = 0; i < firstDay; i++) h += '<div></div>';
  for (let day = 1; day <= lastDate; day++) {
    const key = monthKey + '-' + pad(day);
    h += '<div class="cal-day' + (hasEvent[key] ? ' has' : '') + (key === today ? ' today' : '') + '">' + day + '</div>';
  }
  h += '</div>';

  const list = events.filter(function (ev) { return ev.date.slice(0, 7) === monthKey; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  if (list.length) {
    h += '<ul class="cal-list">' + list.map(function (ev) {
      return '<li><b>' + Number(ev.date.slice(8)) + '일</b>' + escapeHtml(ev.text) + '</li>';
    }).join('') + '</ul>';
  } else {
    h += '<p class="cal-empty">이 달에는 일정이 없어요.</p>';
  }
  return h;
}

// root 안의 모든 캘린더를 그려요. (보고 있는 달은 기억해 둬서, 다시 그려도 그대로 유지돼요)
function renderCalendars(root) {
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  window.__calState = window.__calState || {};
  const now = new Date();
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  root.querySelectorAll('.cal').forEach(function (el) {
    const id = el.dataset.id;
    const st = window.__calState[id] || (window.__calState[id] = { y: now.getFullYear(), m: now.getMonth() });
    let events = [];
    try { events = JSON.parse(el.dataset.events); } catch (e) { events = []; }
    el.innerHTML = calendarHtml(events, st.y, st.m, today);
  });
}

// ‹ › 버튼을 누르면 이전/다음 달로 이동해요.
function handleCalendarClick(e) {
  const btn = e.target.closest('.cal-nav');
  if (!btn) return;
  const el = btn.closest('.cal');
  const st = window.__calState[el.dataset.id];
  st.m += Number(btn.dataset.dir);
  if (st.m < 0) { st.m = 11; st.y -= 1; }
  if (st.m > 11) { st.m = 0; st.y += 1; }
  renderCalendars(el.parentNode);
}

// 페이지 꾸밈에 쓰는 CSS (공개 페이지와 미리보기 공통)
const PAGE_CSS = `
.stage { position: relative; max-width: 440px; margin: 0 auto; padding: 28px 16px 90px; min-height: 100vh; box-sizing: border-box; font-family: sans-serif; }
.head { margin-bottom: 18px; }
.head h1 { margin: 0; font-size: var(--fs-title); line-height: 1.25; word-break: break-word; }
.subtitle { margin: 2px 0 0; font-size: var(--fs-sub); opacity: 0.65; word-break: break-word; }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; display: block; flex: none; box-shadow: 0 0 0 4px rgba(255,255,255,0.7), 0 2px 10px rgba(0,0,0,0.15); }
.head-stack .avatar { margin: 0 auto 12px; }
.ha-left { text-align: left; } .ha-center { text-align: center; } .ha-right { text-align: right; }
.head-stack.ha-left .avatar { margin: 0 0 12px; }
.head-stack.ha-right .avatar { margin: 0 0 12px auto; }
.head-row { display: flex; align-items: center; gap: 16px; text-align: left; }
.head-row .avatar { width: 84px; height: 84px; }
.links { display: flex; gap: 10px; margin: 0 0 18px; }
.links-stack { flex-direction: column; }
.links-row { flex-direction: row; overflow-x: auto; padding: 4px 2px 10px; }
.link-btn { display: block; box-sizing: border-box; text-decoration: none; text-align: center; padding: 14px; font-weight: bold; font-size: var(--fs-btn); border-radius: 12px; }
.links-row .link-btn { flex: 1 0 auto; min-width: 110px; white-space: nowrap; }
.ls-card { border-radius: 22px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
.link-btn:hover { filter: brightness(0.94); }
.blk { margin: 0 0 18px; }
.blk-label { font-size: var(--fs-sub); opacity: 0.6; margin: 0 0 6px 6px; font-weight: 600; word-break: break-word; }
.card { border-radius: 22px; padding: 20px; color: #222; font-size: var(--fs-body); }
.cs-gray { background: #f7f8fa; }
.cs-white { background: #ffffff; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
.cs-none { background: none; padding: 4px 0; color: inherit; }
.sec-text { white-space: pre-wrap; line-height: 1.55; word-break: break-word; font-size: var(--fs-body); }
.al-left { text-align: left; } .al-center { text-align: center; } .al-right { text-align: right; }
details.toggle summary { cursor: pointer; font-weight: bold; font-size: var(--fs-body); }
details.toggle .sec-text { margin-top: 10px; }
.gallery { display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: 6px; }
.gallery img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 12px; display: block; }
.cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: var(--fs-body); }
.cal-nav { border: none; background: rgba(0,0,0,0.07); color: inherit; border-radius: 50%; width: 32px; height: 32px; font-size: 18px; line-height: 1; cursor: pointer; padding: 0; margin: 0; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
.cal-dow { font-size: 12px; opacity: 0.55; padding: 4px 0; }
.cal-day { padding: 8px 0; border-radius: 10px; font-size: 14px; }
.cal-day.today { outline: 2px solid var(--accent); outline-offset: -2px; }
.cal-day.has { background: var(--accent); color: var(--accent-text); font-weight: bold; }
.cal-list { list-style: none; margin: 12px 0 0; padding: 0; font-size: var(--fs-body); line-height: 1.5; }
.cal-list li { padding: 5px 0; border-top: 1px solid rgba(0,0,0,0.08); word-break: break-word; }
.cal-list b { margin-right: 8px; }
.cal-empty { margin: 12px 0 0; opacity: 0.5; font-size: 13px; text-align: center; }
.sticker { position: absolute; transform: translateX(-50%); pointer-events: none; user-select: none; }
`;

// 방문자가 보는 공개 페이지
function publicPage(page) {
  const design = normalizeDesign(page);
  const view = { title: page.title, links: page.links || [], design: design };
  const hasCalendar = design.blocks.some(function (b) { return b.type === 'calendar'; });
  // 캘린더가 있을 때만 작은 스크립트를 넣어요.
  const script = hasCalendar
    ? '<script>' + [escapeHtml, calendarHtml, renderCalendars, handleCalendarClick].map(String).join('\n') +
      "\nrenderCalendars(document);document.addEventListener('click',handleCalendarClick);</script>"
    : '';
  return '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(page.title || page.slug) + '</title>' +
    '<style>body{margin:0;overflow-x:hidden;min-height:100vh;' + bgCss(design) + '}' + PAGE_CSS + '</style>' +
    '</head><body>' + renderPage(view) + script + '</body></html>';
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
  const shared = [escapeHtml, readableText, bgCss, renderPage, calendarHtml, renderCalendars, handleCalendarClick].map(String).join('\n\n');

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
  .preview { min-height: 620px; max-height: calc(100vh - 80px); overflow-y: auto; border: 1px solid #ccc; }
  .preview .stage { min-height: 620px; }
  .preview .sticker { pointer-events: auto; cursor: grab; touch-action: none; }
  .box { background: white; border-radius: 16px; padding: 16px; margin-bottom: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
  .box h2 { margin: 0 0 10px; font-size: 17px; }
  label { display: block; font-size: 14px; color: #555; margin-top: 8px; }
  input[type=text], textarea, select { width: 100%; box-sizing: border-box; padding: 10px; margin: 4px 0; border: 1px solid #ccc; border-radius: 8px; font-size: 15px; font-family: inherit; }
  input[type=color] { width: 56px; height: 36px; border: 1px solid #ccc; border-radius: 8px; padding: 2px; background: white; }
  input[type=date] { padding: 8px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
  button { background: #6c5ce7; color: white; border: none; padding: 10px 14px; border-radius: 10px; font-size: 14px; cursor: pointer; margin: 4px 4px 4px 0; }
  button.gray { background: #b2bec3; }
  button.red { background: #d63031; }
  .item { background: #f8f8f8; border-radius: 10px; padding: 10px; margin: 8px 0; }
  .item .tag { display: inline-block; background: #6c5ce7; color: white; font-size: 12px; padding: 2px 8px; border-radius: 20px; margin-bottom: 4px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .row input[type=text] { flex: 1; min-width: 120px; width: auto; }
  .thumb { width: 56px; height: 56px; border-radius: 10px; object-fit: contain; background: #ddd; }
  .gthumb { position: relative; display: inline-block; margin: 4px 6px 4px 0; }
  .gthumb img { width: 64px; height: 64px; object-fit: cover; border-radius: 10px; display: block; }
  .gthumb button { position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; padding: 0; margin: 0; border-radius: 50%; background: #d63031; font-size: 12px; line-height: 22px; }
  .swatch { width: 40px; height: 40px; border-radius: 10px; border: 2px solid white; box-shadow: 0 0 0 1px #bbb; padding: 0; margin: 4px 6px 4px 0; }
  .sizeRow { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 14px; color: #555; }
  .sizeRow span.name { width: 120px; }
  .sizeRow input[type=range] { flex: 1; }
  .sizeRow span.val { width: 40px; text-align: right; }
  .hint, .small { color: #777; font-size: 13px; }
  .savebar { position: fixed; left: 0; right: 0; bottom: 0; background: white; border-top: 1px solid #ddd; padding: 10px 16px; text-align: center; z-index: 10; }
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
      <label>제목 (선택)</label>
      <input type="text" id="title" maxlength="50" placeholder="비워 두면 제목이 표시되지 않아요">
      <label>제목 아래 짧은 설명 (선택)</label>
      <input type="text" id="subtitle" maxlength="60" placeholder="예: @내계정  (비워 두면 표시되지 않아요)">
      <label>프로필 사진</label>
      <div class="row">
        <img id="avatarThumb" class="thumb" alt="">
        <input type="file" id="avatarFile" accept="image/png,image/jpeg,image/webp">
        <button class="gray" id="avatarDel">사진 지우기</button>
      </div>
      <label>머리글 배치</label>
      <select id="headLayout">
        <option value="stack">사진 위, 글 아래</option>
        <option value="row">사진 왼쪽, 글 오른쪽</option>
      </select>
      <div id="headAlignRow">
        <label>제목/설명 정렬</label>
        <select id="headAlign"><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select>
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
      <label>카드 모양 (글, 토글, 갤러리, 캘린더를 담는 둥근 상자)</label>
      <select id="cardStyle">
        <option value="gray">연한 회색 카드</option>
        <option value="white">흰색 카드 (그림자)</option>
        <option value="none">카드 없음</option>
      </select>
      <label>카드 밖 글자색 (제목, 소제목 등)</label>
      <select id="textColor"><option value="dark">검정</option><option value="light">흰색</option></select>
      <label>링크 버튼 기본 색 <input type="color" id="accent"></label>
    </div>

    <div class="box">
      <h2>글자 크기</h2>
      <div id="sizes"></div>
    </div>

    <div class="box">
      <h2>링크 버튼</h2>
      <label>버튼 모양</label>
      <select id="linkStyle">
        <option value="fill">색을 채운 버튼</option>
        <option value="card">흰 카드 버튼 (그림자)</option>
        <option value="outline">테두리만 있는 버튼</option>
      </select>
      <label>버튼 배열</label>
      <select id="linkLayout">
        <option value="stack">세로로 쌓기</option>
        <option value="row">가로로 나란히 (넘치면 옆으로 스크롤)</option>
      </select>
      <p class="hint">버튼마다 다른 색을 쓰려면 각 버튼의 "이 버튼만 다른 색"을 켜세요.</p>
      <div id="links"></div>
      <button class="gray" id="addLink">+ 링크 추가</button>
    </div>

    <div class="box">
      <h2>내용 블록</h2>
      <p class="hint">블록을 추가해서 페이지를 채워요. ↑↓로 순서를 바꿀 수 있어요. (최대 12개)<br>
      글 안에서 <b>**이렇게**</b> 쓰면 굵은 글씨가 돼요.</p>
      <div id="blocks"></div>
      <button class="gray" data-add="text">+ 글</button>
      <button class="gray" data-add="toggle">+ 토글</button>
      <button class="gray" data-add="gallery">+ 사진 갤러리</button>
      <button class="gray" data-add="calendar">+ 일정 캘린더</button>
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
const FONT_LIMITS = ${JSON.stringify(FONT_LIMITS)};
let dirty = false;            // 저장하지 않은 변경이 있는지

// ----- 공개 페이지를 그리는 함수들 (서버 코드에서 복사됨) -----
${shared}

function $(id) { return document.getElementById(id); }
const preview = $('preview');

function setMsg(text) { $('msg').textContent = text; }

// 미리보기를 다시 그려요.
function refresh() {
  preview.style.cssText = bgCss(design) + 'border-radius:16px;';
  preview.innerHTML = renderPage(data);
  renderCalendars(preview);
}

// 무언가 바뀌었을 때 부르는 함수
function changed() { dirty = true; refresh(); }
window.onbeforeunload = function () { return dirty ? '저장하지 않은 변경이 있어요.' : undefined; };

// 미리보기 안의 링크는 눌러도 이동하지 않게 하고, 캘린더의 ‹ › 버튼은 동작하게 해요.
preview.addEventListener('click', function (e) {
  if (e.target.closest('a')) e.preventDefault();
  handleCalendarClick(e);
});

// ----- 작은 도우미들: 화면 부품을 만들어요 -----
function button(text, cls, onclick) {
  const b = document.createElement('button');
  b.textContent = text; b.className = cls; b.onclick = onclick;
  return b;
}
function textInput(value, placeholder, max, oninput) {
  const t = document.createElement('input');
  t.type = 'text'; t.value = value; t.placeholder = placeholder; t.maxLength = max;
  t.oninput = function () { oninput(t.value); };
  return t;
}
function textArea(value, placeholder, max, oninput) {
  const t = document.createElement('textarea');
  t.rows = 4; t.value = value; t.placeholder = placeholder; t.maxLength = max;
  t.oninput = function () { oninput(t.value); };
  return t;
}
function selectBox(options, value, onchange) {
  const s = document.createElement('select');
  options.forEach(function (o) {
    const opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; s.appendChild(opt);
  });
  s.value = String(value);
  s.onchange = function () { onchange(s.value); };
  return s;
}
function labelOf(text, el) {
  const l = document.createElement('label');
  l.append(text, el);
  return l;
}
function move(list, i, dir, redraw) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const temp = list[i]; list[i] = list[j]; list[j] = temp;
  redraw(); changed();
}
const ALIGN_OPTIONS = [['left', '왼쪽 정렬'], ['center', '가운데 정렬'], ['right', '오른쪽 정렬']];

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
$('subtitle').value = design.subtitle;
$('subtitle').oninput = function () { design.subtitle = $('subtitle').value; changed(); };

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

$('headLayout').value = design.header.layout;
$('headAlign').value = design.header.align;
function syncHead() { $('headAlignRow').style.display = design.header.layout === 'stack' ? 'block' : 'none'; }
$('headLayout').onchange = function () { design.header.layout = $('headLayout').value; syncHead(); changed(); };
$('headAlign').onchange = function () { design.header.align = $('headAlign').value; changed(); };

// ----- 배경과 색 -----
const PRESETS = [['#f3f0ff', '#f3f0ff'], ['#ffeaa7', '#fab1a0'], ['#a29bfe', '#74b9ff'], ['#55efc4', '#81ecec'], ['#fd79a8', '#fdcb6e'], ['#2d3436', '#636e72']];

function syncBgControls() {
  $('bgType').value = design.bg.type;
  $('bgColor1').value = design.bg.color1;
  $('bgColor2').value = design.bg.color2;
  $('rowColors').style.display = design.bg.type === 'image' ? 'none' : 'flex';
  $('color2Label').style.display = design.bg.type === 'gradient' ? 'block' : 'none';
  $('rowImage').style.display = design.bg.type === 'image' ? 'block' : 'none';
  $('cardStyle').value = design.cardStyle;
  $('textColor').value = design.textColor;
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
$('cardStyle').onchange = function () { design.cardStyle = $('cardStyle').value; changed(); };
$('textColor').onchange = function () { design.textColor = $('textColor').value; changed(); };
$('accent').oninput = function () { design.accent = $('accent').value; drawLinks(); changed(); };

// ----- 글자 크기 슬라이더 -----
[['title', '제목'], ['sub', '제목 아래 설명 / 소제목'], ['body', '카드 안 글'], ['btn', '링크 버튼 글']].forEach(function (k) {
  const key = k[0];
  const row = document.createElement('div'); row.className = 'sizeRow';
  const name = document.createElement('span'); name.className = 'name'; name.textContent = k[1];
  const range = document.createElement('input'); range.type = 'range'; range.id = 'size_' + key;
  range.min = FONT_LIMITS[key][0]; range.max = FONT_LIMITS[key][1]; range.value = design.fonts[key];
  const val = document.createElement('span'); val.className = 'val'; val.textContent = design.fonts[key] + 'px';
  range.oninput = function () { design.fonts[key] = Number(range.value); val.textContent = range.value + 'px'; changed(); };
  row.append(name, range, val);
  $('sizes').appendChild(row);
});

// ----- 링크 -----
$('linkStyle').value = design.linkStyle;
$('linkLayout').value = design.linkLayout;
$('linkStyle').onchange = function () { design.linkStyle = $('linkStyle').value; changed(); };
$('linkLayout').onchange = function () { design.linkLayout = $('linkLayout').value; changed(); };

function drawLinks() {
  const box = $('links'); box.innerHTML = '';
  data.links.forEach(function (l, i) {
    const item = document.createElement('div'); item.className = 'item';
    const t = textInput(l.title, '버튼 이름 (예: 인스타그램)', 50, function (v) { l.title = v; changed(); });
    const u = textInput(l.url, '주소 (https:// 로 시작)', 500, function (v) { l.url = v; changed(); });
    // 이 버튼만의 색 (체크하면 직접 고르고, 끄면 기본 색을 써요)
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
  data.links.push({ title: '', url: '', color: '' }); drawLinks(); changed();
};

// ----- 내용 블록 (글 / 토글 / 사진 갤러리 / 일정 캘린더) -----
const BLOCK_NAMES = { text: '글', toggle: '토글', gallery: '사진 갤러리', calendar: '일정 캘린더' };

function todayString() {
  const d = new Date(); const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// 일정 날짜를 고치면 미리보기 달력이 그 달로 이동해요.
function jumpToMonth(index, dateString) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(dateString)) return;
  window.__calState = window.__calState || {};
  window.__calState['b' + index] = { y: Number(dateString.slice(0, 4)), m: Number(dateString.slice(5, 7)) - 1 };
}

function drawEvents(b, index, box) {
  box.innerHTML = '';
  b.events.forEach(function (ev, k) {
    const row = document.createElement('div'); row.className = 'row';
    const date = document.createElement('input'); date.type = 'date'; date.value = ev.date;
    date.oninput = function () { ev.date = date.value; jumpToMonth(index, ev.date); changed(); };
    const text = textInput(ev.text, '일정 내용', 100, function (v) { ev.text = v; changed(); });
    row.append(date, text, button('삭제', 'red', function () { b.events.splice(k, 1); drawEvents(b, index, box); changed(); }));
    box.appendChild(row);
  });
}

function drawGalleryThumbs(b, box) {
  box.innerHTML = '';
  b.images.forEach(function (src, k) {
    const wrap = document.createElement('span'); wrap.className = 'gthumb';
    const img = document.createElement('img'); img.src = src;
    wrap.append(img, button('✕', '', function () { b.images.splice(k, 1); drawGalleryThumbs(b, box); changed(); }));
    box.appendChild(wrap);
  });
}

function drawBlocks() {
  const box = $('blocks'); box.innerHTML = '';
  design.blocks.forEach(function (b, i) {
    const item = document.createElement('div'); item.className = 'item';
    const tag = document.createElement('div'); tag.className = 'tag'; tag.textContent = BLOCK_NAMES[b.type];
    item.append(tag, textInput(b.heading, '소제목 (카드 위에 작게 표시돼요, 비워도 돼요)', 30, function (v) { b.heading = v; changed(); }));

    if (b.type === 'text') {
      item.append(textArea(b.text, '내용을 적어 주세요', 1000, function (v) { b.text = v; changed(); }),
        selectBox(ALIGN_OPTIONS, b.align, function (v) { b.align = v; changed(); }));
    }
    if (b.type === 'toggle') {
      const open = document.createElement('input'); open.type = 'checkbox'; open.checked = !!b.open;
      open.onchange = function () { b.open = open.checked; changed(); };
      item.append(textInput(b.title, '토글 제목 (눌러서 펼치는 줄)', 50, function (v) { b.title = v; changed(); }),
        textArea(b.text, '펼쳤을 때 보일 내용', 1000, function (v) { b.text = v; changed(); }),
        selectBox(ALIGN_OPTIONS, b.align, function (v) { b.align = v; changed(); }),
        labelOf('', open));
      item.lastChild.append(' 처음부터 펼쳐 두기');
    }
    if (b.type === 'gallery') {
      const thumbs = document.createElement('div');
      drawGalleryThumbs(b, thumbs);
      const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.accept = 'image/png,image/jpeg,image/webp';
      file.onchange = async function () {
        const files = Array.from(file.files); file.value = '';
        for (const f of files) {
          if (b.images.length >= 12) { setMsg('갤러리 하나에는 사진을 12장까지 넣을 수 있어요.'); break; }
          const url = await uploadImage(f, 900, 'image/jpeg');
          if (!url) break;
          b.images.push(url); drawGalleryThumbs(b, thumbs); changed();
        }
      };
      item.append(thumbs, file,
        selectBox([['1', '한 줄에 1장'], ['2', '한 줄에 2장'], ['3', '한 줄에 3장']], b.columns, function (v) { b.columns = Number(v); changed(); }));
    }
    if (b.type === 'calendar') {
      const events = document.createElement('div');
      drawEvents(b, i, events);
      item.append(events, button('+ 일정 추가', 'gray', function () {
        if (b.events.length >= 50) { setMsg('일정은 캘린더 하나에 50개까지예요.'); return; }
        b.events.push({ date: todayString(), text: '' });
        jumpToMonth(i, todayString());
        drawEvents(b, i, events); changed();
      }));
    }

    item.append(document.createElement('br'),
      button('↑', 'gray', function () { move(design.blocks, i, -1, drawBlocks); }),
      button('↓', 'gray', function () { move(design.blocks, i, 1, drawBlocks); }),
      button('블록 삭제', 'red', function () { design.blocks.splice(i, 1); drawBlocks(); changed(); }));
    box.appendChild(item);
  });
}

document.querySelectorAll('[data-add]').forEach(function (btn) {
  btn.onclick = function () {
    if (design.blocks.length >= 12) { setMsg('블록은 최대 12개까지예요.'); return; }
    const type = btn.dataset.add;
    const b = { type: type, heading: '' };
    if (type === 'text') { b.text = ''; b.align = 'left'; }
    if (type === 'toggle') { b.title = ''; b.text = ''; b.align = 'left'; b.open = false; }
    if (type === 'gallery') { b.images = []; b.columns = 2; }
    if (type === 'calendar') { b.events = []; }
    design.blocks.push(b); drawBlocks(); changed();
  };
});

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
    preview.scrollTop = 0;   // 새 스티커가 보이도록 미리보기를 맨 위로
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
  // 날짜도 내용도 비어 있는 일정 줄은 정리해요.
  let cleaned = false;
  design.blocks.forEach(function (b) {
    if (b.type === 'calendar') {
      const before = b.events.length;
      b.events = b.events.filter(function (ev) { return ev.date || ev.text; });
      if (b.events.length !== before) cleaned = true;
    }
  });
  if (cleaned) drawBlocks();

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
showAvatar(); syncHead(); syncBgControls(); drawLinks(); drawBlocks(); drawStickers(); refresh();
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
      if (isLimited(slugKey, MAX_UPLOADS_PER_PAGE_PER_DAY) || isLimited(ipKey, 150)) {
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
        title: body.title.trim(), // 제목은 비워도 돼요
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
