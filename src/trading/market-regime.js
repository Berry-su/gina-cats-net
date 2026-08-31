/**
 * 交易模块 —— 市场环境/危机知识评估 (market-regime.js)
 *
 * 将已植入的历史市场风波知识（存于记忆系统与 CATS-Net 抽象空间）接入交易决策链路：
 *   - assess(concepts)：把当前市场状况映射到的概念集合，召回最相关的历史危机案例，
 *     计算「危机等级」与「风险调节建议」，供策略信号与风控层使用；
 *   - deriveConcepts(metrics)：把可观测的市场指标（跌幅、波动、杠杆、流动性等）
 *     翻译为概念 id，作为 assess 的输入（连接真实行情与本模块的桥梁）；
 *   - 危机等级越高，风控越紧：降低仓位上限、收紧止损、限制开仓频率，极端时直接熔断新开仓。
 *
 * 依赖方向单向 trading → memory/cats_net，通过构造注入，未注入时降级返回「正常/无知识」。
 */

/** 各概念的危险权重（越高代表越接近危机）。缺省视为低危 0.3。 */
export const DANGER_WEIGHTS = Object.freeze({
  panic: 0.9,
  liquidity_crisis: 0.9,
  systemic_risk: 0.9,
  credit_crunch: 0.8,
  currency_crisis: 0.8,
  debt_crisis: 0.8,
  black_swan: 0.8,
  circuit_breaker: 0.7,
  margin_trading: 0.7,
  carry_trade: 0.7,
  bubble: 0.7,
  leverage: 0.7,
  over_speculation: 0.6,
  contagion: 0.6,
  deleveraging: 0.5,
  equity_pledge: 0.5,
  fraud: 0.5,
  trade_war: 0.5,
  inflation: 0.4,
  interest_rate: 0.4,
  market_bottom: 0.3,
  stop_loss: 0.2,
  bailout: 0.2,
  regulation: 0.2,
  monetary_policy: 0.3,
})

/** 危机等级定义（按分区分）。 */
const LEVELS = [
  { level: 0, max: 0.3, name: '正常' },
  { level: 1, max: 0.55, name: '警惕' },
  { level: 2, max: 0.75, name: '高风险' },
  { level: 3, max: 1.01, name: '危机' },
]

/** 各等级对应的风控调节系数（越小越严格）。 */
const ADJUSTMENTS = [
  { positionRatioFactor: 1, totalExposureFactor: 1, orderSizeFactor: 1, openFrequencyFactor: 1, stopLossFactor: 1, halt: false },
  { positionRatioFactor: 0.7, totalExposureFactor: 0.85, orderSizeFactor: 0.7, openFrequencyFactor: 1, stopLossFactor: 0.8, halt: false },
  { positionRatioFactor: 0.4, totalExposureFactor: 0.6, orderSizeFactor: 0.4, openFrequencyFactor: 0.6, stopLossFactor: 0.5, halt: false },
  { positionRatioFactor: 0.1, totalExposureFactor: 0.25, orderSizeFactor: 0.1, openFrequencyFactor: 0.2, stopLossFactor: 0.3, halt: true },
]

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

export class MarketRegimeAdvisor {
  /**
   * @param {object} [options]
   * @param {object|null} [options.catsNet]        CATS-Net 实例（可选）
   * @param {object|null} [options.memoryManager]  记忆管理器实例（可选）
   * @param {Object<string, number>} [options.dangerWeights] 概念危险权重覆盖
   */
  constructor({ catsNet = null, memoryManager = null, dangerWeights = {} } = {}) {
    this.catsNet = catsNet ?? null
    this.memoryManager = memoryManager ?? null
    this.dangerWeights = { ...DANGER_WEIGHTS, ...dangerWeights }
  }

