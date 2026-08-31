/**
 * 记忆系统 —— 记忆管理器 (MemoryManager)
 *
 * 三层记忆的编排器，实现「感知 → 工作记忆 → 短期记忆 → 长期记忆」的巩固流水线，
 * 并负责与 CATS-Net 抽象空间对接（依赖方向严格为 memory → cats_net，由构造注入，
 * 本模块不 import CATS-Net，从而避免循环依赖并支持无内核的降级模式）。
 *
 * 核心对接点：`consolidate()` 将短期记忆巩固为长期时，委托注入的 catsNet 实例调用
 * `projectMemory()`，把情节编码进抽象空间，建立「记忆条目 <-> 概念节点」双向链接。
 *
 * 安全机制与 CATS-Net 一致：
 *   - 异常容错：所有 catsNet 调用包 try/catch，内核不可用时降级不崩溃；
 *   - 死循环拦截：巩固批量上限 maxConsolidate + 三层容量上限 + 检索 limit；
 *   - 紧急终止：abort() / clearAbort() + _guard()，中断后续操作。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { WorkingMemory } from './working-memory.js'
import { ShortTermMemory } from './short-term-memory.js'
import { LongTermMemory } from './long-term-memory.js'

/** 记忆快照格式与版本。 */
export const MEMORY_FORMAT = 'gina-memory'
export const MEMORY_VERSION = '1.0.0'

