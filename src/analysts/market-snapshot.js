/**
 * 分析师团队 —— 统一市场数据快照 (market-snapshot.js)
 *
 * 所有分析师消费同一种输入结构 MarketSnapshot，实现「数据就绪即插即用」：
 *   - 五个领域字段：technical(技术面) / fundamental(基本面) / macro(宏观) / fundFlow(资金面) / sentiment(情绪面)；
 *   - 后续接入真实数据采集引擎时，只需把采集结果灌入本结构即可，分析师无需改动。
 *
 * 本文件不依赖任何外部模块，可独立使用。
 */

function num(v, fallback = 0) {
  return typeof v === 'number' && !Number.isNaN(v) ? v : fallback
}

/**
 * 校验并归一化一份市场快照，缺失字段补默认值。
 * @param {object} s
 * @returns {object}
 */
export function normalizeSnapshot(s = {}) {
  const technical = s.technical ?? {}
  const fundamental = s.fundamental ?? {}
  const macro = s.macro ?? {}
  const fundFlow = s.fundFlow ?? {}
  const sentiment = s.sentiment ?? {}

  return {
    symbol: typeof s.symbol === 'string' && s.symbol ? s.symbol : 'UNKNOWN',
    name: typeof s.name === 'string' ? s.name : (typeof s.symbol === 'string' ? s.symbol : ''),
    market: s.market === 'CN' ? 'CN' : 'US',
    price: num(s.price, 100),
    change1d: num(s.change1d, 0),

    technical: {
      trend: technical.trend === 'up' ? 'up' : technical.trend === 'down' ? 'down' : 'sideways',
      aboveMa20: !!technical.aboveMa20,
      aboveMa60: !!technical.aboveMa60,
      macdSignal: technical.macdSignal === 'golden' ? 'golden' : technical.macdSignal === 'dead' ? 'dead' : 'none',
      rsi14: num(technical.rsi14, 50),
      volumeRatio: num(technical.volumeRatio, 1),
      pattern: ['breakout', 'breakdown', 'range', 'reversal'].includes(technical.pattern) ? technical.pattern : 'none',
      support: technical.support == null ? null : num(technical.support, null),
      resistance: technical.resistance == null ? null : num(technical.resistance, null),
    },

    fundamental: {
      pe: fundamental.pe == null ? null : num(fundamental.pe, null),
      pb: fundamental.pb == null ? null : num(fundamental.pb, null),
      peg: fundamental.peg == null ? null : num(fundamental.peg, null),
      roe: fundamental.roe == null ? null : num(fundamental.roe, null),
      revenueGrowth: fundamental.revenueGrowth == null ? null : num(fundamental.revenueGrowth, null),
      profitGrowth: fundamental.profitGrowth == null ? null : num(fundamental.profitGrowth, null),
      industryProsperity: fundamental.industryProsperity === 'up' ? 'up' : fundamental.industryProsperity === 'down' ? 'down' : 'flat',
      valuationPercentile: fundamental.valuationPercentile == null ? null : num(fundamental.valuationPercentile, null),
      debtRatio: fundamental.debtRatio == null ? null : num(fundamental.debtRatio, null),
    },

    macro: {
      liquidity: macro.liquidity === 'loose' ? 'loose' : macro.liquidity === 'tight' ? 'tight' : 'neutral',
      policyBias: macro.policyBias === 'dovish' ? 'dovish' : macro.policyBias === 'hawkish' ? 'hawkish' : 'neutral',
      interestRate: macro.interestRate == null ? null : num(macro.interestRate, null),
      geopoliticalRisk: macro.geopoliticalRisk === 'high' ? 'high' : macro.geopoliticalRisk === 'low' ? 'low' : 'medium',
      currencyPressure: macro.currencyPressure === 'depreciation' ? 'depreciation' : macro.currencyPressure === 'appreciation' ? 'appreciation' : 'stable',
    },

    fundFlow: {
      northboundNet: fundFlow.northboundNet == null ? null : num(fundFlow.northboundNet, null),
      dragonTigerNetBuy: fundFlow.dragonTigerNetBuy == null ? null : num(fundFlow.dragonTigerNetBuy, null),
      marginBalanceTrend: fundFlow.marginBalanceTrend === 'up' ? 'up' : fundFlow.marginBalanceTrend === 'down' ? 'down' : 'flat',
      mainForceNet: fundFlow.mainForceNet == null ? null : num(fundFlow.mainForceNet, null),
      turnoverRate: fundFlow.turnoverRate == null ? null : num(fundFlow.turnoverRate, null),
    },

    sentiment: {
      fearGreedIndex: sentiment.fearGreedIndex == null ? null : num(sentiment.fearGreedIndex, null),
      sectorHeat: sentiment.sectorHeat === 'hot' ? 'hot' : sentiment.sectorHeat === 'cold' ? 'cold' : 'warm',
      themeHeat: sentiment.themeHeat === 'hot' ? 'hot' : sentiment.themeHeat === 'cold' ? 'cold' : 'warm',
      limitUpCount: sentiment.limitUpCount == null ? null : num(sentiment.limitUpCount, null),
      limitDownCount: sentiment.limitDownCount == null ? null : num(sentiment.limitDownCount, null),
      abnormalVolatility: !!sentiment.abnormalVolatility,
    },
  }
}

/**
 * 生成一份模拟市场快照，用于离线跑通演示与测试。
 * @param {object} [options]
 * @param {string} [options.symbol]
 * @param {string} [options.name]
 * @param {'US'|'CN'} [options.market]
 * @param {'bullish'|'bearish'|'divergent'|'crisis'|'neutral'} [options.scenario]
 * @param {object} [options.overrides] 深合并覆盖
 * @returns {object}
 */
