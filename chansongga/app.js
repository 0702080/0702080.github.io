/* 내 찬송가 — 개인용 악보/가사 뷰어 (vanilla JS, 빌드 도구 없음) */
'use strict';

// 폰이 옛 캐시를 물고 있는지 설정 화면에서 바로 확인할 수 있도록 남긴다.
const APP_VERSION = '2026-09-21 full2';
const DATA_URL = 'data/hymns.json';
const SAMPLE_URL = 'data/hymns.sample.json';
const LS = 'hymnapp.v1';

const state = {
  meta: {},
  hymns: [],
  byNo: new Map(),
  fav: new Set(),
  settings: {
    theme: 'auto', font: 115, zoom: 80,
    wake: false, scoreFirst: true, invert: false, transpose: {}
  },
  view: 'pad',
  lib: new Map(),        // 번호 -> { title, blob }  이 기기에 저장된 악보
  objUrl: null,          // 지금 화면에 쓰는 Blob URL (다음 곡에서 해제한다)
  current: null,
  padBuf: '',
  osmd: null,
  wakeLock: null
};

/* ── 내 악보 보관함 (IndexedDB) ─────────────
   악보 이미지는 이 기기의 브라우저 저장소에만 들어간다.
   서버로 올라가지 않으므로 앱 코드는 공개 호스팅에 두어도 된다. */
const DB_NAME = 'hymnLibrary';
const DB_VER = 1;
const STORE = 'scores';
// 001장_제목.jpg / 12장 제목.png / 037.jpg
const FILE_RE = /^(\d{1,4})\s*(?:장)?[_\-. ]*(.*)$/;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'no' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function done(tr) {
  return new Promise((res, rej) => {
    tr.oncomplete = res;
    tr.onerror = () => rej(tr.error);
    tr.onabort = () => rej(tr.error);
  });
}

async function libPut(records) {
  const db = await openDB();
  const os = store(db, 'readwrite');
  records.forEach(r => os.put(r));
  await done(os.transaction);
  db.close();
}

async function libAll() {
  if (!window.indexedDB) return [];
  try {
    const db = await openDB();
    const os = store(db, 'readonly');
    const rows = await new Promise((res, rej) => {
      const r = os.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return rows;
  } catch (e) {
    return [];        // 사생활 보호 모드 등에서 막힐 수 있다
  }
}

async function libClearAll() {
  const db = await openDB();
  const os = store(db, 'readwrite');
  os.clear();
  await done(os.transaction);
  db.close();
}

/* ── ZIP 풀기 ───────────────────────────
   카톡·드라이브로 사진을 옮기면 파일 이름이 바뀌어 번호를 잃는다.
   ZIP 안에서는 원래 이름이 보존되므로 압축 파일째 받아서 직접 푼다.
   (라이브러리 없이 브라우저 기본 기능만 사용) */
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
};

function mimeOf(name) {
  return MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}

async function readZip(file) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일이 아닙니다');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8')
      .decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;

    if (name.endsWith('/')) continue;
    const base = name.split('/').pop();
    if (!base || base.startsWith('.')) continue;
    if (!MIME[(base.split('.').pop() || '').toLowerCase()]) continue;

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.slice(start, start + compSize);

    let bytes;
    if (method === 0) {
      bytes = raw;
    } else if (method === 8 && typeof DecompressionStream === 'function') {
      const stream = new Blob([raw]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue;                      // 지원하지 않는 압축 방식
    }
    out.push(new File([bytes], base, { type: mimeOf(base) }));
  }
  return out;
}

function parseFileName(name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const m = FILE_RE.exec(stem);
  if (!m) return null;
  return { no: Number(m[1]), title: m[2].replace(/[_\s]+/g, ' ').trim() };
}

/* ── 한글 초성 ─────────────────────────── */
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ',
             'ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const CHO_SET = new Set(CHO);

function toCho(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) out += CHO[Math.floor(c / 588)];
    else if (ch !== ' ') out += ch;
  }
  return out;
}
const isChoQuery = q => q.length > 0 && [...q].every(c => CHO_SET.has(c));
const norm = s => (s || '').toLowerCase().replace(/[\s,.!?~·'"()]/g, '');

/* ── 저장소 ───────────────────────────── */
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || '{}');
    if (Array.isArray(raw.fav)) state.fav = new Set(raw.fav);
    if (raw.settings) Object.assign(state.settings, raw.settings);
  } catch (e) { /* 저장소를 못 읽어도 기본값으로 동작한다 */ }
}
function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      fav: [...state.fav], settings: state.settings
    }));
  } catch (e) { /* 사생활 보호 모드 등 — 무시 */ }
}

/* ── DOM 도우미 ───────────────────────── */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── 라우팅 ───────────────────────────── */
const VIEWS = ['home', 'list', 'search', 'fav', 'settings', 'detail'];
const TITLES = { home: '내 찬송가', list: '전체 목록', search: '검색',
                 fav: '즐겨찾기', settings: '설정' };

function show(view, opts = {}) {
  state.view = view;
  VIEWS.forEach(v => { const el = $('view-' + v); if (el) el.hidden = v !== view; });

  const detail = view === 'detail';
  // 상세 화면에서는 탭 선택 표시를 건드리지 않는다 — 번호 시트로 곡을 넘겨도
  // '번호' 탭이 계속 선택된 것처럼 보여야 하기 때문.
  if (!detail) {
    // 검색 결과는 '한글' 탭, 시작 화면은 '번호' 탭에 대응한다.
    const tabKey = view === 'search' ? 'kor' : view === 'home' ? 'num' : view;
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.view === tabKey));
  }
  $('appbar').hidden = detail;
  if (!detail) $('appTitle').textContent = TITLES[view];

  if (!opts.keepScroll) $('main').scrollTop = 0;
  if (view === 'list') renderList();
  if (view === 'fav') renderFav();
}