export class MemoryManager {
  /**
   * @param {object} [options]
   * @param {object|null} [options.catsNet]  CATS-Net 实例（可选；为空则降级为无投影模式）
   * @param {object} [options.working]     透传给 WorkingMemory
   * @param {object} [options.shortTerm]   透传给 ShortTermMemory
   * @param {object} [options.longTerm]    透传给 LongTermMemory
   */
  constructor({
    catsNet = null,
    working = {},
    shortTerm = {},
    longTerm = {},
  } = {}) {
    this.catsNet = catsNet ?? null
    this.working = new WorkingMemory(working)
    this.shortTerm = new ShortTermMemory(shortTerm)
    this.longTerm = new LongTermMemory(longTerm)
    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 安全机制
  // ---------------------------------------------------------------------------

  /** 紧急终止。 */
  abort() {
    this._aborted = true
    return this
  }

  /** 解除终止。 */
  clearAbort() {
    this._aborted = false
    return this
  }

  /** 是否已终止。 */
  isAborted() {
    return this._aborted
  }

  _guard() {
    if (this._aborted) {
      const err = new Error('MemoryManager 已紧急终止，操作被拒绝')
      err.code = 'ABORTED'
      throw err
    }
  }

  /** 是否已接入 CATS-Net 抽象空间。 */
  hasAbstractSpace() {
    return this.catsNet != null && typeof this.catsNet.projectMemory === 'function'
  }

  // ---------------------------------------------------------------------------
  // 巩固流水线
  // ---------------------------------------------------------------------------

  /**
   * 采集一条观察/经历，进入工作记忆。
   * @param {object} observation
   * @param {string} observation.content   内容
   * @param {string[]} [observation.concepts] 涉及概念 id（供后续检索）
   * @param {string[]} [observation.tags]   标签
   * @param {number} [observation.importance] 初始重要性
   * @returns {object} 工作记忆条目
   */
  addObservation(observation = {}) {
    this._guard()
    const entry = this.working.add({
      id: observation.id,
      content: observation.content,
      tags: Array.isArray(observation.tags) ? observation.tags : [],
      concepts: Array.isArray(observation.concepts) ? observation.concepts : [],
      source: observation.source ?? 'observation',
      importance: observation.importance ?? 1,
    })
    console.log(
      `[memory] 写入工作记忆: id=${entry.id} source=${entry.source} importance=${entry.importance.toFixed(2)} ` +
      `concepts=[${entry.concepts.join(',')}] 当前=${this.working.size}/${this.working.capacity}`,
    )
    return entry
  }

  /**
   * 将当前工作记忆全部转移到短期记忆（随后清空工作记忆）。
   * @returns {{moved:number}} 转移条数
   */
  shiftToShortTerm() {
    this._guard()
    let moved = 0
    for (const wmEntry of this.working.shiftOut()) {
      this.shortTerm.addFromWorking(wmEntry, {
        label: wmEntry.content?.slice(0, 32),
        concepts: Array.isArray(wmEntry.concepts) ? wmEntry.concepts : [],
      })
      moved++
    }
    this.working.clear()
    return { moved }
  }

  /**
   * 将高强度短期记忆巩固为长期记忆，并（可选）投影到 CATS-Net 抽象空间。
   *
   * 这是与 CATS-Net 的核心对接点：
   *   - 对每条达到阈值的短期记忆，若已接入内核，则调用 catsNet.projectMemory() 编码；
   *   - 长期条目记录 `abstractSpaceRef`（投影的概念 id），建立双向链接；
   *   - 内核不可用 / 投影失败时降级：仍写入长期记忆，只是缺少抽象空间引用。
   *
   * @param {object} [options]
   * @param {number} [options.minStrength]     巩固强度阈值
   * @param {number} [options.maxConsolidate]  单次巩固数量上限（死循环保护）
   * @returns {{consolidated:number, projected:number, skipped:number}}
   */
  consolidate({ minStrength = 0.6, maxConsolidate = 100 } = {}) {
    this._guard()
    const candidates = this.shortTerm.listConsolidatable(minStrength).slice(0, maxConsolidate)
    let consolidated = 0
    let projected = 0
    let skipped = 0

    for (const stmEntry of candidates) {
      let abstractSpaceRef = []

      if (this.hasAbstractSpace()) {
        try {
          // concepts 对齐守卫：只投影抽象空间中已存在的概念，避免静默生成空投影
          const allConcepts = Array.isArray(stmEntry.concepts) ? stmEntry.concepts : []
          const alignedConcepts = typeof this.catsNet.getNode === 'function'
            ? allConcepts.filter((c) => this.catsNet.getNode(c))
            : allConcepts
          const filteredOut = allConcepts.filter((c) => !alignedConcepts.includes(c))
          if (filteredOut.length > 0) {
            console.log(
              `[memory] 巩固投影过滤: 记忆=${stmEntry.id} 过滤不在抽象空间的概念=[${filteredOut.join(', ')}] ` +
              `保留=[${alignedConcepts.join(', ') || '(空)'}]`,
            )
          }

          const proj = this.catsNet.projectMemory({
            id: `mm_${stmEntry.id}`,
            label: stmEntry.label,
            content: stmEntry.content,
            concepts: alignedConcepts,
            strength: stmEntry.strength,
          })
          if (proj && Array.isArray(proj.concepts)) {
            abstractSpaceRef = [...proj.concepts]
          }
          console.log(`[memory] 巩固投影完成: 记忆=${stmEntry.id} 抽象空间引用=[${abstractSpaceRef.join(', ') || '(空)'}]`)
          projected++
        } catch {
          console.log(`[memory] 巩固投影降级: 记忆=${stmEntry.id} 内核异常，跳过投影仍写长期记忆`)
        }
      }

      this.longTerm.addFromShortTerm(stmEntry, { abstractSpaceRef })
      this.shortTerm.remove(stmEntry.id)
      consolidated++
    }

    skipped = this.shortTerm.listConsolidatable(minStrength).length // 剩余仍在短期的孤儿由下次巩固处理
    return { consolidated, projected, skipped }
  }

  // ---------------------------------------------------------------------------
  // 检索 / 召回 / 衰减
  // ---------------------------------------------------------------------------

  /**
   * 跨三层检索：返回合并结果，每条标注所属 layer 与匹配分。
   * @param {string[]} query 概念/标签/关键词
   * @param {object} [options]
   * @param {number} [options.limit]
   * @returns {Array<{layer:string, entry:object, score:number}>}
   */
  retrieve(query, { limit = 10 } = {}) {
    this._guard()
    const results = []

    for (const r of this.shortTerm.retrieve(query, { limit })) {
      results.push({ layer: 'shortTerm', entry: r.entry, score: r.score })
    }
    for (const r of this.longTerm.retrieve(query, { limit })) {
      results.push({ layer: 'longTerm', entry: r.entry, score: r.score })
    }
    // 工作记忆：按标签/关键词命中
    const qset = new Set(Array.isArray(query) ? query : [])
    for (const e of this.working.list()) {
      let hit = 0
      for (const t of e.tags) if (qset.has(t)) hit++
      for (const q of qset) if (typeof e.content === 'string' && e.content.includes(q)) hit++
      if (hit > 0) {
        results.push({ layer: 'working', entry: e, score: hit * e.importance })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /**
   * 委托 CATS-Net 从抽象空间唤回记忆痕迹（无内核则降级返回空）。
   * @param {string[]} queryConcepts
   * @param {object} [options]
   * @returns {Array}
   */
  retrieveAbstract(queryConcepts, options) {
    this._guard()
    if (!this.hasAbstractSpace() || typeof this.catsNet.retrieveMemory !== 'function') return []
    try {
      return this.catsNet.retrieveMemory(queryConcepts, options)
    } catch {
      return []
    }
  }

  /**
   * 全层查一条记忆。
   * @param {string} id
   * @returns {{layer:string, entry:object}|null}
   */
  recall(id) {
    this._guard()
    if (this.working.has(id)) return { layer: 'working', entry: this.working.get(id) }
    if (this.shortTerm.has(id)) return { layer: 'shortTerm', entry: this.shortTerm.get(id) }
    if (this.longTerm.has(id)) return { layer: 'longTerm', entry: this.longTerm.get(id) }
    return null
  }

  /**
   * 全层衰减（工作记忆遗忘最快、短期次之、长期最慢）。
   * @returns {{working:object, shortTerm:object, longTerm:object}}
   */
  decayAll() {
    this._guard()
    return {
      working: this.working.decay(),
      shortTerm: this.shortTerm.decay(),
      longTerm: this.longTerm.decay(),
    }
  }

  /** 三层统计快照。 */
  stats() {
    return {
      working: this.working.size,
      shortTerm: this.shortTerm.size,
      longTerm: this.longTerm.size,
      hasAbstractSpace: this.hasAbstractSpace(),
    }
  }

  // ---------------------------------------------------------------------------
  // 序列化 / 持久化
  // ---------------------------------------------------------------------------

  serialize() {
    return {
      working: this.working.toJSON(),
      shortTerm: this.shortTerm.toJSON(),
      longTerm: this.longTerm.toJSON(),
    }
  }

  deserialize(data) {
    if (!data || typeof data !== 'object') throw new TypeError('deserialize 需要对象')
    this.working.fromJSON(data.working ?? [])
    this.shortTerm.fromJSON(data.shortTerm ?? [])
    this.longTerm.fromJSON(data.longTerm ?? [])
    return this
  }

  /**
   * 原子保存到磁盘（带版本号）。
   * @param {string} filePath
   * @returns {string}
   */
  save(filePath) {
    const snapshot = {
      format: MEMORY_FORMAT,
      version: MEMORY_VERSION,
      savedAt: new Date().toISOString(),
      ...this.serialize(),
    }
    const json = JSON.stringify(snapshot, null, 2)
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, json, 'utf8')
    renameSync(tmp, filePath)
    return filePath
  }

  /**
   * 从磁盘加载并覆盖当前状态。
   * @param {string} filePath
   * @returns {this}
   */
  load(filePath) {
    if (!existsSync(filePath)) throw new Error(`记忆快照不存在: ${filePath}`)
    const data = JSON.parse(readFileSync(filePath, 'utf8'))
    if (data.format !== MEMORY_FORMAT) throw new Error(`记忆快照格式不匹配: ${data.format}`)
    if (data.version !== MEMORY_VERSION) throw new Error(`记忆快照版本不匹配: ${data.version}`)
    return this.deserialize(data)
  }
}