/**
 * 交易模块 —— 策略信号计算 (strategy.js)
 *
 * 策略层只负责「方向判断」，输出结构化信号，供交易引擎 + 风控层审计：
 *   - 信号结构：{ action: 'buy' | 'sell' | 'hold', size?: number, reason: string }
 *   - 策略不直接下单，不接触资金与风控，保证职责单一。
 *
 * 本文件提供：Strategy 基类 + 两个示例策略（均线交叉、突破）。
 */

/** 计算数组均值。 */
function average(arr) {
  if (!arr || arr.length === 0) return 0
  return arr.reduce((sum, v) => sum + v, 0) / arr.length
}

export class Strategy {
  /**
   * @param {object} [options]
   * @param {string} [options.name] 策略名
   */
  constructor({ name = 'base' } = {}) {
    this.name = name
  }

  /**
   * 根据一只 tick 与当前持仓计算信号。
   * @param {import('./market-data.js').Tick} tick
   * @param {object|null} position 当前持仓（无则为 null）
   * @returns {{action:string, size?:number, reason:string}}
   */
  onTick(tick, position = null) {
    return { action: 'hold', reason: 'base-strategy' }
  }
}

/**
 * 均线交叉策略：短期均线上穿长期均线 → buy；下穿 → sell。
 */
export class MovingAverageStrategy extends Strategy {
  /**
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {number} [options.shortWindow] 短期均线窗口
   * @param {number} [options.longWindow]  长期均线窗口
   */
  constructor({ name = 'ma-cross', shortWindow = 5, longWindow = 20 } = {}) {
    super({ name })
    if (shortWindow >= longWindow) throw new RangeError('shortWindow 必须小于 longWindow')
    this.shortWindow = shortWindow
    this.longWindow = longWindow
    /** @type {Map<string, {prices:number[], prevShort:number|null, prevLong:number|null}>} */
    this.state = new Map()
  }

  onTick(tick, position = null) {
    let st = this.state.get(tick.symbol)
    if (!st) {
      st = { prices: [], prevShort: null, prevLong: null }
      this.state.set(tick.symbol, st)
    }
    st.prices.push(tick.close)
    if (st.prices.length > this.longWindow + 1) st.prices.shift()

    if (st.prices.length < this.longWindow) {
      return { action: 'hold', reason: `数据不足 (${st.prices.length}/${this.longWindow})` }
    }

    const short = average(st.prices.slice(-this.shortWindow))
    const long = average(st.prices)

    const signal = this._crossSignal(short, long, st)
    if (signal === 'buy') {
      st.prevShort = short
      st.prevLong = long
      return { action: 'buy', reason: `均线金叉 short=${short.toFixed(2)} long=${long.toFixed(2)}` }
    }
    if (signal === 'sell') {
      st.prevShort = short
      st.prevLong = long
      return { action: 'sell', reason: `均线死叉 short=${short.toFixed(2)} long=${long.toFixed(2)}` }
    }

    st.prevShort = short
    st.prevLong = long
    return { action: 'hold', reason: '无交叉' }
  }

  _crossSignal(short, long, st) {
    if (st.prevShort === null || st.prevLong === null) return 'hold'
    if (st.prevShort <= st.prevLong && short > long) return 'buy'
    if (st.prevShort >= st.prevLong && short < long) return 'sell'
    return 'hold'
  }
}

/**
 * 突破策略：收盘价突破最近 N 根最高价 → buy；跌破最低价 → sell。
 */
export class BreakoutStrategy extends Strategy {
  /**
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {number} [options.window] 突破观察窗口
   */
  constructor({ name = 'breakout', window = 10 } = {}) {
    super({ name })
    this.window = window
    /** @type {Map<string, number[]>} */
    this.history = new Map()
  }

  onTick(tick, position = null) {
    let list = this.history.get(tick.symbol)
    if (!list) {
      list = []
      this.history.set(tick.symbol, list)
    }
    list.push(tick.close)
    if (list.length > this.window + 1) list.shift()

    if (list.length < this.window) {
      return { action: 'hold', reason: `数据不足 (${list.length}/${this.window})` }
    }

    const lookback = list.slice(0, -1) // 不含当前价
    const high = Math.max(...lookback)
    const low = Math.min(...lookback)

    if (tick.close > high) return { action: 'buy', reason: `突破前高 ${high.toFixed(2)}` }
    if (tick.close < low) return { action: 'sell', reason: `跌破前低 ${low.toFixed(2)}` }
    return { action: 'hold', reason: '区间内震荡' }
  }
}