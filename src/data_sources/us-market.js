/**
 * 真实数据源 —— 美股行情 / 财报 (us-market.js)
 *
 * 通过 Clash Verge 翻墙访问：
 *   - Yahoo Finance：免费美股行情（无需 key）；
 *   - Alpaca：美股行情/交易（需 ALPACA_KEY / ALPACA_SECRET）；
 *   - SEC EDGAR：美股财报（免费，需带 User-Agent）。
 */

import { QuoteSource } from '../data_engine/index.js'
import { FinancialSource } from './interfaces.js'
import { fetchJson } from './http-client.js'

function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) ? null : n
}

// ---------------------------------------------------------------------------
// Yahoo Finance
// ---------------------------------------------------------------------------

export function yahooChartUrl(symbol, { range = '1d', interval = '1d' } = {}) {
  const s = encodeURIComponent(symbol)
  return `https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=${range}&interval=${interval}`
}

/** 解析 Yahoo chart 响应 → QuoteItem（归一化前）。 */
export function mapYahooChart(symbol, raw) {
  const meta = raw?.chart?.result?.[0]?.meta ?? {}
  const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose)
  const price = num(meta.regularMarketPrice)
  const changePercent = price != null && prev ? (price - prev) / prev : null
  return {
    symbol,
    name: symbol,
    market: 'US',
    price,
    prevClose: prev,
    changePercent,
    open: price,
    high: price,
    low: price,
    volume: null,
    dragonTiger: false,
    timestamp: Date.now(),
  }
}

/**
 * Yahoo 美股行情源（实现 QuoteSource）。
 */
export class YahooFinanceQuoteSource extends QuoteSource {
  constructor({ symbols = [], proxyUrl = null, userAgent = '' } = {}) {
    super()
    this.symbols = symbols
    this.proxyUrl = proxyUrl
    this.userAgent = userAgent
  }

  async fetch() {
    const out = []
    for (const symbol of this.symbols) {
      try {
        const raw = await fetchJson(yahooChartUrl(symbol), {
          proxyUrl: this.proxyUrl,
          headers: this.userAgent ? { 'User-Agent': this.userAgent } : {},
        })
        out.push(mapYahooChart(symbol, raw))
      } catch {
        // 单标的失败跳过
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Alpaca
// ---------------------------------------------------------------------------

export function alpacaHeaders(key, secret) {
  return {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
  }
}

/**
 * Alpaca 美股行情源（需 key；作为备选实现 QuoteSource）。
 */
export class AlpacaQuoteSource extends QuoteSource {
  constructor({ key = '', secret = '', symbols = [], proxyUrl = null } = {}) {
    super()
    this.key = key
    this.secret = secret
    this.symbols = symbols
    this.proxyUrl = proxyUrl
  }

  async fetch() {
    if (!this.key || !this.secret) return []
    const out = []
    for (const symbol of this.symbols) {
      try {
        const raw = await fetchJson(
          `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
          { proxyUrl: this.proxyUrl, headers: alpacaHeaders(this.key, this.secret) },
        )
        const q = raw?.quote ?? {}
        out.push({
          symbol, name: symbol, market: 'US',
          price: num(q.ap) ?? num(q.bp), prevClose: null, changePercent: null,
          open: null, high: null, low: null, dragonTiger: false, timestamp: Date.now(),
        })
      } catch {
        // 单标的失败跳过
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// SEC EDGAR（美股财报，免费）
// ---------------------------------------------------------------------------

export function secCikLookupUrl() {
  return 'https://www.sec.gov/files/company_tickers.json'
}

export function secCompanyFactsUrl(cik) {
  const zeroPadded = String(cik).padStart(10, '0')
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${zeroPadded}.json`
}

/**
 * SEC EDGAR 财报源（需要 ticker→CIK 映射 + 翻墙 + User-Agent）。
 * 作为 FinancialSource 的骨架实现；爬取财务概念需进一步按 XBRL 概念解析。
 */
export class SecEdgarFinancialSource extends FinancialSource {
  constructor({ userAgent = '', proxyUrl = null } = {}) {
    super()
    this.userAgent = userAgent
    this.proxyUrl = proxyUrl
  }

  async fetch() {
    // 骨架：尚未解析 XBRL 概念，返回空；真实接入时应在此调用 SEC EDGAR 并映射为 FinancialItem。
    void this.userAgent
    void this.proxyUrl
    return []
  }
}