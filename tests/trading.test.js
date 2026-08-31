/**
 * 交易模块 —— 单元测试
 *
 * 运行：node --test tests/trading.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MarketDataProvider,
  MockMarketDataProvider,
  Strategy,
  MovingAverageStrategy,
  BreakoutStrategy,
  PositionManager,
  RiskController,
  TradingEngine,
} from '../src/trading/index.js'

const tick = (symbol, close, extra = {}) => ({
  symbol,
  timestamp: Date.now(),
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  ...extra,
})

// ---------------------------------------------------------------------------
describe('MarketDataProvider —— 行情抽象层', () => {
  test('订阅与回调', () => {
    const p = new MarketDataProvider()
    p.registerSymbol('AAPL')
    assert.deepEqual(p.getSymbols(), ['AAPL'])
    const ticks = []
    p.onTick((t) => ticks.push(t))
    p._emit(tick('AAPL', 100))
    assert.equal(ticks.length, 1)
    assert.equal(ticks[0].close, 100)
  })

  test('Mock 生成合法 tick', () => {
    const mock = new MockMarketDataProvider({ symbols: ['AAPL'], basePrice: 100 })
    const t = mock.generateTick('AAPL')
    assert.equal(t.symbol, 'AAPL')
    assert.equal(typeof t.close, 'number')
    assert.ok(t.close > 0)
    assert.ok(t.high >= t.low)
  })
})

// ---------------------------------------------------------------------------
describe('Strategy —— 策略信号', () => {
  test('基类默认 hold', () => {
    const s = new Strategy({ name: 'base' })
    assert.equal(s.onTick(tick('A', 1)).action, 'hold')
  })

  test('均线交叉：数据不足时 hold', () => {
    const s = new MovingAverageStrategy({ shortWindow: 2, longWindow: 3 })
    assert.equal(s.onTick(tick('A', 10)).action, 'hold')
    assert.equal(s.onTick(tick('A', 10)).action, 'hold')
  })

  test('均线交叉：短期上穿产生 buy', () => {
    const s = new MovingAverageStrategy({ shortWindow: 2, longWindow: 3 })
    s.onTick(tick('A', 10))
    s.onTick(tick('A', 10))
    s.onTick(tick('A', 10)) // 均线持平，无交叉
    const r = s.onTick(tick('A', 20)) // 短期上穿
    assert.equal(r.action, 'buy')
  })

  test('突破策略：突破前高 buy', () => {
    const s = new BreakoutStrategy({ window: 3 })
    s.onTick(tick('A', 10))
    s.onTick(tick('A', 10))
    s.onTick(tick('A', 10))
    const r = s.onTick(tick('A', 15))
    assert.equal(r.action, 'buy')
  })
})

// ---------------------------------------------------------------------------
describe('PositionManager —— 仓位管理', () => {
  test('开仓扣减权益', () => {
    const pm = new PositionManager({ initialEquity: 100000 })
    pm.openPosition('AAPL', 100, 100)
    assert.equal(pm.getEquity(), 90000)
    assert.equal(pm.getPosition('AAPL').qty, 100)
  })

  test('加仓加权均价', () => {
    const pm = new PositionManager({ initialEquity: 100000 })
    pm.openPosition('AAPL', 100, 100)
    pm.openPosition('AAPL', 100, 200)
    const pos = pm.getPosition('AAPL')
    assert.equal(pos.qty, 200)
    assert.equal(pos.avgPrice, 150)
  })

  test('平仓计算盈亏并回补权益', () => {
    const pm = new PositionManager({ initialEquity: 100000 })
    pm.openPosition('AAPL', 100, 100)
    const { closed, pnl } = pm.closePosition('AAPL', 120)
    assert.equal(closed, true)
    assert.equal(pnl, 2000)
    assert.equal(pm.getEquity(), 102000)
    assert.ok(!pm.hasPosition('AAPL'))
  })

  test('浮动盈亏', () => {
    const pm = new PositionManager({ initialEquity: 100000 })
    pm.openPosition('AAPL', 100, 100)
    assert.equal(pm.getUnrealizedPnl('AAPL', 110), 1000)
  })

  test('资金不足抛错', () => {
    const pm = new PositionManager({ initialEquity: 1000 })
    assert.throws(() => pm.openPosition('AAPL', 100, 100), /资金不足/)
  })
})

// ---------------------------------------------------------------------------
describe('RiskController —— 风控规则', () => {
  function ctx(equity, positions = new Map()) {
    return { equity, positions, currentPrices: {} }
  }

  test('正常订单通过', () => {
    const rc = new RiskController()
    const r = rc.checkOrder({ symbol: 'AAPL', side: 'buy', size: 100, price: 100 }, ctx(100000))
    assert.equal(r.approved, true)
  })

  test('单标的仓位占比超限拒绝', () => {
    const rc = new RiskController({ maxPositionRatio: 0.2 })
    // 买入 10000*100 = 100万，占权益 10万 的 1000%，超限
    const r = rc.checkOrder({ symbol: 'AAPL', side: 'buy', size: 10000, price: 100 }, ctx(100000))
    assert.equal(r.approved, false)
    assert.ok(r.reasons.some((x) => x.includes('仓位')))
  })

  test('单笔数量超限拒绝', () => {
    const rc = new RiskController({ maxOrderSize: 100 })
    const r = rc.checkOrder({ symbol: 'A', side: 'buy', size: 101, price: 10 }, ctx(100000))
    assert.equal(r.approved, false)
    assert.ok(r.reasons.some((x) => x.includes('单笔数量')))
  })

  test('防连续恶性开仓：窗口内同向密集开仓拒绝', () => {
    const rc = new RiskController({ maxOpenFrequency: 3, openWindowMs: 60000 })
    rc.recordOpen('buy')
    rc.recordOpen('buy')
    rc.recordOpen('buy')
    const r = rc.checkOrder({ symbol: 'A', side: 'buy', size: 10, price: 10 }, ctx(100000))
    assert.equal(r.approved, false)
    assert.ok(r.reasons.some((x) => x.includes('连续开仓')))
  })

  test('止损触发', () => {
    const rc = new RiskController({ stopLossPercent: 0.05 })
    const r = rc.checkStopLossTakeProfit({ qty: 100, avgPrice: 100 }, 94)
    assert.equal(r.action, 'stop_loss')
  })

  test('止盈触发', () => {
    const rc = new RiskController({ takeProfitPercent: 0.1 })
    const r = rc.checkStopLossTakeProfit({ qty: 100, avgPrice: 100 }, 112)
    assert.equal(r.action, 'take_profit')
  })

  test('未触发保持持有', () => {
    const rc = new RiskController()
    assert.equal(rc.checkStopLossTakeProfit({ qty: 100, avgPrice: 100 }, 101).action, 'hold')
  })

  test('每日亏损熔断', () => {
    const rc = new RiskController({ maxDailyLoss: 0.05 })
    rc.updateEquity(100000)
    rc.recordTrade(-6000) // 亏 6%，超 5% 阈值
    assert.equal(rc.isHalted(), true)
  })

  test('最大回撤熔断', () => {
    const rc = new RiskController({ maxDrawdown: 0.2 })
    rc.updateEquity(100000) // 峰值 10万
    rc.updateEquity(79000)  // 回撤 21% > 20%
    assert.equal(rc.isHalted(), true)
  })
})

// ---------------------------------------------------------------------------
describe('TradingEngine —— 交易引擎', () => {
  function buildEngine(strategy, options = {}) {
    const pm = new PositionManager({ initialEquity: 100000 })
    const rc = new RiskController()
    const engine = new TradingEngine({
      strategy,
      positionManager: pm,
      riskController: rc,
      defaultSize: 100,
      ...options,
    })
    return { engine, pm, rc }
  }

  test('买入信号开仓', () => {
    const strat = { onTick: () => ({ action: 'buy', reason: 'test' }) }
    const { engine, pm } = buildEngine(strat)
    const r = engine.processTick(tick('AAPL', 100))
    assert.equal(r.order.status, 'filled')
    assert.ok(pm.hasPosition('AAPL'))
  })

  test('卖出信号平仓', () => {
    const strat = { onTick: () => ({ action: 'sell', reason: 'test' }) }
    const { engine, pm } = buildEngine(strat)
    // 先手动开仓
    pm.openPosition('AAPL', 100, 100)
    const r = engine.processTick(tick('AAPL', 102)) // 浮盈 2%，不触发止盈/止损
    assert.equal(r.order.status, 'filled')
    assert.equal(r.order.pnl, 200)
    assert.ok(!pm.hasPosition('AAPL'))
  })

  test('止损自动触发（不依赖策略）', () => {
    const strat = { onTick: () => ({ action: 'hold', reason: 'hold' }) }
    const { engine, pm } = buildEngine(strat)
    pm.openPosition('AAPL', 100, 100)
    const r = engine.processTick(tick('AAPL', 94)) // 浮亏 6% > 5%
    assert.ok(r.stopLoss)
    assert.ok(!pm.hasPosition('AAPL'))
  })

  test('风控拒绝：超大买单', () => {
    const strat = { onTick: () => ({ action: 'buy', size: 10000, reason: 'bulk' }) }
    const { engine, pm } = buildEngine(strat)
    engine.defaultSize = 10000
    const r = engine.processTick(tick('AAPL', 100))
    // 10000*100 = 100万 超单标的 20% 与单笔上限
    assert.equal(r.order.status, 'rejected')
    assert.ok(!pm.hasPosition('AAPL'))
  })

  test('紧急终止后处理抛错', () => {
    const strat = { onTick: () => ({ action: 'hold' }) }
    const { engine } = buildEngine(strat)
    engine.abort()
    assert.throws(() => engine.processTick(tick('A', 1)), (e) => e.code === 'ABORTED')
  })

  test('异常容错：无策略返回降级结果', () => {
    const { engine } = buildEngine(null)
    const r = engine.processTick(tick('A', 100))
    assert.equal(r.signal.action, 'hold')
  })
})