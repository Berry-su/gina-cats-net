/**
 * CATS-Net L3 概念层次 (Y-03) —— 单元测试
 *
 * 覆盖：
 *   1) 构造与默认值（向后兼容：不传 level = 'semantic'）
 *   2) 显式指定 level（3 个合法值）
 *   3) 非法 level 抛 RangeError
 *   4) setLevel 切换 + history 记录
 *   5) getLevelTransitionWeight 查表：同层 = 1.0
 *   6) getLevelTransitionWeight 查表：episodic ↔ semantic = 0.5
 *   7) getLevelTransitionWeight 查表：semantic → abstract = 0.3
 *   8) getLevelTransitionWeight 查表：episodic → abstract = 0.2
 *   9) getLevelTransitionWeight 非法 level = 0
 *   10) spreadActivation 跨层 + hop decay 计算
 *   11) spreadActivation 非法 targetLevel = 0
 *   12) getConceptSphereData 返回结构 + 层统计
 *   13) getConceptSphereData 跨层边标注 levelTransition
 *   14) toJSON / fromJSON 往返保留 level
 *   15) merge 取较高抽象度一侧的 level
 *
 * 运行：node --test tests/test-concept-node-level.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ConceptNode,
  CONCEPT_LEVELS,
  CONCEPT_TYPES,
  LEVEL_TRANSITION_WEIGHTS,
  HOP_DECAY_FACTOR,
  getLevelTransitionWeight,
} from '../src/cats_net/index.js'

// ---------------------------------------------------------------------------
describe('ConceptNode.level —— 构造与默认值', () => {
  test('不传 level 时默认为 semantic（向后兼容）', () => {
    const n = new ConceptNode({ id: 'a' })
    assert.equal(n.level, 'semantic')
  })

  test('三个合法层次都接受', () => {
    for (const lvl of CONCEPT_LEVELS) {
      const n = new ConceptNode({ id: `n_${lvl}`, level: lvl })
      assert.equal(n.level, lvl)
    }
  })

  test('非法 level 抛 RangeError 并列出合法值', () => {
    assert.throws(
      () => new ConceptNode({ id: 'x', level: 'meta' }),
      (err) => err instanceof RangeError && /meta/.test(err.message) && /episodic, semantic, abstract/.test(err.message),
    )
  })

  test('CONCEPT_LEVELS 不可变', () => {
    assert.equal(Object.isFrozen(CONCEPT_LEVELS), true)
    assert.equal(CONCEPT_LEVELS.length, 3)
    assert.deepEqual([...CONCEPT_LEVELS], ['episodic', 'semantic', 'abstract'])
  })
})

// ---------------------------------------------------------------------------
describe('ConceptNode.setLevel —— 切换 + 审计', () => {
  test('setLevel 合法值切换并写入 history', () => {
    const n = new ConceptNode({ id: 'a', level: 'semantic' })
    n.setLevel('abstract')
    assert.equal(n.level, 'abstract')
    const last = n.history[n.history.length - 1]
    assert.equal(last.op, 'setLevel')
    assert.equal(last.from, 'semantic')
    assert.equal(last.to, 'abstract')
  })

  test('setLevel 非法值抛 RangeError', () => {
    const n = new ConceptNode({ id: 'a' })
    assert.throws(() => n.setLevel('imaginary'), RangeError)
    assert.equal(n.level, 'semantic') // 未变更
  })

  test('setLevel 同值不写 history（无操作幂等）', () => {
    const n = new ConceptNode({ id: 'a', level: 'semantic' })
    const histBefore = n.history.length
    n.setLevel('semantic')
    assert.equal(n.history.length, histBefore)
  })
})

// ---------------------------------------------------------------------------
describe('LEVEL_TRANSITION_WEIGHTS —— 跨层权重表', () => {
  test('同层 = 1.0', () => {
    for (const lvl of CONCEPT_LEVELS) {
      assert.equal(getLevelTransitionWeight(lvl, lvl), 1.0)
    }
  })

  test('episodic ↔ semantic = 0.5（双向对称）', () => {
    assert.equal(getLevelTransitionWeight('episodic', 'semantic'), 0.5)
    assert.equal(getLevelTransitionWeight('semantic', 'episodic'), 0.5)
  })

  test('semantic → abstract = 0.3', () => {
    assert.equal(getLevelTransitionWeight('semantic', 'abstract'), 0.3)
  })

  test('abstract → semantic = 0.3（对称）', () => {
    assert.equal(getLevelTransitionWeight('abstract', 'semantic'), 0.3)
  })

  test('episodic → abstract = 0.2（最远层衰减最大）', () => {
    assert.equal(getLevelTransitionWeight('episodic', 'abstract'), 0.2)
    assert.equal(getLevelTransitionWeight('abstract', 'episodic'), 0.2)
  })

  test('LEVEL_TRANSITION_WEIGHTS 表 9 项齐全', () => {
    assert.equal(Object.keys(LEVEL_TRANSITION_WEIGHTS).length, 9)
    assert.equal(Object.isFrozen(LEVEL_TRANSITION_WEIGHTS), true)
  })

  test('HOP_DECAY_FACTOR = 0.9', () => {
    assert.equal(HOP_DECAY_FACTOR, 0.9)
  })

  test('非法 level 查表返回 0', () => {
    assert.equal(getLevelTransitionWeight('imaginary', 'semantic'), 0)
    assert.equal(getLevelTransitionWeight('semantic', 'imaginary'), 0)
    assert.equal(getLevelTransitionWeight('imaginary', 'imaginary'), 0)
  })
})

// ---------------------------------------------------------------------------
describe('ConceptNode.spreadActivation —— 跨层扩散', () => {
  test('同层：effective = incoming × HOP_DECAY_FACTOR', () => {
    const n = new ConceptNode({ id: 'a', level: 'semantic' })
    const eff = n.spreadActivation('semantic', 1.0)
    assert.equal(eff, 0.9) // 1.0 × 0.9
  })

  test('episodic → semantic：0.5 × 0.9 = 0.45', () => {
    const n = new ConceptNode({ id: 'a', level: 'episodic' })
    const eff = n.spreadActivation('semantic', 1.0)
    assert.equal(eff, 0.45)
  })

  test('semantic → abstract：0.3 × 0.9 = 0.27', () => {
    const n = new ConceptNode({ id: 'a', level: 'semantic' })
    const eff = n.spreadActivation('abstract', 1.0)
    assert.equal(eff, 0.27)
  })

  test('episodic → abstract：0.2 × 0.9 = 0.18', () => {
    const n = new ConceptNode({ id: 'a', level: 'episodic' })
    const eff = n.spreadActivation('abstract', 1.0)
    assert.ok(Math.abs(eff - 0.18) < 1e-9, `expected 0.18, got ${eff}`)
  })

  test('incomingWeight 被裁剪到 [0,1]（防止外部注入负值或 >1）', () => {
    const n = new ConceptNode({ id: 'a', level: 'semantic' })
    // 同层 = 1.0 × 0.9 × 1.0（被 clamp 到 1.0）
    assert.equal(n.spreadActivation('semantic', 5), 0.9)
    // 负值被 clamp 到 0
    assert.equal(n.spreadActivation('semantic', -1), 0)
  })

  test('非法 targetLevel 返回 0 且写入 history', () => {
    const n = new ConceptNode({ id: 'a', level: 'semantic' })
    const histBefore = n.history.length
    const eff = n.spreadActivation('imaginary', 1.0)
    assert.equal(eff, 0)
    const last = n.history[n.history.length - 1]
    assert.equal(last.op, 'spreadActivation')
    assert.equal(last.rejected, true)
    assert.equal(n.history.length, histBefore + 1)
  })

  test('非法 incomingWeight 抛 TypeError', () => {
    const n = new ConceptNode({ id: 'a' })
    assert.throws(() => n.spreadActivation('semantic', 'foo'), TypeError)
    assert.throws(() => n.spreadActivation('semantic', NaN), TypeError)
  })

  test('调用方拿到 0.9 hop decay 后可继续累乘（2 hop）', () => {
    const a = new ConceptNode({ id: 'a', level: 'episodic' })
    const eff1 = a.spreadActivation('semantic', 1.0) // 0.5 × 0.9 = 0.45
    const b = new ConceptNode({ id: 'b', level: 'semantic' })
    const eff2 = b.spreadActivation('abstract', eff1) // 0.3 × 0.9 × 0.45 = 0.1215
    assert.ok(Math.abs(eff2 - 0.1215) < 1e-9)
  })
})

// ---------------------------------------------------------------------------
describe('ConceptNode.getConceptSphereData —— 3D 球数据后端', () => {
  function buildSpace() {
    const a = new ConceptNode({ id: 'risk', level: 'abstract', activation: 0.8, confidence: 0.9, granularity: 3 })
    const b = new ConceptNode({ id: 'stop_loss', type: 'action', level: 'semantic', activation: 0.5, confidence: 0.7, granularity: 1 })
    const c = new ConceptNode({ id: 'event_2026_09_01', level: 'episodic', activation: 0.3, confidence: 0.5, granularity: 0 })
    a.connect('b', 0.9, 'causal')
    b.connect('c', 0.6, 'association')
    return new Map([[a.id, a], [b.id, b], [c.id, c]])
  }

  test('返回 {nodes, edges, layers} 完整结构', () => {
    const data = ConceptNode.getConceptSphereData(buildSpace())
    assert.ok(Array.isArray(data.nodes))
    assert.ok(Array.isArray(data.edges))
    assert.ok(typeof data.layers === 'object')
    assert.equal(data.nodes.length, 3)
  })

  test('nodes 字段齐全：id/name/level/activation/confidence/granularity/type', () => {
    const data = ConceptNode.getConceptSphereData(buildSpace())
    const risk = data.nodes.find((n) => n.id === 'risk')
    assert.equal(risk.level, 'abstract')
    assert.equal(risk.activation, 0.8)
    assert.equal(risk.confidence, 0.9)
    assert.equal(risk.granularity, 3)
    assert.ok(risk.name)
    assert.ok(risk.type)
  })

  test('edges 标注 levelTransition', () => {
    const s1 = new ConceptNode({ id: 's1', level: 'semantic' })
    const s2 = new ConceptNode({ id: 's2', level: 'semantic' })
    const a = new ConceptNode({ id: 'a', level: 'abstract' })
    s1.connect('s2', 0.8, 'association')
    s1.connect('a', 0.7, 'hierarchical')
    const data2 = ConceptNode.getConceptSphereData(new Map([[s1.id, s1], [s2.id, s2], [a.id, a]]))
    const e1 = data2.edges.find((e) => e.source === 's1' && e.target === 's2')
    const e2 = data2.edges.find((e) => e.source === 's1' && e.target === 'a')
    assert.equal(e1.levelTransition, 1.0) // semantic → semantic
    assert.equal(e2.levelTransition, 0.3) // semantic → abstract
  })

  test('layers 统计：count + avgActivation', () => {
    const space = buildSpace()
    const data = ConceptNode.getConceptSphereData(space)
    assert.equal(data.layers.abstract.count, 1) // risk
    assert.equal(data.layers.semantic.count, 1) // stop_loss
    assert.equal(data.layers.episodic.count, 1) // event
    assert.equal(data.layers.abstract.avgActivation, 0.8)
    assert.equal(data.layers.episodic.avgActivation, 0.3)
  })

  test('空 Map 返回空数组 + 全 0 统计', () => {
    const data = ConceptNode.getConceptSphereData(new Map())
    assert.equal(data.nodes.length, 0)
    assert.equal(data.edges.length, 0)
    assert.equal(data.layers.episodic.count, 0)
    assert.equal(data.layers.semantic.count, 0)
    assert.equal(data.layers.abstract.count, 0)
    assert.equal(data.layers.episodic.avgActivation, 0)
  })

  test('接受数组输入', () => {
    const a = new ConceptNode({ id: 'a', level: 'semantic' })
    const b = new ConceptNode({ id: 'b', level: 'abstract' })
    a.connect('b', 0.5)
    const data = ConceptNode.getConceptSphereData([a, b])
    assert.equal(data.nodes.length, 2)
    assert.equal(data.edges.length, 1)
  })

  test('边去重：双向连接只记 1 条', () => {
    const a = new ConceptNode({ id: 'a', level: 'semantic' })
    const b = new ConceptNode({ id: 'b', level: 'semantic' })
    a.connect('b', 0.8, 'association', true) // bidirectional
    const data = ConceptNode.getConceptSphereData(new Map([[a.id, a], [b.id, b]]))
    assert.equal(data.edges.length, 1)
  })
})

// ---------------------------------------------------------------------------
describe('toJSON / fromJSON / merge —— 层次往返兼容', () => {
  test('toJSON 输出包含 level 字段', () => {
    const n = new ConceptNode({ id: 'a', level: 'abstract' })
    const json = n.toJSON()
    assert.equal(json.level, 'abstract')
  })

  test('fromJSON 旧数据无 level 回退到 semantic（向后兼容）', () => {
    const old = { id: 'a', type: 'abstract', activation: 0.5, confidence: 1, granularity: 1, attributes: {}, connections: [], history: [] }
    const n = ConceptNode.fromJSON(old)
    assert.equal(n.level, 'semantic')
  })

  test('fromJSON 显式 level 正确恢复', () => {
    const n = new ConceptNode({ id: 'a', level: 'episodic' })
    const restored = ConceptNode.fromJSON(n.toJSON())
    assert.equal(restored.level, 'episodic')
  })

  test('merge：取 granularity 较高一侧的 level', () => {
    const a = new ConceptNode({ id: 'a', level: 'episodic', granularity: 1, confidence: 1 })
    const b = new ConceptNode({ id: 'b', level: 'abstract', granularity: 3, confidence: 1 })
    const merged = a.merge(b)
    assert.equal(merged.level, 'abstract') // granularity 高的胜
  })

  test('merge：granularity 相同保留 a 的 level', () => {
    const a = new ConceptNode({ id: 'a', level: 'semantic', granularity: 2, confidence: 1 })
    const b = new ConceptNode({ id: 'b', level: 'episodic', granularity: 2, confidence: 1 })
    const merged = a.merge(b)
    assert.equal(merged.level, 'semantic')
  })
})
