/* 9급 문제은행 — 한 문제씩 풀고 바로 채점한다.
   출제 규칙은 PC의 bank.py와 같다: 영역 비율(BLUEPRINT) → 급수 비율(LEVEL_MIX)
   → 영역 안에서는 오답률 높은 단원 우선, 최근 N일 안에 푼 문항은 쿨다운. */
'use strict';

const SUBJECTS = [
  { key: 'kor', name: '국어' },
  { key: 'eng', name: '영어' },
  { key: 'law', name: '행정법' },
  { key: 'adm', name: '행정학' },
];
const CIRC = ['①', '②', '③', '④', '⑤'];
const DAY = 864e5;

/* ── 저장 (이 기기의 브라우저) ─────────────────────────────── */
const store = {
  get(k, d) { try { const v = localStorage.getItem('gb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gb.' + k, JSON.stringify(v)); return true; } catch (e) { toast('저장 공간이 부족해 기록하지 못했어요'); return false; } },
};
let HIST = store.get('hist', []);      // [{id, s, c(code), r(area), ok, t, d(ms), p(picked)}]
let FLAGS = store.get('flags', {});    // 해설 신고: {id: t}
let STARS = store.get('stars', {});    // 저장한 문제: {id: t}
const DATA = {};                       // key → {conf, items, byId}

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ── 데이터 ─────────────────────────────────────────────── */
async function load(key) {
  if (DATA[key]) return DATA[key];
  const r = await fetch('data/' + key + '.json');
  if (!r.ok) throw new Error('데이터를 불러오지 못했어요 (' + r.status + ')');
  const d = await r.json();
  d.byId = new Map(d.items.map(q => [q.id, q]));
  DATA[key] = d;
  return d;
}

/* ── 출제 ──────────────────────────────────────────────── */
function histOf(key) { return HIST.filter(h => h.s === key); }

function lastById(key) {
  const m = new Map();
  for (const h of histOf(key)) { const p = m.get(h.id); if (!p || h.t >= p.t) m.set(h.id, h); }
  return m;
}

function errRate(key) {           // 단원별 라플라스 보정 오답률 (bank.py error_rate와 같다)
  const agg = {};
  for (const h of histOf(key)) { const a = agg[h.c] || (agg[h.c] = [0, 0]); a[0]++; if (!h.ok) a[1]++; }
  const out = {};
  for (const k in agg) out[k] = (agg[k][1] + 1) / (agg[k][0] + 2);
  return out;
}

function wpick(arr, w) {
  const tot = w.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return arr[Math.floor(Math.random() * arr.length)];
  let r = Math.random() * tot;
  for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}

function nextQuestion(key, mode, exclude) {
  const d = DATA[key], conf = d.conf;
  const last = lastById(key);
  const now = Date.now();
  let cand;
  if (mode === 'wrong') {
    cand = d.items.filter(q => { const h = last.get(q.id); return h && !h.ok; });
  } else if (mode === 'star') {
    cand = d.items.filter(q => STARS[q.id]);
  } else {
    const cut = now - conf.cooldown * DAY;
    cand = d.items.filter(q => { const h = last.get(q.id); return !h || h.t < cut; });
  }
  cand = cand.filter(q => !exclude.has(q.id));
  if (!cand.length) return null;
  const er = errRate(key);
  const wq = q => (er[q.code] ?? .5) ** 2 + .05;
  if (mode !== 'mix') return wpick(cand, cand.map(wq));

  // 1) 영역: BLUEPRINT 비율. 남은 문항이 없는 영역은 빼고 다시 정규화한다.
  const byArea = {};
  for (const q of cand) (byArea[q.area] || (byArea[q.area] = [])).push(q);
  const areas = Object.keys(conf.blueprint).filter(a => byArea[a]);
  if (!areas.length) return wpick(cand, cand.map(wq));
  const area = wpick(areas, areas.map(a => conf.blueprint[a]));
  let pool = byArea[area];
  // 2) 급수: LEVEL_MIX. 이 영역에 있는 급수만 남겨 정규화한다.
  if (conf.levelMix) {
    const lvs = Object.keys(conf.levelMix).filter(lv => pool.some(q => q.lv === lv));
    if (lvs.length) { const lv = wpick(lvs, lvs.map(l => conf.levelMix[l])); pool = pool.filter(q => q.lv === lv); }
  }
  // 3) 문항: 오답률 높은 단원 우선
  return wpick(pool, pool.map(wq));
}

