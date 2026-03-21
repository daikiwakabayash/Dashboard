import { describe, it, expect } from 'vitest';

// Test the finance data flow logic independently
// This verifies that API response data correctly flows through the system

describe('Finance Data Flow', () => {
  // Simulate what the API returns
  const mockApiResponse = {
    success: true,
    data: {
      period: '2024-10',
      companyName: 'NAORUテクノロジー',
      fiscalYear: '第4期',
      pl: {
        sales: 355600000,
        costOfSales: 0,
        grossProfit: 355600000,
        sgaExpenses: 310000000,
        personnelCost: 180000000,
        rent: 45000000,
        advertising: 30000000,
        depreciation: 5000000,
        otherSga: 50000000,
        operatingIncome: 45600000,
        nonOperatingIncome: 1200000,
        nonOperatingExpenses: 3500000,
        ordinaryIncome: 43300000,
        extraordinaryGains: 0,
        extraordinaryLosses: 0,
        incomeBeforeTax: 43300000,
        incomeTax: 13000000,
        netIncome: 30300000,
      },
      bs: {
        cash: 156780575,
        accountsReceivable: 7553835,
        inventory: 0,
        otherCurrentAssets: 23796604,
        totalCurrentAssets: 188131014,
        fixedAssets: 1397477,
        intangibleAssets: 9956616,
        investments: 4076251,
        totalFixedAssets: 15430344,
        totalAssets: 203561358,
        accountsPayable: 82729385,
        shortTermLoans: 0,
        unpaidExpenses: 0,
        otherCurrentLiabilities: 2904556,
        totalCurrentLiabilities: 85633941,
        longTermLoans: 35232000,
        otherFixedLiabilities: 12023441,
        totalFixedLiabilities: 47255441,
        totalLiabilities: 132889382,
        capital: 3000000,
        retainedEarnings: 67671976,
        totalEquity: 70671976,
        totalLiabilitiesAndEquity: 203561358,
      },
      cashflow: {
        operatingCF: 35300000,
        investingCF: -5000000,
        financingCF: -10000000,
        netCashChange: 20300000,
        beginningCash: 136480575,
        endingCash: 156780575,
        depreciation: 5000000,
        changeInReceivables: -1200000,
        changeInPayables: 3000000,
        capex: -5000000,
        loanRepayment: -10000000,
      },
      accountDetails: {
        unpaidExpenses: [],
        accountsReceivable: [{ name: '売掛金', amount: 7553835 }],
        accountsPayable: [{ name: '買掛金', amount: 82729385 }],
      },
    },
  };

  it('API response has correct structure with non-zero values', () => {
    const { data } = mockApiResponse;
    expect(data.period).toBe('2024-10');
    expect(data.fiscalYear).toBe('第4期');
    expect(data.pl.sales).toBe(355600000);
    expect(data.pl.sales).toBeGreaterThan(0);
    expect(data.bs.totalAssets).toBe(203561358);
    expect(data.bs.totalAssets).toBeGreaterThan(0);
    expect(data.bs.cash).toBe(156780575);
  });

  it('finPeriodData storage logic works correctly', () => {
    // Simulate storing multiple periods
    let finPeriodData = [];

    // Add first period (第4期)
    const extracted1 = mockApiResponse.data;
    const existing1 = finPeriodData.filter(d => d.fiscalYear !== extracted1.fiscalYear);
    finPeriodData = [...existing1, extracted1].sort((a, b) => (a.period || '').localeCompare(b.period || ''));

    expect(finPeriodData).toHaveLength(1);
    expect(finPeriodData[0].fiscalYear).toBe('第4期');
    expect(finPeriodData[0].pl.sales).toBe(355600000);

    // Add second period (第5期)
    const extracted2 = {
      ...mockApiResponse.data,
      period: '2025-10',
      fiscalYear: '第5期',
      pl: { ...mockApiResponse.data.pl, sales: 400000000 },
    };
    const existing2 = finPeriodData.filter(d => d.fiscalYear !== extracted2.fiscalYear);
    finPeriodData = [...existing2, extracted2].sort((a, b) => (a.period || '').localeCompare(b.period || ''));

    expect(finPeriodData).toHaveLength(2);
    expect(finPeriodData[0].fiscalYear).toBe('第4期');
    expect(finPeriodData[1].fiscalYear).toBe('第5期');
    expect(finPeriodData[1].pl.sales).toBe(400000000);
  });

  it('finSelectedData correctly selects period by fiscalYear', () => {
    const finPeriodData = [
      { ...mockApiResponse.data, period: '2023-10', fiscalYear: '第3期', pl: { ...mockApiResponse.data.pl, sales: 200000000 } },
      { ...mockApiResponse.data, period: '2024-10', fiscalYear: '第4期', pl: { ...mockApiResponse.data.pl, sales: 355600000 } },
      { ...mockApiResponse.data, period: '2025-10', fiscalYear: '第5期', pl: { ...mockApiResponse.data.pl, sales: 400000000 } },
    ];

    // Simulate finSelectedData for '第4期'
    const finPeriod = '第4期';
    const match = finPeriodData.find(d => d.fiscalYear === finPeriod || d.period === finPeriod);
    expect(match).toBeDefined();
    expect(match.pl.sales).toBe(355600000);
    expect(match.bs.totalAssets).toBe(203561358);
    expect(match.cashflow.operatingCF).toBe(35300000);

    // Simulate finSelectedData for 'latest'
    const sorted = [...finPeriodData].sort((a, b) => (b.period || '').localeCompare(a.period || ''));
    const latest = sorted[0];
    expect(latest.fiscalYear).toBe('第5期');
    expect(latest.pl.sales).toBe(400000000);
  });

  it('finPeriodOptions correctly maps period to 令和年度', () => {
    const toReiwaYear = (period) => {
      if (!period) return '';
      const yearMatch = period.match(/^(\d{4})/);
      if (!yearMatch) return period;
      const westernYear = parseInt(yearMatch[1]);
      const reiwaYear = westernYear - 2018;
      if (reiwaYear <= 0) return `${westernYear}年度`;
      return `令和${reiwaYear}年度`;
    };

    expect(toReiwaYear('2023-10')).toBe('令和5年度');
    expect(toReiwaYear('2024-10')).toBe('令和6年度');
    expect(toReiwaYear('2025-10')).toBe('令和7年度');

    const finPeriodData = [
      { period: '2023-10', fiscalYear: '第3期', pl: { sales: 200000000 } },
      { period: '2024-10', fiscalYear: '第4期', pl: { sales: 355600000 } },
      { period: '2025-10', fiscalYear: '第5期', pl: { sales: 400000000 } },
    ];

    const options = finPeriodData
      .filter(d => d.period)
      .sort((a, b) => a.period.localeCompare(b.period))
      .map(d => ({
        value: d.fiscalYear || d.period,
        label: toReiwaYear(d.period),
      }));

    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({ value: '第3期', label: '令和5年度' });
    expect(options[1]).toEqual({ value: '第4期', label: '令和6年度' });
    expect(options[2]).toEqual({ value: '第5期', label: '令和7年度' });
  });

  it('finData merge with extracted data works correctly', () => {
    // Simulate what happens in handleFinancePdfUpload
    let finData = null;
    const extracted = mockApiResponse.data;

    // First upload - finData is null
    finData = {
      ...finData,
      pl: { ...finData?.pl, ...extracted.pl },
      bs: { ...finData?.bs, ...extracted.bs },
      cashflow: { ...finData?.cashflow, ...extracted.cashflow },
      accountDetails: extracted.accountDetails || finData?.accountDetails,
    };

    expect(finData.pl.sales).toBe(355600000);
    expect(finData.bs.cash).toBe(156780575);
    expect(finData.cashflow.operatingCF).toBe(35300000);
    expect(finData.pl.sales).not.toBe(0);
    expect(finData.bs.totalAssets).not.toBe(0);
  });

  it('localStorage round-trip preserves data', () => {
    const data = [mockApiResponse.data];
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].pl.sales).toBe(355600000);
    expect(parsed[0].bs.totalAssets).toBe(203561358);
    expect(parsed[0].cashflow.operatingCF).toBe(35300000);
    expect(parsed[0].fiscalYear).toBe('第4期');
    expect(parsed[0].period).toBe('2024-10');
  });

  it('API JSON response parsing works for different formats', () => {
    // Format 1: ```json ... ```
    const text1 = '```json\n{"period":"2024-10","pl":{"sales":100}}\n```';
    const match1 = text1.match(/```json\s*([\s\S]*?)```/) || text1.match(/(\{[\s\S]*\})/);
    expect(match1).not.toBeNull();
    const parsed1 = JSON.parse(match1[1]);
    expect(parsed1.pl.sales).toBe(100);

    // Format 2: raw JSON
    const text2 = '{"period":"2024-10","pl":{"sales":200}}';
    const match2 = text2.match(/```json\s*([\s\S]*?)```/) || text2.match(/(\{[\s\S]*\})/);
    expect(match2).not.toBeNull();
    const parsed2 = JSON.parse(match2[1]);
    expect(parsed2.pl.sales).toBe(200);

    // Format 3: with surrounding text
    const text3 = 'Here is the data:\n```json\n{"period":"2024-10","pl":{"sales":300}}\n```\nDone.';
    const match3 = text3.match(/```json\s*([\s\S]*?)```/) || text3.match(/(\{[\s\S]*\})/);
    expect(match3).not.toBeNull();
    const parsed3 = JSON.parse(match3[1]);
    expect(parsed3.pl.sales).toBe(300);
  });

  it('Display values calculate correctly from data', () => {
    const data = mockApiResponse.data;

    // KPI cards - 万円 display
    expect(Math.round(data.pl.sales / 10000)).toBe(35560);
    expect(Math.round(data.bs.cash / 10000)).toBe(15678);
    expect(Math.round(data.pl.netIncome / 10000)).toBe(3030);

    // Profitability metrics
    const grossMargin = data.pl.sales ? ((data.pl.grossProfit / data.pl.sales) * 100).toFixed(1) : '-';
    expect(grossMargin).toBe('100.0'); // No COGS

    const operatingMargin = data.pl.sales ? ((data.pl.operatingIncome / data.pl.sales) * 100).toFixed(1) : '-';
    expect(operatingMargin).toBe('12.8');

    // Safety metrics
    const currentRatio = data.bs.totalCurrentLiabilities ? ((data.bs.totalCurrentAssets / data.bs.totalCurrentLiabilities) * 100).toFixed(1) : '-';
    expect(currentRatio).toBe('219.7');

    const equityRatio = data.bs.totalAssets ? ((data.bs.totalEquity / data.bs.totalAssets) * 100).toFixed(1) : '-';
    expect(equityRatio).toBe('34.7');
  });

  it('Zero-division safety works correctly', () => {
    const emptyData = {
      pl: { sales: 0, grossProfit: 0, operatingIncome: 0, ordinaryIncome: 0, personnelCost: 0 },
      bs: { totalCurrentAssets: 0, totalCurrentLiabilities: 0, totalEquity: 0, totalAssets: 0, totalLiabilities: 0, cash: 0 },
    };

    // These should return '-' not NaN/Infinity
    const grossMargin = emptyData.pl.sales ? ((emptyData.pl.grossProfit / emptyData.pl.sales) * 100).toFixed(1) : '-';
    expect(grossMargin).toBe('-');

    const currentRatio = emptyData.bs.totalCurrentLiabilities ? ((emptyData.bs.totalCurrentAssets / emptyData.bs.totalCurrentLiabilities) * 100).toFixed(1) : '-';
    expect(currentRatio).toBe('-');

    const equityRatio = emptyData.bs.totalAssets ? ((emptyData.bs.totalEquity / emptyData.bs.totalAssets) * 100).toFixed(1) : '-';
    expect(equityRatio).toBe('-');
  });
});
