// ── Square 統合ディスパッチャ ───────────────────────────────────
// Vercel Hobbyの関数数上限(12)対策で、Square系の3ハンドラを1関数に集約。
// 実体は lib/handlers/ に分離。旧URLは vercel.json の rewrites で振り分け:
//   /api/square/metrics    → /api/square?fn=metrics（既定）
//   /api/square/settlement → /api/square?fn=settlement
//   /api/square/test       → /api/square?fn=test
import metricsHandler from '../lib/handlers/square-metrics.js';
import settlementHandler from '../lib/handlers/square-settlement.js';
import testHandler from '../lib/handlers/square-test.js';

export default function handler(req, res) {
  const fn = (req.query && req.query.fn) || 'metrics';
  if (fn === 'settlement') return settlementHandler(req, res);
  if (fn === 'test') return testHandler(req, res);
  return metricsHandler(req, res);
}
