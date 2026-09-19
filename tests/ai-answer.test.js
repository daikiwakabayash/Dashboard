import { describe, it, expect } from 'vitest';
import {
  AGENTS, AGENT_KEYS, agentOf, agentsForScreen, STATUSES, normalizeStatus, normalizeOrigin,
  normalizeCitation, normalizeClaim, claimIsFact, CLAIM_REASON, OUTWARD_KINDS, normalizeAction,
  actionNeedsApproval, normalizeFreshness, freshnessLabel, isStale, normalizeAnswer,
  demoteUncited, displayValue, claimNote, answerVerdict, VERDICT_LABEL,
} from '../lib/ai-answer.js';

const cite = { id: 'c1', label: 'SalonOne 売上', version: 'v3', current: true };
const factish = (o = {}) => ({ text: '新規が伸びた', value: 120, unit: '人', period: '2026-09',
  defVersion: 'agg-v2', citationIds: ['c1'], origin: 'source', ...o });

describe('8人の業務AI', () => {
  it('8人ぶんある', () => expect(AGENTS).toHaveLength(8));
  it('別画面を作らず、既存の画面に割り当てる', () => {
    expect(AGENTS.every(a => !!a.screen)).toBe(true);
    expect(agentsForScreen('creative').map(a => a.key)).toEqual(['sns', 'content']);
    expect(agentsForScreen('home').map(a => a.key)).toEqual(['chief']);
  });
  it('知らないキーは null（それらしい担当を作らない）', () => {
    expect(agentOf('zzz')).toBe(null);
    expect(agentOf('chief').ja).toBe('経営の相談役');
  });
  it('状態は AGENTS.md §5 と同じ', () => {
    expect(STATUSES).toEqual(['queued', 'running', 'completed', 'failed', 'cancelled']);
    expect(normalizeStatus('とつぜん')).toBe('queued');
  });
});

describe('出どころ', () => {
  it('source と名乗るときだけ実績あつかい', () => {
    expect(normalizeOrigin('source')).toBe('source');
    expect(normalizeOrigin('llm')).toBe('model');
    expect(normalizeOrigin(undefined)).toBe('model');   // ⚠️ 既定は model（安全側）
  });
});

describe('出典', () => {
  it('id が無ければ出典として数えない', () => {
    expect(normalizeCitation({ label: '名前だけ' })).toBe(null);
  });
  it('https 以外のURLは持たない', () => {
    expect(normalizeCitation({ id: 'c', url: 'http://x' }).url).toBe('');
    expect(normalizeCitation({ id: 'c', url: 'https://x' }).url).toBe('https://x');
  });
});

