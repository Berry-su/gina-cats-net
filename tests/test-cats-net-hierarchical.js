/**
 * CatsNet.activateHierarchical / spreadActivation 跨层权重收口（C-1.1）—— 集成测试
 *
 * 覆盖（ADR-002 §3.1.5）：
 *   1) 跨层权重生效：episodic(1.0) → semantic = 0.54（v0.6 salience=1.0 乘子 1.2），
 *      semantic(0.54) → abstract = 0.17496（每跳各 × 1.2）
 *   2) 同层 1.0 权重传播不退化：semantic → semantic 应保持 0.9 × 1.2 = 1.08 → clamp 到 1.0
 *   3) 深度超限终止：maxDepth=2 时 3 层链式扩散应停在第 2 层
 *   4) getLevelActivationSummary 按层统计
 *   5) levels 选项限定：exclude semantic 时不跨入 semantic
 *   6) 不存在的 rootId：安全返回空结果
 *
 * v0.6 算例更新（ADR-006 §4.3）：默认 salience=confidence=1.0，乘子=1 + (1.0-0.5)×0.4 = 1.2
 *   - 0.45 → 0.54
 *   - 0.1215 → 0.17496
 *   - 0.9 → 1.0（clamp）
 *
 * 运行：node --test tests/test-cats-net-hierarchical.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CatsNet, CONCEPT_LEVELS, HOP_DECAY_FACTOR, LEVEL_TRANSITION_WEIGHTS } from '../src/cats_net/index.js'

// 跨层权重精确值（与 ADR-002 §3.1.5 算例一致）
const EPISODIC_TO_SEMANTIC = LEVEL_TRANSITION_WEIGHTS['episodic→semantic'] // 0.5
const SEMANTIC_TO_ABSTRACT = LEVEL_TRANSITION_WEIGHTS['semantic→abstract'] // 0.3
const SEMANTIC_TO_SEMANTIC = LEVEL_TRANSITION_WEIGHTS['semantic→semantic'] // 1.0

// 允许浮点误差
const EPS = 1e-6
const near = (a, b, msg) => {
  assert.ok(Math.abs(a - b) < EPS, `${msg}：期望 ${b}，实得 ${a}（误差 ${Math.abs(a - b)}）`)
}

// ---------------------------------------------------------------------------
describe('CatsNet.activateHierarchical —— C-1.1 跨层激活扩散', () => {
  test('跨层权重生效：episodic(1.0) → semantic = 0.54，再 → abstract ≈ 0.17496（v0.6 salience × 1.2）', () => {
    const cn = new CatsNet()
    const episodic = cn.addNode({ id: 'evt_1', name: '昨日跌停', level: 'episodic' })
    const semantic = cn.addNode({ id: 'vol', name: '波动', level: 'semantic' })
    const abstract = cn.addNode({ id: 'risk', name: '风险', level: 'abstract' })
    episodic.connect(semantic.id, 1.0, 'causal')
    semantic.connect(abstract.id, 1.0, 'causal')

    const result = cn.activateHierarchical('evt_1', { seedAmount: 1.0 })

    // v0.6 算例：episodic(1.0) × weight 1.0 × transition 0.5 × HOP 0.9 × salienceBoost 1.2 = 0.54
    near(semantic.activation, 0.54, 'semantic 激活值（v0.6 salience × 1.2）')
    // v0.6 算例：semantic(0.54) × weight 1.0 × transition 0.3 × HOP 0.9 × salienceBoost 1.2 = 0.17496
    near(
      abstract.activation,
      EPISODIC_TO_SEMANTIC * HOP_DECAY_FACTOR * SEMANTIC_TO_ABSTRACT * HOP_DECAY_FACTOR * 1.2 * 1.2,
      'abstract 激活值（v0.6 每跳各 × 1.2）',
    )

    // layers 分组正确
    assert.deepEqual(result.layers.episodic.sort(), ['evt_1'])
    assert.deepEqual(result.layers.semantic.sort(), ['vol'])
    assert.deepEqual(result.layers.abstract.sort(), ['risk'])
    assert.equal(result.activated.length, 3)
    // trace 含全部 3 节点 + 每节点带 hopPath
    assert.equal(result.trace.length, 3)
    for (const t of result.trace) {
      assert.ok(t.nodeId && t.level && typeof t.activation === 'number' && Array.isArray(t.hopPath))
    }
    // hopPath 包含根节点 + 自身
    const rootTrace = result.trace.find((t) => t.nodeId === 'evt_1')
    assert.deepEqual(rootTrace.hopPath, ['evt_1'])
  })

  test('同层 1.0 权重传播：semantic → semantic = 1.0（v0.6 × 1.2 → clamp 上限）', () => {
    const cn = new CatsNet()
    const a = cn.addNode({ id: 'a', level: 'semantic' })
    const b = cn.addNode({ id: 'b', level: 'semantic' })
    a.connect(b.id, 1.0, 'causal')

    cn.activateHierarchical('a', { seedAmount: 1.0, maxDepth: 1 })

    // v0.6 算例：semantic(1.0) × weight 1.0 × transition 1.0 × HOP 0.9 × salienceBoost 1.2 = 1.08
    //   → target.activate() clamp 到 [0,1] → 终值 1.0
    near(b.activation, 1.0, 'semantic → semantic 激活值（v0.6 clamp 上限）')
  })

  test('深度超限终止：maxDepth=2 时 3 层链式扩散停在第 2 层（v0.6 算例）', () => {
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    const a = cn.addNode({ id: 'a', level: 'abstract' })
    e.connect(s.id, 1.0, 'causal')
    s.connect(a.id, 1.0, 'causal')

    // maxDepth=1 只允许一层扩散（root 自身 + 1 跳），s 应激活，a 不应激活
    const r1 = cn.activateHierarchical('e', { seedAmount: 1.0, maxDepth: 1 })
    near(s.activation, 0.54, 'maxDepth=1 时 s 仍激活（v0.6 × 1.2）')
    assert.equal(a.activation, 0, 'maxDepth=1 时 a 不应激活')
    assert.equal(r1.activated.length, 2, 'maxDepth=1 激活 2 节点')

    // 重置后再跑 maxDepth=2
    cn.reset()
    cn.addNode({ id: 'e2', level: 'episodic' })
    cn.addNode({ id: 's2', level: 'semantic' })
    cn.addNode({ id: 'a2', level: 'abstract' })
    const e2 = cn.getNode('e2')
    const s2 = cn.getNode('s2')
    const a2 = cn.getNode('a2')
    e2.connect(s2.id, 1.0, 'causal')
    s2.connect(a2.id, 1.0, 'causal')
    cn.activateHierarchical('e2', { seedAmount: 1.0, maxDepth: 2 })
    near(s2.activation, 0.54, 'maxDepth=2 时 s2 仍激活（v0.6 × 1.2）')
    near(a2.activation, 0.17496, 'maxDepth=2 时 a2 应激活（v0.6 每跳各 × 1.2）')
  })

  test('levels 选项限定：仅 episodic + abstract 时不跨入 semantic', () => {
    const cn = new CatsNet()
    const e = cn.addNode({ id: 'e', level: 'episodic' })
    const s = cn.addNode({ id: 's', level: 'semantic' })
    const a = cn.addNode({ id: 'a', level: 'abstract' })
    e.connect(s.id, 1.0, 'causal')
    s.connect(a.id, 1.0, 'causal')

    const result = cn.activateHierarchical('e', { levels: ['episodic', 'abstract'], seedAmount: 1.0 })
    // s 不在 allowedLevels，不应被激活
    assert.equal(s.activation, 0, '限定 levels 排除 semantic 时 s 不应激活')
    // a 也不应激活（因为 s 是中间跳，被排除）
    assert.equal(a.activation, 0, '限定 levels 排除 semantic 时 a 不应激活')
    assert.equal(result.activated.length, 1, '仅 e 被激活')
  })

  test('getLevelActivationSummary 按层统计 count / totalActivation / avgActivation', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'e1', level: 'episodic' }).activate(0.3, 'test')
    cn.addNode({ id: 'e2', level: 'episodic' }).activate(0.5, 'test')
    cn.addNode({ id: 's1', level: 'semantic' }).activate(0.7, 'test')
    cn.addNode({ id: 'a1', level: 'abstract' }).activate(0.2, 'test')
    cn.addNode({ id: 'a2', level: 'abstract' }).activate(0.4, 'test')

    const summary = cn.getLevelActivationSummary()
    assert.equal(summary.episodic.count, 2)
    near(summary.episodic.totalActivation, 0.8, 'episodic totalActivation')
    near(summary.episodic.avgActivation, 0.4, 'episodic avgActivation')
    assert.equal(summary.semantic.count, 1)
    near(summary.semantic.totalActivation, 0.7, 'semantic totalActivation')
    assert.equal(summary.abstract.count, 2)
    near(summary.abstract.totalActivation, 0.6, 'abstract totalActivation')
    near(summary.abstract.avgActivation, 0.3, 'abstract avgActivation')
  })

  test('不存在的 rootId：安全返回空结果（不抛错）', () => {
    const cn = new CatsNet()
    const result = cn.activateHierarchical('nonexistent')
    assert.deepEqual(result.activated, [])
    assert.deepEqual(result.layers, { episodic: [], semantic: [], abstract: [] })
    assert.deepEqual(result.trace, [])
  })

  test('CONCEPT_LEVELS 与 ADR-002 §3.1.1 一致：episodic / semantic / abstract', () => {
    assert.deepEqual([...CONCEPT_LEVELS], ['episodic', 'semantic', 'abstract'])
  })
})
