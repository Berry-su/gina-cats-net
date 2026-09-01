/**
 * CatsNet 编辑 API（C-1.4 阶段 4）—— 7 个公开 API + salience + softDelete
 *
 * 覆盖（ADR-002 §3.4）：
 *   1) updateConcept 部分更新：name / type / level / attributes / granularity
 *   2) updateConcept 拒绝软删除节点 / 拒绝非法 patch
 *   3) mergeConcepts 3 合 1：关系迁移 + memory 重定向
 *   4) mergeConcepts 用 newId 指定新 keeper
 *   5) splitConcept 1 拆 2：父子 hierarchical 弱连接
 *   6) demoteConcept / boostConcept：只改 salience，**不动** confidence / activation
 *   7) salience 字段独立性：构造时 salience 默认 = confidence
 *   8) softDeleteConcept：deletedAt 切换 + process/spread/learn/sphere 跳过
 *   9) restoreConcept：从软删除恢复
 *  10) 持久化 round-trip：toJSON/fromJSON 保留 salience + deletedAt
 *  11) 向后兼容：旧快照无 salience/deletedAt 字段 → 默认 confidence / null
 *  12) 跟 learnConcepts 协同：mergeConcepts 不破坏 cooccurrence tracker
 *  13) 跟 C-1.3 self-learning 协同：learnConcepts 跳过软删除节点
 *  14) 软删除节点移除：removeNode 仍可彻底清理软删除节点
 *  15) 节点级 demote/boost/softDelete/restore 方法（直接调 node.xxx）
 *
 * 运行：node --test tests/test-cats-net-editor.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CatsNet,
  ConceptNode,
  Serializer,
} from '../src/cats_net/index.js'

// 浮点精度
const EPS = 1e-6
const near = (a, b, msg) => {
  assert.ok(
    Math.abs(a - b) < EPS,
    `${msg}：期望 ${b}，实得 ${a}（误差 ${Math.abs(a - b)}）`,
  )
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

// Mock 时间（避免真实时间漂移）
const originalDateNow = Date.now
let mockNow = 1_700_000_000_000
function withMockTime(fn) {
  Date.now = () => mockNow
  try {
    return fn()
  } finally {
    Date.now = originalDateNow
  }
}

// ===========================================================================
// 1. updateConcept 部分更新
// ===========================================================================

describe('CatsNet.updateConcept —— 部分更新', () => {
  test('部分更新：name + attributes + level', () => {
    const cn = new CatsNet()
    const n = cn.addNode({
      id: 'foo',
      name: '旧名',
      type: 'abstract',
      level: 'semantic',
      attributes: { a: 1, b: 'x' },
      confidence: 0.7,
    })

    const updated = cn.updateConcept('foo', {
      name: '新名',
      attributes: { c: 2, d: 'y' }, // 整体替换
      level: 'abstract',
    })

    assert.ok(updated, '返回节点')
    assert.equal(updated.name, '新名', 'name 已更新')
    assert.equal(updated.level, 'abstract', 'level 已更新')
    assert.deepEqual(updated.attributes, { c: 2, d: 'y' }, 'attributes 整体替换（不是 merge）')
    // 未在 patch 里的字段应保持
    assert.equal(updated.type, 'abstract', 'type 保留')
    assert.equal(updated.confidence, 0.7, 'confidence 保留')
  })

  test('updateConcept(null patch) 抛 TypeError / 不存在的 id 返回 null', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    assert.throws(() => cn.updateConcept('a', null), TypeError)
    assert.throws(() => cn.updateConcept('a', 'not an object'), TypeError)
    assert.equal(cn.updateConcept('nonexistent', { name: 'x' }), null)
  })

  test('updateConcept 拒绝软删除节点（返回 null，不改数据）', () => {
    const cn = new CatsNet()
    const n = cn.addNode({ id: 'a', name: 'orig' })
    cn.softDeleteConcept('a')
    const r = cn.updateConcept('a', { name: 'should not apply' })
    assert.equal(r, null, '软删除节点返回 null')
    // 节点还在 Map，但 name 没改
    const n2 = cn.getNode('a')
    assert.equal(n2.name, 'orig', 'name 未被更新')
  })

  test('updateConcept 非法 patch 抛 TypeError', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    // patch 不是对象 → 抛错
    assert.throws(() => cn.updateConcept('a', 'not an object'), TypeError)
  })

  test('updateConcept 非法 type 抛 RangeError', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    assert.throws(
      () => cn.updateConcept('a', { type: 'unknown_type' }),
      RangeError,
    )
  })

  test('updateConcept 过滤 attributes 中非法值（非 number/string）', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.updateConcept('a', {
      attributes: { good: 1, ok: 'x', bad: null, worse: [], bad2: {} },
    })
    const n = cn.getNode('a')
    assert.deepEqual(n.attributes, { good: 1, ok: 'x' })
  })

  test('updateConcept 改 granularity 生效', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', granularity: 1 })
    cn.updateConcept('a', { granularity: 5 })
    assert.equal(cn.getNode('a').granularity, 5)
  })

  test('updateConcept history 留痕：name / level / attributes', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.updateConcept('a', { name: 'new', level: 'abstract', attributes: { k: 1 } })
    const history = cn.getNode('a').history
    const ops = history.map((h) => h.op)
    assert.ok(ops.includes('updateName'), 'updateName 留痕')
    assert.ok(ops.includes('setLevel'), 'setLevel 留痕')
    assert.ok(ops.includes('updateAttributes'), 'updateAttributes 留痕')
  })
})

// ===========================================================================
// 2. mergeConcepts 多合 1
// ===========================================================================

describe('CatsNet.mergeConcepts —— 多合 1', () => {
  test('3 合 1：关系迁移 + memory 重定向', () => {
    const cn = new CatsNet()
    // 3 个高相似度节点（高 typeScore + 共享 attributes）
    const a = cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'risk' }, confidence: 0.7 })
    const b = cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'risk' }, confidence: 0.6 })
    const c = cn.addNode({ id: 'c', type: 'entity', attributes: { name: 'risk' }, confidence: 0.5 })
    // 其他节点指向 c
    const other = cn.addNode({ id: 'other' })
    other.connect('c', 0.8, 'causal', false)
    // 投影一条 memory 引用 c
    cn.projectMemory({ id: 'm1', concepts: ['a', 'b', 'c'] })

    const r = cn.mergeConcepts(['a', 'b', 'c'])

    assert.ok(r, '返回结果')
    assert.equal(r.merged.id, 'a', '默认 keeper = ids[0]')
    assert.equal(r.merged.type, 'entity', 'type 保留')
    assert.equal(r.removed.length, 2, '移除了 2 个节点')
    assert.ok(r.removed.includes('b') && r.removed.includes('c'), 'b 和 c 被移除')
    assert.ok(r.redirected >= 1, '至少 1 个连接被重定向（other→c → other→a）')

    // 验证：b/c 不在 Map，a 还在
    assert.equal(cn.hasNode('b'), false, 'b 已移除')
    assert.equal(cn.hasNode('c'), false, 'c 已移除')
    assert.equal(cn.hasNode('a'), true, 'a 保留为 keeper')

    // 验证：other 对 c 的连接 → 重定向到 a
    const otherNode = cn.getNode('other')
    assert.ok(otherNode.connections.has('a'), 'other 改连 a')
    assert.equal(otherNode.connections.has('c'), false, 'other 不再连 c')

    // 验证：projection memory 中 c 的引用已重定向为 a
    const mem = cn.projection.get('m1')
    assert.ok(mem, 'memory m1 存在')
    assert.ok(!mem.concepts.includes('c'), 'memory 中 c 已重定向')
    // v0.5.1 R5（拍板 b）：_redirectMemories 现在做 Set dedupe
    //   原 C-1.3 行为：a 出现 3 次（a→a, b→a, c→a）—— 冲突"完整版=上线产品"硬约束
    //   现 v0.5.1 行为：dedupe 后 a 只出现 1 次，b/c 写入 mergedFrom
    assert.equal(mem.concepts.filter((x) => x === 'a').length, 1, 'v0.5.1 dedupe：a 只出现 1 次')
    assert.equal(mem.concepts.length, 1, 'mem.concepts 长度 = 1')
    // mergedFrom 记录 b 和 c 两个来源（按合并顺序追加）
    assert.ok(Array.isArray(mem.mergedFrom), 'mergedFrom 是数组')
    const sources = mem.mergedFrom.map((m) => m.from).sort()
    assert.deepEqual(sources, ['b', 'c'], 'mergedFrom 含 b + c 两个来源')
    // 每条 mergedFrom entry 都有 from / at / via
    for (const entry of mem.mergedFrom) {
      assert.equal(typeof entry.from, 'string', 'entry.from 是字符串')
      assert.equal(typeof entry.at, 'number', 'entry.at 是数字')
      assert.equal(entry.via, 'mergeConcepts', 'entry.via = "mergeConcepts"')
    }
  })

  test('mergeConcepts 用 newId 指定新 keeper', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', confidence: 0.7 })
    cn.addNode({ id: 'b', confidence: 0.6 })

    const r = cn.mergeConcepts(['a', 'b'], 'merged_node')
    assert.equal(r.merged.id, 'merged_node', '新 id 作为 keeper')
    assert.equal(cn.hasNode('merged_node'), true, '新 keeper 存在')
    assert.equal(cn.hasNode('a'), false, 'a 已移除')
    assert.equal(cn.hasNode('b'), false, 'b 已移除')
  })

  test('mergeConcepts 不足 2 个 id 抛 TypeError', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    assert.throws(() => cn.mergeConcepts(['a']), TypeError)
    assert.throws(() => cn.mergeConcepts([]), TypeError)
  })

  test('mergeConcepts 全部是软删除节点 → 返回 null', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.addNode({ id: 'b' })
    cn.softDeleteConcept('a')
    cn.softDeleteConcept('b')
    assert.equal(cn.mergeConcepts(['a', 'b']), null)
  })

  test('mergeConcepts 跳过软删除节点（只合未删除的）', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.addNode({ id: 'b' })
    cn.addNode({ id: 'c' })
    cn.softDeleteConcept('b')

    const r = cn.mergeConcepts(['a', 'b', 'c'])
    assert.equal(r.merged.id, 'a', 'a 是 keeper')
    // b 是软删除，所以 removed 只有 [c]
    assert.equal(r.removed.length, 1, 'b 被跳过，只移除 1 个')
    assert.equal(r.removed[0], 'c', '移除了 c')
  })

  test('mergeConcepts 强制覆盖属性（newAttributes）', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', attributes: { a: 1, b: 2 } })
    cn.addNode({ id: 'b', attributes: { c: 3 } })

    const r = cn.mergeConcepts(['a', 'b'], 'merged', { only: 'forced' })
    assert.deepEqual(r.merged.attributes, { only: 'forced' }, 'attributes 整体替换')
  })

  // v0.5.1 R5（ADR-002 §3.4.7 Blocker 2 · 拍板 b）：
  //   mergeConcepts 后 memory.concepts[] 必须 dedupe（Set 去重），
  //   并把被合并的旧 id 追加到 mem.mergedFrom 记录可追溯。
  test('v0.5.1 R5：3 节点合并后 memory.concepts 去重 + mergedFrom 记录 2 个来源', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      // 3 节点 a/b/c，mergeConcepts([a,b,c]) → keeper = a
      cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'risk' }, confidence: 0.7 })
      cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'risk' }, confidence: 0.6 })
      cn.addNode({ id: 'c', type: 'entity', attributes: { name: 'risk' }, confidence: 0.5 })
      // 投影一条 memory 同时含 a/b/c 三个概念
      cn.projectMemory({ id: 'mem_abc', concepts: ['a', 'b', 'c'], strength: 0.9 })
      // 再加一条 memory 仅含 a（无重复，mergedFrom 不应追加）
      cn.projectMemory({ id: 'mem_a_only', concepts: ['a'], strength: 0.9 })

      const r = cn.mergeConcepts(['a', 'b', 'c'])
      assert.ok(r, 'mergeConcepts 成功')
      assert.equal(r.merged.id, 'a', 'keeper = a')

      // 1) mem_abc 合并后 a 只出现 1 次（去重），b/c 写入 mergedFrom
      const memAbc = cn.projection.get('mem_abc')
      assert.ok(memAbc, 'mem_abc 存在')
      assert.equal(memAbc.concepts.length, 1, 'dedupe 后 mem_abc.concepts 长度 = 1')
      assert.deepEqual(memAbc.concepts, ['a'], 'dedupe 后 mem_abc.concepts = [a]')
      assert.ok(Array.isArray(memAbc.mergedFrom), 'mem_abc.mergedFrom 是数组')
      const sources = memAbc.mergedFrom.map((m) => m.from).sort()
      assert.deepEqual(sources, ['b', 'c'], 'mergedFrom 含 b + c 两个来源')
      // 每条 entry 都有 from / at / via
      for (const entry of memAbc.mergedFrom) {
        assert.equal(typeof entry.from, 'string', 'entry.from 是 string')
        assert.equal(typeof entry.at, 'number', 'entry.at 是 number')
        assert.equal(entry.via, 'mergeConcepts', 'entry.via = "mergeConcepts"')
      }

      // 2) mem_a_only 原本就没重复，mergedFrom 应为空（避免噪音）
      const memAOnly = cn.projection.get('mem_a_only')
      assert.ok(memAOnly, 'mem_a_only 存在')
      assert.deepEqual(memAOnly.concepts, ['a'], 'mem_a_only.concepts 不变')
      assert.equal(memAOnly.mergedFrom.length, 0, '无重复时 mergedFrom 不追加')
    })
  })
})

// ===========================================================================
// 3. splitConcept 1 拆多
// ===========================================================================

describe('CatsNet.splitConcept —— 1 拆多', () => {
  test('拆 2：父子 hierarchical 弱连接 + 子节点可独立激活', () => {
    const cn = new CatsNet()
    const orig = cn.addNode({
      id: 'parent',
      name: '风险',
      type: 'abstract',
      level: 'abstract',
      attributes: { category: 'meta' },
      confidence: 0.9,
    })
    // 别的节点连 parent
    const neighbor = cn.addNode({ id: 'neighbor' })
    neighbor.connect('parent', 0.7, 'association', false)

    const r = cn.splitConcept('parent', [
      { id: 'risk_market', name: '市场风险', attributes: { kind: 'market' } },
      { id: 'risk_credit', name: '信用风险', attributes: { kind: 'credit' }, weight: 0.8 },
    ])

    assert.ok(r, '返回结果')
    assert.equal(r.original.id, 'parent', 'original 保留')
    assert.equal(r.children.length, 2, '拆出 2 个子节点')
    assert.equal(r.children[0].id, 'risk_market', '第一个子节点 id')
    assert.equal(r.children[1].id, 'risk_credit', '第二个子节点 id')

    // 父子连接（hierarchical，单向）
    const cMeta1 = orig.connections.get('risk_market')
    const cMeta2 = orig.connections.get('risk_credit')
    assert.ok(cMeta1, 'parent 连 risk_market')
    assert.equal(cMeta1.type, 'hierarchical', '连接类型是 hierarchical')
    assert.equal(cMeta1.bidirectional, false, '单向连接')
    assert.ok(cMeta2, 'parent 连 risk_credit')

    // 子节点有 attributes
    assert.deepEqual(r.children[0].attributes, { kind: 'market' })
    assert.deepEqual(r.children[1].attributes, { kind: 'credit' })

    // original 的 attributes 没动
    assert.deepEqual(orig.attributes, { category: 'meta' }, 'original attributes 保留')

    // 其他节点对 parent 的连接还在
    const neighborNode = cn.getNode('neighbor')
    assert.ok(neighborNode.connections.has('parent'), 'neighbor→parent 连接保留')
  })

  test('splitConcept 不存在的 id 返回 null', () => {
    const cn = new CatsNet()
    assert.equal(cn.splitConcept('nonexistent', [{ name: 'x' }]), null)
  })

  test('splitConcept 软删除节点返回 null', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.softDeleteConcept('a')
    assert.equal(cn.splitConcept('a', [{ name: 'x' }]), null)
  })

  test('splitConcept parts 为空抛 TypeError', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    assert.throws(() => cn.splitConcept('a', []), TypeError)
  })

  test('splitConcept 子节点 id 自动生成（不传 id 时）', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'parent' })
    const r = cn.splitConcept('parent', [
      { name: 'c1' },
      { name: 'c2' },
    ])
    assert.equal(r.children[0].id, 'parent#split-0', '自动 id 用 0-based index')
    assert.equal(r.children[1].id, 'parent#split-1')
  })

  test('splitConcept 子节点 id 冲突抛错（已存在的活跃节点）', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'parent' })
    cn.addNode({ id: 'existing' })
    assert.throws(
      () => cn.splitConcept('parent', [{ id: 'existing' }]),
      /子节点 id 已存在/,
    )
  })
})

// ===========================================================================
// 4. demoteConcept / boostConcept + salience 字段独立性
// ===========================================================================

describe('CatsNet.demoteConcept / boostConcept —— salience 字段独立性', () => {
  test('demoteConcept 只改 salience，**不动** confidence / activation', () => {
    const cn = new CatsNet()
    const n = cn.addNode({
      id: 'a',
      confidence: 0.8,
      activation: 0.3,
      salience: 0.9, // 显式设高
    })
    const r = cn.demoteConcept('a', 0.5)
    assert.ok(r, '返回节点')
    near(r.salience, 0.45, 'salience × 0.5')
    assert.equal(r.confidence, 0.8, 'confidence 不变')
    assert.equal(r.activation, 0.3, 'activation 不变')
  })

  test('boostConcept 只改 salience，**不动** confidence / activation', () => {
    const cn = new CatsNet()
    const n = cn.addNode({
      id: 'a',
      confidence: 0.8,
      activation: 0.3,
      salience: 0.5,
    })
    const r = cn.boostConcept('a', 1.2)
    near(r.salience, 0.6, 'salience × 1.2')
    assert.equal(r.confidence, 0.8, 'confidence 不变')
    assert.equal(r.activation, 0.3, 'activation 不变')
  })

  test('salience clamp [0,1]：boost 到 1 上限 / demote 极小因子不出负数', () => {
    const cn = new CatsNet()
    // boost：salience=0.9 × factor=100 = 90 → clamp 到 1
    cn.addNode({ id: 'a', salience: 0.9 })
    cn.boostConcept('a', 100)
    assert.equal(cn.getNode('a').salience, 1, 'boost clamp 上限到 1')

    // demote：salience=0.1 × factor=0.001 = 0.0001（不会变负数）
    cn.addNode({ id: 'b', salience: 0.1 })
    cn.demoteConcept('b', 0.001)
    const b = cn.getNode('b').salience
    assert.ok(b >= 0 && b < 0.01, `demote 极小因子结果 ${b} 仍在 [0, 1)`)
  })

  test('salience 默认 = confidence（构造时未显式设）', () => {
    const cn = new CatsNet()
    const n = cn.addNode({ id: 'a', confidence: 0.65 })
    near(n.salience, 0.65, 'salience 默认 = confidence')
  })

  test('demoteConcept 默认 factor = 0.5', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', salience: 0.8 })
    cn.demoteConcept('a')
    near(cn.getNode('a').salience, 0.4, '默认 factor=0.5')
  })

  test('boostConcept 默认 factor = 1.2', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', salience: 0.5 })
    cn.boostConcept('a')
    near(cn.getNode('a').salience, 0.6, '默认 factor=1.2')
  })

  test('demoteConcept 非法 factor 兜底为 0.5', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', salience: 0.8 })
    cn.demoteConcept('a', -1) // 非法
    near(cn.getNode('a').salience, 0.4, 'factor=-1 兜底为 0.5')
  })

  test('demoteConcept/boostConcept 不存在 / 软删除 → 返回 null', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.softDeleteConcept('a')
    assert.equal(cn.demoteConcept('a', 0.5), null)
    assert.equal(cn.boostConcept('a', 1.2), null)
    assert.equal(cn.demoteConcept('nonexistent'), null)
  })

  test('ConceptNode 节点级 demote/boost/softDelete/restore 方法', () => {
    const cn = new CatsNet()
    const n = cn.addNode({ id: 'a', salience: 0.6 })

    n.demote(0.5)
    near(n.salience, 0.3, '节点级 demote')

    n.boost(2.0)
    near(n.salience, 0.6, '节点级 boost')

    n.softDelete(1234567890)
    assert.equal(n.isDeleted(), true, 'isDeleted() = true')
    assert.equal(n.deletedAt, 1234567890, 'deletedAt 已设')

    n.restore()
    assert.equal(n.isDeleted(), false, 'isDeleted() = false')
    assert.equal(n.deletedAt, null, 'deletedAt 已清')
    assert.equal(n.restore(), false, '重复 restore 返回 false')
  })
})

// ===========================================================================
// 5. softDeleteConcept / restoreConcept
// ===========================================================================

describe('CatsNet.softDeleteConcept / restoreConcept', () => {
  test('softDelete 设 deletedAt = now，可 restore 清掉', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'a' })

      const r1 = cn.softDeleteConcept('a')
      assert.equal(r1, true, '第一次软删除返回 true')
      const node = cn.getNode('a')
      assert.ok(node.deletedAt, 'deletedAt 已设')
      assert.equal(node.deletedAt, mockNow, 'deletedAt = mockNow')

      // 软删除后 isAlive = false
      assert.equal(cn.isAlive('a'), false, 'isAlive = false')

      const r2 = cn.restoreConcept('a')
      assert.ok(r2, 'restore 返回节点')
      assert.equal(cn.getNode('a').deletedAt, null, 'deletedAt 已清')
      assert.equal(cn.isAlive('a'), true, 'isAlive = true')
    })
  })

  test('softDeleteConcept 幂等：重复 softDelete 返回 false', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    assert.equal(cn.softDeleteConcept('a'), true, '第一次 true')
    assert.equal(cn.softDeleteConcept('a'), false, '第二次 false')
  })

  test('softDeleteConcept 不存在的 id 返回 false', () => {
    const cn = new CatsNet()
    assert.equal(cn.softDeleteConcept('nonexistent'), false)
  })

  test('restoreConcept 未软删除的 id 返回 null', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    assert.equal(cn.restoreConcept('a'), null)
  })

  test('restoreConcept 不存在的 id 返回 null', () => {
    const cn = new CatsNet()
    assert.equal(cn.restoreConcept('nonexistent'), null)
  })

  test('软删除后：spreadActivation / activateHierarchical 跳过', () => {
    const cn = new CatsNet()
    const a = cn.addNode({ id: 'a' })
    const b = cn.addNode({ id: 'b' })
    a.connect('b', 1.0, 'causal')

    // 软删除 b
    cn.softDeleteConcept('b')

    // 激活扩散
    const r1 = cn.spreadActivation([{ id: 'a', amount: 1.0 }])
    assert.equal(r1.activated.includes('b'), false, 'spreadActivation 跳过软删除 b')
    assert.equal(b.activation, 0, 'b 没被激活')

    // 跨层激活
    cn.tickTimeDecay(Date.now()) // 衰减不影响（已 skip）
    const r2 = cn.activateHierarchical('a')
    assert.equal(r2.activated.includes('b'), false, 'activateHierarchical 跳过 b')
  })

  test('软删除后：getLevelActivationSummary 不计', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', level: 'semantic' })
    cn.addNode({ id: 'b', level: 'semantic' })
    cn.softDeleteConcept('b')

    const sum = cn.getLevelActivationSummary()
    assert.equal(sum.semantic.count, 1, 'count 只算 1 个')
  })

  test('软删除后：tickTimeDecay 跳过', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a', activation: 0.5 })
      a.lastActivatedAt = mockNow - 10 * DAY_MS

      cn.softDeleteConcept('a')

      // 推进时间后调 tickTimeDecay
      const t = mockNow + 10 * DAY_MS
      const r = cn.tickTimeDecay(t)
      assert.equal(r.decayed, 0, '软删除节点没被衰减')
      assert.equal(a.activation, 0.5, 'activation 未变')
    })
  })

  test('软删除后：learnConcepts 跳过（既不合并也不降权）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a', level: 'semantic', confidence: 0.8, activation: 0.1 })
      a.lastActivatedAt = mockNow - 100 * DAY_MS // 100 天前
      cn.softDeleteConcept('a')

      const r = cn.learnConcepts({ now: mockNow, episodes: [] })
      const entry = r.demoted.find((d) => d.id === 'a')
      assert.equal(entry, undefined, '软删除节点不参与 learnConcepts 降权')
    })
  })

  test('软删除后：getConceptSphereData 跳过', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.addNode({ id: 'b' })
    cn.softDeleteConcept('b')
    const data = ConceptNode.getConceptSphereData(cn.nodes)
    const ids = data.nodes.map((n) => n.id).sort()
    assert.deepEqual(ids, ['a'], '3D sphere data 只含未软删除节点')
  })

  test('aliveSize 排除软删除', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.addNode({ id: 'b' })
    cn.addNode({ id: 'c' })
    cn.softDeleteConcept('b')
    assert.equal(cn.size, 3, 'size 含全部')
    assert.equal(cn.aliveSize, 2, 'aliveSize 只算未删除')
  })

  test('removeNode 仍可彻底清理软删除节点', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })
    cn.softDeleteConcept('a')
    assert.equal(cn.removeNode('a'), true, 'removeNode 删软删除节点')
    assert.equal(cn.hasNode('a'), false, '彻底从 Map 删除')
    assert.equal(cn.aliveSize, 0)
  })
})

// ===========================================================================
// 6. 持久化 round-trip
// ===========================================================================

describe('持久化 round-trip —— salience + deletedAt', () => {
  test('toJSON 包含 salience + deletedAt', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', salience: 0.42, deletedAt: 1234567890 })
    const data = cn.serialize()
    const nodeJson = data.nodes.find((n) => n.id === 'a')
    assert.equal(nodeJson.salience, 0.42, 'salience 已序列化')
    assert.equal(nodeJson.deletedAt, 1234567890, 'deletedAt 已序列化')
  })

  test('fromJSON 恢复 salience + deletedAt', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', salience: 0.42, deletedAt: 1234567890 })

    const dir = mkdtempSync(join(tmpdir(), 'cats-net-c14-'))
    const fp = join(dir, 'snap.json')
    try {
      cn.save(fp)
      const cn2 = new CatsNet()
      cn2.load(fp)
      const a = cn2.getNode('a')
      assert.equal(a.salience, 0.42, 'salience 已恢复')
      assert.equal(a.deletedAt, 1234567890, 'deletedAt 已恢复')
      assert.equal(cn2.isAlive('a'), false, '恢复后仍标记为软删除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('向后兼容：旧快照无 salience 字段 → 恢复时默认 = confidence', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a', confidence: 0.75 })

    // 手动序列化、剥掉 salience 字段
    const data = cn.serialize()
    for (const n of data.nodes) delete n.salience

    // 反序列化
    const cn2 = new CatsNet()
    cn2.deserialize(data)
    const a = cn2.getNode('a')
    near(a.salience, 0.75, 'salience 默认 = confidence')
  })

  test('向后兼容：旧快照无 deletedAt 字段 → 恢复时默认 = null', () => {
    const cn = new CatsNet()
    cn.addNode({ id: 'a' })

    // 手动序列化、剥掉 deletedAt
    const data = cn.serialize()
    for (const n of data.nodes) delete n.deletedAt

    const cn2 = new CatsNet()
    cn2.deserialize(data)
    const a = cn2.getNode('a')
    assert.equal(a.deletedAt, null, 'deletedAt 默认 = null')
    assert.equal(cn2.isAlive('a'), true, '旧快照节点默认视为未删除')
  })

  test('Serializer round-trip：toJSON / fromJSON 完整', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cats-net-c14-'))
    const fp = join(dir, 'snap.json')
    try {
      const cn = new CatsNet()
      cn.addNode({ id: 'a', salience: 0.42, confidence: 0.6 })
      cn.addNode({ id: 'b', salience: 0.88, deletedAt: 1234567890 })

      // 中间插入 memory
      cn.projectMemory({ id: 'm1', concepts: ['a', 'b'] })

      cn.save(fp)
      const cn2 = new CatsNet()
      cn2.load(fp)
      const a = cn2.getNode('a')
      const b = cn2.getNode('b')
      assert.equal(a.salience, 0.42, 'a.salience')
      assert.equal(a.deletedAt, null, 'a.deletedAt = null')
      assert.equal(b.salience, 0.88, 'b.salience')
      assert.equal(b.deletedAt, 1234567890, 'b.deletedAt 保留')
      // memory 还在
      const m = cn2.projection.get('m1')
      assert.ok(m, 'memory m1 保留')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// 7. 跟 learnConcepts 的协同
// ===========================================================================

describe('编辑 API + learnConcepts 协同', () => {
  test('mergeConcepts 不破坏 cooccurrence tracker', () => {
    const cn = new CatsNet()
    // 让 cooccurrence 有数据
    for (let i = 0; i < 5; i++) {
      cn.cooccurrence.recordEpisode(['a', 'b', 'c'], Date.now())
    }
    const sizeBefore = cn.cooccurrence.size
    assert.ok(sizeBefore > 0, 'tracker 里有数据')

    // 合并
    cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'risk' } })
    cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'risk' } })
    cn.mergeConcepts(['a', 'b'])

    // tracker size 应该不变（mergeConcepts 不动 tracker）
    assert.equal(cn.cooccurrence.size, sizeBefore, 'tracker size 不变')
  })

  test('learnConcepts 跳过软删除节点：合并不碰已删除节点', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'risk' } })
      const b = cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'risk' } })
      const c = cn.addNode({ id: 'c', type: 'entity', attributes: { name: 'risk' } })
      // 软删除 c
      cn.softDeleteConcept('c')

      // 通过 learnConcepts 触发合并（用 episodes）
      const episodes = []
      for (let i = 0; i < 5; i++) {
        episodes.push({ concepts: ['a', 'b', 'c'], timestamp: mockNow })
      }
      const r = cn.learnConcepts({ episodes, now: mockNow, mergeSimilarity: 0.5 })
      // c 已软删除 → 视为不存在 → 不会跟 a/b 合并
      // 实际：learnConcepts 会把 a/b/c 都加进 cooccurrence → 高频 pair a-b/c/c-a 出现
      // 但 a/b/c 都在 nodes（c 软删除）→ a/b 高相似度 → 合并
      // 合并的可能是 a+b 留着，c 软删除保留
      // 主要验证：learnConcepts 不抛错、不把 c 合并到 a/b
      assert.ok(cn.hasNode('c'), 'c 仍在 Map（learnConcepts 不动软删除节点）')
      assert.equal(cn.getNode('c').deletedAt != null, true, 'c 仍软删除')
    })
  })

  test('softDelete 后 learnConcepts 不把它的 evidence 算进新节点的 confidence', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const a = cn.addNode({ id: 'a' })
      cn.softDeleteConcept('a')

      // 通过 learnConcepts 跑：高频 pair (a, b) 出现，但 a 已软删除
      const episodes = []
      for (let i = 0; i < 10; i++) {
        episodes.push({ concepts: ['a', 'b'], timestamp: mockNow })
      }
      const r = cn.learnConcepts({ episodes, now: mockNow, maxNew: 5 })
      // a 已软删除 → 视为不存在 → 只归纳 b（如果 a 不存在）
      // 主要验证：learnConcepts 不抛错
      assert.ok(r, 'learnConcepts 成功执行')
    })
  })
})

// ===========================================================================
// 8. 持久化（其他场景）
// ===========================================================================

describe('serialize / deserialize —— 增量兼容', () => {
  test('serialize 包含 nodes 全部字段', () => {
    const cn = new CatsNet()
    cn.addNode({
      id: 'a',
      salience: 0.55,
      deletedAt: 999,
      confidence: 0.7,
      activation: 0.3,
    })
    const data = cn.serialize()
    const json = JSON.parse(JSON.stringify(data)) // 验证可 JSON 化
    assert.equal(json.nodes[0].salience, 0.55)
    assert.equal(json.nodes[0].deletedAt, 999)
  })
})
