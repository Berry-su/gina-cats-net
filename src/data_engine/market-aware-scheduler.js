/**
 * 数据采集引擎 —— 分区域定时调度器 (market-aware-scheduler.js)
 *
 * 针对美国与中国市场的时差，分别对「美国信息」「中国信息」做交易时段感知的定时采集：
 *   - 每个区域绑定一个采集 job（如：US job 采集全球/美股信息，CN job 采集中国信息）；
 *   - start() 时，若该市场正处于活跃时段则「第一时间」立即采集，否则等到下一时段开盘；
 *   - 盘中按 intradayMinutes 定时，收盘/开盘边界自动对齐；
 *   - 安全机制：防重入、异常不中断、stop/abort 可控。
 */

import {
  nextUpdateDelayMs,
  minutesInTimeZone,
  SESSIONS,
} from './market-calendar.js'

export class MarketAwareScheduler {
  /**
   * @param {object} [options]
   * @param {Function|null} [options.us] US 采集 job（async）—— 收集美国/全球信息
   * @param {Function|null} [options.cn] CN 采集 job（async）—— 收集中国信息
   * @param {number} [options.intradayMinutes] 盘中采集间隔（分钟）
   * @param {Function} [options.onError]
   * @param {Function} [options.now]  时间提供者（测试可注入）
   */
  constructor({ us = null, cn = null, intradayMinutes = 5, onError = null, now = null } = {}) {
    this.jobs = { US: us, CN: cn }
    this.intradayMinutes = intradayMinutes
    this.onError = onError ?? null
    this._now = now ?? (() => new Date())
    this._timers = { US: null, CN: null }
    this._busy = { US: false, CN: false }
    this._stopped = false
    this._aborted = false
  }

  // ---------------------------------------------------------------------------
  // 安全机制
  // ---------------------------------------------------------------------------

  abort() {
    this._aborted = true
    this.stop()
    return this
  }

  clearAbort() {
    this._aborted = false
    return this
  }

  isAborted() {
    return this._aborted
  }

  stop() {
    this._stopped = true
    for (const r of ['US', 'CN']) {
      if (this._timers[r]) { clearTimeout(this._timers[r]); this._timers[r] = null }
    }
    return this
  }

  isRunning() {
    return !this._stopped
  }

  // ---------------------------------------------------------------------------
  // 调度
  // ---------------------------------------------------------------------------

  /** 启动：活跃市场立即采集，随后按交易时段定时。 */
  start() {
    this._aborted = false
    this._stopped = false
    for (const region of ['US', 'CN']) {
      if (!this.jobs[region]) continue
      const { minutesOfDay } = this._state(region)
      // 第一时间：当前正处于活跃时段，先立即采集
      if (this._isActive(region)) this.trigger(region)
      this._arm(region)
    }
    return this
  }

  /** 手动触发某区域立即采集（防重入）。 */
  async trigger(region) {
    const job = this.jobs[region]
    if (!job || this._busy[region]) return
    if (this._aborted || this._stopped) return
    this._busy[region] = true
    try {
      await job()
    } catch (err) {
      if (this.onError) { try { this.onError(err) } catch { /* 忽略 */ } }
    } finally {
      this._busy[region] = false
    }
  }

  /** 距今下一次采集的毫秒数（供观察/测试）。 */
  getNextDelay(region) {
    const { minutesOfDay } = this._state(region)
    return nextUpdateDelayMs(region, { minutesOfDay, intradayMinutes: this.intradayMinutes })
  }

  _arm(region) {
    if (this._stopped || this._aborted) return
    const delay = this.getNextDelay(region)
    const t = setTimeout(async () => {
      await this.trigger(region)
      this._arm(region)
    }, delay)
    if (typeof t.unref === 'function') t.unref()
    this._timers[region] = t
  }

  _state(region) {
    const now = this._now()
    const minutesOfDay = minutesInTimeZone(now, SESSIONS[region]?.timezone)
    return { now, minutesOfDay }
  }

  _isActive(region) {
    const { minutesOfDay } = this._state(region)
    const cfg = SESSIONS[region]
    return cfg?.windows.some(([s, e]) => minutesOfDay >= s && minutesOfDay < e) ?? false
  }
}