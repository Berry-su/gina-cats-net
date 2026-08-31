/**
 * 真实数据源 —— 单元测试
 *
 * 运行：node --test tests/data-sources.test.js
 * 注：网络请求不在此测试真实调用，只测纯映射/解析/配置/授权门逻辑。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  loadDataSourcesConfig,
  buildTushareRequest,
  mapTushareRow,
  mapTushareDaily,
  mapTushareDailyBasic,
  mapTushareMoneyflow,
  yahooChartUrl,
  mapYahooChart,
  alpacaHeaders,
  secCompanyFactsUrl,
  parseRss,
  RssNewsSource,
  TonghuashunBrokerAdapter,
} from '../src/data_sources/index.js'
import { SnapshotBuilder } from '../src/data_engine/index.js'

describe('config —— 配置加载', () => {
  test('无配置文件时返回默认值', () => {
    const c = loadDataSourcesConfig('/nonexistent/path.json')
    assert.equal(c.tushareToken, '')
    assert.equal(c.alpaca.key, '')
    assert.ok(c.proxy.includes('7890'))
  })
})

describe('tushare —— 请求与映射', () => {
  test('buildTushareRequest 组装请求体', () => {
    const r = buildTushareRequest('daily', { trade_date: '20260819' }, 'ts_code,close')
    assert.equal(r.api_name, 'daily')
    assert.deepEqual(r.params, { trade_date: '20260819' })
    assert.equal(r.fields, 'ts_code,close')
  })

  test('mapTushareRow 由 fields+values 组装对象', () => {
    assert.deepEqual(mapTushareRow(['a', 'b'], [1, 2]), { a: 1, b: 2 })
  })

  test('mapTushareDaily 映射行情', () => {
    const q = mapTushareDaily({ ts_code: '600519.SH', close: 150, pre_close: 146.34, pct_chg: 2.5 })
    assert.equal(q.symbol, '600519')
    assert.equal(q.market, 'CN')
    assert.equal(q.changePercent, 0.025)
    assert.equal(q.price, 150)
  })

  test('mapTushareDailyBasic 映射估值', () => {
    const f = mapTushareDailyBasic({ ts_code: '000001.SZ', pe: 8.5, pb: 1.2 })
    assert.equal(f.symbol, '000001')
    assert.equal(f.pe, 8.5)
    assert.equal(f.pb, 1.2)
  })

  test('mapTushareMoneyflow 映射资金流', () => {
    const f = mapTushareMoneyflow({ ts_code: '300750.SZ', net_mf_amount: 12345 })
    assert.equal(f.symbol, '300750')
    assert.equal(f.mainForceNet, 12345)
  })
})

describe('us-market —— 美股映射', () => {
  test('yahooChartUrl 编码标的', () => {
    assert.ok(yahooChartUrl('AAPL').includes('/chart/AAPL'))
  })

  test('mapYahooChart 由前置收盘算涨跌幅', () => {
    const q = mapYahooChart('AAPL', { chart: { result: [{ meta: { regularMarketPrice: 106, chartPreviousClose: 100 } }] } })
    assert.equal(q.symbol, 'AAPL')
    assert.equal(q.changePercent, 0.06)
    assert.equal(q.market, 'US')
  })

  test('alpacaHeaders 携带密钥', () => {
    const h = alpacaHeaders('k', 's')
    assert.equal(h['APCA-API-KEY-ID'], 'k')
    assert.equal(h['APCA-API-SECRET-KEY'], 's')
  })

  test('secCompanyFactsUrl 补齐 10 位 CIK', () => {
    assert.equal(secCompanyFactsUrl('320193'), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json')
  })
})

describe('rss —— 新闻解析', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item><title>新闻A</title><link>http://a</link><description>描述A</description><pubDate>Tue, 19 Aug 2026 10:00:00 GMT</pubDate></item><item><title>新闻B</title><link>http://b</link></item></rss>`

  test('parseRss 解析条目', () => {
    const items = parseRss(xml)
    assert.equal(items.length, 2)
    assert.equal(items[0].title, '新闻A')
    assert.equal(items[0].link, 'http://a')
    assert.equal(items[1].title, '新闻B')
  })

  test('RssNewsSource 构造', () => {
    const s = new RssNewsSource({ outlet: '路透社', source: 'Reuters', url: 'http://x/rss' })
    assert.equal(s.outlet, '路透社')
    assert.equal(s.url, 'http://x/rss')
  })
})

describe('broker —— 交易骨架与授权门', () => {
  test('未授权拒单', async () => {
    const b = new TonghuashunBrokerAdapter()
    const r = await b.placeOrder({ symbol: '600519', side: 'buy', size: 100, price: 10 }, { authorized: false })
    assert.equal(r.status, 'rejected')
    assert.ok(r.reason.includes('授权'))
  })

  test('已授权但通道未接入', async () => {
    const b = new TonghuashunBrokerAdapter()
    const r = await b.placeOrder({ symbol: '600519', side: 'buy', size: 100, price: 10 }, { authorized: true })
    assert.equal(r.status, 'not_connected')
  })

  test('持仓/账户查询骨架', async () => {
    const b = new TonghuashunBrokerAdapter()
    assert.deepEqual(await b.getPositions(), [])
    assert.equal(await b.getAccount(), null)
  })
})

describe('SnapshotBuilder —— 财报/资金流富化', () => {
  test('financials/fundFlows 填充 fundamental/fundFlow', () => {
    const payload = {
      news: [],
      quotes: [{ symbol: 'AAPL', name: '苹果', market: 'US', price: 100, prevClose: 100, changePercent: 0, volume: 100, avgVolume: 100, dragonTiger: false }],
      abnormal: [],
      financials: [{ symbol: 'AAPL', pe: 12, pb: 2, roe: 18, profitGrowth: 22, industryProsperity: 'up' }],
      fundFlows: [{ symbol: 'AAPL', mainForceNet: 33, northboundNet: 20, marginBalanceTrend: 'up', turnoverRate: 4 }],
    }
    const b = new SnapshotBuilder({ maxSymbols: 5 })
    const snaps = b.buildSnapshots(payload)
    const s = snaps.find((x) => x.symbol === 'AAPL')
    assert.equal(s.fundamental.pe, 12)
    assert.equal(s.fundamental.roe, 18)
    assert.equal(s.fundamental.industryProsperity, 'up')
    assert.equal(s.fundFlow.mainForceNet, 33)
    assert.equal(s.fundFlow.marginBalanceTrend, 'up')
  })
})