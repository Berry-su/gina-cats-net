/**
 * 数据采集引擎 —— 单元测试
 *
 * 运行：node --test tests/data-engine.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWatchlist,
  normalizeNews,
  normalizeQuote,
  MockNewsSource,
  MockQuoteSource,
  AbnormalScanner,
  Scheduler,
  DataEngine,
} from '../src/data_engine/index.js'

describe('normalizer —— 归一化', () => {
  test('normalizeNews：非法输入返回 null', () => {
    assert.equal(normalizeNews(null), null)
    assert.equal(normalizeNews({}), null)
  })

  test('normalizeNews：合法输入补齐字段', () => {
    const n = normalizeNews({ title: '测试新闻', source: 'WSJ', tags: ['宏观', '利率'], symbols: ['AAPL'] })
    assert.equal(n.source, 'WSJ')
    assert.equal(n.title, '测试新闻')
    assert.deepEqual(n.tags, ['宏观', '利率'])
    assert.deepEqual(n.symbols, ['AAPL'])
    assert.ok(n.importance >= 0 && n.importance <= 1)
  })

  test('normalizeQuote：非法输入返回 null', () => {
    assert.equal(normalizeQuote(null), null)
    assert.equal(normalizeQuote({}), null)
    assert.equal(normalizeQuote({ symbol: 'X', price: 0 }), null)
  })

  test('normalizeQuote：按价格差计算涨跌幅', () => {
    const q = normalizeQuote({ symbol: 'AAPL', price: 110, prevClose: 100 })
    assert.equal(q.symbol, 'AAPL')
    assert.equal(q.changePercent, 0.1)
    assert.equal(q.changeAmount, 10)
  })
})

describe('watchlist —— 自选池', () => {
  test('buildWatchlist 生成并去重', () => {
    const w = buildWatchlist({ usCount: 10, cnCount: 10 })
    assert.ok(w.us.length >= 10)
    assert.ok(w.cn.length >= 10)
    const symbols = w.us.map((x) => x.symbol)
    assert.equal(new Set(symbols).size, symbols.length)
  })
})

describe('MockNewsSource —— 新闻源', () => {
  test('fetch 返回指定来源与条数', async () => {
    const src = new MockNewsSource({ source: 'WSJ', outlet: '华尔街日报', count: 3 })
    const items = await src.fetch()
    assert.equal(items.length, 3)
    assert.equal(items[0].source, 'WSJ')
    assert.equal(items[0].outlet, '华尔街日报')
    assert.ok(items[0].title)
  })
})

describe('MockQuoteSource —— 行情源', () => {
  test('fetch 返回自选池全部标的', async () => {
    const src = new MockQuoteSource({
      watchlist: {
        us: [{ symbol: 'AAPL', name: '苹果' }, { symbol: 'MSFT', name: '微软' }],
        cn: [{ symbol: '600519', name: '贵州茅台' }],
      },
    })
    const quotes = await src.fetch()
    assert.equal(quotes.length, 3)
    for (const q of quotes) {
      assert.ok(typeof q.symbol === 'string')
      assert.ok(q.price > 0)
      assert.equal(typeof q.changePercent, 'number')
    }
  })
})

describe('AbnormalScanner —— 异动监控', () => {
  test('识别涨跌幅/放量/龙虎榜三类异动', () => {
    const scanner = new AbnormalScanner({ priceMovePercent: 0.05, volumeSpikeRatio: 3 })
    const quotes = [
      { symbol: 'A', name: 'A', market: 'US', changePercent: 0.06, volume: 100, avgVolume: 100, dragonTiger: false },
      { symbol: 'B', name: 'B', market: 'US', changePercent: 0.01, volume: 500, avgVolume: 100, dragonTiger: false },
      { symbol: 'C', name: 'C', market: 'US', changePercent: 0.01, volume: 100, avgVolume: 100, dragonTiger: true },
      { symbol: 'D', name: 'D', market: 'US', changePercent: 0.01, volume: 100, avgVolume: 100, dragonTiger: false },
    ]
    const res = scanner.scan(quotes)
    assert.equal(res.length, 3)
    assert.deepEqual(res.map((x) => x.symbol).sort(), ['A', 'B', 'C'])
  })
})

describe('Scheduler —— 定时调度', () => {
  test('start/stop 与手动执行', async () => {
    let count = 0
    const sch = new Scheduler({ intervalMs: 100000, job: async () => { count += 1 } })
    await sch.runNow()
    assert.equal(count, 1)
    sch.start()
    assert.ok(sch.isRunning())
    sch.stop()
    assert.ok(!sch.isRunning())
    assert.equal(count, 1) // 未到周期，未额外执行
  })

  test('job 异常不中断调度', async () => {
    const errors = []
    const sch = new Scheduler({
      intervalMs: 100000,
      job: async () => { throw new Error('boom') },
      onError: (e) => errors.push(e),
    })
    await sch.runNow()
    assert.equal(errors.length, 1)
  })
})

describe('DataEngine —— 编排主类', () => {
  function buildEngine() {
    const news = new MockNewsSource({ source: 'WSJ', outlet: '华尔街日报', count: 3 })
    const quotes = new MockQuoteSource({
      watchlist: {
        us: [{ symbol: 'AAPL', name: '苹果' }],
        cn: [{ symbol: '600519', name: '贵州茅台' }],
      },
    })
    return new DataEngine({ newsSources: [news], quoteSources: [quotes] })
  }

  test('collectOnce 返回新闻+行情+异动', async () => {
    let last = null
    const engine = buildEngine()
    engine.onData = (p) => { last = p }
    const p = await engine.collectOnce()
    assert.ok(p.news.length >= 1)
    assert.equal(p.quoteCount, 2)
    assert.equal(typeof p.abnormalCount, 'number')
    assert.ok(last)
  })

  test('紧急终止后 collectOnce 拒绝', async () => {
    const engine = buildEngine()
    engine.abort()
    await assert.rejects(() => engine.collectOnce(), (e) => e.code === 'ABORTED')
  })

  test('单源失败不影响整体抓取', async () => {
    const bad = { fetch: async () => { throw new Error('fail') } }
    const good = new MockNewsSource({ source: 'WSJ', outlet: '华尔街日报', count: 2 })
    const engine = new DataEngine({ newsSources: [bad, good], quoteSources: [] })
    const p = await engine.collectOnce()
    assert.ok(p.news.length >= 1)
  })
})