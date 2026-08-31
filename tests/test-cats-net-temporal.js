/**
 * CatsNet 时序激活 / ConceptNode 时序字段（C-1.2 阶段 2）—— 单元 + 集成测试
 *
 * 覆盖（ADR-002 §3.2.5）：
 *   1) 指数衰减数学正确性：A(t) = A0 × exp(-λ × Δt_hours)
 *   2) 3 类型衰减率差异化：episodic 0.1/h / semantic 0.01/h / abstract 0.001/h
 *   3) getActivationAt 纯查询（不改 activation）
 *   4) applyTimeDecay 实际修改 + 推进 lastActivatedAt
 *   5) lastActivatedAt 在 activate/deactivate/decay 后自动更新
 *   6) Serializer round-trip：toJSON → fromJSON 保留 3 字段
 *   7) tickTimeDecay 全图批量衰减 + 返回 {decayed, stable}
 *   8) getActivationHistory 时间窗查询（fromT/toT 边界）
 *   9) 边界：过去时间 / 未来时间 / 显式 activationDecayRate 覆盖
 *   10) 向后兼容：旧数据无 lastActivatedAt → 从 history[0].ts 推断
 *
 * 运行：node --test tests/test-cats-net-temporal.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CatsNet,
  ConceptNode,
  Serializer,
  CONCEPT_LEVELS,
  LEVEL_DECAY_RATES,
  ACTIVATION_DECAY_MODELS,
} from '../src/cats_net/index.js'

// 允许浮点误差
const EPS = 1e-6
const near = (a, b, msg) => {
  assert.ok(
    Math.abs(a - b) < EPS,
    `${msg}：期望 ${b}，实得 ${a}（误差 ${Math.abs(a - b)}）`,
  )
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

// 主动 mock Date.now（避免真实时间漂移影响算例精度）
const originalDateNow = Date.now
let mockNow = 1_700_000_000_000 // 2023-11-14T22:13:20Z 固定
function withMockTime(fn) {
  Date.now = () => mockNow
  try {
    return fn()
  } finally {
    Date.now = originalDateNow
  }
}

// ---------------------------------------------------------------------------
describe('ConceptNode 时序字段构造与默认值', () => {
  test('不传 lastActivatedAt/activationDecayRate 时按 level 自动选', () => {
    const cn = new ConceptNode({ id: 'a', level: 'semantic' })
    assert.equal(typeof cn.lastActivatedAt, 'number')
    assert.equal(cn.activationDecayRate, LEVEL_DECAY_RATES.semantic)
    assert.equal(cn.activationDecayModel, 'exponential')
  })

  test('3 level 默认衰减率与 ADR-002 §3.2.1 一致', () => {
    assert.equal(LEVEL_DECAY_RATES.episodic, 0.1)
    assert.equal(LEVEL_DECAY_RATES.semantic, 0.01)
    assert.equal(LEVEL_DECAY_RATES.abstract, 0.001)
  })

  test('显式 activationDecayRate 覆盖 level 默认', () => {
    const cn = new ConceptNode({ id: 'a', level: 'episodic', activationDecayRate: 0.5 })
    assert.equal(cn.activationDecayRate, 0.5)
  })

  test('非法 activationDecayModel 回退到 exponential', () => {
    const cn = new ConceptNode({ id: 'a', activationDecayModel: 'linear-bogus' })
    assert.equal(cn.activationDecayModel, 'exponential')
  })

  test('ACTIVATION_DECAY_MODELS 只含 exponential（预留扩展位）', () => {
    assert.deepEqual([...ACTIVATION_DECAY_MODELS], ['exponential'])
  })
})

// ---------------------------------------------------------------------------
describe('指数衰减数学正确性（C-1.2 算例）', () => {
  test('semantic 节点 1 小时后：exp(-0.01 × 1) = 0.99005', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 's', level: 'semantic' })
      cn.activate(1.0, 'test')
      const future = mockNow + 1 * HOUR_MS
      const got = cn.getActivationAt(future)
      const expected = 1.0 * Math.exp(-0.01 * 1)
      near(got, expected, '1 小时后激活值')
    })
  })

  test('semantic 节点 1 天后：exp(-0.01 × 24) ≈ 0.7866', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 's', level: 'semantic' })
      cn.activate(1.0, 'test')
      const future = mockNow + 1 * DAY_MS
      const got = cn.getActivationAt(future)
      const expected = 1.0 * Math.exp(-0.01 * 24)
      near(got, expected, '1 天后激活值')
      // 浮点精度验证：1 天后语义节点应 ≈ 0.79
      assert.ok(got < 0.8 && got > 0.78, `1 天后应为 0.78~0.80，实得 ${got}`)
    })
  })

  test('3 类型衰减率差异化：24h 后 episodic≈0.09 / semantic≈0.79 / abstract≈0.976', () => {
    withMockTime(() => {
      const e = new ConceptNode({ id: 'e', level: 'episodic' })
      const s = new ConceptNode({ id: 's', level: 'semantic' })
      const a = new ConceptNode({ id: 'a', level: 'abstract' })
      e.activate(1.0, 'test')
      s.activate(1.0, 'test')
      a.activate(1.0, 'test')
      const future = mockNow + 1 * DAY_MS
      near(e.getActivationAt(future), Math.exp(-0.1 * 24), 'episodic 24h 后')
      near(s.getActivationAt(future), Math.exp(-0.01 * 24), 'semantic 24h 后')
      near(a.getActivationAt(future), Math.exp(-0.001 * 24), 'abstract 24h 后')
      // 数量级检查
      assert.ok(e.getActivationAt(future) < 0.1, 'episodic 24h 后应 < 0.1')
      assert.ok(s.getActivationAt(future) > 0.7 && s.getActivationAt(future) < 0.9, 'semantic 24h 后应 0.7~0.9')
      assert.ok(a.getActivationAt(future) > 0.95, 'abstract 24h 后应 > 0.95')
    })
  })
})

// ---------------------------------------------------------------------------
describe('getActivationAt 纯查询 + 边界', () => {
  test('过去时间返回当前 activation（不衰减）', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a', level: 'semantic' })
      cn.activate(0.7, 'test')
      const past = mockNow - 1 * HOUR_MS
      near(cn.getActivationAt(past), 0.7, '过去 1 小时查询')
    })
  })

  test('未来时间 + 显式 activationDecayRate=0 时永不变', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a', level: 'semantic', activationDecayRate: 0 })
      cn.activate(0.5, 'test')
      const future = mockNow + 100 * DAY_MS
      near(cn.getActivationAt(future), 0.5, 'λ=0 时激活值永不变')
    })
  })

  test('getActivationAt 纯查询：连续多次调不改 this.activation', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a', level: 'semantic' })
      cn.activate(1.0, 'test')
      const before = cn.activation
      const future = mockNow + 10 * HOUR_MS
      cn.getActivationAt(future)
      cn.getActivationAt(future)
      cn.getActivationAt(future)
      assert.equal(cn.activation, before, 'getActivationAt 不改 activation')
      assert.equal(cn.lastActivatedAt, mockNow, 'getActivationAt 不改 lastActivatedAt')
    })
  })

  test('非法 t 抛 TypeError', () => {
    const cn = new ConceptNode({ id: 'a' })
    assert.throws(() => cn.getActivationAt('not-a-number'), TypeError)
    assert.throws(() => cn.getActivationAt(NaN), TypeError)
  })
})

// ---------------------------------------------------------------------------
describe('applyTimeDecay 实际修改 + 推进 lastActivatedAt', () => {
  test('applyTimeDecay(now) 写回 activation + 推进 lastActivatedAt', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a', level: 'semantic' })
      cn.activate(1.0, 'test')
      const future = mockNow + 1 * DAY_MS
      const decayed = cn.applyTimeDecay(future)
      const expected = Math.exp(-0.01 * 24)
      near(decayed, expected, 'applyTimeDecay 返回值')
      near(cn.activation, expected, 'applyTimeDecay 写回 activation')
      assert.equal(cn.lastActivatedAt, future, 'applyTimeDecay 推进 lastActivatedAt')
    })
  })

  test('applyTimeDecay 幂等：连调两次结果稳定', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a', level: 'semantic' })
      cn.activate(1.0, 'test')
      const future = mockNow + 1 * DAY_MS
      cn.applyTimeDecay(future)
      const after1 = cn.activation
      cn.applyTimeDecay(future) // 同一时刻
      near(cn.activation, after1, '同 now 二次 applyTimeDecay 幂等')
    })
  })
})

// ---------------------------------------------------------------------------
describe('lastActivatedAt 在 activate/deactivate/decay 后自动更新', () => {
  test('activate 后 lastActivatedAt 推进', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a' })
      mockNow += 1000
      cn.activate(0.5, 'test')
      assert.equal(cn.lastActivatedAt, mockNow)
    })
  })

  test('deactivate 后 lastActivatedAt 推进', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a' })
      mockNow += 1000
      cn.deactivate(0.1, 'test')
      assert.equal(cn.lastActivatedAt, mockNow)
    })
  })

  test('decay 后 lastActivatedAt 推进', () => {
    withMockTime(() => {
      const cn = new ConceptNode({ id: 'a' })
      mockNow += 1000
      cn.decay(0.1)
      assert.equal(cn.lastActivatedAt, mockNow)
    })
  })
})

// ---------------------------------------------------------------------------
describe('Serializer round-trip（C-1.2 持久化）', () => {
  test('toJSON 包含 3 个时序字段', () => {
    const cn = new ConceptNode({ id: 'a', level: 'episodic' })
    const json = cn.toJSON()
    assert.equal(typeof json.lastActivatedAt, 'number')
    assert.equal(json.activationDecayRate, 0.1)
    assert.equal(json.activationDecayModel, 'exponential')
  })

  test('fromJSON 完整保留 3 字段', () => {
    const original = new ConceptNode({
      id: 'a',
      level: 'semantic',
      lastActivatedAt: 1000,
      activationDecayRate: 0.5,
      activationDecayModel: 'exponential',
    })
    const restored = ConceptNode.fromJSON(original.toJSON())
    assert.equal(restored.lastActivatedAt, 1000)
    assert.equal(restored.activationDecayRate, 0.5)
    assert.equal(restored.activationDecayModel, 'exponential')
  })

  test('向后兼容：旧数据无 lastActivatedAt → 从 history[0].ts 推断', () => {
    const legacyData = {
      id: 'legacy',
      name: 'legacy',
      type: 'abstract',
      level: 'semantic',
      attributes: {},
      activation: 0.5,
      confidence: 1,
      granularity: 1,
      connections: [],
      history: [{ ts: 1234567890, op: 'activate', amount: 0.5, activation: 0.5 }],
    }
    const restored = ConceptNode.fromJSON(legacyData)
    assert.equal(restored.lastActivatedAt, 1234567890, '从 history[0].ts 推断')
    // activationDecayRate 缺省 → 按 semantic level 默认
    assert.equal(restored.activationDecayRate, LEVEL_DECAY_RATES.semantic)
  })

  test('CatsNet 全图 Serializer 往返：时序字段保留', () => {
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })
    e.activate(0.8, 'test')
    const ser = new Serializer()
    const data = ser.serialize(cn.serialize())
    const cn2 = new CatsNet()
    cn2.deserialize(ser.deserialize(data))
    const restored = cn2.getNode('e')
    assert.equal(restored.lastActivatedAt, e.lastActivatedAt)
    assert.equal(restored.activationDecayRate, 0.1)
    assert.equal(restored.activation, 0.8)
  })
})

// ---------------------------------------------------------------------------
describe('CatsNet.tickTimeDecay 全图批量衰减', () => {
  test('返回 {decayed, stable} 计数正确', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a', level: 'semantic', activationDecayRate: 0.5 }) // 高衰减
      const b = cn.addNode({ id: 'b', level: 'abstract', activationDecayRate: 0 }) // 不衰减
      a.activate(1.0, 'test')
      b.activate(1.0, 'test')
      const future = mockNow + 1 * DAY_MS
      const result = cn.tickTimeDecay(future)
      assert.equal(result.decayed, 1, 'a 衰减')
      assert.equal(result.stable, 1, 'b 稳定')
      near(a.activation, Math.exp(-0.5 * 24), 'a 衰减后激活值')
      assert.equal(b.activation, 1.0, 'b 永不变')
    })
  })

  test('tickTimeDecay 不影响 history（仅写 _record）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a', level: 'semantic' })
      a.activate(1.0, 'test')
      const beforeHistory = a.history.length
      cn.tickTimeDecay(mockNow + 1 * HOUR_MS)
      const afterHistory = a.history.length
      // tickTimeDecay 会写 _record（applyTimeDecay），所以 history 会 +1
      assert.equal(afterHistory, beforeHistory + 1, '每次 applyTimeDecay 写一条 history')
    })
  })
})

// ---------------------------------------------------------------------------
describe('CatsNet.getActivationHistory 时间窗查询', () => {
  test('返回 [fromT, toT] 区间内的 history 条目（按 ts 升序）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a', level: 'semantic' })
      // 制造 3 条 activate 记录（间隔 1 小时）
      mockNow += 1000
      a.activate(0.3, 'src1')
      mockNow += HOUR_MS
      a.activate(0.5, 'src2')
      mockNow += HOUR_MS
      a.activate(0.7, 'src3')
      const records = cn.getActivationHistory('a', 0, mockNow + 1000)
      assert.equal(records.length, 3, '3 条 history')
      // 按 ts 升序
      assert.ok(records[0].ts <= records[1].ts && records[1].ts <= records[2].ts)
      // 包含 sourceId
      assert.deepEqual(records.map((r) => r.sourceId), ['src1', 'src2', 'src3'])
    })
  })

  test('fromT/toT 顺序无所谓（自动取 min/max）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a' })
      mockNow += 1000
      a.activate(0.5, 'src')
      const records1 = cn.getActivationHistory('a', 0, mockNow + 100)
      const records2 = cn.getActivationHistory('a', mockNow + 100, 0)
      assert.equal(records1.length, records2.length, 'fromT/toT 颠倒结果一致')
    })
  })

  test('不存在 id 返回空数组', () => {
    const cn = new CatsNet()
    assert.deepEqual(cn.getActivationHistory('nope', 0, 1e15), [])
  })

  test('非法 fromT/toT 抛 TypeError', () => {
    const cn = new CatsNet()
    assert.throws(() => cn.getActivationHistory('a', '0', 1), TypeError)
    assert.throws(() => cn.getActivationHistory('a', 0, NaN), TypeError)
  })
})
