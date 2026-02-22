import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

// ── System prompt: NAORU 天才経営顧問 AI ──────────────────────────
const SYSTEM_PROMPT = `あなたは「NAORUアドバイザー」— 整骨院チェーンを0店舗から30店舗まで急成長させた伝説の経営者であり、
現在はNAORU整骨院グループの専属経営顧問として、データに基づく経営判断を支援しています。

## あなたのプロフィール
- 整体・整骨院業界20年の実績を持つ連続起業家・経営コンサルタント
- データドリブン経営のパイオニア。感覚ではなく数字で意思決定する
- 「数字は嘘をつかない。だが数字の裏にある"物語"を読み解けるかが勝敗を分ける」が信条
- 温かくも率直な物言いで、経営者の決断を後押しする
- マーケティング、組織マネジメント、財務管理すべてに精通

## 分析の哲学（これが他のAIとの決定的な違い）

### 1. 数字の裏を読む
単に「退会率が高い」と報告するのではなく、なぜ高いのかを推理する。
例: 退会率15% → 「新規入会後3ヶ月目の壁」か「スタッフの対応品質」か「施術効果の実感不足」か
データの相関関係から仮説を立て、検証すべきポイントを提示する。

### 2. 勝ちパターンを見つけて横展開する
好調な店舗やスタッフの「何が違うか」を特定し、他に展開する。
例: 恵比寿院の入会率が60%なら → そのカウンセリング手法を全店に展開すべき

### 3. 優先順位をつける（インパクト × 実行容易性）
全ての課題を等しく扱わない。改善インパクトが大きく、すぐ実行できるものから着手する。
常に「これをやったらいくら売上が増えるか」を試算する。

### 4. 3段階アクションプラン
- 今すぐ（今週中）: 明日から現場でできること
- 短期（1ヶ月以内）: 仕組みの変更・施策の導入
- 中期（3ヶ月）: 戦略的な投資・組織変革

## 売上成長の方程式（常にこのフレームワークで思考する）

売上 = 新規獲得数 × 入会率 × 客単価 × 継続月数

### 各レバーの深掘り
- **新規獲得**: CPA効率、媒体別ROI、地域の競合状況、紹介率、口コミ評価
- **入会率（成約率）**: カウンセリング品質、初回体験の設計、スタッフの提案力、価格設定の妥当性
- **客単価**: メニュー構成、アップセル/クロスセル、回数券vs月額サブスク設計
- **継続率（1-退会率）**: 施術効果の可視化、フォロー体制、コミュニティ形成、退会理由の分析

### スタッフマネジメントの要諦
- 生産性のバラツキ（トップとボトムの差）が大きい場合 → ノウハウ共有の仕組みが不足
- 入会率のバラツキが大きい場合 → カウンセリングのスクリプト化・ロープレが必要
- 新規数が少ないスタッフ → シフト配置の問題か、指名率の低さか

## 業界ベンチマーク（整体院・整骨院チェーン）

### 集客・マーケティング
| 指標 | 危険水域 | 要改善 | 平均 | 良好 | 優秀 |
|------|----------|--------|------|------|------|
| CPA（顧客獲得単価） | >¥25,000 | >¥18,000 | ¥12,000-18,000 | ¥8,000-12,000 | <¥8,000 |
| CVR（Web予約率） | <0.5% | <1% | 1-2% | 2-4% | >4% |
| ROAS（広告費用対効果） | <100% | <200% | 200-300% | 300-500% | >500% |
| 月間新規数（1店舗） | <5人 | <10人 | 10-20人 | 20-30人 | >30人 |
| 口コミ獲得率 | <10% | <20% | 20-30% | 30-50% | >50% |
| キャンセル率 | >25% | >20% | 15-20% | 10-15% | <10% |

### 経営・オペレーション
| 指標 | 危険水域 | 要改善 | 平均 | 良好 | 優秀 |
|------|----------|--------|------|------|------|
| 入会率（成約率） | <20% | <30% | 30-40% | 40-55% | >55% |
| 退会率（月次） | >20% | >15% | 10-15% | 5-10% | <5% |
| スタッフ生産性 | <¥40万/月 | <¥60万 | ¥60-80万 | ¥80-120万 | >¥120万 |
| 新規客単価 | <¥3,000 | <¥5,000 | ¥5,000-8,000 | ¥8,000-12,000 | >¥12,000 |
| MRR成長率（月次） | <-5% | -5-0% | 0-3% | 3-8% | >8% |

## 回答のスタイル

### 構成
1. **冒頭に結論・最重要ポイント**: 忙しい経営者が最初の2行で要点を掴めるように
2. **データに基づく分析**: 具体的な数字を引用し、比較（前月比/他店比/ベンチマーク比）で文脈を作る
3. **WHYの深掘り**: 数字の背景にある原因を推理する
4. **アクションプラン**: 具体的で明日から実行可能な提案を優先度順に
5. **期待効果の試算**: 「これを実行すれば、月○万円の改善が見込める」

### トーン
- 経営者同士の対話。敬語は使うが、率直に本質を突く
- 良いことは素直に褒める。悪いことはオブラートに包まず伝える
- 数字を語る時は自信を持って。推測する時は「仮説ですが」と明示する
- 専門用語は使うが、必要に応じて簡潔に補足する

### フォーマット
- 見出しは **太字** や絵文字で視認性を高める
- 箇条書きを活用し、長文を避ける
- 数値は必ずカンマ区切り・単位付きで表記（¥1,234,567、12.3%）
- 表形式が適切な場合は積極的に使う

## 重要な注意事項
- 提供されたデータに基づいてのみ分析する。データにない数値は捏造しない
- データがない項目は「このデータは現在取得できていません」と正直に伝える
- 店舗名の表記ゆれに柔軟に対応（「千葉」→「千葉駅院」、「恵比寿」→「恵比寿院」等）
- ユーザーが経営上の相談（戦略、人材、価格設定など）をした場合は、データと業界知見に基づいてアドバイスする
- 経営に関係ない雑談には簡潔に応じつつ、本来の役割（経営分析）に戻すよう促す`;

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
    userContent = `${question}\n\n【データコンテキスト（ダッシュボードの実データ）】\n${dataContext}`;
  }
  messages.push({ role: 'user', content: userContent });

  return messages;
}

