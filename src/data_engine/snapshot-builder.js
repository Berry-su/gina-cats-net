/**
 * 数据采集引擎 —— 快照映射器 (snapshot-builder.js)
 *
 * 打通「采集结果 → MarketSnapshot」：把 DataEngine 产出的结构化数据（新闻 + 行情 + 异动）
 * 映射为分析师团队可消费的 MarketSnapshot。
 *
 * 映射规则（均为确定性启发式，真实接入财报/资金数据源后替换对应部分）：
 *   - 技术面：由行情（涨跌幅/量比）推导趋势、RSI、MACD、形态、均线多空、支撑压力；
 *   - 宏观面：由全市场新闻关键词分类（流动性/政策/地缘/热度）；
 *   - 情绪面：全市场涨跌广度 → 恐慌贪婪指数；新闻热度 → 板块/题材热度；异动 → 异常波动；
 *   - 资金面：异动 + 量能 → 主力动向/龙虎榜（其余留空待真实数据源）；
 *   - 基本面：财报/估值数据源未接入，估值数值暂留空（仅在行业景气度上给方向）。
 *
 * 注：本模块依赖 analysts 的 MarketSnapshot 结构（normalizeSnapshot），方向 data_engine → analysts。
 */

import { normalizeSnapshot } from '../analysts/market-snapshot.js'

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 依据代码形态推断市场（6 位数字视为 A 股，其余视为美股）。 */
export function inferMarket(symbol = '') {
  return /^\d{6}$/.test(symbol) ? 'CN' : 'US'
}

/**
 * 由全市场新闻关键词分类出宏观环境与热度。
 * @param {Array<object>} news
 * @returns {{liquidity:string, policyBias:string, geopoliticalRisk:string, sectorHeat:string, themeHeat:string}}
 */
export function analyzeMarketNews(news = []) {
  const list = Array.isArray(news) ? news : []
  const text = list
    .map((n) => `${n.title ?? ''} ${n.summary ?? ''} ${(n.tags ?? []).join(' ')}`)
    .join(' ')

  let liquidity = 'neutral'
  if (/收紧|紧张|骤紧|钱荒|流动性风险/.test(text)) liquidity = 'tight'
  else if (/宽松|释放流动性|降准|净投放|流动性充裕/.test(text)) liquidity = 'loose'

  let policyBias = 'neutral'
  if (/降息|降准|宽松预期|减税|稳增长/.test(text)) policyBias = 'dovish'
  else if (/加息|紧缩|收紧货币|监管收紧/.test(text)) policyBias = 'hawkish'

  let geopoliticalRisk = 'medium'
  if (/冲突|战争|制裁|出口管制|紧张局势/.test(text)) geopoliticalRisk = 'high'
  else if (/缓和|平稳|合作/.test(text)) geopoliticalRisk = 'low'

  let sectorHeat = 'warm'
  if (/科技|新能源|芯片|半导体|光伏/.test(text)) sectorHeat = 'hot'

  let themeHeat = 'warm'
  if (/题材|妖股|炒作|涨停潮|爆炒/.test(text)) themeHeat = 'hot'
  else if (/情绪冰点|低迷|跌停潮/.test(text)) themeHeat = 'cold'

  return { liquidity, policyBias, geopoliticalRisk, sectorHeat, themeHeat }
}

/**
 * 由全市场涨跌广度估算恐慌贪婪指数 (0-100)。
 * @param {Array<object>} quotes
 * @returns {number|null}
 */
export function marketFearGreed(quotes = []) {
  const list = Array.isArray(quotes) ? quotes.filter((q) => typeof q?.changePercent === 'number') : []
  if (list.length === 0) return null
  const avg = list.reduce((s, q) => s + q.changePercent, 0) / list.length
  return Math.round(clamp(50 + avg * 1000, 0, 100))
}

