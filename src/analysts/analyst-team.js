/**
 * 分析师团队 —— 团队编排 (analyst-team.js)
 *
 * 汇集 5 个分析师 + 1 个风控官，对同一份市场快照并行分析，
 * 每个分身职责清晰、互不越权；风控官单独标记 isRisk 以便整合层识别。
 *
 * createAnalystTeam() 一键构建默认团队，所有成员共享同一个 brain。
 */

import { Opinion } from './analyst.js'
import { MacroAnalyst } from './macro-analyst.js'
import { FundamentalAnalyst } from './fundamental-analyst.js'
import { TechnicalAnalyst } from './technical-analyst.js'
import { FundFlowAnalyst } from './fundflow-analyst.js'
import { SentimentAnalyst } from './sentiment-analyst.js'
import { RiskOfficer } from './risk-officer.js'

export class AnalystTeam {
  /**
   * @param {object} options
   * @param {Array<import('./analyst.js').Analyst>} [options.analysts]
   * @param {RiskOfficer|null} [options.riskOfficer]
   */
  constructor({ analysts = [], riskOfficer = null } = {}) {
    this.analysts = Array.isArray(analysts) ? analysts : []
    this.riskOfficer = riskOfficer ?? null
  }

  /** 当前团队总人数（含风控官）。 */
  get size() {
    return this.analysts.length + (this.riskOfficer ? 1 : 0)
  }

  /**
   * 对快照执行全团队分析。
   * @param {object} snapshot
   * @returns {{opinions:Opinion[], risk:Opinion|null}}
   */
  analyze(snapshot) {
    const opinions = []
    for (const a of this.analysts) {
      try {
        opinions.push(a.analyze(snapshot))
      } catch (err) {
        opinions.push(new Opinion({
          role: a?.role ?? '未知分析师',
          view: 'neutral',
          label: '观望',
          reasons: [`分析异常：${err?.message ?? err}`],
          meta: { error: true },
        }))
      }
    }

    let risk = null
    if (this.riskOfficer) {
      try {
        risk = this.riskOfficer.analyze(snapshot)
      } catch (err) {
        risk = new Opinion({
          role: '风控官',
          view: 'neutral',
          label: '观望',
          reasons: [`风控评估异常：${err?.message ?? err}`],
          meta: { isRisk: true, error: true },
        })
      }
    }

    return { opinions, risk }
  }
}

/**
 * 构建默认分析师团队（共享同一个 brain）。
 * @param {object|null} brain 共享大脑（createSharedBrain 的返回值）
 * @param {object} [options]
 * @param {AnalystTeam|null} [options.existing] 若提供则复用该团队实例
 * @returns {AnalystTeam}
 */
export function createAnalystTeam(brain = null, { existing = null } = {}) {
  if (existing instanceof AnalystTeam) return existing

  return new AnalystTeam({
    analysts: [
      new MacroAnalyst({ brain }),
      new FundamentalAnalyst({ brain }),
      new TechnicalAnalyst({ brain }),
      new FundFlowAnalyst({ brain }),
      new SentimentAnalyst({ brain }),
    ],
    riskOfficer: new RiskOfficer({ brain }),
  })
}