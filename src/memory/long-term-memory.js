/**
 * 记忆系统 —— 长期记忆 (LongTermMemory)
 *
 * 长期记忆是三层记忆中的「知识沉淀层」：
 *   - 容量大（默认 1000）；
 *   - 遗忘极慢（strength 衰减系数很小）；
 *   - 保存经「巩固」而来、相对稳定的知识；
 *   - 每条条目可选持有 `abstractSpaceRef`，记录其在 CATS-Net 抽象空间中的投影，
 *     从而建立「记忆条目 <-> 概念节点」的双向可追溯链接。
 *
 * 本层存储结构自洽，不直接依赖 CATS-Net；投影动作由 MemoryManager 委托执行。
 */

const STRENGTH_MIN = 0
const STRENGTH_MAX = 1

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

let longSeq = 0
function nextId() {
  longSeq += 1
  return `ltm_${Date.now().toString(36)}_${longSeq}`
}

export class LongTermMemory {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity]     容量上限（默认 1000）
   * @param {number} [options.decayRate]    单次衰减系数（很小）
   * @param {number} [options.minStrength]  低于该强度的记忆被清除
   */
  constructor({ capacity = 1000, decayRate = 0.01, minStrength = 0.1 } = {}) {
    this.capacity = typeof capacity === 'number' && capacity > 0 ? Math.floor(capacity) : 1000
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
   * 加入一条长期记忆（容量满时淘汰最低强度条目）。
   * @param {object} item
   * @param {string} [item.id]
   * @param {string} [item.label]
   * @param {string} [item.content]
   * @param {string[]} [item.concepts]        涉及概念 id
   * @param {string[]} [item.tags]
   * @param {number} [item.strength]
   * @param {string[]} [item.abstractSpaceRef] CATS-Net 抽象空间投影引用（概念 id 列表）
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
      strength: clamp(item.strength ?? 0.8, STRENGTH_MIN, STRENGTH_MAX),
      abstractSpaceRef: Array.isArray(item.abstractSpaceRef) ? item.abstractSpaceRef : [],
      timestamp: Date.now(),
    }
    this.items.set(entry.id, entry)
    return entry
  }

  /** 从短期记忆条目巩固而来。 */
  addFromShortTerm(stmEntry, { abstractSpaceRef = [] } = {}) {
    return this.add({
      id: stmEntry.id ? `ltm_${stmEntry.id}` : undefined,
      label: stmEntry.label,
      content: stmEntry.content,
      concepts: stmEntry.concepts,
      tags: stmEntry.tags,
      strength: stmEntry.strength,
      abstractSpaceRef,
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
   * 缓慢遗忘：强度衰减，低于阈值的清除。
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

  toJSON() {
    return this.list().map((e) => ({
      ...e,
      concepts: [...e.concepts],
      tags: [...e.tags],
      abstractSpaceRef: [...e.abstractSpaceRef],
    }))
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
        abstractSpaceRef: Array.isArray(raw.abstractSpaceRef) ? raw.abstractSpaceRef : [],
        timestamp: raw.timestamp,
      })
    }
    return this
  }
}