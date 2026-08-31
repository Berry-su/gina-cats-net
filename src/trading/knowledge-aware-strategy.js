/**
 * 交易模块 —— 知识感知策略装饰器 (knowledge-aware-strategy.js)
 *
 * 包装任意基础策略，在信号产生后叠加「投资知识依据」：
 *   - 根据策略声明的方法论概念（frameworkConcepts）+ 可选市场概念，调用 KnowledgeAdvisor.explain()
 *     识别所属体系（价值/成长/趋势/量化/宏观/风控），并把相关书籍、技术、案例写入信号的 reason，
 *     使策略能够「根据价值或趋势体系给出具体理由」。
 *   - 遭遇异常或无知识库时降级为原始信号，不影响交易主流程。
 */

import { Strategy } from './strategy.js'

export class KnowledgeAwareStrategy extends Strategy {
  /**
   * @param {object} options
   * @param {import('./strategy.js').Strategy} options.strategy  被包装的基础策略
   * @param {import('./knowledge-advisor.js').KnowledgeAdvisor} [options.advisor] 知识顾问
   * @param {string[]} [options.frameworkConcepts] 该策略方法论对应的概念 id（用于识别体系）
   * @param {Function} [options.marketConceptsProvider] (tick, baseSignal) => string[] 附加市场概念
   * @param {string} [options.frameworkKey] 强制指定体系 key（如 'value' / 'trend'），缺省自动识别
   */
  constructor({
    strategy = null,
    advisor = null,
    frameworkConcepts = [],
    marketConceptsProvider = null,
    frameworkKey = null,
  } = {}) {
    super({ name: `knowledge-${strategy?.name ?? 'unknown'}` })
    this.strategy = strategy
    this.advisor = advisor ?? null
    this.frameworkConcepts = Array.isArray(frameworkConcepts) ? frameworkConcepts : []
    this.marketConceptsProvider = marketConceptsProvider ?? null
    this.frameworkKey = frameworkKey ?? null
  }

  onTick(tick, position = null) {
    const base = this.strategy ? this.strategy.onTick(tick, position) : { action: 'hold', reason: '无基础策略' }
    if (!base || typeof base !== 'object' || base.action === 'hold') return base
    if (!this.advisor || typeof this.advisor.explain !== 'function') return base

    try {
      const marketConcepts =
        typeof this.marketConceptsProvider === 'function' ? this.marketConceptsProvider(tick, base) : []
      const concepts = Array.from(new Set([...this.frameworkConcepts, ...(Array.isArray(marketConcepts) ? marketConcepts : [])]))

      const exp = this.advisor.explain(concepts, { frameworkKey: this.frameworkKey })
      const reason = `${base.reason ?? base.action}｜${exp.reason}`

      return {
        ...base,
        reason,
        knowledge: exp,
      }
    } catch {
      return base
    }
  }
}