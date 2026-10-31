/* 9급 문제은행 — 한 문제씩 풀고 바로 채점한다.
   출제 규칙은 PC의 bank.py와 같다: 영역 비율(BLUEPRINT) → 급수 비율(LEVEL_MIX)
   → 영역 안에서는 오답률 높은 단원 우선, 최근 N일 안에 푼 문항은 쿨다운.
   기록은 이 기기에 쌓이고, 동기화 코드를 넣으면 /api/sync로 다른 기기와 합친다. */
'use strict';

const SUBJECTS = [
  { key: 'kor', name: '국어' },
  { key: 'eng', name: '영어' },
  { key: 'law', name: '행정법', ox: true },
  { key: 'adm', name: '행정학', ox: true },
];
const SUBJ = Object.fromEntries(SUBJECTS.map(s => [s.key, s]));
const CIRC = ['①', '②', '③', '④', '⑤'];
const DAY = 864e5;
const DAILY_N = 10, OX_N = 20, SET_N = 10;

/* ── 저장 (이 기기의 브라우저) ─────────────────────────────── */
const store = {
  get(k, d) { try { const v = localStorage.getItem('gb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gb.' + k, JSON.stringify(v)); return true; } catch (e) { toast('저장 공간이 부족해 기록하지 못했어요'); return false; } },
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

let HIST = store.get('hist', []);      // [{u, id, s, c(code), r(area), ok, t, d(ms), p, k?:'ox'}]
// 저장·신고는 {id: {on, t}} — 기기 간에 마지막에 바꾼 쪽이 이긴다. (첫 버전은 {id: t}였다)
const upgradeMap = m => { const o = {}; for (const k in m) o[k] = typeof m[k] === 'number' ? { on: true, t: m[k] } : m[k]; return o; };
let STARS = upgradeMap(store.get('stars', {}));
let FLAGS = upgradeMap(store.get('flags', {}));
let DAILY = store.get('daily', {});    // {"law|2026-10-20|q": {ids, t}}
let SYNC = store.get('sync', { code: '', cursor: 0, outbox: [], at: 0 });
let MEMO = store.get('memo', {});      // 개념 카드 메모 {cardId: {v, t}} — 기기 간에 마지막에 고친 쪽이 이긴다
{ let fix = false; for (const h of HIST) if (!h.u) { h.u = uid(); fix = true; } if (fix) store.set('hist', HIST); }
const HSEEN = new Set(HIST.map(h => h.u));
const DATA = {}, OX = {}, CON = {};

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ── 데이터 ─────────────────────────────────────────────── */
async function load(key) {
  if (DATA[key]) return DATA[key];
  const r = await fetch('data/' + key + '.json');
  if (!r.ok) throw new Error('데이터를 불러오지 못했어요 (' + r.status + ')');
  const d = await r.json();
  d.byId = new Map(d.items.map(q => [q.id, q]));
  d.unitCount = {};
  for (const q of d.items) d.unitCount[q.code] = (d.unitCount[q.code] || 0) + 1;
  return (DATA[key] = d);
}
async function loadOx(key) {
  if (OX[key]) return OX[key];
  const r = await fetch('data/ox_' + key + '.json');
  if (!r.ok) throw new Error('OX 데이터를 불러오지 못했어요 (' + r.status + ')');
  const d = await r.json();
  d.byId = new Map(d.items.map(o => [o.id, o]));
  return (OX[key] = d);
}

// 개념 카드 (data/concept_{key}.json). 없으면 빈 것으로 둔다.
async function loadConcept(key) {
  if (CON[key]) return CON[key];
  let d = { units: {} };
  try { const r = await fetch('data/concept_' + key + '.json'); if (r.ok) d = await r.json(); } catch (e) { }
  d.byQ = new Map(); d.card = new Map();
  for (const [code, u] of Object.entries(d.units)) for (const c of u.cards) {
    d.card.set(c.id, { code, c });
    for (const q of c.q || []) { if (!d.byQ.has(q)) d.byQ.set(q, []); d.byQ.get(q).push({ code, c }); }
  }
  return (CON[key] = d);
}

/* ── 기록 조회 ─────────────────────────────────────────── */
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dateKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function histOf(key, ox) { return HIST.filter(h => h.s === key && (ox ? h.k === 'ox' : h.k !== 'ox')); }
function lastById(key, ox) {
  const m = new Map();
  for (const h of histOf(key, ox)) { const p = m.get(h.id); if (!p || h.t >= p.t) m.set(h.id, h); }
  return m;
}
function errRate(key) {           // 단원별 라플라스 보정 오답률 (bank.py error_rate와 같다). OX 기록도 같은 단원으로 센다.
  const agg = {};
  for (const h of HIST) if (h.s === key) { const a = agg[h.c] || (agg[h.c] = [0, 0]); a[0]++; if (!h.ok) a[1]++; }
  const out = {};
  for (const k in agg) out[k] = (agg[k][1] + 1) / (agg[k][0] + 2);
  return out;
}
function wrongIds(key) { const out = []; for (const [id, h] of lastById(key)) if (!h.ok && DATA[key].byId.has(id)) out.push(id); return out; }
// 마지막에 틀린 OX 문장. OX 데이터를 아직 안 받았으면 기록만으로 센다.
function oxWrongIds(key) { const out = []; for (const [id, h] of lastById(key, true)) if (!h.ok && (!OX[key] || OX[key].byId.has(id))) out.push(id); return out; }
const starIds = key => Object.keys(STARS).filter(id => STARS[id].on && DATA[key] && DATA[key].byId.has(id));

/* ── 출제 ──────────────────────────────────────────────── */
// 오늘의 세트는 날짜·과목으로 정해지는 고정 난수로 뽑는다. 두 기기의 기록이 같으면 같은 세트가 나온다.
function seededRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  let a = h >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function wpick(arr, w, rng = Math.random) {
  const tot = w.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return arr[Math.floor(rng() * arr.length)];
  let r = rng() * tot;
  for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}
const wq = (er, q) => (er[q.code] ?? .5) ** 2 + .05;

// 실전 비율: 영역(BLUEPRINT) → 급수(LEVEL_MIX) → 오답률 높은 단원 우선.
// 쿨다운: 마지막에 맞힌 문항은 conf.cooldown일, 틀린 문항은 conf.cooldownWrong일 쉰다(PC bank.py와 같다).
function pickMix(items, conf, er, exclude, lastMap, rng = Math.random) {
  const now = Date.now(), okCut = now - conf.cooldown * DAY, ngCut = now - (conf.cooldownWrong ?? 7) * DAY;
  const resting = q => { const h = lastMap.get(q.id); return h && h.t >= (h.ok ? okCut : ngCut); };
  const cand = items.filter(q => !exclude.has(q.id) && !resting(q));
  if (!cand.length) {   // 전부 쉬는 중이면 가장 오래전에 푼 것부터 다시
    let best = null;
    for (const q of items) if (!exclude.has(q.id)) { const h = lastMap.get(q.id); if (!best || (h ? h.t : 0) < best[1]) best = [q, h ? h.t : 0]; }
    return best && best[0];
  }
  const byArea = {};
  for (const q of cand) (byArea[q.area] || (byArea[q.area] = [])).push(q);
  const areas = Object.keys(conf.blueprint).filter(a => byArea[a]);
  if (!areas.length) return wpick(cand, cand.map(q => wq(er, q)), rng);
  let pool = byArea[wpick(areas, areas.map(a => conf.blueprint[a]), rng)];
  if (conf.levelMix) {
    const lvs = Object.keys(conf.levelMix).filter(lv => pool.some(q => q.lv === lv));
    if (lvs.length) { const lv = wpick(lvs, lvs.map(l => conf.levelMix[l]), rng); pool = pool.filter(q => q.lv === lv); }
  }
  return wpick(pool, pool.map(q => wq(er, q)), rng);
}

// 단원: 안 푼 것·틀린 것 먼저, 맞힌 것은 뒤로 (bank.py unit과 같다). 쿨다운 없음.
function pickUnit(key, codes, exclude) {
  const last = lastById(key), er = errRate(key);
  const cand = DATA[key].items.filter(q => codes.includes(q.code) && !exclude.has(q.id));
  if (!cand.length) return null;
  return wpick(cand, cand.map(q => { const h = last.get(q.id); return (h && h.ok ? .25 : 1) * wq(er, q); }));
}

function generateDaily(key, kind) {
  const dk = key + '|' + dateKey() + '|' + kind;
  const ex = new Set(), ids = [], rng = seededRng(dk);
  const conf = DATA[key].conf, er = errRate(key);
  const [items, n, last] = kind === 'ox' ? [OX[key].items, OX_N, lastById(key, true)] : [DATA[key].items, DAILY_N, lastById(key)];
  for (let i = 0; i < n; i++) { const q = pickMix(items, conf, er, ex, last, rng); if (!q) break; ex.add(q.id); ids.push(q.id); }
  return ids;
}
// 서버에 오늘의 세트를 등록한다. 먼저 등록된 세트가 있으면 그걸 돌려받는다(c: 서버 확정).
async function claimDaily(dk, ids) {
  const r = await fetch('api/daily', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SYNC.code },
    body: JSON.stringify({ dk, ids }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  DAILY[dk] = { ids: j.ids, t: j.t, c: true }; store.set('daily', DAILY);
}
// 세트를 새로 만들기 전에 먼저 동기화해서 다른 기기가 만든 오늘의 세트가 있으면 그걸 쓴다.
async function ensureDaily(key, kind) {
  const dk = key + '|' + dateKey() + '|' + kind;
  if (DAILY[dk] && (DAILY[dk].c || !SYNC.code)) return;
  if (SYNC.code) {
    // 기록을 먼저 맞춰서 같은 후보를 만들고, 서버에서 확정받는다. 오프라인이면 이 기기 세트로 시작하고 나중에 맞춘다.
    await Promise.race([syncNow(), new Promise(r => setTimeout(r, 4000))]);
    try { await claimDaily(dk, DAILY[dk] ? DAILY[dk].ids : generateDaily(key, kind)); return; } catch (e) { /* 오프라인 */ }
  }
  if (!DAILY[dk]) { DAILY[dk] = { ids: generateDaily(key, kind), t: Date.now() }; store.set('daily', DAILY); }
}
function dailyState(key, kind) {
  const dk = key + '|' + dateKey() + '|' + kind;
  const set = DAILY[dk];
  if (!set) return null;
  const t0 = today0(), done = new Map();
  for (const h of HIST) if (h.s === key && h.t >= t0 && set.ids.includes(h.id) && (kind === 'ox') === (h.k === 'ox')) done.set(h.id, h);
  return { ids: set.ids, done };
}

function makeWrongSet(key, ox) {
  const er = errRate(key), last = lastById(key, ox);
  const ids = ox ? oxWrongIds(key) : wrongIds(key), src = ox ? OX[key] : DATA[key];
  // 오래전에 틀린 것, 약한 단원 먼저
  const w = ids.map(id => { const q = src.byId.get(id); const age = (Date.now() - last.get(id).t) / DAY; return wq(er, q) * (1 + Math.min(age, 30) / 10); });
  const out = [], pool = ids.slice(), ww = w.slice(), n = ox ? OX_N : SET_N;
  while (out.length < n && pool.length) { const x = wpick(pool, ww); const i = pool.indexOf(x); out.push(x); pool.splice(i, 1); ww.splice(i, 1); }
  return out;
}

/* ── 기록 ──────────────────────────────────────────────── */
function record(key, item, picked, ok, ms, ox) {
  const h = { u: uid(), id: item.id, s: key, c: item.code, r: item.area, ok, t: Date.now(), d: Math.round(ms), p: picked };
  if (ox) h.k = 'ox';
  HIST.push(h); HSEEN.add(h.u); store.set('hist', HIST);
  emit({ u: h.u, k: 'h', d: h, t: h.t });
}
function toggleMap(map, name, id) {
  const on = !(map[id] && map[id].on), t = Date.now();
  map[id] = { on, t }; store.set(name, map);
  emit({ k: name === 'stars' ? 's' : 'f', d: { id, on }, t });
  return on;
}

/* ── 동기화 ─────────────────────────────────────────────── */
let syncTimer = null, syncP = null, syncState = '';
function emit(ev) {
  if (!SYNC.code) return;
  ev.u = ev.u || uid();
  SYNC.outbox.push(ev); store.set('sync', SYNC);
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2500);
}
function applyRemote(items) {
  let n = 0;
  for (const e of items) {
    if (e.k === 'h') { if (!HSEEN.has(e.u)) { HIST.push(e.d); HSEEN.add(e.u); n++; } }
    else if (e.k === 's' || e.k === 'f') {
      const map = e.k === 's' ? STARS : FLAGS, cur = map[e.d.id];
      if (!cur || e.t > cur.t) map[e.d.id] = { on: !!e.d.on, t: e.t };
    }   // (첫 동기화 버전의 'd' 이벤트는 이제 /api/daily가 맡으므로 무시한다)
    else if (e.k === 'm') { const cur = MEMO[e.d.id]; if (!cur || e.t > cur.t) MEMO[e.d.id] = { v: String(e.d.v || ''), t: e.t }; }
  }
  if (n) HIST.sort((a, b) => a.t - b.t);
  store.set('hist', HIST); store.set('stars', STARS); store.set('flags', FLAGS); store.set('daily', DAILY); store.set('memo', MEMO);
  return n;
}
function syncNow(manual) {
  if (!SYNC.code) return Promise.resolve();
  if (syncP) return syncP;
  syncP = doSync(manual).finally(() => { syncP = null; });
  return syncP;
}
async function doSync(manual) {
  setSyncBadge('동기화 중…');
  let got = 0;
  try {
    for (let i = 0; i < 20; i++) {
      const push = SYNC.outbox.slice(0, 1500);
      const r = await fetch('api/sync', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SYNC.code },
        body: JSON.stringify({ since: SYNC.cursor, push }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      SYNC.outbox = SYNC.outbox.slice(push.length);
      got += applyRemote(j.items || []);
      SYNC.cursor = j.cursor; SYNC.at = Date.now(); store.set('sync', SYNC);
      if (!j.more && !SYNC.outbox.length) break;
    }
    // 오프라인에서 만든 오늘의 세트를 서버 확정 세트로 맞춘다
    const today = '|' + dateKey() + '|';
    for (const dk of Object.keys(DAILY)) if (dk.includes(today) && !DAILY[dk].c) { try { await claimDaily(dk, DAILY[dk].ids); } catch (e) { } }
    syncState = 'ok';
    setSyncBadge('동기화됨');
    if (manual) toast(got ? `다른 기기 기록 ${got}건을 합쳤어요` : '동기화했어요');
    if (got && onSyncRefresh) onSyncRefresh();
  } catch (e) {
    syncState = 'err';
    setSyncBadge(navigator.onLine === false ? '오프라인' : '동기화 실패');
    if (manual) toast('동기화하지 못했어요: ' + e.message);
  }
}
let onSyncRefresh = null;
function setSyncBadge(txt) { const b = document.getElementById('sync-badge'); if (b) b.textContent = txt; }
function enableSync(code) {
  SYNC = { code, cursor: 0, outbox: [], at: 0 };
  // 이 기기에 이미 쌓인 기록을 전부 올린다. 같은 기록은 서버에서 한 번만 저장된다.
  for (const h of HIST) SYNC.outbox.push({ u: h.u, k: 'h', d: h, t: h.t });
  for (const [id, v] of Object.entries(STARS)) SYNC.outbox.push({ u: uid(), k: 's', d: { id, on: v.on }, t: v.t });
  for (const [id, v] of Object.entries(FLAGS)) SYNC.outbox.push({ u: uid(), k: 'f', d: { id, on: v.on }, t: v.t });
  store.set('sync', SYNC);
  return syncNow(true);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { syncNow(); return; }
  // 앱을 닫거나 다른 앱으로 갈 때: 남은 기록을 바로 올린다(keepalive는 페이지가 사라져도 요청을 끝까지 보낸다).
  if (!SYNC.code || !SYNC.outbox.length) return;
  clearTimeout(syncTimer);
  const push = [];
  let size = 0;
  for (const e of SYNC.outbox) { size += JSON.stringify(e).length; if (size > 50000) break; push.push(e); }
  fetch('api/sync', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SYNC.code },
    body: JSON.stringify({ since: SYNC.cursor, push }) }).catch(() => {});
  // 응답을 못 받을 수 있으므로 outbox는 그대로 둔다. 다시 열 때 한 번 더 올라가도 서버가 중복을 버린다.
});
window.addEventListener('online', () => syncNow());

