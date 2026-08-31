/**
 * 记忆系统 —— 单元测试
 *
 * 运行：node --test tests/memory.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryManager,
  WorkingMemory,
  ShortTermMemory,
  LongTermMemory,
} from '../src/memory/index.js'
import { CatsNet } from '../src/cats_net/index.js'

// ---------------------------------------------------------------------------
describe('WorkingMemory —— 工作记忆', () => {
  test('容量限制：超出容量淘汰最低重要性条目', () => {
    const wm = new WorkingMemory({ capacity: 3 })
    wm.add({ id: 'a', content: 'A', importance: 1 })
    wm.add({ id: 'b', content: 'B', importance: 0.9 })
    wm.add({ id: 'c', content: 'C', importance: 0.8 })
    wm.add({ id: 'd', content: 'D', importance: 0.95 })
    assert.equal(wm.size, 3)
    assert.ok(!wm.has('c')) // c 重要性最低被淘汰
    assert.ok(wm.has('d'))
  })

  test('快速遗忘：decay 降低重要性', () => {
    const wm = new WorkingMemory({ decayRate: 0.5, minImportance: 0.1 })
    wm.add({ id: 'a', content: 'A', importance: 1 })
    const before = wm.get('a').importance
    const { retained } = wm.decay()
    // 1 * 0.5 = 0.5 >= 0.1 保留
    assert.equal(retained, 1)
    assert.ok(wm.get('a').importance < before)
  })

  test('序列化往返', () => {
    const wm = new WorkingMemory()
    wm.add({ id: 'a', content: 'A', tags: ['x'], importance: 0.7 })
    const wm2 = new WorkingMemory()
    wm2.fromJSON(wm.toJSON())
    assert.equal(wm2.size, 1)
    assert.equal(wm2.get('a').content, 'A')
  })
})

// ---------------------------------------------------------------------------
describe('ShortTermMemory —— 短期记忆', () => {
  test('add 与按概念检索排序', () => {
    const stm = new ShortTermMemory()
    stm.add({ id: 'full', content: '全相关', concepts: ['risk', 'stop_loss'], strength: 0.8 })
    stm.add({ id: 'partial', content: '部分相关', concepts: ['risk'], strength: 0.8 })
    const results = stm.retrieve(['risk', 'stop_loss'])
    assert.equal(results[0].entry.id, 'full')
  })

  test('遗忘：低于阈值清除', () => {
    const stm = new ShortTermMemory({ decayRate: 0.9, minStrength: 0.5 })
    stm.add({ id: 'a', content: 'A', strength: 1 })
    stm.decay() // 1*0.1 = 0.1 < 0.5，被清除
    assert.equal(stm.size, 0)
  })

  test('listConsolidatable 阈值过滤', () => {
    const stm = new ShortTermMemory()
    stm.add({ id: 'strong', content: '强', strength: 0.9 })
    stm.add({ id: 'weak', content: '弱', strength: 0.3 })
    const list = stm.listConsolidatable(0.6)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'strong')
  })

  test('序列化往返', () => {
    const stm = new ShortTermMemory()
    stm.add({ id: 'a', content: 'A', concepts: ['x'], tags: ['t'], strength: 0.5 })
    const stm2 = new ShortTermMemory()
    stm2.fromJSON(stm.toJSON())
    assert.equal(stm2.size, 1)
    assert.deepEqual(stm2.get('a').concepts, ['x'])
  })
})

// ---------------------------------------------------------------------------
describe('LongTermMemory —— 长期记忆', () => {
  test('addFromShortTerm 携带抽象空间引用', () => {
    const ltm = new LongTermMemory()
    ltm.addFromShortTerm(
      { id: 'stm_x', label: '风控', content: '内容', concepts: ['risk'], tags: [], strength: 0.8 },
      { abstractSpaceRef: ['risk'] },
    )
    assert.equal(ltm.size, 1)
    const entry = ltm.get('ltm_stm_x')
    assert.deepEqual(entry.abstractSpaceRef, ['risk'])
  })

  test('缓慢遗忘：decayRate 小则保留', () => {
    const ltm = new LongTermMemory({ decayRate: 0.01, minStrength: 0.1 })
    ltm.add({ id: 'a', content: 'A', strength: 1 })
    ltm.decay() // 1*0.99 = 0.99 保留
    assert.equal(ltm.size, 1)
  })

  test('序列化往返', () => {
    const ltm = new LongTermMemory()
    ltm.add({ id: 'a', content: 'A', abstractSpaceRef: ['x'] })
    const ltm2 = new LongTermMemory()
    ltm2.fromJSON(ltm.toJSON())
    assert.equal(ltm2.size, 1)
    assert.deepEqual(ltm2.get('a').abstractSpaceRef, ['x'])
  })
})

// ---------------------------------------------------------------------------
describe('MemoryManager —— 编排器（降级模式，无 CATS-Net）', () => {
  test('巩固流水线：addObservation → shift → consolidate', () => {
    const mm = new MemoryManager()
    mm.addObservation({ id: 'obs1', content: '市场下跌', concepts: ['market_drop'], importance: 1 })
    assert.equal(mm.stats().working, 1)

    const { moved } = mm.shiftToShortTerm()
    assert.equal(moved, 1)
    assert.equal(mm.stats().working, 0)
    assert.equal(mm.stats().shortTerm, 1)

    const { consolidated, projected } = mm.consolidate({ minStrength: 0.6 })
    assert.equal(consolidated, 1)
    assert.equal(projected, 0) // 无内核，无投影
    assert.equal(mm.stats().longTerm, 1)
    assert.equal(mm.stats().shortTerm, 0)
  })

  test('跨层检索与 recall', () => {
    const mm = new MemoryManager()
    mm.addObservation({ id: 'obs1', content: '风险监管', concepts: ['risk'], importance: 1 })
    mm.shiftToShortTerm()
    mm.consolidate({ minStrength: 0.6 })

    const results = mm.retrieve(['risk'])
    assert.ok(results.length >= 1)
    assert.equal(results[0].layer, 'longTerm')

    const hit = mm.recall(mmgetLongId(mm))
    assert.ok(hit)
    assert.equal(hit.layer, 'longTerm')
  })

  test('紧急终止：abort 后操作抛错', () => {
    const mm = new MemoryManager()
    mm.abort()
    assert.ok(mm.isAborted())
    assert.throws(() => mm.addObservation({ content: 'x' }), (e) => e.code === 'ABORTED')
    mm.clearAbort()
    mm.addObservation({ content: 'y' })
    assert.equal(mm.stats().working, 1)
  })

  test('持久化 save / load 往返', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'memory-'))
    try {
      const mm = new MemoryManager()
      mm.addObservation({ id: 'o', content: '内容', concepts: ['c'], importance: 1 })
      mm.shiftToShortTerm()
      mm.consolidate({ minStrength: 0.6 })
      const file = join(tmp, 'memory.json')
      mm.save(file)

      const mm2 = new MemoryManager()
      mm2.load(file)
      assert.equal(mm2.stats().longTerm, 1)
      assert.equal(mm2.stats().working, 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
describe('MemoryManager —— 与 CATS-Net 对接', () => {
  function brainWithConcepts() {
    const brain = new CatsNet()
    brain.addNode({ id: 'risk', name: '风险' })
    brain.addNode({ id: 'stop_loss', name: '止损' })
    return brain
  }

  test('consolidate 投影到抽象空间并建立双向链接', () => {
    const brain = brainWithConcepts()
    const mm = new MemoryManager({ catsNet: brain })

    mm.addObservation({ id: 'obs', content: '风险触发止损', concepts: ['risk', 'stop_loss'], importance: 1 })
    mm.shiftToShortTerm()
    const { consolidated, projected } = mm.consolidate({ minStrength: 0.6 })

    assert.equal(consolidated, 1)
    assert.equal(projected, 1)
    // 抽象空间出现记忆痕迹
    assert.equal(brain.projection.size, 1)
    // 长期记忆条目持有抽象空间引用
    const ltmEntries = mm.longTerm.list()
    assert.equal(ltmEntries.length, 1)
    assert.deepEqual(ltmEntries[0].abstractSpaceRef.sort(), ['risk', 'stop_loss'])
    // 投影激发概念激活
    assert.ok(brain.getNode('risk').activation > 0)
  })

  test('retrieveAbstract 委托内核唤回记忆', () => {
    const brain = brainWithConcepts()
    const mm = new MemoryManager({ catsNet: brain })
    mm.addObservation({ id: 'obs', content: '风控', concepts: ['risk', 'stop_loss'], importance: 1 })
    mm.shiftToShortTerm()
    mm.consolidate({ minStrength: 0.6 })

    const hits = mm.retrieveAbstract(['risk'])
    assert.ok(hits.length >= 1)
  })

  test('无内核时降级（不崩、无投影）', () => {
    const mm = new MemoryManager({ catsNet: null })
    mm.addObservation({ id: 'obs', content: 'x', concepts: ['y'], importance: 1 })
    mm.shiftToShortTerm()
    const { consolidated, projected } = mm.consolidate({ minStrength: 0.6 })
    assert.equal(consolidated, 1)
    assert.equal(projected, 0)
    assert.deepEqual(mm.retrieveAbstract(['y']), [])
  })
})

// 辅助：取得长期记忆中唯一条目的 id
function mmgetLongId(mm) {
  return mm.longTerm.list()[0]?.id
}