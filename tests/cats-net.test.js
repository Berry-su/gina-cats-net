/**
 * CATS-Net 抽象空间内核 —— 单元测试
 *
 * 运行：node --test tests/cats-net.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CatsNet,
  ConceptNode,
  ConflictResolver,
  Serializer,
  MemoryProjection,
  CONFLICT_TYPES,
  RESOLUTION_STRATEGIES,
} from '../src/cats_net/index.js'

// ---------------------------------------------------------------------------
describe('ConceptNode —— 概念抽象节点', () => {
  test('构造与默认值', () => {
    const n = new ConceptNode({ id: 'x' })
    assert.equal(n.id, 'x')
    assert.equal(n.name, 'x')
    assert.equal(n.type, 'abstract')
    assert.equal(n.activation, 0)
    assert.equal(n.confidence, 1)
  })

  test('非法 id 抛异常', () => {
    assert.throws(() => new ConceptNode({ id: '' }), TypeError)
  })

  test('非法 type 抛异常', () => {
    assert.throws(() => new ConceptNode({ id: 'x', type: 'unknown' }), RangeError)
  })

  test('激活裁剪到 [0,1]', () => {
    const n = new ConceptNode({ id: 'x' })
    n.activate(5)
    assert.equal(n.activation, 1)
    n.deactivate(10)
    assert.equal(n.activation, 0)
  })

  test('时间衰减降低激活与置信度', () => {
    const n = new ConceptNode({ id: 'x', activation: 1, confidence: 1 })
    const before = { activation: n.activation, confidence: n.confidence }
    n.decay(0.5)
    assert.ok(n.activation < before.activation)
    assert.ok(n.confidence < before.confidence)
  })

  test('连接管理与自连接保护', () => {
    const n = new ConceptNode({ id: 'x' })
    n.connect('y', 0.5)
    assert.equal(n.getWeight('y'), 0.5)
    assert.equal(n.getConnections().length, 1)
    assert.throws(() => n.connect('x'), Error)
    n.disconnect('y')
    assert.equal(n.getWeight('y'), 0)
  })

  test('语义相似度：相同概念为 1，不同概念较小', () => {
    const a = new ConceptNode({ id: 'a', type: 'entity', attributes: { label: 'apple', score: 0.5 } })
    const b = new ConceptNode({ id: 'b', type: 'entity', attributes: { label: 'apple', score: 0.5 } })
    const c = new ConceptNode({ id: 'c', type: 'action', attributes: { verb: 'run' } })
    assert.equal(a.similarity(b), 1)
    assert.ok(a.similarity(c) < a.similarity(b))
  })

  test('属性矛盾检测', () => {
    const a = new ConceptNode({ id: 'a', attributes: { color: 'red', size: 1 } })
    const b = new ConceptNode({ id: 'b', attributes: { color: 'blue', size: 3 } })
    const conflicts = a.findAttributeConflicts(b)
    assert.equal(conflicts.length, 2)
  })

  test('融合：数值加权平均 + 连接并集', () => {
    const a = new ConceptNode({ id: 'a', confidence: 1, attributes: { v: 10 } })
    const b = new ConceptNode({ id: 'b', confidence: 1, attributes: { v: 20 } })
    a.connect('other', 0.5)
    b.connect('other', 0.7)
    const merged = a.merge(b)
    assert.equal(merged.attributes.v, 15) // (10+20)/2
    assert.ok(Math.abs(merged.getWeight('other') - 0.6) < 1e-9) // (0.5+0.7)/2
  })

  test('toJSON / fromJSON 往返', () => {
    const n = new ConceptNode({ id: 'x', name: '概念', attributes: { a: 1 }, activation: 0.3 })
    n.connect('y', 0.8)
    const restored = ConceptNode.fromJSON(n.toJSON())
    assert.equal(restored.id, 'x')
    assert.equal(restored.name, '概念')
    assert.equal(restored.activation, 0.3)
    assert.equal(restored.getWeight('y'), 0.8)
    assert.deepEqual(restored.attributes, { a: 1 })
  })
})

// ---------------------------------------------------------------------------
describe('ConflictResolver —— 冲突消解', () => {
  function twoSimilarNodes() {
    const a = new ConceptNode({ id: 'a', type: 'entity', attributes: { label: 'x', v: 1 } })
    const b = new ConceptNode({ id: 'b', type: 'entity', attributes: { label: 'x', v: 1 } })
    return [a, b]
  }

  test('检测语义重叠', () => {
    const [a, b] = twoSimilarNodes()
    const resolver = new ConflictResolver()
    const nodes = new Map([[a.id, a], [b.id, b]])
    const conflicts = resolver.detectConflicts(nodes)
    assert.ok(conflicts.some((c) => c.type === CONFLICT_TYPES.SEMANTIC_OVERLAP))
  })

  test('检测属性矛盾', () => {
    const a = new ConceptNode({ id: 'a', type: 'entity', attributes: { color: 'red' } })
    const b = new ConceptNode({ id: 'b', type: 'entity', attributes: { color: 'blue' } })
    const resolver = new ConflictResolver()
    const conflicts = resolver.detectConflicts(new Map([[a.id, a], [b.id, b]]))
    assert.ok(conflicts.some((c) => c.type === CONFLICT_TYPES.ATTRIBUTE_CONTRADICTION))
  })

  test('检测激活竞争', () => {
    const a = new ConceptNode({ id: 'a', activation: 0.5 })
    const b = new ConceptNode({ id: 'b', activation: 0.52 })
    const shared = new ConceptNode({ id: 'shared' })
    a.connect('shared', 0.5)
    b.connect('shared', 0.5)
    const resolver = new ConflictResolver()
    const conflicts = resolver.detectConflicts(new Map([[a.id, a], [b.id, b], [shared.id, shared]]))
    assert.ok(conflicts.some((c) => c.type === CONFLICT_TYPES.ACTIVATION_RIVALRY))
  })

  test('检测连接不一致', () => {
    const a = new ConceptNode({ id: 'a' })
    const b = new ConceptNode({ id: 'b' })
    a.connect('b', 1.0)
    b.connect('a', 0.1)
    const resolver = new ConflictResolver()
    const conflicts = resolver.detectConflicts(new Map([[a.id, a], [b.id, b]]))
    assert.ok(conflicts.some((c) => c.type === CONFLICT_TYPES.CONNECTION_INCONSISTENCY))
  })

  test('语义重叠消解 -> 融合并删除冗余节点', () => {
    const [a, b] = twoSimilarNodes()
    const resolver = new ConflictResolver()
    const nodes = new Map([[a.id, a], [b.id, b]])
    const result = resolver.resolveAll(nodes)
    assert.ok(result.resolved >= 1)
    // 融合后只剩一个节点
    assert.equal(nodes.size, 1)
  })

  test('单次消解上限作为死循环保护', () => {
    const [a, b] = twoSimilarNodes()
    const resolver = new ConflictResolver()
    const nodes = new Map([[a.id, a], [b.id, b]])
    const result = resolver.resolveAll(nodes, { maxResolutions: 0 })
    assert.equal(result.resolved, 0)
    assert.ok(result.skipped >= 1)
    assert.equal(nodes.size, 2) // 未发生消解
  })
})

// ---------------------------------------------------------------------------
describe('Serializer —— 持久化序列化', () => {
  function sampleSnapshot() {
    const node = new ConceptNode({ id: 'x', activation: 0.5 })
    return { nodes: [node.toJSON()], memory: [], meta: {} }
  }

  test('serialize 注入 format/version/savedAt', () => {
    const s = new Serializer()
    const out = s.serialize(sampleSnapshot())
    assert.equal(out.format, 'cats-net')
    assert.equal(out.version, '1.0.0')
    assert.ok(out.savedAt)
  })

  test('validate 拒绝错误 format', () => {
    const s = new Serializer()
    const { valid, errors } = s.validate({ format: 'wrong', version: '1.0.0', nodes: [] })
    assert.equal(valid, false)
    assert.ok(errors.length > 0)
  })

  test('deserialize 恢复为 ConceptNode 实例', () => {
    const s = new Serializer()
    const snap = s.serialize(sampleSnapshot())
    const restored = s.deserialize(snap)
    assert.ok(restored.nodes instanceof Map)
    assert.ok(restored.nodes.get('x') instanceof ConceptNode)
    assert.equal(restored.nodes.get('x').activation, 0.5)
  })

  test('saveToFile / loadFromFile 原子往返', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'catsnet-'))
    try {
      const s = new Serializer()
      const file = join(tmp, 'snapshot.json')
      s.saveToFile(file, sampleSnapshot())
      const restored = s.loadFromFile(file)
      assert.equal(restored.nodes.size, 1)
      assert.ok(restored.nodes.get('x') instanceof ConceptNode)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
describe('MemoryProjection —— 记忆投影', () => {
  function space() {
    const m = new Map()
    for (const id of ['risk', 'stop_loss', 'position']) {
      m.set(id, new ConceptNode({ id }))
    }
    return m
  }

  test('project 形成记忆痕迹并激发概念', () => {
    const sp = space()
    const mp = new MemoryProjection()
    const entry = mp.project(
      { label: '风控', concepts: ['risk', 'stop_loss'], strength: 0.8 },
      sp,
    )
    assert.equal(mp.size, 1)
    assert.equal(entry.concepts.length, 2)
    assert.ok(sp.get('risk').activation > 0)
  })

  test('retrieve 按重叠度排序', () => {
    const sp = space()
    const mp = new MemoryProjection()
    mp.project({ id: 'm1', label: '全相关', concepts: ['risk', 'stop_loss'], strength: 0.8 }, sp)
    mp.project({ id: 'm2', label: '部分相关', concepts: ['risk'], strength: 0.8 }, sp)
    const results = mp.retrieve(['risk', 'stop_loss'])
    assert.ok(results.length >= 2)
    // 覆盖更多查询概念的记忆排前面
    assert.equal(results[0].entry.id, 'm1')
  })

  test('reinforce 强化', () => {
    const sp = space()
    const mp = new MemoryProjection()
    mp.project({ id: 'm', concepts: ['risk'], strength: 0.5 }, sp)
    mp.reinforce('m', 0.3)
    assert.equal(mp.get('m').strength, 0.8)
  })

  test('decayAll 遗忘过弱记忆', () => {
    const sp = space()
    const mp = new MemoryProjection({ minStrength: 0.9 })
    mp.project({ id: 'weak', concepts: ['risk'], strength: 0.1 }, sp)
    mp.decayAll()
    assert.equal(mp.size, 0) // 过弱记忆被遗忘
  })

  test('toJSON / fromJSON 往返', () => {
    const sp = space()
    const mp = new MemoryProjection()
    mp.project({ id: 'm', label: '风控', concepts: ['risk', 'stop_loss'] }, sp)
    const mp2 = new MemoryProjection()
    mp2.fromJSON(mp.toJSON())
    assert.equal(mp2.size, 1)
    assert.equal(mp2.get('m').label, '风控')
  })
})

// ---------------------------------------------------------------------------
describe('CatsNet —— 内核主类', () => {
  test('节点生命周期管理', () => {
    const brain = new CatsNet()
    brain.addNode({ id: 'a' })
    assert.ok(brain.hasNode('a'))
    assert.ok(brain.getNode('a') instanceof ConceptNode)
    assert.equal(brain.size, 1)
    assert.ok(brain.removeNode('a'))
    assert.ok(!brain.hasNode('a'))
  })

  test('单点激活', () => {
    const brain = new CatsNet()
    brain.addNode({ id: 'a', activation: 0.2 })
    assert.equal(brain.activate('a', 0.3), 0.5)
    assert.equal(brain.activate('missing', 1), null)
  })

  test('激活扩散：沿连接传播且迭代有界', () => {
    const brain = new CatsNet({ maxIterations: 20 })
    brain.addNode({ id: 'a', activation: 1 })
    brain.addNode({ id: 'b', activation: 0 })
    brain.addNode({ id: 'c', activation: 0 })
    brain.getNode('a').connect('b', 0.9)
    brain.getNode('b').connect('c', 0.9)

    const spread = brain.spreadActivation([{ id: 'a', amount: 1 }])
    assert.ok(spread.iterations <= 20)
    assert.ok(spread.activated.includes('b'))
    assert.ok(brain.getNode('b').activation > 0)
  })

  test('process 流水线：自动抽象新概念 + 记忆投影', () => {
    const brain = new CatsNet()
    const result = brain.process({
      concepts: [{ id: 'new_concept', weight: 1 }],
      episode: { id: 'mem', concepts: ['new_concept'] },
    })
    assert.equal(result.aborted, false)
    assert.ok(brain.hasNode('new_concept')) // 自动抽象化
    assert.ok(result.memory) // 记忆投影
    assert.equal(brain.projection.size, 1)
  })

  test('紧急终止：abort 后处理被拒绝且异常不外泄', () => {
    const brain = new CatsNet()
    brain.addNode({ id: 'a' })
    brain.abort()
    assert.ok(brain.isAborted())
    const result = brain.process({ concepts: [{ id: 'a', weight: 1 }] })
    assert.equal(result.aborted, true)
    assert.ok(result.error)
    assert.equal(result.spread.activated.length, 0)
  })

  test('clearAbort 后可恢复运行', () => {
    const brain = new CatsNet()
    brain.addNode({ id: 'a' })
    brain.abort()
    brain.clearAbort()
    const result = brain.process({ concepts: [{ id: 'a', weight: 1 }] })
    assert.equal(result.aborted, false)
  })

  test('内存态 serialize / deserialize 往返', () => {
    const brain = new CatsNet()
    brain.addNode({ id: 'a', activation: 0.4 })
    brain.projectMemory({ id: 'm', concepts: ['a'] })

    const snap = brain.serialize()
    const brain2 = new CatsNet()
    brain2.deserialize(snap)
    assert.equal(brain2.size, 1)
    // 0.4 初始激活 + project 投影激发 0.2
    assert.ok(Math.abs(brain2.getNode('a').activation - 0.6) < 1e-9)
    assert.equal(brain2.projection.size, 1)
  })

  test('磁盘 save / load 往返', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'catsnet-brain-'))
    try {
      const brain = new CatsNet()
      brain.addNode({ id: 'a', activation: 0.6 })
      const file = join(tmp, 'brain.json')
      brain.save(file)

      const brain2 = new CatsNet()
      brain2.load(file)
      assert.equal(brain2.size, 1)
      assert.equal(brain2.getNode('a').activation, 0.6)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})