// ── フィードバック API: GAS スプレッドシート連携 ──────────────────
// 環境変数: FEEDBACK_GAS_URL - フィードバック用GAS WebアプリURL
//
// GET  /api/feedback       → 有効なフィードバック（良い回答例）を取得
// POST /api/feedback       → 新しいフィードバックを送信
//
// GAS スプレッドシート構成（「フィードバック」シート）:
// | 日付 | カテゴリ | 質問 | 悪い回答 | 良い回答 | 有効 |
//
// GAS 側の doGet は有効=TRUE の行を JSON 配列で返す想定
// GAS 側の doPost は新しい行を追記する想定

// ── インメモリキャッシュ（Vercel Serverless のコールド/ウォームで再利用） ──
let feedbackCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10分

export async function fetchFeedbackExamples() {
  const url = process.env.FEEDBACK_GAS_URL;
  if (!url) return [];

  const now = Date.now();
  if (feedbackCache && (now - cacheTimestamp) < CACHE_TTL) {
    return feedbackCache;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`GAS returned ${response.status}`);
    const data = await response.json();
    // data は [{category, question, badAnswer, goodAnswer}] の配列想定
    const examples = Array.isArray(data) ? data : (data.examples || []);
    feedbackCache = examples;
    cacheTimestamp = now;
    return examples;
  } catch (err) {
    console.error('[feedback] Failed to fetch from GAS:', err.message);
    // キャッシュが残っていれば古いものを返す
    return feedbackCache || [];
  }
}

export function buildFeedbackPrompt(examples) {
  if (!examples || examples.length === 0) return '';

  const lines = [
    '\n## 回答品質フィードバック（運用チームからの改善指示）',
    '以下は実際のユーザーフィードバックに基づく回答改善ルールです。同様の質問が来た場合は「良い回答例」を参考にしてください。\n',
  ];

  examples.forEach((ex, i) => {
    lines.push(`### 改善例${i + 1}: ${ex.category || '一般'}`);
    if (ex.question) lines.push(`**質問例**: ${ex.question}`);
    if (ex.badAnswer) lines.push(`**× 悪い回答**: ${ex.badAnswer}`);
    if (ex.goodAnswer) lines.push(`**○ 良い回答**: ${ex.goodAnswer}`);
    lines.push('');
  });

  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const feedbackUrl = process.env.FEEDBACK_GAS_URL;

  // ── GET: フィードバック一覧取得 ──
  if (req.method === 'GET') {
    if (!feedbackUrl) {
      return res.status(200).json({ examples: [], message: 'FEEDBACK_GAS_URL is not configured' });
    }
    try {
      const examples = await fetchFeedbackExamples();
      return res.status(200).json({ examples });
    } catch (err) {
      return res.status(502).json({ error: 'Failed to fetch feedback', message: err.message });
    }
  }

  // ── POST: フィードバック送信 ──
  if (req.method === 'POST') {
    if (!feedbackUrl) {
      return res.status(500).json({
        error: 'FEEDBACK_GAS_URL is not configured',
        message: 'Vercelの環境変数にFEEDBACK_GAS_URLを設定してください。'
      });
    }

    const { question, badAnswer, goodAnswer, category } = req.body || {};
    if (!question || !badAnswer) {
      return res.status(400).json({ error: '質問と悪い回答は必須です' });
    }

    try {
      const response = await fetch(feedbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: new Date().toISOString().slice(0, 10),
          category: category || '一般',
          question,
          badAnswer,
          goodAnswer: goodAnswer || '',
        }),
        redirect: 'follow',
      });

      if (!response.ok) throw new Error(`GAS returned ${response.status}`);

      // キャッシュを無効化して次回リフレッシュ
      feedbackCache = null;
      cacheTimestamp = 0;

      return res.status(200).json({ success: true, message: 'フィードバックを送信しました' });
    } catch (err) {
      console.error('[feedback] Failed to submit:', err.message);
      return res.status(502).json({ error: 'Failed to submit feedback', message: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