/* ── 화면 도구 ─────────────────────────────────────────── */
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/\x02/g, '<u>').replace(/\x03/g, '</u>');
const pct = x => x == null ? '–' : Math.round(x * 100) + '%';
let dock = null;
function setDock(html) {
  if (!dock) { dock = document.createElement('div'); dock.className = 'dock'; document.body.appendChild(dock); }
  dock.hidden = !html; dock.innerHTML = html ? '<div class="in">' + html + '</div>' : '';
}
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}
const bar = (left, title, right = '') => `<div class="bar">${left}<h1>${title}</h1><span class="sub">${right}</span></div>`;
const back = (label = '← 처음') => `<button class="icon-btn" data-back type="button">${label}</button>`;
function on(sel, fn) { $app.querySelectorAll(sel).forEach(el => el.onclick = e => fn(el, e)); }
const syncLabel = () => SYNC.code ? (syncState === 'err' ? '동기화 실패' : '동기화됨') : '동기화 꺼짐';

/* ── 홈 ────────────────────────────────────────────────── */
async function showHome() {
  onSyncRefresh = showHome; setDock('');
  if (!Object.keys(DATA).length) $app.innerHTML = bar('', '9급 문제은행') + '<div class="loading">불러오는 중…</div>';
  try { await Promise.all(SUBJECTS.map(s => load(s.key))); }
  catch (e) { $app.innerHTML = bar('', '9급 문제은행') + `<div class="loading">${esc(e.message)} — 인터넷 연결을 확인하고 다시 열어 주세요.</div>`; return; }
  const dk = dateKey();
  const cards = SUBJECTS.map(s => {
    const d = DATA[s.key], hs = histOf(s.key), last = lastById(s.key);
    const t0 = today0(), today = hs.filter(h => h.t >= t0);
    const recent = hs.slice(-100), acc = recent.length ? recent.filter(h => h.ok).length / recent.length : null;
    const ds = dailyState(s.key, 'q');
    const dTxt = ds ? (ds.done.size >= ds.ids.length ? '오늘의 10 완료' : `오늘의 10 · ${ds.done.size}/${ds.ids.length}`) : '오늘의 10 시작 전';
    return `<button class="subj" data-k="${s.key}" type="button">
      <span class="nm">${s.name}</span>
      <span class="ln ${ds && ds.done.size >= ds.ids.length ? 'done' : ''}">${dTxt}</span>
      <span class="acc">오늘 ${today.length}문제 · 최근 정답률 <b>${pct(acc)}</b></span>
      <span class="meter" aria-hidden="true"><i style="width:${(last.size / d.items.length * 100).toFixed(1)}%"></i></span>
      <span class="ln">${last.size.toLocaleString()} / ${d.items.length.toLocaleString()}문항 풀어봄</span>
    </button>`;
  }).join('');
  $app.innerHTML = `<div class="bar"><h1>9급 문제은행</h1>
      <span class="sub"><button class="icon-btn" id="sync-badge" type="button">${syncLabel()}</button></span>
      <button class="icon-btn" id="go-stats" type="button">통계</button></div>
    <div class="subjects">${cards}</div>
    <p class="note">${dk} · 과목을 눌러 오늘의 10문제, OX, 오답, 단원별로 풀 수 있어요.</p>`;
  on('.subj', b => showSubject(b.dataset.k));
  document.getElementById('go-stats').onclick = showStats;
  document.getElementById('sync-badge').onclick = showSync;
  window.scrollTo(0, 0);
}

