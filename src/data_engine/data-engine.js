/**
 * 数据采集引擎 —— 编排主类 (data-engine.js)
 *
 * 定时抓取「权威新闻 + 全市场行情」，归一化后做异动监控，并通过 onData 回调输出统一数据。
 * 安全机制与其余模块一致：
 *   - 各数据源 fetch 均用 Promise.allSettled 隔离，单源失败不影响整体；
 *   - 归一化对非法数据逐个容错丢弃；
 *   - 紧急终止 abort()/clearAbort()/_guard()；
 *   - 数量上限（maxNews/maxQuotes）防止异常数据源撑爆内存。
 */

import { Scheduler } from './scheduler.js'
import { normalizeNews, normalizeQuote, dedupeQuotes, dedupeNews, dedupeBySymbol } from './normalizer.js'
import { AbnormalScanner } from './abnormal-scanner.js'

export class DataEngine {
  /**
   * @param {object} [options]
   * @param {Array} [options.newsSources]  新闻源列表
   * @param {Array} [options.quoteSources] 行情源列表
   * @param {AbnormalScanner|null} [options.scanner] 异动扫描器（缺省新建）
   * @param {number} [options.intervalMs]  定时抓取间隔
   * @param {number} [options.maxNews]
   * @param {number} [options.maxQuotes]
   * @param {Function} [options.onData]      (payload) => void，每轮抓取后回调
   * @param {Function} [options.onError]     (err) => void
   */
  constructor({
    newsSources = [],
    quoteSources = [],
    financialSources = [],
    fundFlowSources = [],
    scanner = null,
    intervalMs = 60000,
    maxNews = 1000,
    maxQuotes = 5000,
    onData = null,
    onError = null,
  } = {}) {
    this.newsSources = Array.isArray(newsSources) ? newsSources : []
    this.quoteSources = Array.isArray(quoteSources) ? quoteSources : []
    this.financialSources = Array.isArray(financialSources) ? financialSources : []
    this.fundFlowSources = Array.isArray(fundFlowSources) ? fundFlowSources : []
    this.scanner = scanner ?? new AbnormalScanner()
    this.intervalMs = intervalMs
    this.maxNews = maxNews
    this.maxQuotes = maxQuotes
    this.onData = onData ?? null
    this.onError = onError ?? null
    this._aborted = false
    this.lastPayload = null

    this.scheduler = new Scheduler({
      intervalMs: this.intervalMs,
      job: () => this.collectOnce(),
      onError: (err) => this._handleError(err),
    })
  }

  // ---------------------------------------------------------------------------
  // 安全机制
  // ---------------------------------------------------------------------------

  abort() {
    this._aborted = true
    this.scheduler.stop()
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
      const err = new Error('DataEngine 已紧急终止，操作被拒绝')
      err.code = 'ABORTED'
      throw err
    }
  }

  _handleError(err) {
    if (this.onError) {
      try { this.onError(err) } catch { /* 忽略 */ }
    }
  }

  // ---------------------------------------------------------------------------
  // 抓取流水线
  // ---------------------------------------------------------------------------

  /**
   * 执行一轮抓取：新闻 + 行情并行抓取 → 归一化 → 异动扫描 → 输出。
   * @returns {Promise<object>} payload
   */
  async collectOnce() {
    this._guard()

    const [newsRaw, quoteRaw, financialRaw, fundFlowRaw] = await Promise.all([
      this._fetchAll(this.newsSources),
      this._fetchAll(this.quoteSources),
      this._fetchAll(this.financialSources),
      this._fetchAll(this.fundFlowSources),
    ])

    const news = dedupeNews(
      newsRaw.map(normalizeNews).filter(Boolean),
    ).slice(0, this.maxNews)

    const quotes = dedupeQuotes(
      quoteRaw.map(normalizeQuote).filter(Boolean),
    ).slice(0, this.maxQuotes)

    const financials = dedupeBySymbol(financialRaw).slice(0, this.maxQuotes)
    const fundFlows = dedupeBySymbol(fundFlowRaw).slice(0, this.maxQuotes)

    const abnormal = this.scanner ? this.scanner.scan(quotes) : []

    const payload = {
      ts: Date.now(),
      news,
      quotes,
      financials,
      fundFlows,
      newsCount: news.length,
      quoteCount: quotes.length,
      financialCount: financials.length,
      fundFlowCount: fundFlows.length,
      abnormalCount: abnormal.length,
      abnormal,
    }

    this.lastPayload = payload
    if (this.onData) {
      try { this.onData(payload) } catch (err) { this._handleError(err) }
    }
    return payload
  }

  async _fetchAll(sources) {
    const results = await Promise.allSettled(
      sources.map((s) => {
        try {
          return Promise.resolve(s.fetch())
        } catch (err) {
          return Promise.reject(err)
        }
      }),
    )

    const out = []
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        out.push(...r.value)
      } else if (r.status === 'rejected') {
        this._handleError(r.reason)
      }
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // 定时调度
  // ---------------------------------------------------------------------------

  /** 启动定时抓取。 */
  start(immediate = true) {
    this._guard()
    this.scheduler.start(immediate)
    return this
  }

  /** 停止定时抓取。 */
  stop() {
    this.scheduler.stop()
    return this
  }

  /** 立即手动抓取一轮。 */
  runNow() {
    return this.scheduler.runNow()
  }

  /** 是否在运行（定时循环）。 */
  isRunning() {
    return this.scheduler.isRunning()
  }
}