/* 동기화 API + 정적 파일.
   /api/sync 만 이 코드가 처리하고 나머지는 public/ 파일을 그대로 내준다.
   동기화 코드는 저장하지 않는다. SHA-256 해시만 키로 쓴다. */
const MAX_PUSH = 2000, MAX_PULL = 5000;

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function keyOf(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gongsi-bank:' + code));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sync(req, env) {
  const code = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (code.length < 8 || code.length > 128) return json({ error: '동기화 코드는 8자 이상이어야 해요' }, 400);
  let body;
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청' }, 400); }
  const key = await keyOf(code);
  const push = Array.isArray(body.push) ? body.push.slice(0, MAX_PUSH) : [];
  const since = Number.isInteger(body.since) ? body.since : 0;

  const ok = push.filter(e => e && typeof e.u === 'string' && e.u.length <= 64 && typeof e.k === 'string' && e.k.length <= 4
    && e.d !== undefined && Number.isFinite(e.t));
  if (ok.length) {
    const st = env.DB.prepare('INSERT OR IGNORE INTO ev (key, u, k, d, t) VALUES (?1, ?2, ?3, ?4, ?5)');
    for (let i = 0; i < ok.length; i += 100) {
      await env.DB.batch(ok.slice(i, i + 100).map(e => st.bind(key, e.u, e.k, JSON.stringify(e.d).slice(0, 20000), Math.trunc(e.t))));
    }
  }
  const { results } = await env.DB.prepare('SELECT seq, u, k, d, t FROM ev WHERE key = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3')
    .bind(key, since, MAX_PULL).all();
  const items = results.map(r => ({ u: r.u, k: r.k, d: JSON.parse(r.d), t: r.t }));
  const cursor = results.length ? results[results.length - 1].seq : since;
  return json({ items, cursor, more: results.length === MAX_PULL, pushed: ok.length });
}

// 오늘의 세트: 먼저 등록한 기기의 세트만 인정한다(UNIQUE(key, dk) + INSERT OR IGNORE).
// 두 기기가 동시에 눌러도 둘 다 같은 세트를 돌려받는다.
async function daily(req, env) {
  const code = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (code.length < 8 || code.length > 128) return json({ error: '동기화 코드는 8자 이상이어야 해요' }, 400);
  let body;
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청' }, 400); }
  const dk = String(body.dk || '');
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 50) : [];
  if (!/^[a-z]{2,5}\|\d{4}-\d{2}-\d{2}\|(q|ox)$/.test(dk) || !ids.length) return json({ error: '잘못된 세트' }, 400);
  const key = await keyOf(code);
  await env.DB.prepare('INSERT OR IGNORE INTO daily (key, dk, ids, t) VALUES (?1, ?2, ?3, ?4)').bind(key, dk, JSON.stringify(ids), Date.now()).run();
  const row = await env.DB.prepare('SELECT ids, t FROM daily WHERE key = ?1 AND dk = ?2').bind(key, dk).first();
  return json({ dk, ids: JSON.parse(row.ids), t: row.t });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/sync') {
      if (req.method !== 'POST') return json({ error: 'POST만 받아요' }, 405);
      try { return await sync(req, env); } catch (e) { return json({ error: '서버 오류: ' + e.message }, 500); }
    }
    if (url.pathname === '/api/daily') {
      if (req.method !== 'POST') return json({ error: 'POST만 받아요' }, 405);
      try { return await daily(req, env); } catch (e) { return json({ error: '서버 오류: ' + e.message }, 500); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: '없는 주소' }, 404);
    return env.ASSETS.fetch(req);
  },
};
