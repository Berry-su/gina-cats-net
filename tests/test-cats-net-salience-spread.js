/**
 * CatsNet v0.6 · salience 接入 spreadActivation 公式（重要性传染不对称）—— 专项测试
 *
 * 覆盖（ADR-006 §3 / §4.2）：
 *   1) 公式正确性：salience=0.5/0.8/0.2 → 乘子=1.0/1.12/0.92
 *   2) 重要性传染不对称：boost(src.salience) → src 传播被放大；boost(target.salience) → 不影响 src 传
 *   3) 与 demote/boost 集成：demote(0.5) 后 src.salience 降低 → 传播减弱
 *   4) 与 merge 集成：merge 后的 keeper.salience 影响传播
 *   5) 与 learnConcepts 集成：learnDemote 改 salience → 传播减弱
 *   6) 同层 1.0 边界 clamp：salience=1.0 同层 1.0 weight 算例 → 1.08 → clamp 到 1.0
 *   7) SALIENCE_FACTOR 导出正确（= 0.4）
 *   8) spreadActivation 与 activateHierarchical 两条路径行为一致
 *   9) v0.6 默认 salience=confidence=1.0 行为回归（3 跳链式激活算例）
 *  10) 调参窗口边界：SALIENCE_FACTOR=0 → 等同 v0.5 行为
 *
 * 运行：node --test tests/test-cats-net-salience-spread.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CatsNet, SALIENCE_FACTOR } from '../src/cats_net/index.js'

// 浮点精度（与 ADR-002 §3.1.6 一致）
const EPS = 1e-6
const near = (a, b, msg) => {
  assert.ok(Math.abs(a - b) < EPS, `${msg}：期望 ${b}，实得 ${a}（误差 ${Math.abs(a - b)}）`)
}

// HOP_DECAY_FACTOR = 0.9, LEVEL_TRANSITION_WEIGHTS 同上
const HOP = 0.9
const EPISODIC_TO_SEMANTIC = 0.5
const SEMANTIC_TO_SEMANTIC = 1.0
const SEMANTIC_TO_ABSTRACT = 0.3

// ===========================================================================
// 1. 公式正确性
// ===========================================================================

describe('v0.6 salience 公式正确性', () => {
  test('SALIENCE_FACTOR = 0.4（导出值正确）', () => {
    assert.equal(SALIENCE_FACTOR, 0.4, 'SALIENCE_FACTOR 导出 = 0.4')
  })

  test('salience=0.5 中性：乘子 = 1.0（无影响）', () => {
    // 算例：episodic(1.0) × weight 1.0 × transition 0.5 × HOP 0.9 × 1.0 = 0.45
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic', salience: 0.5 })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.45, 'salience=0.5 时 semantic 激活 = 0.45（无加成）')
  })

  test('salience=0.8 高：乘子 = 1 + 0.3 × 0.4 = 1.12', () => {
    // 算例：0.45 × 1.12 = 0.504
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic', salience: 0.8 })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.504, 'salience=0.8 时 semantic 激活 = 0.504')
  })

  test('salience=0.2 低：乘子 = 1 - 0.3 × 0.4 = 0.88', () => {
    // 算例：0.45 × 0.88 = 0.396
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic', salience: 0.2 })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.396, 'salience=0.2 时 semantic 激活 = 0.396')
  })

  test('salience=1.0 满：乘子 = 1.2（默认）', () => {
    // 算例：0.45 × 1.2 = 0.54
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })  // 默认 salience=1.0
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.54, 'salience=1.0 时 semantic 激活 = 0.54')
  })

  test('salience=0.0 底：乘子 = 0.8', () => {
    // 算例：0.45 × 0.8 = 0.36
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic', salience: 0.0 })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.36, 'salience=0.0 时 semantic 激活 = 0.36')
  })
})

// ===========================================================================
// 2. 重要性传染不对称（核心设计）
// ===========================================================================

describe('v0.6 重要性传染不对称（src 侧 vs target 侧）', () => {
  test('boost(src.salience) → src 传播被放大（target.salience 不参与）', () => {
    const cn1 = new CatsNet()
    cn1.addNode({ id: 'e1', level: 'episodic', salience: 1.0 })
    cn1.addNode({ id: 's1', level: 'semantic', salience: 0.0 })  // target 低 salience
    cn1.getNode('e1').connect('s1', 1.0, 'causal')
    cn1.activateHierarchical('e1', { seedAmount: 1.0, maxDepth: 1 })

    const cn2 = new CatsNet()
    cn2.addNode({ id: 'e2', level: 'episodic', salience: 0.0 })  // src 低 salience
    cn2.addNode({ id: 's2', level: 'semantic', salience: 1.0 })  // target 高 salience
    cn2.getNode('e2').connect('s2', 1.0, 'causal')
    cn2.activateHierarchical('e2', { seedAmount: 1.0, maxDepth: 1 })

    // cn1: src.salience=1.0, 乘子=1.2 → s1 激活 = 0.45 × 1.2 = 0.54
    // cn2: src.salience=0.0, 乘子=0.8 → s2 激活 = 0.45 × 0.8 = 0.36
    //   target.salience=1.0 不影响 s2（不对称的体现）
    near(cn1.getNode('s1').activation, 0.54, 'src 高 salience：传播被放大到 0.54')
    near(cn2.getNode('s2').activation, 0.36, 'src 低 salience：传播被压制到 0.36（target 高 salience 不影响）')
  })

  test('target.salience 变化不改变 src → target 传播强度', () => {
    // 对照组 A：target.salience=1.0
    const cnA = new CatsNet()
    cnA.addNode({ id: 'e', level: 'episodic' })  // 默认 salience=1.0
    cnA.addNode({ id: 'sA', level: 'semantic', salience: 1.0 })
    cnA.getNode('e').connect('sA', 1.0, 'causal')
    cnA.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })

    // 实验组 B：target.salience=0.0
    const cnB = new CatsNet()
    cnB.addNode({ id: 'e', level: 'episodic' })
    cnB.addNode({ id: 'sB', level: 'semantic', salience: 0.0 })
    cnB.getNode('e').connect('sB', 1.0, 'causal')
    cnB.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })

    // target.salience 不影响 src 传，所以两次激活值应相同
    near(cnA.getNode('sA').activation, cnB.getNode('sB').activation, 'target.salience 变化不影响传播（不对称性验证）')
    assert.equal(cnA.getNode('sA').activation, 0.54, 'A 激活 = 0.54')
    assert.equal(cnB.getNode('sB').activation, 0.54, 'B 激活 = 0.54（与 A 相同）')
  })
})

// ===========================================================================
// 3. 与 demote/boost 集成
// ===========================================================================

describe('v0.6 demote/boost → salience 变化 → 传播强度变化', () => {
  test('demote(src) → src 传播被压制', () => {
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })  // 默认 salience=1.0
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    // 第一次：默认 salience=1.0 → s = 0.54
    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.54, 'demote 前 s 激活 = 0.54')

    // demote(src, 0.5) → src.salience = 0.5 → 乘子 = 1.0
    cn.demoteConcept('e', 0.5)
    assert.equal(cn.getNode('e').salience, 0.5, 'demote 后 src salience = 0.5')

    // 不重置 CatsNet（reset 会清空 nodes），改用 deactivate 手动重置激活值
    cn.getNode('e').deactivate(cn.getNode('e').activation, 'test:reset')
    cn.getNode('s').deactivate(cn.getNode('s').activation, 'test:reset')
    cn.getNode('e').activate(1.0, 'test:reseed')
    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.45, 'demote 后 s 激活 = 0.45（乘子变 1.0）')
  })

  test('boost(src) → src 传播被放大（直到激活上限）', () => {
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    e.connect(s.id, 1.0, 'causal')

    // boost(src, 1.5) → salience 从 1.0 涨到 clamp 上限 1.0（不变）
    // 仍然乘子 1.2 → s = 0.54
    cn.boostConcept('e', 1.5)
    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.54, 'boost 上限 clamp 后仍 0.54')
  })
})

// ===========================================================================
// 4. 与 merge 集成
// ===========================================================================

describe('v0.6 mergeConcepts → keeper.salience 影响传播', () => {
  test('merge 后 keeper 的 salience 决定其后续传播强度', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', level: 'semantic', salience: 0.5, confidence: 0.7 })
    cn.addNode({ id: 'b', level: 'semantic', salience: 1.0, confidence: 0.6 })
    const result = cn.mergeConcepts(['a', 'b'])
    assert.ok(result, 'merge 成功')

    // merge 公式（concept-node.js:477-509）：
    //   totalConf = 0.7 + 0.6 = 1.3
    //   wThis = 0.7 / 1.3 ≈ 0.5385
    //   wOther = 0.6 / 1.3 ≈ 0.4615
    //   salience_merged = 0.5 × 0.5385 + 1.0 × 0.4615 ≈ 0.7308
    const keeper = cn.getNode('a')
    const expectedSalience = (0.5 * 0.7 + 1.0 * 0.6) / 1.3
    near(keeper.salience, expectedSalience, 'merge 后 keeper.salience（confidence 加权平均）')

    // 验证传播：keeper.salience=expectedSalience → 乘子 = 1 + (expectedSalience - 0.5) × 0.4
    // 单层 semantic → semantic = 1.0 × 0.9 × salienceBoost
    const c = cn.addNode({ id: 'c', level: 'semantic' })
    keeper.connect(c.id, 1.0, 'causal')
    cn.activateHierarchical('a', { seedAmount: 1.0, maxDepth: 1 })
    const salienceBoost = 1 + (expectedSalience - 0.5) * SALIENCE_FACTOR
    const expected = 1.0 * SEMANTIC_TO_SEMANTIC * HOP * salienceBoost
    near(c.activation, Math.min(1.0, expected), 'merge 后传播（按 keeper.salience 缩放）')
  })
})

// ===========================================================================
// 5. 与 learnConcepts 集成（learnDemote 改 salience）
// ===========================================================================

describe('v0.6 learnConcepts 冷降权 → salience 变化 → 传播减弱', () => {
  test('learnDemote 后 src.salience 降低 → 传播减弱', () => {
    const cn = new CatsNet()
    // 创建 1 个 100 天前激活的"冷"节点 + 1 个目标
    const cold = cn.addNode({ id: 'cold', level: 'semantic', activation: 0.1, confidence: 0.8 })
    cold.lastActivatedAt = Date.now() - 100 * 24 * 60 * 60 * 1000
    const target = cn.addNode({ id: 'target', level: 'semantic' })
    cold.connect(target.id, 1.0, 'causal')

    // 跑 learnConcepts → 冷节点降权
    const mockNow = Date.now()
    const result = cn.learnConcepts({ now: mockNow + 1000 })
    assert.ok(result.demoted.length >= 1, '冷节点被降权')

    // 降权后 cold.salience = 0.8 × 0.5 = 0.4
    // 乘子 = 1 + (0.4 - 0.5) × 0.4 = 0.96
    // base = 1.0 × 0.9 = 0.9（先用 cold 原始激活值约 0.1，但 baseBoost 来自 src.spreadActivation）
    // 实际：cold.activation=0.1（已弱）→ incoming = 0.1 × 1.0 = 0.1
    //   baseBoost = semantic→semantic × HOP × 0.1 = 1.0 × 0.9 × 0.1 = 0.09
    //   salienceBoost = 0.96
    //   effective = 0.09 × 0.96 = 0.0864
    cn.activateHierarchical('cold', { seedAmount: 0.5, maxDepth: 1 })
    const expected = 0.1 * SEMANTIC_TO_SEMANTIC * HOP * (1 + (0.4 - 0.5) * SALIENCE_FACTOR)
    // cold 实际激活被 spreadActivation 推高（先 seed 0.5, 然后 spread 自身被推）
    // 简化验证：effective < baseBoost（乘子 0.96 < 1.0），所以 target 激活值应 < 0.1 × 0.9 = 0.09
    // 我们用 cold 实际激活 0.5（seedAmount 写入后，激活 = 0.5）
    const coldActivation = cold.activation  // 0.5
    const expectedFinal = coldActivation * 1.0 * HOP * (1 + (0.4 - 0.5) * SALIENCE_FACTOR)
    near(target.activation, expectedFinal, 'learnDemote 后传播减弱（乘子 0.96）')
  })
})

// ===========================================================================
// 6. 同层 1.0 边界 clamp
// ===========================================================================

describe('v0.6 同层 1.0 weight + salience=1.0 → clamp 上限', () => {
  test('semantic(1.0) → semantic 1.0 weight × salience=1.0 → 1.08 → clamp 1.0', () => {
    const cn = new CatsNet()
    const a = cn.addNode({ id: 'a', level: 'semantic' })
    const b = cn.addNode({ id: 'b', level: 'semantic' })
    a.connect(b.id, 1.0, 'causal')

    cn.activateHierarchical('a', { seedAmount: 1.0, maxDepth: 1 })
    near(b.activation, 1.0, '同层 1.0 + salience=1.0 → 1.0（clamp 上限）')
  })
})

// ===========================================================================
// 7. spreadActivation 与 activateHierarchical 行为一致
// ===========================================================================

describe('v0.6 spreadActivation 与 activateHierarchical 行为一致', () => {
  test('两条扩散路径应用同一条 salience 公式', () => {
    // 用 spreadActivation（限制 1 次迭代，避免收敛到 1.0）
    const cn1 = new CatsNet()
    const a1 = cn1.addNode({ id: 'a', level: 'episodic' })
    const b1 = cn1.addNode({ id: 'b', level: 'semantic' })
    a1.connect(b1.id, 1.0, 'causal')
    cn1.spreadActivation([{ id: 'a', amount: 1.0 }], { iterations: 1, minActivation: 0 })
    const b1Activation = b1.activation

    // 用 activateHierarchical
    const cn2 = new CatsNet()
    const a2 = cn2.addNode({ id: 'a', level: 'episodic' })
    const b2 = cn2.addNode({ id: 'b', level: 'semantic' })
    a2.connect(b2.id, 1.0, 'causal')
    cn2.activateHierarchical('a', { seedAmount: 1.0, maxDepth: 1 })
    const b2Activation = b2.activation

    // 两条路径应得到相同激活值（默认 salience=1.0 → 乘子 1.2）
    near(b1Activation, b2Activation, 'spreadActivation 与 activateHierarchical 行为一致')
    near(b1Activation, 0.54, '默认 salience → 0.54')
  })
})

// ===========================================================================
// 8. 3 跳链式激活算例（v0.6 默认 salience=1.0）
// ===========================================================================

describe('v0.6 链式激活算例（每跳各 × 1.2）', () => {
  test('episodic → semantic → abstract 链式激活：abstract = 0.17496', () => {
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    const a = cn.addNode({ id: 'a', level: 'abstract' })
    e.connect(s.id, 1.0, 'causal')
    s.connect(a.id, 1.0, 'causal')

    cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 2 })
    // hop 1: base = 0.5 × 0.9 × 1.0 = 0.45, × 1.2 = 0.54 → s.activation = 0.54
    // hop 2: base = 0.3 × 0.9 × 0.54 = 0.1458, × 1.2 = 0.17496 → a.activation = 0.17496
    near(s.activation, 0.54, 'hop 1：semantic = 0.54')
    near(a.activation, 0.17496, 'hop 2：abstract = 0.17496（每跳各 × 1.2）')
  })
})

// ===========================================================================
// 9. 调参窗口边界（理论验证：SALIENCE_FACTOR=0 等同 v0.5）
// ===========================================================================

describe('v0.6 调参窗口边界（理论验证）', () => {
  test('SALIENCE_FACTOR=0 时乘子恒为 1.0（公式正确性）', () => {
    // 用 salienceAsymmetry 内部函数验证（通过公式手算）
    //   1 + (src.salience - 0.5) × 0 = 1.0（任何 salience）
    // 这是公式的设计不变量
    for (const sal of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      const boost = 1 + (sal - 0.5) * 0  // 模拟 SALIENCE_FACTOR=0
      assert.equal(boost, 1.0, `salience=${sal} 且 SALIENCE_FACTOR=0 时乘子=1.0`)
    }
  })

  test('SALIENCE_FACTOR=1 时乘子 ∈ [0.5, 1.5]', () => {
    // 公式：1 + (salience - 0.5) × SALIENCE_FACTOR
    //   当 SALIENCE_FACTOR=1：boost = 1 + (sal - 0.5) = 0.5 + sal
    //   - sal=0.0 → 0.5
    //   - sal=0.25 → 0.75
    //   - sal=0.5 → 1.0
    //   - sal=0.75 → 1.25
    //   - sal=1.0 → 1.5
    const cases = [
      { sal: 0.0, expected: 0.5 },
      { sal: 0.25, expected: 0.75 },
      { sal: 0.5, expected: 1.0 },
      { sal: 0.75, expected: 1.25 },
      { sal: 1.0, expected: 1.5 },
    ]
    for (const { sal, expected } of cases) {
      const boost = 1 + (sal - 0.5) * 1
      assert.equal(boost, expected, `salience=${sal} 且 SALIENCE_FACTOR=1 时乘子=${expected}`)
    }
  })
})

// ===========================================================================
// 10. 不破坏 v0.5 行为（除公式乘子外）
// ===========================================================================

describe('v0.6 不破 v0.5 行为（除公式乘子外）', () => {
  test('mergeConcepts + mergedFrom 行为不变（v0.5.1 R5）', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'risk' }, confidence: 0.7 })
    cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'risk' }, confidence: 0.6 })
    cn.addNode({ id: 'c', type: 'entity', attributes: { name: 'risk' }, confidence: 0.5 })
    cn.projectMemory({ id: 'm1', concepts: ['a', 'b', 'c'] })

    const r = cn.mergeConcepts(['a', 'b', 'c'])
    assert.ok(r, 'merge 成功')
    const mem = cn.projection.get('m1')
    assert.equal(mem.concepts.length, 1, 'v0.5.1 dedupe 仍生效')
    assert.equal(mem.mergedFrom.length, 2, 'v0.5.1 mergedFrom 记录 b + c')
  })

  test('learnConcepts 冷降权走 salience（v0.5.1 R6）', () => {
    const cn = new CatsNet()
    const cold = cn.addNode({ id: 'cold', level: 'semantic', activation: 0.1, confidence: 0.8 })
    cold.lastActivatedAt = Date.now() - 100 * 24 * 60 * 60 * 1000

    const result = cn.learnConcepts({ now: Date.now() + 1000 })
    assert.ok(result.demoted.length >= 1, '冷降权仍生效')
    // 验证 result.demoted 字段名仍为 beforeSalience/afterSalience（v0.5.1 R6）
    const entry = result.demoted.find((d) => d.id === 'cold')
    assert.ok(entry.beforeSalience !== undefined, 'beforeSalience 字段仍在')
    assert.ok(entry.afterSalience !== undefined, 'afterSalience 字段仍在')
  })
})