export function createMockSnapshot({ symbol = 'AAPL', name = '示例标的', market = 'US', scenario = 'neutral', overrides = {} } = {}) {
  const base = { symbol, name, market, price: 100, change1d: 0 }

  const scenarios = {
    bullish: {
      price: 100, change1d: 0.02,
      technical: { trend: 'up', aboveMa20: true, aboveMa60: true, macdSignal: 'golden', rsi14: 58, volumeRatio: 1.5, pattern: 'breakout', support: 95, resistance: 108 },
      fundamental: { pe: 12, pb: 2, peg: 0.8, roe: 18, revenueGrowth: 20, profitGrowth: 25, industryProsperity: 'up', valuationPercentile: 20, debtRatio: 35 },
      macro: { liquidity: 'loose', policyBias: 'dovish', interestRate: 3.5, geopoliticalRisk: 'low', currencyPressure: 'stable' },
      fundFlow: { northboundNet: 50, dragonTigerNetBuy: 8, marginBalanceTrend: 'up', mainForceNet: 30, turnoverRate: 4 },
      sentiment: { fearGreedIndex: 62, sectorHeat: 'warm', themeHeat: 'warm', limitUpCount: 80, limitDownCount: 5, abnormalVolatility: false },
    },
    bearish: {
      price: 100, change1d: -0.02,
      technical: { trend: 'down', aboveMa20: false, aboveMa60: false, macdSignal: 'dead', rsi14: 38, volumeRatio: 1.8, pattern: 'breakdown', support: 88, resistance: 96 },
      fundamental: { pe: 45, pb: 8, peg: 3, roe: 6, revenueGrowth: -5, profitGrowth: -15, industryProsperity: 'down', valuationPercentile: 90, debtRatio: 75 },
      macro: { liquidity: 'neutral', policyBias: 'hawkish', interestRate: 6, geopoliticalRisk: 'medium', currencyPressure: 'stable' },
      fundFlow: { northboundNet: -60, dragonTigerNetBuy: -12, marginBalanceTrend: 'flat', mainForceNet: -40, turnoverRate: 2 },
      sentiment: { fearGreedIndex: 25, sectorHeat: 'cold', themeHeat: 'cold', limitUpCount: 10, limitDownCount: 90, abnormalVolatility: false },
    },
    divergent: {
      price: 100, change1d: -0.01,
      technical: { trend: 'down', aboveMa20: false, aboveMa60: true, macdSignal: 'dead', rsi14: 45, volumeRatio: 1.2, pattern: 'breakdown', support: 92, resistance: 105 },
      fundamental: { pe: 10, pb: 1.5, peg: 0.6, roe: 22, revenueGrowth: 30, profitGrowth: 35, industryProsperity: 'up', valuationPercentile: 10, debtRatio: 30 },
      macro: { liquidity: 'neutral', policyBias: 'neutral', interestRate: 4, geopoliticalRisk: 'medium', currencyPressure: 'stable' },
      fundFlow: { northboundNet: -20, dragonTigerNetBuy: 5, marginBalanceTrend: 'flat', mainForceNet: -30, turnoverRate: 3.5 },
      sentiment: { fearGreedIndex: 85, sectorHeat: 'hot', themeHeat: 'hot', limitUpCount: 120, limitDownCount: 20, abnormalVolatility: true },
    },
    crisis: {
      price: 100, change1d: -0.08,
      technical: { trend: 'down', aboveMa20: false, aboveMa60: false, macdSignal: 'dead', rsi14: 30, volumeRatio: 3, pattern: 'breakdown', support: 80, resistance: 90 },
      fundamental: { pe: 18, pb: 3, peg: 1.5, roe: 12, revenueGrowth: 3, profitGrowth: -5, industryProsperity: 'down', valuationPercentile: 55, debtRatio: 60 },
      macro: { liquidity: 'tight', policyBias: 'hawkish', interestRate: 6.5, geopoliticalRisk: 'high', currencyPressure: 'depreciation' },
      fundFlow: { northboundNet: -120, dragonTigerNetBuy: -20, marginBalanceTrend: 'down', mainForceNet: -80, turnoverRate: 6 },
      sentiment: { fearGreedIndex: 10, sectorHeat: 'cold', themeHeat: 'cold', limitUpCount: 5, limitDownCount: 300, abnormalVolatility: true },
    },
    neutral: {
      price: 100, change1d: 0,
      technical: { trend: 'sideways', aboveMa20: true, aboveMa60: false, macdSignal: 'none', rsi14: 50, volumeRatio: 1, pattern: 'range', support: 94, resistance: 104 },
      fundamental: { pe: 20, pb: 3, peg: 1.2, roe: 14, revenueGrowth: 8, profitGrowth: 10, industryProsperity: 'flat', valuationPercentile: 50, debtRatio: 45 },
      macro: { liquidity: 'neutral', policyBias: 'neutral', interestRate: 4.5, geopoliticalRisk: 'medium', currencyPressure: 'stable' },
      fundFlow: { northboundNet: 0, dragonTigerNetBuy: 0, marginBalanceTrend: 'flat', mainForceNet: 0, turnoverRate: 2.5 },
      sentiment: { fearGreedIndex: 50, sectorHeat: 'warm', themeHeat: 'warm', limitUpCount: 40, limitDownCount: 40, abnormalVolatility: false },
    },
  }

  const chosen = scenarios[scenario] ?? scenarios.neutral
  return normalizeSnapshot(deepMerge(deepMerge(base, chosen), overrides))
}

function deepMerge(base, extra) {
  const out = { ...base }
  if (!extra || typeof extra !== 'object') return out
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}