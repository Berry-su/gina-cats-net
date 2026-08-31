/**
 * 分析师团队 —— 技术面分析师 (technical-analyst.js)
 * 负责领域：K 线、均线、量价、支撑压力、形态。
 * 规则：趋势方向 + 均线多空排列 + MACD + RSI 超买超卖 + 突破/破位形态 + 量能配合。
 */

import { Analyst } from './analyst.js'

export class TechnicalAnalyst extends Analyst {
  constructor({ brain = null } = {}) {
    super({ role: '技术面分析师', domain: 'K线、均线、量价、支撑压力、形态', brain })
  }

  analyze(snapshot) {
    const t = snapshot.technical ?? {}
    let score = 0
    const reasons = []
    const keyData = []
    const risks = []

    // 趋势
    if (t.trend === 'up') { score += 0.3; reasons.push('趋势向上'); keyData.push('趋势：多头') }
    else if (t.trend === 'down') { score -= 0.3; reasons.push('趋势向下'); keyData.push('趋势：空头'); risks.push('下行趋势') }
    else keyData.push('趋势：震荡')

    // 均线
    if (t.aboveMa20) { score += 0.15; reasons.push('站上 20 日均线') }
    else { score -= 0.15; risks.push('跌破 20 日均线') }
    if (t.aboveMa60) { score += 0.1 }
    else { score -= 0.1 }

    // MACD
    if (t.macdSignal === 'golden') { score += 0.2; reasons.push('MACD 金叉'); keyData.push('MACD：金叉') }
    else if (t.macdSignal === 'dead') { score -= 0.2; keyData.push('MACD：死叉'); risks.push('MACD 死叉') }

    // RSI
    if (t.rsi14 != null) {
      keyData.push(`RSI ${t.rsi14}`)
      if (t.rsi14 >= 75) { score -= 0.15; risks.push('RSI 超买') }
      else if (t.rsi14 <= 25) { score += 0.1; reasons.push('RSI 超卖，或有反弹') }
    }

    // 形态
    if (t.pattern === 'breakout') { score += 0.2; reasons.push('突破关键位') }
    else if (t.pattern === 'breakdown') { score -= 0.2; risks.push('跌破支撑') }

    // 量价：放量配合趋势
    if (t.volumeRatio != null) {
      keyData.push(`量比 ${t.volumeRatio}`)
      if (t.trend === 'up' && t.volumeRatio >= 1.5) { score += 0.1; reasons.push('放量上攻') }
      else if (t.trend === 'down' && t.volumeRatio >= 1.5) { score -= 0.1; risks.push('放量下跌') }
    }

    return this._decide({
      score,
      reasons,
      keyData,
      risks,
      concepts: ['technical_analysis', 'trend_following', 'momentum', 'mean_reversion', 'stop_loss'],
    })
  }
}