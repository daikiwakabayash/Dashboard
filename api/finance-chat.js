import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const FINANCE_SYSTEM_PROMPT = `あなたは「NAORU財務アドバイザー」— 整骨院チェーンの経理・財務に特化した専門家です。

## あなたの役割
- 損益計算書（P/L）、貸借対照表（B/S）、キャッシュフロー計算書（C/F）の分析
- 財務指標の評価と改善提案
- 資金繰り・キャッシュマネジメントのアドバイス
- 税務・会計に関する一般的なガイダンス

## 分析の視点
1. **収益性**: 売上総利益率、営業利益率、経常利益率
2. **安全性**: 流動比率、自己資本比率、負債比率
3. **効率性**: 総資産回転率、売掛金回転期間
4. **成長性**: 売上高成長率、利益成長率

## 整骨院業界の財務ベンチマーク
| 指標 | 要改善 | 平均 | 良好 | 優秀 |
|------|--------|------|------|------|
| 売上総利益率 | <60% | 60-70% | 70-80% | >80% |
| 営業利益率 | <5% | 5-15% | 15-25% | >25% |
| 人件費率 | >50% | 35-50% | 25-35% | <25% |
| 流動比率 | <100% | 100-150% | 150-200% | >200% |
| 自己資本比率 | <20% | 20-40% | 40-60% | >60% |

## 回答スタイル
- 必ずMarkdown記法で回答（見出し、太字、箇条書き、表）
- 数値は必ずカンマ区切り・単位付き（¥1,234,567、12.3%）
- 冒頭に結論、続いてデータ分析、最後に改善アクション
- 具体的な数値目標と期待効果を提示
- 提供されたデータに基づいてのみ分析する。データにない数値は捏造しない`;

const MODELS = [
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];
const MAX_TOKENS = 8192;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not configured',
      message: 'Vercel の環境変数に ANTHROPIC_API_KEY を設定してください。'
    });
  }

  try {
    const { question, history, dataContext } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    const messages = [];
    const recentHistory = (history || []).slice(-20);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    }

    let userContent = question;
    if (dataContext && dataContext.trim()) {
      userContent = `${question}\n\n【財務データコンテキスト】\n${dataContext}`;
    }
    messages.push({ role: 'user', content: userContent });

    let lastError;
    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i];
      try {
        const response = await anthropic.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system: FINANCE_SYSTEM_PROMPT,
          messages,
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
      } catch (err) {
        const status = err.status || err.error?.status;
        lastError = err;
        if (status !== 404 && status !== 400) break;
      }
    }
    throw lastError;

  } catch (error) {
    console.error('Finance Chat API error:', error);

    if (error.status === 401) {
      return res.status(500).json({ error: 'Invalid API key', message: 'ANTHROPIC_API_KEY が無効です。' });
    }
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limited', message: 'レート制限に達しました。しばらく待ってから再度お試しください。' });
    }
    return res.status(500).json({ error: 'Internal server error', message: 'AI応答の生成中にエラーが発生しました。' });
  }
}