/* ── 목록 렌더 ────────────────────────── */
function itemHTML(h, q) {
  let title = esc(h.title);
  if (q && !isChoQuery(q)) {
    const i = h.title.toLowerCase().indexOf(q.toLowerCase());
    if (i >= 0) {
      title = esc(h.title.slice(0, i)) + '<mark>' +
        esc(h.title.slice(i, i + q.length)) + '</mark>' +
        esc(h.title.slice(i + q.length));
    }
  }
  const sub = [h.tune, h.key].filter(Boolean).join(' · ');
  return `<li><button data-no="${h.no}">
    <span class="hl-no">${h.no}</span>
    <span class="hl-title">${title}${sub ? `<span class="hl-sub">${esc(sub)}</span>` : ''}</span>
    ${state.fav.has(h.no) ? '<span class="hl-star">★</span>' : ''}
  </button></li>`;
}

function renderList() {
  $('hymnList').innerHTML = state.hymns.map(h => itemHTML(h)).join('');
}

function renderFav() {
  const favs = state.hymns.filter(h => state.fav.has(h.no));
  $('favList').innerHTML = favs.map(h => itemHTML(h)).join('');
  $('favEmpty').hidden = favs.length > 0;
}

/* ── 검색 ─────────────────────────────── */
/* 입력줄 키보드 전환 — '번호'는 숫자 키패드, '한글'은 글자 키보드가 뜬다.
   inputMode 만 바꾸면 이미 떠 있는 폰 키보드는 그대로라서, 포커스를 다시 준다. */
function setOmniMode(mode) {
  const o = $('omni');
  const numeric = mode === 'numeric';
  o.inputMode = numeric ? 'numeric' : 'text';
  o.setAttribute('inputmode', numeric ? 'numeric' : 'text');
  if (numeric) o.setAttribute('pattern', '[0-9]*');
  else o.removeAttribute('pattern');
  o.placeholder = numeric ? '번호 입력  (예: 12)' : '제목 · 가사 · 초성 검색';

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === (numeric ? 'num' : 'kor')));

  // 폰에서 키보드가 실제로 바뀌려면 터치 이벤트와 같은 흐름에서 동기로
  // blur -> focus 해야 한다. setTimeout 으로 미루면 iOS 에서 키보드가 안 뜬다.
  if (document.activeElement === o) o.blur();
  o.focus();
}

/* 하단 입력줄 — 숫자면 그 즉시 곡을 열고, 글자가 섞이면 검색한다. */
let lastOmni = null;

/* 번호를 다 치고 잠깐 멈추면 입력칸이 저절로 비워진다.
   그래서 '완료'나 ✕ 를 누르지 않아도 다음 번호를 바로 칠 수 있다.
   (키보드의 완료 키는 기기마다 동작이 달라 믿고 쓸 수 없다) */
const AUTO_CLEAR_MS = 1800;
let autoClearTimer = null;

function scheduleAutoClear() {
  clearTimeout(autoClearTimer);
  autoClearTimer = setTimeout(() => {
    if (/^\d+$/.test($('omni').value.trim())) wipeOmni(false);
  }, AUTO_CLEAR_MS);
}

/* 입력줄 전체 지우기. 보던 곡은 그대로 두고 입력만 비운다. */
function wipeOmni(refocus) {
  const o = $('omni');
  clearTimeout(autoClearTimer);
  o.value = '';
  onOmni();
  if (refocus && document.activeElement !== o) o.focus();
}

function clearOmni() { wipeOmni(true); }

function onOmni() {
  // 일부 키보드는 '완료'를 줄바꿈 글자로 밀어 넣는다. 그것도 전체 지우기로 본다.
  if (/[\r\n]/.test($('omni').value)) { clearOmni(); return; }

  const raw = $('omni').value.trim();
  if (raw === lastOmni) return;    // 같은 값으로 여러 이벤트가 겹쳐 들어온다
  lastOmni = raw;

  const hint = $('omniHint');
  $('omniClear').hidden = !raw;

  if (!raw) {
    hint.hidden = true;
    hint.className = '';
    runSearch('');
    // 빈 검색 화면에 갇히지 않도록 보던 곡으로 되돌린다.
    if (state.view === 'search') show(state.current ? 'detail' : 'home');
    return;
  }

  if (/^\d+$/.test(raw)) {
    const no = Number(raw);
    hint.hidden = false;
    if (openHymn(raw, { replace: true, defer: true })) {
      hint.className = '';
      hint.innerHTML = `<b>${no}장</b> ${esc(state.current.title)}`;
    } else {
      hint.className = 'miss';
      hint.textContent = no > state.meta.totalSlots
        ? `${state.meta.totalSlots}장까지 있습니다`
        : `${no}장은 아직 등록되지 않았습니다`;
    }
    scheduleAutoClear();
    return;
  }

  hint.hidden = true;
  hint.className = '';
  if (state.view !== 'search') show('search', { keepScroll: true });
  runSearch(raw);
}

function runSearch(q) {
  const ul = $('searchResults');
  if (!q) { ul.innerHTML = ''; $('searchEmpty').hidden = true; return; }

  let hits;
  if (/^\d+$/.test(q)) {
    hits = state.hymns.filter(h => String(h.no).startsWith(q));
  } else if (isChoQuery(q)) {
    hits = state.hymns.filter(h => h._cho.includes(q));
  } else {
    const nq = norm(q);
    hits = state.hymns.filter(h => h._text.includes(nq));
  }
  ul.innerHTML = hits.slice(0, 200).map(h => itemHTML(h, q)).join('');
  $('searchEmpty').hidden = hits.length > 0;
}

