/**
 * 分析师团队 —— 基本面分析师 (fundamental-analyst.js)
 * 负责领域：财报、估值、行业景气度、公司基本面。
 * 规则：估值（PE/PB/估值分位）+ 盈利质量（ROE/增长）+ 行业景气 + 偿债能力共同决定性价比。
 */

import { Analyst } from './analyst.js'

export class FundamentalAnalyst extends Analyst {
  constructor({ brain = null } = {}) {
    super({ role: '基本面分析师', domain: '财报、估值、行业景气度、公司基本面', brain })
  }

  analyze(snapshot) {
    const f = snapshot.fundamental ?? {}
    let score = 0
    const reasons = []
    const keyData = []
    const risks = []

    // 估值（越低越好）
    if (f.pe != null) {
      keyData.push(`PE ${f.pe}`)
      if (f.pe <= 15) { score += 0.3; reasons.push('估值便宜（低PE）') }
      else if (f.pe >= 40) { score -= 0.35; reasons.push('估值偏高（高PE）'); risks.push('高估值') }
    }
    if (f.valuationPercentile != null) {
      if (f.valuationPercentile <= 20) { score += 0.2; reasons.push('估值处于历史低位') }
      else if (f.valuationPercentile >= 80) { score -= 0.25; risks.push('估值历史高位') }
    }
    if (f.peg != null && f.peg <= 1) { score += 0.15; keyData.push(`PEG ${f.peg}`) }

    // 盈利质量
    if (f.roe != null) {
      keyData.push(`ROE ${f.roe}%`)
      if (f.roe >= 15) { score += 0.25; reasons.push('净资产回报率高') }
      else if (f.roe <= 5) { score -= 0.25; reasons.push('净资产回报率低') }
    }
    if (f.profitGrowth != null) {
      keyData.push(`利润增速 ${f.profitGrowth}%`)
      if (f.profitGrowth >= 20) { score += 0.2; reasons.push('盈利高增长') }
      else if (f.profitGrowth <= 0) { score -= 0.25; reasons.push('盈利负增长') }
    }
    if (f.revenueGrowth != null && f.revenueGrowth <= -10) { score -= 0.15; risks.push('营收下滑') }

    // 行业景气
    if (f.industryProsperity === 'up') { score += 0.2; reasons.push('行业景气向上') }
    else if (f.industryProsperity === 'down') { score -= 0.2; reasons.push('行业景气回落'); risks.push('行业下行') }

    // 偿债能力
    if (f.debtRatio != null && f.debtRatio >= 70) { score -= 0.15; risks.push('负债率偏高') }

    return this._decide({
      score,
      reasons,
      keyData,
      risks,
      concepts: ['value_investing', 'intrinsic_value', 'margin_of_safety', 'fundamental_analysis', 'growth_investing', 'moat', 'peg_ratio'],
    })
  }
}