/* ── 기록 ──────────────────────────────────────────────── */
function record(key, q, picked, ms) {
  HIST.push({ id: q.id, s: key, c: q.code, r: q.area, ok: picked === q.a, t: Date.now(), d: Math.round(ms), p: picked });
  store.set('hist', HIST);
}

function summary(key) {
  const hs = histOf(key);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const today = hs.filter(h => h.t >= today0.getTime());
  const recent = hs.slice(-100);
  const last = lastById(key);
  let wrong = 0; for (const h of last.values()) if (!h.ok) wrong++;
  return {
    total: hs.length, uniq: last.size, today: today.length,
    todayOk: today.filter(h => h.ok).length,
    acc: recent.length ? recent.filter(h => h.ok).length / recent.length : null,
    wrong,
    stars: Object.keys(STARS).filter(id => DATA[key] && DATA[key].byId.has(id)).length,
  };
}

/* ── 화면 도구 ─────────────────────────────────────────── */
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\x02/g, '<u>').replace(/\x03/g, '</u>');
const pct = x => x == null ? '–' : Math.round(x * 100) + '%';
let dock = null;
function setDock(html) {
  if (!dock) { dock = document.createElement('div'); dock.className = 'dock'; document.body.appendChild(dock); }
  dock.hidden = !html; dock.innerHTML = html ? '<div class="in">' + html + '</div>' : '';
  return dock;
}
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

/* ── 홈 ────────────────────────────────────────────────── */
async function showHome() {
  setDock('');
  $app.innerHTML = '<div class="bar"><h1>9급 문제은행</h1><span class="sub">2027 지방직 9급</span></div><div class="loading">불러오는 중…</div>';
  try { await Promise.all(SUBJECTS.map(s => load(s.key))); }
  catch (e) { $app.querySelector('.loading').textContent = e.message + ' — 인터넷 연결을 확인하고 다시 열어 주세요.'; return; }

  const cards = SUBJECTS.map(s => {
    const d = DATA[s.key], m = summary(s.key);
    const cover = d.items.length ? m.uniq / d.items.length : 0;
    return `<button class="subj" data-k="${s.key}" type="button">
      <span class="nm">${s.name}</span>
      <span class="ln">오늘 ${m.today}문제${m.today ? ` · ${m.todayOk}개 맞음` : ''}</span>
      <span class="acc">최근 정답률 <b>${pct(m.acc)}</b></span>
      <span class="meter" aria-hidden="true"><i style="width:${(cover * 100).toFixed(1)}%"></i></span>
      <span class="ln">${m.uniq.toLocaleString()} / ${d.items.length.toLocaleString()}문항 풀어봄</span>
    </button>`;
  }).join('');

  const extra = SUBJECTS.map(s => {
    const m = summary(s.key);
    return `<div class="row-btns" style="align-items:center"><span style="min-width:3.5em;font-weight:600">${s.name}</span>
      <button class="chip" data-k="${s.key}" data-m="wrong" type="button" ${m.wrong ? '' : 'aria-disabled="true"'}>오답 다시 ${m.wrong}</button>
      <button class="chip" data-k="${s.key}" data-m="star" type="button" ${m.stars ? '' : 'aria-disabled="true"'}>저장한 문제 ${m.stars}</button></div>`;
  }).join('');

  $app.innerHTML = `<div class="bar"><h1>9급 문제은행</h1><span class="sub">2027 지방직 9급</span>
      <button class="icon-btn" id="go-stats" type="button">통계</button></div>
    <div class="subjects">${cards}</div>
    <p class="note">과목을 누르면 실제 지방직 출제 비율대로 한 문제씩 나와요. 최근에 푼 문제는 다시 안 나와요(국어·행정법·행정학 60일, 영어 120일).</p>
    <p class="sec-h">다시 보기</p>
    <div class="card" style="gap:8px">${extra}</div>`;
  $app.querySelectorAll('.subj').forEach(b => b.onclick = () => startQuiz(b.dataset.k, 'mix'));
  $app.querySelectorAll('.chip[data-m]').forEach(b => b.onclick = () => { if (b.getAttribute('aria-disabled') !== 'true') startQuiz(b.dataset.k, b.dataset.m); });
  document.getElementById('go-stats').onclick = showStats;
  window.scrollTo(0, 0);
}

