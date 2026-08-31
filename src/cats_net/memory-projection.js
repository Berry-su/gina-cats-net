/**
 * CATS-Net 抽象空间内核 —— 记忆投影 (MemoryProjection)
 *
 * “记忆投影”是 CATS-Net 将离散经历编码进抽象空间的机制：
 *   - project：把一段情境记忆（episode）涉及的概念，投影到空间中的概念节点上，
 *     形成「激活模式」(activationPattern) 作为记忆痕迹，并同步激发对应概念；
 *   - retrieve：给定查询概念集合，按激活模式重叠度唤回最相关的情境记忆；
 *   - reinforce / decay：记忆强度随复述强化、随时间衰减（类脑记忆巩固与遗忘）。
 *
 * 注意：本模块是「内核级记忆投影」，与独立「记忆系统模块」（src/memory，后续开发）
 * 不同——后者负责分层记忆库的完整生命周期，本模块仅负责「经历→抽象空间痕迹」的投影与唤回。
 */

/** 记忆强度的合法区间。 */
const STRENGTH_MIN = 0
const STRENGTH_MAX = 1

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 单条记忆痕迹。
 */
export class MemoryEntry {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {string} [options.label]        记忆标签
   * @param {string} [options.content]      记忆内容描述
   * @param {string[]} [options.concepts]   涉及的抽象空间概念 id
   * @param {object} [options.activationPattern] 概念 id -> 激活权重 的投影模式
   * @param {number} [options.strength]     记忆强度 [0,1]
   * @param {number} [options.timestamp]    形成时间戳
   */
  constructor({
    id,
    label = '',
    content = '',
    concepts = [],
    activationPattern = {},
    strength = 1,
    timestamp = Date.now(),
  } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('MemoryEntry 需要非空字符串 id')
    }
    this.id = id
    this.label = label
    this.content = content
    this.concepts = Array.isArray(concepts) ? concepts : []
    this.activationPattern = activationPattern && typeof activationPattern === 'object' ? activationPattern : {}
    this.strength = clamp(strength, STRENGTH_MIN, STRENGTH_MAX)
    this.timestamp = typeof timestamp === 'number' ? timestamp : Date.now()
  }

  /** 记忆强度调整。 */
  reinforce(amount = 0.1) {
    this.strength = clamp(this.strength + amount, STRENGTH_MIN, STRENGTH_MAX)
    return this.strength
  }

  decay(rate = 0.05) {
    this.strength = clamp(this.strength * (1 - rate), STRENGTH_MIN, STRENGTH_MAX)
    return this.strength
  }

  toJSON() {
    return {
      id: this.id,
      label: this.label,
      content: this.content,
      concepts: [...this.concepts],
      activationPattern: { ...this.activationPattern },
      strength: this.strength,
      timestamp: this.timestamp,
    }
  }

  static fromJSON(data) {
    return new MemoryEntry({
      id: data.id,
      label: data.label,
      content: data.content,
      concepts: data.concepts,
      activationPattern: data.activationPattern,
      strength: data.strength,
      timestamp: data.timestamp,
    })
  }
}

let memorySeq = 0
function nextMemoryId() {
  memorySeq += 1
  return `mem_${Date.now().toString(36)}_${memorySeq}`
}

export class MemoryProjection {
  /**
   * @param {object} [options]
   * @param {number} [options.decayRate]    单次衰减系数 (0,1)
   * @param {number} [options.minStrength]  低于该强度的记忆将被遗忘删除
   */
  constructor({ decayRate = 0.05, minStrength = 0.01 } = {}) {
    this.decayRate = decayRate
    this.minStrength = minStrength
    /** @type {Map<string, MemoryEntry>} */
    this.memories = new Map()
  }

  /** 记忆数量。 */
  get size() {
    return this.memories.size
  }

