// ── 顧客管理API v4: 患者DB（GAS）× Square サブスクの照合 ──────────────
// 環境変数:
//   PATIENT_DB_GAS_URL - 患者データベース用GAS WebアプリURL
//   SQUARE_TOKENS      - Square APIトークン（JSON配列）
const API_VERSION = 'v4-omori-only';

export const config = {
  api: { bodyParser: false },
  maxDuration: 300,
};

// ── Square SDK 遅延読み込み ──
let _squareModule = null;
async function getSquareModule() {
  if (!_squareModule) _squareModule = await import('square');
  return _squareModule;
}

// ── Square サブスク顧客を詳細付きで取得 ──
async function getSquareSubscribers(accountFilter) {
  const tokenConfigs = getTokenConfigs(accountFilter);
  if (tokenConfigs.length === 0) return { subscribers: [], debug: 'SQUARE_TOKENS 未設定', errors: [] };

  const allSubscribers = [];
  const debugInfo = [];
  const errors = [];

  for (const cfg of tokenConfigs) {
    const accountName = cfg.name || '(名前なし)';
    try {
      const { Client, Environment } = await getSquareModule();
      const client = new Client({
        accessToken: cfg.token,
        environment: cfg.env === 'sandbox' ? Environment.Sandbox : Environment.Production,
      });

      // 1. ロケーション一覧を取得（認証チェック兼用）
      const locationNames = {};
      let locResp;
      try {
        locResp = await client.locationsApi.listLocations();
        for (const loc of (locResp.result.locations || [])) {
          locationNames[loc.id] = loc.name || loc.id;
        }
      } catch (e) {
        const msg = e.message || String(e);
        if (msg.includes('UNAUTHORIZED') || msg.includes('401')) {
          errors.push({ account: accountName, error: 'トークン認証エラー（UNAUTHORIZED）。Square Developer Dashboardでトークンを再生成してください。' });
          debugInfo.push(`${accountName}: UNAUTHORIZED - スキップ`);
          continue;
        }
        errors.push({ account: accountName, error: `Locations取得エラー: ${msg}` });
        debugInfo.push(`${accountName}: Locations error - ${msg}`);
        continue;
      }

      // 2. サブスクリプション一覧を取得
      let cursor = undefined;
      const subscriptions = [];
      do {
        const resp = await client.subscriptionsApi.searchSubscriptions({
          query: { filter: { locationIds: undefined } },
          cursor,
        });
        if (resp.result.subscriptions) {
          subscriptions.push(...resp.result.subscriptions);
        }
        cursor = resp.result.cursor;
      } while (cursor);

      const activeSubscriptions = subscriptions.filter(s => s.status === 'ACTIVE');
      debugInfo.push(`${accountName}: ${subscriptions.length}件中 ${activeSubscriptions.length}件アクティブ`);

      // 3. 顧客詳細をバッチ取得（名前・電話・メール）
      const customerIds = [...new Set(activeSubscriptions.map(s => s.customerId).filter(Boolean))];
      const customerDetails = {};

      for (let i = 0; i < customerIds.length; i += 10) {
        const batch = customerIds.slice(i, i + 10);
        const promises = batch.map(async (cid) => {
          try {
            const resp = await client.customersApi.retrieveCustomer(cid);
            const c = resp.result.customer;
            const name = [c.familyName, c.givenName].filter(Boolean).join('');
            return {
              id: cid,
              name: name || c.emailAddress || cid,
              familyName: c.familyName || '',
              givenName: c.givenName || '',
              phone: c.phoneNumber || '',
              email: c.emailAddress || '',
            };
          } catch {
            return { id: cid, name: cid, familyName: '', givenName: '', phone: '', email: '' };
          }
        });
        const results = await Promise.all(promises);
        results.forEach(r => { customerDetails[r.id] = r; });
      }

      // 4. サブスクリプションごとにデータをまとめる（インボイス取得はスキップ — 高速化）
      // 決済回数はstartDate→chargedThroughDateの月数で推算
      for (const sub of activeSubscriptions) {
        const customer = customerDetails[sub.customerId] || { name: '不明', phone: '', email: '' };
        const storeName = locationNames[sub.locationId] || accountName;

        // startDate→chargedThroughDateの月数で決済回数を推算
        let paymentCount = 0;
        let totalAmount = 0;
        const planAmount = sub.planVariationData?.phases?.[0]?.orderTemplate?.lineItems?.[0]?.basePriceMoney?.amount;
        const monthlyAmt = planAmount ? Number(planAmount) : 0;

        if (sub.startDate && sub.chargedThroughDate) {
          const start = new Date(sub.startDate);
          const charged = new Date(sub.chargedThroughDate);
          if (!isNaN(start.getTime()) && !isNaN(charged.getTime())) {
            paymentCount = Math.max(1, Math.round((charged - start) / (30.44 * 24 * 60 * 60 * 1000)));
            totalAmount = monthlyAmt * paymentCount;
          }
        }

        allSubscribers.push({
          name: customer.name,
          familyName: customer.familyName,
          givenName: customer.givenName,
          phone: customer.phone,
          email: customer.email,
          customerId: sub.customerId,
          monthlyAmount: planAmount ? Number(planAmount) : 0,
          store: storeName,
          subscriptionId: sub.id,
          paymentCount,
          totalAmount,
          lastPaymentDate: sub.chargedThroughDate || '',
          startDate: sub.startDate || '',
          chargedThroughDate: sub.chargedThroughDate || '',
        });
      }
    } catch (err) {
      errors.push({ account: accountName, error: err.message });
      debugInfo.push(`${accountName}: ERROR - ${err.message}`);
    }
  }

  return { subscribers: allSubscribers, debug: debugInfo.join(' / '), errors };
}

