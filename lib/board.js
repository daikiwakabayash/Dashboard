// ── 掲示板（全社発信）ロジック（純粋関数） ──────────────────────────────
// 本部→全体 / スタッフ→全体 のお知らせを1つのフィードに集約する社内掲示板。
// リンク・画像・ファイル・動画(URL埋め込み)に対応。保存は api/plan-store.js（?type=board）。
// tests/board.test.js でカバー。
//
// データモデル（共有ストア blob = naoru:board:v1）:
//   posts: [{ id, authorId, authorName, authorShop, text, links:[], imgIds:[],
//             files:[{id,name,type,size}], videoUrl, pinned, createdAt }]
//   reads: { [staffId]: lastSeenMs }   // 既読（この時刻より後＝新着）
//   画像は chat と同じ別キー保存（naoru:chat:img:<id>）、ファイルは naoru:board:file:<id>

// 新着件数（lastSeenMs より後に投稿された、自分以外の投稿）。ピン留めは新着判定に含めない。
export function boardUnread(posts, lastSeenMs, myStaffId) {
  const last = Number(lastSeenMs) || 0;
  const mine = String(myStaffId || '');
  return (Array.isArray(posts) ? posts : []).reduce((n, p) => {
    if (!p) return n;
    const t = Date.parse(p.createdAt || '') || 0;
    return (t > last && String(p.authorId) !== mine) ? n + 1 : n;
  }, 0);
}

// 表示順: ピン留めを先頭、その後 createdAt 降順。
export function sortPosts(posts) {
  return (Array.isArray(posts) ? posts : []).slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0);
  });
}

// テキストからURLを抽出（http/https・重複除去・最大10件）。lib/chat.js と同仕様。
export function extractLinks(text) {
  const re = /https?:\/\/[^\s<>"'）)】」]+/g;
  const found = String(text || '').match(re) || [];
  const seen = new Set(); const out = [];
  for (const u of found) {
    const url = u.replace(/[.,、。]+$/, '');
    if (!seen.has(url)) { seen.add(url); out.push(url); }
    if (out.length >= 10) break;
  }
  return out;
}

// 動画URL → 埋め込み情報。YouTube/Vimeo は iframe、その他の直リンク(.mp4等)は video タグ。
// 返り値: { kind:'youtube'|'vimeo'|'file'|'link', embedUrl?, src? } または null。
export function videoEmbed(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  let m;
  if ((m = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/))) {
    return { kind: 'youtube', embedUrl: `https://www.youtube.com/embed/${m[1]}` };
  }
  if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/))) {
    return { kind: 'vimeo', embedUrl: `https://player.vimeo.com/video/${m[1]}` };
  }
  if (/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(u)) return { kind: 'file', src: u };
  return { kind: 'link', src: u };
}

// 決定的でない一意ID（時刻＋乱数）。
export function genId(prefix = 'p') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