  /**
   * 将情境记忆投影到抽象空间（激发相关概念并形成记忆痕迹）。
   * @param {object} episode
   * @param {string} [episode.id]         记忆 id（缺省自动生成）
   * @param {string} [episode.label]      标签
   * @param {string} [episode.content]    内容
   * @param {string[]} episode.concepts   涉及的概念 id 列表
   * @param {object} [episode.weights]    概念 id -> 投影权重（缺省 1）
   * @param {number} [episode.strength]   初始强度
   * @param {Map<string, import('./concept-node.js').ConceptNode>} space 抽象空间节点表
   * @returns {MemoryEntry} 形成的记忆痕迹
   */
  project(episode, space) {
    if (!episode || typeof episode !== 'object') throw new TypeError('project 需要 episode 对象')
    if (!(space instanceof Map)) throw new TypeError('project 需要 Map 类型的抽象空间节点表')

    const id = typeof episode.id === 'string' && episode.id ? episode.id : nextMemoryId()
    const concepts = Array.isArray(episode.concepts) ? episode.concepts : []
    const weights = episode.weights && typeof episode.weights === 'object' ? episode.weights : {}
    const strength = clamp(episode.strength ?? 1, STRENGTH_MIN, STRENGTH_MAX)

    const activationPattern = {}
    for (const conceptId of concepts) {
      const node = space.get(conceptId)
      if (!node) continue // 空间中不存在该概念则跳过（不报错，保证容错）
      const weight = typeof weights[conceptId] === 'number' ? weights[conceptId] : 1
      activationPattern[conceptId] = weight
      // 投影副作用：激发空间中的对应概念
      node.activate(weight * 0.2, id)
    }

    const entry = new MemoryEntry({
      id,
      label: episode.label ?? '',
      content: episode.content ?? '',
      concepts: Object.keys(activationPattern),
      activationPattern,
      strength,
      timestamp: Date.now(),
    })

    this.memories.set(id, entry)
    return entry
  }

  /**
   * 检索与查询概念集合最相关的情境记忆。
   * @param {string[]} queryConcepts 查询概念 id 列表
   * @param {object} [options]
   * @param {number} [options.limit] 返回条数上限（默认全部）
   * @param {number} [options.minScore] 保留分数阈值
   * @returns {Array<{entry:MemoryEntry, score:number, overlap:number}>} 按 score 降序
   */
  retrieve(queryConcepts, { limit = 10, minScore = 0 } = {}) {
    const querySet = new Set(Array.isArray(queryConcepts) ? queryConcepts : [])
    if (querySet.size === 0) return []

    const results = []
    for (const entry of this.memories.values()) {
      if (entry.concepts.length === 0) continue
      let hit = 0
      for (const c of entry.concepts) if (querySet.has(c)) hit++
      // 重合度：Jaccard 相似度（交 / 并），兼顾查全与查准
      const unionSize = new Set([...querySet, ...entry.concepts]).size
      const overlap = unionSize === 0 ? 0 : hit / unionSize
      const score = overlap * entry.strength
      if (score >= minScore) {
        results.push({ entry, score, overlap })
      }
    }

    results.sort((x, y) => y.score - x.score || y.entry.timestamp - x.entry.timestamp)
    return results.slice(0, limit)
  }

  /**
   * 强化某条记忆（复述/再认）。
   * @param {string} memoryId
   * @param {number} amount
   * @returns {number|null} 强化后的强度（记忆不存在返回 null）
   */
  reinforce(memoryId, amount = 0.1) {
    const entry = this.memories.get(memoryId)
    if (!entry) return null
    return entry.reinforce(amount)
  }

  /**
   * 获取某条记忆。
   * @param {string} memoryId
   * @returns {MemoryEntry|undefined}
   */
  get(memoryId) {
    return this.memories.get(memoryId)
  }

  /**
   * 全局记忆衰减，过低强度的记忆被遗忘。
   * @returns {{retained:number, forgotten:number}}
   */
  decayAll() {
    let forgotten = 0
    for (const [id, entry] of this.memories) {
      entry.decay(this.decayRate)
      if (entry.strength < this.minStrength) {
        this.memories.delete(id)
        forgotten++
      }
    }
    return { retained: this.memories.size, forgotten }
  }

  /** 返回全部记忆痕迹（只读数组）。 */
  getMemories() {
    return Array.from(this.memories.values())
  }

  /**
   * 序列化为纯对象数组（供 Serializer 持久化）。
   * @returns {Array<object>}
   */
  toJSON() {
    return this.getMemories().map((m) => m.toJSON())
  }

  /**
   * 从纯对象数组恢复（清空后重建）。
   * @param {Array<object>} data
   * @returns {this}
   */
  fromJSON(data) {
    if (!Array.isArray(data)) throw new TypeError('fromJSON 需要数组')
    this.memories = new Map()
    for (const raw of data) {
      const entry = MemoryEntry.fromJSON(raw)
      this.memories.set(entry.id, entry)
    }
    return this
  }
}