// ── 事業計画: データ計算ロジック（テスト用に分離） ──
// index.html の computePlanActuals と同等のロジック

const vn = (n) => (n == null || isNaN(n) || !isFinite(n)) ? 0 : Math.round(n);

/**
 * 店舗別の実績データを計算する
 * @param {Array} rawData - 経営データ配列
 * @param {Array} mktData - マーケティングデータ配列
 * @param {string} branchName - 対象店舗名（空文字なら全店舗）
 * @returns {Object} 計算結果
 */
export function computePlanActuals(rawData, mktData, branchName) {
  const allMonths = [...new Set(rawData.map(d => d.month).filter(Boolean))].sort();
  const latestMonth = allMonths[allMonths.length - 1] || '';
  const prevMonth = allMonths[allMonths.length - 2] || '';
  const branchFilter = branchName ? (d => d.branch === branchName) : (() => true);

  const curData = rawData.filter(d => d.month === latestMonth).filter(branchFilter);
  const prevData = rawData.filter(d => d.month === prevMonth).filter(branchFilter);

  const totalSales = curData.reduce((s, d) => s + vn(d.individualSales), 0);
  const totalNewCount = curData.reduce((s, d) => s + vn(d.newCount), 0);
  const totalNewEnroll = curData.reduce((s, d) => s + vn(d.newEnroll), 0);
  const enrollRate = totalNewCount > 0 ? Math.round((totalNewEnroll / totalNewCount) * 100) : 0;
  const churnCount = curData.reduce((s, d) => s + vn(d.churnCount), 0);
  const prevMembers = curData.reduce((s, d) => s + vn(d.prevMembers), 0);
  const churnRate = prevMembers > 0 ? Math.round((churnCount / prevMembers) * 100) : 0;
  const prevSales = prevData.reduce((s, d) => s + vn(d.individualSales), 0);
  const prevNewCount = prevData.reduce((s, d) => s + vn(d.newCount), 0);

  // マーケティング: 媒体別CPA
  const mktFilter = branchName ? (d => d.branch === branchName) : (() => true);
  const curMkt = mktData.filter(d => d.month === latestMonth && d.media !== '全媒体合計').filter(mktFilter);
  const totalAdSpend = curMkt.reduce((s, d) => s + (d.adSpend || 0), 0);
  const mktNewCount = curMkt.reduce((s, d) => s + (d.newCount || 0), 0);
  const cpa = mktNewCount > 0 ? Math.round(totalAdSpend / mktNewCount) : 0;

  // 媒体別内訳
  const mediaMap = {};
  curMkt.forEach(d => {
    if (!d.media) return;
    if (!mediaMap[d.media]) mediaMap[d.media] = { adSpend: 0, newCount: 0, enrollCount: 0, revenue: 0 };
    mediaMap[d.media].adSpend += d.adSpend || 0;
    mediaMap[d.media].newCount += d.newCount || 0;
    mediaMap[d.media].enrollCount += d.enrollCount || 0;
    mediaMap[d.media].revenue += d.revenue || 0;
  });
  const mediaBreakdown = Object.entries(mediaMap).map(([media, v]) => ({
    media, adSpend: v.adSpend, newCount: v.newCount, enrollCount: v.enrollCount, revenue: v.revenue,
    cpa: v.newCount > 0 ? Math.round(v.adSpend / v.newCount) : 0,
    enrollRate: v.newCount > 0 ? Math.round((v.enrollCount / v.newCount) * 100) : 0,
    roas: v.adSpend > 0 ? Math.round((v.revenue / v.adSpend) * 100) : 0,
  })).sort((a, b) => b.newCount - a.newCount);

  // 全店舗ランキング
  const allBranches = [...new Set(rawData.map(d => d.branch).filter(Boolean))];
  const branchRanking = allBranches.map(b => {
    const bd = rawData.filter(d => d.month === latestMonth && d.branch === b);
    const bm = mktData.filter(d => d.month === latestMonth && d.branch === b && d.media !== '全媒体合計');
    const bSales = bd.reduce((s, d) => s + vn(d.individualSales), 0);
    const bNew = bd.reduce((s, d) => s + vn(d.newCount), 0);
    const bEnroll = bd.reduce((s, d) => s + vn(d.newEnroll), 0);
    const bAdSpend = bm.reduce((s, d) => s + (d.adSpend || 0), 0);
    const bMktNew = bm.reduce((s, d) => s + (d.newCount || 0), 0);
    return { branch: b, sales: bSales, newCount: bNew,
      enrollRate: bNew > 0 ? Math.round((bEnroll / bNew) * 100) : 0,
      cpa: bMktNew > 0 ? Math.round(bAdSpend / bMktNew) : 0, adSpend: bAdSpend };
  }).sort((a, b) => b.sales - a.sales);

  return {
    latestMonth, prevMonth, totalSales, totalNewCount, totalNewEnroll, enrollRate,
    churnRate, cpa, totalAdSpend, prevSales, prevNewCount,
    mediaBreakdown, branchRanking,
    branchName: branchName || '全店舗',
  };
}

/**
 * 安全に数値を丸める（null/NaN/Infinity対応）
 */
export { vn };
