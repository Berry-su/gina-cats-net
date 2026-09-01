/**
 * CATS-Net 抽象空间内核 —— 主类 (CatsNet)
 *
 * 聚合四大组件，形成完整的「类脑概念抽象空间」：
 *   - ConceptNode        概念抽象节点（状态与行为）
 *   - ConflictResolver   冲突消解
 *   - MemoryProjection   记忆投影
 *   - Serializer         持久化序列化
 *
 * 对外提供统一处理流水线 process()，并内建三类安全机制：
 *   1) 异常容错：所有对外入口做输入校验，流水线整体 try/catch；
 *   2) 死循环拦截：激活扩散迭代上限 + 收敛提前终止 + 冲突消解上限 + 总超时；
 *   3) 紧急终止：abort() 设置终止旗标，运行中每步经 _guard() 检查，立即中断。
 */

import { ConceptNode, CONCEPT_TYPES, ACTIVATION_DECAY_MODELS } from './concept-node.js'
import { ConflictResolver } from './conflict-resolver.js'
import { MemoryProjection } from './memory-projection.js'
import { Serializer } from './serializer.js'
import { CooccurrenceTracker } from './cooccurrence.js'

/**
 * 本地副本：sanitizeAttributes（与 concept-node.js 内部实现一致）
 * 用于 updateConcept / mergeConcepts 改 attributes 时的过滤。
 * @param {object} attributes
 * @returns {object} 过滤后的合法属性对象
 */
