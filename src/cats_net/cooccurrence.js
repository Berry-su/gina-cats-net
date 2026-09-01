/**
 * CATS-Net 抽象空间内核 —— 共现追踪器 (CooccurrenceTracker) · C-1.3 概念自学习
 *
 * 用途：统计概念对 (a, b) 在同一上下文（episode）中共现的频次，作为
 *   CatsNet.learnConcepts() 归纳新概念 / 合并旧概念 / 降权冷概念的输入信号。
 *
 * 设计要点（ADR-002 §3.3.2）：
 *   - LRU 上限（默认 10 000 pair）防止内存爆炸；超过时淘汰 lastSeen 最早的一对
 *   - 时间半衰期（默认 1 周 = 168h）：getFrequentPairs 返回 effectiveCount，
 *     = pair.count × exp(-ln2 × Δt_hours / halfLifeHours)
 *   - 入索引前规范化：a < b 字典序，确保 (A,B) 和 (B,A) 是同一对
 *   - 4 重护栏（与 learnConcepts 协同）：
 *       1) LRU 10k 上限（this.maxPairs）
 *       2) minCount 入选阈值（this.minCount，默认 5）
 *       3) halfLifeHours 半衰期（this.halfLifeHours，默认 168）
 *       4) maxNew 单次新增上限（在 CatsNet.learnConcepts 中体现）
 *
 * 边界：与 `src/context/pattern-detector.js`（工具链 ACI）通过 CATS-Net 节点 id
 *   交换数据 —— 本模块只管「概念共现」，不管「工具调用模式」。
 */

const HALF_LIFE_LN2 = Math.LN2

/**
 * 概念共现追踪器。
 *
 * 数据结构：Map<canonicalKey, { a, b, count, weight, lastSeen, firstSeen }>
 *   - canonicalKey = a < b ? `${a}|${b}` : `${b}|${a}`（保证 (A,B) 和 (B,A) 是同一对）
 *   - count 累加；weight 累加（默认 1/次）
 *   - lastSeen 每次 recordPair 更新；LRU 淘汰按 lastSeen 升序淘汰
 */
