import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

// fixtures/ に秘密や実データが紛れ込むのを機械的に防ぐ。
// 「気をつける」ではなく、混入したらテストが落ちる状態にしておく。
const DIR = resolve(process.cwd(), 'fixtures');
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

describe('fixtures - 秘密が混入していない', () => {
  it('検査対象のfixtureが存在する', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // 実在しうる秘密の形。1つでも当たったら落とす。
  const SECRET_PATTERNS = [
    [/sk-[A-Za-z0-9_-]{20,}/, 'Anthropic/OpenAI 形式のAPIキー'],
    [/sq0[a-z]{3}-[A-Za-z0-9_-]{20,}/, 'Square のトークン'],
    [/sq_live_[A-Za-z0-9]+/, 'Square 本番トークン'],
    [/AKfycb[A-Za-z0-9_-]{20,}/, 'GAS デプロイID'],
    [/script\.google\.com\/macros\/s\//, 'GAS WebアプリURL'],
    [/AIza[A-Za-z0-9_-]{30,}/, 'Google APIキー'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '秘密鍵'],
    [/https:\/\/[a-z0-9-]+\.upstash\.io/, 'Upstash のエンドポイント'],
    [/https:\/\/[a-z0-9]{20}\.supabase\.co/, 'Supabase のプロジェクトURL'],
  ];

  // 秘密らしいキー名に、伏字でない実値が入っていないか
  const SECRET_KEYS = /"(password|passwd|api_?key|secret|token|authorization|credential|private_?key)"\s*:\s*"(?!(\s*|SAMPLE|REDACTED|<[^"]*>|\*+)")/i;

  for (const f of files) {
    const text = readFileSync(resolve(DIR, f), 'utf-8');

    it(`${f}: 秘密の形をした文字列を含まない`, () => {
      for (const [re, label] of SECRET_PATTERNS) {
        expect(re.test(text), `${label} らしき値が含まれています`).toBe(false);
      }
    });

    it(`${f}: 秘密らしいキーに実値が入っていない`, () => {
      expect(SECRET_KEYS.test(text), '秘密らしいキーに値が入っています').toBe(false);
    });

    it(`${f}: メールアドレス・電話番号を含まない`, () => {
      expect(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), 'メールアドレスが含まれています').toBe(false);
      expect(/0\d{1,4}-\d{1,4}-\d{3,4}/.test(text), '電話番号らしき値が含まれています').toBe(false);
    });

    it(`${f}: 正しいJSONで、匿名化の注記を持つ`, () => {
      const json = JSON.parse(text);
      expect(json._readme, '_readme（用途と匿名化の説明）が必要').toBeTruthy();
      expect(String(json._readme.warning || '')).toMatch(/含めてはならない|含めない/);
    });
  }
});

describe('fixtures - SalonOne サンプルが契約書どおりの形をしている', () => {
  const j = JSON.parse(readFileSync(resolve(DIR, 'salonone-api-sample.json'), 'utf-8'));

  it('契約書の主要エンドポイントを網羅している', () => {
    for (const k of ['meta', 'me', 'shops', 'salesSummary', 'salesSummaryByShop', 'marketingByChannel', 'marketingByStaff', 'marketingNewCustomers', 'appointments', 'visitSources', 'errors']) {
      expect(j[k], `${k} が無い`).toBeTruthy();
    }
  });

  it('広告費の正式値 ad_spend を各媒体が持つ', () => {
    for (const row of j.marketingByChannel.data) {
      expect(typeof row.ad_spend, `${row.name} の ad_spend`).toBe('number');
    }
  });

  it('新規顧客に受付日コホートの3状態が揃っている', () => {
    const st = j.marketingNewCustomers.data.map(r => r.first_appointment_status);
    expect(st).toContain('completed');   // 来店
    expect(st).toContain('cancelled');   // 実キャンセル
    expect(st).toContain('reserved');    // 未来店（キャンセルに数えない）
  });

  it('dismissed（テスト予約）の例を含む', () => {
    expect(j.appointments.data.some(a => a.dismissed_at)).toBe(true);
  });

  it('媒体名の表記ゆれの例を含む（channel_group 正規化の入力）', () => {
    const names = j.visitSources.data.map(v => v.name);
    expect(names).toContain('META');
    expect(names).toContain('Facebook');
    expect(names).toContain('HPB');
    expect(names).toContain('ホットペッパービューティー');
  });

  it('ページングの形（has_more / next_cursor）を持つ', () => {
    expect(j.marketingNewCustomers.meta).toHaveProperty('has_more');
    expect(j.marketingNewCustomers.meta).toHaveProperty('next_cursor');
  });

  it('主要なエラー形を網羅している', () => {
    for (const k of ['invalidRequest', 'notFound', 'methodNotAllowed', 'upstreamError', 'userAuthRequired', 'invalidToken', 'shopForbidden', 'rateLimited']) {
      expect(j.errors[k], `${k} が無い`).toBeTruthy();
    }
  });
});
