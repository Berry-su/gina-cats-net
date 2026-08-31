/**
 * 分析师团队 —— 情绪面分析师 (sentiment-analyst.js)
 * 负责领域：市场情绪、恐慌贪婪指数、题材热度、妖股监控。
 * 规则：情绪极端时有逆向含义（极恐→机会、极贪→风险）；热度与涨跌停比值反映赚钱效应；
 *       异常波动（妖股）视为风险信号。
 */

import { Analyst } from './analyst.js'

export class SentimentAnalyst extends Analyst {
  constructor({ brain = null } = {}) {
    super({ role: '情绪面分析师', domain: '市场情绪、恐慌贪婪指数、题材热度、妖股监控', brain })
  }

  analyze(snapshot) {
    const s = snapshot.sentiment ?? {}
    let score = 0
    const reasons = []
    const keyData = []
    const risks = []

    // 恐慌贪婪指数
    if (s.fearGreedIndex != null) {
      keyData.push(`恐慌贪婪 ${s.fearGreedIndex}`)
      if (s.fearGreedIndex <= 25) { score += 0.2; reasons.push('情绪冰点，逆向看机会') }
      else if (s.fearGreedIndex <= 45) { score -= 0.1; risks.push('情绪偏恐慌') }
      else if (s.fearGreedIndex <= 60) { score += 0.05; reasons.push('情绪中性偏稳') }
      else if (s.fearGreedIndex <= 80) { score += 0.15; reasons.push('情绪回暖') }
      else { score -= 0.25; risks.push('贪婪过热，警惕回调') }
    }

    // 题材/板块热度
    if (s.sectorHeat === 'hot') { score += 0.1; reasons.push('板块热度高') }
    else if (s.sectorHeat === 'cold') { score -= 0.15; risks.push('板块情绪冰点') }
    if (s.themeHeat === 'hot' && s.sectorHeat !== 'cold') { score += 0.05 }

    // 涨跌停比值（赚钱效应）
    if (s.limitUpCount != null && s.limitDownCount != null) {
      keyData.push(`涨停 ${s.limitUpCount} / 跌停 ${s.limitDownCount}`)
      if (s.limitUpCount >= s.limitDownCount * 3 && s.limitUpCount > 40) { score += 0.15; reasons.push('赚钱效应强（涨停远多于跌停）') }
      else if (s.limitDownCount >= s.limitUpCount * 3 && s.limitDownCount > 40) { score -= 0.2; risks.push('恐慌蔓延（跌停潮）') }
    }

    // 妖股/异常波动监控
    if (s.abnormalVolatility) { score -= 0.25; risks.push('出现异动/妖股，波动风险高') }

    return this._decide({
      score,
      reasons,
      keyData,
      risks,
      concepts: ['behavior_finance', 'trading_psychology', 'over_speculation', 'contrarian', 'panic', 'black_swan'],
    })
  }
}