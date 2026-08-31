/**
 * 交易模块 —— 风控规则 (risk-control.js)
 *
 * 交易模块最安全敏感的层。风控是「硬性前置门控」(hard gate)：
 *   策略信号产生后、订单真正发出前，必须逐条通过本层校验，任一不通过即拒绝。
 *
 * 覆盖四类保护（呼应原约束）：
 *   1) 仓位约束：单标的仓位占比上限、总持仓比率上限、单笔数量上限；
 *   2) 止损止盈：按持仓均价与现价的浮盈/浮亏比例，由引擎在每根 tick 主动检查；
 *   3) 防爆仓：每日最大亏损额（触发后熔断）、最大回撤（峰值权益 vs 当前权益）；
 *   4) 防连续恶性开仓：时间窗口内同方向密集开仓次数超限则拒绝（类似振荡检测）。
 */

export class RiskController {
  /**
   * @param {object} [options]
   * @param {number} [options.maxPositionRatio]  单标的仓位占比上限（相对权益）
   * @param {number} [options.maxTotalExposure]  总持仓比率上限
   * @param {number} [options.maxOrderSize]      单笔最大数量
   * @param {number} [options.maxDailyLoss]      每日最大亏损比例（触发熔断）
   * @param {number} [options.maxDrawdown]       最大回撤比例（触发熔断）
   * @param {number} [options.stopLossPercent]   止损比例
   * @param {number} [options.takeProfitPercent] 止盈比例
   * @param {number} [options.maxOpenFrequency]  开仓窗口内最大开仓次数
   * @param {number} [options.openWindowMs]      防连续开仓时间窗口（毫秒）
   */
  constructor({
    maxPositionRatio = 0.2,
    maxTotalExposure = 0.8,
    maxOrderSize = 1000,
    maxDailyLoss = 0.05,
    maxDrawdown = 0.2,
    stopLossPercent = 0.05,
    takeProfitPercent = 0.1,
    maxOpenFrequency = 5,
    openWindowMs = 60000,
    knowledgeAdvisor = null,
  } = {}) {
    this.maxPositionRatio = maxPositionRatio
    this.maxTotalExposure = maxTotalExposure
    this.maxOrderSize = maxOrderSize
    this.maxDailyLoss = maxDailyLoss
    this.maxDrawdown = maxDrawdown
    this.stopLossPercent = stopLossPercent
    this.takeProfitPercent = takeProfitPercent
    this.maxOpenFrequency = maxOpenFrequency
    this.openWindowMs = openWindowMs
    this.knowledgeAdvisor = knowledgeAdvisor ?? null

    /** 今日累计已实现盈亏。 */
    this.dailyRealizedPnl = 0
    /** 历史峰值权益（用于回撤）。 */
    this.peakEquity = null
    /** 开仓历史：{ timestamp, side }。 */
    this.openHistory = []
    /** 熔断标志。 */
    this._halted = false
    this._haltReason = null

    /** 当前市场环境评估（危机知识），由交易引擎注入。 */
    this.regime = null
    /** 由危机等级推导的风控调节系数。 */
    this._adjust = {
      positionRatioFactor: 1,
      totalExposureFactor: 1,
      orderSizeFactor: 1,
      openFrequencyFactor: 1,
      stopLossFactor: 1,
      halt: false,
    }
  }

  /**
   * 应用市场环境评估，动态收紧风控参数（危机等级越高越严格）。
   * @param {object|null} regime MarketRegimeAdvisor.assess 的返回结果；传 null 撤销。
   * @returns {this}
   */
  applyRegime(regime) {
    this.regime = regime ?? null
    if (regime && regime.adjustment && typeof regime.adjustment === 'object') {
      this._adjust = {
        positionRatioFactor: regime.adjustment.positionRatioFactor ?? 1,
        totalExposureFactor: regime.adjustment.totalExposureFactor ?? 1,
        orderSizeFactor: regime.adjustment.orderSizeFactor ?? 1,
        openFrequencyFactor: regime.adjustment.openFrequencyFactor ?? 1,
        stopLossFactor: regime.adjustment.stopLossFactor ?? 1,
        halt: !!regime.adjustment.halt,
      }
    } else {
      this._adjust = {
        positionRatioFactor: 1,
        totalExposureFactor: 1,
        orderSizeFactor: 1,
        openFrequencyFactor: 1,
        stopLossFactor: 1,
        halt: false,
      }
    }
    return this
  }

