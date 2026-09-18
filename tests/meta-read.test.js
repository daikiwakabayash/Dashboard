import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  normalizeMetric, normalizeMetrics, normalizeOverview, normalizeFreshness,
  buildTree, lastCompleteDays, connectionState, META_API_VERSION,
  looksLikeSample, currencySymbol, normalizeUnit, isCurrencyUnit,
  parseAccountAllowList, declaredMode} from '../lib/meta-read.js';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/meta-overview-sample.json', import.meta.url), 'utf8'));

describe('normalizeMetric - 未接続・欠損を 0 にしない（最重要）', () => {
  it('🔴 value が無ければ null。0 にしない', () => {
    for (const raw of [{}, { value: null }, { value: '' }, { value: undefined }, null]) {
      expect(normalizeMetric(raw, 'spend').value, JSON.stringify(raw)).toBe(null);
    }
  });
  it('🔴 値が無いのに VERIFIED を主張する応答は MISSING に落とす', () => {
    const m = normalizeMetric({ value: null, quality: 'VERIFIED' }, 'spend');
    expect(m.quality).toBe('MISSING');
  });
  it('🔴 本物の 0 は 0 のまま残す（欠損と区別する）', () => {
    const m = normalizeMetric({ value: 0, quality: 'VERIFIED', display: '¥0' }, 'spend');
    expect(m.value).toBe(0);
    expect(m.quality).toBe('VERIFIED');
    expect(m.missingReason).toBe(null);
  });
  it('欠損には必ず理由が付く', () => {
    expect(normalizeMetric({ value: null }, 'spend').missingReason).toBeTruthy();
    expect(normalizeMetric({ value: null, missing_reason: 'テスト理由' }, 'spend').missingReason).toBe('テスト理由');
  });
  it('欠損の表示は「—」（0 や空文字にしない）', () => {
    expect(normalizeMetric({ value: null }, 'spend').display).toBe('—');
  });
  it('数値にならない値は null 扱い', () => {
    expect(normalizeMetric({ value: 'abc' }, 'spend').value).toBe(null);
    expect(normalizeMetric({ value: NaN }, 'spend').value).toBe(null);
  });
  it('🔴 未知の quality は VERIFIED にしない（ESTIMATED へ落とす）', () => {
    expect(normalizeMetric({ value: 5, quality: 'なにか' }, 'spend').quality).toBe('ESTIMATED');
    expect(normalizeMetric({ value: null, quality: 'なにか' }, 'spend').quality).toBe('MISSING');
  });
});

describe('normalizeMetrics - 全指標が揃う', () => {
  it('応答に無い指標も null で揃える（画面が落ちない）', () => {
    const m = normalizeMetrics({ spend: { value: 100 } });
    expect(m.spend.value).toBe(100);
    expect(m.clicks.value).toBe(null);
    expect(m.results.value).toBe(null);
  });
});

