/**
 * 数据采集引擎 —— 全市场行情源 (quote-source.js)
 *
 * 行情源的抽象接口与 Mock 实现。真实接入时（券商/交易所/数据服务商行情）继承 QuoteSource
 * 实现 fetch() 即可；本模块不绑定具体行情网关。
 *
 * MockQuoteSource 对自选池做随机游走，并小概率制造大涨/大跌、放量与龙虎榜，供异动扫描演练。
 */

import { buildWatchlist } from './watchlist.js'

/**
 * 行情源基类。
 */
export class QuoteSource {
  async fetch() {
    return []
  }

  async stop() {}
}

/**
 * 离线 Mock 行情源。
 */
export class MockQuoteSource extends QuoteSource {
  /**
   * @param {object} [options]
   * @param {{us:Array,cn:Array}|null} [options.watchlist] 自选池；缺省用 buildWatchlist()
   * @param {number} [options.basePrice]    美股基准价
   * @param {number} [options.cnBasePrice]  A 股基准价
   * @param {number} [options.volatility]   常规波动幅度
   * @param {number} [options.spikeProbability] 制造大涨/大跌的概率
   * @param {number} [options.dragonTigerProbability] 龙虎榜上榜概率
   */
  constructor({
    watchlist = null,
    basePrice = 200,
    cnBasePrice = 50,
    volatility = 0.02,
    spikeProbability = 0.02,
    dragonTigerProbability = 0.015,
  } = {}) {
    super()
    this.watchlist = watchlist ?? buildWatchlist({ usCount: 500, cnCount: 100 })
    this.basePrice = basePrice
    this.cnBasePrice = cnBasePrice
    this.volatility = volatility
    this.spikeProbability = spikeProbability
    this.dragonTigerProbability = dragonTigerProbability
    /** symbol -> lastPrice（随机游走基准） */
    this._last = new Map()
    /** symbol -> avgVolume（用于量比） */
    this._avg = new Map()
  }

  async fetch() {
    const quotes = []
    this._emit(quotes, this.watchlist.us, 'US', this.basePrice)
    this._emit(quotes, this.watchlist.cn, 'CN', this.cnBasePrice)
    return quotes
  }

  _emit(list, items, market, base) {
    for (const { symbol, name } of items) {
      const prev = this._last.get(symbol) ?? base
      let changePercent = (Math.random() * 2 - 1) * this.volatility

      // 制造异动：大涨/大跌
      if (Math.random() < this.spikeProbability) {
        const magnitude = 0.05 + Math.random() * 0.06 // 5%~11%
        changePercent = Math.random() < 0.5 ? magnitude : -magnitude
      }

      const price = Math.max(0.01, prev * (1 + changePercent))
      const prevClose = prev
      const baseVolume = 1000000 + Math.floor(Math.random() * 5000000)
      let volume = baseVolume
      // 放量：量比突破
      if (Math.abs(changePercent) >= 0.05 || Math.random() < this.spikeProbability) {
        volume = baseVolume * (3 + Math.random() * 5)
      }
      const avgVolume = this._avg.get(symbol) ?? baseVolume * 0.8
      const dragonTiger = Math.random() < this.dragonTigerProbability

      this._last.set(symbol, price)
      this._avg.set(symbol, avgVolume)

      list.push({
        symbol,
        name,
        market,
        price: round(price, market === 'US' ? 2 : 2),
        prevClose: round(prevClose, 2),
        changePercent,
        open: round(prevClose, 2),
        high: round(Math.max(price, prevClose) * 1.005, 2),
        low: round(Math.min(price, prevClose) * 0.995, 2),
        volume: Math.floor(volume),
        avgVolume: Math.floor(avgVolume),
        dragonTiger,
        timestamp: Date.now(),
      })
    }
  }
}

function round(v, digits = 2) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}