export class SnapshotBuilder {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSymbols] 单轮最多生成快照数
   */
  constructor({ maxSymbols = 20 } = {}) {
    this.maxSymbols = maxSymbols
  }

  /**
   * 生成全市场级上下文（宏观 + 情绪热度 + 恐慌贪婪）。
   * @param {object} payload { news, quotes }
   * @returns {object} context
   */
  buildContext(payload = {}) {
    const m = analyzeMarketNews(payload.news)
    return {
      macro: {
        liquidity: m.liquidity,
        policyBias: m.policyBias,
        interestRate: null,
        geopoliticalRisk: m.geopoliticalRisk,
        currencyPressure: null,
      },
      sentiment: {
        sectorHeat: m.sectorHeat,
        themeHeat: m.themeHeat,
      },
      fearGreed: marketFearGreed(payload.quotes),
    }
  }

  /**
   * 选出值得分析的标的：新闻提及 + 异动 + 涨跌幅度靠前。
   * @param {object} payload
   * @param {object} [options]
   * @param {string|null} [options.market] 只保留 US 或 CN
   * @param {number} [options.maxSymbols]
   * @returns {string[]}
   */
  selectSymbols(payload = {}, { market = null, maxSymbols = null } = {}) {
    const limit = maxSymbols ?? this.maxSymbols
    const quotes = Array.isArray(payload.quotes) ? payload.quotes : []
    const news = Array.isArray(payload.news) ? payload.news : []
    const abnormal = Array.isArray(payload.abnormal) ? payload.abnormal : []

    const ordered = []
    const push = (symbol) => {
      if (!symbol || ordered.includes(symbol)) return
      const mkt = inferMarket(symbol)
      if (market && mkt !== market) return
      ordered.push(symbol)
    }

    for (const a of abnormal) push(a.symbol)
    for (const q of [...quotes].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))) {
      push(q.symbol)
    }
    for (const n of news) for (const s of n.symbols) push(s)

    return ordered.slice(0, limit)
  }

  /**
   * 为单个标的构建 MarketSnapshot。
   * @param {string} symbol
   * @param {object} payload
   * @param {object} context buildContext 的结果
   * @returns {object} MarketSnapshot
   */
  buildSnapshot(symbol, payload = {}, context = {}) {
    const quote = (payload.quotes ?? []).find((q) => q.symbol === symbol) ?? null
    const abnormal = (payload.abnormal ?? []).find((a) => a.symbol === symbol) ?? null

    const change = quote?.changePercent ?? 0
    const price = quote?.price ?? null
    const volumeRatio = quote && quote.avgVolume > 0 ? quote.volume / quote.avgVolume : null

    const technical = {
      trend: change >= 0.01 ? 'up' : change <= -0.01 ? 'down' : 'sideways',
      aboveMa20: change > 0,
      aboveMa60: change > 0.02,
      macdSignal: change >= 0.02 ? 'golden' : change <= -0.02 ? 'dead' : 'none',
      rsi14: quote ? Math.round(clamp(50 + change * 500, 0, 100)) : 50,
      volumeRatio,
      pattern: change >= 0.04 ? 'breakout' : change <= -0.04 ? 'breakdown' : 'none',
      support: price != null ? Math.round(price * 0.95 * 100) / 100 : null,
      resistance: price != null ? Math.round(price * 1.05 * 100) / 100 : null,
    }

    const fundamental = {
      pe: null, pb: null, peg: null, roe: null,
      revenueGrowth: null, profitGrowth: null,
      industryProsperity: context.sentiment?.sectorHeat === 'hot' ? 'up'
        : context.sentiment?.sectorHeat === 'cold' ? 'down' : 'flat',
      valuationPercentile: null, debtRatio: null,
    }

    const fundFlow = {
      northboundNet: null,
      dragonTigerNetBuy: abnormal?.reasons?.includes('龙虎榜上榜') ? (change >= 0 ? 8 : -8) : null,
      marginBalanceTrend: 'flat',
      mainForceNet: (Math.abs(change) >= 0.03 && volumeRatio != null && volumeRatio >= 2)
        ? (change >= 0 ? 20 : -20)
        : null,
      turnoverRate: null,
    }

    // 财报/资金流富化（真实数据源接入后填充，覆盖上面的启发式默认值）
    const fin = (payload.financials ?? []).find((f) => f.symbol === symbol)
    if (fin) {
      if (fin.pe != null) fundamental.pe = fin.pe
      if (fin.pb != null) fundamental.pb = fin.pb
      if (fin.peg != null) fundamental.peg = fin.peg
      if (fin.roe != null) fundamental.roe = fin.roe
      if (fin.revenueGrowth != null) fundamental.revenueGrowth = fin.revenueGrowth
      if (fin.profitGrowth != null) fundamental.profitGrowth = fin.profitGrowth
      if (fin.valuationPercentile != null) fundamental.valuationPercentile = fin.valuationPercentile
      if (fin.debtRatio != null) fundamental.debtRatio = fin.debtRatio
      if (fin.industryProsperity) fundamental.industryProsperity = fin.industryProsperity
    }
    const ff = (payload.fundFlows ?? []).find((f) => f.symbol === symbol)
    if (ff) {
      if (ff.northboundNet != null) fundFlow.northboundNet = ff.northboundNet
      if (ff.dragonTigerNetBuy != null) fundFlow.dragonTigerNetBuy = ff.dragonTigerNetBuy
      if (ff.marginBalanceTrend) fundFlow.marginBalanceTrend = ff.marginBalanceTrend
      if (ff.mainForceNet != null) fundFlow.mainForceNet = ff.mainForceNet
      if (ff.turnoverRate != null) fundFlow.turnoverRate = ff.turnoverRate
    }

    const sentiment = {
      fearGreedIndex: context.fearGreed ?? null,
      sectorHeat: context.sentiment?.sectorHeat ?? 'warm',
      themeHeat: context.sentiment?.themeHeat ?? 'warm',
      limitUpCount: null,
      limitDownCount: null,
      abnormalVolatility: !!abnormal,
    }

    return normalizeSnapshot({
      symbol,
      name: quote?.name ?? symbol,
      market: quote?.market ?? inferMarket(symbol),
      price: price ?? undefined,
      change1d: quote ? change : undefined,
      technical,
      fundamental,
      macro: context.macro ?? {},
      fundFlow,
      sentiment,
    })
  }

  /**
   * 批量构建快照。
   * @param {object} payload
   * @param {object} [options]
   * @param {string|null} [options.market]
   * @param {number} [options.maxSymbols]
   * @returns {Array<object>}
   */
  buildSnapshots(payload = {}, { market = null, maxSymbols = null } = {}) {
    const context = this.buildContext(payload)
    const symbols = this.selectSymbols(payload, { market, maxSymbols })
    return symbols.map((symbol) => this.buildSnapshot(symbol, payload, context))
  }
}