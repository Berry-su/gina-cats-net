/**
 * 状态机模块 —— 层次状态机 (HSM)
 *
 * HSM 在 FSM 基础上新增「父子状态层次」，实现：
 *   - 级联进入/退出：迁移时按最低共同祖先(LCA)切分，退出旧链、进入新链，
 *     使父状态的 onEntry/onExit 随子状态切换正确级联触发；
 *   - history 伪状态：迁移目标可为 `hist:<parentId>`，解析为该父状态最近活动的子状态，
 *     实现「回到上次离开的位置」；未记录时回退到注册时指定的初始子状态。
 *
 * 父状态关系通过 State.parent 描述；history 通过 registerHistory() 注册。
 */

import { FSM } from './fsm.js'

const HISTORY_PREFIX = 'hist:'

export class HSM extends FSM {
  constructor(options = {}) {
    super(options)
    /** 父状态 -> 最近活动的子状态 id */
    this.stateHistory = new Map()
    /** history 伪状态 id -> 回退子状态 id */
    this.historyFallback = new Map()
  }

  /**
   * 设置状态父子关系。
   * @param {string} childId
   * @param {string} parentId
   * @returns {this}
   */
  setParent(childId, parentId) {
    const child = this.getState(childId)
    if (!child) throw new Error(`子状态不存在: ${childId}`)
    if (parentId !== null && !this.getState(parentId)) throw new Error(`父状态不存在: ${parentId}`)
    child.parent = parentId
    return this
  }

  /**
   * 注册 history 伪状态并返回其 id（供迁移目标 to 使用）。
   * @param {string} parentId 父状态 id
   * @param {string} fallbackChildId 无历史记录时回退的初始子状态
   * @returns {string} history 伪状态 id
   */
  registerHistory(parentId, fallbackChildId) {
    if (!this.getState(parentId)) throw new Error(`父状态不存在: ${parentId}`)
    const histId = `${HISTORY_PREFIX}${parentId}`
    this.historyFallback.set(histId, fallbackChildId)
    return histId
  }

  // ---------------------------------------------------------------------------
  // 覆盖：目标解析 / 启动 / 迁移副作用
  // ---------------------------------------------------------------------------

  /** 解析 history 伪状态为最近活动子状态（或回退初始子状态）。 */
  _resolveTarget(targetId) {
    if (typeof targetId === 'string' && this.historyFallback.has(targetId)) {
      const parentId = targetId.slice(HISTORY_PREFIX.length)
      return this.stateHistory.get(parentId) ?? this.historyFallback.get(targetId)
    }
    return targetId
  }

  /** 覆盖启动：级联进入初始状态的所有祖先。 */
  start(context = {}) {
    if (!this.initialState) throw new Error('未设置初始状态，无法启动')
    if (!this.getState(this.initialState)) throw new Error(`初始状态不存在: ${this.initialState}`)
    this.currentState = this.initialState
    this._enterChain(this.initialState, context)
    return this
  }

  /** 覆盖复位：清除历史/计数并级联进入初始状态。 */
  reset(context = {}) {
    this.history = []
    this.transitionCount = 0
    this.stateHistory = new Map()
    this.currentState = null
    if (this.initialState) {
      this.currentState = this.initialState
      this._enterChain(this.initialState, context)
    }
    return this
  }

  /**
   * 覆盖迁移副作用：按 LCA 切分，级联退出旧链、进入新链。
   * 同时在退出/进入时维护父状态的 history 记录。
   */
  _applyTransition(t, context) {
    const fromId = t.from
    const resolvedTo = this._resolveTarget(t.to)

    const fromState = this.getState(fromId)
    const toState = this.getState(resolvedTo)
    if (!fromState || !toState) throw new Error(`迁移端点状态缺失: ${fromId} -> ${resolvedTo}`)

    // 退出前记录：from 的父状态最近活动子 = from
    if (fromState.parent) this.stateHistory.set(fromState.parent, fromId)

    const fromChain = this._ancestors(fromId)
    const toChain = this._ancestors(resolvedTo)
    const lcaId = this._lca(fromChain, toChain)

    // 级联退出：从 from 向上到 LCA（不含 LCA），深 → 浅
    const fromLcaIndex = fromChain.indexOf(lcaId)
    for (let i = fromChain.length - 1; i > fromLcaIndex; i--) {
      const s = this.getState(fromChain[i])
      if (s?.onExit) s.onExit(context)
    }

    // 迁移动作
    if (t.action) t.action(context)

    // 级联进入：从 LCA 下一层到 to（含 to），浅 → 深
    const toLcaIndex = toChain.indexOf(lcaId)
    for (let i = toLcaIndex + 1; i < toChain.length; i++) {
      const s = this.getState(toChain[i])
      if (s?.onEntry) s.onEntry(context)
    }

    // 进入后记录：to 的父状态最近活动子 = to
    if (toState.parent) this.stateHistory.set(toState.parent, resolvedTo)
  }

  // ---------------------------------------------------------------------------
  // 层次工具
  // ---------------------------------------------------------------------------

  /** 返回从根到指定状态的祖先链（含自身）。 */
  _ancestors(id) {
    const chain = []
    let cur = this.getState(id)
    while (cur) {
      chain.unshift(cur.id)
      cur = cur.parent ? this.getState(cur.parent) : null
    }
    return chain
  }

  /** 两条祖先链的最低共同祖先 id（无共同前缀则返回 null）。 */
  _lca(chainA, chainB) {
    let lca = null
    const min = Math.min(chainA.length, chainB.length)
    for (let i = 0; i < min; i++) {
      if (chainA[i] === chainB[i]) lca = chainA[i]
      else break
    }
    return lca
  }

  /** 级联进入一条祖先链（从根到目标）。 */
  _enterChain(stateId, context) {
    for (const id of this._ancestors(stateId)) {
      const s = this.getState(id)
      if (s?.onEntry) s.onEntry(context)
    }
  }
}