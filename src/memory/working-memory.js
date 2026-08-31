/**
 * 记忆系统 —— 工作记忆 (WorkingMemory)
 *
 * 工作记忆是三层记忆中的「当前焦点层」，模拟人脑的短时工作缓冲：
 *   - 容量极小（默认 7，符合 Miller 7±2 定律）；
 *   - 遗忘极快（importance 快速衰减）；
 *   - 仅保留当前任务上下文，用于即时推理；
 *   - 超出容量时淘汰「重要性最低且最旧」的条目。
 *
 * 本层不负责持久化，也不负责与抽象空间交互，只负责「此刻正在想什么」。
 */

/** 重要性合法区间。 */
const IMPORTANCE_MIN = 0
const IMPORTANCE_MAX = 1

function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

let workingSeq = 0
function nextId() {
  workingSeq += 1
  return `wm_${Date.now().toString(36)}_${workingSeq}`
}

export class WorkingMemory {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity]       容量上限（默认 7）
   * @param {number} [options.decayRate]      单次衰减系数 (0,1)
   * @param {number} [options.minImportance]  低于该重要性的条目被清除
   */
  constructor({ capacity = 7, decayRate = 0.3, minImportance = 0.01 } = {}) {
    this.capacity = typeof capacity === 'number' && capacity > 0 ? Math.floor(capacity) : 7
    this.decayRate = clamp(decayRate, 0, 1)
    this.minImportance = clamp(minImportance, 0, 1)
    /** @type {Map<string, object>} */
    this.items = new Map()
  }

  /** 当前条目数。 */
  get size() {
    return this.items.size
  }

  /** 是否已满。 */
  isFull() {
    return this.items.size >= this.capacity
  }

  /**
   * 加入一条当前焦点（容量满时先淘汰最低重要性条目）。
   * @param {object} item
   * @param {string} [item.id]
   * @param {string} item.content         内容
   * @param {string[]} [item.tags]        标签
   * @param {number} [item.importance]    初始重要性
   * @returns {object} 存入的条目
   */
  add(item = {}) {
    if (!item || typeof item !== 'object') throw new TypeError('add 需要条目对象')
    if (typeof item.content !== 'string' || item.content.length === 0) {
      throw new TypeError('工作记忆条目需要非空 content')
    }

    if (this.isFull()) this.evict()

    const entry = {
      id: typeof item.id === 'string' && item.id ? item.id : nextId(),
      content: item.content,
      tags: Array.isArray(item.tags) ? item.tags : [],
      concepts: Array.isArray(item.concepts) ? item.concepts : [],
      source: typeof item.source === 'string' && item.source ? item.source : 'observation',
      importance: clamp(item.importance ?? 1, IMPORTANCE_MIN, IMPORTANCE_MAX),
      timestamp: Date.now(),
    }
    this.items.set(entry.id, entry)
    return entry
  }

  /**
   * 获取条目。
   * @param {string} id
   * @returns {object|undefined}
   */
  get(id) {
    return this.items.get(id)
  }

  /**
   * 是否存在条目。
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.items.has(id)
  }

  /**
   * 列表（按重要性降序）。
   * @returns {Array<object>}
   */
  list() {
    return Array.from(this.items.values()).sort((a, b) => b.importance - a.importance)
  }

  /** 清空工作记忆。 */
  clear() {
    this.items = new Map()
  }

  /**
   * 淘汰一条重要性最低（相同则最旧）的条目。
   * @returns {object|null} 被淘汰的条目（空时返回 null）
   */
  evict() {
    if (this.items.size === 0) return null
    let victim = null
    for (const entry of this.items.values()) {
      if (
        victim === null ||
        entry.importance < victim.importance ||
        (entry.importance === victim.importance && entry.timestamp < victim.timestamp)
      ) {
        victim = entry
      }
    }
    this.items.delete(victim.id)
    console.log(`[memory] 工作记忆淘汰: id=${victim.id} source=${victim.source ?? 'observation'} importance=${victim.importance.toFixed(2)} 剩余=${this.items.size}/${this.capacity}`)
    return victim
  }

  /**
   * 快速遗忘：所有条目重要性衰减，低于阈值的被清除。
   * @returns {{retained:number, cleared:number}}
   */
  decay() {
    let cleared = 0
    for (const [id, entry] of this.items) {
      entry.importance = clamp(entry.importance * (1 - this.decayRate), IMPORTANCE_MIN, IMPORTANCE_MAX)
      if (entry.importance < this.minImportance) {
        this.items.delete(id)
        cleared++
      }
    }
    return { retained: this.items.size, cleared }
  }

  /**
   * 以普通对象形式导出全部条目（用于转移到短期记忆）。
   * @returns {Array<object>}
   */
  shiftOut() {
    return this.list().map((e) => ({ ...e, tags: [...e.tags], concepts: [...(e.concepts ?? [])] }))
  }

  /** 序列化。 */
  toJSON() {
    return this.list().map((e) => ({ ...e, tags: [...e.tags], concepts: [...(e.concepts ?? [])] }))
  }

  /** 反序列化（清空后重建）。 */
  fromJSON(data) {
    if (!Array.isArray(data)) throw new TypeError('fromJSON 需要数组')
    this.items = new Map()
    for (const raw of data) {
      this.items.set(raw.id, {
        id: raw.id,
        content: raw.content,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        concepts: Array.isArray(raw.concepts) ? raw.concepts : [],
        source: typeof raw.source === 'string' && raw.source ? raw.source : 'observation',
        importance: raw.importance,
        timestamp: raw.timestamp,
      })
    }
    return this
  }
}