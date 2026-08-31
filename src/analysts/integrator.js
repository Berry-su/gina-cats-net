/**
 * 分析师团队 —— Gina 整合器 (integrator.js)
 *
 * 权限链第三层中的「Gina 整合判断」：
 *   - 汇总全部分析师观点，执行分歧处理机制；
 *   - 风控官一票否决（危机/暂停 → 强制观望/降仓，其他看多无效）；
 *   - 输出「建议」而非「下单」；只有用户 approve() 授权后，getSignal() 才产出台规信号。
 *
 * 分歧处理规则：
 *   1) 风控官 veto → 降仓/暂停（最高优先级）；
 *   2) 看多分析师 ≥ minBullish → 买入建议；
 *   3) 看空分析师 ≥ minBearish → 卖出建议；
 *   4) 其余（含多空分歧大）→ 观望，不强行出信号。
 */

export class Integrator {
  /**
   * @param {object} options
   * @param {import('./analyst-team.js').AnalystTeam} [options.team]
   * @param {number} [options.minBullish] 达成买入共识所需最少看多人数
   * @param {number} [options.minBearish] 达成卖出共识所需最少看空人数
   */
  constructor({ team = null, minBullish = 3, minBearish = 3 } = {}) {
    this.team = team ?? null
    this.minBullish = minBullish
    this.minBearish = minBearish
    this._lastRecommendation = null
  }

  /**
   * 整合判断：产出建议（不直接下单）。
   * @param {object} snapshot
   * @returns {object} recommendation
   */
  integrate(snapshot) {
    if (!this.team) {
      const rec = { symbol: snapshot?.symbol, action: 'hold', label: '观望', reason: '未配置分析师团队', authorized: false }
      this._lastRecommendation = rec
      return rec
    }

    const { opinions, risk } = this.team.analyze(snapshot)

    // 分析师（不含风控官）观点统计
    const analysts = opinions.filter((o) => !o.meta?.isRisk && !o.meta?.error)
    const bullish = analysts.filter((o) => o.isBullish).length
    const bearish = analysts.filter((o) => o.isBearish).length
    const neutral = analysts.length - bullish - bearish

    const vetoed = !!(risk?.meta?.veto)
    const halt = !!(risk?.meta?.halt)

    let action
    let label
    let reason

    if (halt) {
      action = 'halt'
      label = '暂停'
      reason = `风控官一票否决（L${risk.meta.level ?? '?'}）：${risk.reasons?.[0] ?? '危机级风险'}`
    } else if (vetoed) {
      action = 'reduce'
      label = '降仓'
      reason = `风控官一票否决：${risk.reasons?.[0] ?? '高风险，建议观望/降仓'}`
    } else if (bullish >= this.minBullish) {
      action = 'buy'
      label = '买入'
      reason = `${bullish} 位分析师看多，达成买入共识（阈值 ${this.minBullish}）`
    } else if (bearish >= this.minBearish) {
      action = 'sell'
      label = '卖出'
      reason = `${bearish} 位分析师看空，达成卖出共识（阈值 ${this.minBearish}）`
    } else {
      action = 'hold'
      label = '观望'
      reason = bullish > 0 && bearish > 0
        ? `多空分歧较大（看多 ${bullish} / 看空 ${bearish} / 观望 ${neutral}），保持观望`
        : `信号不足（看多 ${bullish} / 看空 ${bearish} / 观望 ${neutral}），保持观望`
    }

    const recommendation = {
      symbol: snapshot?.symbol ?? 'UNKNOWN',
      action,
      label,
      reason,
      authorized: false,
      vetoed,
      halt,
      vetoReason: vetoed ? risk?.reasons?.[0] ?? null : null,
      bullish,
      bearish,
      neutral,
      divergence: (bullish > 0 && bearish > 0) ? 'high' : 'low',
      risk: risk ? { role: risk.role, label: risk.label, level: risk.meta?.level ?? null, veto: vetoed, halt } : null,
      opinions,
      summary: opinions.map((o) => `${o.role}: ${o.label}`).join('；'),
    }

    this._lastRecommendation = recommendation
    return recommendation
  }

  /** 用户拍板授权当前建议（可执行下单）。 */
  approve() {
    if (this._lastRecommendation) this._lastRecommendation.authorized = true
    return this
  }

  /** 撤销授权。 */
  clearApproval() {
    if (this._lastRecommendation) this._lastRecommendation.authorized = false
    return this
  }

  /** 当前建议。 */
  getRecommendation() {
    return this._lastRecommendation
  }

  /**
   * 产出可执行信号：只有「已授权」且「动作可交易」时才返回 buy/sell，否则拒绝。
   * @returns {{action:string, reason:string, symbol?:string}}
   */
  getSignal() {
    const rec = this._lastRecommendation
    if (!rec) return { action: 'hold', reason: '暂无整合建议' }

    if (rec.action === 'halt') return { action: 'hold', reason: '风控官已暂停交易，禁止下单' }
    if (rec.action === 'reduce') return { action: 'hold', reason: `建议降仓，需人工处置（${rec.reason}）` }

    if (!rec.authorized) {
      return { action: 'hold', reason: '未获用户授权，禁止下单（需 approve 后执行）' }
    }

    if (rec.action === 'buy') return { action: 'buy', reason: rec.reason, symbol: rec.symbol }
    if (rec.action === 'sell') return { action: 'sell', reason: rec.reason, symbol: rec.symbol }

    return { action: 'hold', reason: rec.reason }
  }
}