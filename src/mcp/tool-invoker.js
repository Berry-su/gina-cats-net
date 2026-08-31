/**
 * MCP 工具调度模块 —— 工具调用器 (ToolInvoker)
 *
 * 负责安全地执行异步工具调用，内置三层防护：
 *   1) 调用超时：单次调用使用 Promise.race 与 setTimeout 实现独立超时，
 *      避免某个工具卡死拖垮整个 Agent；
 *   2) 重试：调用失败（抛异常 / 超时）可按配置重试；
 *   3) 熔断器（circuit breaker）：连续失败达到阈值后自动「断开」，
 *      拒绝后续调用，防止对故障工具恶性反复调用；经恢复窗口后进入
 *      half-open 试探，成功则闭合恢复。
 *
 * 所有调用路径正确处理 Promise 拒绝，拒绝不会以未捕获异常逃逸。
 */

/** 熔断器三态。 */
export const BREAKER_STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
})

export class ToolInvoker {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]         单次调用超时（毫秒，0 表示不限制）
   * @param {number} [options.retries]           失败重试次数（0 表示不重试）
   * @param {number} [options.failureThreshold]  连续失败多少次后熔断断开
   * @param {number} [options.recoveryTimeout]   熔断断开后的恢复窗口（毫秒）
   */
  constructor({
    timeoutMs = 5000,
    retries = 1,
    failureThreshold = 3,
    recoveryTimeout = 30000,
  } = {}) {
    this.timeoutMs = timeoutMs
    this.retries = retries
    this.failureThreshold = failureThreshold
    this.recoveryTimeout = recoveryTimeout
    /** @type {Map<string, {state:string, failures:number, openedAt:number|null}>} */
    this.breakers = new Map()
  }

  /**
   * 执行一次完整调用（含熔断检查 + 重试 + 超时）。
   * @param {import('./tool-registry.js').Tool} tool
   * @param {object} args
   * @param {object} [context]
   * @returns {Promise<{ok:boolean, result?:*, reason?:string, error?:string, tool:string}>}
   */
  async invoke(tool, args = {}, context = {}) {
    const name = tool.name

    // 1) 熔断检查
    const check = this._checkBreaker(name)
    if (!check.allowed) {
      return { ok: false, reason: check.reason, tool: name }
    }

    // 2) 执行（含重试）
    let lastError = null
    const attempts = Math.max(0, this.retries) + 1
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await this._invokeOnce(tool, args, context)
        this._recordResult(name, true)
        return { ok: true, result, tool: name }
      } catch (err) {
        lastError = err
        // 进入下一轮重试
      }
    }

    // 3) 全部尝试失败
    this._recordResult(name, false)
    return { ok: false, reason: 'error', error: lastError?.message ?? '工具调用失败', tool: name }
  }

  /** 查询某工具的熔断器状态。 */
  getBreakerState(name) {
    return this.breakers.get(name) ? { ...this.breakers.get(name) } : null
  }

  /** 重置某工具的熔断器（闭合）。 */
  resetBreaker(name) {
    this.breakers.set(name, { state: BREAKER_STATE.CLOSED, failures: 0, openedAt: null })
  }

  /** 清空全部熔断器。 */
  resetAllBreakers() {
    this.breakers = new Map()
  }

  // ---------------------------------------------------------------------------
  // 私有
  // ---------------------------------------------------------------------------

  /** 单次调用（含超时），成功返回结果，失败/超时抛异常。 */
  async _invokeOnce(tool, args, context) {
    // 用 async IIFE 包装，确保 handler 同步 throw 也被捕获为 rejection
    const promise = (async () => tool.handler(args, context))()

    if (this.timeoutMs <= 0) {
      return await promise
    }

    let timer = null
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`工具 ${tool.name} 调用超时 (${this.timeoutMs}ms)`))
      }, this.timeoutMs)
    })

    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      clearTimeout(timer)
    }
  }

  /** 熔断检查：返回 { allowed, state, reason? }。 */
  _checkBreaker(name) {
    let b = this.breakers.get(name)
    if (!b) {
      return { allowed: true, state: BREAKER_STATE.CLOSED }
    }
    if (b.state === BREAKER_STATE.OPEN) {
      const elapsed = Date.now() - (b.openedAt ?? 0)
      if (elapsed >= this.recoveryTimeout) {
        b.state = BREAKER_STATE.HALF_OPEN // 恢复窗口到，允许试探一次
        return { allowed: true, state: BREAKER_STATE.HALF_OPEN }
      }
      return { allowed: false, state: BREAKER_STATE.OPEN, reason: 'breaker-open' }
    }
    // closed / half-open 均允许调用
    return { allowed: true, state: b.state }
  }

  /** 根据调用结果更新熔断器。 */
  _recordResult(name, ok) {
    let b = this.breakers.get(name)
    if (!b) {
      b = { state: BREAKER_STATE.CLOSED, failures: 0, openedAt: null }
      this.breakers.set(name, b)
    }
    if (ok) {
      b.failures = 0
      b.state = BREAKER_STATE.CLOSED
      b.openedAt = null
    } else {
      b.failures += 1
      // half-open 试探失败，立即重新断开
      if (b.state === BREAKER_STATE.HALF_OPEN || b.failures >= this.failureThreshold) {
        b.state = BREAKER_STATE.OPEN
        b.openedAt = Date.now()
      }
    }
  }
}