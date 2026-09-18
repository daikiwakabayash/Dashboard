// 擬似KV：Upstash REST の EVAL / MGET を、本番と同じ意味で再現する最小実装。
// ⚠️ これは **擬似KV** であり、実Redis や本番KV の代わりにはならない。
//    Lua を実際に走らせていないので、スクリプトを変えたらここも合わせて直すこと。
//    「擬似KVで通った」と「実Redisで通った」は必ず区別して報告する。
export function kvEvalFake(store, cmd) {
  if (cmd[0] === 'MGET') return { result: cmd.slice(1).map(k => (store.has(k) ? store.get(k) : null)) };
  if (cmd[0] !== 'EVAL') return null;
  const script = cmd[1], key = cmd[3], args = cmd.slice(4);
  if (script.includes('tonumber(m[k])')) {            // 既読の単調更新
    let m = {};
    try { m = JSON.parse(store.get(key) || '{}') || {}; } catch { m = {}; }
    const k = args[0], t = Number(args[1]);
    if (t > (Number(m[k]) || 0)) m[k] = t;
    store.set(key, JSON.stringify(m));
    return { result: 1 };
  }
  if (script.includes('curv~=tonumber')) {            // compare-and-set（版が合わなければ書かない）
    let curv = 0;
    try { const d = JSON.parse(store.get(key) || 'null'); if (d && d._v) curv = Number(d._v) || 0; } catch {}
    if (curv !== Number(args[0])) return { result: -1 };
    store.set(key, args[1]);
    return { result: 1 };
  }
  if (script.includes('arr[#arr+1]')) {               // 配列への原子的追記＋cap
    let arr = [];
    try { arr = JSON.parse(store.get(key) || '[]') || []; } catch { arr = []; }
    arr.push(JSON.parse(args[0]));
    const cap = Number(args[1]);
    if (arr.length > cap) arr = arr.slice(-cap);
    store.set(key, JSON.stringify(arr));
    return { result: arr.length };
  }
  return null;
}