function getTokenConfigs(accountFilter) {
  let tokens = [];
  if (process.env.SQUARE_TOKENS) {
    try {
      const parsed = JSON.parse(process.env.SQUARE_TOKENS.trim());
      if (Array.isArray(parsed) && parsed.length > 0) tokens = parsed;
    } catch (e) {
      console.error('[customers] SQUARE_TOKENS parse error:', e.message);
    }
  }
  if (tokens.length === 0 && process.env.SQUARE_ACCESS_TOKEN) {
    tokens = [{
      name: '',
      token: process.env.SQUARE_ACCESS_TOKEN,
      env: process.env.SQUARE_ENVIRONMENT || 'production',
    }];
  }

  // アカウントフィルター: 指定されたアカウントのみ使用（マッチなしなら空配列）
  if (accountFilter && tokens.length > 0) {
    const filtered = tokens.filter(t =>
      (t.name || '').includes(accountFilter) || accountFilter.includes(t.name || '')
    );
    if (filtered.length > 0) {
      console.log(`[customers] Account filter "${accountFilter}" matched ${filtered.length} token(s): ${filtered.map(t => t.name).join(', ')}`);
      return filtered;
    }
    console.warn(`[customers] Account filter "${accountFilter}" matched 0 of ${tokens.length} tokens. Available: ${tokens.map(t => t.name || '(no name)').join(', ')}`);
    return []; // フィルターにマッチしなければ空（全アカウント取得を防止）
  }
  return tokens;
}

// ── 月別離反者を計算 ──
function computeMonthlyChurn(patients) {
  const periods = [
    { label: '11月の離反', activeMonth: '2025-11', churnMonth: '2025-12', description: '2025年11月に来院 → 12月に未来院' },
    { label: '12月の離反', activeMonth: '2025-12', churnMonth: '2026-01', description: '2025年12月に来院 → 2026年1月に未来院' },
    { label: '1月の離反', activeMonth: '2026-01', churnMonth: '2026-02', description: '2026年1月に来院 → 2月に未来院' },
    { label: '2月の離反（予測）', activeMonth: '2026-02', churnMonth: '2026-03', description: '2026年2月に来院 → 3月現在まだ未来院' },
  ];

  const results = [];
  for (const period of periods) {
    const [activeYear, activeMonthNum] = period.activeMonth.split('-').map(Number);
    const churnedPatients = patients.filter(p => {
      if (!p.lastVisitDate) return false;
      const lastVisit = parseJapaneseDate(p.lastVisitDate);
      if (!lastVisit) return false;
      return lastVisit.getFullYear() === activeYear && (lastVisit.getMonth() + 1) === activeMonthNum;
    });

    results.push({
      ...period,
      patients: churnedPatients.map(p => ({
        name: p.name,
        lastVisitDate: p.lastVisitDate,
        store: p.store || '',
        phone: p.phone || '',
        hasSubscription: false,
      })),
      count: churnedPatients.length,
    });
  }
  return results;
}

