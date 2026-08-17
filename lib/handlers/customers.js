// ── 顧客管理API v8: 患者DB（GAS）のみ ──────────────
// Square照合はフロントエンドで /api/square/metrics のデータと突き合わせる
// 環境変数:
//   PATIENT_DB_GAS_URL - 患者データベース用GAS WebアプリURL
const API_VERSION = 'v8-no-square';

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

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

    const patients = await fetchPatientData(gasUrl);
    const monthlyChurn = computeMonthlyChurn(patients);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(200).json({
      monthlyChurn,
      summary: {
        totalPatients: patients.length,
        totalChurned: monthlyChurn.reduce((sum, p) => sum + p.count, 0),
      },
      apiVersion: API_VERSION,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[customers] Error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
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