/* ── 과목 ──────────────────────────────────────────────── */
async function showSubject(key) {
  onSyncRefresh = () => showSubject(key); setDock('');
  await load(key);
  const s = SUBJ[key], d = DATA[key];
  const con = s.ox ? await loadConcept(key) : null;
  const cu = con ? Object.keys(con.units).length : 0;
  const ds = dailyState(key, 'q');
  const dSub = ds ? (ds.done.size >= ds.ids.length ? `완료 · ${[...ds.done.values()].filter(h => h.ok).length}/${ds.ids.length} 맞음` : `${ds.done.size}/${ds.ids.length} 풀었음 · 이어 풀기`) : '실제 출제 비율로 10문제';
  let oxRow = '';
  if (s.ox) {
    const os = dailyState(key, 'ox');
    const oSub = os ? (os.done.size >= os.ids.length ? `완료 · ${[...os.done.values()].filter(h => h.ok).length}/${os.ids.length} 맞음` : `${os.done.size}/${os.ids.length} 풀었음 · 이어 풀기`) : '기출 선지 20문장, O인지 X인지';
    const own = oxWrongIds(key).length;
    oxRow = `<button class="mode" data-m="ox" type="button"><span class="mt">오늘의 OX 20</span><span class="ms">${oSub}</span></button>
      <button class="mode" data-m="oxwrong" type="button" ${own ? '' : 'disabled'}><span class="mt">OX 오답 20</span><span class="ms">${own ? (own > OX_N ? `틀린 OX 문장 ${own}개 중 ${OX_N}개` : `틀린 OX 문장 ${own}개 모두`) : '아직 틀린 OX 문장이 없어요'}</span></button>`;
  }
  const wn = wrongIds(key).length, sn = starIds(key).length;
  $app.innerHTML = bar(back(), s.name, `${d.items.length.toLocaleString()}문항`) + `
    <div class="modes">
      <button class="mode primary" data-m="daily" type="button"><span class="mt">오늘의 10문제</span><span class="ms">${dSub}</span></button>
      ${cu ? `<button class="mode" data-m="concept" type="button"><span class="mt">개념 카드</span><span class="ms">책 읽은 뒤 카드로 확인 → 그 단원 기출 · ${cu}단원</span></button>` : ''}
      ${oxRow}
      <button class="mode" data-m="wrong" type="button" ${wn ? '' : 'disabled'}><span class="mt">오답 10문제</span><span class="ms">${wn ? (wn > SET_N ? `틀린 문제 ${wn}개 중 ${SET_N}개` : `틀린 문제 ${wn}개 모두`) : '아직 틀린 문제가 없어요'}</span></button>
      <button class="mode" data-m="units" type="button"><span class="mt">단원별</span><span class="ms">단원 골라 10문제 세트 또는 단원 집중</span></button>
      <button class="mode" data-m="mix" type="button"><span class="mt">계속 풀기</span><span class="ms">실제 출제 비율로 끝없이 · 맞힌 문제는 ${d.conf.cooldown}일, 틀린 문제는 ${d.conf.cooldownWrong ?? 7}일 쉬었다가 다시</span></button>
      <button class="mode" data-m="star" type="button" ${sn ? '' : 'disabled'}><span class="mt">저장한 문제</span><span class="ms">${sn}개</span></button>
    </div>`;
  on('[data-back]', showHome);
  on('.mode', async b => {
    const m = b.dataset.m;
    if (m === 'daily') { b.disabled = true; await ensureDaily(key, 'q'); startSet(key, 'daily'); }
    else if (m === 'ox') { b.disabled = true; await loadOx(key); await ensureDaily(key, 'ox'); startSet(key, 'ox'); }
    else if (m === 'wrong') startSet(key, 'wrong', makeWrongSet(key));
    else if (m === 'oxwrong') { b.disabled = true; await loadOx(key); startSet(key, 'oxwrong', makeWrongSet(key, true)); }
    else if (m === 'star') startSet(key, 'star', starIds(key));
    else if (m === 'units') showUnits(key);
    else if (m === 'concept') showConceptList(key);
    else startStream(key, 'mix');
  });
  window.scrollTo(0, 0);
}