/* ── 문제 풀기 ─────────────────────────────────────────── */
let S = null;   // {key, mode, q, picked, t0, seen:Set, n, ok}

async function startQuiz(key, mode) {
  await load(key);
  S = { key, mode, q: null, picked: null, t0: 0, seen: new Set(), n: 0, ok: 0 };
  store.set('last', { key, mode });
  next();
}

function next() {
  const q = nextQuestion(S.key, S.mode, S.seen);
  if (!q) { done(); return; }
  S.q = q; S.picked = null; S.t0 = performance.now(); S.seen.add(q.id);
  renderQ(); window.scrollTo(0, 0);
}

function done() {
  const name = SUBJECTS.find(s => s.key === S.key).name;
  const msg = S.mode === 'mix' ? '쿨다운이 끝난 문제를 모두 풀었어요.' : S.mode === 'wrong' ? '틀린 문제를 모두 다시 풀었어요.' : '저장한 문제를 모두 풀었어요.';
  $app.innerHTML = `<div class="bar"><button class="icon-btn" id="back" type="button">← 과목</button><h1>${name}</h1></div>
    <div class="card"><h2>${msg}</h2><p class="note">이번에 ${S.n}문제 중 ${S.ok}개 맞았어요.</p></div>`;
  document.getElementById('back').onclick = showHome;
  setDock('<button class="btn primary" id="home" type="button">처음으로</button>');
  document.getElementById('home').onclick = showHome;
}

function blocksHtml(blocks) {
  return blocks.map(b => {
    if (b.t === 'text') return `<div class="psg">${esc(b.v)}</div>`;
    if (b.t === 'grid') return `<div class="grid-wrap"><table class="g">${b.v.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('')}</table></div>`;
    const inner = b.v.map(x => x.t === 'img' ? `<img src="data/img/${encodeURIComponent(x.v)}" alt="지문 그림" loading="lazy">` : `<div>${esc(x.v)}</div>`).join('');
    return `<div class="psg${b.t === 'given' ? ' given' : ''}">${b.t === 'given' ? '<span class="lbl">주어진 글</span>' : ''}${inner}</div>`;
  }).join('');
}

function choiceBody(q, i) {
  const c = q.ch[i];
  if (Array.isArray(c)) return `<span class="cells" style="grid-template-columns:repeat(${c.length},minmax(0,1fr))">${c.map(x => `<span>${esc(x)}</span>`).join('')}</span>`;
  if (c == null) return `<span class="tx">지문의 ${CIRC[i]}</span>`;
  return `<span class="tx">${esc(c)}</span>`;
}

