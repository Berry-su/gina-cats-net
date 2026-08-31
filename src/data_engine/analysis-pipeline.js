/**
 * 数据采集引擎 —— 分析流水线 (analysis-pipeline.js)
 *
 * 打通「采集结果 → MarketSnapshot → 分析师团队 → Gina 整合 → 授权闸门」的完整数据流：
 *   1) DataEngine 采集（新闻 + 行情 + 异动）；
 *   2) SnapshotBuilder 映射为多标的市场快照；
 *   3) Integrator（内部驱动 AnalystTeam）逐标的整合出建议；
 *   4) 通过 onReport 回调产出（快照 + 建议 + 是否需授权）。
 *
 * 可选按 market（US/CN）过滤，便于与 MarketAwareScheduler 分区域调度衔接：
 *   美国 job -> pipeline.run({ market: 'US' })，中国 job -> pipeline.run({ market: 'CN' })。
 */

import { Scheduler } from './scheduler.js'
import { SnapshotBuilder } from './snapshot-builder.js'

export class AnalysisPipeline {
  /**
   * @param {object} options
   * @param {import('./data-engine.js').DataEngine} [options.dataEngine]
   * @param {SnapshotBuilder} [options.snapshotBuilder]
   * @param {import('../analysts/integrator.js').Integrator} [options.integrator]
   * @param {number} [options.maxSymbols]
   * @param {Function} [options.onReport]  (reports) => void
   * @param {Function} [options.onError]
   */
  constructor({
    dataEngine = null,
    snapshotBuilder = null,
    integrator = null,
    maxSymbols = 20,
    onReport = null,
    onError = null,
  } = {}) {
    this.dataEngine = dataEngine
    this.snapshotBuilder = snapshotBuilder ?? new SnapshotBuilder({ maxSymbols })
    this.integrator = integrator ?? null
    this.onReport = onReport ?? null
    this.onError = onError ?? null
    this.scheduler = null
    this.lastReports = []
  }

  /**
   * 执行一轮完整数据流。
   * @param {object} [options]
   * @param {string|null} [options.market] 仅分析 US 或 CN 市场的标的
   * @returns {Promise<{payload:object, snapshots:Array, reports:Array}>}
   */
  async run({ market = null } = {}) {
    if (!this.dataEngine) {
      throw new Error('AnalysisPipeline 缺少 dataEngine')
    }
    const payload = await this.dataEngine.collectOnce()
    const snapshots = this.snapshotBuilder.buildSnapshots(payload, {
      market,
      maxSymbols: this.snapshotBuilder.maxSymbols,
    })

    const reports = []
    for (const snap of snapshots) {
      if (!this.integrator) {
        reports.push({ symbol: snap.symbol, snapshot: snap, recommendation: null })
        continue
      }
      try {
        const recommendation = this.integrator.integrate(snap)
        reports.push({ symbol: snap.symbol, snapshot: snap, recommendation })
      } catch (err) {
        reports.push({ symbol: snap.symbol, snapshot: snap, recommendation: null, error: err.message })
        this._handleError(err)
      }
    }

    this.lastReports = reports
    if (this.onReport) {
      try { this.onReport(reports) } catch (err) { this._handleError(err) }
    }
    return { payload, snapshots, reports }
  }

  /**
   * 启动定时循环（简单周期；分区域请配合 MarketAwareScheduler 分别调用 run 的 us/cn job）。
   * @param {number} [intervalMs]
   * @returns {this}
   */
  start(intervalMs = 60000) {
    if (this.scheduler) this.scheduler.stop()
    this.scheduler = new Scheduler({
      intervalMs,
      job: () => this.run(),
      onError: (err) => this._handleError(err),
    })
    this.scheduler.start(true)
    return this
  }

  stop() {
    this.scheduler?.stop()
    return this
  }

  _handleError(err) {
    if (this.onError) {
      try { this.onError(err) } catch { /* 忽略 */ }
    }
  }
}