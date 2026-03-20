import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const EXTRACTION_PROMPT = `あなたは決算書の読み取り専門家です。アップロードされたPDFから財務データを正確に抽出し、以下のJSON構造で返してください。

## 抽出ルール
- 金額は全て円（整数）で出力（千円単位の場合は×1000に変換）
- マイナスの数値は負の整数で表現
- 該当データがない項目は 0 にする
- 複数期がある場合は最新の期のデータを抽出
- 科目名が異なる場合は最も近い科目にマッピング

## 出力JSON構造（必ずこの形式で返すこと）
\`\`\`json
{
  "period": "YYYY-MM",
  "companyName": "会社名",
  "fiscalYear": "第N期",
  "pl": {
    "sales": 0,
    "costOfSales": 0,
    "grossProfit": 0,
    "sgaExpenses": 0,
    "personnelCost": 0,
    "rent": 0,
    "advertising": 0,
    "depreciation": 0,
    "otherSga": 0,
    "operatingIncome": 0,
    "nonOperatingIncome": 0,
    "nonOperatingExpenses": 0,
    "ordinaryIncome": 0,
    "extraordinaryGains": 0,
    "extraordinaryLosses": 0,
    "incomeBeforeTax": 0,
    "incomeTax": 0,
    "netIncome": 0
  },
  "bs": {
    "cash": 0,
    "accountsReceivable": 0,
    "inventory": 0,
    "otherCurrentAssets": 0,
    "totalCurrentAssets": 0,
    "fixedAssets": 0,
    "intangibleAssets": 0,
    "investments": 0,
    "totalFixedAssets": 0,
    "totalAssets": 0,
    "accountsPayable": 0,
    "shortTermLoans": 0,
    "unpaidExpenses": 0,
    "otherCurrentLiabilities": 0,
    "totalCurrentLiabilities": 0,
    "longTermLoans": 0,
    "otherFixedLiabilities": 0,
    "totalFixedLiabilities": 0,
    "totalLiabilities": 0,
    "capital": 0,
    "retainedEarnings": 0,
    "totalEquity": 0,
    "totalLiabilitiesAndEquity": 0
  },
  "cashflow": {
    "operatingCF": 0,
    "investingCF": 0,
    "financingCF": 0,
    "netCashChange": 0,
    "beginningCash": 0,
    "endingCash": 0,
    "depreciation": 0,
    "changeInReceivables": 0,
    "changeInPayables": 0,
    "capex": 0,
    "loanRepayment": 0
  },
  "accountDetails": {
    "unpaidExpenses": [{"name": "科目名", "amount": 0}],
    "accountsReceivable": [{"name": "科目名", "amount": 0}],
    "accountsPayable": [{"name": "科目名", "amount": 0}]
  }
}
\`\`\`

**重要**: JSONのみを返してください。説明文やマークダウンの装飾は不要です。\`\`\`json と \`\`\` で囲んで返してください。
キャッシュフロー計算書がPDFに含まれない場合は、PLとBSから推計してください（営業CF ≈ 純利益 + 減価償却費、など）。`;

const MODELS = [
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

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
    const { pdfBase64, fileName } = req.body;

    if (!pdfBase64) {
      return res.status(400).json({ error: 'pdfBase64 is required' });
    }

    // PDF をClaude APIに送信（document type）
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64,
            },
          },
          {
            type: 'text',
            text: `この決算書PDF（${fileName || '不明'}）から財務データを抽出してJSON形式で返してください。`,
          },
        ],
      },
    ];

    let lastError;
    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i];
      try {
        console.log(`[finance-pdf] Trying model: ${model} for file: ${fileName}`);
        const response = await anthropic.messages.create({
          model,
          max_tokens: 8192,
          system: EXTRACTION_PROMPT,
          messages,
        });

        const text = response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('');

        // JSON を抽出
        const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return res.status(422).json({
            error: 'Failed to extract structured data',
            message: 'PDFから構造化データを抽出できませんでした。別のPDFを試してください。',
            raw: text,
          });
        }

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        return res.status(200).json({
          success: true,
          data: parsed,
          fileName,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        });
      } catch (err) {
        const status = err.status || err.error?.status;
        console.log(`[finance-pdf] Model ${model} failed: ${status || err.message}`);
        lastError = err;
        if (status !== 404 && status !== 400) break;
      }
    }
    throw lastError;

  } catch (error) {
    console.error('Finance PDF API error:', error);

    if (error instanceof SyntaxError) {
      return res.status(422).json({
        error: 'JSON parse failed',
        message: 'AIが返した結果をJSONとして解析できませんでした。再度お試しください。',
      });
    }
    if (error.status === 401) {
      return res.status(500).json({ error: 'Invalid API key' });
    }
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limited', message: 'レート制限に達しました。' });
    }
    return res.status(500).json({
      error: 'Internal server error',
      message: 'PDF解析中にエラーが発生しました。' + (error.message || ''),
    });
  }
}
