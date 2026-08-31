/**
 * 交易模块 —— 交易引擎 (trading-engine.js)
 *
 * 主引擎，编排「行情 → 策略 → 风控 → 执行」全流程，并叠加安全机制与可选外部集成。
 *
 * 每根 tick 的处理流程：
 *   1) 更新最新价，维护权益峰值（回撤监控）；
 *   2) 主动检查该标的持仓的止损/止盈（不依赖策略信号）；
 *   3) 计算策略信号；
 *   4) 买入信号 → 构造订单 → 风控硬门控 → 通过则开仓，否则记录拒绝原因；
 *      卖出信号 → 有持仓则平仓；
 *   5) 关键事件（开/平仓、止损/止盈、风控拒绝、熔断）可选写入记忆 / 激活概念 / 触发状态机。
 *
 * 安全机制与其余模块一致：异常容错、紧急终止（abort/clearAbort/_guard）。
 * 外部集成均通过构造注入，未注入时降级为纯交易引擎。
 */

export class TradingEngine {
  /**
   * @param {object} options
   * @param {import('./market-data.js').MarketDataProvider} [options.provider]
   * @param {import('./strategy.js').Strategy} [options.strategy]
   * @param {import('./position.js').PositionManager} [options.positionManager]
   * @param {import('./risk-control.js').RiskController} [options.riskController]
   * @param {number} [options.defaultSize]         策略未给 size 时的默认开仓数量
   * @param {object|null} [options.memoryManager]  记忆管理器（可选）
   * @param {object|null} [options.catsNet]        CATS-Net 实例（可选）
   * @param {object|null} [options.stateMachine]   状态机（可选）
   */
  constructor({
    provider = null,
    strategy = null,
    positionManager = null,
    riskController = null,
    defaultSize = 100,
    memoryManager = null,
    catsNet = null,
    stateMachine = null,
    regimeAdvisor = null,
    regimeProvider = null,
    knowledgeAdvisor = null,
  } = {}) {
    this.provider = provider
    this.strategy = strategy
    this.positionManager = positionManager
    this.riskController = riskController
    this.defaultSize = defaultSize
    this.memoryManager = memoryManager ?? null
    this.catsNet = catsNet ?? null
    this.stateMachine = stateMachine ?? null
    this.regimeAdvisor = regimeAdvisor ?? null
    this.regimeProvider = regimeProvider ?? null
    this.knowledgeAdvisor = knowledgeAdvisor ?? null

    // 传递知识顾问给风控层（若风控层未自行注入），打通「风控决策链路」
    if (this.riskController && this.knowledgeAdvisor && !this.riskController.knowledgeAdvisor) {
      this.riskController.knowledgeAdvisor = this.knowledgeAdvisor
    }

    /** 最新价快照 symbol -> price。 */
    this.lastPrices = new Map()
    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 安全机制
  // ---------------------------------------------------------------------------

  abort() {
    this._aborted = true
    return this
  }

  clearAbort() {
    this._aborted = false
    return this
  }

  isAborted() {
    return this._aborted
  }

  _guard() {
    if (this._aborted) {
      const err = new Error('TradingEngine 已紧急终止，操作被拒绝')
      err.code = 'ABORTED'
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // 主处理流程
  // ---------------------------------------------------------------------------

  /**
   * 处理一只行情 tick。
   * @param {import('./market-data.js').Tick} tick
   * @returns {object} 处理结果
   */
  processTick(tick) {
    this._guard()
    const symbol = tick.symbol

    try {
      this.lastPrices.set(symbol, tick.close)
      if (this.riskController && typeof this.riskController.updateEquity === 'function') {
        this.riskController.updateEquity(this.positionManager?.getEquity?.() ?? 0)
      }

      // 0) 市场环境评估（危机知识）：召回历史案例 → 危机等级 → 收紧风控
      let regime = null
      if (this.regimeAdvisor) {
        try {
          const concepts = typeof this.regimeProvider === 'function'
            ? this.regimeProvider(tick, {
                lastPrices: Object.fromEntries(this.lastPrices),
                positions: this.positionManager?.positions ?? new Map(),
              })
            : []
          regime = this.regimeAdvisor.assess(concepts)
          if (this.riskController && typeof this.riskController.applyRegime === 'function') {
            this.riskController.applyRegime(regime)
          }
          if (regime.level > 0) {
            console.log(
              `[trade] 危机知识评估: L${regime.level}(${regime.name}) score=${regime.score.toFixed(3)} ` +
              `匹配案例=${regime.matchedCount}${regime.topMatch ? ` 最相关[${regime.topMatch.label}]` : ''}`,
            )
          }
        } catch (err) {
          console.log(`[trade] 危机知识评估失败(降级): ${err.message}`)
          regime = null
        }
      }

      const result = {
        symbol,
        signal: null,
        regime,
        stopLoss: null,
        takeProfit: null,
        order: null,
        aborted: false,
      }

      // 1) 止损止盈检查（仅当前标的）
      const pos = this.positionManager?.getPosition?.(symbol)
      if (pos && this.riskController) {
        const check = this.riskController.checkStopLossTakeProfit(pos, tick.close)
        if (check.action === 'stop_loss' || check.action === 'take_profit') {
          const closed = this.positionManager.closePosition(symbol, tick.close)
          this.riskController.recordTrade(closed.pnl)
          if (check.action === 'stop_loss') {
            result.stopLoss = { pnl: closed.pnl, reason: check.reason }
          } else {
            result.takeProfit = { pnl: closed.pnl, reason: check.reason }
          }
          this._integrate(check.action, { symbol, pnl: closed.pnl, reason: check.reason })
          return result
        }
      }

      // 2) 策略信号
      if (!this.strategy) {
        result.signal = { action: 'hold', reason: '未配置策略' }
        return result
      }
      let signal = this.strategy.onTick(tick, pos ?? null)

      // 2.1) 危机知识干预：高风险/危机环境下抑制新建买盘
      if (signal.action === 'buy' && regime && regime.advice && regime.advice.avoidNewBuy) {
        const hint = regime.topMatch ? ` | 参考案例：${regime.topMatch.label}` : ''
        signal = {
          action: 'hold',
          originalAction: 'buy',
          reason: `危机知识抑制买盘 L${regime.level}(${regime.name})${hint}`,
        }
      }
      result.signal = signal

      // 3) 执行买入
      if (signal.action === 'buy') {
        const size = typeof signal.size === 'number' && signal.size > 0 ? signal.size : this.defaultSize
        const order = { symbol, side: 'buy', size, price: tick.close }
        const check = this.riskController?.checkOrder
          ? this.riskController.checkOrder(order, {
              equity: this.positionManager.getEquity(),
              positions: this.positionManager.positions,
              currentPrices: Object.fromEntries(this.lastPrices),
            })
          : { approved: true, reasons: [] }

        if (check.approved) {
          const newPos = this.positionManager.openPosition(symbol, size, tick.close)
          this.riskController?.recordOpen?.('buy')
          order.status = 'filled'
          order.position = newPos
          result.order = order
          this._integrate('open', { symbol, size, price: tick.close, reason: signal.reason })
        } else {
          order.status = 'rejected'
          order.reasons = check.reasons
          result.order = order
          this._integrate('risk_reject', { symbol, reasons: check.reasons })
        }
        return result
      }

      // 4) 执行卖出
      if (signal.action === 'sell') {
        if (pos) {
          const closed = this.positionManager.closePosition(symbol, tick.close)
          this.riskController?.recordTrade?.(closed.pnl)
          result.order = { symbol, side: 'sell', size: closed.qty, price: tick.close, status: 'filled', pnl: closed.pnl }
          this._integrate('close', { symbol, pnl: closed.pnl, reason: signal.reason })
        } else {
          result.order = { symbol, side: 'sell', status: 'skipped', reason: '无持仓' }
        }
        return result
      }

      return result
    } catch (err) {
      // 异常容错：不外泄，返回降级结果
      return {
        symbol,
        signal: null,
        stopLoss: null,
        takeProfit: null,
        order: null,
        aborted: this._aborted,
        error: err.message,
      }
    }
  }

  /** 便捷：启动行情源并自动接入处理。 */
  start() {
    if (this.provider && typeof this.provider.onTick === 'function') {
      this.provider.onTick((tick) => this.processTick(tick))
      this.provider.start()
    }
    return this
  }

  /** 停止行情源。 */
  stop() {
    this.provider?.stop?.()
    return this
  }

  // ---------------------------------------------------------------------------
  // 外部集成
  // ---------------------------------------------------------------------------

  _integrate(event, detail = {}) {
    const symbol = detail.symbol ?? ''

    if (this.memoryManager && typeof this.memoryManager.addObservation === 'function') {
      if (!(typeof this.memoryManager.isAborted === 'function' && this.memoryManager.isAborted())) {
        try {
          this.memoryManager.addObservation({
            content: `交易事件 ${event} ${symbol}${detail.pnl !== undefined ? ` PnL=${detail.pnl.toFixed(2)}` : ''}`,
            concepts: symbol ? [symbol] : [],
            source: 'trade',
            importance: event === 'risk_reject' ? 0.5 : 0.3,
          })
          console.log(`[trade] 记忆集成: event=${event} symbol=${symbol}`)
        } catch (err) {
          console.log(`[trade] 记忆集成失败(降级): ${err.message}`)
        }
      }
    }

    if (this.catsNet && typeof this.catsNet.activate === 'function') {
      try {
        if (typeof this.catsNet.getNode === 'function' && symbol && this.catsNet.getNode(symbol)) {
          this.catsNet.activate(symbol, 0.2)
        }
      } catch {
        // 概念激活失败不影响交易
      }
    }

    if (this.stateMachine && typeof this.stateMachine.transition === 'function') {
      try {
        this.stateMachine.transition(event === 'open' ? 'trade_open' : 'trade_close')
        console.log(`[trade] 状态机集成: event=${event}`)
      } catch {
        // 状态迁移失败不影响交易
      }
    }
  }
}