function sanitizeAttributesLocal(attributes) {
  const out = {}
  if (!attributes || typeof attributes !== 'object') return out
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'number' || typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

/** 概念自学习（C-1.3）—— 冷概念降权阈值：90 天没激活。 */
const LEARN_COLD_DAYS = 90
/** 概念自学习（C-1.3）—— 冷概念降权因子（C-1.4 将迁移到 salience 字段）。 */
const LEARN_DEMOTE_FACTOR = 0.5
/** 概念自学习（C-1.3）—— 相似度 ≥ 此阈值时自动合并。 */
const LEARN_MERGE_SIMILARITY = 0.6
/** 概念自学习（C-1.3）—— Laplace 平滑常数（影响"新概念入选 confidence"门槛）。 */
const LEARN_LAPLACE_K = 2

export class CatsNet {
  /**
   * @param {object} [options]
   * @param {number} [options.maxIterations]  单次处理的最大扩散迭代次数
   * @param {number} [options.timeoutMs]      单次处理的总超时（毫秒）
   * @param {number} [options.decayFactor]    激活扩散传播衰减系数
   * @param {object} [options.resolverOptions] 透传给 ConflictResolver
   * @param {object} [options.cooccurrenceOptions] 透传给 CooccurrenceTracker
   */
  constructor({
    maxIterations = 100,
    timeoutMs = 5000,
    decayFactor = 0.5,
    resolverOptions = {},
    cooccurrenceOptions = {},
  } = {}) {
    this.maxIterations = maxIterations
    this.timeoutMs = timeoutMs
    this.decayFactor = decayFactor

    /** @type {Map<string, ConceptNode>} */
    this.nodes = new Map()
    /** @type {ConflictResolver} */
    this.resolver = new ConflictResolver(resolverOptions)
    /** @type {MemoryProjection} */
    this.projection = new MemoryProjection()
    /** @type {Serializer} */
    this.serializer = new Serializer()
    /** @type {CooccurrenceTracker} C-1.3：概念自学习共现追踪器 */
    this.cooccurrence = new CooccurrenceTracker(cooccurrenceOptions)

    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 节点生命周期管理
  // ---------------------------------------------------------------------------

  /**
   * 添加概念节点（存在则覆盖）。
   * @param {ConceptNode|object} node ConceptNode 实例或构造参数
   * @returns {ConceptNode}
   */
  addNode(node) {
    const n = node instanceof ConceptNode ? node : new ConceptNode(node)
    this.nodes.set(n.id, n)
    return n
  }

  /**
   * 获取概念节点。
   *
   * C-1.4 行为：仍然返回软删除节点（让上层有机会 `restoreConcept(id)`）；
   * 配合 `getAliveNodes()` / `isAlive(id)` 区分。
   * @param {string} id
   * @returns {ConceptNode|undefined}
   */
  getNode(id) {
    return this.nodes.get(id)
  }

  /**
   * 是否存在概念节点。
   * @param {string} id
   * @returns {boolean}
   */
  hasNode(id) {
    return this.nodes.has(id)
  }

  /**
   * 节点是否存在且**未软删除**。
   *
   * C-1.4 新增：供 `mergeConcepts` / `splitConcept` / `updateConcept` / `learnConcepts` 等
   * "实际操作节点"的 API 在跳过软删除前用。
   * @param {string} id
   * @returns {boolean}
   */
  isAlive(id) {
    const n = this.nodes.get(id)
    return Boolean(n) && n.deletedAt == null
  }

  /**
   * 获取"未软删除"的节点 Map（浅拷贝）。
   *
   * C-1.4 新增：供 `getLevelActivationSummary` / `getConceptSphereData` /
   * `spreadActivation` / `learnConcepts` 等迭代式方法使用。
   * @returns {Map<string, ConceptNode>}
   */
  getAliveNodes() {
    const out = new Map()
    for (const [id, n] of this.nodes) {
      if (n.deletedAt == null) out.set(id, n)
    }
    return out
  }

  /**
   * 移除概念节点（若存在）。同时清掉其他节点对它的连接。
   *
   * C-1.4 行为：硬删除（removeNode 仍会移除软删除节点，等于彻底清理）。
   * @param {string} id
   * @returns {boolean}
   */
  removeNode(id) {
    const existed = this.nodes.delete(id)
    if (existed) {
      // 清理其他节点指向被删节点的连接
      for (const n of this.nodes.values()) n.connections.delete(id)
    }
    return existed
  }

  /** 概念节点数量（含软删除）。 */
  get size() {
    return this.nodes.size
  }

  /** 未软删除节点数量（C-1.4 新增）。 */
  get aliveSize() {
    let n = 0
    for (const node of this.nodes.values()) if (node.deletedAt == null) n++
    return n
  }

  /** 重置为初始状态（清空节点/记忆/共现追踪器并复位终止旗标）。 */
  reset() {
    this.nodes = new Map()
    this.projection = new MemoryProjection()
    this.cooccurrence = new CooccurrenceTracker()
    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 激活：单点激活 + 激活扩散（带死循环/扩散保护）
  // ---------------------------------------------------------------------------

  /**
   * 单点激活一个概念。
   * @param {string} id
   * @param {number} amount
   * @returns {number|null} 更新后激活值；节点不存在返回 null
   */
  activate(id, amount) {
    this._guard()
    const node = this.nodes.get(id)
    if (!node) return null
    return node.activate(amount, id)
  }

  /**
   * 激活扩散：从种子概念沿连接向邻域传播激活。
   *
   * v0.2.0 收口（C-1.1 层次激活扩散）：走 ConceptNode.spreadActivation 跨层权重表 +
   * HOP_DECAY_FACTOR，不再用 this.decayFactor 常数衰减。
   *
   * @param {Array<{id:string, amount:number}>|Object<string,number>} seeds 扩散种子
   * @param {object} [options]
   * @param {number} [options.iterations]   最大迭代次数（覆盖构造默认）
   * @param {number} [options.minActivation] 低于该值停止传播
   * @returns {{iterations:number, activated:string[]}}
   */
  spreadActivation(seeds, { iterations, minActivation = 0.01 } = {}) {
    this._guard()
    const maxIter = iterations ?? this.maxIterations
    const seedList = this._normalizeSeeds(seeds)

    // 1) 激活种子（跳过软删除节点）
    const activated = new Set()
    for (const { id, amount } of seedList) {
      const node = this.nodes.get(id)
      if (!node || node.deletedAt != null) continue
      node.activate(amount, 'seed')
      activated.add(id)
    }

    // 2) 循环扩散
    let iter = 0
    for (iter = 0; iter < maxIter; iter++) {
      this._guard()
      // C-1.4：扩散源跳过软删除节点
      const sources = Array.from(this.nodes.values()).filter(
        (n) => n.deletedAt == null && n.activation > minActivation && n.connections.size > 0,
      )
      if (sources.length === 0) break

      let changed = false
      for (const src of sources) {
        for (const [targetId, meta] of src.connections) {
          if (!meta.bidirectional && src.connections.get(targetId)?.weight === meta.weight) {
            // 非双向连接仍按单向传播
          }
          const target = this.nodes.get(targetId)
          if (!target) continue
          // C-1.4：扩散目标也是软删除 → 跳过
          if (target.deletedAt != null) continue
          // 跨层激活扩散：从 src 节点查 src.level → target.level 转换权重
          //   effective = transition(src.level → target.level) × HOP_DECAY_FACTOR × incoming
          // 取代 v0.1.0 的 `src.activation * meta.weight * this.decayFactor` 常数衰减
          // ADR-002 §3.1.3 文字笔误修正：原文写 target.spreadActivation，
          //   但 spreadActivation 语义是 this.level → targetLevel，
          //   应以 src 为 this、target.level 为目标层
          const incoming = src.activation * meta.weight
          const effective = src.spreadActivation(target.level, incoming)
          if (effective < minActivation) continue
          const before = target.activation
          target.activate(effective, src.id)
          if (target.activation - before > minActivation) changed = true
          activated.add(targetId)
        }
      }
      if (!changed) break // 收敛，提前终止
    }

    return { iterations: iter, activated: Array.from(activated) }
  }

  /**
   * 跨层激活扩散（公开 API · C-1.1）。
   *
   * 以 rootId 为根，沿连接向邻域传播激活；与 spreadActivation 区别：
   *   - 接受 options.levels 限定参与扩散的层次（默认 3 层全开）
   *   - 接受 options.maxDepth 限制扩散深度（默认 3 = 每层一跳）
   *   - 返回值带每层分组 + 完整 trace（节点级 hopPath），便于 3D 可视化
   *
   * @param {string} rootId 根概念 id
   * @param {object} [options]
   * @param {string[]} [options.levels] 参与扩散的层次，默认全部 3 层
   * @param {number} [options.maxDepth] 最大扩散深度（层数），默认 3
   * @param {number} [options.minActivation] 低于该值停止传播，默认 0.01
   * @param {number} [options.seedAmount] 根节点初始激活量，默认 1.0
   * @returns {{
   *   activated: string[],
   *   layers: { episodic: string[], semantic: string[], abstract: string[] },
   *   trace: Array<{ nodeId: string, level: string, activation: number, hopPath: string[] }>
   * }}
   */
  activateHierarchical(
    rootId,
    { levels = ['episodic', 'semantic', 'abstract'], maxDepth = 3, minActivation = 0.01, seedAmount = 1.0 } = {},
  ) {
    this._guard()
    const root = this.nodes.get(rootId)
    if (!root || root.deletedAt != null) {
      return { activated: [], layers: { episodic: [], semantic: [], abstract: [] }, trace: [] }
    }
    // 限定参与扩散的层次
    const allowedLevels = new Set(levels)
    const activated = new Set()
    const layers = { episodic: [], semantic: [], abstract: [] }
    const trace = []

    // BFS 按深度推进：每层深度最多一跳跨层
    // 深度 0：根节点自身（激活）
    root.activate(seedAmount, 'seed:activateHierarchical')
    activated.add(root.id)
    layers[root.level]?.push(root.id)
    trace.push({ nodeId: root.id, level: root.level, activation: root.activation, hopPath: [root.id] })

    // 深度 1..maxDepth
    let frontier = [root]
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next = []
      for (const src of frontier) {
        // C-1.4：跳过软删除的源
        if (src.deletedAt != null) continue
        if (!allowedLevels.has(src.level)) continue
        for (const [targetId, meta] of src.connections) {
          if (activated.has(targetId)) continue
          const target = this.nodes.get(targetId)
          if (!target) continue
          // C-1.4：跳过软删除的目标
          if (target.deletedAt != null) continue
          if (!allowedLevels.has(target.level)) continue
          const incoming = src.activation * meta.weight
          const effective = src.spreadActivation(target.level, incoming)
          if (effective < minActivation) continue
          target.activate(effective, src.id)
          activated.add(target.id)
          layers[target.level]?.push(target.id)
          trace.push({
            nodeId: target.id,
            level: target.level,
            activation: target.activation,
            hopPath: [...(trace.find((t) => t.nodeId === src.id)?.hopPath ?? [src.id]), target.id],
          })
          next.push(target)
        }
      }
      frontier = next
    }

    return { activated: Array.from(activated), layers, trace }
  }

  /**
   * 按层统计激活分布（公开 API · C-1.1）。
   * @returns {{
   *   episodic: { count: number, totalActivation: number, avgActivation: number },
   *   semantic: { count: number, totalActivation: number, avgActivation: number },
   *   abstract: { count: number, totalActivation: number, avgActivation: number }
   * }}
   */
  getLevelActivationSummary() {
    const summary = {
      episodic: { count: 0, totalActivation: 0, avgActivation: 0 },
      semantic: { count: 0, totalActivation: 0, avgActivation: 0 },
      abstract: { count: 0, totalActivation: 0, avgActivation: 0 },
    }
    for (const node of this.nodes.values()) {
      // C-1.4：软删除节点不计入
      if (node.deletedAt != null) continue
      const slot = summary[node.level]
      if (!slot) continue
      slot.count += 1
      slot.totalActivation += node.activation
    }
    for (const key of Object.keys(summary)) {
      const slot = summary[key]
      slot.avgActivation = slot.count > 0 ? slot.totalActivation / slot.count : 0
    }
    return summary
  }

  // ---------------------------------------------------------------------------
  // 时序激活（C-1.2 阶段 2）—— 全图批量衰减 + 时间窗查询
  // ---------------------------------------------------------------------------

  /**
   * 全图批量时序衰减（公开 API）。
   *
   * 对所有节点调 applyTimeDecay(now)，推进 lastActivatedAt 到 now，
   * 把 getActivationAt(now) 写回 activation。
   *
   * 适合：tick 循环 / 持久化前 / 长时间未活动后唤醒。
   *
   * @param {number} [now=Date.now()]
   * @returns {{decayed: number, stable: number}} 衰减节点数 + 稳定节点数
   */
  tickTimeDecay(now = Date.now()) {
    this._guard()
    let decayed = 0
    let stable = 0
    for (const node of this.nodes.values()) {
      // C-1.4：软删除节点不参与时序衰减（保留证据待恢复）
      if (node.deletedAt != null) continue
      const before = node.activation
      node.applyTimeDecay(now)
      // activation 变化 < 1e-9 视为稳定
      if (Math.abs(before - node.activation) < 1e-9) stable += 1
      else decayed += 1
    }
    return { decayed, stable }
  }

  /**
   * 时间窗激活查询（公开 API）。
   *
   * 从节点 history[] 筛 [fromT, toT] 区间的所有 op 条目，按时间戳升序返回。
   * 不做衰减计算（history[] 存的是原始快照，不衰减）。
   *
   * @param {string} id
   * @param {number} fromT 时间戳起点（ms）
   * @param {number} toT 时间戳终点（ms）
   * @returns {Array<{ts:number, op:string, activation?:number, sourceId?:string}>}
   */
  getActivationHistory(id, fromT, toT) {
    if (typeof fromT !== 'number' || !Number.isFinite(fromT)
        || typeof toT !== 'number' || !Number.isFinite(toT)) {
      throw new TypeError('getActivationHistory 需要有限数值型 fromT/toT')
    }
    const node = this.nodes.get(id)
    if (!node) return []
    const lo = Math.min(fromT, toT)
    const hi = Math.max(fromT, toT)
    return node.history
      .filter((h) => typeof h.ts === 'number' && h.ts >= lo && h.ts <= hi)
      .sort((a, b) => a.ts - b.ts)
      .map((h) => ({
        ts: h.ts,
        op: h.op,
        activation: h.activation,
        sourceId: h.sourceId,
      }))
  }

  // ---------------------------------------------------------------------------
  // 概念自学习（C-1.3 阶段 3）—— learnConcepts + 4 重护栏
  // ---------------------------------------------------------------------------

  /**
   * 概念自学习：归纳新概念 + 合并旧概念 + 降权冷概念（ADR-002 §3.3.3）。
   *
   * 算法流程：
   *   1) 数据收集：episodes 缺省从 projection.getMemories() 拉（每条 memory 的 concepts[] 是一次共现）
   *   2) 共现统计：this.cooccurrence.recordEpisode() 遍历所有 (a,b) pair
   *   3) 高频筛选：cooccurrence.getFrequentPairs({ minCount: 5 })
   *   4) 相似度判断：高频 pair 调 a.similarity(b)：
   *        - 双方都已存在 + similarity >= 0.6 → 合并（mergeConcepts 内部动作）
   *        - 仅一方存在 + Laplace 平滑后的 confidence >= minConfidence → 归纳另一方
   *        - 双方都不存在 + 同上 + 容量允许 → 归纳两个新概念
   *   5) 降权冷概念：90 天没激活且 activation < 0.3 的节点 → confidence *= 0.5
   *   6) 返回：{ added: ConceptNode[], merged: {from,to,similarity}[], demoted: {id, beforeConfidence, afterConfidence}[] }
   *
   * 4 重护栏（防概念爆炸）：
   *   1) LRU 10k 上限：CooccurrenceTracker.maxPairs（构造时或 options.cooccurrenceOptions 配）
   *   2) minCount 5：pair 累计次数需 >= 5（CooccurrenceTracker.minCount）
   *   3) maxNew 10：单次新增节点上限
   *   4) halfLife 1 周：旧共现自动衰减（CooccurrenceTracker.halfLifeHours=168）
   *
   * @param {object} [options]
   * @param {Array<{concepts: string[], timestamp?: number}>} [options.episodes]
   *        外部 episode 流；缺省从 projection.getMemories() 拉
   * @param {number} [options.minConfidence=0.7] 新概念入选门槛（基于 Laplace 平滑后的 confidence）
   * @param {number} [options.maxNew=10]         本次新增概念数上限（每个 addNode 算 1）
   * @param {number} [options.now=Date.now()]    衰减参照时间（便于测试用 withMockTime）
   * @param {number} [options.coldDays=90]       冷概念天数阈值
   * @param {number} [options.mergeSimilarity=0.6] 合并相似度门槛
   * @returns {{ added: ConceptNode[], merged: {from:string, to:string, similarity:number}[], demoted: {id:string, beforeConfidence:number, afterConfidence:number}[], recordedPairs: number }}
   */
  learnConcepts({
    episodes,
    minConfidence = 0.7,
    maxNew = 10,
    now = Date.now(),
    coldDays = LEARN_COLD_DAYS,
    mergeSimilarity = LEARN_MERGE_SIMILARITY,
  } = {}) {
    this._guard()
    if (typeof minConfidence !== 'number' || !(minConfidence > 0)) {
      throw new TypeError('learnConcepts 需要正数 minConfidence')
    }
    if (typeof maxNew !== 'number' || !(maxNew >= 0)) {
      throw new TypeError('learnConcepts 需要非负 maxNew')
    }

    const result = { added: [], merged: [], demoted: [], recordedPairs: 0 }
    const tNow = typeof now === 'number' && !Number.isNaN(now) ? now : Date.now()

    // C-1.4：把"软删除"视为不存在（learnConcepts 不应该归纳/合并/降权已软删除节点）
    //  但 hasAlive 在"是否新增"分支里要严格区分：
    //  - hasAlive = "节点存在且未删除"（用于"是 a/b/c"判断）
    //  - hasAny = "节点存在"（包括软删除，用于"是否可 addNode 覆盖"判断）
    //  → 已软删除节点不复活，强行 addNode 会被 nodes.has() 拦截
    const hasAlive = (id) => {
      const n = this.nodes.get(id)
      return Boolean(n) && n.deletedAt == null
    }
    const hasAny = (id) => this.nodes.has(id)

    // 1) 数据收集
    let episodeList = episodes
    if (!Array.isArray(episodeList)) {
      // 从 projection 拉：每条 memory 的 concepts[] + timestamp
      const memories = this.projection.getMemories()
      episodeList = memories.map((m) => ({
        concepts: Array.isArray(m.concepts) ? m.concepts : [],
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : tNow,
      }))
    }

    // 2) 共现统计
    for (const ep of episodeList) {
      if (!ep || !Array.isArray(ep.concepts) || ep.concepts.length < 2) continue
      const ts = typeof ep.timestamp === 'number' ? ep.timestamp : tNow
      const r = this.cooccurrence.recordEpisode(ep.concepts, ts)
      result.recordedPairs += r.recorded
    }

    // 3) 高频筛选
    const frequent = this.cooccurrence.getFrequentPairs({ now: tNow })

    // 4) 相似度判断 + 合并 / 新增
    const addedIds = new Set() // 本次新归纳的 id，避免重复添加
    const absorbed = new Set() // 本次被合并掉的 id，后续 pair 涉及则跳过
    for (const pair of frequent) {
      // 已被合并掉的 id 跳过（防止后续 pair 把它当"不存在"又归纳回来）
      if (absorbed.has(pair.a) || absorbed.has(pair.b)) continue
      if (result.added.length >= maxNew && !this._hasMergeCandidate(pair, frequent, tNow, mergeSimilarity)) {
        continue
      }
      // C-1.4：把软删除视作"不存在"
      const a = hasAlive(pair.a) ? this.nodes.get(pair.a) : null
      const b = hasAlive(pair.b) ? this.nodes.get(pair.b) : null
      const conf = this._confidenceFromCount(pair.count)

      if (a && b) {
        // 双方都存在：检查相似度决定是否合并
        const sim = a.similarity(b)
        if (sim >= mergeSimilarity) {
          const m = this._mergeNodes(a, b)
          if (m) {
            result.merged.push({ from: m.removed, to: m.kept, similarity: sim })
            absorbed.add(m.removed)
          }
        }
        // 否则保留两个独立节点（不强制合并）
      } else if (a && !b && !addedIds.has(pair.b) && !absorbed.has(pair.b)) {
        // 仅 a 存在：归纳 b（但 b 已在 Map 中（含软删除）→ 跳过，避免复活）
        if (result.added.length >= maxNew) continue
        if (conf < minConfidence) continue
        if (hasAny(pair.b)) continue // C-1.4：包括软删除的也算"已存在"，不复活
        const newNode = this.addNode({
          id: pair.b,
          type: 'abstract',
          level: 'semantic',
          confidence: conf,
        })
        // 新归纳的节点跟 a 建弱连接，方便后续激活扩散
        newNode.connect(a.id, 0.5, 'association', false)
        addedIds.add(pair.b)
        result.added.push(newNode)
      } else if (!a && b && !addedIds.has(pair.a) && !absorbed.has(pair.a)) {
        // 仅 b 存在：归纳 a（但 a 已在 Map 中（含软删除）→ 跳过）
        if (result.added.length >= maxNew) continue
        if (conf < minConfidence) continue
        if (hasAny(pair.a)) continue // C-1.4：同上
        const newNode = this.addNode({
          id: pair.a,
          type: 'abstract',
          level: 'semantic',
          confidence: conf,
        })
        newNode.connect(b.id, 0.5, 'association', false)
        addedIds.add(pair.a)
        result.added.push(newNode)
      } else if (!a && !b) {
        // 双方都不存在：尝试归纳两个（容量允许时）
        if (result.added.length + 2 > maxNew) continue
        if (conf < minConfidence) continue
        // C-1.4：双方不在 hasAny 里才能 addNode（防止复活）
        if (hasAny(pair.a) || hasAny(pair.b)) continue
        const na = this.addNode({ id: pair.a, type: 'abstract', level: 'semantic', confidence: conf })
        const nb = this.addNode({ id: pair.b, type: 'abstract', level: 'semantic', confidence: conf })
        na.connect(nb.id, 0.5, 'association', false)
        addedIds.add(pair.a)
        addedIds.add(pair.b)
        result.added.push(na, nb)
      }
    }

    // 5) 降权冷概念（90 天没激活 + activation < 0.3）
    const coldThresholdMs = coldDays * 24 * 3600 * 1000
    for (const node of this.nodes.values()) {
      // C-1.4：软删除节点不参与降权
      if (node.deletedAt != null) continue
      const last = typeof node.lastActivatedAt === 'number' ? node.lastActivatedAt : tNow
      const age = tNow - last
      if (age > coldThresholdMs && node.activation < 0.3) {
        const before = node.confidence
        const after = Math.max(0, before * LEARN_DEMOTE_FACTOR)
        node.confidence = after
        // 同步到 _record 让 history 留痕（C-1.4 会迁移到 salience 字段）
        node._record?.({ op: 'learnDemote', before, after, reason: 'cold' })
        result.demoted.push({ id: node.id, beforeConfidence: before, afterConfidence: after })
      }
    }

    return result
  }

  /**
   * 判断 pair 是否可能产生合并（用于 maxNew 边界判断的辅助）。
   * @private
   */
  _hasMergeCandidate(pair, frequent, _now, threshold) {
    const a = this.nodes.get(pair.a)
    const b = this.nodes.get(pair.b)
    // C-1.4：软删除节点不参与合并候选判断
    if (!a || a.deletedAt != null) return false
    if (!b || b.deletedAt != null) return false
    return a.similarity(b) >= threshold
  }

  /**
   * 用 Laplace 平滑把 pair count 映射为新概念的 confidence：
   *   confidence = count / (count + K)，K=2
   * 这样 count=5 → 0.714，count=7 → 0.778，与默认 minConfidence=0.7 协调。
   * @param {number} count
   * @returns {number}
   */
  _confidenceFromCount(count) {
    if (typeof count !== 'number' || count <= 0) return 0
    return count / (count + LEARN_LAPLACE_K)
  }

  /**
   * 合并两个节点（内部用，C-1.3 learnConcepts 触发，C-1.4 公开为 mergeConcepts）。
   *
   * 行为：
   *   - 保留 confidence 较高一方作 keeper（生成 merged，id/name 取 keeper）
   *   - 合并属性、连接、激活值（沿用 ConceptNode.merge 规则）
   *   - 移除被合并方
   *   - 重定向其他节点指向被合并方的连接（合并到 keeper 上）
   *   - 重定向 projection memory.concepts[] 中的 id
   *   - 清理自连接（merged 上不允许指向自身）
   *
   * @param {string|ConceptNode} idA  节点 id 或 ConceptNode 实例
   * @param {string|ConceptNode} idB  节点 id 或 ConceptNode 实例
   * @returns {{merged:ConceptNode, kept:string, removed:string, redirected:number}|null}
   */
  _mergeNodes(idA, idB) {
    const a = idA instanceof ConceptNode ? idA : this.nodes.get(idA)
    const b = idB instanceof ConceptNode ? idB : this.nodes.get(idB)
    if (!a || !b) return null
    if (a.id === b.id) return null
    // C-1.4：软删除节点不参与合并（避免把已删除节点的证据合并进来）
    if (a.deletedAt != null || b.deletedAt != null) return null
    const [k, r] = a.confidence >= b.confidence ? [a, b] : [b, a]
    const merged = k.merge(r)
    // 清理自连接
    merged.connections.delete(merged.id)
    this.nodes.set(k.id, merged)
    this.nodes.delete(r.id)
    const redirected = this._redirectConnections(r.id, k.id)
    this._redirectMemories(r.id, k.id)
    return { merged, kept: k.id, removed: r.id, redirected }
  }

  /**
   * 把所有其他节点对 fromId 的连接重定向到 toId（连接不存在时新增，重复时合并权重取平均）。
   * @param {string} fromId
   * @param {string} toId
   * @returns {number} 重定向的连接数
   */
  _redirectConnections(fromId, toId) {
    if (fromId === toId) return 0
    let redirected = 0
    for (const node of this.nodes.values()) {
      if (node.id === toId) continue
      if (!node.connections.has(fromId)) continue
      const meta = node.connections.get(fromId)
      node.connections.delete(fromId)
      if (!node.connections.has(toId)) {
        node.connections.set(toId, { ...meta })
      } else {
        // 已存在 → 合并权重
        const existing = node.connections.get(toId)
        existing.weight = (existing.weight + meta.weight) / 2
        existing.bidirectional = existing.bidirectional || meta.bidirectional
      }
      redirected += 1
    }
    return redirected
  }

  /**
   * 把 projection memory 中所有 fromId 引用重定向到 toId。
   * @param {string} fromId
   * @param {string} toId
   * @returns {number} 重定向的记忆数
   */
  _redirectMemories(fromId, toId) {
    if (fromId === toId) return 0
    let redirected = 0
    for (const mem of this.projection.memories.values()) {
      if (!Array.isArray(mem.concepts)) continue
      const idx = mem.concepts.indexOf(fromId)
      if (idx < 0) continue
      mem.concepts[idx] = toId
      if (mem.activationPattern && Object.prototype.hasOwnProperty.call(mem.activationPattern, fromId)) {
        mem.activationPattern[toId] = mem.activationPattern[fromId]
        delete mem.activationPattern[fromId]
      }
      redirected += 1
    }
    return redirected
  }

  // ---------------------------------------------------------------------------
  // 编辑 API（C-1.4 阶段 4）—— 7 个公开 API
  // ---------------------------------------------------------------------------

  /**
   * 1. 增量更新节点元数据（部分更新）。
   *
   * 支持的 patch 字段：name / type / level / attributes / granularity /
   *   activationDecayRate / activationDecayModel
   *
   * 行为约束：
   *   - 软删除节点不允许更新（避免恢复后看到与意图不一致的脏数据）
   *   - attributes patch 是**整体替换**（不是 merge），便于原子性更新
   *   - level / type 改动会走 setLevel() 走 history 留痕
   *   - activation / confidence / salience / deletedAt / connections 不通过此 API 改
   *     （请用专用方法：demote/boost/softDelete/restore/connect）
   *
   * @param {string} id
   * @param {object} patch
   * @returns {ConceptNode|null} 更新后的节点；id 不存在或已软删除返回 null
   */
  updateConcept(id, patch = {}) {
    this._guard()
    const node = this.nodes.get(id)
    if (!node) return null
    if (node.deletedAt != null) return null
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('updateConcept 需要对象 patch')
    }

    // 名称
    if (typeof patch.name === 'string' && patch.name.length > 0) {
      node.name = patch.name
      node._record?.({ op: 'updateName', to: patch.name })
    }

    // 类型
    if (typeof patch.type === 'string') {
      if (!CONCEPT_TYPES.includes(patch.type)) {
        throw new RangeError(`未知概念类型: ${patch.type}`)
      }
      const from = node.type
      node.type = patch.type
      node._record?.({ op: 'updateType', from, to: patch.type })
    }

    // 层次
    if (typeof patch.level === 'string') {
      node.setLevel(patch.level) // 内部已留痕
    }

    // 属性（整体替换）
    if (patch.attributes !== undefined) {
      node.attributes = sanitizeAttributesLocal(patch.attributes)
      node._record?.({ op: 'updateAttributes', keys: Object.keys(node.attributes) })
    }

    // 粒度
    if (typeof patch.granularity === 'number') {
      node.granularity = patch.granularity
      node._record?.({ op: 'updateGranularity', to: patch.granularity })
    }

    // 时序衰减率
    if (typeof patch.activationDecayRate === 'number' && patch.activationDecayRate >= 0) {
      node.activationDecayRate = patch.activationDecayRate
      node._record?.({ op: 'updateDecayRate', to: patch.activationDecayRate })
    }

    if (typeof patch.activationDecayModel === 'string') {
      if (ACTIVATION_DECAY_MODELS.includes(patch.activationDecayModel)) {
        node.activationDecayModel = patch.activationDecayModel
        node._record?.({ op: 'updateDecayModel', to: patch.activationDecayModel })
      }
    }

    return node
  }

  /**
   * 2. 合并多个 concept（公开版，原 _mergeNodes 升级）。
   *
   * 行为：
   *   - ids[0] 默认作为 keeper（除非 newId 提供）
   *   - 多个非 keeper id 依次 merge 进 keeper
   *   - 重定向所有指向被合并节点的连接 → keeper
   *   - 重定向 projection memory.concepts[] 中的 id
   *
   * @param {string[]} ids                              要合并的节点 id 列表（至少 2 个）
   * @param {string} [newId]                            新 keeper id；不传则用 ids[0]
   * @param {object} [newAttributes]                    合并后强制覆盖的属性（整体替换）
   * @returns {{ merged: ConceptNode, removed: string[], redirected: number }|null}
   *          ids 不足 2 个 / 全部不存在 / 全是软删除 → 返回 null
   */
  mergeConcepts(ids, newId, newAttributes) {
    this._guard()
    if (!Array.isArray(ids) || ids.length < 2) {
      throw new TypeError('mergeConcepts 至少需要 2 个 id')
    }
    // 去重 + 过滤软删除 + 过滤不存在
    const validIds = []
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) continue
      const n = this.nodes.get(id)
      if (!n || n.deletedAt != null) continue
      if (!validIds.includes(id)) validIds.push(id)
    }
    if (validIds.length < 2) return null

    // 决定 keeper id
    const keeperId = (typeof newId === 'string' && newId.length > 0) ? newId : validIds[0]

    // 处理 newId 跟 ids 重叠的情况
    let keeper = this.nodes.get(keeperId)
    let allRemoved = validIds.filter((id) => id !== keeperId)

    // 如果 newId 提供的 keeper 还不存在，需要先 addNode 一个空的 keeper
    if (!keeper) {
      // 从 validIds[0] 借用类型/层次/粒度
      const sample = this.nodes.get(validIds[0])
      keeper = this.addNode({
        id: keeperId,
        name: sample.name,
        type: sample.type,
        level: sample.level,
        granularity: sample.granularity,
      })
      // 把它从 allRemoved 里排除（newId 显式指定，不会是 removed）
      allRemoved = validIds.filter((id) => id !== keeperId)
    } else if (keeper.deletedAt != null) {
      // keeper 本身是软删除 → 不允许合并
      return null
    }

    // 依次把 validIds 里非 keeper 的节点 merge 进 keeper
    let totalRedirected = 0
    const removedList = []
    for (const rid of allRemoved) {
      const r = this.nodes.get(rid)
      if (!r || r.deletedAt != null) continue
      const result = this._mergeNodes(keeper, r)
      if (result) {
        totalRedirected += result.redirected
        removedList.push(result.removed)
        // _mergeNodes 会替换 this.nodes[keeperId]，需要刷新 keeper 引用
        keeper = this.nodes.get(keeperId)
      }
    }

    // 应用 newAttributes 强制覆盖（如果提供）
    if (newAttributes && typeof newAttributes === 'object' && keeper) {
      keeper.attributes = sanitizeAttributesLocal(newAttributes)
      keeper._record?.({ op: 'mergeAttributes', keys: Object.keys(keeper.attributes) })
    }

    return {
      merged: keeper,
      removed: removedList,
      redirected: totalRedirected,
    }
  }

  /**
   * 3. 拆分一个 concept。
   *
   * 行为：
   *   - 保留原节点（不动 attributes / connections）
   *   - 为 parts 数组每个 part 创建一个新 ConceptNode
   *   - 原节点与每个子节点建立 hierarchical 弱连接（单向）
   *
   * @param {string} id
   * @param {Array<{id?: string, name?: string, type?: string, level?: string, attributes?: object, weight?: number}>} parts
   * @returns {{ original: ConceptNode, children: ConceptNode[] }|null}
   *          id 不存在 / 软删除 / parts 为空 → 返回 null
   */
  splitConcept(id, parts) {
    this._guard()
    const original = this.nodes.get(id)
    if (!original || original.deletedAt != null) return null
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new TypeError('splitConcept 需要非空 parts 数组')
    }

    const children = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] || {}
      // 自动生成子节点 id（如果没传）
      const childId = typeof part.id === 'string' && part.id.length > 0
        ? part.id
        : `${id}#split-${i}`

      // 不允许覆盖已存在的活跃节点
      if (this.nodes.has(childId) && this.isAlive(childId)) {
        throw new Error(`splitConcept 子节点 id 已存在: ${childId}`)
      }

      // 构造子节点
      const child = this.addNode({
        id: childId,
        name: typeof part.name === 'string' && part.name.length > 0 ? part.name : `${original.name}.${i}`,
        type: typeof part.type === 'string' ? part.type : original.type,
        level: typeof part.level === 'string' ? part.level : original.level,
        attributes: part.attributes && typeof part.attributes === 'object' ? part.attributes : {},
        granularity: Math.max(0, original.granularity - 1),
        confidence: original.confidence,
      })

      // 建立父子 hierarchical 弱连接（单向，weight 来自 part 或默认 0.5）
      const w = typeof part.weight === 'number' ? part.weight : 0.5
      original.connect(childId, w, 'hierarchical', false)
      child.connect(original.id, w, 'hierarchical', false)

      original._record?.({ op: 'splitChild', childId, weight: w })
      children.push(child)
    }

    return { original, children }
  }

  /**
   * 4. 降权（保留节点，可恢复）。
   *
   * 关键设计（ADR-002 §3.4.2）：
   *   - **只**改 salience，**不动** confidence / activation
   *   - 公式：salience *= factor，clamp [0,1]
   *
   * @param {string} id
   * @param {number} [factor=0.5]
   * @returns {ConceptNode|null} 降权后的节点；id 不存在 / 软删除 → null
   */
  demoteConcept(id, factor = 0.5) {
    this._guard()
    const node = this.nodes.get(id)
    if (!node || node.deletedAt != null) return null
    node.demote(factor) // 内部已留痕 + 兜底非法 factor
    return node
  }

  /**
   * 5. 提权（反向降权）。
   *
   * 关键设计（ADR-002 §3.4.2）：
   *   - **只**改 salience，**不动** confidence / activation
   *   - 公式：salience *= factor，clamp [0,1]
   *
   * @param {string} id
   * @param {number} [factor=1.2]
   * @returns {ConceptNode|null} 提权后的节点；id 不存在 / 软删除 → null
   */
  boostConcept(id, factor = 1.2) {
    this._guard()
    const node = this.nodes.get(id)
    if (!node || node.deletedAt != null) return null
    node.boost(factor)
    return node
  }

  /**
   * 6. 软删除（保留 30 天逻辑，process / spread / learn 全部跳过）。
   *
   * 行为：
   *   - 节点**保留在 Map**（getNode(id) 仍返回），便于后续 restore
   *   - 设 deletedAt = now；之后 isAlive(id) === false
   *   - 重复 softDelete：覆盖 deletedAt 为新时间戳
   *
   * @param {string} id
   * @returns {boolean} true = 之前未删除并已软删除；false = id 不存在 / 已是软删除
   */
  softDeleteConcept(id) {
    this._guard()
    const node = this.nodes.get(id)
    if (!node) return false
    if (node.deletedAt != null) return false // 已删除，幂等返回 false
    node.softDelete(Date.now())
    return true
  }

  /**
   * 7. 恢复软删除。
   *
   * @param {string} id
   * @returns {ConceptNode|null} 恢复后的节点；id 不存在 / 未软删除 → null
   */
  restoreConcept(id) {
    this._guard()
    const node = this.nodes.get(id)
    if (!node) return null
    if (node.deletedAt == null) return null
    node.restore()
    return node
  }

  // ---------------------------------------------------------------------------
  // 冲突消解 / 记忆投影
  // ---------------------------------------------------------------------------

  /**
   * 检测并消解当前空间中的所有冲突。
   * @param {object} [options] 透传给 ConflictResolver.resolveAll
   * @returns {{resolved:number, skipped:number, report:Array}}
   */
  resolveConflicts(options) {
    this._guard()
    return this.resolver.resolveAll(this.nodes, options)
  }

  /**
   * 将情境记忆投影到抽象空间。
   * @param {object} episode 见 MemoryProjection.project
   * @returns {object} MemoryEntry
   */
  projectMemory(episode) {
    this._guard()
    return this.projection.project(episode, this.nodes)
  }

  /**
   * 检索相关记忆。
   * @param {string[]} queryConcepts
   * @param {object} [options]
   * @returns {Array}
   */
  retrieveMemory(queryConcepts, options) {
    return this.projection.retrieve(queryConcepts, options)
  }

  // ---------------------------------------------------------------------------
  // 统一处理流水线
  // ---------------------------------------------------------------------------

  /**
   * 统一处理流水线：感知输入 → 概念抽象 → 激活扩散 → 冲突消解 → 记忆投影。
   * @param {object} perception
   * @param {Array<{id:string, weight?:number}>} [perception.concepts] 感知映射的概念（缺则自动抽象化）
   * @param {object} [perception.episode]  可选情境记忆（触发投影）
   * @param {object} [perception.options]  透传 spreadActivation / resolveConflicts
   * @returns {object} 处理结果 { aborted, activated, conflicts, memory }
   */
  process(perception = {}) {
    const startedAt = Date.now()

    try {
      // 安全闸门置于 try 内：紧急终止时返回 aborted 状态而非让异常逃逸
      this._guard()
      const concepts = Array.isArray(perception.concepts) ? perception.concepts : []

      // 1) 概念抽象：感知输入中的概念若缺失，自动创建抽象节点
      const seeds = []
      for (const c of concepts) {
        const id = typeof c === 'string' ? c : c?.id
        if (!id) continue
        if (!this.nodes.has(id)) {
          this.addNode({
            id,
            name: typeof c === 'string' ? id : c?.name ?? id,
            type: typeof c === 'object' ? c?.type ?? 'abstract' : 'abstract',
            attributes: typeof c === 'object' ? c?.attributes ?? {} : {},
            granularity: typeof c === 'object' ? c?.granularity ?? 1 : 1,
          })
        }
        seeds.push({ id, amount: typeof c === 'object' && typeof c.weight === 'number' ? c.weight : 1 })
      }

      // 2) 激活扩散
      const spread = seeds.length > 0
        ? this.spreadActivation(seeds, perception.options)
        : { iterations: 0, activated: [] }

      // 3) 冲突消解
      const conflicts = this.resolveConflicts(perception.options?.resolver)

      // 4) 记忆投影
      let memory = null
      if (perception.episode) {
        memory = this.projectMemory(perception.episode)
      }

      // 总超时保护（处理完成后虽返回结果，但若超时也标记）
      const timedOut = Date.now() - startedAt > this.timeoutMs

      return {
        aborted: false,
        timedOut,
        spread,
        conflicts,
        memory: memory ? memory.toJSON() : null,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (err) {
      // 紧急终止或异常，统一归集，不让异常逃逸导致 Agent 失控
      return {
        aborted: this._aborted,
        timedOut: false,
        error: err.message,
        spread: { iterations: 0, activated: [] },
        conflicts: { resolved: 0, skipped: 0, report: [] },
        memory: null,
        elapsedMs: Date.now() - startedAt,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 紧急终止机制
  // ---------------------------------------------------------------------------

  /**
   * 紧急终止：置位终止旗标，后续任何受保护操作都会立即中断。
   * @returns {this}
   */
  abort() {
    this._aborted = true
    return this
  }

  /** 是否已处于终止状态。 */
  isAborted() {
    return this._aborted
  }

  /** 解除终止状态（需显式调用）。 */
  clearAbort() {
    this._aborted = false
    return this
  }

  /** 运行中安全闸门：已终止则立即抛错。 */
  _guard() {
    if (this._aborted) {
      throw new Error('CATS-Net 已紧急终止，操作被拒绝')
    }
  }

  // ---------------------------------------------------------------------------
  // 序列化 / 持久化
  // ---------------------------------------------------------------------------

  /**
   * 产出内核快照（纯对象，供 Serializer 标准化与落盘）。
   *
   * C-1.3：额外携带 cooccurrence 字段（CooccurrenceTracker 状态），便于持久化自学习信号。
   *
   * @returns {{nodes:Array, memory:Array, cooccurrence:object, meta:object}}
   */
  serialize() {
    return {
      nodes: Array.from(this.nodes.values()).map((n) => n.toJSON()),
      memory: this.projection.toJSON(),
      cooccurrence: this.cooccurrence.toJSON(),
      meta: { nodeCount: this.nodes.size, memoryCount: this.projection.size },
    }
  }

  /**
   * 从快照数据恢复内核状态。
   * 向后兼容：
   *   - 旧快照无 cooccurrence 字段 → 初始化为空 CooccurrenceTracker
   *   - 旧快照有 cooccurrence 字段 → 完整恢复（maxPairs / minCount / halfLifeHours / pairs）
   * @param {object} data 来自 Serializer.deserialize / loadFromFile 的结果
   * @returns {this}
   */
  deserialize(data) {
    if (data.nodes instanceof Map) {
      this.nodes = data.nodes
    } else if (Array.isArray(data.nodes)) {
      this.nodes = new Map(data.nodes.map((n) => {
        const node = ConceptNode.fromJSON(n)
        return [node.id, node]
      }))
    } else {
      throw new TypeError('deserialize 需要 nodes 为 Map 或数组')
    }
    this.projection.fromJSON(data.memory ?? [])
    if (data.cooccurrence && typeof data.cooccurrence === 'object') {
      this.cooccurrence.fromJSON(data.cooccurrence)
    } else {
      // 旧快照无 cooccurrence 字段 → 重置为空 tracker
      this.cooccurrence = new CooccurrenceTracker()
    }
    return this
  }

  /**
   * 原子保存到磁盘。
   * @param {string} filePath
   * @returns {string} 文件路径
   */
  save(filePath) {
    return this.serializer.saveToFile(filePath, this.serialize())
  }

  /**
   * 从磁盘加载并覆盖当前状态。
   * @param {string} filePath
   * @returns {this}
   */
  load(filePath) {
    const data = this.serializer.loadFromFile(filePath)
    return this.deserialize(data)
  }

  // ---------------------------------------------------------------------------
  // 私有工具
  // ---------------------------------------------------------------------------

  /** 归一化扩散种子：支持数组与对象两种形式。 */
  _normalizeSeeds(seeds) {
    const list = []
    if (Array.isArray(seeds)) {
      for (const s of seeds) {
        if (s && typeof s.id === 'string') {
          list.push({ id: s.id, amount: typeof s.amount === 'number' ? s.amount : 1 })
        }
      }
    } else if (seeds && typeof seeds === 'object') {
      for (const [id, amount] of Object.entries(seeds)) {
        list.push({ id, amount: typeof amount === 'number' ? amount : 1 })
      }
    }
    return list
  }
}