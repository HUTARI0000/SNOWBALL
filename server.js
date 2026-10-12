// ============================================================
// 나만의 링크 모음 사이트 - 배포용 버전 (Supabase 데이터베이스 사용)
//
// 연습용 버전과 달라진 점
//  1) 데이터를 data.json 파일 대신 Supabase(인터넷 데이터베이스)에 저장해요.
//     → 서버가 재시작돼도 데이터가 사라지지 않아요.
//  2) 수정 주소가 https:// 로 정확하게 만들어져요.
//  3) 같은 사람이 하루에 페이지를 5개까지만 만들 수 있어요. (스팸 방지)
//
// 비밀 정보(Supabase 주소와 키)는 코드에 직접 적지 않고
// "환경변수"라는 안전한 설정 칸에 넣어요. (README 참고)
// ============================================================

const http = require('http');
const crypto = require('crypto');

// ----- 설정 -----
const PORT = process.env.PORT || 3000;                                    // 서버 번호 (호스팅 서비스가 알아서 정해줘요)
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''); // Supabase 주소
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';                       // Supabase 비밀 키 (절대 공개 금지!)
const MAX_CREATES_PER_DAY = 5;                                             // 하루에 만들 수 있는 페이지 수 (한 사람당)
const RESERVED = ['edit', 'api', 'create', 'admin', 'static', 'favicon.ico']; // 주소로 쓸 수 없는 단어

// 환경변수를 빼먹었으면 바로 알려주고 멈춰요.
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL 과 SUPABASE_KEY 환경변수를 설정해 주세요. (README.md 참고)');
  process.exit(1);
}

// ------------------------------------------------------------
// Supabase(데이터베이스)와 대화하는 함수들
// 데이터베이스에는 "pages" 라는 표(테이블)가 있고, 한 줄이 페이지 하나예요.
// 열: slug(주소), token_hash(수정 비밀번호의 해시), title, bio, links, created_at
// ------------------------------------------------------------

// Supabase에 요청을 보내는 공통 함수
async function supabase(path, options) {
  options = options || {};
  const headers = Object.assign({ apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, options.headers);
  // 예전 방식의 키(eyJ로 시작)는 Authorization 헤더도 필요해요.
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SUPABASE_KEY;
  return fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, options, { headers: headers }));
}

// 주소(slug)로 페이지 찾기. 없으면 null.
async function getPageBySlug(slug) {
  const res = await supabase('pages?slug=eq.' + encodeURIComponent(slug) + '&select=slug,title,bio,links');
  if (!res.ok) throw new Error('DB 읽기 실패: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

// 수정 토큰으로 페이지 찾기. (토큰을 해시로 바꿔서 DB의 값과 비교해요.) 없으면 null.
async function getPageByToken(token) {
  const res = await supabase('pages?token_hash=eq.' + hash(token) + '&select=slug,title,bio,links');
  if (!res.ok) throw new Error('DB 읽기 실패: ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

// 새 페이지 저장. 결과 상태 숫자를 돌려줘요. (409 = 이미 있는 주소)
async function createPage(row) {
  const res = await supabase('pages', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row)
  });
  return res.status;
}

// 기존 페이지 내용 수정
async function updatePage(slug, changes) {
  const res = await supabase('pages?slug=eq.' + encodeURIComponent(slug), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(changes)
  });
  if (!res.ok) throw new Error('DB 저장 실패: ' + res.status);
}

// ------------------------------------------------------------
// 스팸 방지: 같은 IP에서 하루에 만든 횟수를 기억해 둬요.
// (서버 메모리에 저장하므로 서버가 재시작되면 초기화돼요. 기본 보호용이에요.)
// ------------------------------------------------------------
const createLog = {}; // { "IP주소": [만든 시각, 만든 시각, ...] }
const DAY = 24 * 60 * 60 * 1000;

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for']; // 호스팅 서비스 뒤에서는 이 헤더에 진짜 IP가 들어와요
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

function isLimited(ip) {
  const now = Date.now();
  const recent = (createLog[ip] || []).filter(function (t) { return now - t < DAY; });
  createLog[ip] = recent;
  return recent.length >= MAX_CREATES_PER_DAY;
}

function recordCreate(ip) {
  createLog[ip].push(Date.now());
}

// ------------------------------------------------------------
// 도우미 함수들
// ------------------------------------------------------------

// 해시: 글자를 되돌릴 수 없는 이상한 문자열로 바꿔요.
function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 위험한 문자(<script> 등)를 무해한 글자로 바꿔요.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// http:// 또는 https:// 로 시작하는 주소만 허용해요.
function isSafeUrl(url) {
  return /^https?:\/\//i.test(url);
}

// 수정 토큰은 우리가 만든 모양(48글자 영문/숫자)이어야만 통과시켜요.
function isValidToken(token) {
  return /^[a-f0-9]{48}$/.test(token);
}

// 우리 사이트의 진짜 주소 알아내기 (https 문제 해결 부분)
function getOrigin(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, ''); // 직접 지정했으면 그걸 사용
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim(); // 호스팅 서비스가 https라고 알려줘요
  return proto + '://' + req.headers.host;
}

// 브라우저가 보낸 데이터를 받아오는 함수
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (chunk) {
      data += chunk;
      if (data.length > 100000) {
        reject(new Error('요청이 너무 커요'));
        req.destroy();
      }
    });
    req.on('end', function () { resolve(data); });
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

