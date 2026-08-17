// ── GAS系 統合ディスパッチャ ────────────────────────────────────
// Vercel Hobbyの関数数上限(12)対策で、GASプロキシと顧客DBを1関数に集約。
// 実体は lib/handlers/ に分離。旧URLは vercel.json の rewrites で振り分け:
//   /api/gas-proxy → /api/gas?fn=proxy（既定）
//   /api/customers → /api/gas?fn=customers
import proxyHandler from '../lib/handlers/gas-proxy.js';
import customersHandler from '../lib/handlers/customers.js';

export default function handler(req, res) {
  const fn = (req.query && req.query.fn) || 'proxy';
  if (fn === 'customers') return customersHandler(req, res);
  return proxyHandler(req, res);
}
