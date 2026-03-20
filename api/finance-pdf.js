import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const EXTRACTION_PROMPT = `あなたは日本の決算書の読み取り専門家です。アップロードされた決算書のページ画像から財務データを正確に抽出してください。

## 重要な注意事項
- 決算書の全ページの画像が提供されます。損益計算書(PL)、貸借対照表(BS)、キャッシュフロー計算書(CF)のページを探してデータを読み取ってください
- 必ず全ての数値を読み取ってください。特に売上高、営業利益、経常利益、当期純利益、総資産、現金は重要です
- 画像に表示されている数値をそのまま読み取ってください

## 金額の変換ルール
- 最終出力は全て円（整数）
- 決算書の単位に注意:
  - 「単位：千円」→ 読み取った数値 × 1000（例: 35,560千円 → 35560000）
  - 「単位：百万円」→ 読み取った数値 × 1000000
  - 「単位：万円」→ 読み取った数値 × 10000
  - 単位が円の場合 → そのまま
- △（三角）はマイナスを意味する
- カンマは無視する（35,560 → 35560）

## 期・年度の特定
- period: 決算期末日の年月を "YYYY-MM" 形式で（令和5年 = 2023年、令和6年 = 2024年、令和7年 = 2025年）
- fiscalYear: 決算書に記載された「第N期」をそのまま出力
- companyName: 会社名をそのまま出力

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

**重要**: JSONのみを返してください。\`\`\`json と \`\`\` で囲んで返してください。
売上原価が明示されていない場合: grossProfit = sales, costOfSales = 0。
キャッシュフロー計算書が無い場合: PLとBSから推計（営業CF ≈ 純利益 + 減価償却費）。
該当データがない項目は 0 にする。`;

const MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20241022',
];

async function callWithRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.error?.status;
      if (status === 429 && attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt + 1) * 1000;
        console.log(`[finance-pdf] Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

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
    const { pageImages, fileName } = req.body;

    if (!pageImages || !Array.isArray(pageImages) || pageImages.length === 0) {
      return res.status(400).json({ error: 'pageImages array is required' });
    }

    console.log(`[finance-pdf] File: ${fileName}, Pages: ${pageImages.length}`);

    // ページ画像をClaude APIのcontent blocksに変換
    const contentBlocks = [];
    for (let i = 0; i < pageImages.length; i++) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: pageImages[i],
        },
      });
    }
    contentBlocks.push({
      type: 'text',
      text: `この決算書（${fileName || '不明'}、全${pageImages.length}ページ）の全てのページを注意深く確認し、損益計算書(PL)・貸借対照表(BS)・キャッシュフロー計算書のデータを漏れなく抽出してJSON形式で返してください。特に売上高、各種費用、資産・負債の各科目の金額を正確に読み取ってください。単位（千円、万円等）に注意して円に変換してください。`,
    });

    const messages = [{ role: 'user', content: contentBlocks }];

    let lastError;
    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i];
      try {
        console.log(`[finance-pdf] Trying model: ${model}`);

        const response = await callWithRetry(() =>
          anthropic.messages.create({
            model,
            max_tokens: 8192,
            system: EXTRACTION_PROMPT,
            messages,
          })
        );

        const text = response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('');

        const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
          return res.status(422).json({
            error: 'Failed to extract structured data',
            message: 'PDFから構造化データを抽出できませんでした。別のPDFを試してください。',
          });
        }

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        return res.status(200).json({
          success: true,
          data: parsed,
          fileName,
          pages: pageImages.length,
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
      return res.status(500).json({ error: 'Invalid API key', message: 'ANTHROPIC_API_KEY が無効です。' });
    }
    if (error.status === 400 && error.message?.includes('credit balance')) {
      return res.status(402).json({ error: 'Insufficient credits', message: 'Anthropic APIのクレジット残高が不足しています。console.anthropic.com でクレジットをチャージしてください。' });
    }
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limited', message: 'APIのレート制限に達しました。1〜2分後に再度お試しください。' });
    }
    const errMsg = error.message || String(error);
    const statusCode = error.status || 500;
    return res.status(statusCode).json({
      error: 'Internal server error',
      message: errMsg.includes('credit') ? 'Anthropic APIのクレジット残高が不足しています。console.anthropic.com でクレジットをチャージしてください。' : 'PDF解析中にエラーが発生しました: ' + errMsg,
    });
  }
}
