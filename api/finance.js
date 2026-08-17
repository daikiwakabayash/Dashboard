// ── 財務(Finance) 統合ディスパッチャ ────────────────────────────
// Vercel Hobbyの関数数上限(12)対策で、finance系の2ハンドラを1関数に集約。
// 実体は lib/handlers/ に分離。旧URLは vercel.json の rewrites で振り分け:
//   /api/finance-chat → /api/finance?fn=chat（既定）
//   /api/finance-pdf  → /api/finance?fn=pdf
// finance-pdf は大きめのbodyを受けるため bodyParser 上限を引き上げる。
import chatHandler from '../lib/handlers/finance-chat.js';
import pdfHandler from '../lib/handlers/finance-pdf.js';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};

export default function handler(req, res) {
  const fn = (req.query && req.query.fn) || 'chat';
  if (fn === 'pdf') return pdfHandler(req, res);
  return chatHandler(req, res);
}