export class CooccurrenceTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxPairs]      内部 LRU 上限（默认 10000）
   * @param {number} [options.minCount]      入选阈值（默认 5 次）
   * @param {number} [options.halfLifeHours] 计数时间衰减半衰期（默认 168 = 1 周）
   */
  constructor({ maxPairs = 10000, minCount = 5, halfLifeHours = 168 } = {}) {
    if (typeof maxPairs !== 'number' || !(maxPairs > 0)) {
      throw new TypeError('maxPairs 必须是正数')
    }
    if (typeof minCount !== 'number' || !(minCount >= 0)) {
      throw new TypeError('minCount 必须是非负数')
    }
    if (typeof halfLifeHours !== 'number' || !(halfLifeHours > 0)) {
      throw new TypeError('halfLifeHours 必须是正数')
    }
    this.maxPairs = maxPairs
    this.minCount = minCount
    this.halfLifeHours = halfLifeHours
    /** @type {Map<string, {a:string, b:string, count:number, weight:number, lastSeen:number, firstSeen:number}>} */
    this.pairs = new Map()
  }

  /** 当前 pair 数。 */
  get size() {
    return this.pairs.size
  }

  /**
   * 规范化 pair key：a < b 字典序。
   * @param {string} a
   * @param {string} b
   * @returns {string} canonical key
   */
  static canonicalKey(a, b) {
    if (typeof a !== 'string' || a.length === 0 || typeof b !== 'string' || b.length === 0) {
      throw new TypeError('canonicalKey 需要非空字符串 a/b')
    }
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  /**
   * 解析 canonical key 回 a / b。
   * @param {string} key
   * @returns {{a:string, b:string}}
   */
  static parseKey(key) {
    if (typeof key !== 'string') throw new TypeError('parseKey 需要字符串 key')
    const idx = key.indexOf('|')
    if (idx < 0) throw new Error(`非法 pair key: ${key}`)
    return { a: key.slice(0, idx), b: key.slice(idx + 1) }
  }

  /**
   * 记录一次共现（两个概念在同一上下文被激活）。
   *
   * @param {string} a
   * @param {string} b
   * @param {number} [weight=1]
   * @param {number} [timestamp=Date.now()]
   * @returns {{key:string, count:number, evicted:string|null}} 记录后的 count 与本次可能触发的 LRU 淘汰 key
   */
  recordPair(a, b, weight = 1, timestamp = Date.now()) {
    if (typeof a !== 'string' || a.length === 0 || typeof b !== 'string' || b.length === 0) {
      throw new TypeError('recordPair 需要非空字符串 a/b')
    }
    if (a === b) {
      // 自共现忽略（不构成有意义的对）
      return { key: '', count: 0, evicted: null }
    }
    const w = typeof weight === 'number' && !Number.isNaN(weight) ? weight : 1
    const ts = typeof timestamp === 'number' && !Number.isNaN(timestamp) ? timestamp : Date.now()

    const key = CooccurrenceTracker.canonicalKey(a, b)
    let evicted = null
    if (!this.pairs.has(key) && this.pairs.size >= this.maxPairs) {
      // LRU 容量保护：先腾位置
      evicted = this._evictLRU()
    }

    const existing = this.pairs.get(key)
    if (existing) {
      existing.count += 1
      existing.weight += w
      existing.lastSeen = ts
    } else {
      this.pairs.set(key, { a, b, count: 1, weight: w, lastSeen: ts, firstSeen: ts })
    }
    return { key, count: this.pairs.get(key).count, evicted }
  }

  /**
   * 一次记录一个 episode（一组共现概念），自动产生 C(n, 2) 个 pair。
   * @param {string[]} concepts
   * @param {number} [timestamp=Date.now()]
   * @returns {{recorded:number, evicted:string[]}} 本次实际记录的 pair 数 + 触发的 LRU 淘汰
   */
  recordEpisode(concepts, timestamp = Date.now()) {
    if (!Array.isArray(concepts) || concepts.length < 2) {
      return { recorded: 0, evicted: [] }
    }
    const ts = typeof timestamp === 'number' && !Number.isNaN(timestamp) ? timestamp : Date.now()
    const uniq = []
    const seen = new Set()
    for (const c of concepts) {
      if (typeof c !== 'string' || c.length === 0) continue
      if (seen.has(c)) continue
      seen.add(c)
      uniq.push(c)
    }
    if (uniq.length < 2) return { recorded: 0, evicted: [] }

    let recorded = 0
    const evicted = []
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const r = this.recordPair(uniq[i], uniq[j], 1, ts)
        recorded += 1
        if (r.evicted) evicted.push(r.evicted)
      }
    }
    return { recorded, evicted }
  }

  /**
   * LRU 淘汰：按 lastSeen 升序找最早访问的 pair 删除。
   * 10k 规模下 O(n) 扫描可控；如未来要扩到 100k+ 可改双向链表。
   * @returns {string|null} 被淘汰的 key
   */
  _evictLRU() {
    let oldestKey = null
    let oldestTime = Infinity
    for (const [k, p] of this.pairs) {
      if (p.lastSeen < oldestTime) {
        oldestTime = p.lastSeen
        oldestKey = k
      }
    }
    if (oldestKey !== null) this.pairs.delete(oldestKey)
    return oldestKey
  }

  /**
   * 计算 pair 在 now 时刻经半衰期衰减后的有效计数。
   *   effectiveCount = count × exp(-ln2 × Δt_hours / halfLifeHours)
   * @param {{count:number, lastSeen:number}} pair
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  effectiveCount(pair, now = Date.now()) {
    if (typeof now !== 'number' || Number.isNaN(now)) return pair.count
    const deltaMs = Math.max(0, now - pair.lastSeen)
    const deltaHours = deltaMs / 3600000
    const decay = Math.exp(-HALF_LIFE_LN2 * deltaHours / this.halfLifeHours)
    return pair.count * decay
  }

  /**
   * 查询高频共现。
   *
   * 入选门槛用**ceil(effectiveCount)**（不是 effectiveCount，也不是 raw count）：
   *   - 用 raw count：count=5 在 1 秒后 ec≈4.999 < 5，会被错误排除
   *   - 用 effectiveCount：同上问题
   *   - 用 ceil(effectiveCount)：ec=4.999 → ceil=5 ≥ 5 ✓（recent pair 入选）
   *                      ec=2.5 → ceil=3 < 5 ✗（1 周前 5 次共现被正确排除）
   * 半衰期同时影响**入选**和**排序**（recent pair 优先）。
   *
   * @param {object} [options]
   * @param {number} [options.minCount=this.minCount]  入选阈值（用 ceil(effectiveCount) 比）
   * @param {number} [options.since]                  只看 lastSeen >= since 的记录
   * @param {number} [options.now=Date.now()]         衰减参照时间（影响排序）
   * @param {number} [options.limit]                  返回条数上限
   * @returns {Array<{a:string, b:string, count:number, effectiveCount:number, weight:number, lastSeen:number, firstSeen:number}>}
   *          按 effectiveCount 降序，并列时按 lastSeen 降序
   */
  getFrequentPairs({ minCount, since, now = Date.now(), limit } = {}) {
    const threshold = typeof minCount === 'number' ? minCount : this.minCount
    const sinceMs = typeof since === 'number' ? since : 0
    const out = []
    for (const p of this.pairs.values()) {
      if (p.lastSeen < sinceMs) continue
      // 用 ceil(effectiveCount) 作入选门槛：兼顾"recent pair 入选" + "old pair 衰减后被排除"
      const ec = this.effectiveCount(p, now)
      if (Math.ceil(ec) < threshold) continue
      out.push({
        a: p.a,
        b: p.b,
        count: p.count,
        effectiveCount: ec,
        weight: p.weight,
        lastSeen: p.lastSeen,
        firstSeen: p.firstSeen,
      })
    }
    out.sort((x, y) => y.effectiveCount - x.effectiveCount || y.lastSeen - x.lastSeen)
    if (typeof limit === 'number' && limit >= 0) {
      return out.slice(0, limit)
    }
    return out
  }

  /** 全部 pair（含未达 minCount 的），按 lastSeen 降序。 */
  getAllPairs() {
    return Array.from(this.pairs.values())
      .map((p) => ({ ...p }))
      .sort((x, y) => y.lastSeen - x.lastSeen)
  }

  /** 清空全部 pair（不重置 maxPairs / minCount / halfLifeHours）。 */
  clear() {
    this.pairs.clear()
  }

  /** 序列化为可 JSON 化对象。 */
  toJSON() {
    return {
      maxPairs: this.maxPairs,
      minCount: this.minCount,
      halfLifeHours: this.halfLifeHours,
      pairs: Array.from(this.pairs.entries()).map(([key, p]) => [key, { ...p }]),
    }
  }

  /**
   * 从对象恢复（清空当前状态再重建）。
   * 向后兼容：缺字段时保留构造时默认值；缺 pairs 时清空。
   * @param {object} data
   * @returns {this}
   */
  fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new TypeError('fromJSON 需要对象')
    }
    if (typeof data.maxPairs === 'number' && data.maxPairs > 0) this.maxPairs = data.maxPairs
    if (typeof data.minCount === 'number' && data.minCount >= 0) this.minCount = data.minCount
    if (typeof data.halfLifeHours === 'number' && data.halfLifeHours > 0) this.halfLifeHours = data.halfLifeHours
    this.pairs = new Map()
    if (Array.isArray(data.pairs)) {
      for (const entry of data.pairs) {
        if (!Array.isArray(entry) || entry.length !== 2) continue
        const [key, p] = entry
        if (typeof key !== 'string' || !p || typeof p !== 'object') continue
        this.pairs.set(key, {
          a: p.a,
          b: p.b,
          count: typeof p.count === 'number' ? p.count : 0,
          weight: typeof p.weight === 'number' ? p.weight : 0,
          lastSeen: typeof p.lastSeen === 'number' ? p.lastSeen : 0,
          firstSeen: typeof p.firstSeen === 'number' ? p.firstSeen : 0,
        })
      }
    }
    return this
  }
}
