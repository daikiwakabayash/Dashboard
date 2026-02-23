import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// api/auth.jsはdefault exportのhandlerなのでモジュール単位でテスト
// 環境変数を制御してテスト

describe('認証API - ロジックテスト', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createMockRes = () => {
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      setHeader(key, value) { this.headers[key] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
      end() { return this; },
    };
    return res;
  };

  it('パスワード未設定の場合は認証をスキップする', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'POST', body: { action: 'login', password: 'anything' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.token).toBe('dev-mode');
  });

  it('正しいパスワードでログインできる', async () => {
    process.env.DASHBOARD_PASSWORD = 'test-password-123';
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'POST', body: { action: 'login', password: 'test-password-123' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.token).not.toBe('test-password-123'); // パスワード自体は返さない
  });

  it('間違ったパスワードでは401を返す', async () => {
    process.env.DASHBOARD_PASSWORD = 'correct-password';
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'POST', body: { action: 'login', password: 'wrong-password' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.authenticated).toBe(false);
  });

  it('パスワード空文字では400を返す', async () => {
    process.env.DASHBOARD_PASSWORD = 'some-password';
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'POST', body: { action: 'login', password: '' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('正しいトークンで検証が通る', async () => {
    process.env.DASHBOARD_PASSWORD = 'test-pw';
    const { default: handler } = await import('../api/auth.js');

    // まずログインしてトークンを取得
    const loginRes = createMockRes();
    handler({ method: 'POST', body: { action: 'login', password: 'test-pw' } }, loginRes);
    const token = loginRes.body.token;

    // トークンで検証
    const verifyRes = createMockRes();
    handler({ method: 'POST', body: { action: 'verify', token } }, verifyRes);
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body.authenticated).toBe(true);
  });

  it('不正なトークンでは検証が失敗する', async () => {
    process.env.DASHBOARD_PASSWORD = 'test-pw';
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'POST', body: { action: 'verify', token: 'invalid-token' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.authenticated).toBe(false);
  });

  it('GETリクエストは405を返す', async () => {
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'GET' }, res);
    expect(res.statusCode).toBe(405);
  });

  it('不正なactionは400を返す', async () => {
    process.env.DASHBOARD_PASSWORD = 'pw';
    const { default: handler } = await import('../api/auth.js');
    const res = createMockRes();
    handler({ method: 'POST', body: { action: 'invalid' } }, res);
    expect(res.statusCode).toBe(400);
  });
});
