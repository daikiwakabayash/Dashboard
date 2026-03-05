// ── タスク管理 API: GAS スプレッドシート連携 ──────────────────
// 環境変数: TASKS_GAS_URL - タスク管理用GAS WebアプリURL
//
// GET  /api/tasks?yearMonth=2026-03  → 月次目標 + 週次タスク取得
// POST /api/tasks                     → タスク操作（upsertGoal/deleteGoal/toggleGoal/upsertTask/deleteTask/toggleTask）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const tasksUrl = process.env.TASKS_GAS_URL;

  // ── GET: タスクデータ取得 ──
  if (req.method === 'GET') {
    if (!tasksUrl) {
      return res.status(200).json({ goals: [], tasks: [], message: 'TASKS_GAS_URL is not configured' });
    }

    const { yearMonth } = req.query;
    const url = yearMonth ? `${tasksUrl}?action=list&yearMonth=${encodeURIComponent(yearMonth)}` : `${tasksUrl}?action=list`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`GAS returned ${response.status}`);
      const data = await response.json();
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
      return res.status(200).json(data);
    } catch (err) {
      console.error('[tasks] GET error:', err.message);
      return res.status(502).json({ error: 'Failed to fetch tasks', message: err.message });
    }
  }

  // ── POST: タスク操作 ──
  if (req.method === 'POST') {
    if (!tasksUrl) {
      return res.status(500).json({
        error: 'TASKS_GAS_URL is not configured',
        message: 'Vercelの環境変数にTASKS_GAS_URLを設定してください。'
      });
    }

    const body = req.body || {};
    if (!body.action) {
      return res.status(400).json({ error: 'action is required' });
    }

    try {
      const response = await fetch(tasksUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`GAS returned ${response.status}`);
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) {
      console.error('[tasks] POST error:', err.message);
      return res.status(502).json({ error: 'Failed to update task', message: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
