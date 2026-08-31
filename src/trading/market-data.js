/**
 * 交易模块 —— 行情接入抽象层 (market-data.js)
 *
 * 提供统一的行情接入接口，隔离不同数据源（模拟源 / 真实行情源）：
 *   - Tick 统一数据结构：{ symbol, timestamp, open, high, low, close, volume }
 *   - MarketDataProvider：抽象基类，负责订阅标的、注册 tick 回调；
 *   - MockMarketDataProvider：模拟行情源，用于开发与测试（可定时产生随机游走行情）。
 *
 * 后续接入真实行情（如券商 / 数据服务商）时，只需继承 MarketDataProvider
 * 实现数据拉取/推送并调用 _emit 即可，上层交易引擎无需改动。
 */

/**
 * 统一的行情 Tick 结构。
 * @typedef {object} Tick
 * @property {string} symbol     标的代码
 * @property {number} timestamp  毫秒时间戳
 * @property {number} open       开盘价
 * @property {number} high       最高价
 * @property {number} low        最低价
 * @property {number} close      收盘价（最新价）
 * @property {number} [volume]   成交量
 */

export class MarketDataProvider {
  constructor() {
    /** @type {Set<string>} */
    this.symbols = new Set()
    /** @type {Array<(tick: Tick) => void>} */
    this.listeners = []
    this._running = false
  }

  /** 订阅标的。 */
  registerSymbol(symbol) {
    if (typeof symbol !== 'string' || symbol.length === 0) {
      throw new TypeError('registerSymbol 需要非空字符串 symbol')
    }
    this.symbols.add(symbol)
    return this
  }

  /** 已订阅标的列表。 */
  getSymbols() {
    return Array.from(this.symbols)
  }

  /** 注册 tick 回调。 */
  onTick(callback) {
    if (typeof callback !== 'function') throw new TypeError('onTick 需要函数')
    this.listeners.push(callback)
    return this
  }

  /** 启动行情（子类覆盖）。 */
  start() {
    this._running = true
    return this
  }

  /** 停止行情（子类覆盖）。 */
  stop() {
    this._running = false
    return this
  }

  isRunning() {
    return this._running
  }

  /** 校验并广播一只 tick。 */
  _emit(tick) {
    const t = this._validateTick(tick)
    for (const cb of this.listeners) {
      try {
        cb(t)
      } catch {
        // 单个回调异常不阻断行情广播
      }
    }
    return t
  }

  /** 校验 tick 结构。 */
  _validateTick(tick) {
    if (!tick || typeof tick !== 'object') throw new TypeError('tick 必须是对象')
    if (typeof tick.symbol !== 'string' || tick.symbol.length === 0) throw new TypeError('tick 需要 symbol')
    if (typeof tick.close !== 'number' || Number.isNaN(tick.close)) throw new TypeError('tick 需要数值 close')
    return tick
  }
}

/**
 * 模拟行情源：随机游走生成 OHLCV。
 */
export class MockMarketDataProvider extends MarketDataProvider {
  /**
   * @param {object} [options]
   * @param {string[]} [options.symbols]    初始订阅标的
   * @param {number} [options.intervalMs]   定时产生行情的间隔（毫秒）
   * @param {number} [options.basePrice]    初始基准价
   * @param {number} [options.volatility]   波动率（单 tick 最大涨跌比例）
   */
  constructor({ symbols = [], intervalMs = 1000, basePrice = 100, volatility = 0.02 } = {}) {
    super()
    this.intervalMs = intervalMs
    this.basePrice = basePrice
    this.volatility = volatility
    /** 记录各标的最近价格，用于随机游走。 */
    this.lastPrices = new Map()
    this._timer = null
    for (const s of symbols) this.registerSymbol(s)
  }

  /** 手动生成一只 tick（不依赖定时器，便于测试）。 */
  generateTick(symbol) {
    const prev = this.lastPrices.get(symbol) ?? this.basePrice
    // 随机涨跌：[-volatility, +volatility]
    const drift = (Math.random() * 2 - 1) * this.volatility
    const close = Math.max(0.01, prev * (1 + drift))
    const open = prev
    const high = Math.max(open, close) * (1 + Math.random() * this.volatility * 0.5)
    const low = Math.min(open, close) * (1 - Math.random() * this.volatility * 0.5)
    const volume = Math.round(100 + Math.random() * 900)
    this.lastPrices.set(symbol, close)

    const tick = {
      symbol,
      timestamp: Date.now(),
      open,
      high,
      low,
      close,
      volume,
    }
    this._emit(tick)
    return tick
  }

  start() {
    if (this._running) return this
    this._running = true
    this._timer = setInterval(() => {
      for (const symbol of this.symbols) this.generateTick(symbol)
    }, this.intervalMs)
    return this
  }

  stop() {
    this._running = false
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    return this
  }
}