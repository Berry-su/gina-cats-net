/**
 * 分析师团队 —— 风控官 (risk-officer.js)
 * 负责领域：危机识别、仓位建议、止损预警。
 * 拥有一票否决权：只要判定「危机/暂停」，其他分析师再看多也无效，Gina 必须给出观望/降仓建议。
 *
 * 危机等级 = max(本地确定性规则等级, 共享大脑 MarketRegimeAdvisor 评估等级)：
 *   - 本地规则不依赖大脑，保证离线也能判定（大跌/流动性收紧/地缘+两融+异常波动/跌停潮）；
 *   - 大脑评估复用已植入的危机知识，命中历史案例时酌情抬升等级。
 *   L2（高风险）→ 一票否决（降仓/观望）；L3（危机）→ 暂停交易（熔断）。
 * 这是已有 L3 危机熔断在「团队层面」的延伸。
 */

import { Analyst, VIEWS } from './analyst.js'

export class RiskOfficer extends Analyst {
  constructor({ brain = null } = {}) {
    super({ role: '风控官', domain: '危机识别、仓位建议、止损预警', brain })
  }

  analyze(snapshot) {
    const concepts = this._deriveConcepts(snapshot)

    // 大脑评估（历史危机知识命中）
    let regimeLevel = 0
    let regime = null
    const regimeAdvisor = this.brain?.regimeAdvisor
    if (regimeAdvisor && typeof regimeAdvisor.assess === 'function') {
      try {
        regime = regimeAdvisor.assess(concepts)
        regimeLevel = regime?.level ?? 0
      } catch { regime = null }
    }

    // 本地确定性规则等级
    const localLevel = this._localLevel(snapshot)
    const level = Math.max(regimeLevel, localLevel)

    const halt = level >= 3
    const veto = level >= 2

    let view
    let label
    if (halt) { view = VIEWS.BEARISH; label = '暂停' }
    else if (veto) { view = VIEWS.BEARISH; label = '降仓' }
    else if (level === 1) { view = VIEWS.NEUTRAL; label = '观望' }
    else { view = VIEWS.NEUTRAL; label = '正常' }

    return this._decide({
      score: -level / 3,
      label,
      reasons: this._reasons(level, halt, veto, regime),
      keyData: [`危机等级 L${level}（本地 ${localLevel} / 大脑 ${regimeLevel}）`],
      risks: halt || veto ? [`风控官判定「${label}」，一票否决`] : [],
      concepts: ['risk_management', 'position_sizing', 'stop_loss', 'kelly_criterion', 'trading_psychology'],
      meta: {
        isRisk: true,
        veto,
        halt,
        level,
        localLevel,
        regimeLevel,
        regime,
      },
    })
  }

  _reasons(level, halt, veto, regime) {
    const ref = regime?.topMatch?.label ? `，参考：${regime.topMatch.label}` : ''
    if (halt) return [`危机级风险，暂停交易（L${level}）${ref}`]
    if (veto) return [`高风险，建议降仓/观望（L${level}）${ref}`]
    if (level === 1) return ['市场处于警惕状态，控制仓位']
    return ['未发现显著危机信号，维持正常风控']
  }

  /** 本地确定性危机等级（不依赖大脑）。 */
  _localLevel(snapshot) {
    let l = 0
    const chg = typeof snapshot.change1d === 'number' ? snapshot.change1d : null
    const tech = snapshot.technical ?? {}
    const macro = snapshot.macro ?? {}
    const flow = snapshot.fundFlow ?? {}
    const sent = snapshot.sentiment ?? {}

    // 大跌
    if (chg != null && chg <= -0.07) l = Math.max(l, 3)
    else if (chg != null && chg <= -0.03) l = Math.max(l, 1)

    // 异常波动（妖股/异动）
    if (sent.abnormalVolatility) l = Math.max(l, 1)

    // 流动性收紧 + 地缘
    if (macro.liquidity === 'tight' && macro.geopoliticalRisk === 'high') l = Math.max(l, 3)
    else if (macro.liquidity === 'tight') l = Math.max(l, 2)
    else if (macro.geopoliticalRisk === 'high') l = Math.max(l, 1)

    // 两融去杠杆 + 恐慌/破位
    if (flow.marginBalanceTrend === 'down') {
      if (sent.abnormalVolatility || (chg != null && chg <= -0.03) || tech.pattern === 'breakdown') {
        l = Math.max(l, 3)
      } else {
        l = Math.max(l, 1)
      }
    }

    // 跌停潮
    if (sent.limitDownCount != null && sent.limitDownCount >= 100) l = Math.max(l, 2)

    return l
  }

  _deriveConcepts(snapshot) {
    const out = []
    const t = snapshot.technical ?? {}
    const m = snapshot.macro ?? {}
    const f = snapshot.fundFlow ?? {}
    const s = snapshot.sentiment ?? {}

    if (typeof snapshot.change1d === 'number' && snapshot.change1d <= -0.03) out.push('panic')
    if (typeof snapshot.change1d === 'number' && snapshot.change1d <= -0.07) out.push('liquidity_crisis')
    if (m.liquidity === 'tight') out.push('liquidity_crisis', 'credit_crunch')
    if (m.geopoliticalRisk === 'high') out.push('black_swan')
    if (m.currencyPressure === 'depreciation') out.push('currency_crisis')
    if (f.marginBalanceTrend === 'down') out.push('margin_trading', 'leverage')
    if (s.abnormalVolatility) out.push('panic')
    if (t.pattern === 'breakdown' && f.marginBalanceTrend === 'down') out.push('margin_trading')

    return Array.from(new Set(out))
  }
}