/**
 * CATS-Net 抽象空间内核 —— 冲突消解 (ConflictResolver)
 *
 * 负责检测并消解抽象空间中概念之间的四类冲突：
 *   1) 语义重叠 (semantic_overlap)：两概念语义相似度过高，疑似冗余节点；
 *   2) 属性矛盾 (attribute_contradiction)：同名属性取值相互冲突；
 *   3) 激活竞争 (activation_rivalry)：激活值接近且争夺同一批连接的稀疏编码资源；
 *   4) 连接不一致 (connection_inconsistency)：双向连接权重不对称。
 *
 * 消解策略（类脑机制的工程映射）：
 *   - merge     融合：冗余概念合并为更高粒度抽象节点；
 *   - arbitrate 证据仲裁：按置信度裁决属性归属，弱证据方被下调；
 *   - suppress  胜者全拿抑制：激活高者保留，激活低者被抑制；
 *   - split     拆分：矛盾属性拆出独立子节点。
 *
 * resolve 系列方法会**原地修改**传入的节点 Map；为保证可控，所有批量操作
 * 内置去重与处理上限，防止同一冲突被反复触发导致死循环。
 */

import { ConceptNode } from './concept-node.js'

/** 冲突类型。 */
export const CONFLICT_TYPES = Object.freeze({
  SEMANTIC_OVERLAP: 'semantic_overlap',
  ATTRIBUTE_CONTRADICTION: 'attribute_contradiction',
  ACTIVATION_RIVALRY: 'activation_rivalry',
  CONNECTION_INCONSISTENCY: 'connection_inconsistency',
})

/** 消解策略。 */
export const RESOLUTION_STRATEGIES = Object.freeze({
  MERGE: 'merge',
  ARBITRATE: 'arbitrate',
  SUPPRESS: 'suppress',
  SPLIT: 'split',
})

/**
 * 冲突严重度映射（用于排序，值越大越先处理）。
 */
const SEVERITY = {
  [CONFLICT_TYPES.SEMANTIC_OVERLAP]: 3,
  [CONFLICT_TYPES.ATTRIBUTE_CONTRADICTION]: 2,
  [CONFLICT_TYPES.CONNECTION_INCONSISTENCY]: 2,
  [CONFLICT_TYPES.ACTIVATION_RIVALRY]: 1,
}

export class ConflictResolver {
  /**
   * @param {object} [options]
   * @param {number} [options.semanticThreshold]   语义重叠判定阈值 [0,1]
   * @param {number} [options.numericThreshold]    数值属性矛盾的差异阈值
   * @param {number} [options.activationRivalry]   激活竞争判定的激活差阈值
   * @param {number} [options.connectionTolerance] 双向连接权重对称容差
   */
  constructor({
    semanticThreshold = 0.8,
    numericThreshold = 0.5,
    activationRivalry = 0.15,
    connectionTolerance = 0.2,
  } = {}) {
    this.semanticThreshold = semanticThreshold
    this.numericThreshold = numericThreshold
    this.activationRivalry = activationRivalry
    this.connectionTolerance = connectionTolerance
  }

  /**
   * 检测所有节点之间的冲突。
   * @param {Map<string, ConceptNode>} nodes
   * @returns {Array<object>} 冲突列表，按严重度降序
   */
  detectConflicts(nodes) {
    if (!(nodes instanceof Map)) throw new TypeError('detectConflicts 需要 Map 类型节点表')
    const ids = Array.from(nodes.keys())
    const conflicts = []
    const seenPairs = new Set()

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = nodes.get(ids[i])
        const b = nodes.get(ids[j])
        if (!a || !b) continue
        const pairKey = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)

