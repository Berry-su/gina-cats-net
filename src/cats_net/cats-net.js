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

import { ConceptNode } from './concept-node.js'
import { ConflictResolver } from './conflict-resolver.js'
import { MemoryProjection } from './memory-projection.js'
import { Serializer } from './serializer.js'

export class CatsNet {
  /**
   * @param {object} [options]
   * @param {number} [options.maxIterations]  单次处理的最大扩散迭代次数
   * @param {number} [options.timeoutMs]      单次处理的总超时（毫秒）
   * @param {number} [options.decayFactor]    激活扩散传播衰减系数
   * @param {object} [options.resolverOptions] 透传给 ConflictResolver
   */
  constructor({
    maxIterations = 100,
    timeoutMs = 5000,
    decayFactor = 0.5,
    resolverOptions = {},
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
   * 移除概念节点（若存在）。
   * @param {string} id
   * @returns {boolean}
   */
  removeNode(id) {
    return this.nodes.delete(id)
  }

  /** 概念节点数量。 */
  get size() {
    return this.nodes.size
  }

  /** 重置为初始状态（清空节点/记忆并复位终止旗标）。 */
  reset() {
    this.nodes = new Map()
    this.projection = new MemoryProjection()
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

    // 1) 激活种子
    const activated = new Set()
    for (const { id, amount } of seedList) {
      const node = this.nodes.get(id)
      if (!node) continue
      node.activate(amount, 'seed')
      activated.add(id)
    }

    // 2) 循环扩散
    let iter = 0
    for (iter = 0; iter < maxIter; iter++) {
      this._guard()
      const sources = Array.from(this.nodes.values()).filter(
        (n) => n.activation > minActivation && n.connections.size > 0,
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
          const boost = src.activation * meta.weight * this.decayFactor
          if (boost < minActivation) continue
          const before = target.activation
          target.activate(boost, src.id)
          if (target.activation - before > minActivation) changed = true
          activated.add(targetId)
        }
      }
      if (!changed) break // 收敛，提前终止
    }

    return { iterations: iter, activated: Array.from(activated) }
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
   * @returns {{nodes:Array, memory:Array, meta:object}}
   */
  serialize() {
    return {
      nodes: Array.from(this.nodes.values()).map((n) => n.toJSON()),
      memory: this.projection.toJSON(),
      meta: { nodeCount: this.nodes.size, memoryCount: this.projection.size },
    }
  }

  /**
   * 从快照数据恢复内核状态。
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