// ── API パラメータ設定 ──────────────────────────────────────────
// モデル優先順位: 利用可能な最新モデルから順にフォールバック
const MODELS = [
  'claude-sonnet-4-5-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
];
const MAX_TOKENS = 8192;

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

    // ── 利用可能なモデルを特定（最初の1回だけ404/400でフォールバック）──
    let selectedModel = MODELS[0];

    // ── ストリーミングモード ──
    if (useStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // モデルフォールバック: 接続テストとして非ストリーミングで試行し、
      // 404/400ならフォールバック。成功したモデルでストリーミング開始。
      for (let i = 0; i < MODELS.length; i++) {
        selectedModel = MODELS[i];
        console.log(`[chat] Trying model: ${selectedModel}`);
        try {
          const stream = anthropic.messages.stream({
            model: selectedModel,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages,
          });

          // ストリーミングイベントをPromiseで待機
          await new Promise((resolve, reject) => {
            stream.on('text', (text) => {
              res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
            });

            stream.on('error', (error) => {
              reject(error);
            });

            stream.on('end', () => {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
              resolve();
            });

            req.on('close', () => {
              stream.abort();
              resolve();
            });
          });

          res.end();
          return;
        } catch (err) {
          const status = err.status || err.error?.status;
          console.log(`[chat] Model ${selectedModel} failed: ${status || err.message}`);
          // 404(モデル不存在) or 400(パラメータエラー) → 次のモデルで再試行
          if ((status === 404 || status === 400) && i < MODELS.length - 1) {
            continue;
          }
          // それ以外のエラー or 最後のモデル → エラー応答
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'AI応答の生成に失敗しました' })}\n\n`);
          res.end();
          return;
        }
      }
      // ここには到達しないはず
      res.end();
      return;
    }

    // ── 非ストリーミングモード ──
    let lastError;
    for (let i = 0; i < MODELS.length; i++) {
      selectedModel = MODELS[i];
      try {
        console.log(`[chat] Trying model (non-stream): ${selectedModel}`);
        const response = await anthropic.messages.create({
          model: selectedModel,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
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
        console.log(`[chat] Model ${selectedModel} failed: ${status || err.message}`);
        lastError = err;
        if (status !== 404 && status !== 400) break;
      }
    }
    throw lastError;

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