/* ── 곡 열기 ──────────────────────────── */
let scoreTimer = null;

/* opts.replace : 주소를 덮어씀 (키패드로 훑는 중)
   opts.push=false : 주소를 건드리지 않음 (뒤로가기 복원)
   opts.defer : 악보 렌더링을 늦춤 (연타 중 불필요한 렌더 방지) */
function openHymn(no, opts = {}) {
  const h = state.byNo.get(Number(no));
  if (!h) return false;
  state.current = h;
  const url = '#' + h.no;
  if (opts.replace) history.replaceState({ no: h.no }, '', url);
  else if (opts.push !== false) history.pushState({ no: h.no }, '', url);

  paintFav(h.no);

  $('lyrics').innerHTML = (h.verses || []).map(v => `
    <div class="verse">
      <span class="verse-n">${esc(v.n)}</span>
      <div class="verse-body ${v.refrain ? 'refrain' : ''}">
        ${(v.lines || []).map(l => `<p>${esc(l)}</p>`).join('')}
      </div>
    </div>`).join('');

  show('detail');

  // 제목·가사는 즉시 바뀌고, 무거운 악보 렌더링만 잠깐 늦춘다.
  clearTimeout(scoreTimer);
  $('scoreMsg').hidden = false;
  $('scoreMsg').textContent = '악보 준비 중…';
  scoreTimer = setTimeout(() => loadScore(h), opts.defer ? 260 : 0);
  return true;
}

/* ── 악보 (OSMD) ──────────────────────── */
function transposeOf(no) { return state.settings.transpose[no] || 0; }

function paintFav(no) {
  const on = state.fav.has(no);
  const chip = $('favChip');
  chip.textContent = on ? '★' : '☆';
  chip.classList.toggle('on', on);
}

/* ── 악보 확대/이동 ─────────────────────
   페이지 전체는 확대되지 않게 막아 두고(viewport), 악보 영역만 여기서 직접
   처리한다. 두 손가락으로 벌리면 확대, 확대된 상태에서 끌면 이동. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const TAP_MS = 320;      // 이보다 오래 누르면 탭이 아니다
const TAP_SLOP = 12;     // 이보다 많이 움직이면 탭이 아니다

/* 악보 확대/이동기. 작은 악보칸과 전체화면이 같은 코드를 쓴다.
   opts.onTap   한 번 탭했을 때
   opts.onSwipe 확대하지 않은 상태에서 좌우로 밀었을 때 (-1 이전 / +1 다음)
   opts.onChange 배율이 바뀔 때 */
function createZoomer(wrapId, imgId, opts = {}) {
  const z = { s: 1, x: 0, y: 0 };
  const W = () => $(wrapId);
  const I = () => $(imgId);

  const gap = t => Math.hypot(t[0].clientX - t[1].clientX,
                              t[0].clientY - t[1].clientY);
  const mid = t => (t.length > 1
    ? { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }
    : { x: t[0].clientX, y: t[0].clientY });

  function apply() {
    I().style.transform =
      `translate(${z.x.toFixed(1)}px, ${z.y.toFixed(1)}px) scale(${z.s})`;
    W().classList.toggle('zoomed', z.s > 1.01);
    if (opts.onChange) opts.onChange(z);
  }

  /* 확대해도 악보가 화면 밖으로 완전히 빠져나가지 않게 붙잡는다. */
  function clamp() {
    z.s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z.s));
    const w = I().clientWidth || W().clientWidth;
    const h = I().clientHeight || W().clientHeight;
    z.x = Math.min(0, Math.max(-w * (z.s - 1), z.x));
    z.y = Math.min(0, Math.max(-h * (z.s - 1), z.y));
    if (z.s <= ZOOM_MIN + 0.001) { z.x = 0; z.y = 0; }
  }

  function reset() { z.s = 1; z.x = 0; z.y = 0; apply(); }

  function zoomTo(s) {
    z.s = s;
    z.x = -(W().clientWidth * (s - 1)) / 2;
    z.y = 0;
    clamp();
    apply();
  }

  let start = null;        // 확대/이동 시작 상태
  let tap = null;          // 탭 판정용
  let touchedAt = 0;       // 터치 뒤 따라오는 가짜 click 무시용

  const wrap = W();

  wrap.addEventListener('touchstart', e => {
    const t = e.touches;
    const pinch = t.length >= 2;
    if (t.length === 1) {
      tap = { at: Date.now(), x: t[0].clientX, y: t[0].clientY, moved: false };
    } else {
      tap = null;
    }
    // 확대 전의 한 손가락은 곡 넘기기용이므로 위로 흘려보낸다.
    if (!pinch && z.s <= 1.01) { start = null; return; }
    e.stopPropagation();
    start = { s: z.s, x: z.x, y: z.y, gap: pinch ? gap(t) : 0, p: mid(t), pinch };
  }, { passive: true });

  wrap.addEventListener('touchmove', e => {
    const t = e.touches;
    if (tap && t.length === 1 &&
        Math.hypot(t[0].clientX - tap.x, t[0].clientY - tap.y) > TAP_SLOP) {
      tap.moved = true;
    }
    if (!start) return;
    e.stopPropagation();
    e.preventDefault();

    const p = mid(t);
    if (start.pinch && t.length >= 2 && start.gap > 0) {
      const k = Math.min(ZOOM_MAX / start.s,
                Math.max(ZOOM_MIN / start.s, gap(t) / start.gap));
      z.s = start.s * k;
      // 손가락 사이 지점이 제자리에 머물도록 이동량을 보정한다.
      z.x = p.x - k * (start.p.x - start.x);
      z.y = p.y - k * (start.p.y - start.y);
    } else {
      z.x = start.x + (p.x - start.p.x);
      z.y = start.y + (p.y - start.p.y);
    }
    clamp();
    apply();
  }, { passive: false });

  wrap.addEventListener('touchend', e => {
    const last = e.changedTouches && e.changedTouches[0];
    const isTap = !!tap && !tap.moved && (Date.now() - tap.at) < TAP_MS &&
                  !!last && e.touches.length === 0;
    const dx = (tap && last) ? last.clientX - tap.x : 0;
    const dy = (tap && last) ? last.clientY - tap.y : 0;

    if (start) {
      // touchstart 를 가로챘으니 touchend 도 막아야 한다. 안 그러면 상세
      // 화면이 낡은 시작 좌표로 곡을 넘겨 버린다.
      e.stopPropagation();
      if (e.touches.length === 0) start = null;
      clamp();
      apply();
    } else if (opts.onSwipe && z.s <= 1.01 && tap && !isTap &&
               Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) {
      opts.onSwipe(dx < 0 ? 1 : -1);
    }

    if (isTap && opts.onTap) {
      touchedAt = Date.now();
      opts.onTap();
    }
    tap = null;
  }, { passive: true });

  // 마우스로 쓸 때
  wrap.addEventListener('click', () => {
    if (Date.now() - touchedAt < 600) return;   // 터치 뒤 따라온 가짜 click
    if (opts.onTap) opts.onTap();
  });

  wrap.addEventListener('wheel', e => {
    if (!e.ctrlKey && z.s <= 1.01) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z.s * k));
    const kk = ns / z.s;
    z.x = px - kk * (px - z.x);
    z.y = py - kk * (py - z.y);
    z.s = ns;
    clamp();
    apply();
  }, { passive: false });

  return { z, apply, clamp, reset, zoomTo };
}

