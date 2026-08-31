/**
 * 数据采集引擎 —— 定时调度器 (scheduler.js)
 *
 * 轻量定时调度：按 intervalMs 周期性执行 job，具备以下安全机制：
 *   - 防重入：上一轮未结束时跳过本轮，避免任务堆积；
 *   - job 异常不抛出，交由 onError 回调，保证定时器不中断；
 *   - start(immediate) / stop() 可控启停。
 */

export class Scheduler {
  /**
   * @param {object} options
   * @param {number} [options.intervalMs] 周期间隔（毫秒）
   * @param {Function} [options.job]      async 任务函数
   * @param {Function} [options.onError]  任务异常回调 (err) => void
   */
  constructor({ intervalMs = 60000, job = null, onError = null } = {}) {
    this.intervalMs = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 60000
    this.job = job ?? null
    this.onError = onError ?? null
    this._timer = null
    this._busy = false
  }

  /** 是否正在运行。 */
  isRunning() {
    return this._timer != null
  }

  /**
   * 启动调度。
   * @param {boolean} [immediate] 是否立即先执行一次
   * @returns {this}
   */
  start(immediate = false) {
    if (this._timer) return this
    if (immediate) this._run()
    this._timer = setInterval(() => this._run(), this.intervalMs)
    // 避免主动句柄阻止进程退出（定时器不阻止，交由 stop 显式清理）
    if (typeof this._timer.unref === 'function') this._timer.unref()
    return this
  }

  /** 停止调度。 */
  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    return this
  }

  /** 立即手动执行一次（若上一轮仍在运行则跳过）。 */
  runNow() {
    return this._run()
  }

  async _run() {
    if (this._busy) return
    if (!this.job) return
    this._busy = true
    try {
      await this.job()
    } catch (err) {
      if (this.onError) {
        try { this.onError(err) } catch { /* 忽略 onError 自身异常 */ }
      }
    } finally {
      this._busy = false
    }
  }
}