function showUnits(key) {
  onSyncRefresh = () => showUnits(key); setDock('');
  const d = DATA[key], conf = d.conf;
  const last = lastById(key);
  const byCode = {};
  for (const [id, h] of last) { const q = d.byId.get(id); if (!q) continue; const a = byCode[q.code] || (byCode[q.code] = [0, 0]); a[0]++; if (h.ok) a[1]++; }
  const areaOf = {};
  for (const q of d.items) areaOf[q.code] = q.area;
  const codes = Object.keys(d.unitCount).sort((a, b) => {
    const ka = Object.keys(conf.units).indexOf(a), kb = Object.keys(conf.units).indexOf(b);
    return (ka < 0 ? 1e9 : ka) - (kb < 0 ? 1e9 : kb) || a.localeCompare(b);
  });
  const groups = Object.keys(conf.blueprint).map(area => {
    const rows = codes.filter(c => areaOf[c] === area).map(c => {
      const [n, ok] = byCode[c] || [0, 0];
      const acc = n ? ok / n : null;
      return `<li class="unit"><div class="un"><span class="unm">${esc(conf.units[c] || c)}</span>
          <span class="ust">${d.unitCount[c]}문항 · 푼 것 ${n}${n ? ` · 정답률 ${pct(acc)}` : ''}</span></div>
        <div class="ubtn">${CON[key] && CON[key].units[c] ? `<button class="chip con" data-c="${esc(c)}" data-u="con" type="button">개념</button>` : ''}<button class="chip" data-c="${esc(c)}" data-u="set" type="button">10문제</button>
        <button class="chip" data-c="${esc(c)}" data-u="focus" type="button">집중</button></div></li>`;
    }).join('');
    return rows ? `<p class="sec-h">${esc(area)} · 출제 ${Math.round(conf.blueprint[area] * 100)}%</p><ul class="units">${rows}</ul>` : '';
  }).join('');
  $app.innerHTML = bar(back('← ' + SUBJ[key].name), '단원별') + `<p class="note">10문제: 그 단원에서 10문제 세트. 집중: 그 단원만 끝없이. 둘 다 안 푼 문제와 틀린 문제가 먼저 나오고, 최근에 푼 문제도 다시 나와요.</p>${groups}`;
  on('[data-back]', () => showSubject(key));
  on('[data-u]', b => {
    const c = b.dataset.c;
    if (b.dataset.u === 'con') { showConcept(key, c, null, () => showUnits(key)); return; }
    if (b.dataset.u === 'set') { const ex = new Set(), ids = []; for (let i = 0; i < SET_N; i++) { const q = pickUnit(key, [c], ex); if (!q) break; ex.add(q.id); ids.push(q.id); } startSet(key, 'unit', ids, c); }
    else startStream(key, 'focus', c);
  });
  window.scrollTo(0, 0);
}

/* ── 풀기: 세트(정해진 목록)와 스트림(끝없이) ───────────────── */
let S = null;   // {key, mode, ox, list?, idx, res:Map(id→h), code?, seen:Set, cur, picked, t0, n, ok}
const MODE_NAME = { daily: '오늘의 10문제', ox: '오늘의 OX 20', oxwrong: 'OX 오답 20', wrong: '오답 10문제', unit: '단원 10문제', star: '저장한 문제', mix: '계속 풀기', focus: '단원 집중', cunit: '단원 기출', cq: '개념 기출', cox: '개념 OX' };
const OX_MODES = new Set(['ox', 'oxwrong', 'cox']);

function startSet(key, mode, ids, code, ret) {
  let list = ids, res = new Map();
  if (mode === 'daily' || mode === 'ox') {
    const st = dailyState(key, mode === 'ox' ? 'ox' : 'q');
    list = st.ids; res = new Map(st.done);
  }
  if (!list || !list.length) { toast('풀 문제가 없어요'); return; }
  S = { key, mode, ox: OX_MODES.has(mode), list, res, code, ret, seen: new Set(), n: 0, ok: 0 };
  const i = list.findIndex(id => !res.has(id));
  if (i < 0) { showResults(); return; }
  S.idx = i; showItem();
}
function startStream(key, mode, code) {
  S = { key, mode, ox: false, list: null, res: new Map(), code, seen: new Set(), n: 0, ok: 0 };
  nextStream();
}
function nextStream() {
  const { key, mode, code } = S;
  const q = mode === 'focus' ? pickUnit(key, [code], S.seen)
    : pickMix(DATA[key].items, DATA[key].conf, errRate(key), S.seen, lastById(key));
  if (!q) { toast(mode === 'focus' ? '이 단원 문제를 다 봤어요' : '풀 문제가 없어요'); showSubject(key); return; }
  S.cur = q.id; S.seen.add(q.id); S.picked = null; S.t0 = performance.now();
  renderItem();
}
function showItem() {
  S.cur = S.list[S.idx]; S.picked = null; S.t0 = performance.now();
  renderItem();
}
function advance() {
  if (!S.list) { nextStream(); return; }
  const i = S.list.findIndex((id, j) => j > S.idx && !S.res.has(id));
  const j = i >= 0 ? i : S.list.findIndex(id => !S.res.has(id));
  if (j < 0) { showResults(); return; }
  S.idx = j; showItem();
}

function itemOf(id) { return S.ox ? OX[S.key].byId.get(id) : DATA[S.key].byId.get(id); }

function blocksHtml(blocks) {
  return blocks.map(b => {
    if (b.t === 'text') return /^<표>/.test(b.v) && !b.v.includes('\n') ? `<div class="gcap">${esc(b.v)}</div>` : `<div class="psg">${esc(b.v)}</div>`;
    if (b.t === 'grid') {                 // span: 병합 셀 [행, 열, 행수, 열수]. 가려진 칸은 건너뛴다
      const sp = new Map(), cov = new Set();
      for (const [r, c, rs, cs] of b.span || []) {
        sp.set(r + ',' + c, [rs, cs]);
        for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) if (i !== r || j !== c) cov.add(i + ',' + j);
      }
      const td = (x, i, j) => {
        if (cov.has(i + ',' + j)) return '';
        const [rs, cs] = sp.get(i + ',' + j) || [1, 1];
        return `<td${rs > 1 ? ` rowspan="${rs}"` : ''}${cs > 1 ? ` colspan="${cs}"` : ''}>${esc(x)}</td>`;
      };
      return `<div class="grid-wrap"><table class="g">${b.v.map((r, i) => '<tr>' + r.map((x, j) => td(x, i, j)).join('') + '</tr>').join('')}</table></div>`;
    }
    const inner = b.v.map(x => x.t === 'img' ? `<img src="data/img/${encodeURIComponent(x.v)}" alt="지문 그림">` : `<div>${esc(x.v)}</div>`).join('');
    return `<div class="psg${b.t === 'given' ? ' given' : ''}">${b.t === 'given' ? '<span class="lbl">주어진 글</span>' : ''}${inner}</div>`;
  }).join('');
}
function choiceBody(q, i) {
  const c = q.ch[i];
  if (Array.isArray(c)) return `<span class="cells" style="grid-template-columns:repeat(${c.length},minmax(0,1fr))">${c.map(x => `<span>${esc(x)}</span>`).join('')}</span>`;
  if (c == null) return `<span class="tx">지문의 ${CIRC[i]}</span>`;
  return `<span class="tx">${esc(c)}</span>`;
}