describe('主張ひとつ', () => {
  it('未取得を 0 にしない', () => {
    expect(normalizeClaim({ value: null }).value).toBe(null);
    expect(normalizeClaim({ value: '' }).value).toBe(null);
    expect(normalizeClaim({ value: undefined }).value).toBe(null);
    expect(normalizeClaim({ value: 'あ' }).value).toBe(null);
    expect(normalizeClaim({ value: 0 }).value).toBe(0);      // 本当の 0 は 0
  });
  it('🔴 モデルが作った値は実績にしない', () => {
    const r = claimIsFact(factish({ origin: 'model' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('model_generated');
    expect(CLAIM_REASON[r.reason]).toContain('実績');
  });
  it('🔴 出典が無ければ事実にしない', () => {
    expect(claimIsFact(factish({ citationIds: [] }))).toEqual({ ok: false, reason: 'no_citation' });
  });
  it('🔴 数値には対象期間・単位・集計定義版が要る', () => {
    expect(claimIsFact(factish({ period: '' })).reason).toBe('no_period');
    expect(claimIsFact(factish({ unit: '' })).reason).toBe('no_unit');
    expect(claimIsFact(factish({ defVersion: '' })).reason).toBe('no_def_version');
  });
  it('数値でない主張は、期間・単位が無くても事実になれる', () => {
    expect(claimIsFact({ text: '看板が古い', origin: 'source', citationIds: ['c1'] })).toEqual({ ok: true });
  });
  it('揃っていれば事実', () => expect(claimIsFact(factish())).toEqual({ ok: true }));
});

describe('🔴 出典の無い主張は事実から落とす', () => {
  const base = { agent: 'marketing', status: 'completed', citations: [cite] };
  it('出典つきは事実のまま', () => {
    const { answer, demoted } = demoteUncited({ ...base, facts: [factish()] });
    expect(answer.facts).toHaveLength(1);
    expect(demoted).toHaveLength(0);
  });
  it('出典が無いものは仮説へ落ちる', () => {
    const { answer, demoted } = demoteUncited({ ...base, facts: [factish({ citationIds: [] })] });
    expect(answer.facts).toHaveLength(0);
    expect(answer.hypotheses).toHaveLength(1);
    expect(demoted[0].reason).toBe('no_citation');
  });
  it('モデルが作った値も仮説へ落ちる', () => {
    const { answer, demoted } = demoteUncited({ ...base, facts: [factish({ origin: 'model' })] });
    expect(answer.facts).toHaveLength(0);
    expect(demoted[0].reason).toBe('model_generated');
  });
  it('🔴 citations に無い出典IDを名乗っても事実にしない', () => {
    const { answer, demoted } = demoteUncited({ ...base, facts: [factish({ citationIds: ['ないやつ'] })] });
    expect(answer.facts).toHaveLength(0);
    expect(demoted[0].reason).toBe('no_citation');
  });
  it('元からの仮説は消えない', () => {
    const { answer } = demoteUncited({ ...base, facts: [factish({ citationIds: [] })], hypotheses: [{ text: 'もとの仮説' }] });
    expect(answer.hypotheses.map(h => h.text)).toEqual(['もとの仮説', '新規が伸びた']);
  });
});

describe('提案', () => {
  it('外向きの操作は承認が要る', () => {
    for (const k of OUTWARD_KINDS) expect(actionNeedsApproval({ kind: k })).toBe(true);
  });
  it('🔴 分からない種別は承認が要る側に倒す', () => {
    expect(actionNeedsApproval({ kind: '' })).toBe(true);
    expect(actionNeedsApproval({})).toBe(true);
    expect(actionNeedsApproval({ kind: 'なんとか' })).toBe(true);
  });
  it('読み取りだけは承認が要らない', () => {
    expect(actionNeedsApproval({ kind: 'read_report' })).toBe(false);
  });
  it('知らないキーを生やさない', () => {
    expect(Object.keys(normalizeAction({ こっそり: 1 })).sort())
      .toEqual(['approvalId', 'citationIds', 'id', 'kind', 'title', 'why']);
  });
});

describe('鮮度', () => {
  const now = Date.UTC(2026, 8, 19, 0, 0, 0);
  it('取れていなければ「不明」', () => {
    expect(normalizeFreshness({}).at).toBe(null);
    expect(freshnessLabel({}, now)).toBe('更新日時が不明');
  });
  it('経過で言い換える', () => {
    expect(freshnessLabel({ at: now - 30 * 1000 }, now)).toBe('たった今の情報');
    expect(freshnessLabel({ at: now - 5 * 60 * 1000 }, now)).toBe('5分前の情報');
    expect(freshnessLabel({ at: now - 3 * 3600 * 1000 }, now)).toBe('3時間前の情報');
    expect(freshnessLabel({ at: now - 2 * 86400 * 1000 }, now)).toBe('2日前の情報');
  });
  it('🔴 鮮度が分からないものは「古いかもしれない」側に倒す', () => {
    expect(isStale({}, now)).toBe(true);
    expect(isStale({ at: now - 1000 }, now)).toBe(false);
    expect(isStale({ at: now - 48 * 3600 * 1000 }, now)).toBe(true);
  });
});

describe('画面に出す値', () => {
  it('未取得は「未取得」（0 と書かない）', () => {
    expect(displayValue({ value: null, unit: '人' })).toBe('未取得');
  });
  it('単位を付ける・桁を区切る', () => {
    expect(displayValue({ value: 120, unit: '人' })).toBe('120人');
    expect(displayValue({ value: 1234567, unit: '円' })).toBe('1,234,567円');
  });
  it('但し書きに対象期間・出典・集計定義を必ず入れる', () => {
    expect(claimNote(factish(), [cite])).toBe('対象期間: 2026-09 / 出典: SalonOne 売上 / 集計定義: agg-v2');
  });
  it('欠けていれば「不明」と書く（省略しない）', () => {
    expect(claimNote({ value: 1 }, [])).toBe('対象期間: 不明 / 出典: 不明 / 集計定義: 不明');
  });
});

describe('出してよい回答か', () => {
  const base = { agent: 'marketing', citations: [cite] };
  it('調べている途中', () => {
    expect(answerVerdict({ ...base, status: 'running' })).toBe('running');
    expect(VERDICT_LABEL.running).toContain('調べ');
  });
  it('失敗・中止', () => {
    expect(answerVerdict({ ...base, status: 'failed' })).toBe('failed');
    expect(answerVerdict({ ...base, status: 'cancelled' })).toBe('failed');
  });
  it('🔴 中身が無ければ「判断不能」', () => {
    expect(answerVerdict({ ...base, status: 'completed' })).toBe('insufficient');
    expect(VERDICT_LABEL.insufficient).toContain('根拠');
  });
  it('🔴 事実が1つも無く、取れていない項目があるなら「判断不能」', () => {
    expect(answerVerdict({ ...base, status: 'completed', hypotheses: [{ text: 'たぶん' }], missingData: ['広告費'] }))
      .toBe('insufficient');
  });
  it('事実があれば出す', () => {
    expect(answerVerdict({ ...base, status: 'completed', facts: [factish()] })).toBe('ok');
  });
});

describe('回答まるごと', () => {
  it('知らないキーを生やさない', () => {
    expect(Object.keys(normalizeAnswer({ こっそり: 1 })).sort())
      .toEqual(['agent', 'citations', 'error', 'facts', 'freshness', 'hypotheses', 'missingData', 'proposedActions', 'question', 'status', 'usage']);
  });
  it('snake_case でも読める（③が返す形に合わせる）', () => {
    const a = normalizeAnswer({ missing_data: ['広告費'], proposed_actions: [{ kind: 'sns_post' }] });
    expect(a.missingData).toEqual(['広告費']);
    expect(a.proposedActions).toHaveLength(1);
  });
  it('知らない担当は空にする（勝手に割り当てない）', () => {
    expect(normalizeAnswer({ agent: 'よその人' }).agent).toBe('');
    expect(normalizeAnswer({ agent: 'chief' }).agent).toBe('chief');
  });
  it('使用量は負を採らない', () => {
    expect(normalizeAnswer({ usage: { calls: -1, tokens: 'あ', costJpy: 12 } }).usage)
      .toEqual({ calls: null, tokens: null, costJpy: 12 });
  });
  it('空でも落ちない', () => {
    const a = normalizeAnswer(null);
    expect(a.facts).toEqual([]);
    expect(a.freshness.at).toBe(null);
  });
});
