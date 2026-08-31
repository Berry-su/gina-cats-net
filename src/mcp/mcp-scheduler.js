/**
 * MCP 工具调度模块 —— 主类 (MCPScheduler)
 *
 * 聚合 ToolRegistry（注册/发现/校验）与 ToolInvoker（超时/重试/熔断），
 * 提供统一的「动态调用」入口，并叠加安全机制与可选外部集成：
 *
 * 调用流程：_guard → 工具查找 → 参数校验 → invoker.invoke → 集成 → 返回。
 *
 * 安全机制（与 CATS-Net / 记忆 / 状态机一致）：
 *   - 异常容错：handler 异常 / Promise 拒绝均不外泄，统一归集到返回对象；
 *   - 失控拦截：单次超时 + 重试上限 + 熔断器，防止对故障工具恶性循环调用；
 *   - 紧急终止：abort() / clearAbort() + _guard()。
 *
 * 可选集成（依赖单向 mcp → cats_net / memory，构造注入，未注入降级）：
 *   - memoryManager：调用后写入工作记忆；
 *   - catsNet：调用后激活已存在的工具名概念；
 *   - stateMachine：预留字段，供上层将工具调用映射为状态事件（本模块不主动触发）。
 */

import { Tool, ToolRegistry } from './tool-registry.js'
import { ToolInvoker } from './tool-invoker.js'

export class MCPScheduler {
  /**
   * @param {object} [options]
   * @param {ToolRegistry} [options.registry]    自定义注册表
   * @param {ToolInvoker} [options.invoker]      自定义调用器
   * @param {object|null} [options.memoryManager] 记忆管理器（可选）
   * @param {object|null} [options.catsNet]       CATS-Net 实例（可选）
   * @param {object|null} [options.stateMachine]  状态机（预留）
   * @param {number} [options.timeoutMs]         覆写调用器超时
   * @param {number} [options.retries]           覆写调用器重试
   * @param {number} [options.failureThreshold]  覆写调用器熔断阈值
   * @param {number} [options.recoveryTimeout]   覆写调用器熔断恢复窗口
   */
  constructor({
    registry,
    invoker,
    memoryManager = null,
    catsNet = null,
    stateMachine = null,
    timeoutMs,
    retries,
    failureThreshold,
    recoveryTimeout,
  } = {}) {
    this.registry = registry ?? new ToolRegistry()
    this.invoker = invoker ?? new ToolInvoker({
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(retries !== undefined ? { retries } : {}),
      ...(failureThreshold !== undefined ? { failureThreshold } : {}),
      ...(recoveryTimeout !== undefined ? { recoveryTimeout } : {}),
    })
    this.memoryManager = memoryManager ?? null
    this.catsNet = catsNet ?? null
    this.stateMachine = stateMachine ?? null
    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 注册 / 注销 / 发现
  // ---------------------------------------------------------------------------

  /** 注册工具。 */
  register(tool) {
    return this.registry.register(tool)
  }

  /** 注销工具。 */
  unregister(name) {
    return this.registry.unregister(name)
  }

  /** 获取工具。 */
  getTool(name) {
    return this.registry.get(name)
  }

  /** 是否存在工具。 */
  hasTool(name) {
    return this.registry.has(name)
  }

  /** 列出全部工具。 */
  listTools() {
    return this.registry.list()
  }

  /**
   * 发现工具：按名称/描述/标签综合搜索。
   * @param {string} query
   * @returns {import('./tool-registry.js').Tool[]}
   */
  discover(query) {
    return this.registry.search(query)
  }

  /** 校验工具入参。 */
  validate(name, args) {
    return this.registry.validate(name, args)
  }

  // ---------------------------------------------------------------------------
  // 安全机制
  // ---------------------------------------------------------------------------

  abort() {
    this._aborted = true
    return this
  }

  clearAbort() {
    this._aborted = false
    return this
  }

  isAborted() {
    return this._aborted
  }

  _guard() {
    if (this._aborted) {
      const err = new Error('MCPScheduler 已紧急终止，调用被拒绝')
      err.code = 'ABORTED'
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // 动态调用
  // ---------------------------------------------------------------------------

  /**
   * 动态调用工具。
   * @param {string} name 工具名
   * @param {object} [args] 入参
   * @param {object} [context] 业务上下文
   * @returns {Promise<{ok:boolean, result?:*, reason?:string, error?:string, tool:string}>}
   */
  async call(name, args = {}, context = {}) {
    this._guard()

    const tool = this.registry.get(name)
    if (!tool) {
      return { ok: false, reason: 'not-found', error: `工具不存在: ${name}`, tool: name }
    }

    const validation = tool.validate(args)
    if (!validation.valid) {
      return { ok: false, reason: 'invalid-arguments', error: validation.errors.join('; '), tool: name }
    }

    const result = await this.invoker.invoke(tool, args, context)
    this._integrate(tool, args, result, context)
    return result
  }

  // ---------------------------------------------------------------------------
  // 外部集成
  // ---------------------------------------------------------------------------

  _integrate(tool, args, result, context) {
    // 记忆系统：写入调用记录（降权 + 来源打标 + 目标 abort 检查）
    if (this.memoryManager && typeof this.memoryManager.addObservation === 'function') {
      if (typeof this.memoryManager.isAborted === 'function' && this.memoryManager.isAborted()) {
        console.log(`[mcp] 记忆集成跳过: memoryManager 已 abort，工具 ${tool.name} 的调用记录未写入`)
      } else {
        try {
          this.memoryManager.addObservation({
            content: `调用工具 ${tool.name} ${result.ok ? '成功' : '失败'}`,
            concepts: [tool.name],
            tags: [...tool.tags],
            source: 'tool',
            importance: 0.3,
          })
          console.log(`[mcp] 记忆集成完成: tool=${tool.name} source=tool importance=0.30`)
        } catch (err) {
          console.log(`[mcp] 记忆集成失败(降级): tool=${tool.name} 原因=${err.message}`)
        }
      }
    }

    // 抽象空间：激活已存在的工具名概念（目标 abort 检查）
    if (this.catsNet && typeof this.catsNet.activate === 'function') {
      if (typeof this.catsNet.isAborted === 'function' && this.catsNet.isAborted()) {
        console.log(`[mcp] 概念集成跳过: catsNet 已 abort，工具 ${tool.name} 的概念未激活`)
      } else {
        try {
          if (typeof this.catsNet.getNode === 'function' && this.catsNet.getNode(tool.name)) {
            this.catsNet.activate(tool.name, 0.2)
            console.log(`[mcp] 概念激活: ${tool.name} (+0.20)`)
          } else {
            console.log(`[mcp] 概念激活跳过: ${tool.name} 不在抽象空间中`)
          }
        } catch (err) {
          console.log(`[mcp] 概念激活失败(降级): ${tool.name} 原因=${err.message}`)
        }
      }
    }

    // stateMachine 为预留集成点，本模块不主动触发状态迁移
  }
}