// ── 照合ロジック: 電話番号メイン + 名前サブ ──
function matchPatientToSubscriber(patient, subscribersByPhone, subscribersByEmail, subscribersByName) {
  // 1. 電話番号照合（最優先 — 漢字/カタカナ問題を回避）
  if (patient.phone) {
    const normalized = normalizePhone(patient.phone);
    if (normalized.length >= 8 && subscribersByPhone[normalized]) {
      return { match: subscribersByPhone[normalized], method: '電話番号' };
    }
  }

  // 2. メールアドレス照合
  if (patient.email) {
    const normalizedEmail = (patient.email || '').toLowerCase().trim();
    if (normalizedEmail && subscribersByEmail[normalizedEmail]) {
      return { match: subscribersByEmail[normalizedEmail], method: 'メール' };
    }
  }

  // 3. 名前照合（完全一致 — 同じ文字体系の場合のみマッチ）
  const pName = normalizeJapaneseName(patient.name);
  if (pName && subscribersByName[pName]) {
    return { match: subscribersByName[pName], method: '名前一致' };
  }

  // 4. 部分一致（姓名逆順含む）
  for (const [key, sub] of Object.entries(subscribersByName)) {
    if (sub.familyName && sub.givenName) {
      const reversed = normalizeJapaneseName(sub.givenName + sub.familyName);
      if (pName === reversed) return { match: sub, method: '名前(逆順)' };
    }
    if (pName.length >= 2 && key.length >= 2) {
      if (pName.includes(key) || key.includes(pName)) {
        return { match: sub, method: '名前(部分)' };
      }
    }
  }

  return null;
}

