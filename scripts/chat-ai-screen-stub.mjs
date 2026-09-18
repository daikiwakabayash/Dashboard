// 本番画面（index.html）を動かすための最小スタブAPI。
// ⚠️ 本番には一切触れません。画面が「何を送るか」を観測するためだけのものです。
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = '/home/user/Dashboard';
export const calls = [];
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };
const ROOMS = { g_trial: '本部/root 検証ルーム（試用）', g_trial2: '本部 AI 検証ルーム2' };
const FAQS  = { faq_family: '家族施術制度', faq_shift: 'シフト提出ルール' };
const state = { answers: {}, order: [], seq: 0, byReq: {} };

const json = (res, o) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(o)); };

export function start(port = 8961) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
      const p = url.pathname;
      if (p.startsWith('/api/')) calls.push({ path: p, query: Object.fromEntries(url.searchParams), body, method: req.method });

      if (p === '/api/settlement-auth') {
        if (req.method === 'GET') return json(res, { ok: true, shops: {} });
        if (body.action === 'login') return json(res, { ok: true, token: 'stub-root-token', owner: '__root__', root: true, role: 'root' });
        if (body.action === 'verify') return json(res, { ok: true, owner: '__root__', root: true, role: 'root' });
        return json(res, { ok: true });
      }
      if (p === '/api/plan-store') {
        const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
        const action = req.method === 'GET' ? url.searchParams.get('action') : body.action;
        if (type === 'ccflags') return json(res, { ok: true, configured: true,
          flags: { cc_all: true, cc_ai_trial: true, cc_authz: 'on', env: 'preview', configured: true } });
        if (type === 'chatai') {
          if (action === 'config') return json(res, { ok: true, enabled: true,
            config: { trialRooms: Object.keys(ROOMS), allowedDocIds: Object.keys(FAQS),
                      // ①が名前を返せるようにした場合に画面が使える形（②の提案）
                      trialRoomNames: ROOMS, allowedDocTitles: FAQS } });
          if (action === 'ask') {
            const rid = String(body.request_id || '');
            if (state.byReq[rid]) return json(res, { ok: true, replay: true, answer_message_id: state.byReq[rid], room_id: body.room_id });
            const aid = `a_stub_${++state.seq}`;
            state.byReq[rid] = aid;
            state.answers[aid] = { body: `［サンプル回答］${body.question}`, mode: 'sample',
              sources: { verification: 'none', verified: [], candidates: [] },
              questionMessageId: `m_stub_${state.seq}`, corrections: [], hq_review: null };
            state.order.push(aid);
            return json(res, { ok: true, answer_message_id: aid, question_message_id: `m_stub_${state.seq}`, room_id: body.room_id, mode: 'sample' });
          }
          if (action === 'get') return json(res, { ok: true, room_id: body.room_id, answers: state.answers });
          if (action === 'hq_review') { const a = state.answers[body.answer_message_id]; if (a) a.hq_review = { status:'pending', notified:false, channel:'not_connected' }; return json(res, { ok: true, created: true }); }
          if (action === 'correct') { const a = state.answers[body.answer_message_id]; if (a) a.corrections = [...(a.corrections||[]), { id:`c${Date.now()}`, text: body.text, byName:'本部', at:new Date().toISOString(), knowledgeStatus:'approval_candidate' }]; return json(res, { ok: true }); }
        }
        return json(res, { ok: true });
      }
      // 経営データ系は最小の成功形を返す（ダッシュボードがエラー画面に落ちないように）
      if (p.startsWith('/api/gas') || p.startsWith('/api/customers')) return json(res, { success: true, data: [] });
      if (p.startsWith('/api/square')) return json(res, { success: true, accounts: [], data: [] });
      if (p.startsWith('/api/salonone')) return json(res, { data: [], meta: {} });
      if (p.startsWith('/api/')) return json(res, { ok: true, success: true, data: [] });

      const f = path.join(ROOT, decodeURIComponent(p === '/' ? '/index.html' : p));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
      res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
      res.end(fs.readFileSync(f));
    });
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}
export const reset = () => { state.answers = {}; state.order = []; state.seq = 0; state.byReq = {}; calls.length = 0; };