let scoreZoom = null;    // 곡 화면 안의 작은 악보
let fsZoom = null;       // 전체화면 악보

/* ── 전체화면 악보 ───────────────────────
   악보를 한 번 탭하면 전체화면으로 열린다. 다시 탭하면 닫힌다. */
function fsOpen() {
  const src = $('scoreImg').getAttribute('src');
  if (!src || $('scoreImgWrap').hidden) return;
  $('fsImg').src = src;
  $('fsView').hidden = false;
  document.body.classList.add('fs-open');
  fsZoom.reset();
  // 브라우저의 네이티브 전체화면(requestFullscreen)은 그 요소의 자손만 그린다.
  // 그러면 하단 입력줄이 화면에서 사라져 번호를 칠 수 없다. 그래서 화면을
  // 덮는 방식으로 띄우고, 입력줄만 그 위에 올린다.
}

function fsClose() {
  $('fsView').hidden = true;
  document.body.classList.remove('fs-open');
}

const fsIsOpen = () => !$('fsView').hidden;

/* 전체화면 아래쪽에 배율을 잠깐 띄운다. 확대가 먹히는지 눈으로 바로 확인된다. */
let fsInfoTimer = null;
function fsInfoShow(text) {
  const el = $('fsInfo');
  el.hidden = false;
  el.classList.remove('fade');
  el.textContent = text;
  clearTimeout(fsInfoTimer);
  fsInfoTimer = setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => { el.hidden = true; }, 280);
  }, 1100);
}

/* 전체화면에서 곡을 넘기면 그림도 같이 바꾼다. */
function fsSync() {
  if (!fsIsOpen()) return;
  const src = $('scoreImg').getAttribute('src');
  if (src) { $('fsImg').src = src; fsZoom.reset(); }
}

/* 지금 화면에 쓰이는 악보 요소 (이미지 / OSMD) */
function activeScoreBox() {
  const type = ((state.current || {}).score || {}).type;
  return type === 'image' ? $('scoreImgWrap') : $('osmd');
}

async function loadScore(h) {
  const msg = $('scoreMsg'), box = $('osmd'), imgWrap = $('scoreImgWrap');
  const type = (h.score || {}).type;
  const collapsed = !state.settings.scoreFirst;

  $('scoreToggle').textContent = collapsed ? '악보 보기' : '악보 숨기기';
  $('trGroup').hidden = type !== 'musicxml';   // 조옮김은 MusicXML 에서만
  $('imgZoom').hidden = type !== 'image';

  if (!type) {
    box.hidden = imgWrap.hidden = true;
    box.innerHTML = '';
    msg.hidden = false;
    msg.textContent = '이 곡은 악보가 아직 등록되지 않았습니다.';
    return;
  }

  if (type === 'image') {
    box.hidden = true;
    box.innerHTML = '';
    imgWrap.hidden = collapsed;
    if (scoreZoom) scoreZoom.reset();   // 곡을 바꾸면 확대 상태도 처음으로
    msg.hidden = false;
    msg.textContent = '악보 불러오는 중…';
    const img = $('scoreImg');
    img.onload = () => { msg.hidden = true; fsSync(); };
    img.alt = `${h.no}장 ${h.title} 악보`;

    // 이전 곡의 Blob URL 은 반드시 풀어준다. 안 그러면 메모리가 계속 쌓인다.
    if (state.objUrl) { URL.revokeObjectURL(state.objUrl); state.objUrl = null; }

    const rec = state.lib.get(h.no);
    if (rec) {                       // 이 기기에 저장해 둔 악보
      state.objUrl = URL.createObjectURL(rec.blob);
      img.onerror = () => {
        msg.hidden = false;
        msg.textContent = '저장된 악보를 여는 데 실패했습니다.';
      };
      img.src = state.objUrl;
      return;
    }
    if (!h.score.src) {              // 보관함에도 없고 서버 경로도 없음
      img.removeAttribute('src');
      msg.hidden = false;
      msg.textContent = '이 곡의 악보가 이 기기에 없습니다. 설정에서 불러오세요.';
      return;
    }
    img.onerror = () => {
      msg.hidden = false;
      msg.textContent = '악보 이미지를 불러오지 못했습니다: ' + h.score.src;
    };
    img.src = h.score.src;
    return;
  }

  imgWrap.hidden = true;
  box.hidden = collapsed;
  msg.hidden = false; msg.textContent = '악보 불러오는 중…';
  box.innerHTML = '';

  if (typeof opensheetmusicdisplay === 'undefined') {
    msg.textContent = '악보 렌더러를 불러오지 못했습니다. (오프라인 첫 실행이면 온라인에서 한 번 열어주세요)';
    return;
  }
  try {
    state.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(box, {
      autoResize: true,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawPartNames: false,
      backend: 'svg',
      darkMode: isDark()
    });
    state.osmd.TransposeCalculator = new opensheetmusicdisplay.TransposeCalculator();
    await state.osmd.load(h.score.src);
    state.osmd.zoom = state.settings.zoom / 100;
    applyTranspose(false);
    msg.hidden = true;
  } catch (err) {
    msg.hidden = false;
    msg.textContent = '악보를 표시할 수 없습니다: ' + (err && err.message ? err.message : err);
  }
}