  /**
   * 评估当前市场环境：召回历史危机案例并计算危机等级与风控调节建议。
   * @param {string[]} concepts 当前市场状况映射到的概念 id 列表
   * @param {object} [options]
   * @param {number} [options.limit] 参与计算的历史案例条数上限
   * @returns {object} regime 评估结果
   */
  assess(concepts = [], { limit = 10 } = {}) {
    const query = Array.isArray(concepts) ? concepts.filter((c) => typeof c === 'string') : []

    const matchedCases = this._recall(query, { limit })

    // 1) 危险占比：查询概念中高危概念的比例
    const dangerHits = query.filter((c) => (this.dangerWeights[c] ?? 0) >= 0.6)
    const dangerRatio = query.length > 0 ? dangerHits.length / query.length : 0

    // 2) 匹配强度：最相关历史案例的分数（已含记忆强度 0~约0.95）
    const matchStrength = matchedCases.length > 0
      ? Math.max(...matchedCases.map((c) => c.score))
      : 0

    // 综合危机分
    const score = clamp(0.6 * matchStrength + 0.4 * dangerRatio, 0, 1)
    const { level, name } = this._levelOf(score)
    const adjustment = { ...(ADJUSTMENTS[level] ?? ADJUSTMENTS[0]) }

    const advice = {
      tightenStopLoss: level >= 1,
      avoidNewBuy: level >= 2,
      reducePosition: level >= 2,
      halt: level >= 3,
    }

    return {
      level,
      name,
      score,
      matchedCount: matchedCases.length,
      topMatch: matchedCases[0] ?? null,
      matchedCases,
      advice,
      adjustment,
    }
  }

  /**
   * 把可观测市场指标翻译为概念 id 列表。
   * @param {object} metrics
   * @param {number} [metrics.priceDropRatio]  短期跌幅比例（如 0.05 表示跌 5%）
   * @param {boolean} [metrics.volatilityUp]   波动率是否飙升
   * @param {boolean} [metrics.marginCallRisk] 是否存在两融/杠杆强平风险
   * @param {boolean} [metrics.liquidityTight] 流动性是否收紧
   * @param {boolean} [metrics.creditSpreadUp] 信用利差是否走阔
   * @param {boolean} [metrics.bubbleValuation] 估值是否泡沫化
   * @param {boolean} [metrics.policyShock]    是否存在政策冲击
   * @param {boolean} [metrics.currencyDepreciation] 本币是否贬值
   * @param {boolean} [metrics.blackSwanEvent] 是否发生黑天鹅事件
   * @returns {string[]}
   */
  static deriveConcepts(metrics = {}) {
    const out = []
    const m = metrics && typeof metrics === 'object' ? metrics : {}

    if (typeof m.priceDropRatio === 'number' && m.priceDropRatio >= 0.07) {
      out.push('liquidity_crisis', 'panic')
    } else if (typeof m.priceDropRatio === 'number' && m.priceDropRatio >= 0.03) {
      out.push('panic')
    }
    if (m.volatilityUp) out.push('panic')
    if (m.marginCallRisk) out.push('margin_trading', 'leverage')
    if (m.liquidityTight) out.push('liquidity_crisis')
    if (m.creditSpreadUp) out.push('credit_crunch', 'systemic_risk')
    if (m.bubbleValuation) out.push('bubble', 'over_speculation')
    if (m.policyShock) out.push('policy_market', 'regulation')
    if (m.currencyDepreciation) out.push('currency_crisis', 'contagion')
    if (m.blackSwanEvent) out.push('black_swan', 'panic')

    return Array.from(new Set(out))
  }

  // ---------------------------------------------------------------------------
  // 私有工具
  // ---------------------------------------------------------------------------

  /** 从抽象空间与分层记忆中召回相关历史案例（去重）。 */
  _recall(query, { limit = 10 } = {}) {
    const results = []

    if (this.catsNet && typeof this.catsNet.retrieveMemory === 'function') {
      try {
        const abs = this.catsNet.retrieveMemory(query, { limit, minScore: 0 })
        for (const h of abs) {
          results.push({
            label: h.entry?.label ?? '',
            content: h.entry?.content ?? '',
            score: h.score ?? 0,
            overlap: h.overlap ?? 0,
            source: 'abstract',
          })
        }
      } catch {
        // 内核异常则降级
      }
    }

    if (this.memoryManager && typeof this.memoryManager.retrieve === 'function') {
      try {
        const mem = this.memoryManager.retrieve(query, { limit })
        for (const h of mem) {
          results.push({
            label: h.entry?.label ?? '',
            content: h.entry?.content ?? '',
            score: h.score ?? 0,
            overlap: h.overlap ?? 0,
            source: h.layer ?? 'memory',
          })
        }
      } catch {
        // 记忆异常则降级
      }
    }

    // 按 label 去重（同一条案例可能同时出现在抽象空间与长期记忆）
    const seen = new Set()
    const unique = []
    for (const c of results) {
      if (!c.label || seen.has(c.label)) continue
      seen.add(c.label)
      unique.push(c)
    }
    unique.sort((a, b) => b.score - a.score)
    return unique.slice(0, limit)
  }

  _levelOf(score) {
    for (const l of LEVELS) {
      if (score < l.max) return { level: l.level, name: l.name }
    }
    return { level: 3, name: '危机' }
  }
}