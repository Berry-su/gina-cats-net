/**
 * CATS-Net 抽象空间内核 —— 概念抽象节点 (ConceptNode)
 *
 * 概念节点是 CATS-Net 抽象空间中的最小语义单元，模拟类脑神经元簇的若干特性：
 *   - 激活扩散：节点被外部刺激激活后，通过带权连接向相邻节点传播激活。
 *   - 竞争与抑制：有限的激活资源会在相似/相邻节点之间竞争（由 ConflictResolver 处理）。
 *   - 时间衰减：长时间未被激活的概念会逐渐"冷却"。
 *   - 证据累积：概念置信度随证据累积而强化、随矛盾证据而削弱。
 *   - 语义融合：语义高度重合的概念可被融合为更高粒度的抽象节点。
 *
 * 本文件只负责「节点」自身的状态与行为，不负责冲突消解、序列化、记忆投影等跨节点能力。
 */

/** 概念支持的类型（用于语义相似度与冲突判定的先验信息）。 */
export const CONCEPT_TYPES = Object.freeze([
  'entity',      // 实体：具体对象
  'abstract',    // 抽象：抽象概念
  'relation',    // 关系：概念间的关联
  'action',      // 动作：可执行的行为
  'attribute',   // 属性：描述性特征
])

/** 激活值的合法区间。 */
export const ACTIVATION_MIN = 0
export const ACTIVATION_MAX = 1

/** 激活历史的默认最大长度（防止无限增长）。 */
export const HISTORY_MAX_LENGTH = 100

/**
 * 将数值裁剪到 [min, max] 区间。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 校验属性对象：值只能是 number 或 string，其余类型一律忽略并按需提示。
 * @param {object} attributes
 * @returns {object} 过滤后的合法属性对象
 */