function applyTranspose(rerender = true) {
  const o = state.osmd;
  if (!o || !o.Sheet) return;
  const n = transposeOf(state.current.no);
  o.Sheet.Transpose = n;
  $('trLabel').textContent = n === 0 ? '원조' : (n > 0 ? `+${n}` : `${n}`);
  try {
    o.updateGraphic();
    o.render();
  } catch (e) {
    if (rerender) $('scoreMsg').textContent = '조옮김에 실패했습니다.';
  }
}

function bumpTranspose(d) {
  if (!state.current || !state.osmd) return;
  const no = state.current.no;
  const n = Math.max(-11, Math.min(11, transposeOf(no) + d));
  state.settings.transpose[no] = n;
  save();
  applyTranspose();
}

const isDark = () => document.documentElement.dataset.theme === 'dark' ||
  (state.settings.theme === 'auto' &&
   matchMedia('(prefers-color-scheme: dark)').matches);

/* ── 설정 적용 ────────────────────────── */
function applySettings() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme === 'auto' ? '' : s.theme;
  if (s.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.setProperty('--lyric-scale', s.font / 100);
  $('setTheme').value = s.theme;
  $('setFont').value = s.font;
  $('setZoom').value = s.zoom;
  $('setWake').checked = s.wake;
  $('setScoreFirst').checked = s.scoreFirst;
  $('setInvert').checked = s.invert;
  document.body.classList.toggle('invert-score', s.invert);
  if (state.osmd) { state.osmd.zoom = s.zoom / 100; try { state.osmd.render(); } catch (e) {} }
  updateWakeLock();
}

async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (state.settings.wake && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } else if (!state.settings.wake && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch (e) { /* 배터리 절약 모드 등에서 거부될 수 있다 */ }
}

/* ── 키패드 ───────────────────────────── */
function buildKeypad() {
  const keys = ['1','2','3','4','5','6','7','8','9','del','0','go'];
  $('keypad').innerHTML = keys.map(k => {
    if (k === 'del') return '<button class="del" data-k="del">지움</button>';
    if (k === 'go') return '<button class="go" data-k="go">크게 보기</button>';
    return `<button data-k="${k}">${k}</button>`;
  }).join('');
}

function openPad() {
  $('padSheet').hidden = false;
  $('padBackdrop').hidden = false;
  document.body.classList.add('pad-open');
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === 'pad'));
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty(
      '--pad-h', $('padSheet').offsetHeight + 'px');
  });
}

function closePad() {
  $('padSheet').hidden = true;
  $('padBackdrop').hidden = true;
  document.body.classList.remove('pad-open');
}

const maxDigits = () => String(state.meta.totalSlots || 645).length;

function padPress(k) {
  if (k === 'del') state.padBuf = '';          // 한 글자씩이 아니라 전부 지운다
  else if (k === 'go') { closePad(); return; }
  else if (state.padBuf.length < maxDigits()) state.padBuf += k;
  updatePad();
}

/* 한 글자 누를 때마다 뒤의 곡이 즉시 바뀐다. */
function updatePad() {
  const buf = state.padBuf;
  const hint = $('padHint');
  $('padNum').textContent = buf || '–';

  if (!buf) {
    hint.className = '';
    hint.textContent = '번호를 누르세요';
    return;
  }
  if (openHymn(buf, { replace: true, defer: true })) {
    hint.className = '';
    hint.textContent = state.current.title;
  } else {
    hint.className = 'miss';
    hint.textContent = Number(buf) > state.meta.totalSlots
      ? `${state.meta.totalSlots}장까지 있습니다`
      : `${buf}장은 아직 등록되지 않았습니다`;
  }
}

/* ── 오프라인 캐시 ────────────────────── */
async function cacheAll(btn) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    $('statCache').textContent = '서비스워커 없음 (http로 열어야 동작)';
    return;
  }
  btn.disabled = true;
  btn.textContent = '저장 중…';
  const urls = [DATA_URL, ...state.hymns.filter(h => h.score).map(h => h.score.src)];
  navigator.serviceWorker.controller.postMessage({ type: 'CACHE_URLS', urls });
  const ch = new MessageChannel();
  navigator.serviceWorker.addEventListener('message', function done(ev) {
    if (ev.data && ev.data.type === 'CACHE_DONE') {
      navigator.serviceWorker.removeEventListener('message', done);
      btn.disabled = false;
      btn.textContent = '전곡 오프라인 저장';
      $('statCache').textContent = `${ev.data.ok}곡 저장됨`;
    }
  });
  void ch;
}

