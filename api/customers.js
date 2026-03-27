// ── 顧客管理API: 患者DB（GAS）× Square サブスクの照合 ──────────────
// 環境変数:
//   PATIENT_DB_GAS_URL - 患者データベース用GAS WebアプリURL
//   SQUARE_TOKENS      - Square APIトークン（JSON配列）

export const config = {
  api: { bodyParser: false },
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

  for (const config of tokenConfigs) {
    try {
      const { Client, Environment } = await getSquareModule();
      const client = new Client({
        accessToken: config.token,
        environment: config.env === 'sandbox' ? Environment.Sandbox : Environment.Production,
      });

      // サブスクリプション一覧を取得
      let cursor = undefined;
      const subscriptions = [];
      do {
        const resp = await client.subscriptionsApi.searchSubscriptions({
          query: {
            filter: {
              locationIds: undefined,
            },
          },
          cursor,
        });
        if (resp.result.subscriptions) {
          subscriptions.push(...resp.result.subscriptions);
        }
        cursor = resp.result.cursor;
      } while (cursor);

      // アクティブなサブスクのみ（ACTIVE状態）
      const activeSubscriptions = subscriptions.filter(s => s.status === 'ACTIVE');

      // 顧客IDを収集してバッチで名前取得
      const customerIds = [...new Set(activeSubscriptions.map(s => s.customerId).filter(Boolean))];
      const customerNames = {};

      // 10件ずつバッチで顧客情報取得
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
          store: config.name || '',
          subscriptionId: sub.id,
        });
      }
    } catch (err) {
      console.error(`[customers] Square API error (${config.name}):`, err.message);
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
        message: 'Vercelの環境変数に PATIENT_DB_GAS_URL を設定してください。患者データベースのGAS WebアプリURLが必要です。',
      });
    }

    // 患者データとSquareサブスクを並列取得
    const [patientsResult, squareSubscribers] = await Promise.all([
      fetchPatientData(gasUrl),
      getSquareSubscribers().catch(err => {
        console.error('[customers] Square fetch error:', err.message);
        return [];
      }),
    ]);

    const patients = patientsResult;
    const today = new Date();

    // 各患者の経過日数を計算
    const patientsWithDays = patients.map(p => {
      let daysSinceLastVisit = null;
      if (p.lastVisitDate) {
        const lastVisit = parseJapaneseDate(p.lastVisitDate);
        if (lastVisit) {
          daysSinceLastVisit = Math.floor((today - lastVisit) / (1000 * 60 * 60 * 24));
        }
      }
      return { ...p, daysSinceLastVisit };
    });

    // 30日以上来院がない患者
    const noVisitPatients = patientsWithDays
      .filter(p => p.daysSinceLastVisit !== null && p.daysSinceLastVisit >= 30)
      .sort((a, b) => b.daysSinceLastVisit - a.daysSinceLastVisit);

    // サブスク決済が発生しているが来院していない患者を照合
    const subsAlerts = [];
    if (squareSubscribers.length > 0) {
      for (const sub of squareSubscribers) {
        // 名前で照合（部分一致）
        const matchedPatient = patientsWithDays.find(p => {
          if (!p.name || !sub.name) return false;
          const pName = normalizeJapaneseName(p.name);
          const sName = normalizeJapaneseName(sub.name);
          return pName === sName || pName.includes(sName) || sName.includes(pName);
        });

        if (matchedPatient && matchedPatient.daysSinceLastVisit !== null && matchedPatient.daysSinceLastVisit >= 30) {
          subsAlerts.push({
            name: matchedPatient.name,
            lastVisitDate: matchedPatient.lastVisitDate,
            daysSinceLastVisit: matchedPatient.daysSinceLastVisit,
            monthlyAmount: sub.monthlyAmount,
            store: sub.store || matchedPatient.store || '',
            subscriptionId: sub.subscriptionId,
            hasSubscription: true,
          });
        } else if (!matchedPatient) {
          // 患者DBに見つからないサブスク契約者
          subsAlerts.push({
            name: sub.name,
            lastVisitDate: null,
            daysSinceLastVisit: null,
            monthlyAmount: sub.monthlyAmount,
            store: sub.store || '',
            subscriptionId: sub.subscriptionId,
            hasSubscription: true,
            notInDatabase: true,
          });
        }
      }
    }

    // 患者にサブスクフラグを追加
    const subscriberNames = new Set(squareSubscribers.map(s => normalizeJapaneseName(s.name)));
    const enrichedPatients = patientsWithDays.map(p => ({
      ...p,
      hasSubscription: subscriberNames.has(normalizeJapaneseName(p.name || '')),
    }));
    const enrichedNoVisit = noVisitPatients.map(p => ({
      ...p,
      hasSubscription: subscriberNames.has(normalizeJapaneseName(p.name || '')),
    }));

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({
      patients: enrichedPatients,
      noVisitPatients: enrichedNoVisit,
      subsAlerts,
      summary: {
        totalPatients: enrichedPatients.length,
        noVisitCount: enrichedNoVisit.length,
        subsAlertCount: subsAlerts.length,
        squareSubscribers: squareSubscribers.length,
      },
    });
  } catch (err) {
    console.error('[customers] Error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

// ── GASから患者データを取得 ──
async function fetchPatientData(gasUrl) {
  const response = await fetch(gasUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`GAS API returned ${response.status}`);
  }

  const data = await response.json();

  // GASから返されるデータ形式に応じてパース
  // 期待形式: { patients: [{ name, lastVisitDate, store, ... }] }
  // または配列形式: [{ name, lastVisitDate, store, ... }]
  if (Array.isArray(data)) {
    return data;
  }
  if (data.patients && Array.isArray(data.patients)) {
    return data.patients;
  }
  // スプレッドシートの行データが直接返ってくる場合
  if (data.values && Array.isArray(data.values)) {
    return parseSpreadsheetRows(data.values);
  }

  console.warn('[customers] Unexpected GAS response format:', Object.keys(data));
  return [];
}

// ── スプレッドシートの行データをパース ──
function parseSpreadsheetRows(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0];
  const nameIdx = headers.findIndex(h => h && (h.includes('患者名') || h.includes('氏名') || h.includes('名前')));
  const lastVisitIdx = headers.findIndex(h => h && (h.includes('最終来院') || h.includes('最終来店')));
  const storeIdx = headers.findIndex(h => h && (h.includes('店舗') || h.includes('院')));

  return rows.slice(1).map(row => ({
    name: nameIdx >= 0 ? (row[nameIdx] || '') : '',
    lastVisitDate: lastVisitIdx >= 0 ? (row[lastVisitIdx] || '') : '',
    store: storeIdx >= 0 ? (row[storeIdx] || '') : '',
  })).filter(p => p.name);
}

// ── 日付パーサー（日本語形式対応） ──
function parseJapaneseDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();

  // YYYY/MM/DD or YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }

  // MM/DD/YYYY
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    return new Date(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]));
  }

  // 日本語: YYYY年MM月DD日
  const jpMatch = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jpMatch) {
    return new Date(Number(jpMatch[1]), Number(jpMatch[2]) - 1, Number(jpMatch[3]));
  }

  // Date.parseで最終手段
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// ── 名前の正規化（照合用） ──
function normalizeJapaneseName(name) {
  return (name || '')
    .replace(/[\s\u3000]+/g, '') // 全角半角スペース除去
    .replace(/[\(\)（）]/g, '') // 括弧除去
    .trim();
}
