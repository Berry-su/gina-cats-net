/**
 * 真实数据源 —— 统一导出入口
 *
 * 各数据源适配器实现 data_engine 的 QuoteSource/NewsSource 或本模块的 FinancialSource/FundFlowSource，
 * 可直接注入 DataEngine；BrokerAdapter 为下单执行层（受用户授权门约束）。
 */

export { loadDataSourcesConfig, DEFAULT_CONFIG_PATH } from './config.js'
export { proxiedFetch, fetchJson } from './http-client.js'
export { FinancialSource, FundFlowSource } from './interfaces.js'
export { BrokerAdapter, TonghuashunBrokerAdapter } from './broker.js'
export {
  TUSHARE_ENDPOINT,
  buildTushareRequest,
  mapTushareRow,
  mapTushareDaily,
  mapTushareDailyBasic,
  mapTushareMoneyflow,
  TushareQuoteSource,
  TushareFinancialSource,
  TushareFundFlowSource,
} from './tushare.js'
export {
  yahooChartUrl,
  mapYahooChart,
  YahooFinanceQuoteSource,
  alpacaHeaders,
  AlpacaQuoteSource,
  secCikLookupUrl,
  secCompanyFactsUrl,
  SecEdgarFinancialSource,
} from './us-market.js'
export {
  DEFAULT_NEWS_FEEDS,
  parseRss,
  RssNewsSource,
  createRssNewsSources,
} from './rss-news.js'