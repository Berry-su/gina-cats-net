/**
 * 分析师团队 —— 资金面分析师 (fundflow-analyst.js)
 * 负责领域：北向资金、龙虎榜、融资融券、主力动向。
 * 规则：聪明钱（北向/主力/龙虎榜）净流入 + 两融余额趋势 + 换手热度共同判断资金面强弱。
 */

import { Analyst } from './analyst.js'

export class FundFlowAnalyst extends Analyst {
  constructor({ brain = null } = {}) {
    super({ role: '资金面分析师', domain: '北向资金、龙虎榜、融资融券、主力动向', brain })
  }

  analyze(snapshot) {
    const f = snapshot.fundFlow ?? {}
    let score = 0
    const reasons = []
    const keyData = []
    const risks = []

    // 北向资金（亿元）
    if (f.northboundNet != null) {
      keyData.push(`北向净买入 ${f.northboundNet} 亿`)
      if (f.northboundNet >= 30) { score += 0.25; reasons.push('北向资金大幅流入') }
      else if (f.northboundNet <= -30) { score -= 0.25; risks.push('北向资金大幅流出') }
    }

    // 主力净流入（亿元）
    if (f.mainForceNet != null) {
      keyData.push(`主力净流入 ${f.mainForceNet} 亿`)
      if (f.mainForceNet >= 30) { score += 0.2; reasons.push('主力资金净流入') }
      else if (f.mainForceNet <= -30) { score -= 0.2; risks.push('主力资金净流出') }
    }

    // 龙虎榜（亿元）
    if (f.dragonTigerNetBuy != null) {
      if (f.dragonTigerNetBuy >= 10) { score += 0.15; reasons.push('龙虎榜游资净买入') }
      else if (f.dragonTigerNetBuy <= -10) { score -= 0.15; risks.push('龙虎榜净卖出') }
    }

    // 两融余额趋势
    if (f.marginBalanceTrend === 'up') { score += 0.15; reasons.push('两融余额上升，杠杆资金进场') }
    else if (f.marginBalanceTrend === 'down') { score -= 0.2; risks.push('两融去杠杆，资金撤离') }

    // 换手率（过高警惕，适中健康）
    if (f.turnoverRate != null) {
      keyData.push(`换手率 ${f.turnoverRate}%`)
      if (f.turnoverRate >= 10) { score -= 0.1; risks.push('换手过热，警惕博弈') }
      else if (f.turnoverRate <= 1.5) { score -= 0.1; risks.push('流动性不足') }
    }

    return this._decide({
      score,
      reasons,
      keyData,
      risks,
      concepts: ['margin_trading', 'momentum', 'trend_following', 'liquidity_crisis', 'panic'],
    })
  }
}