// 문항 본문. picked가 있으면 채점된 모습(선지별 해설 포함)
function questionHtml(key, q, picked) {
  const unit = DATA[key].conf.units[q.code] || q.code;
  const n = q.n || 4;
  const tbl = q.ch.length && Array.isArray(q.ch[0]);
  const hdr = tbl && q.hdr ? `<div class="cells hdr" style="grid-template-columns:repeat(${q.hdr.length},minmax(0,1fr))">${q.hdr.map(h => `<span>${esc(h)}</span>`).join('')}</div>` : '';
  let opts = '';
  for (let i = 0; i < n; i++) {
    const cls = ['opt'];
    let ex = '';
    if (picked) {
      if (i + 1 === q.a) cls.push('right');
      if (i + 1 === picked) cls.push('picked');
      if (i + 1 === picked && picked !== q.a) cls.push('wrong');
      if (q.ex && q.ex[i]) { const [lab, txt] = exLabel(q.ex[i], i + 1 === q.a); ex = `<div class="ex"><span class="v">${lab}</span>${esc(txt)}</div>`; }
    }
    opts += `<li class="${cls.join(' ')}"><button type="button" data-i="${i + 1}" ${picked ? 'disabled' : ''} aria-label="${i + 1}번">
      <span class="bub">${i + 1}</span>${choiceBody(q, i)}</button>${ex}</li>`;
  }
  let after = '';
  if (picked) {
    const ok = picked === q.a;
    after += `<div class="result ${ok ? 'ok' : 'no'}">${ok ? '맞음' : '틀림'} · 정답 ${CIRC[q.a - 1]}${ok ? '' : ` (고른 답 ${CIRC[picked - 1]})`}</div>`;
    if (q.why) after += `<div class="why"><b>핵심</b> ${esc(q.why)}</div>`;
    if (q.sol) after += solHtml(q.sol);
    if (!q.ex && !q.sol) after += `<div class="noex">이 문항은 해설을 준비 중이에요.</div>`;
  }
  return `<article class="sheet">
      <div class="meta"><span class="area">${esc(q.area)}</span><span>${esc(unit)}</span>
        ${q.lv === '7급' ? '<span class="badge lv7">7급</span>' : ''}${q.gen ? '<span class="badge gen">예상문제</span>' : ''}</div>
      <p class="stem">${esc(q.stem)}</p>
      ${blocksHtml(q.blocks)}
      ${hdr}<ol class="ch">${opts}</ol>
      ${after}
      ${picked ? toolsHtml(q.id, !!(q.ex || q.why || q.sol)) + conceptChips(key, q.id) : ''}
      <div class="meta">${esc(q.src)}</div>
    </article>`;
}
// 영어: 선지별 대신 문항 전체 해설 (핵심 문장 해석 → 풀이 → 오답 → 어휘)
function solHtml(s) {
  // 영어 key = [[원문, 해석]…] / 국어 key = ["지문 근거 문장"…]
  const ko = (s.key || []).some(k => typeof k === 'string');
  const key = (s.key || []).map(k => typeof k === 'string' ? `<p class="kq">${esc(k)}</p>` : `<p class="en">${esc(k[0])}</p><p class="ko">${esc(k[1])}</p>`).join('');
  const voc = (s.voc || []).map(([w, m]) => `<span><i>${esc(w)}</i> ${esc(m)}</span>`).join('');
  return `<div class="sol">
      ${key ? `<div class="sk"><b>${ko ? '근거' : '핵심 문장'}</b>${key}</div>` : ''}
      <div><b>풀이</b><p>${esc(s.exp)}</p></div>
      ${s.wrong ? `<div><b>오답</b><p>${esc(s.wrong)}</p></div>` : ''}
      ${voc ? `<div><b>어휘</b><p class="voc">${voc}</p></div>` : ''}
      ${s.note ? `<div><b>참고</b><p>${esc(s.note)}</p></div>` : ''}
    </div>`;
}
function oxHtml(key, o, picked) {
  const unit = DATA[key].conf.units[o.code] || o.code;
  let after = '';
  if (picked) {
    const ok = (picked === 'O') === o.o;
    after = `<div class="result ${ok ? 'ok' : 'no'}">${ok ? '맞음' : '틀림'} · 이 문장은 ${o.o ? 'O (옳음)' : 'X (옳지 않음)'}</div>
      ${o.ex ? `<div class="why"><b>해설</b> ${esc(exLabel(o.ex)[1])}</div>` : '<div class="noex">해설은 준비 중이에요. 원문 문항에서 다른 선지와 함께 볼 수 있어요.</div>'}
      ${toolsHtml(o.id, !!o.ex, true)}${conceptChips(key, o.q)}`;
  }
  const btn = v => {
    let cls = 'oxb';
    if (picked) { if ((v === 'O') === o.o) cls += ' right'; if (v === picked && (v === 'O') !== o.o) cls += ' wrong'; }
    return `<button class="${cls}" data-ox="${v}" type="button" ${picked ? 'disabled' : ''} aria-label="${v === 'O' ? '옳다' : '옳지 않다'}">${v}</button>`;
  };
  return `<article class="sheet">
      <div class="meta"><span class="area">${esc(o.area)}</span><span>${esc(unit)}</span>${o.lv === '7급' ? '<span class="badge lv7">7급</span>' : ''}</div>
      <p class="topic">${esc(o.topic)}</p>
      <p class="stmt">${esc(o.st)}</p>
      <div class="oxrow">${btn('O')}${btn('X')}</div>
      ${after}
      <div class="meta">${esc(o.src)}</div>
    </article>`;
}
// 해설 머리말('옳음.' '틀림.' '정답.' '오답.')을 라벨로 바꾼다. 없으면 정답 여부로 붙인다.
const EX_LAB = { '옳음': '옳은 설명', '틀림': '틀린 설명', '정답': '정답', '오답': '오답' };
function exLabel(e, isAns) {
  const m = /^(옳음|틀림|정답|오답)\.\s*/.exec(e);
  return m ? [EX_LAB[m[1]], e.slice(m[0].length)] : [isAns ? '정답' : '오답', e];
}
function toolsHtml(id, hasEx, ox) {
  const st = STARS[id] && STARS[id].on, fl = FLAGS[id] && FLAGS[id].on;
  return `<div class="tools">
    ${ox ? '<button class="chip" data-tool="orig" type="button">원문 문항 보기</button>' : `<button class="chip${st ? ' on' : ''}" data-tool="star" type="button">${st ? '★ 저장됨' : '☆ 저장'}</button>`}
    ${hasEx ? `<button class="chip${fl ? ' on' : ''}" data-tool="flag" type="button">${fl ? '해설 신고함' : '해설이 이상해요'}</button>` : ''}
  </div>`;
}