function renderQ() {
  const { q, key } = S, d = DATA[key];
  const name = SUBJECTS.find(s => s.key === key).name;
  const unit = d.conf.units[q.code] || q.code;
  const n = q.n || 4;
  const tbl = q.ch.length && Array.isArray(q.ch[0]);
  const hdr = tbl && q.hdr ? `<div class="cells hdr" style="grid-template-columns:repeat(${q.hdr.length},minmax(0,1fr))">${q.hdr.map(h => `<span>${esc(h)}</span>`).join('')}</div>` : '';
  const modeLbl = S.mode === 'wrong' ? '오답 다시' : S.mode === 'star' ? '저장한 문제' : '';
  const picked = S.picked;

  let opts = '';
  for (let i = 0; i < n; i++) {
    const cls = ['opt'];
    let ex = '';
    if (picked) {
      if (i + 1 === q.a) cls.push('right');
      if (i + 1 === picked) cls.push('picked');
      if (i + 1 === picked && picked !== q.a) cls.push('wrong');
      if (q.ex && q.ex[i]) ex = `<div class="ex"><span class="v">${i + 1 === q.a ? '정답' : '오답'}</span>${esc(q.ex[i])}</div>`;
    }
    opts += `<li class="${cls.join(' ')}"><button type="button" data-i="${i + 1}" ${picked ? 'disabled' : ''} aria-label="${i + 1}번">
      <span class="bub">${i + 1}</span>${choiceBody(q, i)}</button>${ex}</li>`;
  }

  let after = '';
  if (picked) {
    const ok = picked === q.a;
    after += `<div class="result ${ok ? 'ok' : 'no'}">${ok ? '맞음' : '틀림'} · 정답 ${CIRC[q.a - 1]}${ok ? '' : ` (고른 답 ${CIRC[picked - 1]})`}</div>`;
    if (q.why) after += `<div class="why"><b>핵심</b> ${esc(q.why)}</div>`;
    if (!q.ex) after += `<div class="noex">이 문항은 선지별 해설을 준비 중이에요.</div>`;
    after += `<div class="tools">
      <button class="chip${STARS[q.id] ? ' on' : ''}" id="star" type="button">${STARS[q.id] ? '★ 저장됨' : '☆ 저장'}</button>
      ${q.ex || q.why ? `<button class="chip${FLAGS[q.id] ? ' on' : ''}" id="flag" type="button">${FLAGS[q.id] ? '해설 신고함' : '해설이 이상해요'}</button>` : ''}
    </div>`;
  }

  $app.innerHTML = `<div class="bar"><button class="icon-btn" id="back" type="button">← 과목</button><h1>${name}</h1>
      <span class="sub">${modeLbl ? modeLbl + ' · ' : ''}이번 ${S.n}문제${S.n ? ` · ${S.ok}개 맞음` : ''}</span></div>
    <article class="sheet">
      <div class="meta"><span class="area">${esc(q.area)}</span><span>${esc(unit)}</span>
        ${q.lv === '7급' ? '<span class="badge lv7">7급</span>' : ''}${q.gen ? '<span class="badge gen">예상문제</span>' : ''}</div>
      <p class="stem">${esc(q.stem)}</p>
      ${blocksHtml(q.blocks)}
      ${hdr}<ol class="ch">${opts}</ol>
      ${after}
      <div class="meta">${esc(q.src)}</div>
    </article>`;

  document.getElementById('back').onclick = showHome;
  $app.querySelectorAll('.opt>button').forEach(b => b.onclick = () => answer(+b.dataset.i));
  const st = document.getElementById('star');
  if (st) st.onclick = () => { if (STARS[q.id]) delete STARS[q.id]; else STARS[q.id] = Date.now(); store.set('stars', STARS); renderQ(); };
  const fl = document.getElementById('flag');
  if (fl) fl.onclick = () => { if (FLAGS[q.id]) delete FLAGS[q.id]; else FLAGS[q.id] = Date.now(); store.set('flags', FLAGS); toast(FLAGS[q.id] ? '신고했어요. 백업 파일에 같이 담겨요' : '신고를 취소했어요'); renderQ(); };

  if (picked) {
    setDock('<button class="btn primary" id="nx" type="button">다음 문제</button>');
    document.getElementById('nx').onclick = next;
  } else setDock('');
}

