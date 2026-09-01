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

/**
 * 概念层次（Y-03 L3 激活扩散层次）。
 *
 * 三层抽象，对应认知科学里"情节 / 语义 / 抽象"三个粒度：
 *   - episodic  情节层：与具体时间/事件绑定的概念（"昨天 14:32 跌停"）
 *   - semantic  语义层：通用语义概念（"股票" "波动"）
 *   - abstract  抽象层：高度抽象的元概念（"风险" "价值"）
 *
 * 节点默认在 semantic 层（中层），保证向后兼容。
 */
export const CONCEPT_LEVELS = Object.freeze(['episodic', 'semantic', 'abstract'])

/** 跨层激活扩散权重表（行 = 源层，列 = 目标层）。 */
export const LEVEL_TRANSITION_WEIGHTS = Object.freeze({
  'episodic→episodic': 1.0,
  'episodic→semantic': 0.5,
  'episodic→abstract': 0.2,
  'semantic→episodic': 0.5,
  'semantic→semantic': 1.0,
  'semantic→abstract': 0.3,
  'abstract→episodic': 0.2,
  'abstract→semantic': 0.3,
  'abstract→abstract': 1.0,
})

/** 每跳的衰减系数（跨层传播每经过一跳乘一次）。 */
export const HOP_DECAY_FACTOR = 0.9

/** 激活值的合法区间。 */
export const ACTIVATION_MIN = 0
export const ACTIVATION_MAX = 1

/** 激活历史的默认最大长度（防止无限增长）。 */
export const HISTORY_MAX_LENGTH = 100

// ---------------------------------------------------------------------------
// 时序激活（C-1.2 阶段 2）—— 衰减率按 level 分类型
// ---------------------------------------------------------------------------

/**
 * 各 level 的默认时序衰减率（按小时，指数衰减）。
 *
 * 衰减公式：A(t) = A(t0) × exp(-λ × Δt_hours)
 *   - episodic: 0.1 / h   → 24h 后 ≈ 0.09（短期记忆快速遗忘）
 *   - semantic: 0.01 / h  → 3 天后 ≈ 0.5（中等衰减）
 *   - abstract: 0.001 / h → 几乎永久（1 年衰减不到一半）
 *
 * 构造 ConceptNode 时若不显式传 activationDecayRate，按 level 自动选。
 */
export const LEVEL_DECAY_RATES = Object.freeze({
  episodic: 0.1,
  semantic: 0.01,
  abstract: 0.001,
})

/** 时序衰减模型（预留扩展位）。 */
export const ACTIVATION_DECAY_MODELS = Object.freeze(['exponential'])

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

/**
 * 查询跨层激活扩散权重（行 = 源层，列 = 目标层）。
 * 未知转换或非法 level 返回 0。
 * @param {string} fromLevel 源节点层次
 * @param {string} toLevel   目标节点层次
 * @returns {number} 跨层权重 [0,1]
 */
export function getLevelTransitionWeight(fromLevel, toLevel) {
  if (!CONCEPT_LEVELS.includes(fromLevel) || !CONCEPT_LEVELS.includes(toLevel)) return 0
  if (fromLevel === toLevel) return 1
  return LEVEL_TRANSITION_WEIGHTS[`${fromLevel}→${toLevel}`] ?? 0
}

