/**
 * 记忆系统 —— 短期记忆 (ShortTermMemory)
 *
 * 短期记忆是三层记忆中的「近期情节层」，介于工作记忆与长期记忆之间：
 *   - 容量中等（默认 20）；
 *   - 遗忘中等（strength 按中等速率衰减，低于阈值清除）；
 *   - 保存最近一段时间的情节（episode），可被巩固作家长期记忆；
 *   - 支持按概念/标签检索（普通记忆匹配，不涉及抽象空间投影）。
 *
 * 本层自身不与该抽象空间交互；「巩固到长期」由 MemoryManager 委托 CATS-Net 完成。
 */

const STRENGTH_MIN = 0
const STRENGTH_MAX = 1

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

let shortSeq = 0
function nextId() {
  shortSeq += 1
  return `stm_${Date.now().toString(36)}_${shortSeq}`
}

export class ShortTermMemory {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity]     容量上限（默认 20）
   * @param {number} [options.decayRate]    单次衰减系数 (0,1)
   * @param {number} [options.minStrength]  低于该强度的记忆被清除
   */
  constructor({ capacity = 20, decayRate = 0.1, minStrength = 0.05 } = {}) {
    this.capacity = typeof capacity === 'number' && capacity > 0 ? Math.floor(capacity) : 20
    this.decayRate = clamp(decayRate, 0, 1)
    this.minStrength = clamp(minStrength, 0, 1)
    /** @type {Map<string, object>} */
    this.items = new Map()
  }

  get size() {
    return this.items.size
  }

  isFull() {
    return this.items.size >= this.capacity
  }

  /**
   * 加入一条近期情节（容量满时淘汰最低强度条目）。
   * @param {object} item
   * @param {string} [item.id]
   * @param {string} [item.label]      标签
   * @param {string} [item.content]    内容
   * @param {string[]} [item.concepts] 涉及概念 id
   * @param {string[]} [item.tags]     附加标签
   * @param {number} [item.strength]   初始强度
   * @returns {object} 存入的条目
   */
  add(item = {}) {
    if (!item || typeof item !== 'object') throw new TypeError('add 需要条目对象')

    if (this.isFull()) this.evict()

    const entry = {
      id: typeof item.id === 'string' && item.id ? item.id : nextId(),
      label: item.label ?? '',
      content: item.content ?? '',
      concepts: Array.isArray(item.concepts) ? item.concepts : [],
      tags: Array.isArray(item.tags) ? item.tags : [],
      strength: clamp(item.strength ?? 1, STRENGTH_MIN, STRENGTH_MAX),
      timestamp: Date.now(),
    }
    this.items.set(entry.id, entry)
    return entry
  }

  /** 从工作记忆条目转移到短期记忆。 */
  addFromWorking(wmEntry, { label = '', concepts = [] } = {}) {
    return this.add({
      id: wmEntry.id ? `stm_${wmEntry.id}` : undefined,
      label: label || wmEntry.content?.slice(0, 32),
      content: wmEntry.content,
      concepts: Array.isArray(concepts) ? concepts : [],
      tags: wmEntry.tags || [],
      strength: wmEntry.importance ?? 1,
    })
  }

  get(id) {
    return this.items.get(id)
  }

  has(id) {
    return this.items.has(id)
  }

  list() {
    return Array.from(this.items.values()).sort((a, b) => b.strength - a.strength)
  }

  /**
   * 淘汰一条强度最低（相同则最旧）的条目。
   * @returns {object|null}
   */
  evict() {
    if (this.items.size === 0) return null
    let victim = null
    for (const entry of this.items.values()) {
      if (
        victim === null ||
        entry.strength < victim.strength ||
        (entry.strength === victim.strength && entry.timestamp < victim.timestamp)
      ) {
        victim = entry
      }
    }
    this.items.delete(victim.id)
    return victim
  }

  /**
   * 按概念/标签检索（Jaccard 重合度 × 强度）。
   * @param {string[]} query
   * @param {object} [options]
   * @param {number} [options.limit]
   * @returns {Array<{entry:object, score:number, overlap:number}>}
   */
  retrieve(query, { limit = 10 } = {}) {
    const qset = new Set(Array.isArray(query) ? query : [])
    if (qset.size === 0) return []

    const results = []
    for (const entry of this.items.values()) {
      const keys = new Set([...entry.concepts, ...entry.tags])
      if (keys.size === 0) continue
      let hit = 0
      for (const k of keys) if (qset.has(k)) hit++
      const unionSize = new Set([...qset, ...keys]).size
      const overlap = unionSize === 0 ? 0 : hit / unionSize
      const score = overlap * entry.strength
      results.push({ entry, score, overlap })
    }
    results.sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
    return results.slice(0, limit)
  }

  /**
   * 遗忘：强度衰减，低于阈值的清除。
   * @returns {{retained:number, cleared:number}}
   */
  decay() {
    let cleared = 0
    for (const [id, entry] of this.items) {
      entry.strength = clamp(entry.strength * (1 - this.decayRate), STRENGTH_MIN, STRENGTH_MAX)
      if (entry.strength < this.minStrength) {
        this.items.delete(id)
        cleared++
      }
    }
    return { retained: this.items.size, cleared }
  }

  /**
   * 返回强度达到阈值、可被巩固为长期的条目。
   * @param {number} threshold
   * @returns {Array<object>}
   */
  listConsolidatable(threshold = 0.6) {
    return this.list().filter((e) => e.strength >= threshold)
  }

  /** 删除指定条目（巩固迁移时使用）。 */
  remove(id) {
    return this.items.delete(id)
  }

  toJSON() {
    return this.list().map((e) => ({ ...e, concepts: [...e.concepts], tags: [...e.tags] }))
  }

  fromJSON(data) {
    if (!Array.isArray(data)) throw new TypeError('fromJSON 需要数组')
    this.items = new Map()
    for (const raw of data) {
      this.items.set(raw.id, {
        id: raw.id,
        label: raw.label,
        content: raw.content,
        concepts: Array.isArray(raw.concepts) ? raw.concepts : [],
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        strength: raw.strength,
        timestamp: raw.timestamp,
      })
    }
    return this
  }
}