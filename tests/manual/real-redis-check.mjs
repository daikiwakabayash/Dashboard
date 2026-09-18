// 実Redis（擬似KVではない）で、@AI の原子的処理を確認する手動チェック。
//   前提: ローカルに redis-server が動いていること（本番KVには接続しない）。
//   使い方: redis-server --port 6399 --daemonize yes && node tests/manual/real-redis-check.mjs
// ⚠️ 本番データには一切触れない。専用DBをflushして使う。
import http from 'node:http';
import net from 'node:net';
import handler from '../../api/plan-store.js';
import { hashOwnerToken } from '../../lib/settlement.js';

const REDIS_PORT = Number(process.env.REDIS_PORT || 6399);
const BRIDGE_PORT = 8791;

// ── 最小 RESP クライアント（実Redisへ本物のコマンドを送る）──
function redisCmd(args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(REDIS_PORT, '127.0.0.1');
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('connect', () => {
      let out = `*${args.length}\r\n`;
      for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
      sock.write(out);
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const s = buf.toString();
      if (s.startsWith('$-1\r\n')) { sock.end(); return resolve(null); }
      if (s.startsWith('+') || s.startsWith(':') || s.startsWith('-')) {
        if (s.includes('\r\n')) { sock.end(); return resolve(s.slice(1, s.indexOf('\r\n'))); }
      }
      if (s.startsWith('$')) {
        const head = s.indexOf('\r\n'); const len = Number(s.slice(1, head));
        if (head >= 0 && Buffer.byteLength(s) >= head + 2 + len + 2) {
          sock.end(); return resolve(s.slice(head + 2, head + 2 + len));
        }
      }
    });
  });
}

// ── Upstash REST 互換ブリッジ（/get/:key, /set/:key, POST [cmd...]）──
const bridge = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (req.url.startsWith('/get/')) return send({ result: await redisCmd(['GET', decodeURIComponent(req.url.slice(5))]) });
    if (req.url.startsWith('/set/')) return send({ result: await redisCmd(['SET', decodeURIComponent(req.url.slice(5)), body]) });
    const cmd = JSON.parse(body);                     // ['EVAL', script, '1', key, ...args] / ['MGET', ...]
    return send({ result: await redisCmd(cmd) });
  } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
});

