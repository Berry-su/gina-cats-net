/**
 * 交易模块 —— 投资知识决策顾问 (knowledge-advisor.js)
 *
 * 将已植入的投资知识（书籍 / 交易技术 / 股神案例）接入策略信号与风控决策链路：
 *   - frameworkOf(concepts)：根据概念集合识别当前所属的投资体系（价值 / 成长 / 趋势 / 量化 / 宏观 / 风控）；
 *   - explain(concepts)：召回最相关的书籍、技术、案例，并综合成一句带依据的决策理由，
 *     供策略信号输出「具体理由」、供风控层给出「知识依据」。
 *
 * 依赖方向单向 trading → memory/cats_net，通过构造注入；未注入时降级为仅体系名称、无引用的理由。
 */

/** 投资体系定义：概念匹配集 + 决策原则。 */
export const FRAMEWORKS = Object.freeze({
  value: {
    name: '价值投资体系',
    rule: '以低于内在价值并留安全边际买入',
    concepts: ['value_investing', 'intrinsic_value', 'margin_of_safety', 'fundamental_analysis', 'moat', 'dcf_valuation'],
  },
  growth: {
    name: '成长投资体系',
    rule: '以合理价格买入高成长优质企业',
    concepts: ['growth_investing', 'peg_ratio', 'long_term_holding', 'compounding', 'circle_of_competence'],
  },
  trend: {
    name: '趋势跟踪体系',
    rule: '顺应趋势、突破入场并严守止损',
    concepts: ['trend_following', 'momentum', 'technical_analysis', 'mean_reversion'],
  },
  quant: {
    name: '量化投资体系',
    rule: '系统化、纪律化、分散化',
    concepts: ['quant_investing', 'arbitrage', 'hedging', 'event_driven'],
  },
  macro: {
    name: '宏观对冲体系',
    rule: '识别宏观失衡并顺势对冲',
    concepts: ['reflexivity', 'economic_cycle', 'asset_allocation', 'short_selling', 'currency_crisis'],
  },
  risk: {
    name: '风险与仓位体系',
    rule: '先控风险、仓位与止损，再谋收益',
    concepts: ['risk_management', 'position_sizing', 'kelly_criterion', 'stop_loss', 'trading_psychology'],
  },
})

/** 知识类型标注文案。 */
const KIND_ALIAS = { book: '书籍', technique: '技术', case: '案例' }

function cleanLabel(label = '') {
  return String(label).replace(/^\[(?:书籍|交易技术|股神案例)\]\s*/, '')
}

export class KnowledgeAdvisor {
  /**
   * @param {object} [options]
   * @param {object|null} [options.catsNet]        CATS-Net 实例（可选）
   * @param {object|null} [options.memoryManager]  记忆管理器实例（可选）
   */
  constructor({ catsNet = null, memoryManager = null } = {}) {
    this.catsNet = catsNet ?? null
    this.memoryManager = memoryManager ?? null
  }

  /** 是否接入任何知识源。 */
  hasKnowledge() {
    return !!(this.catsNet || this.memoryManager)
  }

  /**
   * 根据概念集合识别所属投资体系。
   * @param {string[]} concepts
   * @returns {{key:string, name:string, rule:string}|null}
   */
  frameworkOf(concepts = []) {
    const set = new Set(Array.isArray(concepts) ? concepts : [])
    if (set.size === 0) return null
    let best = null
    let bestScore = 0
    for (const [key, fw] of Object.entries(FRAMEWORKS)) {
      const hits = fw.concepts.filter((c) => set.has(c)).length
      if (hits > bestScore) {
        bestScore = hits
        best = { key, name: fw.name, rule: fw.rule }
      }
    }
    return bestScore > 0 ? best : null
  }

  /**
   * 召回相关知识并生成决策依据理由。
   * @param {string[]} concepts 当前决策涉及的概念 id
   * @param {object} [options]
   * @param {number} [options.limit] 参与生成理由的知识条数上限
   * @param {string|null} [options.frameworkKey] 强制指定体系（否则自动识别）
   * @returns {object} { framework, references, reason }
   */
  explain(concepts = [], { limit = 3, frameworkKey = null } = {}) {
    const query = Array.isArray(concepts) ? concepts.filter((c) => typeof c === 'string') : []

    const framework = frameworkKey && FRAMEWORKS[frameworkKey]
      ? { key: frameworkKey, ...FRAMEWORKS[frameworkKey] }
      : this.frameworkOf(query)

    const references = this._recall(query).slice(0, limit)

    const parts = []
    if (framework) parts.push(`${framework.name}（${framework.rule}）`)
    if (references.length > 0) {
      const refs = references
        .map((r) => {
          const title = cleanLabel(r.label).split('|')[0].trim()
          if (!title) return null
          const tag = KIND_ALIAS[r.kind] ?? ''
          return tag ? `${tag}《${title}》` : `《${title}》`
        })
        .filter(Boolean)
      if (refs.length > 0) parts.push(`依据：${refs.join('；')}`)
    }

    const reason = parts.length > 0 ? parts.join('｜') : (framework ? framework.name : '暂无知识依据')

    return {
      framework,
      references,
      reason,
    }
  }

  // ---------------------------------------------------------------------------
  // 私有工具
  // ---------------------------------------------------------------------------

  /** 从抽象空间与分层记忆中召回相关知识（去重、按分数降序）。 */
  _recall(query, { limit = 20 } = {}) {
    const results = []

    if (this.catsNet && typeof this.catsNet.retrieveMemory === 'function') {
      try {
        for (const h of this.catsNet.retrieveMemory(query, { limit, minScore: 0 })) {
          results.push({
            label: h.entry?.label ?? '',
            content: h.entry?.content ?? '',
            kind: this._kindOf(h.entry?.content ?? ''),
            score: h.score ?? 0,
            source: 'abstract',
          })
        }
      } catch {
        // 内核异常降级
      }
    }

    if (this.memoryManager && typeof this.memoryManager.retrieve === 'function') {
      try {
        for (const h of this.memoryManager.retrieve(query, { limit })) {
          results.push({
            label: h.entry?.label ?? '',
            content: h.entry?.content ?? '',
            kind: this._kindOf(h.entry?.content ?? ''),
            score: h.score ?? 0,
            source: h.layer ?? 'memory',
          })
        }
      } catch {
        // 记忆异常降级
      }
    }

    const seen = new Set()
    const unique = []
    for (const r of results) {
      if (!r.label || seen.has(r.label)) continue
      seen.add(r.label)
      unique.push(r)
    }
    unique.sort((a, b) => b.score - a.score)
    return unique.slice(0, limit)
  }

  /** 从内容里判断知识类型（book/technique/case）。 */
  _kindOf(content = '') {
    if (content.includes('[书籍]')) return 'book'
    if (content.includes('[交易技术]')) return 'technique'
    if (content.includes('[股神案例]')) return 'case'
    return 'unknown'
  }
}