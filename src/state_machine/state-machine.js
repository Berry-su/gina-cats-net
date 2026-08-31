/**
 * 状态机模块 —— 主类 (StateMachine)
 *
 * StateMachine 是面向业务的统一入口，继承 HSM，在完整状态机能力之上叠加：
 *   - 迁移超时保护（timeoutMs）：检测单次迁移耗时，超时即紧急终止，防止失控；
 *   - 紧急终止：abort() / clearAbort() / isAborted() + _guard()；
 *   - 可选集成（依赖方向单向 state_machine → cats_net / memory，构造注入）：
 *       * memoryManager：迁移成功后写入工作记忆，供后续决策；
 *       * catsNet：迁移后激活已存在的目标状态概念（不在抽象空间则跳过）。
 *   未注入任何外部模块时降级为纯状态机运行。
 */

import { HSM } from './hsm.js'

export class StateMachine extends HSM {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]        单次迁移耗时上限（毫秒，0 表示不限制）
   * @param {object|null} [options.catsNet]     CATS-Net 实例（可选）
   * @param {object|null} [options.memoryManager] 记忆管理器实例（可选）
   * @param {...object} options                  其余透传给 HSM/FSM（如 initialState）
   */
  constructor({ timeoutMs = 1000, catsNet = null, memoryManager = null, ...options } = {}) {
    super(options)
    this.timeoutMs = timeoutMs
    this.catsNet = catsNet ?? null
    this.memoryManager = memoryManager ?? null
    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 安全机制
  // ---------------------------------------------------------------------------

  /** 紧急终止。 */
  abort() {
    this._aborted = true
    return this
  }

  /** 解除终止。 */
  clearAbort() {
    this._aborted = false
    return this
  }

  /** 是否已终止。 */
  isAborted() {
    return this._aborted
  }

  _guard() {
    if (this._aborted) {
      const err = new Error('StateMachine 已紧急终止，迁移被拒绝')
      err.code = 'ABORTED'
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // 覆盖迁移：安全闸门 + 超时 + 集成
  // ---------------------------------------------------------------------------

  /**
   * 执行迁移（含安全闸门、超时保护与外部集成）。
   * @param {string} event
   * @param {object} [context]
   * @returns {object} 与 FSM.transition 相同的结结果，额外可含 timedOut
   */
  transition(event, context = {}) {
    this._guard()
    const startedAt = Date.now()

    const result = super.transition(event, context)

    const elapsed = Date.now() - startedAt
    if (this.timeoutMs > 0 && elapsed > this.timeoutMs) {
      result.timedOut = true
      // 超时保护：置位紧急终止，阻断后续迁移，防止 Agent 失控
      this.abort()
    }

    this._integrate(result, context)
    return result
  }

  // ---------------------------------------------------------------------------
  // 外部集成
  // ---------------------------------------------------------------------------

  /** 迁移成功后的集成动作（可选，全部 try/catch 降级）。 */
  _integrate(result, context) {
    if (!result.ok) return

    // 写入记忆系统（降权 + 来源打标 + 目标 abort 检查）
    if (this.memoryManager && typeof this.memoryManager.addObservation === 'function') {
      if (typeof this.memoryManager.isAborted === 'function' && this.memoryManager.isAborted()) {
        console.log(`[state] 记忆集成跳过: memoryManager 已 abort，迁移 ${result.from}->${result.to} 未写入`)
      } else {
        try {
          this.memoryManager.addObservation({
            content: `状态迁移 ${result.from} -> ${result.to}（事件 ${result.event}）`,
            concepts: [result.from, result.to],
            source: 'state',
            importance: 0.3,
          })
          console.log(`[state] 记忆集成完成: ${result.from}->${result.to} source=state importance=0.30`)
        } catch (err) {
          console.log(`[state] 记忆集成失败(降级): ${result.from}->${result.to} 原因=${err.message}`)
        }
      }
    }

    // 激活抽象空间中的目标状态概念（目标 abort 检查）
    if (this.catsNet && typeof this.catsNet.activate === 'function') {
      if (typeof this.catsNet.isAborted === 'function' && this.catsNet.isAborted()) {
        console.log(`[state] 概念集成跳过: catsNet 已 abort，状态 ${result.to} 未激活`)
      } else {
        try {
          if (typeof this.catsNet.getNode === 'function' && this.catsNet.getNode(result.to)) {
            this.catsNet.activate(result.to, 0.2)
            console.log(`[state] 概念激活: ${result.to} (+0.20)`)
          } else {
            console.log(`[state] 概念激活跳过: ${result.to} 不在抽象空间中`)
          }
        } catch (err) {
          console.log(`[state] 概念激活失败(降级): ${result.to} 原因=${err.message}`)
        }
      }
    }
  }
}