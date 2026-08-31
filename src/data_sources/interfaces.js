/**
 * 真实数据源 —— 富化数据源接口 (interfaces.js)
 *
 * 行情/新闻已有 data_engine 的 QuoteSource/NewsSource 基类；这里补充两类富化数据源：
 *   - FinancialSource：财报/估值数据 → 归一化为 financial 条目（对应 MarketSnapshot.fundamental）；
 *   - FundFlowSource：资金流向数据 → 归一化为 fundFlow 条目（对应 MarketSnapshot.fundFlow）。
 *
 * 归一化条目字段定义（供 DataEngine 富化、SnapshotBuilder 映射使用）：
 *   FinancialItem: { symbol, market, pe, pb, peg, roe, revenueGrowth, profitGrowth, industryProsperity, valuationPercentile, debtRatio, reportDate }
 *   FundFlowItem:  { symbol, market, northboundNet, dragonTigerNetBuy, marginBalanceTrend, mainForceNet, turnoverRate }
 */

export class FinancialSource {
  /** 子类实现：抓取财报/估值原始数据。 */
  async fetch() {
    return []
  }
}

export class FundFlowSource {
  /** 子类实现：抓取资金流向原始数据。 */
  async fetch() {
    return []
  }
}