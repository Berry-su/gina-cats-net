/**
 * 交易模块 —— 仓位管理 (position.js)
 *
 * 跟踪账户权益与持仓，计算浮动/已实现盈亏。
 * 资金模型（简化现金模型）：
 *   - 开仓买入：权益（现金）扣除买入成本；
 *   - 平仓卖出：权益回补卖出金额，并产出已实现盈亏；
 *   - 浮动盈亏 = (现价 - 持仓均价) × 持仓数量。
 */

export class PositionManager {
  /**
   * @param {object} [options]
   * @param {number} [options.initialEquity] 初始权益（现金）
   */
  constructor({ initialEquity = 100000 } = {}) {
    if (typeof initialEquity !== 'number' || initialEquity < 0) {
      throw new TypeError('initialEquity 必须为非负数值')
    }
    /** 现金权益。 */
    this.equity = initialEquity
    /** symbol -> { qty:number, avgPrice:number } */
    this.positions = new Map()
  }

  /** 当前现金权益。 */
  getEquity() {
    return this.equity
  }

  /** 是否存在某标的持仓。 */
  hasPosition(symbol) {
    return this.positions.has(symbol)
  }

  /**
   * 获取持仓。
   * @param {string} symbol
   * @returns {{qty:number, avgPrice:number}|undefined}
   */
  getPosition(symbol) {
    return this.positions.get(symbol)
  }

  /** 所有持仓列表。 */
  listPositions() {
    return Array.from(this.positions.entries()).map(([symbol, p]) => ({ symbol, ...p }))
  }

  /**
   * 开仓 / 加仓（买入）。
   * @param {string} symbol
   * @param {number} qty    买入数量（>0）
   * @param {number} price  成交价
   * @returns {{symbol:string, qty:number, avgPrice:number}} 更新后持仓
   */
  openPosition(symbol, qty, price) {
    if (typeof qty !== 'number' || qty <= 0) throw new TypeError('qty 必须为正数')
    if (typeof price !== 'number' || price <= 0 || Number.isNaN(price)) {
      throw new TypeError('price 必须为正数')
    }
    const cost = qty * price
    if (cost > this.equity) {
      throw new Error(`可用资金不足：需要 ${cost.toFixed(2)}，可用 ${this.equity.toFixed(2)}`)
    }

    const existing = this.positions.get(symbol)
    if (existing) {
      const totalQty = existing.qty + qty
      const avgPrice = (existing.qty * existing.avgPrice + qty * price) / totalQty
      existing.qty = totalQty
      existing.avgPrice = avgPrice
    } else {
      this.positions.set(symbol, { qty, avgPrice: price })
    }
    this.equity -= cost
    return { symbol, ...this.positions.get(symbol) }
  }

  /**
   * 平仓（卖出全部持仓）。
   * @param {string} symbol
   * @param {number} price 卖出价
   * @returns {{closed:boolean, pnl?:number, qty?:number, avgPrice?:number}}
   */
  closePosition(symbol, price) {
    if (typeof price !== 'number' || price <= 0 || Number.isNaN(price)) {
      throw new TypeError('price 必须为正数')
    }
    const pos = this.positions.get(symbol)
    if (!pos) return { closed: false }

    const pnl = (price - pos.avgPrice) * pos.qty
    this.equity += pos.qty * price
    this.positions.delete(symbol)
    return { closed: true, pnl, qty: pos.qty, avgPrice: pos.avgPrice }
  }

  /**
   * 单标的浮动盈亏。
   * @param {string} symbol
   * @param {number} currentPrice
   * @returns {number} 无持仓时返回 0
   */
  getUnrealizedPnl(symbol, currentPrice) {
    const pos = this.positions.get(symbol)
    if (!pos) return 0
    return (currentPrice - pos.avgPrice) * pos.qty
  }

  /**
   * 全部持仓浮动盈亏。
   * @param {Object<string, number>} currentPrices symbol -> 现价
   * @returns {number}
   */
  getTotalUnrealizedPnl(currentPrices = {}) {
    let total = 0
    for (const [symbol, pos] of this.positions) {
      const price = currentPrices[symbol]
      if (typeof price === 'number') total += (price - pos.avgPrice) * pos.qty
    }
    return total
  }

  /**
   * 全部持仓市值。
   * @param {Object<string, number>} currentPrices symbol -> 现价
   * @returns {number}
   */
  getTotalMarketValue(currentPrices = {}) {
    let total = 0
    for (const [symbol, pos] of this.positions) {
      const price = currentPrices[symbol]
      if (typeof price === 'number') total += pos.qty * price
    }
    return total
  }

  toJSON() {
    return {
      equity: this.equity,
      positions: this.listPositions(),
    }
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') throw new TypeError('fromJSON 需要对象')
    this.equity = data.equity
    this.positions = new Map()
    for (const p of data.positions ?? []) {
      this.positions.set(p.symbol, { qty: p.qty, avgPrice: p.avgPrice })
    }
    return this
  }
}