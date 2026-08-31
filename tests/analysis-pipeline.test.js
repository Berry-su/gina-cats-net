/**
 * 数据采集引擎 —— 快照映射 + 分析流水线 单元测试
 *
 * 运行：node --test tests/analysis-pipeline.test.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { CatsNet } from '../src/cats_net/index.js'
import { MemoryManager } from '../src/memory/index.js'
import { createSharedBrain, createAnalystTeam, Integrator } from '../src/analysts/index.js'

import {
  inferMarket,
  analyzeMarketNews,
  marketFearGreed,
  SnapshotBuilder,
  AnalysisPipeline,
} from '../src/data_engine/index.js'

function emptyBrain() {
  const catsNet = new CatsNet({ maxIterations: 50 })
  const memoryManager = new MemoryManager({ catsNet })
  return createSharedBrain({ brain: catsNet, memoryManager })
}

describe('snapshot-builder —— 基础映射', () => {
  test('inferMarket 判断市场', () => {
    assert.equal(inferMarket('600519'), 'CN')
    assert.equal(inferMarket('AAPL'), 'US')
  })

  test('analyzeMarketNews 关键词分类', () => {
    assert.equal(analyzeMarketNews([{ title: '流动性骤紧' }]).liquidity, 'tight')
    assert.equal(analyzeMarketNews([{ title: '央行降准释放流动性' }]).liquidity, 'loose')
    assert.equal(analyzeMarketNews([{ title: '市场预期加息' }]).policyBias, 'hawkish')
    assert.equal(analyzeMarketNews([{ title: '预期年内降息' }]).policyBias, 'dovish')
    assert.equal(analyzeMarketNews([{ title: '地缘冲突升级' }]).geopoliticalRisk, 'high')
  })

  test('marketFearGreed 由涨跌广度估算', () => {
    assert.equal(marketFearGreed([{ changePercent: 0.02 }, { changePercent: -0.02 }]), 50)
    assert.equal(marketFearGreed([{ changePercent: 0.1 }, { changePercent: 0.1 }]), 100)
  })
})

describe('SnapshotBuilder —— 快照生成', () => {
  const payload = {
    news: [
      { title: '央行降准释放流动性', tags: ['宏观'], symbols: [] },
      { title: '科技股财报超预期', tags: ['科技', '财报'], symbols: ['AAPL'] },
    ],
    quotes: [
      { symbol: 'AAPL', name: '苹果', market: 'US', price: 106, prevClose: 100, changePercent: 0.06, volume: 3000000, avgVolume: 1000000, dragonTiger: false },
      { symbol: '600519', name: '贵州茅台', market: 'CN', price: 95, prevClose: 100, changePercent: -0.05, volume: 500000, avgVolume: 100000, dragonTiger: true },
    ],
    abnormal: [
      { symbol: 'AAPL', name: '苹果', market: 'US', changePercent: 0.06, reasons: ['涨幅超阈值', '成交量异常放量'] },
      { symbol: '600519', name: '贵州茅台', market: 'CN', changePercent: -0.05, reasons: ['跌幅超阈值', '龙虎榜上榜'] },
    ],
  }

  test('批量构建快照并归一化', () => {
    const b = new SnapshotBuilder({ maxSymbols: 10 })
    const snaps = b.buildSnapshots(payload)
    assert.ok(snaps.length >= 2)
    for (const s of snaps) {
      assert.ok(s.symbol)
      assert.ok(s.technical && typeof s.technical.rsi14 === 'number')
      assert.ok(s.macro && s.fundFlow && s.sentiment && s.fundamental)
    }
  })

  test('market 过滤仅保留对应市场', () => {
    const b = new SnapshotBuilder()
    const cn = b.buildSnapshots(payload, { market: 'CN' })
    assert.ok(cn.every((s) => s.market === 'CN'))
    assert.ok(cn.some((s) => s.symbol === '600519'))
  })

  test('技术面由涨跌幅推导', () => {
    const b = new SnapshotBuilder()
    const snaps = b.buildSnapshots(payload, { market: 'US' })
    const aapl = snaps.find((s) => s.symbol === 'AAPL')
    assert.equal(aapl.technical.trend, 'up')
    assert.equal(aapl.technical.pattern, 'breakout')
    assert.equal(aapl.technical.aboveMa20, true)
  })
})

describe('AnalysisPipeline —— 完整数据流', () => {
  function buildPipeline(payload) {
    const brain = emptyBrain()
    const integrator = new Integrator({ team: createAnalystTeam(brain) })
    const snapshotBuilder = new SnapshotBuilder({ maxSymbols: 10 })
    const dataEngine = { collectOnce: async () => payload }
    return new AnalysisPipeline({ dataEngine, snapshotBuilder, integrator })
  }

  const payload = {
    news: [
      { title: '央行降准释放流动性', tags: ['宏观'], symbols: [] },
      { title: '预期年内降息', tags: ['利率'], symbols: [] },
    ],
    quotes: [
      { symbol: 'AAPL', name: '苹果', market: 'US', price: 106, prevClose: 100, changePercent: 0.06, volume: 3000000, avgVolume: 1000000, dragonTiger: false },
      { symbol: 'MSFT', name: '微软', market: 'US', price: 104, prevClose: 100, changePercent: 0.04, volume: 2000000, avgVolume: 1000000, dragonTiger: false },
      { symbol: '600519', name: '贵州茅台', market: 'CN', price: 96, prevClose: 100, changePercent: -0.04, volume: 400000, avgVolume: 100000, dragonTiger: false },
    ],
    abnormal: [
      { symbol: 'AAPL', name: '苹果', market: 'US', changePercent: 0.06, reasons: ['涨幅超阈值'] },
    ],
  }

  test('run 产出行情快照与分析建议', async () => {
    let reports = null
    const pipeline = buildPipeline(payload)
    pipeline.onReport = (r) => { reports = r }
    const { snapshots } = await pipeline.run()
    assert.ok(snapshots.length >= 1)
    assert.ok(Array.isArray(reports))
    assert.ok(reports.length >= 1)
    for (const r of reports) {
      assert.ok(r.symbol)
      assert.ok(r.recommendation) // 已接入整合器
      assert.ok(['buy', 'sell', 'hold', 'reduce', 'halt'].includes(r.recommendation.action))
    }
  })

  test('run 按 market 过滤', async () => {
    const pipeline = buildPipeline(payload)
    const { snapshots } = await pipeline.run({ market: 'CN' })
    assert.ok(snapshots.every((s) => s.market === 'CN'))
  })

  test('未授权前建议不产单', async () => {
    const pipeline = buildPipeline(payload)
    await pipeline.run({ market: 'US' })
    const recs = pipeline.lastReports.map((r) => r.recommendation).filter(Boolean)
    // 授权闸门属于 Integrator：未 approve 时 getSignal 为 hold
    if (recs.length > 0) {
      assert.equal(pipeline.integrator.getSignal().action, 'hold')
    }
  })
})