/* ── 제스처 (좌우 스와이프로 곡 넘기기) ── */
const SWIPE_X = 70;    // 한 손가락 좌우 — 이만큼 밀어야 곡이 넘어간다
const SWIPE_Y2 = 60;   // 두 손가락 위아래 — 10단위 이동
const PINCH_TOL = 40;  // 두 손가락 간격이 이보다 더 벌어지면 핀치로 본다

let toastTimer = null;

function toast(text, sub) {
  const el = $('toast');
  el.innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '');
  el.hidden = false;
  el.classList.remove('out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.hidden = true; }, 260);
  }, 620);
}

function initSwipe() {
  const el = $('view-detail');
  const touches = e => e.touches || [];
  const gap = t => Math.hypot(t[0].clientX - t[1].clientX,
                              t[0].clientY - t[1].clientY);
  const mid = t => (t.length > 1
    ? { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }
    : { x: t[0].clientX, y: t[0].clientY });

  let sx = 0, sy = 0, cy0 = 0, cx0 = 0, gap0 = 0;
  let lastDy = 0, two = false, twoVertical = false, lockPan = false;
  // 이 화면이 touchstart 를 실제로 받았을 때만 손짓으로 인정한다.
  // 악보가 시작을 가로챈 경우 낡은 좌표로 곡이 넘어가면 안 된다.
  let armed = false;

  el.addEventListener('touchstart', e => {
    const t = touches(e);
    if (!t.length) return;
    armed = true;
    two = t.length >= 2;
    twoVertical = false;
    lastDy = 0;
    // 확대된 이미지 위에서는 좌우로 미는 게 '화면 밀기'여야 한다.
    // 악보를 확대해 둔 상태에서는 좌우로 미는 게 '악보 이동'이어야 한다.
    lockPan = scoreZoom.z.s > 1.01 &&
      !!(e.target.closest && e.target.closest('.score-img-wrap'));
    const c = mid(t);
    cx0 = c.x; cy0 = c.y;
    sx = t[0].clientX; sy = t[0].clientY;
    if (two) gap0 = gap(t);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    const t = touches(e);
    if (t.length !== 2) return;
    const c = mid(t);
    const dy = c.y - cy0, dx = c.x - cx0;
    lastDy = dy;
    // 간격을 유지한 채 세로로 함께 움직이면 핀치가 아니라 두 손가락 제스처다.
    if (Math.abs(gap(t) - gap0) < PINCH_TOL &&
        Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) {
      twoVertical = true;
      e.preventDefault();          // 브라우저 스크롤 대신 우리가 처리
    }
  }, { passive: false });

  el.addEventListener('touchend', e => {
    if (!armed) return;          // 시작을 못 봤으면 아무것도 하지 않는다
    armed = false;
    if (twoVertical) {
      if (Math.abs(lastDy) > SWIPE_Y2) jumpTen(lastDy < 0 ? 1 : -1);
      two = twoVertical = false;
      return;
    }
    if (two) { two = false; return; }      // 핀치였으면 아무것도 하지 않는다
    if (lockPan) return;

    const last = e.changedTouches && e.changedTouches[0];
    if (!last) return;
    const dx = last.clientX - sx;
    const dy = last.clientY - sy;
    if (Math.abs(dx) > SWIPE_X && Math.abs(dx) > Math.abs(dy) * 2) {
      step(dx < 0 ? 1 : -1);               // 오른쪽→왼쪽 = 다음 곡
    }
  }, { passive: true });
}

function step(d) {
  const i = state.hymns.indexOf(state.current) + d;
  if (i >= 0 && i < state.hymns.length) openHymn(state.hymns[i].no);
}

/* 등록된 곡 중 target 에 가장 가까운 곡 (dir 방향 우선) */
function nearestHymn(target, dir) {
  if (state.byNo.has(target)) return state.byNo.get(target);
  const ahead = state.hymns.filter(h => h.no >= target);
  const behind = state.hymns.filter(h => h.no <= target);
  return dir > 0
    ? (ahead[0] || behind[behind.length - 1] || null)
    : (behind[behind.length - 1] || ahead[0] || null);
}

/* 두 손가락 위/아래 — 10장 단위로 건너뛴다 (13장에서 위로 → 20장 → 30장) */
function jumpTen(dir) {
  if (!state.current) return;
  const cur = state.current.no;
  const max = state.meta.totalSlots || 645;
  let target = dir > 0
    ? (Math.floor(cur / 10) + 1) * 10
    : (Math.ceil(cur / 10) - 1) * 10;
  target = Math.max(1, Math.min(max, target));

  const h = nearestHymn(target, dir);
  if (!h || h.no === cur) {
    toast(dir > 0 ? '마지막 곡' : '첫 곡');
    return;
  }
  openHymn(h.no);
  toast(`${h.no}장`, h.title);
}

