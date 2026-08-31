/**
 * 真实数据源 —— Tushare 适配器 (tushare.js)
 *
 * Tushare（https://tushare.pro）用于 A 股行情 / 财报估值 / 资金流向。
 * 需在配置中提供 token（TUSHARE_TOKEN 或 data-sources.json 的 tushare.token）。
 *
 * 说明：以下字段映射为「可落地起点」，接入真实数据后应按 Tushare 当前字段口径逐项核对。
 */

import { QuoteSource } from '../data_engine/index.js'
import { FinancialSource, FundFlowSource } from './interfaces.js'
import { fetchJson } from './http-client.js'

export const TUSHARE_ENDPOINT = 'http://api.tushare.pro'

/**
 * 构造 Tushare POST 请求体（token 由调用方注入，便于测试）。
 * @param {string} apiName
 * @param {object} params
 * @param {string} fields
 * @returns {object}
 */
export function buildTushareRequest(apiName, params = {}, fields = '') {
  return { api_name: apiName, token: '<token>', params: params ?? {}, fields }
}

/** 将 Tushare 的 fields+values 组装为对象。 */
export function mapTushareRow(fields = [], values = []) {
  const obj = {}
  fields.forEach((f, i) => { obj[f] = values[i] })
  return obj
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) ? null : n
}

/** daily 行情 → QuoteItem（归一化前）。 */
export function mapTushareDaily(row) {
  const code = String(row.ts_code ?? '').split('.')[0]
  const pct = num(row.pct_chg)
  return {
    symbol: code,
    name: code,
    market: 'CN',
    price: num(row.close),
    prevClose: num(row.pre_close),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    changePercent: pct == null ? null : pct / 100,
    volume: num(row.vol),
    dragonTiger: false,
    timestamp: Date.now(),
  }
}

/** daily_basic 估值 → FinancialItem（归一化前）。 */
export function mapTushareDailyBasic(row) {
  const code = String(row.ts_code ?? '').split('.')[0]
  return {
    symbol: code,
    market: 'CN',
    pe: num(row.pe),
    pe_ttm: num(row.pe_ttm),
    pb: num(row.pb),
    reportDate: row.trade_date ?? null,
  }
}

/** moneyflow 资金流 → FundFlowItem（归一化前；单位换算由调用方按字段口径确认）。 */
export function mapTushareMoneyflow(row) {
  const code = String(row.ts_code ?? '').split('.')[0]
  return {
    symbol: code,
    market: 'CN',
    mainForceNet: num(row.net_mf_amount), // 主力净流入额（万元，需换算）
    marginBalanceTrend: null,
    turnoverRate: num(row.turnover_rate),
  }
}

/**
 * Tushare A 股行情源（实现 QuoteSource，可直接注入 DataEngine）。
 */
export class TushareQuoteSource extends QuoteSource {
  constructor({ token = '', tradeDate = null, proxyUrl = null } = {}) {
    super()
    this.token = token
    this.tradeDate = tradeDate
    this.proxyUrl = proxyUrl
  }

  async fetch() {
    if (!this.token) return []
    const fields = 'ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount'
    const params = this.tradeDate ? { trade_date: this.tradeDate } : {}
    const body = { ...buildTushareRequest('daily', params, fields), token: this.token }
    const data = await fetchJson(TUSHARE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      proxyUrl: this.proxyUrl,
    })
    const fieldsArr = data?.data?.fields ?? []
    const items = data?.data?.items ?? []
    return items.map((vals) => mapTushareDaily(mapTushareRow(fieldsArr, vals)))
  }
}

/**
 * Tushare 财报/估值源（实现 FinancialSource）。
 */
export class TushareFinancialSource extends FinancialSource {
  constructor({ token = '', tradeDate = null, proxyUrl = null } = {}) {
    super()
    this.token = token
    this.tradeDate = tradeDate
    this.proxyUrl = proxyUrl
  }

  async fetch() {
    if (!this.token) return []
    const fields = 'ts_code,trade_date,pe,pe_ttm,pb,total_mv'
    const params = this.tradeDate ? { trade_date: this.tradeDate } : {}
    const body = { ...buildTushareRequest('daily_basic', params, fields), token: this.token }
    const data = await fetchJson(TUSHARE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      proxyUrl: this.proxyUrl,
    })
    const fieldsArr = data?.data?.fields ?? []
    const items = data?.data?.items ?? []
    return items.map((vals) => mapTushareDailyBasic(mapTushareRow(fieldsArr, vals)))
  }
}

/**
 * Tushare 资金流向源（实现 FundFlowSource）。
 */
export class TushareFundFlowSource extends FundFlowSource {
  constructor({ token = '', tradeDate = null, proxyUrl = null } = {}) {
    super()
    this.token = token
    this.tradeDate = tradeDate
    this.proxyUrl = proxyUrl
  }

  async fetch() {
    if (!this.token) return []
    const fields = 'ts_code,trade_date,net_mf_amount,net_mf_rate,turnover_rate'
    const params = this.tradeDate ? { trade_date: this.tradeDate } : {}
    const body = { ...buildTushareRequest('moneyflow', params, fields), token: this.token }
    const data = await fetchJson(TUSHARE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      proxyUrl: this.proxyUrl,
    })
    const fieldsArr = data?.data?.fields ?? []
    const items = data?.data?.items ?? []
    return items.map((vals) => mapTushareMoneyflow(mapTushareRow(fieldsArr, vals)))
  }
}