const mockRes = () => { const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; };
const ROOT = () => ({ host: 'test.local', 'x-cc-owner': '__root__',
  'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const call = async (req) => { const res = mockRes(); await handler({ headers: { host: 'test.local' }, query: {}, body: {}, ...req }, res); return res; };
const ask = (over = {}) => call({ method: 'POST', headers: ROOT(),
  body: { type: 'chatai', action: 'ask', question: '家族施術のルールは？', room_id: 'g_trial', request_id: 'r', ...over } });

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? '  OK  ' : '  NG  '} ${name}${detail ? '  ' + detail : ''}`); };

async function main() {
  await new Promise(r => bridge.listen(BRIDGE_PORT, '127.0.0.1', r));
  await redisCmd(['SELECT', '0']);
  await redisCmd(['FLUSHDB']);                 // ⚠️ ローカル検証用DBのみ

  process.env.KV_REST_API_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
  process.env.KV_REST_API_TOKEN = 'local-not-a-secret';
  process.env.VERCEL_ENV = 'preview';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  delete process.env.ANTHROPIC_API_KEY;        // ← 実AIは呼ばない。sample 回答で確認する

  const set = (k, v) => redisCmd(['SET', k, JSON.stringify(v)]);
  const reset = async () => {
    await redisCmd(['FLUSHDB']);
    await set('naoru:cc:flags:v1:preview', { cc_all: true, cc_ai_trial: true, cc_authz: 'off' });
    await set('naoru:chatai:cfg:v1:preview', { trialRooms: ['g_trial'], allowedDocIds: ['faq1'] });
    await set('naoru:chat:v1', { rooms: [{ id: 'g_trial', kind: 'group', name: '検証用', members: ['__root__'] }], dir: { staff: [] }, notes: {} });
    await set('naoru:faq:v1', { faqs: [{ id: 'faq1', q: '家族施術のルールは？', a: '事前申請が必要です。', updatedAt: '2026-09-12T00:00:00Z' }] });
  };
  const aiStore = async () => JSON.parse((await redisCmd(['GET', 'naoru:chatai:v1:preview'])) || '{}');
  const msgs = async () => JSON.parse((await redisCmd(['GET', 'naoru:chat:m:g_trial'])) || '[]');

  console.log(`\n実Redis ${REDIS_PORT} に対する確認（擬似KVではない）\n`);

  await reset();
  await Promise.all([ask({ request_id: 'same' }), ask({ request_id: 'same' })]);
  let st = await aiStore(), m = await msgs();
  check('(1) 同じ request_id の同時実行で回答が重複しない',
    m.filter(x => x.fromStaffId === '__ai__').length === 1 && Object.keys(st.answers || {}).length === 1,
    `AI回答=${m.filter(x => x.fromStaffId === '__ai__').length}件`);

  await reset();
  await Promise.all([ask({ request_id: 'a', question: 'Aの質問' }), ask({ request_id: 'b', question: 'Bの質問' })]);
  st = await aiStore(); m = await msgs();
  check('(2) 別質問の同時実行でどちらの回答も消えない',
    Object.keys(st.answers || {}).length === 2 && m.filter(x => x.fromStaffId === '__ai__').length === 2,
    `回答=${Object.keys(st.answers || {}).length}件 / メッセージ=${m.length}件`);

  await reset();
  const first = await ask({ request_id: 'base' });
  const aid = first.body.answer_message_id;
  await Promise.all([
    ask({ request_id: 'during', question: '別の質問' }),
    call({ method: 'POST', headers: ROOT(), body: { type: 'chatai', action: 'correct', answer_message_id: aid, text: '本部の訂正' } }),
  ]);
  st = await aiStore();
  check('(3) 生成中の本部訂正が回答保存で消えない',
    (st.corrections[aid] || []).some(c => c.text === '本部の訂正') && Object.keys(st.answers).length === 2,
    `訂正=${(st.corrections[aid] || []).length}件 / 回答=${Object.keys(st.answers).length}件`);

  await reset();
  const stop = (async () => { await new Promise(r => setTimeout(r, 5));
    await set('naoru:cc:flags:v1:preview', { cc_all: true, cc_ai_trial: false, cc_authz: 'off' }); })();
  const [stopped] = await Promise.all([ask({ request_id: 'stop' }), stop]);
  m = await msgs();
  check('(4) 生成中に OFF にすると投稿されない',
    stopped.body.ok === false && m.filter(x => x.fromStaffId === '__ai__').length === 0,
    `code=${stopped.body.error && stopped.body.error.code}`);

  await reset();
  const one = await ask({ request_id: 'replay' });
  const again = await ask({ request_id: 'replay' });
  check('(5) 同じ依頼IDの再試行は同じ answer_message_id（回答が増えない）',
    again.body.replay === true && again.body.answer_message_id === one.body.answer_message_id
      && (await msgs()).filter(x => x.fromStaffId === '__ai__').length === 1);

  await reset();
  const r20 = await Promise.all(Array.from({ length: 20 }, (_, i) => ask({ request_id: `bulk_${i}`, question: `質問${i}` })));
  st = await aiStore(); m = await msgs();
  check('(6) 20件同時でも取りこぼさない（実Redisの競合下）',
    r20.every(r => r.body.ok) && Object.keys(st.answers).length === 20 && m.filter(x => x.fromStaffId === '__ai__').length === 20,
    `成功=${r20.filter(r => r.body.ok).length}/20 回答=${Object.keys(st.answers).length} メッセージ=${m.length}`);

  check('(7) 実AIは呼んでいない（ANTHROPIC_API_KEY 未設定＝sample 回答）',
    String(one.body.mode) === 'sample', `mode=${one.body.mode}`);

  await redisCmd(['FLUSHDB']);
  bridge.close();
  const ng = results.filter(r => !r.pass);
  console.log(`\n${results.length - ng.length}/${results.length} OK`);
  process.exit(ng.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
