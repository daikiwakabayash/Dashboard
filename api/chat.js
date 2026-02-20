import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

// ── System prompt: NAORU 経営分析 AI ──────────────────────────────
const SYSTEM_PROMPT = `あなたはNAORU整骨院グループの経営分析AIアシスタント「NAORUアシスタント」です。
ダッシュボードに表示されているリアルタイムの経営データ・マーケティングデータ・サブスクリプションデータに基づき、
正確で実用的な分析・アドバイスを提供します。

## あなたの強み
- 具体的な数値に基づく分析（推測ではなく、提供されたデータのみを使用）
- 業界ベンチマークとの比較による客観的な評価
- 実行可能な改善提案

## 業界ベンチマーク（整体院・整骨院）
| 指標 | 要改善 | 平均 | 良好 | 優秀 |
|------|--------|------|------|------|
| CPA（顧客獲得単価） | >¥18,000 | ¥12,000-18,000 | ¥8,000-12,000 | <¥8,000 |
| 入会率 | <30% | 30-40% | 40-55% | >55% |
| 退会率（月次） | >15% | 10-15% | 5-10% | <5% |
| ROAS | <200% | 200-300% | 300-500% | >500% |
| スタッフ生産性 | <¥60万/月 | ¥60-80万 | ¥80-120万 | >¥120万 |
| 口コミ獲得率 | <20% | 20-30% | 30-50% | >50% |
| キャンセル率 | >20% | 15-20% | 10-15% | <10% |
| CVR（Web） | <1% | 1-2% | 2-4% | >4% |

## 回答のガイドライン
1. **数値を必ず含める**: データがある場合、具体的な数字で回答する
2. **比較で文脈を作る**: 前月比、他店舗比較、業界ベンチマーク比較を活用
3. **課題には必ず改善策を**: 問題を指摘するだけでなく、具体的なアクションを提案
4. **簡潔かつ網羅的に**: 冗長な説明は避け、ポイントを明確に
5. **日本語で回答**: 自然な日本語で対話する
6. **データがない場合は正直に**: 提供されたデータにない情報は推測せず、「該当データがありません」と伝える
7. **店舗名の表記ゆれに注意**: 「千葉」→「千葉駅院」、「恵比寿」→「恵比寿院」など柔軟に対応

## データについて
ユーザーメッセージに添付される【データコンテキスト】セクションには、質問に関連するダッシュボードの実データが含まれています。
このデータを元に分析してください。データがない項目については「データが取得できていません」と回答してください。`;

// ── Helper: リクエストボディのバリデーション ──────────────────────
function validateRequest(body) {
  if (!body || typeof body.question !== 'string' || !body.question.trim()) {
    return { valid: false, error: 'question is required' };
  }
  if (body.history && !Array.isArray(body.history)) {
    return { valid: false, error: 'history must be an array' };
  }
  return { valid: true };
}

// ── Helper: 会話履歴を Claude messages 形式に変換 ────────────────
function buildMessages(question, history = [], dataContext = '') {
  const messages = [];

  // 過去の会話履歴（最大10往復 = 20メッセージ）
  const recentHistory = (history || []).slice(-20);
  for (const msg of recentHistory) {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    });
  }

  // 最新のユーザー質問（データコンテキスト付き）
  let userContent = question;
  if (dataContext && dataContext.trim()) {
    userContent = `${question}\n\n【データコンテキスト】\n${dataContext}`;
  }
  messages.push({ role: 'user', content: userContent });

  return messages;
}

// ── Vercel Serverless Handler ────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // API キー確認
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not configured',
      message: 'Vercel の環境変数に ANTHROPIC_API_KEY を設定してください。'
    });
  }

  try {
    const body = req.body;
    const validation = validateRequest(body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const { question, history, dataContext, stream: useStream } = body;

    const messages = buildMessages(question, history, dataContext);

    // ── ストリーミングモード ──
    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-5-20250514',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages
      });

      stream.on('text', (text) => {
        res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
      });

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
      });

      stream.on('end', () => {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      // クライアント切断時のクリーンアップ
      req.on('close', () => {
        stream.abort();
      });

      return;
    }

    // ── 非ストリーミングモード ──
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages
    });

    const assistantMessage = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      }
    });

  } catch (error) {
    console.error('Chat API error:', error);

    if (error.status === 401) {
      return res.status(500).json({
        error: 'Invalid API key',
        message: 'ANTHROPIC_API_KEY が無効です。正しいキーを設定してください。'
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        error: 'Rate limited',
        message: 'APIのレート制限に達しました。しばらく待ってから再度お試しください。'
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: 'AI応答の生成中にエラーが発生しました。しばらく待ってから再度お試しください。'
    });
  }
}