// 방문자가 보는 공개 페이지
function publicPage(page) {
  const buttons = page.links.map(function (l) {
    return `<a class="link-btn" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.title)}</a>`;
  }).join('');
  return layout(page.title, `
    <h1>${escapeHtml(page.title)}</h1>
    <p class="bio">${escapeHtml(page.bio)}</p>
    ${buttons || '<p class="small" style="text-align:center">아직 링크가 없어요.</p>'}
  `);
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

// 수정 화면
function editPage(token, page) {
  // 서버 데이터를 화면의 자바스크립트로 안전하게 넘겨주는 부분
  const initial = JSON.stringify({ title: page.title, bio: page.bio, links: page.links })
    .replace(/</g, '\\u003c');

  return layout('페이지 수정', `
    <h1>✏️ 페이지 수정</h1>
    <label>제목</label>
    <input id="title" maxlength="50">
    <label>소개글</label>
    <textarea id="bio" rows="3" maxlength="200"></textarea>
    <h3>링크 목록</h3>
    <div id="links"></div>
    <button class="gray" onclick="addLink()">+ 링크 추가</button>
    <hr>
    <button onclick="save()">저장하기</button>
    <p id="msg" class="small"></p>

    <script>
      // ----- 이 아래는 브라우저 안에서 움직이는 코드예요 -----
      const token = ${JSON.stringify(token)};
      const data = ${initial};   // 지금 저장되어 있는 내용

      // 화면에 제목, 소개글 채우기
      document.getElementById('title').value = data.title;
      document.getElementById('bio').value = data.bio;

      // 링크 목록을 화면에 그리는 함수
      function render() {
        const box = document.getElementById('links');
        box.innerHTML = '';
        data.links.forEach(function (link, i) {
          const row = document.createElement('div');
          row.className = 'link-row';

          const t = document.createElement('input');
          t.placeholder = '버튼 이름 (예: 인스타그램)';
          t.value = link.title;
          t.oninput = function () { link.title = t.value; };

          const u = document.createElement('input');
          u.placeholder = '주소 (https:// 로 시작)';
          u.value = link.url;
          u.oninput = function () { link.url = u.value; };

          const up = document.createElement('button');
          up.className = 'gray'; up.textContent = '↑';
          up.onclick = function () { move(i, -1); };

          const down = document.createElement('button');
          down.className = 'gray'; down.textContent = '↓';
          down.onclick = function () { move(i, 1); };

          const del = document.createElement('button');
          del.className = 'red'; del.textContent = '삭제';
          del.onclick = function () { data.links.splice(i, 1); render(); };

          row.append(t, u, up, down, del);
          box.appendChild(row);
        });
      }

      function addLink() { data.links.push({ title: '', url: '' }); render(); }

      function move(i, dir) {  // 순서 바꾸기
        const j = i + dir;
        if (j < 0 || j >= data.links.length) return;
        const temp = data.links[i];
        data.links[i] = data.links[j];
        data.links[j] = temp;
        render();
      }

      // 서버에 저장 요청 보내기
      async function save() {
        data.title = document.getElementById('title').value;
        data.bio = document.getElementById('bio').value;
        const msg = document.getElementById('msg');
        msg.textContent = '저장 중...';
        const res = await fetch('/api/save/' + token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        msg.textContent = result.ok ? '✅ 저장됐어요!' : '❌ ' + result.error;
      }

      render();
    </script>
  `);
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
      if (isLimited(ip)) {
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
      if (status === 409) { // 409 = 같은 주소가 이미 있다는 뜻
        return sendHtml(res, 400, homePage('이미 사용 중이거나 쓸 수 없는 주소예요.'));
      }
      if (status >= 300) throw new Error('페이지 만들기 실패: ' + status);

      recordCreate(ip);
      const origin = getOrigin(req);
      return sendHtml(res, 200, createdPage(slug, origin + '/edit/' + token, origin + '/' + slug));
    }

    // (다) 수정 화면 보기:  GET /edit/토큰
    if (req.method === 'GET' && parts[0] === 'edit' && parts.length === 2) {
      const page = isValidToken(parts[1]) ? await getPageByToken(parts[1]) : null;
      if (!page) return sendHtml(res, 404, layout('없음', '<h1>잘못된 수정 주소예요.</h1>'));
      return sendHtml(res, 200, editPage(parts[1], page));
    }

    // (라) 저장하기:  POST /api/save/토큰
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
      if (typeof body.bio !== 'string' || body.bio.length > 200) {
        return sendJson(res, 400, { ok: false, error: '소개글은 200자 이하여야 해요.' });
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
        cleanLinks.push({ title: l.title.trim() || l.url.trim(), url: l.url.trim() });
      }

      await updatePage(page.slug, {
        title: body.title.trim() || page.slug,
        bio: body.bio.trim(),
        links: cleanLinks
      });
      return sendJson(res, 200, { ok: true });
    }

    // (마) 공개 페이지 보기:  GET /주소
    if (req.method === 'GET' && parts.length === 1 && /^[a-z0-9_-]{3,20}$/.test(parts[0])) {
      const page = await getPageBySlug(parts[0]);
      if (page) return sendHtml(res, 200, publicPage(page));
    }

    // 위 어디에도 해당하지 않으면 "없는 페이지"
    return sendHtml(res, 404, layout('없음', '<h1>페이지를 찾을 수 없어요.</h1><p class="bio"><a href="/">처음으로</a></p>'));

  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

server.listen(PORT, function () {
  console.log('서버가 켜졌어요! 포트 번호: ' + PORT);
});
