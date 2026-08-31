/**
 * 数据采集引擎 —— 统一导出入口
 *
 * 定时抓取权威新闻 + 全市场行情 → 归一化 → 异动监控 → 输出统一数据。
 * 后续通过 onData 将结果灌入 MarketSnapshot 分发给分析师团队。
 */

export { US_TOP, CN_TOP, buildWatchlist } from './watchlist.js'
export { normalizeNews, normalizeQuote, dedupeQuotes, dedupeNews } from './normalizer.js'
export { NewsSource, MockNewsSource, AUTHORITATIVE_SOURCES, DEFAULT_NEWS_POOL, createMockNewsSources } from './news-source.js'
export { QuoteSource, MockQuoteSource } from './quote-source.js'
export { AbnormalScanner } from './abnormal-scanner.js'
export { Scheduler } from './scheduler.js'
export { DataEngine } from './data-engine.js'
export {
  SESSIONS,
  TIMEZONES,
  minutesInTimeZone,
  sessionLabel,
  isActive,
  getSessionState,
  nextUpdateDelayMs,
  nextUpdateDelay,
} from './market-calendar.js'
export { MarketAwareScheduler } from './market-aware-scheduler.js'
export {
  inferMarket,
  analyzeMarketNews,
  marketFearGreed,
  SnapshotBuilder,
} from './snapshot-builder.js'
export { AnalysisPipeline } from './analysis-pipeline.js'