function sanitizeAttributes(attributes) {
  const out = {}
  if (!attributes || typeof attributes !== 'object') return out
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'number' || typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

export class ConceptNode {
  /**
   * @param {object} options
   * @param {string} options.id           唯一标识（必填）
   * @param {string} [options.name]       概念名称，缺省取 id
   * @param {string} [options.type]       概念类型，见 CONCEPT_TYPES
   * @param {object} [options.attributes] 属性键值对（值为 number|string）
   * @param {number} [options.activation] 初始激活值 [0,1]
   * @param {number} [options.confidence] 初始置信度/证据强度 [0,1]
   * @param {number} [options.granularity] 概念粒度（越大越抽象）
   */
  constructor({
    id,
    name,
    type = 'abstract',
    attributes = {},
    activation = 0,
    confidence = 1,
    granularity = 1,
  } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('ConceptNode 需要非空字符串 id')
    }
    if (!CONCEPT_TYPES.includes(type)) {
      throw new RangeError(`未知概念类型: ${type}，合法值为 ${CONCEPT_TYPES.join(', ')}`)
    }

    this.id = id
    this.name = typeof name === 'string' && name.length > 0 ? name : id
    this.type = type
    this.attributes = sanitizeAttributes(attributes)
    this.activation = clamp(activation, ACTIVATION_MIN, ACTIVATION_MAX)
    this.confidence = clamp(confidence, 0, 1)
    this.granularity = typeof granularity === 'number' ? granularity : 1

    /** @type {Map<string, {weight:number, type:string, bidirectional:boolean}>} */
    this.connections = new Map()
    /** 激活历史快照，用于时间衰减与审计。 */
    this.history = []
  }

  // ---------------------------------------------------------------------------
  // 激活 / 抑制 / 衰减 —— 类脑兴奋性与抑制性调控
  // ---------------------------------------------------------------------------

  /**
   * 增加激活值（兴奋性输入）。激活值被裁剪到 [0,1]。
   * @param {number} amount 激活增量（>0）
   * @param {string} [sourceId] 激活来源节点 id，用于审计
   * @returns {number} 更新后的激活值
   */
  activate(amount, sourceId) {
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
      throw new TypeError('activate 需要数值型 amount')
    }
    this.activation = clamp(this.activation + amount, ACTIVATION_MIN, ACTIVATION_MAX)
    this._record({ op: 'activate', amount, sourceId, activation: this.activation })
    return this.activation
  }

  /**
   * 降低激活值（抑制性输入）。
   * @param {number} amount 激活减量（>0）
   * @param {string} [sourceId] 抑制来源节点 id
   * @returns {number} 更新后的激活值
   */
  deactivate(amount, sourceId) {
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
      throw new TypeError('deactivate 需要数值型 amount')
    }
    this.activation = clamp(this.activation - amount, ACTIVATION_MIN, ACTIVATION_MAX)
    this._record({ op: 'deactivate', amount, sourceId, activation: this.activation })
    return this.activation
  }

  /**
   * 时间衰减：按比例降低激活值与部分置信度（长期记忆遗忘）。
   * @param {number} rate 衰减系数 (0,1)
   * @returns {{activation:number, confidence:number}} 更新后的状态
   */
  decay(rate = 0.1) {
    const r = clamp(rate, 0, 1)
    this.activation = clamp(this.activation * (1 - r), ACTIVATION_MIN, ACTIVATION_MAX)
    // 置信度只做轻微衰减，避免证据被完全抹除
    this.confidence = clamp(this.confidence * (1 - r * 0.5), 0, 1)
    this._record({ op: 'decay', rate: r, activation: this.activation, confidence: this.confidence })
    return { activation: this.activation, confidence: this.confidence }
  }

  /**
   * 强化概念置信度（证据累积）。
   * @param {number} amount
   * @returns {number} 更新后的置信度
   */
  strengthen(amount = 0.1) {
    this.confidence = clamp(this.confidence + amount, 0, 1)
    this._record({ op: 'strengthen', amount, confidence: this.confidence })
    return this.confidence
  }

  /**
   * 削弱概念置信度（遇到矛盾证据）。
   * @param {number} amount
   * @returns {number} 更新后的置信度
   */
  weaken(amount = 0.1) {
    this.confidence = clamp(this.confidence - amount, 0, 1)
    this._record({ op: 'weaken', amount, confidence: this.confidence })
    return this.confidence
  }

  // ---------------------------------------------------------------------------
  // 连接管理 —— 带权关联，激活扩散的通道
  // ---------------------------------------------------------------------------

  /**
   * 建立/更新与另一节点的带权连接。
   * @param {string} targetId 目标节点 id
   * @param {number} weight 连接权重 (>0)
   * @param {string} type 连接类型（如 association / causal / hierarchical）
   * @param {boolean} bidirectional 是否建立双向连接（默认 true）
   * @returns {this}
   */
  connect(targetId, weight = 1, type = 'association', bidirectional = true) {
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new TypeError('connect 需要非空字符串 targetId')
    }
    if (targetId === this.id) {
      throw new Error(`不允许自连接: ${this.id} -> ${this.id}`)
    }
    const w = clamp(weight, 0, Number.POSITIVE_INFINITY)
    this.connections.set(targetId, { weight: w, type, bidirectional })
    return this
  }

  /**
   * 移除与目标节点的连接。
   * @param {string} targetId
   * @returns {boolean} 是否确实存在并移除
   */
  disconnect(targetId) {
    return this.connections.delete(targetId)
  }

  /**
   * 获取连接权重，不存在时返回 0。
   * @param {string} targetId
   * @returns {number}
   */
  getWeight(targetId) {
    return this.connections.get(targetId)?.weight ?? 0
  }

  /**
   * 以普通对象形式返回连接列表（避免外部直接持有 Map 引用）。
   * @returns {Array<{targetId:string, weight:number, type:string, bidirectional:boolean}>}
   */
  getConnections() {
    return Array.from(this.connections.entries()).map(([targetId, meta]) => ({
      targetId,
      ...meta,
    }))
  }

  // ---------------------------------------------------------------------------
  // 语义相似度 —— 冲突检测与记忆检索的基础
  // ---------------------------------------------------------------------------

  /**
   * 计算与另一节点的语义相似度 [0,1]。
   * 综合三部分：
   *   1) 类型相似度：type 相同记 1，否则 0.5；
   *   2) 文本属性 Jaccard 相似度；
   *   3) 数值属性余弦相似度。
   * @param {ConceptNode} other
   * @returns {number} 综合语义相似度 [0,1]
   */
  similarity(other) {
    if (!(other instanceof ConceptNode)) return 0

    // 1) 类型相似度
    const typeScore = this.type === other.type ? 1 : 0.5

    // 2) 文本属性 Jaccard 相似度（比较字符串属性值）
    const textScore = this._textJaccard(other)

    // 3) 数值属性余弦相似度
    const numScore = this._numericCosine(other)

    // 权重：类型 0.3，文本 0.4，数值 0.3
    return 0.3 * typeScore + 0.4 * textScore + 0.3 * numScore
  }

  /**
   * 文本属性的 Jaccard 相似度：共享（键+值相等）的字符串属性 / 并集。
   * @param {ConceptNode} other
   * @returns {number}
   */
  _textJaccard(other) {
    const a = this._stringAttrPairs()
    const b = other._stringAttrPairs()
    if (a.size === 0 && b.size === 0) return 0.5 // 都无文本属性时给中性分
    const inter = [...a].filter((x) => b.has(x)).length
    const union = new Set([...a, ...b]).size
    return union === 0 ? 0 : inter / union
  }

  /**
   * 数值属性的余弦相似度。
   * @param {ConceptNode} other
   * @returns {number}
   */
  _numericCosine(other) {
    const aKeys = this._numericAttrKeys()
    const bKeys = other._numericAttrKeys()
    const keys = new Set([...aKeys, ...bKeys])
    if (keys.size === 0) return 0.5 // 都无数值属性时给中性分

    let dot = 0
    let na = 0
    let nb = 0
    for (const k of keys) {
      const av = typeof this.attributes[k] === 'number' ? this.attributes[k] : 0
      const bv = typeof other.attributes[k] === 'number' ? other.attributes[k] : 0
      dot += av * bv
      na += av * av
      nb += bv * bv
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

  /**
   * 判断是否与另一节点存在属性矛盾（供 ConflictResolver 使用）。
   * 规则：同名字符串属性值不同，或同名数值属性差异超过阈值。
   * @param {ConceptNode} other
   * @param {number} numericThreshold
   * @returns {Array<{key:string, mine:*, theirs:*}>} 矛盾属性列表
   */
  findAttributeConflicts(other, numericThreshold = 0.5) {
    const conflicts = []
    const keys = new Set([...Object.keys(this.attributes), ...Object.keys(other.attributes)])
    for (const k of keys) {
      const a = this.attributes[k]
      const b = other.attributes[k]
      if (a === undefined || b === undefined) continue // 单边有属性不算矛盾
      if (typeof a === 'string' && typeof b === 'string' && a !== b) {
        conflicts.push({ key: k, mine: a, theirs: b })
      } else if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) > numericThreshold) {
        conflicts.push({ key: k, mine: a, theirs: b })
      }
    }
    return conflicts
  }

  // ---------------------------------------------------------------------------
  // 概念融合 —— 抽象层级上升
  // ---------------------------------------------------------------------------

  /**
   * 将另一节点融合进当前节点（不修改 other，返回新的融合结果副本）。
   * 融合规则（类脑抽象抽象化）：
   *   - 数值属性取加权平均（权重 = confidence）；
   *   - 字符串属性取置信度较高一方的值；
   *   - 连接取并集，重复连接的权重取平均；
   *   - 激活值取较高者，置信度取加权平均，粒度取较大者。
   * @param {ConceptNode} other
   * @returns {ConceptNode} 融合后的新节点（不污染原始两个节点）
   */
  merge(other) {
    if (!(other instanceof ConceptNode)) {
      throw new TypeError('merge 需要 ConceptNode 实例')
    }
    const totalConf = this.confidence + other.confidence
    const wThis = totalConf === 0 ? 0.5 : this.confidence / totalConf
    const wOther = totalConf === 0 ? 0.5 : other.confidence / totalConf

    // 属性融合
    const attributes = {}
    const allKeys = new Set([...Object.keys(this.attributes), ...Object.keys(other.attributes)])
    for (const k of allKeys) {
      const a = this.attributes[k]
      const b = other.attributes[k]
      if (a === undefined) {
        attributes[k] = b
      } else if (b === undefined) {
        attributes[k] = a
      } else if (typeof a === 'number' && typeof b === 'number') {
        attributes[k] = a * wThis + b * wOther
      } else {
        // 字符串取置信度高的一方
        attributes[k] = this.confidence >= other.confidence ? a : b
      }
    }

    const merged = new ConceptNode({
      id: this.id,
      name: this.name,
      type: this.granularity >= other.granularity ? this.type : other.type,
      attributes,
      activation: Math.max(this.activation, other.activation),
      confidence: clamp(this.confidence * wThis + other.confidence * wOther, 0, 1),
      granularity: Math.max(this.granularity, other.granularity),
    })

    // 连接并集，重复连接权重取平均
    const connMap = new Map()
    for (const [targetId, meta] of this.connections) connMap.set(targetId, { ...meta })
    for (const [targetId, meta] of other.connections) {
      if (connMap.has(targetId)) {
        const prev = connMap.get(targetId)
        connMap.set(targetId, {
          weight: (prev.weight + meta.weight) / 2,
          type: prev.type,
          bidirectional: prev.bidirectional || meta.bidirectional,
        })
      } else {
        connMap.set(targetId, { ...meta })
      }
    }
    merged.connections = connMap

    return merged
  }

  // ---------------------------------------------------------------------------
  // 序列化 / 反序列化
  // ---------------------------------------------------------------------------

  /**
   * 序列化为可 JSON 化的普通对象。
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      attributes: { ...this.attributes },
      activation: this.activation,
      confidence: this.confidence,
      granularity: this.granularity,
      connections: this.getConnections(),
      history: this.history.map((h) => ({ ...h })),
    }
  }

  /**
   * 从普通对象恢复为 ConceptNode 实例。
   * @param {object} data
   * @returns {ConceptNode}
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') throw new TypeError('fromJSON 需要对象')
    const node = new ConceptNode({
      id: data.id,
      name: data.name,
      type: data.type,
      attributes: data.attributes,
      activation: data.activation,
      confidence: data.confidence,
      granularity: data.granularity,
    })
    if (Array.isArray(data.connections)) {
      for (const c of data.connections) {
        node.connections.set(c.targetId, {
          weight: c.weight,
          type: c.type,
          bidirectional: c.bidirectional,
        })
      }
    }
    if (Array.isArray(data.history)) {
      node.history = data.history.map((h) => ({ ...h })).slice(-HISTORY_MAX_LENGTH)
    }
    return node
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /** 记录一次状态变更到 history（带长度上限）。 */
  _record(entry) {
    this.history.push({ ts: Date.now(), ...entry })
    if (this.history.length > HISTORY_MAX_LENGTH) {
      this.history = this.history.slice(-HISTORY_MAX_LENGTH)
    }
  }

  /** 字符串属性以 "key=value" 形式组成集合（用于 Jaccard）。 */
  _stringAttrPairs() {
    const pairs = new Set()
    for (const [k, v] of Object.entries(this.attributes)) {
      if (typeof v === 'string') pairs.add(`${k}=${v}`)
    }
    return pairs
  }

  /** 数值属性的键集合。 */
  _numericAttrKeys() {
    return Object.keys(this.attributes).filter((k) => typeof this.attributes[k] === 'number')
  }
}