/**
 * 分析师团队 —— 宏观策略师 (macro-analyst.js)
 * 负责领域：美联储/央行政策、利率、汇率、地缘政治。
 * 规则：流动性、货币政策取向、地缘风险、汇率压力共同决定宏观风险偏好。
 */

import { Analyst } from './analyst.js'

export class MacroAnalyst extends Analyst {
  constructor({ brain = null } = {}) {
    super({ role: '宏观策略师', domain: '美联储/央行政策、利率、汇率、地缘政治', brain })
  }

  analyze(snapshot) {
    const m = snapshot.macro ?? {}
    let score = 0
    const reasons = []
    const keyData = []
    const risks = []

    // 流动性
    if (m.liquidity === 'loose') { score += 0.35; reasons.push('流动性宽松，支撑风险资产'); keyData.push('流动性：宽松') }
    else if (m.liquidity === 'tight') { score -= 0.4; reasons.push('流动性收紧，压制估值'); risks.push('流动性收紧') }

    // 货币政策取向
    if (m.policyBias === 'dovish') { score += 0.3; reasons.push('货币政策偏鸽，宽松预期'); keyData.push('政策取向：偏鸽') }
    else if (m.policyBias === 'hawkish') { score -= 0.35; reasons.push('货币政策偏鹰，紧缩预期'); risks.push('加息/紧缩预期') }

    // 地缘政治
    if (m.geopoliticalRisk === 'high') { score -= 0.4; reasons.push('地缘政治风险高企'); risks.push('地缘政治风险高') }
    else if (m.geopoliticalRisk === 'low') { score += 0.15; reasons.push('地缘环境平稳') }

    // 汇率/本币压力
    if (m.currencyPressure === 'depreciation') { score -= 0.2; reasons.push('本币贬值压力，资本外流风险'); risks.push('汇率贬值压力') }
    else if (m.currencyPressure === 'appreciation') { score += 0.1; reasons.push('本币走强，资本回流') }

    // 利率水平（仅作数据展示与轻度影响）
    if (m.interestRate != null) {
      keyData.push(`利率 ${m.interestRate}%`)
      if (m.interestRate >= 5) score -= 0.1
      else if (m.interestRate <= 2) score += 0.1
    }

    return this._decide({
      score,
      reasons,
      keyData,
      risks,
      concepts: ['monetary_policy', 'interest_rate', 'economic_cycle', 'liquidity_crisis', 'currency_crisis', 'trade_war'],
    })
  }
}