describe('normalizeOverview - 版の管理', () => {
  it('🔴 知らない版は表示しない', () => {
    const r = normalizeOverview({ ...FIXTURE, api_version: 'meta-read-99' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('UNSUPPORTED_VERSION');
    expect(r.error.message).toContain('meta-read-99');
  });
  it('版が無い応答も表示しない', () => {
    expect(normalizeOverview({ status: 'ok' }).ok).toBe(false);
    expect(normalizeOverview(null).ok).toBe(false);
  });
  it('対応版なら通す', () => {
    expect(normalizeOverview(FIXTURE).ok).toBe(true);
    expect(normalizeOverview(FIXTURE).apiVersion).toBe(META_API_VERSION);
  });
});

describe('normalizeOverview - エラー応答', () => {
  const err = (code) => ({ api_version: META_API_VERSION, status: 'error', error: { code, message: 'テスト', retryable: false },
                           freshness: { last_success_at: '2026-09-17T03:00:00+09:00' } });
  it('未接続は connected:false', () => {
    const r = normalizeOverview(err('NOT_CONNECTED'));
    expect(r.ok).toBe(false);
    expect(r.connected).toBe(false);
  });
  it('🔴 エラーでも最終成功取得日時は残す（いつの数字かが最重要）', () => {
    expect(normalizeOverview(err('UPSTREAM_ERROR')).freshness.lastSuccessAt).toBe('2026-09-17T03:00:00+09:00');
  });
  it('🔴 エラー時に金額を作らない（totals を持たない）', () => {
    const r = normalizeOverview(err('RATE_LIMITED'));
    expect(r.totals).toBeUndefined();
  });
  it('接続済みだが失敗、は connected:true（未接続と区別する）', () => {
    expect(normalizeOverview(err('UPSTREAM_ERROR')).connected).toBe(true);
  });
});

describe('normalizeOverview - サンプルデータの印', () => {
  it('🔴 fixture には必ず印が付く', () => {
    expect(normalizeOverview(FIXTURE).isSample).toBe(true);
  });
  it('opts でも印を付けられる', () => {
    const clean = { ...FIXTURE }; delete clean._fixture;
    expect(normalizeOverview(clean, { fixture: true }).isSample).toBe(true);
  });
  it('実データには印が付かない', () => {
    // サンプル判定は _fixture だけでなく「作り物のアカウントID」も見るので、
    // 実データらしいIDに差し替えて確認する。
    const clean = { ...FIXTURE, account: { ...FIXTURE.account, id: 'act_123456789012' } };
    delete clean._fixture;
    expect(normalizeOverview(clean).isSample).toBe(false);
  });
  it('版エラーでも印は保たれる', () => {
    expect(normalizeOverview({ ...FIXTURE, api_version: 'x' }).isSample).toBe(true);
  });
});

describe('normalizeOverview - 期間・通貨・タイムゾーン', () => {
  const r = normalizeOverview(FIXTURE);
  it('通貨とタイムゾーンを保持する', () => {
    expect(r.account.currency).toBe('JPY');
    expect(r.account.timezone).toBe('Asia/Tokyo');
    expect(r.period.timezone).toBe('Asia/Tokyo');
  });
  it('当日を含めていないことが分かる', () => {
    expect(r.period.completeDaysOnly).toBe(true);
    expect(r.period.excludedToday).toBe(true);
  });
  it('通貨が無ければ null（勝手に円にしない）', () => {
    const noCur = normalizeOverview({ ...FIXTURE, account: { ...FIXTURE.account, currency: '' } });
    expect(noCur.account.currency).toBe(null);
  });
  it('店舗対応と確度を保持する', () => {
    expect(r.account.storeMapping).toHaveLength(2);
    expect(r.account.storeMapping[0].confidence).toBe('confirmed');
    expect(r.account.storeMapping[1].confidence).toBe('inferred');
  });
  it('未知の確度は unmapped に倒す', () => {
    const x = normalizeOverview({ ...FIXTURE, account: { ...FIXTURE.account, store_mapping: [{ store_id: '1', confidence: 'たぶん' }] } });
    expect(x.account.storeMapping[0].confidence).toBe('unmapped');
  });
});

describe('normalizeOverview - 配信状態', () => {
  const r = normalizeOverview(FIXTURE);
  it('status と effective_status を別に持つ（審査落ちが見える）', () => {
    const dis = r.rows.find(x => x.id === 'ad_2');
    expect(dis.status).toBe('ACTIVE');
    expect(dis.effectiveStatus).toBe('DISAPPROVED');
  });
  it('停止中のキャンペーンも一覧に残る', () => {
    expect(r.rows.find(x => x.id === 'c_2').effectiveStatus).toBe('PAUSED');
  });
});

describe('normalizeOverview - クリエイティブは権限が確認できた分だけ', () => {
  it('🔴 permission が denied ならURLを使わない', () => {
    const r = normalizeOverview(FIXTURE);
    const ad = r.rows.find(x => x.id === 'ad_1');
    expect(ad.creative.permission).toBe('denied');
    expect(ad.creative.thumbnailUrl).toBe(null);
  });
  it('🔴 permission が unknown でもURLを使わない', () => {
    const src = { ...FIXTURE, rows: [{ ...FIXTURE.rows[2], creative: { thumbnail_url: 'https://x/y.jpg', permission: 'unknown', type: 'image' } }] };
    expect(normalizeOverview(src).rows[0].creative.thumbnailUrl).toBe(null);
  });
  it('granted のときだけURLを使う', () => {
    const src = { ...FIXTURE, rows: [{ ...FIXTURE.rows[2], creative: { thumbnail_url: 'https://x/y.jpg', permission: 'granted', type: 'image' } }] };
    expect(normalizeOverview(src).rows[0].creative.thumbnailUrl).toBe('https://x/y.jpg');
  });
});

describe('buildTree - 親子の組み立て', () => {
  it('campaign → adset → ad の順に深さが付く', () => {
    const t = buildTree(normalizeOverview(FIXTURE).rows);
    expect(t[0].depth).toBe(0);
    expect(t[1].depth).toBe(1);
    expect(t[2].depth).toBe(2);
  });
  it('🔴 親が見つからない行も落とさない', () => {
    const rows = [{ id: 'x', parentId: 'missing', level: 'ad', metrics: {} }];
    const t = buildTree(rows);
    expect(t).toHaveLength(1);
    expect(t[0].orphan).toBe(true);
  });
  it('循環していても無限ループしない', () => {
    const rows = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
    expect(() => buildTree(rows)).not.toThrow();
    expect(buildTree(rows)).toHaveLength(2);
  });
  it('全行が残る（件数が減らない）', () => {
    const rows = normalizeOverview(FIXTURE).rows;
    expect(buildTree(rows)).toHaveLength(rows.length);
  });
});

describe('lastCompleteDays - 当日を含めない', () => {
  it('🔴 直近7日は「昨日まで」', () => {
    const p = lastCompleteDays(7, new Date('2026-09-18T05:00:00Z'));
    expect(p.to).toBe('2026-09-17');     // 昨日
    expect(p.from).toBe('2026-09-11');   // その6日前
  });
  it('日数を変えられる', () => {
    const p = lastCompleteDays(1, new Date('2026-09-18T05:00:00Z'));
    expect({ from: p.from, to: p.to }).toEqual({ from: '2026-09-17', to: '2026-09-17' });
  });
  it('月をまたいでも正しい', () => {
    const p = lastCompleteDays(7, new Date('2026-10-03T05:00:00Z'));
    expect({ from: p.from, to: p.to }).toEqual({ from: '2026-09-26', to: '2026-10-02' });
  });
});

describe('connectionState - 未接続の理由を出す', () => {
  it('接続先が無ければサンプル表示＋理由', () => {
    const s = connectionState({});
    expect(s.connected).toBe(false);
    expect(s.mode).toBe('sample');
    expect(s.reason).toContain('META_READ_API_BASE');
  });
  it('鍵が無ければその理由', () => {
    const s = connectionState({ META_READ_API_BASE: 'https://x' });
    expect(s.connected).toBe(false);
    expect(s.reason).toContain('META_READ_API_KEY');
  });
  it('両方あれば接続済み', () => {
    expect(connectionState({ META_READ_API_BASE: 'https://x', META_READ_API_KEY: 'k' }).connected).toBe(true);
  });
  it('🔴 未接続の説明に金額を含めない', () => {
    const s = connectionState({});
    expect(JSON.stringify(s)).not.toMatch(/[¥$]|円/);
  });
  it('取得に失敗したら理由を引き継ぐ', () => {
    const s = connectionState({ META_READ_API_BASE: 'https://x', META_READ_API_KEY: 'k' },
      { ok: false, error: { code: 'TOKEN_EXPIRED', message: 'Meta側の再認証が必要です' } });
    expect(s.mode).toBe('error');
    expect(s.code).toBe('TOKEN_EXPIRED');
  });
});

describe('normalizeFreshness', () => {
  it('最終成功・最終試行・遅れを持つ', () => {
    const f = normalizeFreshness({ last_success_at: 'a', last_attempt_at: 'b', lag_minutes: 10 });
    expect(f).toEqual({ lastSuccessAt: 'a', lastAttemptAt: 'b', lagMinutes: 10 });
  });
  it('無ければ null（0分にしない）', () => {
    expect(normalizeFreshness(null)).toEqual({ lastSuccessAt: null, lastAttemptAt: null, lagMinutes: null });
  });
});

describe('契約とfixtureの整合', () => {
  it('fixture は契約の版と一致する', () => {
    expect(FIXTURE.api_version).toBe(META_API_VERSION);
  });
  it('🔴 fixture はサンプルと明示している', () => {
    expect(FIXTURE._fixture).toBe(true);
    expect(FIXTURE.account.name).toContain('サンプル');
  });
  it('🔴 fixture に実在しそうな店舗名・口座IDが入っていない', () => {
    const s = JSON.stringify(FIXTURE);
    expect(s).not.toMatch(/NAORU\s*(整骨院)?\s*(恵比寿|渋谷|梅田|銀座|新宿)/);
    expect(FIXTURE.account.id).toMatch(/^act_0+$/);
  });
  it('成果件数は SalonOne の予約数と別物だと明記している', () => {
    expect(FIXTURE.definitions.results.note).toContain('SalonOne');
  });
});

// ── #387 の指摘（ロジック層）────────────────────────────────────
describe('(5) 未知の quality を VERIFIED へ昇格させない', () => {
  it('🔴 知らない quality は ESTIMATED（確定値として見せない）', () => {
    expect(normalizeMetric({ value: 100, quality: 'SUPER_VERIFIED' }, 'spend').quality).toBe('ESTIMATED');
    expect(normalizeMetric({ value: 100, quality: 'ok' }, 'spend').quality).toBe('ESTIMATED');
  });
  it('quality が無いときだけ値の有無から決める', () => {
    expect(normalizeMetric({ value: 100 }, 'spend').quality).toBe('VERIFIED');
    expect(normalizeMetric({ value: null }, 'spend').quality).toBe('MISSING');
  });
  it('知らない quality で値も無ければ MISSING', () => {
    expect(normalizeMetric({ value: null, quality: 'weird' }, 'spend').quality).toBe('MISSING');
  });
});

describe('(4) サンプル判定', () => {
  it('🔴 上流の mode/mock/sample 申告を拾う', () => {
    for (const d of [{ mode: 'mock' }, { mode: 'sample' }, { sample: true }, { mock: true }, { _fixture: true }, { environment: 'sandbox' }]) {
      expect(looksLikeSample(d), JSON.stringify(d)).toBe(true);
    }
  });
  it('🔴 作り物のアカウントID（act_000…）を拾う', () => {
    expect(looksLikeSample({ account: { id: 'act_0000000000000' } })).toBe(true);
  });
  it('実データらしい応答は false', () => {
    expect(looksLikeSample({ account: { id: 'act_123456789' } })).toBe(false);
    expect(looksLikeSample(null)).toBe(false);
  });
});

describe('(2) 要求と応答の一致を確認する', () => {
  const base = JSON.parse(JSON.stringify(FIXTURE));
  it('🔴 テナントが違えば表示しない', () => {
    const r = normalizeOverview(base, { expect: { tenantId: 'other' } });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('RESPONSE_MISMATCH');
  });
  it('🔴 アカウントが違えば表示しない', () => {
    const r = normalizeOverview(base, { expect: { accountId: 'act_expected' } });
    expect(r.ok).toBe(false);
    expect(r.error.detail[0].field).toBe('account');
  });
  it('🔴 期間が違えば表示しない', () => {
    const r = normalizeOverview(base, { expect: { from: '2026-01-01', to: '2026-01-07' } });
    expect(r.ok).toBe(false);
  });
  it('🔴 食い違ったときに数字を返さない', () => {
    const r = normalizeOverview(base, { expect: { tenantId: 'other' } });
    expect(r.totals).toBeUndefined();
    expect(r.rows).toBeUndefined();
  });
  it('一致していれば通る', () => {
    const r = normalizeOverview(base, { expect: { tenantId: 'naoru', accountId: base.account.id, from: base.period.from, to: base.period.to } });
    expect(r.ok).toBe(true);
  });
  it('expect を渡さなければ従来どおり（後方互換）', () => {
    expect(normalizeOverview(base).ok).toBe(true);
  });
});

describe('(6) タイムゾーン基準の期間', () => {
  it('🔴 東京の朝（UTCではまだ前日）でも「昨日まで」が正しい', () => {
    // 2026-09-18 02:00 UTC = 東京 11:00。東京の昨日は 09-17
    const jst = lastCompleteDays(7, new Date('2026-09-18T02:00:00Z'), 'Asia/Tokyo');
    expect(jst.to).toBe('2026-09-17');
    expect(jst.from).toBe('2026-09-11');
  });
  it('🔴 UTC基準とずれる時間帯がある（タイムゾーンを見ている証拠）', () => {
    // 2026-09-18 23:00 UTC = 東京は 09-19 08:00 → 東京の昨日は 09-18
    const at = new Date('2026-09-18T23:00:00Z');
    expect(lastCompleteDays(7, at, 'Asia/Tokyo').to).toBe('2026-09-18');
    expect(lastCompleteDays(7, at, 'UTC').to).toBe('2026-09-17');
  });
  it('タイムゾーンを返す（画面に出せる）', () => {
    expect(lastCompleteDays(7, new Date(), 'Australia/Sydney').timeZone).toBe('Australia/Sydney');
  });
  it('不正なタイムゾーンでも落ちない', () => {
    expect(() => lastCompleteDays(7, new Date(), 'Not/AZone')).not.toThrow();
  });
});

describe('(6) 通貨は JPY 以外も保持する', () => {
  it('主要通貨の記号を返す', () => {
    expect(currencySymbol('JPY')).toBe('¥');
    expect(currencySymbol('AUD')).toBe('A$');
    expect(currencySymbol('MYR')).toBe('RM');
  });
  it('知らない通貨は記号なし（勝手に¥にしない）', () => {
    expect(currencySymbol('XYZ')).toBe('');
    expect(currencySymbol(null)).toBe('');
  });
});

describe('(6) 行数上限は黙って切らない', () => {
  it('🔴 上限を超えたら truncated と総件数を返す', () => {
    const many = { ...FIXTURE, rows: Array.from({ length: 1200 }, (_, i) => ({ level: 'ad', id: `x${i}`, name: `広告${i}`, metrics: {} })) };
    const r = normalizeOverview(many);
    expect(r.truncated).toBe(true);
    expect(r.rowCountTotal).toBe(1200);
    expect(r.rows).toHaveLength(r.rowCap);
  });
  it('上限以内なら truncated は false', () => {
    expect(normalizeOverview(FIXTURE).truncated).toBe(false);
  });
  it('上流のページング情報を引き継ぐ', () => {
    const r = normalizeOverview({ ...FIXTURE, paging: { has_more: true, next_cursor: 'abc' } });
    expect(r.paging).toEqual({ hasMore: true, nextCursor: 'abc' });
  });
});

// ── ③からの指摘（固定参照 3396a18 時点の差分）──────────────────────────
// (3) 外貨の単位が count（件数）へ潰れていた
describe('🔴 金額の単位は広告アカウントの通貨を保持する', () => {
  it('AUD / MYR / USD をそのまま通貨単位として残す', () => {
    for (const c of ['AUD', 'MYR', 'USD', 'SGD']) {
      expect(normalizeUnit(c)).toBe(c);
      expect(isCurrencyUnit(normalizeUnit(c))).toBe(true);
    }
  });
  it('小文字の通貨コードも大文字で保持する', () => {
    expect(normalizeUnit('aud')).toBe('AUD');
  });
  it('JPY も従来どおり保持する（回帰）', () => {
    expect(normalizeUnit('JPY')).toBe('JPY');
  });
  it('count / ratio はそのまま', () => {
    expect(normalizeUnit('count')).toBe('count');
    expect(normalizeUnit('ratio')).toBe('ratio');
    expect(isCurrencyUnit('count')).toBe(false);
    expect(isCurrencyUnit('ratio')).toBe(false);
  });
  it('通貨コードでない未知の値は count（従来どおり控えめ）', () => {
    for (const v of ['', null, undefined, 'dollars', '¥', 'JP']) expect(normalizeUnit(v)).toBe('count');
  });
  it('🔴 豪州アカウントの消化額が「件数」にならない', () => {
    const m = normalizeMetric({ value: 1234, unit: 'AUD', quality: 'VERIFIED' }, 'spend');
    expect(m.unit).toBe('AUD');
    expect(m.unit).not.toBe('count');
  });
});

// ── 実データ接続の受入ゲート（③ naoru-ai-platform と揃える）─────────────
describe('parseAccountAllowList - 部分採用しない', () => {
  it('🔴 1件でも不正なら、リスト全体を無効にする（残りだけ採用しない）', () => {
    const r = parseAccountAllowList({ META_AD_ACCOUNT_IDS: 'act_1335477837049931,invalid' });
    expect(r.valid).toBe(false);
    expect(r.ids).toEqual([]);
    expect(r.reason).toContain('リスト全体を無効');
  });
  it('🔴 act_ + 数字以外は不正（③が受け付けない形式を通さない）', () => {
    for (const v of ['act_live', 'act_ABC', '1335477837049931', 'act_', 'act_12a']) {
      expect(parseAccountAllowList({ META_AD_ACCOUNT_IDS: v }).valid, v).toBe(false);
    }
  });
  it('🔴 重複はリスト全体を無効にする', () => {
    expect(parseAccountAllowList({ META_AD_ACCOUNT_IDS: 'act_123,act_123' }).valid).toBe(false);
  });
  it('🔴 旧 META_AD_ACCOUNT_ID（単数）は許可リストに使わない。黙って無視せず移行を伝える', () => {
    const r = parseAccountAllowList({ META_AD_ACCOUNT_ID: 'act_1335477837049931' });
    expect(r.valid).toBe(false);
    expect(r.ids).toEqual([]);
    expect(r.reason).toContain('META_AD_ACCOUNT_IDS');
  });
  it('正しいリストは採用する（空白は許す）', () => {
    const r = parseAccountAllowList({ META_AD_ACCOUNT_IDS: ' act_1335477837049931 , act_222 ' });
    expect(r.valid).toBe(true);
    expect(r.ids).toEqual(['act_1335477837049931', 'act_222']);
  });
});

describe('unknown mode を実データとして表示しない', () => {
  // FIXTURE は act_0000000000000 で「明らかな作り物」と判定されるため、実アカウント形のIDで組む
  const ok = { ...FIXTURE, api_version: 'meta-read-1',
    account: { ...FIXTURE.account, id: 'act_1335477837049931' } };
  it('🔴 mode/data_mode が unknown なら数値を出さない', () => {
    const r = normalizeOverview({ ...ok, mode: 'unknown', data_mode: 'unknown', sample: false, _fixture: false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('MODE_UNCONFIRMED');
    expect(r.totals).toBeUndefined();
    expect(r.isSample).toBe(false);          // サンプルとも偽らない
  });
  it('🔴 unknown を live へ昇格させない', () => {
    expect(declaredMode({ mode: 'unknown' })).toBe('unconfirmed');
    expect(declaredMode({ data_mode: 'unknown' })).toBe('unconfirmed');
    expect(declaredMode({ mode: 'live' })).toBe('live');
    expect(declaredMode({ _fixture: true })).toBe('sample');
    expect(declaredMode({})).toBe('unstated');      // 旧形式は従来どおり
  });
  it('エラー応答は従来どおり理由を出す（MODE_UNCONFIRMED に吸い込まない）', () => {
    const r = normalizeOverview({ api_version: 'meta-read-1', status: 'error', data_mode: 'unknown',
      error: { code: 'RATE_LIMITED', retryable: true }, freshness: { last_success_at: '2026-09-17T00:00:00Z' } });
    expect(r.error.code).toBe('RATE_LIMITED');
    expect(r.freshness.lastSuccessAt).toBe('2026-09-17T00:00:00Z');
  });
});

describe('金額の単位と広告アカウント通貨の一致', () => {
  it('🔴 通貨が一致しない金額は数字を出さない（桁も意味も違う値を実績にしない）', () => {
    expect(normalizeMetric({ value: 1234, unit: 'JPY', quality: 'VERIFIED' }, 'spend', 'AUD').value).toBe(null);
    expect(normalizeMetric({ value: 1234, unit: 'JPY', quality: 'VERIFIED' }, 'spend', 'AUD').missingReason)
      .toContain('通貨');
  });
  it('一致していれば保持する（円へ寄せない）', () => {
    for (const c of ['JPY', 'USD', 'AUD', 'MYR']) {
      const m = normalizeMetric({ value: 100, unit: c, quality: 'VERIFIED' }, 'spend', c);
      expect(m.unit, c).toBe(c);
      expect(m.value, c).toBe(100);
    }
  });
  it('🔴 3文字ならなんでも通貨と判断しない', () => {
    expect(normalizeUnit('xyz', 'JPY')).toBe(null);
    expect(normalizeUnit('JPY', 'JPY')).toBe('JPY');
  });
  it('🔴 アカウント通貨が不明なら金額は表示しない', () => {
    expect(normalizeMetric({ value: 1234, unit: 'JPY' }, 'spend', '').value).toBe(null);
  });
  it('count / ratio は通貨に関係なくそのまま（表示回数やCTRまで消さない）', () => {
    expect(normalizeMetric({ value: 5, unit: 'count' }, 'clicks', 'AUD').value).toBe(5);
    expect(normalizeMetric({ value: 0.02, unit: 'ratio' }, 'ctr', 'AUD').value).toBe(0.02);
  });
  it('normalizeOverview は account.currency を使って totals を検証する', () => {
    const r = normalizeOverview({ api_version: 'meta-read-1', status: 'ok', _fixture: true,
      account: { id: 'act_1', currency: 'AUD' }, period: { from: 'a', to: 'b' },
      totals: { spend: { value: 100, unit: 'JPY', quality: 'VERIFIED' }, clicks: { value: 3, unit: 'count' } },
      rows: [], freshness: {} });
    expect(r.totals.spend.value).toBe(null);
    expect(r.totals.clicks.value).toBe(3);
  });
  it('2引数の従来呼び出しは挙動を変えない（外貨をcountに潰さない）', () => {
    expect(normalizeMetric({ value: 1234, unit: 'AUD', quality: 'VERIFIED' }, 'spend').unit).toBe('AUD');
  });
});
