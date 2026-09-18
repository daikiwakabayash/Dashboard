// ── 組織図: 自己紹介の項目 ──────────────────────────────────────────────
// 「ひとこと」「得意なこと・相談できること」「学びたいこと」「趣味・好きなこと」を
// セラピスト本人が気軽に書けるようにする。
//
// ⚠️ 設計方針
//   - **氏名・所属・役割・社員IDはここで扱わない。** それらは既存の正本（SalonOne）に紐づく。
//     本人が自由に書き換えられる項目にしない。
//   - 写真も自己紹介も**任意**。空でも成立する。写真が無い人はイニシャルで統一する
//     （仮の生成顔を本人写真として使わない）。
//   - 複数店舗に所属していても staff_id で1人にまとめる。
//   - 検索は名前・店舗に加えて、得意分野・趣味でも当たるようにする。
//
// tests/profile-fields.test.js でカバー。

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

export const TAG_MAX = 8;          // 1項目あたりのタグ数
export const TAG_LEN = 24;         // タグ1件の長さ
export const ONELINE_LEN = 60;     // ひとこと

// 入力例（画面に出す候補。押すだけで入れられるようにする）
export const TAG_SUGGESTIONS = {
  goodAt: ['骨盤矯正', '猫背・姿勢', '産後ケア', '肩こり', '腰痛', 'スポーツ障害', '自律神経',
    '問診・カウンセリング', '新人教育', '予約管理', 'SNS発信', '店販提案'],
  learning: ['解剖学', '栄養', 'トレーニング指導', 'マーケティング', '店舗運営', '数字の読み方',
    '接客英語', '動画編集', 'AI活用'],
  hobbies: ['筋トレ', 'サウナ', 'キャンプ', '登山', '釣り', 'ゴルフ', 'サッカー', '野球', 'ランニング',
    '料理', 'カフェ巡り', '旅行', '映画', '読書', '音楽', 'ゲーム', 'ペット', 'カメラ'],
};

// タグ配列を整える。空・重複・長すぎ・多すぎを落とす。
export function normalizeTags(v) {
  const out = [], seen = new Set();
  for (const raw of arr(v)) {
    const t = str(raw).replace(/[　\s]+/g, ' ').trim().slice(0, TAG_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(t);
    if (out.length >= TAG_MAX) break;
  }
  return out;
}

/**
 * 自己紹介の項目だけを取り出して整える。
 * ⚠️ 氏名・所属・役割・社員IDは**受け取らない**（正本を本人が書き換えられないようにする）。
 */
export function normalizeIntro(p) {
  const src = (p && typeof p === 'object') ? p : {};
  return {
    oneLine: str(src.oneLine).replace(/[\r\n]+/g, ' ').trim().slice(0, ONELINE_LEN),
    goodAt: normalizeTags(src.goodAt),
    learning: normalizeTags(src.learning),
    hobbies: normalizeTags(src.hobbies),
  };
}

// 何か書かれているか（空のカードに「未記入」と出すため）
export function hasIntro(p) {
  const i = normalizeIntro(p);
  return !!(i.oneLine || i.goodAt.length || i.learning.length || i.hobbies.length);
}

// 写真が無い人のイニシャル。⚠️ 生成顔は使わない。
export function initialOf(name) {
  const n = str(name).replace(/[　\s]+/g, '').trim();
  return n ? n.charAt(0) : '?';
}

/**
 * 検索に使う文字列。名前・店舗・得意分野・学びたいこと・趣味・ひとことを対象にする。
 * 全角半角・カタカナ／ひらがな・大文字小文字の違いを吸収する。
 */
export function searchNorm(s) {
  return str(s).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　]/g, '');
}

export function searchHay(person, profile) {
  const p = person || {}; const i = normalizeIntro(profile);
  return searchNorm([
    p.name, p.nameKana, p.shop, ...arr(p.shops),
    i.oneLine, ...i.goodAt, ...i.learning, ...i.hobbies,
  ].filter(Boolean).join(' '));
}

/** 検索語で絞り込む。空なら全員。 */
export function filterPeople(people, query, profileOf) {
  const q = searchNorm(query);
  if (!q) return arr(people);
  const get = typeof profileOf === 'function' ? profileOf : () => null;
  return arr(people).filter(p => searchHay(p, get(p)).includes(q));
}

/**
 * 複数店舗に所属していても1人にまとめる（staff_id で集約）。
 * ⚠️ 売上の有無を在籍の条件にしない。名簿にいれば在籍として扱う。
 */
export function mergeByStaffId(rows) {
  const map = new Map();
  for (const r of arr(rows)) {
    const id = str(r && r.id);
    if (!id) continue;
    const shop = str(r.shop);
    if (!map.has(id)) {
      map.set(id, { id, name: str(r.name), nameKana: str(r.nameKana), role: str(r.role), shops: shop ? [shop] : [] });
      continue;
    }
    const cur = map.get(id);
    if (shop && !cur.shops.includes(shop)) cur.shops.push(shop);
    if (!cur.name && r.name) cur.name = str(r.name);
  }
  return [...map.values()].map(p => ({ ...p, shop: p.shops[0] || '' }));
}

/**
 * 自己紹介を編集してよいか。
 *   actor: { id, role, verified }（サーバーが確かめた本人）
 * 本人か、本部の管理者（root / admin）だけ。
 * ⚠️ クライアントの申告（body.root など）を根拠にしない。
 */
export function canEditProfile(actor, pid) {
  const a = actor || {};
  if (a.verified !== true) return false;
  if (['root', 'admin'].includes(str(a.role))) return true;
  return !!str(a.id) && str(a.id) === str(pid);
}
