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

// ── Square サブスク顧客を詳細付きで取得 ──
async function getSquareSubscribers() {
  const tokenConfigs = getTokenConfigs();
  if (tokenConfigs.length === 0) return { subscribers: [], debug: 'No tokens configured' };

  const allSubscribers = [];
  const debugInfo = [];

  for (const cfg of tokenConfigs) {
    try {
      const { Client, Environment } = await getSquareModule();
      const client = new Client({
        accessToken: cfg.token,
        environment: cfg.env === 'sandbox' ? Environment.Sandbox : Environment.Production,
      });

      // 1. ロケーション一覧を取得（店舗名用）
      const locationNames = {};
      try {
        const locResp = await client.locationsApi.listLocations();
        for (const loc of (locResp.result.locations || [])) {
          locationNames[loc.id] = loc.name || loc.id;
        }
      } catch (e) {
        console.error(`[customers] Locations fetch error (${cfg.name}):`, e.message);
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
      debugInfo.push(`${cfg.name || 'account'}: ${subscriptions.length} total subs, ${activeSubscriptions.length} active`);

      // 3. 顧客IDを収集してバッチで詳細取得（名前・電話・メール）
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

      // 4. インボイス取得（決済回数・合計金額・最終決済日用）
      // 全ロケーションのインボイスを取得
      const invoicesByCustomer = {};
      const locationIds = Object.keys(locationNames);

      for (const locId of locationIds) {
        try {
          let invCursor = undefined;
          do {
            const invResp = await client.invoicesApi.listInvoices({
              locationId: locId,
              cursor: invCursor,
            });
            for (const inv of (invResp.result.invoices || [])) {
              const custId = inv.primaryRecipient?.customerId;
              if (!custId) continue;
              if (!invoicesByCustomer[custId]) invoicesByCustomer[custId] = [];

              // PAID or PARTIALLY_PAIDのインボイスのみカウント
              if (inv.status === 'PAID' || inv.status === 'PARTIALLY_PAID') {
                const pr = inv.paymentRequests?.[0];
                const amount = pr?.computedAmountMoney?.amount || pr?.totalCompletedAmountMoney?.amount || 0;
                invoicesByCustomer[custId].push({
                  amount: Number(amount),
                  date: pr?.dueDate || inv.createdAt?.split('T')[0] || '',
                  status: inv.status,
                });
              }
            }
            invCursor = invResp.result.cursor;
          } while (invCursor);
        } catch (e) {
          console.error(`[customers] Invoices fetch error (${locId}):`, e.message);
        }
      }

      // 5. サブスクリプションごとにデータをまとめる
      for (const sub of activeSubscriptions) {
        const customer = customerDetails[sub.customerId] || { name: '不明', phone: '', email: '' };
        const storeName = locationNames[sub.locationId] || cfg.name || '';
        const invoices = invoicesByCustomer[sub.customerId] || [];

        // 決済回数・合計金額・最終決済日を計算
        const paymentCount = invoices.length;
        const totalAmount = invoices.reduce((sum, inv) => sum + inv.amount, 0);
        const lastPaymentDate = invoices.length > 0
          ? invoices.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].date
          : sub.chargedThroughDate || '';

        const planAmount = sub.planVariationData?.phases?.[0]?.orderTemplate?.lineItems?.[0]?.basePriceMoney?.amount;

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
          lastPaymentDate,
          startDate: sub.startDate || '',
          chargedThroughDate: sub.chargedThroughDate || '',
        });
      }
    } catch (err) {
      console.error(`[customers] Square API error (${cfg.name}):`, err.message);
      debugInfo.push(`${cfg.name || 'account'}: ERROR - ${err.message}`);
    }
  }

  return { subscribers: allSubscribers, debug: debugInfo.join('; ') };
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
      const lvYear = lastVisit.getFullYear();
      const lvMonth = lastVisit.getMonth() + 1;
      return lvYear === activeYear && lvMonth === activeMonthNum;
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

// ── 名前照合ロジック（複数手段で照合） ──
function matchPatientToSubscriber(patient, subscriberMap, subscribersByPhone) {
  const pName = normalizeJapaneseName(patient.name);

  // 1. フルネーム完全一致
  if (subscriberMap[pName]) return subscriberMap[pName];

  // 2. スペースなし/あり両方試行（「田中太郎」vs「田中 太郎」）
  // subscriberMapは既にスペース除去済みなので、患者名もスペース除去して比較
  // → これは normalizeJapaneseName で既に実施済み

  // 3. 姓名逆順の照合（「太郎田中」→「田中太郎」）
  for (const [key, sub] of Object.entries(subscriberMap)) {
    // 姓+名 vs 名+姓の照合
    if (sub.familyName && sub.givenName) {
      const reversed = normalizeJapaneseName(sub.givenName + sub.familyName);
      if (pName === reversed) return sub;
    }
    // 部分一致（患者名がSubscriber名を含む or 逆）
    if (pName.length >= 2 && key.length >= 2) {
      if (pName.includes(key) || key.includes(pName)) return sub;
    }
  }

  // 4. 電話番号照合（補助的）
  if (patient.phone && subscribersByPhone[normalizePhone(patient.phone)]) {
    return subscribersByPhone[normalizePhone(patient.phone)];
  }

  return null;
}

function normalizePhone(phone) {
  return (phone || '').replace(/[\s\-\(\)（）+]/g, '').replace(/^0/, '');
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
    const squareWithTimeout = Promise.race([
      getSquareSubscribers(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Square API timeout (120s)')), 120000)),
    ]).catch(err => {
      console.error('[customers] Square fetch skipped:', err.message);
      return { subscribers: [], debug: `Error: ${err.message}` };
    });

    const [patientsResult, squareResult] = await Promise.all([
      fetchPatientData(gasUrl),
      squareWithTimeout,
    ]);

    const patients = patientsResult;
    const squareSubscribers = squareResult.subscribers || [];
    const squareDebug = squareResult.debug || '';

    // 月別離反者を計算
    const monthlyChurn = computeMonthlyChurn(patients);

    // Square照合用マップ作成
    const subscriberMap = {};
    const subscribersByPhone = {};
    for (const sub of squareSubscribers) {
      const normalized = normalizeJapaneseName(sub.name);
      subscriberMap[normalized] = sub;
      if (sub.phone) {
        subscribersByPhone[normalizePhone(sub.phone)] = sub;
      }
    }

    // 離反者にSquareデータを付与
    let totalMatched = 0;
    for (const period of monthlyChurn) {
      for (const p of period.patients) {
        const matched = matchPatientToSubscriber(p, subscriberMap, subscribersByPhone);
        if (matched) {
          p.hasSubscription = true;
          p.monthlyAmount = matched.monthlyAmount;
          p.subscriptionStore = matched.store;
          p.paymentCount = matched.paymentCount;
          p.totalAmount = matched.totalAmount;
          p.lastPaymentDate = matched.lastPaymentDate;
          p.squareName = matched.name; // 照合確認用
          totalMatched++;
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
        matchedCount: totalMatched,
      },
      squareAvailable: squareSubscribers.length > 0,
      squareDebug,
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
    .replace(/[\s\u3000]+/g, '') // 全角半角スペース除去
    .replace(/[\(\)（）]/g, '') // 括弧除去
    .trim();
}