function normalizePhone(phone) {
  // 全角→半角変換 + 記号除去 + 先頭0除去
  return (phone || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-\(\)（）+＋・]/g, '')
    .replace(/^0/, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const gasUrl = process.env.PATIENT_DB_GAS_URL;
    if (!gasUrl) {
      return res.status(500).json({
        error: 'PATIENT_DB_GAS_URL is not configured',
        message: 'Vercelの環境変数に PATIENT_DB_GAS_URL を設定してください。',
        setupRequired: true,
      });
    }

    // accountパラメータでSquareアカウントを絞り込み（例: ?account=大森院）
    const accountFilter = req.query?.account || '大森院';

    // 患者データとSquareサブスクを並列取得
    const squareWithTimeout = Promise.race([
      getSquareSubscribers(accountFilter),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Square API timeout (120s)')), 120000)),
    ]).catch(err => {
      console.error('[customers] Square fetch skipped:', err.message);
      return { subscribers: [], debug: `Error: ${err.message}`, errors: [{ account: 'ALL', error: err.message }] };
    });

    const [patientsResult, squareResult] = await Promise.all([
      fetchPatientData(gasUrl),
      squareWithTimeout,
    ]);

    const patients = patientsResult;
    const squareSubscribers = squareResult.subscribers || [];
    const squareDebug = squareResult.debug || '';
    const squareErrors = squareResult.errors || [];

    // 月別離反者を計算
    const monthlyChurn = computeMonthlyChurn(patients);

    // Square照合用インデックス作成
    const subscribersByPhone = {};
    const subscribersByEmail = {};
    const subscribersByName = {};

    for (const sub of squareSubscribers) {
      // 電話番号インデックス
      if (sub.phone) {
        const normalized = normalizePhone(sub.phone);
        if (normalized.length >= 8) subscribersByPhone[normalized] = sub;
      }
      // メールインデックス
      if (sub.email) {
        subscribersByEmail[sub.email.toLowerCase().trim()] = sub;
      }
      // 名前インデックス
      const normalizedName = normalizeJapaneseName(sub.name);
      if (normalizedName) subscribersByName[normalizedName] = sub;
    }

    // 離反者にSquareデータを付与
    let totalMatched = 0;
    const matchMethods = {};
    for (const period of monthlyChurn) {
      for (const p of period.patients) {
        const result = matchPatientToSubscriber(p, subscribersByPhone, subscribersByEmail, subscribersByName);
        if (result) {
          const { match, method } = result;
          p.hasSubscription = true;
          p.monthlyAmount = match.monthlyAmount;
          p.subscriptionStore = match.store;
          p.paymentCount = match.paymentCount;
          p.totalAmount = match.totalAmount;
          p.lastPaymentDate = match.lastPaymentDate;
          p.squareName = match.name;
          p.matchMethod = method;
          totalMatched++;
          matchMethods[method] = (matchMethods[method] || 0) + 1;
        }
      }
      period.patients.sort((a, b) => {
        if (a.hasSubscription && !b.hasSubscription) return -1;
        if (!a.hasSubscription && b.hasSubscription) return 1;
        return 0;
      });
      period.subsCount = period.patients.filter(p => p.hasSubscription).length;
    }

    // サブスク決済アラート
    const allSubsAlerts = [];
    for (const period of monthlyChurn) {
      for (const p of period.patients) {
        if (p.hasSubscription) {
          allSubsAlerts.push({ ...p, churnPeriod: period.label, churnDescription: period.description });
        }
      }
    }

    // デバッグ用: Square側のサンプルデータ（上位5件）
    const squareSample = squareSubscribers.slice(0, 5).map(s => ({
      name: s.name,
      phone: s.phone ? s.phone.slice(0, 4) + '****' : 'なし',
      email: s.email ? s.email.split('@')[0].slice(0, 3) + '***@...' : 'なし',
    }));

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({
      monthlyChurn,
      subsAlerts: allSubsAlerts,
      summary: {
        totalPatients: patients.length,
        totalChurned: monthlyChurn.reduce((sum, p) => sum + p.count, 0),
        subsAlertCount: allSubsAlerts.length,
        squareSubscribers: squareSubscribers.length,
        matchedCount: totalMatched,
        matchMethods,
      },
      squareAvailable: squareSubscribers.length > 0,
      squareDebug,
      squareErrors,
      squareSample,
      apiVersion: API_VERSION,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[customers] Error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

// ── GASから患者データを取得（30秒タイムアウト） ──
async function fetchPatientData(gasUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(gasUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GAS API returned ${response.status}`);
    const data = await response.json();

    if (Array.isArray(data)) return data;
    if (data.patients && Array.isArray(data.patients)) return data.patients;
    if (data.values && Array.isArray(data.values)) return parseSpreadsheetRows(data.values);

    console.warn('[customers] Unexpected GAS response format:', Object.keys(data));
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function parseSpreadsheetRows(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0];
  const nameIdx = headers.findIndex(h => h && (h.includes('患者名') || h.includes('氏名') || h.includes('名前')));
  const lastVisitIdx = headers.findIndex(h => h && (h.includes('最終来院') || h.includes('最終来店')));
  const storeIdx = headers.findIndex(h => h && (h.includes('店舗') || h.includes('院')));
  const phoneIdx = headers.findIndex(h => h && (h.includes('電話') || h.includes('TEL')));

  return rows.slice(1).map(row => ({
    name: nameIdx >= 0 ? (row[nameIdx] || '') : '',
    lastVisitDate: lastVisitIdx >= 0 ? (row[lastVisitIdx] || '') : '',
    store: storeIdx >= 0 ? (row[storeIdx] || '') : '',
    phone: phoneIdx >= 0 ? (row[phoneIdx] || '') : '',
  })).filter(p => p.name);
}

function parseJapaneseDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoMatch) return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) return new Date(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]));
  const jpMatch = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jpMatch) return new Date(Number(jpMatch[1]), Number(jpMatch[2]) - 1, Number(jpMatch[3]));
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeJapaneseName(name) {
  return (name || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\(\)（）]/g, '')
    .trim();
}