export class ConceptNode {
  /**
   * @param {object} options
   * @param {string} options.id           唯一标识（必填）
   * @param {string} [options.name]       概念名称，缺省取 id
   * @param {string} [options.type]       概念类型，见 CONCEPT_TYPES
   * @param {string} [options.level]      概念层次（Y-03）：'episodic' | 'semantic' | 'abstract'，默认 'semantic'
   * @param {object} [options.attributes] 属性键值对（值为 number|string）
   * @param {number} [options.activation] 初始激活值 [0,1]
   * @param {number} [options.confidence] 初始置信度/证据强度 [0,1]
   * @param {number} [options.granularity] 概念粒度（越大越抽象）
   * @param {number} [options.lastActivatedAt] 最近一次激活时间戳（ms），默认 Date.now()
   * @param {number} [options.activationDecayRate] 时序衰减率（按小时），默认按 level 自动选
   * @param {string} [options.activationDecayModel] 衰减模型，默认 'exponential'
   * @param {number} [options.salience]  重要性权重 [0,1]（C-1.4 阶段 4 新增），默认 = confidence
   * @param {number|null} [options.deletedAt] 软删除时间戳（ms），C-1.4 阶段 4 新增；非 null 视为已软删除
   */
  constructor({
    id,
    name,
    type = 'abstract',
    level = 'semantic',
    attributes = {},
    activation = 0,
    confidence = 1,
    granularity = 1,
    lastActivatedAt,
    activationDecayRate,
    activationDecayModel = 'exponential',
    salience,
    deletedAt = null,
  } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('ConceptNode 需要非空字符串 id')
    }
    if (!CONCEPT_TYPES.includes(type)) {
      throw new RangeError(`未知概念类型: ${type}，合法值为 ${CONCEPT_TYPES.join(', ')}`)
    }
    if (!CONCEPT_LEVELS.includes(level)) {
      throw new RangeError(`未知概念层次: ${level}，合法值为 ${CONCEPT_LEVELS.join(', ')}`)
    }
    if (deletedAt !== null && (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt))) {
      throw new TypeError('deletedAt 需要有限数值或 null')
    }

    this.id = id
    this.name = typeof name === 'string' && name.length > 0 ? name : id
    this.type = type
    this.level = level
    this.attributes = sanitizeAttributes(attributes)
    this.activation = clamp(activation, ACTIVATION_MIN, ACTIVATION_MAX)
    this.confidence = clamp(confidence, 0, 1)
    this.granularity = typeof granularity === 'number' ? granularity : 1

    // C-1.2 时序激活字段
    this.lastActivatedAt = typeof lastActivatedAt === 'number' ? lastActivatedAt : Date.now()
    this.activationDecayRate = typeof activationDecayRate === 'number'
      ? activationDecayRate
      : LEVEL_DECAY_RATES[level]
    this.activationDecayModel = ACTIVATION_DECAY_MODELS.includes(activationDecayModel)
      ? activationDecayModel
      : 'exponential'

    // C-1.4 阶段 4：编辑 API 字段
    //   - salience：重要性权重，独立于 confidence/activation；
    //     默认 = confidence（向后兼容：旧节点没显式设时跟着 evidence 走）
    //   - deletedAt：软删除时间戳；非 null 视为已软删除（process / spread / learn 跳过）
    this.salience = clamp(
      typeof salience === 'number' ? salience : confidence,
      0, 1,
    )
    this.deletedAt = deletedAt

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
    this.lastActivatedAt = Date.now()
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
    this.lastActivatedAt = Date.now()
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
    this.lastActivatedAt = Date.now()
    this._record({ op: 'decay', rate: r, activation: this.activation, confidence: this.confidence })
    return { activation: this.activation, confidence: this.confidence }
  }

  // ---------------------------------------------------------------------------
  // 时序激活（C-1.2 阶段 2）—— 指数衰减 + 时间点查询
  // ---------------------------------------------------------------------------

  /**
   * 按时间点查询激活值（**纯查询，不改 this.activation**）。
   *
   * 公式（指数衰减）：
   *   A(t) = this.activation × exp(-activationDecayRate × Δt_hours)
   *   Δt_hours = max(0, (t - this.lastActivatedAt)) / 3600000
   *
   * @param {number} t  时间戳（ms），建议 Date.now() 风格
   * @returns {number} 该时刻的激活值 [0,1]
   */
  getActivationAt(t) {
    if (typeof t !== 'number' || Number.isNaN(t)) {
      throw new TypeError('getActivationAt 需要数值型时间戳 t')
    }
    const deltaMs = Math.max(0, t - this.lastActivatedAt)
    const deltaHours = deltaMs / 3600000
    const decayed = this.activation * Math.exp(-this.activationDecayRate * deltaHours)
    return clamp(decayed, ACTIVATION_MIN, ACTIVATION_MAX)
  }

  /**
   * 应用时序衰减到当前（**实际改 this.activation**，推进 lastActivatedAt）。
   *
   * 等价于：在时刻 now 查询 getActivationAt(now)，把结果写回 this.activation。
   * 适合 tick 循环 / 持久化前批量衰减。
   *
   * @param {number} [now=Date.now()]
   * @returns {number} 衰减后激活值
   */
  applyTimeDecay(now = Date.now()) {
    const decayed = this.getActivationAt(now)
    this.activation = decayed
    this.lastActivatedAt = now
    this._record({ op: 'applyTimeDecay', activation: this.activation, now })
    return this.activation
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
      // 层次取较高抽象度一侧（与 type 选择规则保持一致）
      level: this.granularity >= other.granularity ? this.level : other.level,
      attributes,
      activation: Math.max(this.activation, other.activation),
      confidence: clamp(this.confidence * wThis + other.confidence * wOther, 0, 1),
      // C-1.4：salience 也按 confidence 加权平均（重要性随证据强度走）
      salience: clamp(this.salience * wThis + other.salience * wOther, 0, 1),
      granularity: Math.max(this.granularity, other.granularity),
      // C-1.4：deletedAt 取并集（任一被软删除 → 合并后也视为软删除）
      deletedAt: this.deletedAt != null ? this.deletedAt : other.deletedAt,
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
  // 层次管理 —— Y-03 L3 激活扩散层次
  // ---------------------------------------------------------------------------

  /**
   * 设置概念层次（episodic / semantic / abstract）。
   * 设置会被记录到 history，便于审计与回放。
   * @param {string} level
   * @returns {this}
   */
  setLevel(level) {
    if (!CONCEPT_LEVELS.includes(level)) {
      throw new RangeError(`未知概念层次: ${level}，合法值为 ${CONCEPT_LEVELS.join(', ')}`)
    }
    const from = this.level
    if (from === level) return this
    this.level = level
    this._record({ op: 'setLevel', from, to: level })
    return this
  }

  // ---------------------------------------------------------------------------
  // 编辑 API（C-1.4 阶段 4）—— salience 调整 + 软删除
  // ---------------------------------------------------------------------------

  /**
   * 降权（保留节点，可恢复）。
   *
   * 关键设计（ADR-002 §3.4.2）：
   *   - **只**改 salience，**不动** confidence / activation
   *   - 公式：salience *= factor，clamp [0,1]
   *   - 不抛错：factor 非法时按 0.5 兜底（防御性，不破调用方）
   *
   * @param {number} [factor=0.5]
   * @returns {number} 降权后的 salience
   */
  demote(factor = 0.5) {
    const f = (typeof factor === 'number' && Number.isFinite(factor) && factor > 0) ? factor : 0.5
    const before = this.salience
    this.salience = clamp(this.salience * f, 0, 1)
    this._record({ op: 'demote', factor: f, before, after: this.salience })
    return this.salience
  }

  /**
   * 提权（反向降权）。
   *
   * 关键设计（ADR-002 §3.4.2）：
   *   - **只**改 salience，**不动** confidence / activation
   *   - 公式：salience *= factor，clamp [0,1]
   *
   * @param {number} [factor=1.2]
   * @returns {number} 提权后的 salience
   */
  boost(factor = 1.2) {
    const f = (typeof factor === 'number' && Number.isFinite(factor) && factor > 0) ? factor : 1.2
    const before = this.salience
    this.salience = clamp(this.salience * f, 0, 1)
    this._record({ op: 'boost', factor: f, before, after: this.salience })
    return this.salience
  }

  /**
   * 软删除（节点保留在 Map，可通过 restore 恢复）。
   *
   * 行为：
   *   - 设 deletedAt = now（默认 Date.now()），process / spread / learn 等查询会跳过
   *   - 不动 activation / confidence / connections
   *   - 重复 softDelete：覆盖 deletedAt 为新时间戳
   *
   * @param {number} [now=Date.now()]
   * @returns {number} 设置的 deletedAt 时间戳
   */
  softDelete(now = Date.now()) {
    const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const before = this.deletedAt
    this.deletedAt = ts
    this._record({ op: 'softDelete', before, after: ts })
    return ts
  }

  /**
   * 恢复软删除（清 deletedAt）。
   *
   * @returns {boolean} true = 之前是软删除态并已恢复；false = 本来就没被删除
   */
  restore() {
    if (this.deletedAt == null) return false
    const before = this.deletedAt
    this.deletedAt = null
    this._record({ op: 'restore', before })
    return true
  }

  /**
   * 是否处于软删除态。
   * @returns {boolean}
   */
  isDeleted() {
    return this.deletedAt != null
  }

  /**
   * 跨层激活扩散（Y-03 核心算法）。
   *
   * 给定目标层次与传入权重，返回经跨层转换与单跳衰减后的有效权重。
   *   effective = levelTransition(from→to) × HOP_DECAY_FACTOR × incomingWeight
   *
   * 跨层权重表（行=源层 / 列=目标层）：
   *               episodic  semantic  abstract
   *   episodic      1.0       0.5       0.2
   *   semantic      0.5       1.0       0.3
   *   abstract      0.2       0.3       1.0
   *
   * 调用方（通常是 CatsNet.spreadActivation）会再叠加连接权重、当前激活值与多跳累乘 HOP_DECAY_FACTOR。
   *
   * @param {string} targetLevel     目标节点层次
   * @param {number} [incomingWeight=1.0] 传入权重（典型 = 连接权重 × 源节点当前激活）
   * @returns {number} 跨层有效权重 [0,1]；非法 level 返回 0
   */
  spreadActivation(targetLevel, incomingWeight = 1.0) {
    if (typeof incomingWeight !== 'number' || Number.isNaN(incomingWeight)) {
      throw new TypeError('spreadActivation 需要数值型 incomingWeight')
    }
    if (!CONCEPT_LEVELS.includes(targetLevel)) {
      this._record({ op: 'spreadActivation', fromLevel: this.level, toLevel: String(targetLevel), incomingWeight, effective: 0, rejected: true })
      return 0
    }
    const transition = getLevelTransitionWeight(this.level, targetLevel)
    const effective = transition * HOP_DECAY_FACTOR * clamp(incomingWeight, 0, 1)
    this._record({ op: 'spreadActivation', fromLevel: this.level, toLevel: targetLevel, incomingWeight, transition, effective })
    return effective
  }

  /**
   * 构造 3D 概念球编辑器数据（Y-03 + Y-10-R 后端契约）。
   *
   * 输入一组 ConceptNode（Map 或数组），输出前端可直接渲染的纯数据：
   *   - nodes:  [{ id, name, level, activation, confidence, granularity, type }]
   *   - edges:  [{ source, target, weight, type, levelTransition }]
   *   - layers: { episodic: { count, totalActivation, avgActivation }, semantic: ..., abstract: ... }
   *
   * 3D 坐标 (x,y,z) 由前端按 level + 球面布局计算；本方法只供数据。
   *
   * @param {Map<string, ConceptNode>|Iterable<ConceptNode>} nodes
   * @returns {{nodes:Array, edges:Array, layers:object}}
   */
  static getConceptSphereData(nodes) {
    const map = (() => {
      if (nodes instanceof Map) return nodes
      if (Array.isArray(nodes)) return new Map(nodes.filter((n) => n && n.id).map((n) => [n.id, n]))
      if (nodes && typeof nodes[Symbol.iterator] === 'function') {
        const m = new Map()
        for (const n of nodes) if (n && n.id) m.set(n.id, n)
        return m
      }
      return new Map()
    })()

    const layerStats = {}
    for (const lvl of CONCEPT_LEVELS) {
      layerStats[lvl] = { count: 0, totalActivation: 0, avgActivation: 0 }
    }

    const outNodes = []
    const outEdges = []
    const seenEdges = new Set()

    for (const node of map.values()) {
      // C-1.4：3D 可视化跳过软删除节点（deletedAt != null）
      if (node.deletedAt != null) continue
      const lvl = node.level ?? 'semantic'
      outNodes.push({
        id: node.id,
        name: node.name,
        level: lvl,
        type: node.type,
        activation: node.activation,
        confidence: node.confidence,
        granularity: node.granularity,
        // C-1.4 阶段 4 新增：salience 字段
        salience: node.salience,
      })
      if (layerStats[lvl]) {
        layerStats[lvl].count++
        layerStats[lvl].totalActivation += node.activation
      }
      for (const [targetId, meta] of node.connections) {
        if (!map.has(targetId)) continue
        const target = map.get(targetId)
        // C-1.4：边也跳过软删除目标（指向被软删除的节点的连接不渲染）
        if (target.deletedAt != null) continue
        const targetLvl = target.level ?? 'semantic'
        // 去重：保留单向记一次，按 id 字典序较小的为 source
        const edgeKey = node.id < targetId ? `${node.id}|${targetId}` : `${targetId}|${node.id}`
        if (seenEdges.has(edgeKey)) continue
        seenEdges.add(edgeKey)
        outEdges.push({
          source: node.id,
          target: targetId,
          weight: meta.weight,
          type: meta.type,
          levelTransition: getLevelTransitionWeight(lvl, targetLvl),
        })
      }
    }

    for (const lvl of CONCEPT_LEVELS) {
      const s = layerStats[lvl]
      s.avgActivation = s.count > 0 ? s.totalActivation / s.count : 0
    }

    return { nodes: outNodes, edges: outEdges, layers: layerStats }
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
      level: this.level,
      attributes: { ...this.attributes },
      activation: this.activation,
      confidence: this.confidence,
      granularity: this.granularity,
      // C-1.2 时序激活字段
      lastActivatedAt: this.lastActivatedAt,
      activationDecayRate: this.activationDecayRate,
      activationDecayModel: this.activationDecayModel,
      // C-1.4 阶段 4：编辑 API 字段
      salience: this.salience,
      deletedAt: this.deletedAt,
      connections: this.getConnections(),
      history: this.history.map((h) => ({ ...h })),
    }
  }

  /**
   * 从普通对象恢复为 ConceptNode 实例。
   * 向后兼容：
   *   - 旧数据无 level 字段时回退到 'semantic'
   *   - 旧数据无 lastActivatedAt 时从 history[0].ts 推断（无 history 则用 Date.now()）
   *   - 旧数据无 activationDecayRate 时按 level 自动选（构造器逻辑）
   *   - 旧数据无 salience 字段时回退 = confidence（构造器逻辑，保证 demo / 旧快照可用）
   *   - 旧数据无 deletedAt 字段时回退 = null（视为未删除）
   * @param {object} data
   * @returns {ConceptNode}
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') throw new TypeError('fromJSON 需要对象')
    // 推断 lastActivatedAt：优先 data.lastActivatedAt，否则 history[0].ts，否则 Date.now()
    let inferredLastActivatedAt = data.lastActivatedAt
    if (typeof inferredLastActivatedAt !== 'number' && Array.isArray(data.history) && data.history.length > 0) {
      inferredLastActivatedAt = data.history[0].ts
    }
    if (typeof inferredLastActivatedAt !== 'number') {
      inferredLastActivatedAt = Date.now()
    }
    const node = new ConceptNode({
      id: data.id,
      name: data.name,
      type: data.type,
      level: data.level ?? 'semantic',
      attributes: data.attributes,
      activation: data.activation,
      confidence: data.confidence,
      granularity: data.granularity,
      lastActivatedAt: inferredLastActivatedAt,
      activationDecayRate: data.activationDecayRate,
      activationDecayModel: data.activationDecayModel,
      // C-1.4：salience / deletedAt 字段
      salience: typeof data.salience === 'number' ? data.salience : undefined,
      deletedAt: typeof data.deletedAt === 'number' ? data.deletedAt : null,
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