  /** 当前市场环境评估结果。 */
  getRegime() {
    return this.regime
  }

  /**
   * 生成风控知识依据（仓位/止损/风险体系），无知识库则返回 null。
   * @param {string[]} [extra] 额外概念
   * @returns {string|null}
   */
  _riskNote(extra = []) {
    if (!this.knowledgeAdvisor || typeof this.knowledgeAdvisor.explain !== 'function') return null
    try {
      const concepts = ['risk_management', 'position_sizing', 'stop_loss', 'kelly_criterion', 'trading_psychology', ...extra]
      const exp = this.knowledgeAdvisor.explain(concepts)
      return exp.reason
    } catch {
      return null
    }
  }

  /** 是否已熔断。 */
  isHalted() {
    return this._halted
  }

  /** 熔断原因。 */
  getHaltReason() {
    return this._haltReason
  }

  // ---------------------------------------------------------------------------
  // 硬性开仓门控
  // ---------------------------------------------------------------------------

  /**
   * 检查订单是否可执行（逐条校验，返回全部拒绝原因）。
   * @param {object} order 待执行订单 { symbol, side, size, price }
   * @param {object} context { equity, positions(Map), currentPrices({symbol:price}) }
   * @returns {{approved:boolean, reasons:string[]}}
   */
  checkOrder(order, context = {}) {
    const reasons = []
    const equity = context.equity ?? 0
    const positions = context.positions instanceof Map ? context.positions : new Map()
    const currentPrices = context.currentPrices ?? {}

    // 危机知识收紧后的有效阈值
    const positionRatioLimit = this.maxPositionRatio * (this._adjust.positionRatioFactor ?? 1)
    const totalExposureLimit = this.maxTotalExposure * (this._adjust.totalExposureFactor ?? 1)
    const orderSizeLimit = this.maxOrderSize * (this._adjust.orderSizeFactor ?? 1)
    const openFreqLimit = Math.max(1, Math.floor(this.maxOpenFrequency * (this._adjust.openFrequencyFactor ?? 1)))

    // 0) 订单合法性
    if (!order || typeof order !== 'object') return { approved: false, reasons: ['订单缺失'] }
    if (order.side !== 'buy' && order.side !== 'sell') reasons.push(`非法方向: ${order.side}`)
    if (typeof order.size !== 'number' || order.size <= 0) reasons.push('数量必须为正数')
    if (typeof order.price !== 'number' || order.price <= 0 || Number.isNaN(order.price)) reasons.push('价格非法')

    // 1) 熔断（每日亏损 / 回撤）
    if (this._halted) reasons.push(`风控熔断中: ${this._haltReason ?? '未知原因'}`)

    // 1.5) 危机知识熔断（极高危机等级禁止新建仓位）
    if (this._adjust.halt && order.side === 'buy') {
      const lv = this.regime?.level ?? '?'
      reasons.push(`危机知识熔断(L${lv})：禁止新建仓位`)
    }

    // 2) 单笔数量上限
    if (typeof order.size === 'number' && order.size > orderSizeLimit) {
      reasons.push(`单笔数量 ${order.size} 超上限 ${orderSizeLimit}`)
    }

    if (order.side === 'buy' && typeof order.size === 'number' && typeof order.price === 'number') {
      // 3) 单标的仓位占比
      const existingQty = positions.get(order.symbol)?.qty ?? 0
      const existingPrice = currentPrices[order.symbol] ?? order.price
      const newMarketValue = existingQty * existingPrice + order.size * order.price
      if (equity > 0 && newMarketValue / equity > positionRatioLimit) {
        reasons.push(`单标的仓位 ${(newMarketValue / equity * 100).toFixed(1)}% 超上限 ${(positionRatioLimit * 100).toFixed(1)}%`)
      }

      // 4) 总持仓比率
      let totalMarketValue = 0
      for (const [sym, pos] of positions) {
        const px = currentPrices[sym] ?? order.price
        totalMarketValue += pos.qty * px
      }
      totalMarketValue += order.size * order.price
      if (equity > 0 && totalMarketValue / equity > totalExposureLimit) {
        reasons.push(`总持仓 ${(totalMarketValue / equity * 100).toFixed(1)}% 超上限 ${(totalExposureLimit * 100).toFixed(1)}%`)
      }

      // 5) 防连续恶性开仓
      const now = Date.now()
      const recentBuys = this.openHistory.filter(
        (h) => h.side === 'buy' && now - h.timestamp <= this.openWindowMs,
      ).length
      if (recentBuys >= openFreqLimit) {
        reasons.push(`连续开仓过于频繁: ${this.openWindowMs / 1000}s 内已开仓 ${recentBuys} 次（上限 ${openFreqLimit}）`)
      }
    }

    // 风控知识依据（有知识库且被拒绝时附加）
    if (reasons.length > 0) {
      const note = this._riskNote()
      if (note) reasons.push(`风控知识依据：${note}`)
    }

    return { approved: reasons.length === 0, reasons }
  }