        const found = this._detectPair(a, b)
        for (const c of found) conflicts.push(c)
      }
    }

    conflicts.sort((x, y) => y.severity - x.severity)
    return conflicts
  }

  /**
   * 消解单个冲突（原地修改 nodes）。
   * @param {object} conflict 由 detectConflicts 产生的冲突对象
   * @param {Map<string, ConceptNode>} nodes
   * @returns {object} 消解报告
   */
  resolve(conflict, nodes) {
    if (!conflict || typeof conflict !== 'object') {
      throw new TypeError('resolve 需要冲突对象')
    }
    const { type, nodeAId, nodeBId } = conflict
    const a = nodes.get(nodeAId)
    const b = nodes.get(nodeBId)

    // 节点可能已被之前某次消解移除/融合
    if (!a && !b) {
      return { conflict, strategy: null, action: 'skip', message: '两个节点均已不存在', affectedNodes: [] }
    }
    if (!a || !b) {
      const survivor = a ? nodeAId : nodeBId
      return { conflict, strategy: null, action: 'skip', message: `节点 ${survivor} 已不存在`, affectedNodes: [survivor] }
    }

    switch (type) {
      case CONFLICT_TYPES.SEMANTIC_OVERLAP:
        return this._resolveByMerge(conflict, a, b, nodes)
      case CONFLICT_TYPES.ATTRIBUTE_CONTRADICTION:
        return this._resolveAttributeConflict(conflict, a, b, nodes)
      case CONFLICT_TYPES.ACTIVATION_RIVALRY:
        return this._resolveBySuppress(conflict, a, b)
      case CONFLICT_TYPES.CONNECTION_INCONSISTENCY:
        return this._resolveConnectionInconsistency(conflict, a, b)
      default:
        return { conflict, strategy: null, action: 'skip', message: `未知冲突类型: ${type}`, affectedNodes: [] }
    }
  }

  /**
   * 批量检测并消解冲突。
   * @param {Map<string, ConceptNode>} nodes
   * @param {object} [options]
   * @param {number} [options.maxResolutions] 单次消解数量上限（死循环保护）
   * @returns {{resolved:number, skipped:number, report:Array<object>}}
   */
  resolveAll(nodes, { maxResolutions = 1000 } = {}) {
    const conflicts = this.detectConflicts(nodes)
    const report = []
    let resolved = 0
    let skipped = 0

    for (const conflict of conflicts) {
      if (resolved >= maxResolutions) {
        report.push({ conflict, strategy: null, action: 'limit', message: '达到单次消解上限，中止', affectedNodes: [] })
        skipped++
        continue
      }
      const result = this.resolve(conflict, nodes)
      if (result.action === 'skip' || result.action === 'limit') {
        skipped++
      } else {
        resolved++
      }
      report.push(result)
    }

    return { resolved, skipped, report }
  }

  // ---------------------------------------------------------------------------
  // 私有：冲突检测
  // ---------------------------------------------------------------------------

  _detectPair(a, b) {
    const conflicts = []

    // 1) 语义重叠
    const sim = a.similarity(b)
    if (sim >= this.semanticThreshold) {
      conflicts.push({
        type: CONFLICT_TYPES.SEMANTIC_OVERLAP,
        nodeAId: a.id,
        nodeBId: b.id,
        severity: SEVERITY[CONFLICT_TYPES.SEMANTIC_OVERLAP] + sim,
        detail: { similarity: sim },
      })
    }

    // 2) 属性矛盾
    const attrConflicts = a.findAttributeConflicts(b, this.numericThreshold)
    if (attrConflicts.length > 0) {
      conflicts.push({
        type: CONFLICT_TYPES.ATTRIBUTE_CONTRADICTION,
        nodeAId: a.id,
        nodeBId: b.id,
        severity: SEVERITY[CONFLICT_TYPES.ATTRIBUTE_CONTRADICTION] + attrConflicts.length,
        detail: { attributes: attrConflicts },
      })
    }

    // 3) 激活竞争：激活值接近且共享连接
    const activationGap = Math.abs(a.activation - b.activation)
    const sharedConnections = this._sharedTargetCount(a, b)
    if (activationGap <= this.activationRivalry && sharedConnections > 0 && a.activation > 0) {
      conflicts.push({
        type: CONFLICT_TYPES.ACTIVATION_RIVALRY,
        nodeAId: a.id,
        nodeBId: b.id,
        severity: SEVERITY[CONFLICT_TYPES.ACTIVATION_RIVALRY] + sharedConnections,
        detail: { activationGap, sharedConnections },
      })
    }

    // 4) 连接不一致
    const aToB = a.getWeight(b.id)
    const bToA = b.getWeight(a.id)
    if (aToB > 0 && bToA > 0 && Math.abs(aToB - bToA) > this.connectionTolerance) {
      conflicts.push({
        type: CONFLICT_TYPES.CONNECTION_INCONSISTENCY,
        nodeAId: a.id,
        nodeBId: b.id,
        severity: SEVERITY[CONFLICT_TYPES.CONNECTION_INCONSISTENCY] + Math.abs(aToB - bToA),
        detail: { weightAtoB: aToB, weightBtoA: bToA },
      })
    }

    return conflicts
  }

  // ---------------------------------------------------------------------------
  // 私有：消解策略
  // ---------------------------------------------------------------------------

  /** 语义重叠 -> 融合冗余节点。 */
  _resolveByMerge(conflict, a, b, nodes) {
    // 保留 confidence 较高的一方作为融合主体
    const [keeper, removee] = a.confidence >= b.confidence ? [a, b] : [b, a]
    const merged = keeper.merge(removee)
    nodes.delete(removee.id)
    nodes.set(keeper.id, merged)
    this._redirectConnections(nodes, removee.id, keeper.id)
    return {
      conflict,
      strategy: RESOLUTION_STRATEGIES.MERGE,
      action: 'merged',
      message: `融合 ${removee.id} 到 ${keeper.id}（相似度 ${conflict.detail.similarity?.toFixed(3)}）`,
      affectedNodes: [keeper.id, removee.id],
    }
  }

  /** 属性矛盾 -> 证据仲裁（按置信度），极端分歧时拆分。 */
  _resolveAttributeConflict(conflict, a, b, nodes) {
    // 若矛盾属性数量多且双方置信度都高，采用拆分；否则仲裁。
    const attrCount = conflict.detail.attributes.length
    if (attrCount > 1 && a.confidence > 0.6 && b.confidence > 0.6) {
      return this._resolveBySplit(conflict, a, b, nodes)
    }
    const [winner, loser] = a.confidence >= b.confidence ? [a, b] : [b, a]
    // 弱证据方被下调置信度
    loser.weaken(0.15)
    return {
      conflict,
      strategy: RESOLUTION_STRATEGIES.ARBITRATE,
      action: 'arbitrated',
      message: `属性矛盾由 ${winner.id}（置信度 ${winner.confidence.toFixed(2)}）仲裁胜出，下调 ${loser.id}`,
      affectedNodes: [winner.id, loser.id],
    }
  }

  /** 激活竞争 -> 胜者全拿抑制。 */
  _resolveBySuppress(conflict, a, b) {
    const [winner, loser] = a.activation >= b.activation ? [a, b] : [b, a]
    const suppressAmount = Math.min(0.3, Math.max(0.05, Math.abs(a.activation - b.activation) + 0.1))
    loser.deactivate(suppressAmount, winner.id)
    return {
      conflict,
      strategy: RESOLUTION_STRATEGIES.SUPPRESS,
      action: 'suppressed',
      message: `${winner.id} 胜出，抑制 ${loser.id}（-${suppressAmount.toFixed(2)}）`,
      affectedNodes: [winner.id, loser.id],
    }
  }

  /** 连接不一致 -> 取双向权重平均并回写，消除不对称。 */
  _resolveConnectionInconsistency(conflict, a, b) {
    const wAtoB = a.getWeight(b.id)
    const wBtoA = b.getWeight(a.id)
    const avg = (wAtoB + wBtoA) / 2
    a.connect(b.id, avg, a.connections.get(b.id)?.type || 'association', true)
    b.connect(a.id, avg, b.connections.get(a.id)?.type || 'association', true)
    return {
      conflict,
      strategy: RESOLUTION_STRATEGIES.ARBITRATE,
      action: 'balanced',
      message: `平衡 ${a.id}<->${b.id} 连接权重为 ${avg.toFixed(3)}`,
      affectedNodes: [a.id, b.id],
    }
  }

  /** 属性矛盾 -> 拆分出独立子节点承载矛盾属性。 */
  _resolveBySplit(conflict, a, b, nodes) {
    const createdNodes = []
    // 将 a 中与 b 矛盾的属性拆出为 a 的子节点
    const aConflicts = conflict.detail.attributes.filter((c) => c.mine !== undefined && c.theirs !== undefined)
    for (const c of aConflicts) {
      const childId = `${a.id}#split-${c.key}`
      const child = new ConceptNode({
        id: childId,
        name: `${a.name}.${c.key}`,
        type: 'attribute',
        attributes: { [c.key]: c.mine },
        confidence: a.confidence,
        granularity: a.granularity - 1,
      })
      nodes.set(childId, child)
      // 建立父子关联
      const parent = nodes.get(a.id)
      parent.connect(childId, 0.9, 'hierarchical', false)
      createdNodes.push(childId)
    }
    return {
      conflict,
      strategy: RESOLUTION_STRATEGIES.SPLIT,
      action: 'split',
      message: `拆分 ${a.id} 的矛盾属性为子节点: ${createdNodes.join(', ')}`,
      affectedNodes: [a.id, b.id, ...createdNodes],
    }
  }

  // ---------------------------------------------------------------------------
  // 私有：工具
  // ---------------------------------------------------------------------------

  /** 两节点共同连接的目标节点数量。 */
  _sharedTargetCount(a, b) {
    const aTargets = new Set(a.connections.keys())
    let count = 0
    for (const targetId of b.connections.keys()) {
      if (aTargets.has(targetId)) count++
    }
    return count
  }

  /** 将全图中指向 fromId 的连接重定向到 toId（融合后保持图连通）。 */
  _redirectConnections(nodes, fromId, toId) {
    for (const node of nodes.values()) {
      if (node.id === fromId || node.id === toId) continue
      const meta = node.connections.get(fromId)
      if (meta) {
        node.connections.delete(fromId)
        // 若已存在指向 toId 的连接则取平均，否则新建
        const existing = node.connections.get(toId)
        node.connections.set(toId, {
          weight: existing ? (existing.weight + meta.weight) / 2 : meta.weight,
          type: meta.type,
          bidirectional: meta.bidirectional,
        })
      }
    }
  }
}