/* ── 이벤트 연결 ──────────────────────── */
function wire() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => {
      const v = t.dataset.view;
      closePad();
      if (v === 'num') { setOmniMode('numeric'); return; }
      if (v === 'kor') {
        setOmniMode('text');
        const q = $('omni').value.trim();
        if (q && !/^\d+$/.test(q)) {
          show('search', { keepScroll: true });
          runSearch(q);
        }
        return;
      }
      show(v);
    }));

  $('keypad').addEventListener('click', e => {
    const b = e.target.closest('button'); if (b) padPress(b.dataset.k);
  });
  $('padClose').addEventListener('click', closePad);
  $('padBackdrop').addEventListener('click', closePad);
  $('homeOpenPad').addEventListener('click', openPad);

  ['hymnList', 'searchResults', 'favList'].forEach(id =>
    $(id).addEventListener('click', e => {
      const b = e.target.closest('button[data-no]');
      if (b) { closePad(); openHymn(b.dataset.no); }
    }));

  // 안드로이드 IME 는 입력을 '조합 중'으로 들고 있다가 확정할 때가 있어서,
  // input 하나만 들으면 돋보기(확인)를 눌러야 반영되는 것처럼 보인다.
  // 값이 바뀔 수 있는 모든 경로에서 같은 처리를 돌린다.
  ['input', 'keyup', 'compositionupdate', 'compositionend', 'change', 'search']
    .forEach(ev => $('omni').addEventListener(ev, onOmni));
  // 숫자 키패드의 '완료'(Enter) 는 입력 전체 지우기로 쓴다.
  // 키보드는 내리지 않는다 — 바로 다음 번호를 칠 수 있어야 하므로.
  // '완료' 키는 기기/키보드마다 서로 다른 신호를 보낸다. 삼성 숫자 키패드처럼
  // keydown(Enter) 을 아예 안 주는 경우가 있어 잡을 수 있는 경로를 모두 건다.
  $('omni').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearOmni(); }
  });
  $('omni').addEventListener('beforeinput', e => {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      clearOmni();
    }
  });
  $('omniForm').addEventListener('submit', e => {
    e.preventDefault();
    clearOmni();
  });
  $('omniClear').addEventListener('click', clearOmni);

  $('favChip').addEventListener('click', () => {
    if (!state.current) return;
    const no = state.current.no;
    if (state.fav.has(no)) state.fav.delete(no); else state.fav.add(no);
    save();
    paintFav(no);
  });

  $('trUp').addEventListener('click', () => bumpTranspose(1));
  $('trDown').addEventListener('click', () => bumpTranspose(-1));
  $('scoreToggle').addEventListener('click', () => {
    const box = activeScoreBox();
    box.hidden = !box.hidden;
    $('scoreToggle').textContent = box.hidden ? '악보 보기' : '악보 숨기기';
  });
  $('imgZoom').addEventListener('click', () => {
    if (scoreZoom.z.s > 1.01) scoreZoom.reset();
    else scoreZoom.zoomTo(2.2);
  });

  // 작은 악보를 탭하면 전체화면, 전체화면에서 탭하면 닫는다.
  scoreZoom = createZoomer('scoreImgWrap', 'scoreImg', {
    onTap: fsOpen,
    onChange: z => {
      $('imgZoom').textContent = z.s > 1.01 ? '⤡ 원래대로' : '⤢ 확대';
    }
  });
  fsZoom = createZoomer('fsView', 'fsImg', {
    onTap: fsClose,
    onSwipe: step            // 전체화면에서도 좌우로 밀어 곡을 넘긴다
  });
  $('fsClose').addEventListener('click', e => { e.stopPropagation(); fsClose(); });

  // 확대기와 별개로 손가락 수를 읽는다. 확대가 안 될 때, 터치 자체가 안 오는지
  // 아니면 계산이 잘못된 것인지 화면만 보고 가릴 수 있다. (capture 단계)
  ['touchstart', 'touchmove', 'touchend'].forEach(ev =>
    $('fsView').addEventListener(ev, e => {
      const n = e.touches.length;
      // capture 단계라 확대 계산 전이다. 다음 프레임에 읽어야 현재 배율이 나온다.
      requestAnimationFrame(() => {
        fsInfoShow(n ? `손가락 ${n} · ${fsZoom.z.s.toFixed(1)}배`
                     : `${fsZoom.z.s.toFixed(1)}배`);
      });
    }, { passive: true, capture: true }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && fsIsOpen()) fsClose();
  });

  // iOS 사파리는 user-scalable=no 를 무시한다. 페이지 자체가 확대되지 않도록
  // 사파리 전용 제스처 이벤트를 막는다. 악보 확대는 위에서 직접 처리한다.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev =>
    document.addEventListener(ev, e => e.preventDefault(), { passive: false }));

  $('setTheme').addEventListener('change', e => {
    state.settings.theme = e.target.value; save(); applySettings();
    if (state.current && state.view === 'detail') loadScore(state.current);
  });
  $('setFont').addEventListener('input', e => {
    state.settings.font = +e.target.value;
    document.documentElement.style.setProperty('--lyric-scale', state.settings.font / 100);
  });
  $('setFont').addEventListener('change', save);
  $('setZoom').addEventListener('change', e => {
    state.settings.zoom = +e.target.value; save();
    if (state.osmd) { state.osmd.zoom = state.settings.zoom / 100; try { state.osmd.render(); } catch (err) {} }
  });
  $('setWake').addEventListener('change', e => {
    state.settings.wake = e.target.checked; save(); updateWakeLock();
  });
  $('setScoreFirst').addEventListener('change', e => {
    state.settings.scoreFirst = e.target.checked; save();
  });
  $('setInvert').addEventListener('change', e => {
    state.settings.invert = e.target.checked; save();
    document.body.classList.toggle('invert-score', state.settings.invert);
  });
  $('cacheBtn').addEventListener('click', e => cacheAll(e.target));

  $('libBtn').addEventListener('click', () => $('libPick').click());
  $('libPick').addEventListener('change', e => {
    if (e.target.files && e.target.files.length) importFiles(e.target.files);
    e.target.value = '';           // 같은 파일을 다시 골라도 change 가 뜨도록
  });
  $('libClearBtn').addEventListener('click', async () => {
    if (!state.lib.size) { toast('저장된 악보 없음'); return; }
    if (!confirm(`이 기기에 저장된 악보 ${state.lib.size}곡을 모두 지웁니다.\n계속할까요?`)) return;
    await libClearAll();
    for (const h of state.hymns) {
      if (h.score && h.score.local) delete h.score;
    }
    await loadLibrary();
    buildIndex();
    if (state.current) loadScore(state.current);
    toast('삭제했습니다');
  });

  window.addEventListener('popstate', e => {
    closePad();
    if (e.state && e.state.no) openHymn(e.state.no, { push: false });
    else show('home');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateWakeLock();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto' && state.current && state.view === 'detail') {
      loadScore(state.current);
    }
  });

  initSwipe();
}