function renderItem() {
  onSyncRefresh = null;
  const { key } = S;
  const it = itemOf(S.cur);
  const prog = S.list ? `${Math.min(S.res.size + (S.picked ? 0 : 1), S.list.length)} / ${S.list.length}` : `이번 ${S.n}문제${S.n ? ` · ${S.ok}개 맞음` : ''}`;
  const title = S.mode === 'unit' || S.mode === 'focus' || S.mode === 'cunit' ? (DATA[key].conf.units[S.code] || S.code) : MODE_NAME[S.mode];
  $app.innerHTML = `<div class="bar">${back(S.ret ? '← 개념' : '← ' + SUBJ[key].name)}<h1 class="sm">${esc(title)}</h1><span class="sub">${prog}</span></div>`
    + (S.list ? `<div class="pdots" aria-hidden="true">${S.list.map((id, j) => { const h = S.res.get(id); return `<i class="${h ? (h.ok ? 'ok' : 'no') : ''}${j === S.idx ? ' cur' : ''}"></i>`; }).join('')}</div>` : '')
    + (S.ox ? oxHtml(key, it, S.picked) : questionHtml(key, it, S.picked));
  on('[data-back]', () => S.ret ? S.ret() : showSubject(key));
  on('.opt>button', b => answer(+b.dataset.i));
  on('[data-ox]', b => answer(b.dataset.ox));
  on('[data-tool]', b => {
    const t = b.dataset.tool;
    if (t === 'star') toggleMap(STARS, 'stars', it.id);
    else if (t === 'flag') toast(toggleMap(FLAGS, 'flags', it.id) ? '신고했어요. 다음에 해설을 고칠 때 모아서 봐요' : '신고를 취소했어요');
    else if (t === 'orig') { showOrig(key, it.q); return; }
    else if (t === 'concept') { showConcept(key, b.dataset.code, b.dataset.cid, renderItem); return; }
    renderItem();
  });
  if (S.picked) {
    const last = S.list && S.list.every(id => S.res.has(id));
    setDock(`<button class="btn primary" id="nx" type="button">${last ? '결과 보기' : '다음'}</button>`);
    document.getElementById('nx').onclick = advance;
  } else setDock('');
}

function answer(v) {
  if (S.picked) return;
  const it = itemOf(S.cur);
  const ok = S.ox ? ((v === 'O') === it.o) : (v === it.a);
  S.picked = v; S.n++; if (ok) S.ok++;
  record(S.key, it, v, ok, performance.now() - S.t0, S.ox);
  if (S.list) S.res.set(it.id, HIST[HIST.length - 1]);
  renderItem();
  const r = document.querySelector('.result');
  if (r) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showOrig(key, qid) {
  const q = DATA[key].byId.get(qid);
  const h = lastById(key).get(qid);
  setDock('');
  $app.innerHTML = `<div class="bar"><button class="icon-btn" data-back type="button">← OX로</button><h1 class="sm">원문 문항</h1></div>`
    + (h ? '' : '<p class="note">아직 이 문항을 풀지 않았어요. 정답과 해설이 같이 보여요.</p>')
    + questionHtml(key, q, h ? h.p : q.a);
  on('[data-back]', renderItem);
  on('[data-tool]', b => {
    if (b.dataset.tool === 'concept') { showConcept(key, b.dataset.code, b.dataset.cid, () => showOrig(key, qid)); return; }
    if (b.dataset.tool === 'star') toggleMap(STARS, 'stars', q.id); else toggleMap(FLAGS, 'flags', q.id); showOrig(key, qid);
  });
  window.scrollTo(0, 0);
}

function showResults() {
  const { key } = S;
  const rows = S.list.map((id, j) => {
    const it = itemOf(id), h = S.res.get(id);
    const label = S.ox ? it.st : it.stem;
    return `<li><button class="rrow" data-j="${j}" type="button"><span class="rk ${h ? (h.ok ? 'ok' : 'no') : ''}">${h ? (h.ok ? 'O' : 'X') : '–'}</span>
      <span class="rt"><span class="rl">${esc(label.replace(/[\x02\x03]/g, '').slice(0, 70))}</span><span class="rs">${esc(it.area)} · ${esc(it.src)}</span></span></button></li>`;
  }).join('');
  const ok = [...S.res.values()].filter(h => h.ok).length;
  const ret = S.ret || (() => showSubject(key));
  setDock(`<button class="btn" id="again" type="button">${S.ret ? '개념 카드로' : SUBJ[key].name + '으로'}</button>`);
  $app.innerHTML = `<div class="bar">${back(S.ret ? '← 개념' : '← ' + SUBJ[key].name)}<h1 class="sm">${MODE_NAME[S.mode]}</h1><span class="sub">${ok} / ${S.list.length} 맞음</span></div>
    <div class="card"><h2>${ok} / ${S.list.length}</h2><p class="note">문항을 누르면 다시 볼 수 있어요.</p></div>
    <ol class="results">${rows}</ol>`;
  on('[data-back]', ret);
  document.getElementById('again').onclick = ret;
  on('.rrow', b => reviewAt(+b.dataset.j));
  window.scrollTo(0, 0);
}
function reviewAt(j) {
  const { key } = S, id = S.list[j], it = itemOf(id), h = S.res.get(id);
  setDock('');
  $app.innerHTML = `<div class="bar"><button class="icon-btn" data-back type="button">← 결과</button><h1 class="sm">${j + 1}번 다시 보기</h1></div>`
    + (S.ox ? oxHtml(key, it, h ? h.p : (it.o ? 'O' : 'X')) : questionHtml(key, it, h ? h.p : it.a));
  on('[data-back]', showResults);
  on('[data-tool]', b => {
    const t = b.dataset.tool;
    if (t === 'concept') { showConcept(key, b.dataset.code, b.dataset.cid, () => reviewAt(j)); return; }
    if (t === 'star') toggleMap(STARS, 'stars', it.id); else if (t === 'flag') toggleMap(FLAGS, 'flags', it.id); else if (t === 'orig') { showOrig(key, it.q); return; }
    reviewAt(j);
  });
  window.scrollTo(0, 0);
}

/* ── 개념 카드 ─────────────────────────────────────────── */
// 카드 문장의 {{…}}는 핵심어. 읽기에서는 밑줄 강조, 가리기에서는 눌러야 보인다.
// 함정 문장의 '→ O / → X'도 가리기에서는 판정을 숨겨 OX처럼 떠올리게 한다.
let CHIDE = false;
function cloze(t, hide) {
  let h = esc(t).replace(/\{\{(.+?)\}\}/g, (_, w) => hide ? `<button class="cz" data-cz type="button" aria-label="가린 낱말 보기">${w}</button>` : `<mark class="cz">${w}</mark>`);
  h = h.replace(/→ (O|X)\b(.*)$/, (_, v, rest) => {
    const tag = `<span class="vd ${v === 'O' ? 'o' : 'x'}">${v}</span>${rest}`;
    return '→ ' + (hide ? `<button class="cz vdz" data-cz type="button" aria-label="판정 보기">${tag}</button>` : tag);
  });
  return h;
}
function conceptChips(key, qid) {
  const con = CON[key]; if (!con) return '';
  const hits = con.byQ.get(qid) || [];
  if (!hits.length) return '';
  return `<div class="tools con-tools"><span class="note">관련 개념</span>${hits.slice(0, 3).map(({ code, c }) =>
    `<button class="chip con" data-tool="concept" data-code="${esc(code)}" data-cid="${esc(c.id)}" type="button">${esc(c.t)}</button>`).join('')}</div>`;
}
function unitIds(key, code) {          // 단원 기출 전부. 안 푼 것·틀린 것이 앞에 오도록 pickUnit 순서로.
  const ex = new Set(), ids = [];
  for (;;) { const q = pickUnit(key, [code], ex); if (!q) break; ex.add(q.id); ids.push(q.id); }
  return ids;
}
async function showConceptList(key) {
  onSyncRefresh = () => showConceptList(key); setDock('');
  const con = await loadConcept(key), d = DATA[key], last = lastById(key);
  const rows = Object.entries(con.units).map(([code, u]) => {
    const ids = d.items.filter(q => q.code === code).map(q => q.id);
    const done = ids.filter(id => last.has(id)), ok = done.filter(id => last.get(id).ok);
    return `<li class="unit"><div class="un"><span class="unm">${esc(u.title)}</span>
        <span class="ust">${esc(u.book)} · 카드 ${u.cards.length}장 · 기출 ${ids.length}문항${done.length ? ` · 정답률 ${pct(ok.length / done.length)}` : ''}</span></div>
      <div class="ubtn"><button class="chip con" data-c="${esc(code)}" type="button">열기</button></div></li>`;
  }).join('');
  $app.innerHTML = bar(back('← ' + SUBJ[key].name), '개념 카드') + `
    <p class="note">${Object.keys(con.units).length}단원 · ${key === 'law' ? '핵심집약으로 개념 읽기 → 카드로 판단 기준·함정 확인 → 단원 기출' : '패스프래소 읽기 → 카드 읽고 메모 한두 줄 → 단원 기출'}. '섞여 나온 것' 카드는 다른 주제인데 이 단원으로 분류된 기출이에요.</p>
    <ul class="units">${rows}</ul>`;
  on('[data-back]', () => showSubject(key));
  on('[data-c]', b => showConcept(key, b.dataset.c, null, () => showConceptList(key)));
  window.scrollTo(0, 0);
}
async function showConcept(key, code, focusId, ret) {
  await load(key); const con = await loadConcept(key);
  const u = con.units[code]; if (!u) { toast('이 단원은 아직 개념 카드가 없어요'); return; }
  ret = ret || (() => showConceptList(key));
  onSyncRefresh = null;
  const d = DATA[key], last = lastById(key);
  const allIds = d.items.filter(q => q.code === code).map(q => q.id);
  const stat = ids => { const done = ids.filter(id => last.has(id)); const ok = done.filter(id => last.get(id).ok).length; return { n: ids.length, done: done.length, ok }; };
  const st = stat(allIds);
  const bookShort = u.book.split('·')[0].trim();
  const steps = u.style === 'unpack'
    ? [`${bookShort} 읽기`, '이 카드 읽고 메모 한두 줄', '단원 기출 풀기']
    : [`${bookShort} 개념 읽기`, '이 카드 2~3분 · 가리기로 확인', '단원 기출 풀기'];
  const cards = u.cards.map(c => {
    const cs = stat(c.q || []);
    const memo = MEMO[c.id] ? MEMO[c.id].v : '';
    const rh = c.tbl && c.tbl.r.every(r => String(r[0] || '').length <= 14);   // 첫 칸이 짧으면 행 머리로
    const tbl = c.tbl ? `<div class="grid-wrap"><table class="ct${c.tbl.h.length > 2 ? ' wide' : ''}"><tr>${c.tbl.h.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${c.tbl.r.map(r => '<tr>' + r.map((x, j) => `<td data-h="${esc(c.tbl.h[j] || '')}"${j === 0 && rh ? ' class="rh"' : ''}>${cloze(x, false)}</td>`).join('') + '</tr>').join('')}</table></div>` : '';
    return `<article class="ccard${c.id === focusId ? ' focus' : ''}" id="cc-${esc(c.id)}">
      <div class="ch-h"><h2>${esc(c.t)}</h2>${cs.n ? `<span class="cnt">기출 ${cs.n}${cs.done ? ` · ${cs.ok}/${cs.done} 맞힘` : ''}</span>` : ''}</div>
      ${c.pts && c.pts.length ? `<ul class="pts">${c.pts.map(p => `<li>${cloze(p, CHIDE)}</li>`).join('')}</ul>` : ''}
      ${tbl}
      ${c.trap && c.trap.length ? `<div class="trap"><b>기출 함정</b><ul>${c.trap.map(p => `<li>${cloze(p, CHIDE)}</li>`).join('')}</ul></div>` : ''}
      ${u.style === 'unpack' ? `<label class="memo"><span>내 메모</span><textarea data-memo="${esc(c.id)}" rows="2" placeholder="내 말로 한두 줄 (모든 기기에 동기화)">${esc(memo)}</textarea></label>` : ''}
      ${cs.n ? `<div class="tools"><button class="chip" data-cq="${esc(c.id)}" type="button">이 개념 기출 ${cs.n}</button><button class="chip" data-cox="${esc(c.id)}" type="button">이 개념 OX</button></div>` : ''}
    </article>`;
  }).join('');
  $app.innerHTML = bar(back('← 뒤로'), esc(u.title.split('(')[0].trim()), esc(bookShort)) + `
    <div class="cintro"><ol class="steps">${steps.map((t, i) => `<li class="${i === 1 ? 'now' : ''}">${esc(t)}</li>`).join('')}</ol>
      <p class="note">${esc(u.intro)}</p></div>
    <div class="seg" role="group" aria-label="보기 방식">
      <button type="button" data-hide="0" aria-pressed="${!CHIDE}">읽기</button>
      <button type="button" data-hide="1" aria-pressed="${CHIDE}">가리고 떠올리기</button></div>
    ${cards}
    <p class="note">카드는 2013~2026 기출에서 실제로 물은 것만 모아 새로 쓴 정리예요. 법 개정은 출제 당시 기준이라, 바뀐 곳은 카드에 따로 적어요.</p>`;
  setDock(`<button class="btn primary" id="cu" type="button">단원 기출 풀기 · ${st.n}문항${st.done ? ` (푼 것 ${st.done})` : ''}</button>`);
  const again = () => showConcept(key, code, null, ret);
  on('[data-back]', ret);
  on('[data-hide]', b => { CHIDE = b.dataset.hide === '1'; const y = window.scrollY; again().then(() => window.scrollTo(0, y)); });
  on('[data-cz]', b => b.classList.toggle('show'));
  on('[data-cq]', b => { const c = con.card.get(b.dataset.cq).c; startSet(key, 'cq', c.q.slice(), code, () => showConcept(key, code, c.id, ret)); });
  on('[data-cox]', async b => {
    const c = con.card.get(b.dataset.cox).c; b.disabled = true;
    const ox = await loadOx(key), qs = new Set(c.q);
    const ids = ox.items.filter(o => qs.has(o.q)).map(o => o.id);
    if (!ids.length) { toast('이 개념은 OX로 쪼갤 수 있는 문장이 없어요'); b.disabled = false; return; }
    startSet(key, 'cox', ids, code, () => showConcept(key, code, c.id, ret));
  });
  $app.querySelectorAll('[data-memo]').forEach(ta => {
    ta.onchange = () => {
      const id = ta.dataset.memo, v = ta.value.trim(), t = Date.now();
      MEMO[id] = { v, t }; store.set('memo', MEMO); emit({ k: 'm', d: { id, v }, t });
      toast(SYNC.code ? '메모를 저장했어요' : '이 기기에만 저장했어요');
    };
  });
  document.getElementById('cu').onclick = () => startSet(key, 'cunit', unitIds(key, code), code, () => showConcept(key, code, null, ret));
  if (focusId) { const el = document.getElementById('cc-' + focusId); if (el) el.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0); }
  else window.scrollTo(0, 0);
}

