/**
 * 分析师团队 —— 基类与分析观点 (analyst.js)
 *
 * 定义了统一的分析师基类 Analyst 与固定输出格式的 Opinion：
 *   【角色】【观点】【核心理由】【关键数据】【风险提示】
 * 所有分析师分身共享同一个大脑（brain = { catsNet, memoryManager, knowledgeAdvisor, regimeAdvisor }），
 * 由外部统一注入；各分身仅差异在「职责领域」与「评分规则」。
 */

export const VIEWS = Object.freeze({
  BULLISH: 'bullish',
  BEARISH: 'bearish',
  NEUTRAL: 'neutral',
})

export const VIEW_LABELS = Object.freeze({
  bullish: '看多',
  bearish: '看空',
  neutral: '观望',
})

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 一条分析师观点（固定格式）。
 */
export class Opinion {
  /**
   * @param {object} o
   * @param {string} o.role        角色名
   * @param {string} o.view        观点类型 bullish/bearish/neutral
   * @param {string} [o.label]     观点文案（缺省取 VIEW_LABELS）
   * @param {string[]} [o.reasons]  核心理由 1-2 条
   * @param {string[]} [o.keyData]  关键数据 1-2 条
   * @param {string[]} [o.risks]    风险提示 1 条
   * @param {object} [o.meta]       附加信息（score / veto / halt / regime / knowledge 等）
   */
  constructor({ role, view, label, reasons = [], keyData = [], risks = [], meta = {} }) {
    this.role = role
    this.view = view
    this.label = label ?? VIEW_LABELS[view] ?? view
    this.reasons = Array.isArray(reasons) ? reasons.filter(Boolean) : []
    this.keyData = Array.isArray(keyData) ? keyData.filter(Boolean) : []
    this.risks = Array.isArray(risks) ? risks.filter(Boolean) : []
    this.meta = meta ?? {}
  }

  get isBullish() { return this.view === VIEWS.BULLISH }
  get isBearish() { return this.view === VIEWS.BEARISH }
  get isNeutral() { return this.view === VIEWS.NEUTRAL }

  /** 固定格式纯文本输出。 */
  toText() {
    return [
      `【角色】${this.role}`,
      `【观点】${this.label}`,
      `【核心理由】${this.reasons.length ? this.reasons.join('；') : '—'}`,
      `【关键数据】${this.keyData.length ? this.keyData.join('；') : '—'}`,
      `【风险提示】${this.risks.length ? this.risks.join('；') : '无'}`,
    ].join('\n')
  }
}

/**
 * 分析师基类。子类实现 analyze(snapshot) 返回 Opinion。
 */
export class Analyst {
  /**
   * @param {object} options
   * @param {string} options.role   角色名
   * @param {string} options.domain 负责领域
   * @param {object|null} [options.brain] 共享大脑（catsNet/memoryManager/knowledgeAdvisor/regimeAdvisor）
   */
  constructor({ role, domain, brain = null } = {}) {
    if (!role) throw new TypeError('Analyst 需要 role')
    this.role = role
    this.domain = domain ?? ''
    this.brain = brain ?? null
  }

  /** 子类实现：根据快照产出观点。 */
  analyze(_snapshot) {
    throw new Error(`${this.role}.analyze 未实现`)
  }

  /**
   * 便捷：根据评分与素材构造观点。
   * @param {object} p
   * @param {number} p.score       [-1,1] 正看多负看空
   * @param {string[]} [p.reasons]
   * @param {string[]} [p.keyData]
   * @param {string[]} [p.risks]
   * @param {string[]} [p.concepts] 用于召唤知识依据的概念 id
   * @param {object} [p.meta]
   * @returns {Opinion}
   */
  _decide({ score, reasons = [], keyData = [], risks = [], concepts = [], meta = {}, label = null }) {
    const s = clamp(score, -1, 1)
    const view = s >= 0.3 ? VIEWS.BULLISH : s <= -0.3 ? VIEWS.BEARISH : VIEWS.NEUTRAL

    const knowledge = this._explain(concepts)
    if (knowledge) {
      meta.knowledge = knowledge
    }

    return new Opinion({
      role: this.role,
      view,
      label: label ?? VIEW_LABELS[view],
      reasons: reasons.slice(0, 2),
      keyData: keyData.slice(0, 2),
      risks: risks.slice(0, 1),
      meta: { score: s, ...meta },
    })
  }

  /** 从共享大脑的知识顾问召回体系化依据（无大脑则返回空）。 */
  _explain(concepts = []) {
    const advisor = this.brain?.knowledgeAdvisor
    if (!advisor || typeof advisor.explain !== 'function') return ''
    try {
      return advisor.explain(concepts).reason
    } catch {
      return ''
    }
  }
}

export { clamp }