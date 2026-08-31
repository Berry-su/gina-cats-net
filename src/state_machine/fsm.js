/**
 * 状态机模块 —— 有限状态机 (FSM)
 *
 * FSM 提供状态机的基础能力：
 *   - 状态注册（State）与迁移表（Transition）管理；
 *   - 迁移查找：当前状态 + 事件 → 唯一迁移；
 *   - 迁移执行顺序：guard 校验 → 退出旧状态 onExit → 迁移 action → 进入新状态 onEntry；
 *   - 迁移历史记录与「振荡检测」（识别 A→B→A→B 往返循环并阻断）；
 *   - 可扩展：`_applyTransition` 为受保护方法，供 HSM 覆盖实现层次级联。
 *
 * 说明：状态定义通常包含函数（onEntry/onExit/action），故不提供 JSON 持久化；
 * 运行时位置可通过 `getSnapshot()` 导出审计。
 */

import { State } from './state.js'
import { Transition } from './transition.js'

export class FSM {
  /**
   * @param {object} [options]
   * @param {string|null} [options.initialState]   初始状态 id
   * @param {number} [options.oscillationWindow]   振荡检测的历史窗口长度（默认 3）
   */
  constructor({ initialState = null, oscillationWindow = 3 } = {}) {
    /** @type {Map<string, State>} */
    this.states = new Map()
    /** @type {Map<string, Transition>} key = `${from}:${event}` */
    this.transitions = new Map()
    this.currentState = null
    this.initialState = initialState
    this.oscillationWindow = oscillationWindow
    /** @type {Array<{from:string, to:string, event:string, timestamp:number}>} */
    this.history = []
    this.transitionCount = 0
  }

  // ---------------------------------------------------------------------------
  // 状态 / 迁移注册
  // ---------------------------------------------------------------------------

  /**
   * 添加状态。
   * @param {State|object} state
   * @returns {State}
   */
  addState(state) {
    const s = state instanceof State ? state : new State(state)
    this.states.set(s.id, s)
    return s
  }

  /**
   * 获取状态。
   * @param {string} id
   * @returns {State|undefined}
   */
  getState(id) {
    return this.states.get(id)
  }

  /**
   * 添加迁移。
   * @param {Transition|object} transition
   * @returns {Transition}
   */
  addTransition(transition) {
    const t = transition instanceof Transition ? transition : new Transition(transition)
    this.transitions.set(`${t.from}:${t.event}`, t)
    return t
  }

  /**
   * 查找迁移。
   * @param {string} from
   * @param {string} event
   * @returns {Transition|undefined}
   */
  getTransition(from, event) {
    return this.transitions.get(`${from}:${event}`)
  }

  // ---------------------------------------------------------------------------
  // 运行时
  // ---------------------------------------------------------------------------

  /**
   * 启动：进入初始状态（触发其 onEntry）。
   * @param {object} [context]
   * @returns {this}
   */
  start(context = {}) {
    if (!this.initialState) throw new Error('未设置初始状态，无法启动')
    const initial = this.getState(this.initialState)
    if (!initial) throw new Error(`初始状态不存在: ${this.initialState}`)
    this.currentState = this.initialState
    this._enterState(initial, context)
    return this
  }

  /** 当前状态 id。 */
  getCurrentStateId() {
    return this.currentState
  }

  /** 当前状态对象。 */
  getCurrentState() {
    return this.currentState ? this.getState(this.currentState) : null
  }

  /** 迁移历史（只读副本）。 */
  getHistory() {
    return this.history.map((h) => ({ ...h }))
  }

  /**
   * 查询当前状态下某事件是否可迁移（仅校验迁移存在与守卫，不做振荡检测）。
   * @param {string} event
   * @param {object} [context]
   * @returns {boolean}
   */
  canTransition(event, context = {}) {
    const t = this.getTransition(this.currentState, event)
    return !!t && t.isAllowed(context)
  }

  /**
   * 执行迁移。
   * @param {string} event
   * @param {object} [context]
   * @returns {{ok:boolean, from?:string, to?:string, event?:string, reason?:string, error?:string}}
   */
  transition(event, context = {}) {
    if (this.currentState === null) {
      return { ok: false, reason: 'not-started' }
    }

    const t = this.getTransition(this.currentState, event)
    if (!t) {
      return { ok: false, reason: 'no-transition', from: this.currentState, event }
    }

    if (!t.isAllowed(context)) {
      return { ok: false, reason: 'guard-rejected', from: t.from, to: t.to, event }
    }

    if (this._detectOscillation(t.from, t.to)) {
      return { ok: false, reason: 'oscillation', from: t.from, to: t.to, event }
    }

    const resolvedTo = this._resolveTarget(t.to)

    try {
      const source = this.getState(t.from)
      const target = this.getState(resolvedTo)
      if (!source || !target) {
        return { ok: false, reason: 'missing-state', from: t.from, to: resolvedTo, event }
      }
      this._applyTransition(t, context)
    } catch (err) {
      // 动作副作用异常不切换状态，异常不外泄，交由调用方按 reason 处理
      return { ok: false, reason: 'error', from: t.from, to: resolvedTo, event, error: err.message }
    }

    this.currentState = resolvedTo
    this.transitionCount += 1
    this.history.push({ from: t.from, to: resolvedTo, event, timestamp: Date.now() })
    return { ok: true, from: t.from, to: resolvedTo, event }
  }

  /**
   * 复位回初始状态（清除历史与计数）。
   * @param {object} [context]
   * @returns {this}
   */
  reset(context = {}) {
    this.history = []
    this.transitionCount = 0
    this.currentState = null
    if (this.initialState) {
      this.currentState = this.initialState
      this._enterState(this.getState(this.initialState), context)
    }
    return this
  }

  /** 运行时位置快照（审计用）。 */
  getSnapshot() {
    return {
      currentState: this.currentState,
      transitionCount: this.transitionCount,
      history: this.getHistory(),
    }
  }

  // ---------------------------------------------------------------------------
  // 受保护的执行钩子（HSM 覆盖以支持层次级联）
  // ---------------------------------------------------------------------------

  /**
   * 执行一次迁移的副作用：退出源 → 迁移动作 → 进入目标。
   * @param {Transition} t
   * @param {object} context
   */
  _applyTransition(t, context) {
    const source = this.getState(t.from)
    const target = this.getState(t.to)
    this._exitState(source, context)
    if (t.action) t.action(context)
    this._enterState(target, context)
  }

  /**
   * 解析迁移目标（FSM 恒等返回；HSM 覆盖以解析 history 伪状态）。
   * @param {string} targetId
   * @returns {string}
   */
  _resolveTarget(targetId) {
    return targetId
  }

  /** 退出状态（触发 onExit）。 */
  _exitState(state, context) {
    if (state?.onExit) state.onExit(context)
  }

  /** 进入状态（触发 onEntry）。 */
  _enterState(state, context) {
    if (state?.onEntry) state.onEntry(context)
  }

  // ---------------------------------------------------------------------------
  // 振荡检测
  // ---------------------------------------------------------------------------

  /**
   * 检测是否形成 A→B→A→B 往返振荡。
   * 条件：最近 3 次迁移恰为 to→from, from→to, to→from，本次再迁 from→to 即形成循环。
   * @param {string} from
   * @param {string} to
   * @returns {boolean}
   */
  _detectOscillation(from, to) {
    const tail = this.history.slice(-this.oscillationWindow)
    if (tail.length < this.oscillationWindow) return false
    return (
      tail[0].from === to && tail[0].to === from &&
      tail[1].from === from && tail[1].to === to &&
      tail[2].from === to && tail[2].to === from
    )
  }
}