function answer(i) {
  if (S.picked) return;
  S.picked = i; S.n++; if (i === S.q.a) S.ok++;
  record(S.key, S.q, i, performance.now() - S.t0);
  renderQ();
  const r = document.querySelector('.result');
  if (r) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ── 통계 ──────────────────────────────────────────────── */
async function showStats() {
  await Promise.all(SUBJECTS.map(s => load(s.key)));
  const cls = a => a == null ? '' : a >= .8 ? 'good' : a >= .6 ? 'mid' : 'low';
  const bar = a => a == null ? '' : `<span class="mbar"><i class="${cls(a)}" style="width:${Math.round(a * 100)}%"></i></span>`;
  const cards = SUBJECTS.map(s => {
    const d = DATA[s.key], hs = histOf(s.key);
    if (!hs.length) return `<div class="card"><h2>${s.name}</h2><p class="note">아직 푼 문제가 없어요.</p></div>`;
    const by = {};
    for (const h of hs) { const a = by[h.r] || (by[h.r] = [0, 0]); a[0]++; if (h.ok) a[1]++; }
    const rows = Object.keys(d.conf.blueprint).map(a => {
      const [n, ok] = by[a] || [0, 0];
      const acc = n ? ok / n : null;
      return `<tr><td>${esc(a)}</td><td class="n">${Math.round(d.conf.blueprint[a] * 100)}%</td><td class="n">${n ? Math.round(n / hs.length * 100) + '%' : '–'}</td><td class="n">${n}</td><td class="n">${pct(acc)} ${bar(acc)}</td></tr>`;
    }).join('');
    const er = errRate(s.key), cnt = {}, okc = {};
    for (const h of hs) { cnt[h.c] = (cnt[h.c] || 0) + 1; okc[h.c] = (okc[h.c] || 0) + (h.ok ? 1 : 0); }
    const weak = Object.keys(er).filter(c => cnt[c] >= 3).sort((a, b) => er[b] - er[a]).slice(0, 5);
    const weakRows = weak.map(c => `<tr><td>${esc(d.conf.units[c] || c)}</td><td class="n">${cnt[c]}</td><td class="n">${pct(okc[c] / cnt[c])} ${bar(okc[c] / cnt[c])}</td></tr>`).join('');
    const ms = hs.filter(h => h.d > 0 && h.d < 600000).map(h => h.d);
    const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 1000) : null;
    return `<div class="card"><h2>${s.name}</h2>
      <p class="note">${hs.length}번 풀이 · 전체 정답률 ${pct(hs.filter(h => h.ok).length / hs.length)}${avg ? ` · 문항당 평균 ${avg}초` : ''}</p>
      <div class="tbl-wrap"><table class="st"><tr><th>영역</th><th class="n">목표</th><th class="n">실제</th><th class="n">풀이</th><th class="n">정답률</th></tr>${rows}</table></div>
      ${weak.length ? `<p class="sec-h" style="margin:4px 0 -6px">약한 단원 (3문제 이상 푼 것 중)</p>
      <div class="tbl-wrap"><table class="st"><tr><th>단원</th><th class="n">풀이</th><th class="n">정답률</th></tr>${weakRows}</table></div>` : ''}
    </div>`;
  }).join('');

  $app.innerHTML = `<div class="bar"><button class="icon-btn" id="back" type="button">← 처음</button><h1>통계</h1></div>
    ${cards}
    <div class="card"><h2>기록 백업</h2>
      <p class="note">기록은 이 기기의 브라우저에만 저장돼요. 아이폰과 아이패드는 기록이 따로 쌓이고, 앱을 지우면 기록도 사라져요. 가끔 백업 파일을 저장해 두세요.</p>
      <div class="row-btns"><button class="chip" id="exp" type="button">백업 파일 저장</button>
        <label class="chip" for="imp">백업 불러오기</label><input type="file" id="imp" accept="application/json,.json" hidden></div>
      <p class="note">풀이 ${HIST.length}건 · 저장한 문제 ${Object.keys(STARS).length} · 해설 신고 ${Object.keys(FLAGS).length}</p>
    </div>`;
  setDock('');
  document.getElementById('back').onclick = showHome;
  document.getElementById('exp').onclick = exportBackup;
  document.getElementById('imp').onchange = e => importBackup(e.target.files[0]);
  window.scrollTo(0, 0);
}

function exportBackup() {
  const data = JSON.stringify({ v: 1, at: new Date().toISOString(), hist: HIST, stars: STARS, flags: FLAGS });
  const blob = new Blob([data], { type: 'application/json' });
  const name = '9급문제은행_백업_' + new Date().toISOString().slice(0, 10) + '.json';
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
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
    // 합친다: 같은 (문항, 시각) 기록은 하나만 남긴다. 다른 기기 기록을 가져올 때도 쓴다.
    const seen = new Set(HIST.map(h => h.id + '@' + h.t));
    let add = 0;
    for (const h of d.hist) if (!seen.has(h.id + '@' + h.t)) { HIST.push(h); add++; }
    HIST.sort((a, b) => a.t - b.t);
    Object.assign(STARS, d.stars || {}); Object.assign(FLAGS, d.flags || {});
    store.set('hist', HIST); store.set('stars', STARS); store.set('flags', FLAGS);
    toast(`기록 ${add}건을 합쳤어요`);
    showStats();
  } catch (e) { toast('백업 파일을 읽지 못했어요'); }
}

/* ── 시작 ──────────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
showHome();
