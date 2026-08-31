/**
 * 数据采集引擎 —— 异动监控 (abnormal-scanner.js)
 *
 * 对归一化后的行情做异动识别，用于「异动股自动推送」：
 *   - 涨跌幅超阈值（默认 ±5%）；
 *   - 成交量异常（量比超阈值，默认 3 倍）；
 *   - 龙虎榜上榜。
 * 命中任一条即标记为异动，产出结构化告警供下游（分析师团队/推送）消费。
 */

export class AbnormalScanner {
  /**
   * @param {object} [options]
   * @param {number} [options.priceMovePercent] 涨跌幅绝对阈值（比例，0.05 = 5%）
   * @param {number} [options.volumeSpikeRatio] 量比阈值（volume/avgVolume）
   */
  constructor({ priceMovePercent = 0.05, volumeSpikeRatio = 3 } = {}) {
    this.priceMovePercent = priceMovePercent
    this.volumeSpikeRatio = volumeSpikeRatio
  }

  /**
   * 扫描一批行情，返回异动列表。
   * @param {Array<object>} quotes
   * @returns {Array<{symbol:string,name:string,market:string,changePercent:number,reasons:string[]}>}
   */
  scan(quotes) {
    const out = []
    if (!Array.isArray(quotes)) return out

    for (const q of quotes) {
      if (!q || typeof q.symbol !== 'string') continue
      const reasons = []

      const pct = typeof q.changePercent === 'number' ? q.changePercent : 0
      if (Math.abs(pct) >= this.priceMovePercent) {
        reasons.push(pct >= 0 ? '涨幅超阈值' : '跌幅超阈值')
      }

      if (q.avgVolume > 0 && typeof q.volume === 'number' && q.volume / q.avgVolume >= this.volumeSpikeRatio) {
        reasons.push('成交量异常放量')
      }

      if (q.dragonTiger) {
        reasons.push('龙虎榜上榜')
      }

      if (reasons.length > 0) {
        out.push({
          symbol: q.symbol,
          name: q.name ?? q.symbol,
          market: q.market ?? 'US',
          changePercent: pct,
          reasons,
        })
      }
    }

    return out
  }
}