// ── 顧客管理API: 患者DB（GAS）× Square サブスクの照合 ──────────────
// 環境変数:
//   PATIENT_DB_GAS_URL - 患者データベース用GAS WebアプリURL
//   SQUARE_TOKENS      - Square APIトークン（JSON配列）

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

// ── Square サブスク顧客を取得 ──
async function getSquareSubscribers() {
  const tokenConfigs = getTokenConfigs();
  if (tokenConfigs.length === 0) return [];

  const allSubscribers = [];

  for (const cfg of tokenConfigs) {
    try {
      const { Client, Environment } = await getSquareModule();
      const client = new Client({
        accessToken: cfg.token,
        environment: cfg.env === 'sandbox' ? Environment.Sandbox : Environment.Production,
      });

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

      // 顧客IDを収集してバッチで名前取得
      const customerIds = [...new Set(activeSubscriptions.map(s => s.customerId).filter(Boolean))];
      const customerNames = {};

      for (let i = 0; i < customerIds.length; i += 10) {
        const batch = customerIds.slice(i, i + 10);
        const promises = batch.map(async (cid) => {
          try {
            const resp = await client.customersApi.retrieveCustomer(cid);
            const c = resp.result.customer;
            const name = [c.familyName, c.givenName].filter(Boolean).join('');
            return { id: cid, name: name || c.emailAddress || cid };
          } catch {
            return { id: cid, name: cid };
          }
        });
        const results = await Promise.all(promises);
        results.forEach(r => { customerNames[r.id] = r.name; });
      }

      for (const sub of activeSubscriptions) {
        const planAmount = sub.planVariationData?.phases?.[0]?.orderTemplate?.lineItems?.[0]?.basePriceMoney?.amount;
        allSubscribers.push({
          name: customerNames[sub.customerId] || sub.customerId || '不明',
          customerId: sub.customerId,
          monthlyAmount: planAmount ? Number(planAmount) : 0,
          store: cfg.name || '',
          subscriptionId: sub.id,
        });
      }
    } catch (err) {
      console.error(`[customers] Square API error (${cfg.name}):`, err.message);
    }
  }

  return allSubscribers;
}

function getTokenConfigs() {
  if (process.env.SQUARE_TOKENS) {
    try {
      const tokens = JSON.parse(process.env.SQUARE_TOKENS.trim());
      if (Array.isArray(tokens) && tokens.length > 0) return tokens;
    } catch (e) {
      console.error('[customers] SQUARE_TOKENS parse error:', e.message);
    }
  }
  if (process.env.SQUARE_ACCESS_TOKEN) {
    return [{
      name: '',
      token: process.env.SQUARE_ACCESS_TOKEN,
      env: process.env.SQUARE_ENVIRONMENT || 'production',
    }];
  }
  return [];
}

// ── 月別離反者を計算 ──
function computeMonthlyChurn(patients) {
  // 対象期間: 2025年11月〜2026年3月
  const periods = [
    { label: '11月の離反', activeMonth: '2025-11', churnMonth: '2025-12', description: '2025年11月に来院 → 12月に未来院' },
    { label: '12月の離反', activeMonth: '2025-12', churnMonth: '2026-01', description: '2025年12月に来院 → 2026年1月に未来院' },
    { label: '1月の離反', activeMonth: '2026-01', churnMonth: '2026-02', description: '2026年1月に来院 → 2月に未来院' },
    { label: '2月の離反（予測）', activeMonth: '2026-02', churnMonth: '2026-03', description: '2026年2月に来院 → 3月現在まだ未来院' },
  ];

  const results = [];

  for (const period of periods) {
    const [activeYear, activeMonthNum] = period.activeMonth.split('-').map(Number);
    const [churnYear, churnMonthNum] = period.churnMonth.split('-').map(Number);

    const churnedPatients = patients.filter(p => {
      if (!p.lastVisitDate) return false;
      const lastVisit = parseJapaneseDate(p.lastVisitDate);
      if (!lastVisit) return false;

      const lvYear = lastVisit.getFullYear();
      const lvMonth = lastVisit.getMonth() + 1; // 1-based

      // 最終来院がactiveMonth（来院していた月）に該当
      // = 最終来院日がactiveMonth中 → つまりchurnMonth以降は来ていない
      if (lvYear === activeYear && lvMonth === activeMonthNum) {
        return true;
      }
      return false;
    });

    results.push({
      ...period,
      patients: churnedPatients.map(p => ({
        name: p.name,
        lastVisitDate: p.lastVisitDate,
        store: p.store || '',
        phone: p.phone || '',
        hasSubscription: false, // 後で付与
      })),
      count: churnedPatients.length,
    });
  }

  return results;
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

    // 患者データとSquareサブスクを並列取得
    // Square APIは45秒タイムアウト（遅い場合は患者データだけで返す）
    const squareWithTimeout = Promise.race([
      getSquareSubscribers(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Square API timeout')), 45000)),
    ]).catch(err => {
      console.error('[customers] Square fetch skipped:', err.message);
      return [];
    });

    const [patientsResult, squareSubscribers] = await Promise.all([
      fetchPatientData(gasUrl),
      squareWithTimeout,
    ]);

    const patients = patientsResult;

    // 月別離反者を計算
    const monthlyChurn = computeMonthlyChurn(patients);

    // Square照合: サブスク契約者名のセット
    const subscriberMap = {};
    for (const sub of squareSubscribers) {
      const normalized = normalizeJapaneseName(sub.name);
      subscriberMap[normalized] = sub;
    }

    // 離反者にサブスクフラグを付与
    for (const period of monthlyChurn) {
      for (const p of period.patients) {
        const normalized = normalizeJapaneseName(p.name);
        const sub = subscriberMap[normalized];
        if (sub) {
          p.hasSubscription = true;
          p.monthlyAmount = sub.monthlyAmount;
          p.subscriptionStore = sub.store;
        }
      }
      // サブスクありを先頭に、その後は最終来院日の降順
      period.patients.sort((a, b) => {
        if (a.hasSubscription && !b.hasSubscription) return -1;
        if (!a.hasSubscription && b.hasSubscription) return 1;
        return 0;
      });
      period.subsCount = period.patients.filter(p => p.hasSubscription).length;
    }

    // サブスク決済アラート: 全離反者の中でサブスクが続いている人
    const allSubsAlerts = [];
    for (const period of monthlyChurn) {
      for (const p of period.patients) {
        if (p.hasSubscription) {
          allSubsAlerts.push({
            ...p,
            churnPeriod: period.label,
            churnDescription: period.description,
          });
        }
      }
    }

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({
      monthlyChurn,
      subsAlerts: allSubsAlerts,
      summary: {
        totalPatients: patients.length,
        totalChurned: monthlyChurn.reduce((sum, p) => sum + p.count, 0),
        subsAlertCount: allSubsAlerts.length,
        squareSubscribers: squareSubscribers.length,
      },
      squareAvailable: squareSubscribers.length > 0,
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

    if (!response.ok) {
      throw new Error(`GAS API returned ${response.status}`);
    }

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

// ── 日付パーサー ──
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