/* 검색용 색인을 다시 만든다. 곡이 추가/변경될 때마다 호출. */
function buildIndex() {
  state.hymns.sort((a, b) => a.no - b.no);
  state.byNo.clear();
  for (const h of state.hymns) {
    state.byNo.set(h.no, h);
    const lyricText = (h.verses || []).flatMap(v => v.lines || []).join(' ');
    h._text = norm(h.title + ' ' + lyricText + ' ' + (h.tune || ''));
    h._cho = toCho(h.title + ' ' + lyricText);
  }
}

/* 이 기기에 저장해 둔 악보를 곡 목록에 얹는다. 없는 번호는 새로 만든다. */
async function loadLibrary() {
  const rows = await libAll();
  state.lib.clear();
  for (const r of rows) {
    if (!r || !r.blob) continue;
    state.lib.set(r.no, { title: r.title || '', blob: r.blob });

    let h = state.byNo.get(r.no);
    if (!h) {
      h = { no: r.no, title: r.title || `${r.no}장`, verses: [], tags: [] };
      state.hymns.push(h);
      state.byNo.set(r.no, h);
    }
    if (r.title) h.title = r.title;
    h.score = { type: 'image', local: true };
  }
  $('libCount').textContent = `${state.lib.size}곡`;
}

/* 고른 이미지들을 이 기기에 저장한다. 서버로는 아무것도 보내지 않는다. */
function report(html, bad) {
  const el = $('libReport');
  el.hidden = false;
  el.className = bad ? 'bad' : '';
  el.innerHTML = html;
}

async function importFiles(fileList) {
  const btn = $('libBtn');
  btn.disabled = true;
  btn.textContent = '읽는 중…';
  report('파일을 읽고 있습니다…');

  try {
    // ZIP 이 섞여 있으면 먼저 푼다.
    let files = [];
    for (const f of [...fileList]) {
      if (/\.zip$/i.test(f.name)) {
        report(`${esc(f.name)} 을 푸는 중…`);
        files = files.concat(await readZip(f));
      } else {
        files.push(f);
      }
    }

    const records = [];
    const rejected = [];
    for (const f of files) {
      const meta = parseFileName(f.name);
      if (!meta || !(meta.no >= 1 && meta.no <= state.meta.totalSlots)) {
        rejected.push(f.name);
        continue;
      }
      records.push({ no: meta.no, title: meta.title, blob: f });
    }

    if (!records.length) {
      const sample = rejected.slice(0, 3).map(esc).join('<br>');
      report(
        `<b>0곡 등록됨</b><br>고른 파일 ${files.length}개 모두 이름 앞에 번호가 없습니다.` +
        `<br><br>카톡·드라이브로 옮기면 이름이 바뀝니다. ZIP 으로 옮기면 원래 이름이 남습니다.` +
        (sample ? `<br><br>예: <br>${sample}` : ''), true);
      return;
    }

    btn.textContent = '저장 중…';
    await libPut(records);
    await loadLibrary();
    buildIndex();
    $('statCount').textContent =
      `${state.hymns.length} / ${state.meta.totalSlots}곡`;

    const nums = records.map(r => r.no).sort((a, b) => a - b);
    let msg = `<b>${records.length}곡 저장됨</b> (${nums[0]}~${nums[nums.length - 1]}장)`;
    if (rejected.length) {
      msg += `<br>${rejected.length}개는 이름에 번호가 없어 건너뜀:<br>` +
             rejected.slice(0, 3).map(esc).join('<br>');
    }
    report(msg + '<br><br>이 기기에만 저장되었습니다.');
    toast(`${records.length}곡 저장`);
  } catch (e) {
    report('<b>실패</b><br>' + esc(e && e.message ? e.message : e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '파일 고르기';
  }
}

/* ── 시작 ─────────────────────────────── */
async function main() {
  load();
  buildKeypad();
  wire();
  applySettings();

  try {
    // 내 곡 목록이 있으면 그것을, 없으면 저장소에 포함된 예시를 쓴다.
    let res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) res = await fetch(SAMPLE_URL, { cache: 'no-cache' });
    const json = await res.json();
    state.meta = json.meta || { totalSlots: 645 };
    state.hymns = (json.hymns || []).sort((a, b) => a.no - b.no);
  } catch (e) {
    $('padHint').textContent = 'data/hymns.json 을 불러오지 못했습니다';
    return;
  }

  await loadLibrary();
  buildIndex();

  $('statCount').textContent =
    `${state.hymns.length} / ${state.meta.totalSlots}곡`;
  $('statCache').textContent =
    navigator.serviceWorker ? '준비됨' : '이 브라우저에서는 불가';
  $('statVer').textContent = APP_VERSION;

  const hash = location.hash.replace('#', '');
  if (hash && state.byNo.has(Number(hash))) {
    openHymn(hash, { push: false });
  } else {
    show('home');
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
