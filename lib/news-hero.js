// ── NAORUニュース: ファーストビュー（画面のいちばん上の一枚）──────────────
//
// ⚠️ 設計方針
//   - 文言と写真は**本部が画面から差し替えられる**ようにする。
//     コードに焼き付けると、変えたいときに私（①）の手が要る。
//   - 写真は**本部・管理者だけ**が差し替えられる。全社の顔になる場所なので、
//     誰でも書き換えられる状態にしない。サーバー側でも確かめる。
//   - 写真の実体は別キー（IDだけを持つ）。ここに画像データを詰め込まない。
//   - ⚠️ 人が写る写真を載せる場所なので、**掲載許可の確認**を保存の条件にする。
//     確認は自動で立てない。
//   - 未設定でも成り立つこと。写真が無ければ、文字だけの面で出す。
//
// tests/news-hero.test.js でカバー。

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

export const HERO_KEY = 'naoru:news:hero:v1';

/** 既定の文言（オーナー提示のファーストビューに合わせた初期値）。 */
export const HERO_DEFAULT = Object.freeze({
  overline: 'NAORU NEWS / ONE TEAM',
  title: 'この仲間と、\n次のNAORUへ。',
  lead: '最期まで大切な人と笑顔で\n元気な社会を創造する。',
  sign: 'ともにつくる。最高の未来を。',
  signLatin: 'ONE NAORU\nFOR A BRIGHTER\nHEALTHCARE TOMORROW',
});

export const TITLE_MAX = 60;
export const LEAD_MAX = 120;

/** 保存する形に整える。⚠️ 知らないキーを生やさない。空欄は既定の文言に戻す。 */
export function normalizeHero(input) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const pick = (k, max) => {
    const v = str(src[k], max).trim();
    return v || HERO_DEFAULT[k];
  };
  return {
    overline: pick('overline', 60),
    title: pick('title', TITLE_MAX),
    lead: pick('lead', LEAD_MAX),
    sign: pick('sign', 60),
    signLatin: pick('signLatin', 120),
    imgId: str(src.imgId, 64),
    // ⚠️ 写っている人の掲載許可を確かめたか。自動では立てない。
    consent: src.consent === true,
    updatedAt: Number(src.updatedAt) || 0,
    updatedBy: str(src.updatedBy, 64),
  };
}

/** 差し替えてよいのは本部・管理者だけ。⚠️ 名乗りではなく、確かめた actor で判定する。 */
export function canEditHero(actor) {
  const a = actor || {};
  return a.verified === true && ['root', 'admin'].includes(str(a.role, 20));
}

/**
 * 保存してよいか。
 * ⚠️ 写真があるのに掲載許可が未確認なら止める。理由を返す（黙って落とさない）。
 */
export function heroReady(h) {
  const x = normalizeHero(h);
  if (x.imgId && !x.consent) return { ok: false, reason: 'consent_unconfirmed' };
  return { ok: true };
}

export const HERO_REASON = Object.freeze({
  consent_unconfirmed: '写真に写っている方の掲載許可を確かめてから保存してください。',
});

/** 表示用に行へ割る（改行をそのまま持たせる。勝手に詰めない）。 */
export function heroLines(v, max = 4) {
  return str(v, 400).split('\n').map(s => s.trim()).filter(Boolean).slice(0, max);
}