  // ---------------------------------------------------------------------------
  // 止损止盈检查（由引擎每 tick 主动调用）
  // ---------------------------------------------------------------------------

  /**
   * 检查持仓是否触发止损/止盈。
   * @param {{qty:number, avgPrice:number}} position
   * @param {number} currentPrice
   * @returns {{action:string, reason:string}} action: 'stop_loss' | 'take_profit' | 'hold'
   */
  checkStopLossTakeProfit(position, currentPrice) {
    if (!position || position.qty <= 0 || !position.avgPrice) {
      return { action: 'hold', reason: '无持仓' }
    }
    const pnlRatio = (currentPrice - position.avgPrice) / position.avgPrice
    // 危机等级越高，止损阈值越紧（跌幅更小即触发止损）
    const stopLoss = this.stopLossPercent * (this._adjust.stopLossFactor ?? 1)
    if (pnlRatio <= -stopLoss) {
      let reason = `止损触发 浮亏 ${(pnlRatio * 100).toFixed(2)}%`
      const note = this._riskNote()
      if (note) reason += `｜${note}`
      return { action: 'stop_loss', reason }
    }
    if (pnlRatio >= this.takeProfitPercent) {
      return { action: 'take_profit', reason: `止盈触发 浮盈 ${(pnlRatio * 100).toFixed(2)}%` }
    }
    return { action: 'hold', reason: '未触发' }
  }

  // ---------------------------------------------------------------------------
  // 状态更新（由引擎在成交/权益变化时调用）
  // ---------------------------------------------------------------------------

  /** 记录一次已实现盈亏，更新每日亏损熔断。 */
  recordTrade(pnl) {
    this.dailyRealizedPnl += pnl
    if (this.peakEquity != null && this.peakEquity > 0) {
      const loss = -this.dailyRealizedPnl
      if (loss >= this.maxDailyLoss * this.peakEquity) {
        this._halt('每日亏损熔断')
      }
    }
  }

  /** 记录一次开仓（用于防连续开仓）。 */
  recordOpen(side) {
    this.openHistory.push({ timestamp: Date.now(), side })
    // 清理窗口外历史，防止无限增长
    const cutoff = Date.now() - this.openWindowMs
    this.openHistory = this.openHistory.filter((h) => h.timestamp >= cutoff)
  }

  /** 更新当前权益，维护峰值与回撤熔断。 */
  updateEquity(equity) {
    if (this.peakEquity === null) this.peakEquity = equity
    if (equity > this.peakEquity) {
      this.peakEquity = equity
      return // 创新高不检查回撤
    }
    if (this.peakEquity > 0) {
      const drawdown = (this.peakEquity - equity) / this.peakEquity
      if (drawdown >= this.maxDrawdown) {
        this._halt('最大回撤熔断')
      }
    }
  }

  /** 重置每日状态（跨日复位）。 */
  resetDaily() {
    this.dailyRealizedPnl = 0
    this._halted = false
    this._haltReason = null
  }

  /** 内部：置位熔断。 */
  _halt(reason) {
    if (this._halted) return
    this._halted = true
    this._haltReason = reason
    console.log(`[risk] 风控熔断: ${reason}`)
  }
}