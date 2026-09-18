// ── 宛先をテキストで指定する ────────────────────────────────────────────
// 「鶴見と関内に以下の文章を送ってほしい」
// 「若林と佐藤（本部の佐藤）、あと八代、怜、透子、田中（新宿の田中）」
// のような書き方から、実在のスタッフを割り出す。
//
// ⚠️ 設計方針
//   - **勝手に送らない。** 曖昧なものは「候補」として返し、人が選ぶまで宛先に入れない。
//   - **見つからなかった言葉は必ず返す。** 黙って無視すると、届いたつもりの人が出る。
//   - 判定は決め打ちの規則だけで行う（AIに推測させない）。同じ入力なら必ず同じ結果。
//   - 店舗・エリアの判定は lib/audience.js / lib/geo.js をそのまま使う（表を増やさない）。
//
// tests/recipients.test.js でカバー。

import { areaOf, PREF_NAMES } from './audience.js';
import { regionOf } from './geo.js';
import { storeRoomId } from './chat.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v == null ? '' : v);

// 補足「（本部の佐藤）」を一時的に置き換える印。入力に現れない形にする。
const HINT_OPEN = '@@h';
const HINT_CLOSE = 'h@@';

// 全角英数→半角、空白の統一、前後の空白落とし
export function normalize(s) {
  return str(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[　\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

// 照合用の形。店舗名の飾り（NAORU / 院）と敬称・空白を落とす。
export function matchKey(s) {
  return normalize(s)
    .replace(/NAORU/gi, '')
    .replace(/院$/, '')
    .replace(/(さん|くん|ちゃん|様|さま|氏)$/, '')
    .replace(/ /g, '')
    .toLowerCase();
}

// 宛先ではない言い回し。⚠️ 切り出しの前に落とす。
//    残すと「関内に送って」の“に送って”まで名前として扱われる。
const ACTION_PATTERNS = [
  /(で|に|へ|を)?グループ(を)?(組|作|つく)[んりっるってら]*(で|て)?(ほし[いく]|下さい|ください)?/g,
  /(に|へ)?(以下|下記|この|次|上記)の?(文章|文面|文|メッセージ|内容|件|話)?(を)?/g,
  /(それぞれ|各自|各々|おのおの)(に|へ)?/g,
  /(を)?(送|おく|連絡|通知|共有|流)[っりるってらしじ]*(て)?(おいて)?(ほし[いく]|下さい|ください)?/g,
  /(に|へ)?(DM|dm|ダイレクト)(を)?(送|出)?[っりるってら]*(て)?/g,
  /(の)?(グループ|部屋|ルーム)(すべて|全部|全て)?(に|へ)?/g,
  /(の)?(店舗|お店|院)(すべて|全部|全て|全店)?(の)?(に|へ)?/g,
  /(この|その|あの)?\s*\d+\s*つ(の)?/g,
  /(その|この|あの)(人|方)(たち)?(の)?(に|へ)?/g,
  /(の)?(人|方|みんな|全員|メンバー|スタッフ)(たち)?(に|へ)?/g,
  /(すべて|全て|全部|全店)(の)?(に|へ)?/g,
  /(お願いします|おねがいします|よろしく)[。、!！]?/g,
];

// 宛先の区切り。「と」「や」「あと」は名前にも含まれ得るので、
// まとまりで照合できなかったときだけ使う（下の splitSoft）。
const HARD_SPLIT = /[、,，・･/／＆&\n]+/;

// 宛先にはなり得ない言葉。指示文の名残なので、当たらなかったと騒がずに捨てる。
const STOPWORDS = new Set(['これ', 'それ', 'あれ', 'こちら', 'そちら', 'あちら',
  '文', '文章', '文面', 'メッセージ', '内容', '件', '話', '以下', '下記', '上記', '次',
  'みんな', '皆', '皆さん', '全員', '各位', 'こと', 'もの', 'ため']);

// まとまりで当たらなかった言葉を、さらに細かく割る
export function splitSoft(s) {
  return str(s).split(/(?:と|や|あと|および|ならびに|プラス)/).map(x => x.trim()).filter(Boolean);
}

/**
 * 文章 → { intent, tokens }
 *   intent:
 *     'store_rooms' … 既存の店舗グループへ送る（「神奈川の店舗すべてのグループに送って」）
 *     'new_group'   … その人たちで新しくグループを作る（「グループを作ってほしい」）
 *     'dm'          … 一人ずつ個別に送る（「それぞれに送ってほしい」）
 *     null          … 指定なし（画面の既定に任せる）
 *   tokens: [{ raw, name, hint }]   hint は「本部の佐藤」「田中（新宿の田中）」の“本部”“新宿”
 *
 * ⚠️「グループを作る」と「グループに送る」は別物。取り違えると、送るだけのつもりで
 *    新しい部屋が増えたり、逆に既存の店舗ルームへ流れたりする。助詞で見分ける。
 */
export function parseRecipientText(text) {
  const src = normalize(text);
  let intent = null;
  if (/グループ(を)?(組|作|つく)/.test(src) || /まとめて(1|一)つ/.test(src)) intent = 'new_group';
  else if (/(グループ|部屋|ルーム)(に|へ)/.test(src)) intent = 'store_rooms';
  else if (/個別|一人ずつ|ひとりずつ|それぞれ|DM|dm|ダイレクト/.test(src)) intent = 'dm';

  // 「（本部の佐藤）」のような補足を、直前の名前のヒントとして取り出す
  const hints = [];
  let work = src.replace(/[（(]([^）)]{1,20})[）)]/g, (_m, inner) => {
    hints.push(inner);
    return `${HINT_OPEN}${hints.length - 1}${HINT_CLOSE}`;
  });

  for (const re of ACTION_PATTERNS) work = work.replace(re, ' ');

  const pieces = work.split(HARD_SPLIT).flatMap(p => p.split(/ +/)).map(p => p.trim()).filter(Boolean);
  const tokens = [];
  const hintRe = new RegExp(`^(.*?)${HINT_OPEN}(\\d+)${HINT_CLOSE}(.*)$`);
  for (const piece of pieces) {
    const m = piece.match(hintRe);
    if (m) {
      const name = (m[1] + m[3]).replace(/^(と|や|あと)/, '').trim();
      const hintRaw = hints[Number(m[2])] || '';
      // 「新宿の田中」→ ヒントは“新宿”。「本部の佐藤」→“本部”
      const hint = (hintRaw.match(/^(.+?)の(.+)$/) || [])[1] || hintRaw;
      if (name) tokens.push({ raw: `${name}（${hintRaw}）`, name, hint: hint.trim() });
      continue;
    }
    const plain = piece.replace(new RegExp(`${HINT_OPEN}\\d+${HINT_CLOSE}`, 'g'), '')
      .replace(/^(と|や|あと|および|ならびに|プラス)/, '').trim();
    if (!plain || STOPWORDS.has(plain)) continue;
    const withHint = plain.match(/^(.{1,12}?)の(.{1,12})$/);
    if (withHint) { tokens.push({ raw: plain, name: withHint[2], hint: withHint[1] }); continue; }
    tokens.push({ raw: plain, name: plain, hint: '' });
  }
  return { intent, tokens };
}

// 照合先（在籍者と店舗名）を作る
function buildIndex(staff, shops) {
  const people = arr(staff).filter(p => p && str(p.id));
  const shopNames = new Set(arr(shops).map(s => str(s && s.name ? s.name : s)).filter(Boolean));
  for (const p of people) if (p.shop) shopNames.add(str(p.shop));
  return { people, shopNames: [...shopNames] };
}

const REGIONS = ['北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州', '沖縄', '海外'];

// 1つの言葉を照合する。返り値 { kind, people, label } / null
function resolveToken(token, idx) {
  const key = matchKey(token.name);
  if (!key) return null;
  const hintKey = matchKey(token.hint);
  const byHint = (p) => !hintKey || matchKey(p.shop).includes(hintKey) || matchKey(p.name).includes(hintKey);

  // 1) 氏名がそのまま一致（いちばん強い）
  const exact = idx.people.filter(p => matchKey(p.name) === key && byHint(p));
  if (exact.length === 1) return { kind: 'staff', people: exact, label: exact[0].name };
  if (exact.length > 1) return { kind: 'ambiguous', people: exact, label: token.name };

  // 2) 店舗名（「鶴見」→「NAORU 鶴見院」）。その店舗の全員。
  const shopHit = idx.shopNames.filter(n => matchKey(n).includes(key));
  if (shopHit.length) {
    const members = idx.people.filter(p => shopHit.some(n => matchKey(p.shop) === matchKey(n)));
    return { kind: 'shop', people: members, shops: shopHit,
      label: shopHit.length === 1 ? shopHit[0] : `${shopHit[0]} ほか${shopHit.length - 1}店` };
  }

  // 3) 都道府県・地域
  const prefName = Object.values(PREF_NAMES).find(n =>
    matchKey(n) === key || matchKey(n).replace(/(都|府|県)$/, '') === key);
  if (prefName) {
    return { kind: 'area', label: prefName, people: idx.people.filter(p => areaOf(p.shop).pref === prefName) };
  }
  const region = REGIONS.find(r => matchKey(r) === key);
  if (region) {
    return { kind: 'area', label: region, people: idx.people.filter(p => regionOf(areaOf(p.shop).rank) === region) };
  }

  // 4) 氏名の一部（苗字だけ・下の名前だけ）。複数当たったら「候補」にする。
  const partial = idx.people.filter(p => matchKey(p.name).includes(key) && byHint(p));
  if (partial.length === 1) return { kind: 'staff', people: partial, label: partial[0].name };
  if (partial.length > 1) return { kind: 'ambiguous', people: partial, label: token.name };

  return null;
}

/**
 * 文章 → 宛先。
 *   ctx = { staff: [{id,name,shop}], shops: [{name}] または ['店舗名'] }
 * 返り値:
 *   people    … 確定した宛先（重複なし）
 *   groups    … どの言葉が誰に当たったかの内訳（画面に出す）
 *   ambiguous … 候補が複数で決められなかったもの（人が選ぶまで宛先に入れない）
 *   unknown   … 一人も当たらなかった言葉（黙って無視しない）
 */
export function resolveRecipients(text, ctx) {
  const { intent, tokens } = parseRecipientText(text);
  const idx = buildIndex((ctx || {}).staff, (ctx || {}).shops);
  const seen = new Map();
  const groups = [], ambiguous = [], unknown = [];
  const rooms = new Map();     // 既存の店舗ルーム（「グループに送って」のとき使う）

  // まとまりで当たらなければ「と・や・あと」で割ってもう一度試す
  const expand = (t) => {
    const r = resolveToken(t, idx);
    if (r) return [{ token: t, res: r }];
    // 末尾に助詞が残っていたら落として試す（「宮崎育美の」→「宮崎育美」）。
    // ⚠️ 先にそのままで照合しているので、助詞で終わる名前を壊さない。
    const trimmed = t.name.replace(/(の|に|へ|を|は|も|が)$/, '');
    if (trimmed && trimmed !== t.name) {
      const sub = { raw: trimmed, name: trimmed, hint: t.hint };
      const r2 = resolveToken(sub, idx);
      if (r2) return [{ token: sub, res: r2 }];
    }
    const parts = splitSoft(t.name);
    // ⚠️ 1つしか残らなくても、元と違えば試す（「あと八代」→「八代」を取りこぼさない）
    if (!parts.length || (parts.length === 1 && parts[0] === t.name)) return [{ token: t, res: null }];
    return parts.map(name => {
      const sub = { raw: name, name, hint: t.hint };
      return { token: sub, res: resolveToken(sub, idx) };
    });
  };

  for (const t of tokens) {
    for (const { token, res } of expand(t)) {
      if (!res) { unknown.push(token.raw); continue; }
      if (res.kind === 'ambiguous') {
        ambiguous.push({ token: token.raw,
          candidates: res.people.map(p => ({ id: str(p.id), name: str(p.name), shop: str(p.shop) })) });
        continue;
      }
      if (!res.people.length) { unknown.push(token.raw); continue; }   // 店舗は分かったが在籍者0
      for (const p of res.people) if (!seen.has(str(p.id))) seen.set(str(p.id), p);
      // 「グループに送って」用に、その店舗の**既存の店舗ルーム**も割り出しておく。
      // shop は当たった店舗そのもの、area はその中の人が所属する店舗。
      const shopNames = res.kind === 'shop' ? arr(res.shops)
        : (res.kind === 'area' ? [...new Set(res.people.map(p => str(p.shop)).filter(Boolean))] : []);
      for (const name of shopNames) {
        const id = storeRoomId(name);
        if (!rooms.has(id)) rooms.set(id, { id, name, kind: 'store' });
      }
      groups.push({ token: token.raw, kind: res.kind, label: res.label, count: res.people.length,
        shops: shopNames,
        people: res.people.map(p => ({ id: str(p.id), name: str(p.name), shop: str(p.shop) })) });
    }
  }
  return { intent, people: [...seen.values()], rooms: [...rooms.values()],
    groups, ambiguous, unknown, total: seen.size };
}

/** 画面とルーム名に出す短い説明（「鶴見・関内（8名）」） */
export function recipientLabel(res) {
  const r = res || {};
  const names = arr(r.groups).map(g => g.label);
  if (!names.length) return '';
  const head = names.slice(0, 3).join('・') + (names.length > 3 ? `ほか${names.length - 3}件` : '');
  return `${head}（${r.total || 0}名）`;
}

/**
 * そのまま送ってよいか。曖昧・未一致が残っていれば止める。
 *   mode: 'store_rooms' なら送り先は店舗ルーム、それ以外は人。
 * ⚠️ 「誰に届くか分からない状態で送らない」ための最後の関所。
 */
export function canSend(res, mode) {
  const r = res || {};
  if (arr(r.ambiguous).length) return { ok: false, reason: 'ambiguous' };
  if (arr(r.unknown).length) return { ok: false, reason: 'unknown' };
  const m = mode || r.intent;
  if (m === 'store_rooms') {
    if (!arr(r.rooms).length) return { ok: false, reason: 'no_rooms' };
    return { ok: true };
  }
  if (!arr(r.people).length) return { ok: false, reason: 'no_recipients' };
  return { ok: true };
}
