import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  normalizeMetric, normalizeMetrics, normalizeOverview, normalizeFreshness,
  buildTree, lastCompleteDays, connectionState, META_API_VERSION,
} from '../lib/meta-read.js';

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
  it('未知の quality は値の有無から決める', () => {
    expect(normalizeMetric({ value: 5, quality: 'なにか' }, 'spend').quality).toBe('VERIFIED');
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
    const clean = { ...FIXTURE }; delete clean._fixture;
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
    expect(lastCompleteDays(1, new Date('2026-09-18T05:00:00Z'))).toEqual({ from: '2026-09-17', to: '2026-09-17' });
  });
  it('月をまたいでも正しい', () => {
    expect(lastCompleteDays(7, new Date('2026-10-03T05:00:00Z'))).toEqual({ from: '2026-09-26', to: '2026-10-02' });
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
