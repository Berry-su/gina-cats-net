/**
 * 分析师团队 —— 单元测试
 *
 * 运行：node --test tests/analysts.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { CatsNet } from '../src/cats_net/index.js'
import { MemoryManager } from '../src/memory/index.js'

import {
  createSharedBrain,
  createAnalystTeam,
  createMockSnapshot,
  Integrator,
  Opinion,
  VIEWS,
} from '../src/analysts/index.js'

// 使用空大脑（不依赖快照文件），保证测试确定性
function buildEmptyBrain() {
  const catsNet = new CatsNet({ maxIterations: 50 })
  const memoryManager = new MemoryManager({ catsNet })
  return createSharedBrain({ brain: catsNet, memoryManager })
}

function buildIntegrator() {
  const brain = buildEmptyBrain()
  return new Integrator({ team: createAnalystTeam(brain) })
}

describe('Opinion —— 观点固定格式', () => {
  test('toText 输出五段固定格式', () => {
    const o = new Opinion({
      role: '宏观策略师', view: VIEWS.BULLISH,
      reasons: ['流动性宽松'], keyData: ['利率 3.5%'], risks: ['地缘风险'],
    })
    const t = o.toText()
    assert.ok(t.includes('【角色】宏观策略师'))
    assert.ok(t.includes('【观点】看多'))
    assert.ok(t.includes('【核心理由】'))
    assert.ok(t.includes('【关键数据】'))
    assert.ok(t.includes('【风险提示】'))
  })
})

describe('MarketSnapshot —— 统一输入结构', () => {
  test('createMockSnapshot 归一化并补齐字段', () => {
    const s = createMockSnapshot({ symbol: 'AAPL', scenario: 'neutral' })
    assert.equal(s.symbol, 'AAPL')
    assert.ok(s.technical && typeof s.technical.rsi14 === 'number')
    assert.ok(s.fundamental && s.macro && s.fundFlow && s.sentiment)
  })
})

describe('AnalystTeam —— 团队编排', () => {
  test('默认团队含 5 名分析师 + 1 名风控官', () => {
    const team = createAnalystTeam(buildEmptyBrain())
    assert.equal(team.size, 6)
    assert.equal(team.analysts.length, 5)
    assert.ok(team.riskOfficer)
  })

  test('各分析师均输出合法 Opinion 且共享同一大脑', () => {
    const brain = buildEmptyBrain()
    const team = createAnalystTeam(brain)
    const { opinions, risk } = team.analyze(createMockSnapshot({ scenario: 'neutral' }))
    assert.equal(opinions.length, 5)
    for (const o of opinions) {
      assert.ok(o instanceof Opinion)
      assert.ok(['bullish', 'bearish', 'neutral'].includes(o.view))
    }
    assert.ok(risk.meta.isRisk)
    // 共享大脑：所有分析师使用同一个 catsNet 引用
    assert.equal(team.analysts[0].brain.catsNet, brain.catsNet)
    assert.equal(team.analysts[1].brain.catsNet, brain.catsNet)
  })
})

describe('Integrator —— 分歧处理与决策', () => {
  test('看多共识（≥3）→ 买入建议', () => {
    const rec = buildIntegrator().integrate(createMockSnapshot({ scenario: 'bullish' }))
    assert.equal(rec.action, 'buy')
    assert.equal(rec.vetoed, false)
    assert.ok(rec.bullish >= 3)
  })

  test('看空共识（≥3）→ 卖出建议', () => {
    const rec = buildIntegrator().integrate(createMockSnapshot({ scenario: 'bearish' }))
    assert.equal(rec.action, 'sell')
    assert.equal(rec.vetoed, false)
    assert.ok(rec.bearish >= 3)
  })

  test('多空分歧 → 观望，不强出信号', () => {
    const rec = buildIntegrator().integrate(createMockSnapshot({ scenario: 'divergent' }))
    assert.equal(rec.action, 'hold')
    assert.equal(rec.divergence, 'high')
  })

  test('危机情景 → 风控官一票否决（暂停）', () => {
    const rec = buildIntegrator().integrate(createMockSnapshot({ scenario: 'crisis' }))
    assert.equal(rec.action, 'halt')
    assert.equal(rec.vetoed, true)
    assert.equal(rec.halt, true)
  })

  test('风控官否决优先于看多共识（越权无效）', () => {
    // 在看多情景上叠加危机信号，即使其他分析师看多，风控官仍一票否决
    const snapshot = createMockSnapshot({
      scenario: 'bullish',
      overrides: {
        change1d: -0.08,
        macro: { liquidity: 'tight', geopoliticalRisk: 'high' },
        fundFlow: { marginBalanceTrend: 'down' },
        sentiment: { abnormalVolatility: true },
      },
    })
    const rec = buildIntegrator().integrate(snapshot)
    assert.equal(rec.action, 'halt')
    assert.equal(rec.vetoed, true)
  })
})

describe('Integrator —— 授权闸门（只有用户授权才可下单）', () => {
  test('未授权前 getSignal 拒绝下单', () => {
    const int = buildIntegrator()
    int.integrate(createMockSnapshot({ scenario: 'bullish' }))
    const sig = int.getSignal()
    assert.equal(sig.action, 'hold')
    assert.ok(sig.reason.includes('授权'))
  })

  test('授权后 getSignal 输出买入信号', () => {
    const int = buildIntegrator()
    int.integrate(createMockSnapshot({ scenario: 'bullish' }))
    int.approve()
    const sig = int.getSignal()
    assert.equal(sig.action, 'buy')
  })

  test('暂停/降仓建议即使授权也不产单', () => {
    const int = buildIntegrator()
    int.integrate(createMockSnapshot({ scenario: 'crisis' }))
    int.approve()
    const sig = int.getSignal()
    assert.equal(sig.action, 'hold')
  })
})