/* ── 동기화 설정 ───────────────────────────────────────── */
function newCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789', b = new Uint32Array(12);
  crypto.getRandomValues(b);
  const s = [...b].map(x => a[x % a.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
function showSync() {
  onSyncRefresh = showSync; setDock('');
  const when = SYNC.at ? new Date(SYNC.at).toLocaleString('ko-KR') : '아직 없음';
  $app.innerHTML = bar(back(), '기기 동기화') + (SYNC.code ? `
    <div class="card"><h2>동기화 켜짐</h2>
      <p class="note">다른 기기에서도 아래 코드를 입력하면 기록·저장한 문제·오늘의 세트가 합쳐져요. 이 코드를 아는 사람은 기록을 볼 수 있으니 남에게 알려주지 마세요.</p>
      <p class="code" id="code-txt">${esc(SYNC.code)}</p>
      <div class="row-btns"><button class="chip" id="copy" type="button">코드 복사</button><button class="chip" id="now" type="button">지금 동기화</button><button class="chip" id="off" type="button">이 기기에서 끄기</button></div>
      <p class="note">마지막 동기화: ${esc(when)} · 올릴 기록 ${SYNC.outbox.length}건</p>
    </div>` : `
    <div class="card"><h2>처음 쓰는 기기라면</h2>
      <p class="note">새 코드를 만들어요. 그다음 다른 기기에서 이 코드를 입력하면 돼요. 가입이나 로그인은 없어요.</p>
      <div class="row-btns"><button class="chip" id="make" type="button">새 동기화 코드 만들기</button></div>
    </div>
    <div class="card"><h2>다른 기기에서 이미 만들었다면</h2>
      <label class="note" for="code-in">그 기기의 동기화 화면에 있는 코드를 입력하세요.</label>
      <input id="code-in" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="xxxx-xxxx-xxxx">
      <div class="row-btns"><button class="chip" id="join" type="button">연결하기</button></div>
    </div>`);
  on('[data-back]', showHome);
  const g = id => document.getElementById(id);
  if (g('make')) g('make').onclick = async () => { await enableSync(newCode()); showSync(); };
  if (g('join')) g('join').onclick = async () => {
    const c = g('code-in').value.trim().toLowerCase();
    if (c.length < 8) { toast('코드를 다시 확인해 주세요'); return; }
    await enableSync(c); showSync();
  };
  if (g('copy')) g('copy').onclick = () => navigator.clipboard.writeText(SYNC.code).then(() => toast('복사했어요'), () => toast('길게 눌러 복사해 주세요'));
  if (g('now')) g('now').onclick = async () => { await syncNow(true); showSync(); };
  if (g('off')) g('off').onclick = () => { SYNC = { code: '', cursor: 0, outbox: [], at: 0 }; store.set('sync', SYNC); toast('이 기기의 동기화를 껐어요. 기록은 남아 있어요'); showSync(); };
  window.scrollTo(0, 0);
}

/* ── 통계 ──────────────────────────────────────────────── */
async function showStats() {
  onSyncRefresh = showStats;
  await Promise.all(SUBJECTS.map(s => load(s.key)));
  const cls = a => a == null ? '' : a >= .8 ? 'good' : a >= .6 ? 'mid' : 'low';
  const mbar = a => a == null ? '' : `<span class="mbar"><i class="${cls(a)}" style="width:${Math.round(a * 100)}%"></i></span>`;
  const cards = SUBJECTS.map(s => {
    const d = DATA[s.key], hs = histOf(s.key), oxs = histOf(s.key, true);
    if (!hs.length && !oxs.length) return `<div class="card"><h2>${s.name}</h2><p class="note">아직 푼 문제가 없어요.</p></div>`;
    const by = {}, oby = {};
    for (const h of hs) { const a = by[h.r] || (by[h.r] = [0, 0]); a[0]++; if (h.ok) a[1]++; }
    for (const h of oxs) { const a = oby[h.r] || (oby[h.r] = [0, 0]); a[0]++; if (h.ok) a[1]++; }
    const rows = Object.keys(d.conf.blueprint).map(a => {
      const [n, ok] = by[a] || [0, 0], acc = n ? ok / n : null;
      const [on_, ook] = oby[a] || [0, 0];
      return `<tr><td>${esc(a)}</td><td class="n">${Math.round(d.conf.blueprint[a] * 100)}%</td><td class="n">${n && hs.length ? Math.round(n / hs.length * 100) + '%' : '–'}</td><td class="n">${n}</td><td class="n">${pct(acc)} ${mbar(acc)}</td>${s.ox ? `<td class="n">${on_ ? pct(ook / on_) : '–'}</td>` : ''}</tr>`;
    }).join('');
    const cnt = {}, okc = {};
    for (const h of hs) { cnt[h.c] = (cnt[h.c] || 0) + 1; okc[h.c] = (okc[h.c] || 0) + (h.ok ? 1 : 0); }
    const er = errRate(s.key);
    const weak = Object.keys(cnt).filter(c => cnt[c] >= 3).sort((a, b) => er[b] - er[a]).slice(0, 5);
    const weakRows = weak.map(c => `<tr><td>${esc(d.conf.units[c] || c)}</td><td class="n">${cnt[c]}</td><td class="n">${pct(okc[c] / cnt[c])} ${mbar(okc[c] / cnt[c])}</td></tr>`).join('');
    const ms = hs.filter(h => h.d > 0 && h.d < 600000).map(h => h.d);
    const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 1000) : null;
    return `<div class="card"><h2>${s.name}</h2>
      <p class="note">문항 ${hs.length}번 풀이${hs.length ? ` · 정답률 ${pct(hs.filter(h => h.ok).length / hs.length)}` : ''}${avg ? ` · 문항당 평균 ${avg}초` : ''}${oxs.length ? ` · OX ${oxs.length}문장 정답률 ${pct(oxs.filter(h => h.ok).length / oxs.length)}` : ''}</p>
      <div class="tbl-wrap"><table class="st"><tr><th>영역</th><th class="n">목표</th><th class="n">실제</th><th class="n">풀이</th><th class="n">정답률</th>${s.ox ? '<th class="n">OX</th>' : ''}</tr>${rows}</table></div>
      ${weak.length ? `<p class="sec-h" style="margin:4px 0 -6px">약한 단원 (3문제 이상 푼 것 중)</p>
      <div class="tbl-wrap"><table class="st"><tr><th>단원</th><th class="n">풀이</th><th class="n">정답률</th></tr>${weakRows}</table></div>` : ''}
    </div>`;
  }).join('');
  const nStar = Object.values(STARS).filter(v => v.on).length, nFlag = Object.values(FLAGS).filter(v => v.on).length;
  $app.innerHTML = bar(back(), '통계') + cards + `
    <div class="card"><h2>기록 백업</h2>
      <p class="note">${SYNC.code ? '동기화가 켜져 있어서 기록이 서버에도 있어요. 그래도 가끔 파일로 받아 두면 안전해요.' : '기록은 이 기기의 브라우저에만 저장돼요. 동기화를 켜거나 가끔 백업 파일을 저장해 두세요.'}</p>
      <div class="row-btns"><button class="chip" id="exp" type="button">백업 파일 저장</button>
        <label class="chip" for="imp">백업 불러오기</label><input type="file" id="imp" accept="application/json,.json" hidden></div>
      <p class="note">풀이 ${HIST.length}건 · 저장한 문제 ${nStar} · 해설 신고 ${nFlag}</p>
    </div>`;
  setDock('');
  on('[data-back]', showHome);
  document.getElementById('exp').onclick = exportBackup;
  document.getElementById('imp').onchange = e => importBackup(e.target.files[0]);
  window.scrollTo(0, 0);
}

function exportBackup() {
  const data = JSON.stringify({ v: 2, at: new Date().toISOString(), hist: HIST, stars: STARS, flags: FLAGS, daily: DAILY, memo: MEMO });
  const name = '9급문제은행_백업_' + dateKey() + '.json';
  const blob = new Blob([data], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importBackup(f) {
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.hist)) throw new Error();
    const seen = new Set(HIST.map(h => h.id + '@' + h.t));
    let add = 0;
    for (const h of d.hist) if (!seen.has(h.id + '@' + h.t)) { h.u = h.u || uid(); HIST.push(h); HSEEN.add(h.u); add++; emit({ u: h.u, k: 'h', d: h, t: h.t }); }
    HIST.sort((a, b) => a.t - b.t);
    const merge = (dst, src) => { for (const [id, v0] of Object.entries(upgradeMap(src || {}))) if (!dst[id] || v0.t > dst[id].t) dst[id] = v0; };
    merge(STARS, d.stars); merge(FLAGS, d.flags);
    for (const [id, m] of Object.entries(d.memo || {})) if (!MEMO[id] || m.t > MEMO[id].t) MEMO[id] = m;
    store.set('hist', HIST); store.set('stars', STARS); store.set('flags', FLAGS); store.set('memo', MEMO);
    toast(`기록 ${add}건을 합쳤어요`);
    showStats();
  } catch (e) { toast('백업 파일을 읽지 못했어요'); }
}

/* ── 시작 ──────────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
showHome().then(() => syncNow());
