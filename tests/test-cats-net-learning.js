/**
 * CATS-Net 概念自学习（CooccurrenceTracker + learnConcepts）—— C-1.3 阶段 3 测试
 *
 * 覆盖（ADR-002 §3.3.5 + 4 重护栏 + 易错点）：
 *   CooccurrenceTracker：
 *     1) recordPair / recordEpisode 基本行为
 *     2) 规范化：recordPair(a,b) === recordPair(b,a)（canonical key）
 *     3) LRU 10k 上限：插入 15000 pair → size=10000，lastSeen 最早的被淘汰
 *     4) half-life 1 周衰减：1 周前的 pair effectiveCount 减半
 *     5) minCount 5 过滤低频
 *     6) getFrequentPairs 按 effectiveCount 降序
 *     7) since 过滤 + limit 截断
 *     8) toJSON / fromJSON 往返（保留 maxPairs/minCount/halfLifeHours/pairs）
 *     9) 自共现忽略 + 非法输入抛错
 *
 *   CatsNet.learnConcepts：
 *     10) 10 次共现后归纳新概念（4 个未知概念 + 10 episodes）
 *     11) 相似度 0.6+ 自动合并
 *     12) maxNew=10 限制新增数
 *     13) minConfidence=0.7 过滤低置信（count<5 不入选）
 *     14) LRU 10k cap 不爆（100k 随机 episode 跑完 size ≤ 10000）
 *     15) 90 天没激活 → demoted.length >= 1（v0.5.1 R6：salience × 0.5，原 confidence × 0.5 已迁 salience 字段）
 *     16) 无 episodes → 从 projection.getMemories() 拉
 *     17) 合并后连接重定向（指向 removee 的连接 → keeper）
 *     18) 合并后 projection memory.concepts[] id 重定向
 *     19) Serializer round-trip：cooccurrence 字段保留
 *     20) 向后兼容：旧快照无 cooccurrence 字段 → 仍可加载（空 tracker）
 *
 * 运行：node --test tests/test-cats-net-learning.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CatsNet,
  ConceptNode,
  CooccurrenceTracker,
  Serializer,
  MemoryProjection,
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
const WEEK_MS = 7 * DAY_MS

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
// CooccurrenceTracker 单元测试
// ===========================================================================

describe('CooccurrenceTracker —— 基础行为', () => {
  test('默认参数：maxPairs=10000, minCount=5, halfLifeHours=168', () => {
    const t = new CooccurrenceTracker()
    assert.equal(t.maxPairs, 10000)
    assert.equal(t.minCount, 5)
    assert.equal(t.halfLifeHours, 168)
    assert.equal(t.size, 0)
  })

  test('自定义参数', () => {
    const t = new CooccurrenceTracker({ maxPairs: 100, minCount: 2, halfLifeHours: 24 })
    assert.equal(t.maxPairs, 100)
    assert.equal(t.minCount, 2)
    assert.equal(t.halfLifeHours, 24)
  })

  test('非法参数抛 TypeError', () => {
    assert.throws(() => new CooccurrenceTracker({ maxPairs: 0 }), TypeError)
    assert.throws(() => new CooccurrenceTracker({ minCount: -1 }), TypeError)
    assert.throws(() => new CooccurrenceTracker({ halfLifeHours: 0 }), TypeError)
  })

  test('canonicalKey：a < b 字典序', () => {
    assert.equal(CooccurrenceTracker.canonicalKey('a', 'b'), 'a|b')
    assert.equal(CooccurrenceTracker.canonicalKey('b', 'a'), 'a|b')
    assert.equal(CooccurrenceTracker.canonicalKey('risk', 'stop_loss'), 'risk|stop_loss')
  })

  test('canonicalKey 非法输入抛 TypeError', () => {
    assert.throws(() => CooccurrenceTracker.canonicalKey('', 'a'), TypeError)
    assert.throws(() => CooccurrenceTracker.canonicalKey('a', ''), TypeError)
    assert.throws(() => CooccurrenceTracker.canonicalKey(null, 'a'), TypeError)
  })

  test('parseKey 还原', () => {
    assert.deepEqual(CooccurrenceTracker.parseKey('a|b'), { a: 'a', b: 'b' })
    assert.deepEqual(CooccurrenceTracker.parseKey('risk|stop_loss'), { a: 'risk', b: 'stop_loss' })
  })
})

describe('CooccurrenceTracker.recordPair / recordEpisode', () => {
  test('单次 recordPair：count=1, lastSeen=now', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      const r = t.recordPair('a', 'b', 1, mockNow)
      assert.equal(t.size, 1)
      assert.equal(r.count, 1)
      const p = t.getAllPairs()[0]
      assert.equal(p.a, 'a')
      assert.equal(p.b, 'b')
      assert.equal(p.count, 1)
      assert.equal(p.lastSeen, mockNow)
      assert.equal(p.firstSeen, mockNow)
    })
  })

  test('recordPair(a,b) === recordPair(b,a)：规范化生效', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      t.recordPair('a', 'b')
      t.recordPair('b', 'a') // 同一对，应累加
      assert.equal(t.size, 1)
      assert.equal(t.getAllPairs()[0].count, 2)
    })
  })

  test('weight 累加（默认 1/次）', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      t.recordPair('a', 'b', 2)
      t.recordPair('a', 'b', 3)
      const p = t.getAllPairs()[0]
      assert.equal(p.count, 2)
      assert.equal(p.weight, 5)
    })
  })

  test('自共现忽略（a === b）', () => {
    const t = new CooccurrenceTracker()
    const r = t.recordPair('a', 'a')
    assert.equal(t.size, 0)
    assert.equal(r.count, 0)
  })

  test('recordEpisode：4 概念生成 C(4,2)=6 pair', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      const r = t.recordEpisode(['a', 'b', 'c', 'd'])
      assert.equal(r.recorded, 6)
      assert.equal(t.size, 6)
    })
  })

  test('recordEpisode 自动去重（同一 episode 内重复出现不重复计数）', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      t.recordEpisode(['a', 'b', 'a', 'b']) // 概念 a/b 各出现 1 次（去重后）
      assert.equal(t.size, 1)
      assert.equal(t.getAllPairs()[0].count, 1)
    })
  })

  test('recordEpisode 长度 < 2 不记录', () => {
    const t = new CooccurrenceTracker()
    assert.equal(t.recordEpisode(['a']).recorded, 0)
    assert.equal(t.recordEpisode([]).recorded, 0)
    assert.equal(t.size, 0)
  })

  test('非法输入抛 TypeError', () => {
    const t = new CooccurrenceTracker()
    assert.throws(() => t.recordPair('', 'a'), TypeError)
    assert.throws(() => t.recordPair('a', null), TypeError)
  })
})

// ----------------------------------------------------------------------------
// LRU 10k 上限 —— 4 重护栏 #1
// ----------------------------------------------------------------------------

describe('CooccurrenceTracker LRU 10k 上限（4 重护栏 #1）', () => {
  test('插入 15000 pair 后 size=10000，触发 5000 次 LRU 淘汰', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ maxPairs: 10000 })
      let evictedCount = 0
      // 一次性插入 15000 个不同的 pair（i 与 j 组合）
      for (let i = 0; i < 15000; i++) {
        const a = `n${i}`
        const b = `n${i + 1}`
        const r = t.recordPair(a, b, 1, mockNow + i) // lastSeen 递增
        if (r.evicted) evictedCount += 1
      }
      assert.equal(t.size, 10000, 'LRU 上限严格生效')
      assert.equal(evictedCount, 5000, '淘汰 5000 次')
    })
  })

  test('LRU 淘汰按 lastSeen 升序（最早的被淘汰）', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ maxPairs: 3 })
      // 3 个 pair：a-b (t=100), c-d (t=200), e-f (t=300)
      t.recordPair('a', 'b', 1, 100)
      t.recordPair('c', 'd', 1, 200)
      t.recordPair('e', 'f', 1, 300)
      assert.equal(t.size, 3)
      // 插入第 4 个 pair（lastSeen=400）→ 应淘汰 a-b（lastSeen=100）
      t.recordPair('g', 'h', 1, 400)
      assert.equal(t.size, 3)
      const keys = Array.from(t.pairs.keys())
      assert.ok(!keys.includes('a|b'), 'a-b 被淘汰')
      assert.ok(keys.includes('c|d'), 'c-d 保留')
      assert.ok(keys.includes('e|f'), 'e-f 保留')
      assert.ok(keys.includes('g|h'), 'g-h 新增')
    })
  })

  test('更新已存在 pair 不触发 LRU 淘汰', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ maxPairs: 2 })
      t.recordPair('a', 'b', 1, 100)
      t.recordPair('c', 'd', 1, 200)
      assert.equal(t.size, 2)
      // 更新 a-b（已存在）不触发 LRU
      t.recordPair('a', 'b', 1, 300)
      assert.equal(t.size, 2)
    })
  })
})

// ----------------------------------------------------------------------------
// half-life 1 周衰减 —— 4 重护栏 #2
// ----------------------------------------------------------------------------

describe('CooccurrenceTracker half-life 1 周衰减（4 重护栏 #2 默认）', () => {
  test('半衰期：1 周前 pair 的 effectiveCount 减半', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ halfLifeHours: 168 })
      t.recordPair('a', 'b', 1, mockNow - WEEK_MS) // 1 周前
      const now = mockNow
      const p = t.getAllPairs()[0]
      const ec = t.effectiveCount(p, now)
      // exp(-ln2 × 168 / 168) = exp(-ln2) = 0.5
      near(ec, 0.5, '1 周前 pair 的 effectiveCount')
    })
  })

  test('半衰期：2 周前 = 0.25，3 周前 = 0.125', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ halfLifeHours: 168 })
      t.recordPair('a', 'b', 1, mockNow - 2 * WEEK_MS)
      const ec = t.effectiveCount(t.getAllPairs()[0], mockNow)
      near(ec, 0.25, '2 周前 pair 的 effectiveCount')
      t.clear()
      t.recordPair('a', 'b', 1, mockNow - 3 * WEEK_MS)
      const ec3 = t.effectiveCount(t.getAllPairs()[0], mockNow)
      near(ec3, 0.125, '3 周前 pair 的 effectiveCount')
    })
  })

  test('effectiveCount(now) === pair.count 当 now = lastSeen', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      t.recordPair('a', 'b', 1, mockNow)
      const p = t.getAllPairs()[0]
      near(t.effectiveCount(p, mockNow), p.count, 'now=lastSeen 时无衰减')
    })
  })

  test('effectiveCount 对未来时间无负增长（past/future 边界）', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      t.recordPair('a', 'b', 1, mockNow)
      const p = t.getAllPairs()[0]
      // now < lastSeen → deltaMs=0，effectiveCount=count（不退化）
      const ec = t.effectiveCount(p, mockNow - 1 * HOUR_MS)
      near(ec, p.count, '过去 now 不退化')
    })
  })
})

// ----------------------------------------------------------------------------
// getFrequentPairs 行为 + minCount / since / limit
// ----------------------------------------------------------------------------

describe('CooccurrenceTracker.getFrequentPairs', () => {
  test('minCount 过滤低频：count=4 不入选（默认 minCount=5）', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      // count=3 (a-b)
      for (let i = 0; i < 3; i++) t.recordPair('a', 'b')
      // count=10 (c-d)
      for (let i = 0; i < 10; i++) t.recordPair('c', 'd')
      const pairs = t.getFrequentPairs({ now: mockNow })
      assert.equal(pairs.length, 1, '只 c-d 入选')
      assert.equal(pairs[0].a, 'c')
      assert.equal(pairs[0].count, 10)
    })
  })

  test('按 effectiveCount 降序排列', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker()
      // a-b 计数 5
      for (let i = 0; i < 5; i++) t.recordPair('a', 'b')
      // c-d 计数 20
      for (let i = 0; i < 20; i++) t.recordPair('c', 'd')
      // e-f 计数 10
      for (let i = 0; i < 10; i++) t.recordPair('e', 'f')
      const pairs = t.getFrequentPairs({ now: mockNow })
      assert.equal(pairs.length, 3)
      assert.equal(pairs[0].a, 'c') // count=20
      assert.equal(pairs[1].a, 'e') // count=10
      assert.equal(pairs[2].a, 'a') // count=5
    })
  })

  test('since 过滤：只看 lastSeen >= since 的 pair', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ minCount: 1 })
      t.recordPair('a', 'b', 1, mockNow - 5000) // 5s 前
      t.recordPair('c', 'd', 1, mockNow)        // 现在
      t.recordPair('e', 'f', 1, mockNow - 2000) // 2s 前
      const pairs = t.getFrequentPairs({ since: mockNow - 3000, now: mockNow })
      assert.equal(pairs.length, 2)
      const keys = pairs.map((p) => p.a).sort()
      assert.deepEqual(keys, ['c', 'e'])
    })
  })

  test('limit 截断：只返回前 N 条', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ minCount: 1 })
      for (let i = 0; i < 10; i++) t.recordPair(`n${i}`, `n${i + 1}`, 1, mockNow)
      const pairs = t.getFrequentPairs({ limit: 3, now: mockNow })
      assert.equal(pairs.length, 3)
    })
  })

  test('空 tracker 返回空数组', () => {
    const t = new CooccurrenceTracker()
    assert.deepEqual(t.getFrequentPairs(), [])
  })
})

// ----------------------------------------------------------------------------
// CooccurrenceTracker 持久化
// ----------------------------------------------------------------------------

describe('CooccurrenceTracker 持久化 toJSON / fromJSON', () => {
  test('往返：maxPairs/minCount/halfLifeHours + pairs 全部保留', () => {
    withMockTime(() => {
      const t = new CooccurrenceTracker({ maxPairs: 100, minCount: 3, halfLifeHours: 24 })
      t.recordPair('a', 'b', 2, mockNow)
      t.recordPair('c', 'd', 5, mockNow + 1000)
      const json = t.toJSON()
      assert.equal(json.maxPairs, 100)
      assert.equal(json.minCount, 3)
      assert.equal(json.halfLifeHours, 24)
      assert.equal(json.pairs.length, 2)

      const t2 = new CooccurrenceTracker()
      t2.fromJSON(json)
      assert.equal(t2.maxPairs, 100)
      assert.equal(t2.minCount, 3)
      assert.equal(t2.halfLifeHours, 24)
      assert.equal(t2.size, 2)
    })
  })

  test('fromJSON 缺字段保留默认', () => {
    const t = new CooccurrenceTracker({ maxPairs: 50 })
    t.fromJSON({ pairs: [['a|b', { a: 'a', b: 'b', count: 5, weight: 5, lastSeen: 100, firstSeen: 100 }]] })
    assert.equal(t.maxPairs, 50, '缺 maxPairs 保留默认')
    assert.equal(t.size, 1)
  })

  test('fromJSON 非法输入抛错', () => {
    const t = new CooccurrenceTracker()
    assert.throws(() => t.fromJSON(null), TypeError)
    assert.throws(() => t.fromJSON('not-object'), TypeError)
  })
})

// ===========================================================================
// CatsNet.learnConcepts 集成测试
// ===========================================================================

describe('CatsNet —— CooccurrenceTracker 初始化与暴露', () => {
  test('CatsNet 默认带一个空 CooccurrenceTracker', () => {
    const cn = new CatsNet()
    assert.ok(cn.cooccurrence instanceof CooccurrenceTracker)
    assert.equal(cn.cooccurrence.size, 0)
    assert.equal(cn.cooccurrence.maxPairs, 10000)
    assert.equal(cn.cooccurrence.minCount, 5)
  })

  test('CatsNet 支持 cooccurrenceOptions 定制 tracker', () => {
    const cn = new CatsNet({ cooccurrenceOptions: { maxPairs: 100, minCount: 2, halfLifeHours: 24 } })
    assert.equal(cn.cooccurrence.maxPairs, 100)
    assert.equal(cn.cooccurrence.minCount, 2)
    assert.equal(cn.cooccurrence.halfLifeHours, 24)
  })

  test('reset() 重置 cooccurrence 为空', () => {
    const cn = new CatsNet()
    cn.cooccurrence.recordPair('a', 'b')
    assert.equal(cn.cooccurrence.size, 1)
    cn.reset()
    assert.equal(cn.cooccurrence.size, 0)
  })
})

// ----------------------------------------------------------------------------
// learnConcepts 端到端
// ----------------------------------------------------------------------------

describe('CatsNet.learnConcepts —— 端到端', () => {
  test('10 次共现后归纳新概念（4 未知概念 + 10 episodes）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      // 4 个不同类型的概念，attribute 差异大 → 相似度 < 0.6，不会被自动合并
      const episodes = []
      for (let i = 0; i < 10; i++) {
        episodes.push({
          concepts: ['risk_event', 'volatility_index', 'trader_alice', 'market_open'],
          timestamp: mockNow + i * 1000,
        })
      }
      const result = cn.learnConcepts({ episodes, now: mockNow + 10 * 1000 })
      // 6 个 pair 都 count=10，Laplace 平滑后 conf = 10/12 ≈ 0.833
      // 4 个新概念全部归纳（maxNew=10 允许）
      // 后续可能触发合并（同 type=abstract + 无 attr → sim=0.65 >= 0.6），但归纳步骤是 4 个
      assert.ok(result.added.length >= 1, `至少 1 个新概念，实得 ${result.added.length}`)
      assert.equal(result.added.length, 4, '4 个新概念被归纳（added 计数）')
      assert.equal(result.recordedPairs, 60, 'C(4,2) × 10 = 60 pair-records')
      // cooccurrence tracker 收到 6 个不同的 pair（每个 count=10）
      assert.equal(cn.cooccurrence.size, 6, 'tracker 收到 6 个 pair')
    })
  })

  test('相似度 0.6+ 自动合并（两个高度相似节点 + 5 次共现）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      // 制造 2 个高度相似的节点：同 type、同 label、相似数值属性
      cn.addNode({
        id: 'apple_red',
        type: 'entity',
        attributes: { label: 'apple', size: 1.0 },
        confidence: 0.9,
      })
      cn.addNode({
        id: 'apple_red_alt',
        type: 'entity',
        attributes: { label: 'apple', size: 1.1 },
        confidence: 0.85,
      })
      // 验证 similarity >= 0.6
      const sim = cn.getNode('apple_red').similarity(cn.getNode('apple_red_alt'))
      assert.ok(sim >= 0.6, `基础相似度 ${sim} 应 >= 0.6`)

      // 5 次共现（满足 minCount=5）
      const episodes = []
      for (let i = 0; i < 5; i++) {
        episodes.push({ concepts: ['apple_red', 'apple_red_alt'], timestamp: mockNow + i * 1000 })
      }
      const result = cn.learnConcepts({ episodes, now: mockNow + 5 * 1000 })
      assert.ok(result.merged.length >= 1, `至少 1 次合并，实得 ${result.merged.length}`)
      // 合并后只剩 1 个节点（keeper 保留，removee 删除）
      assert.equal(cn.size, 1, '合并后 2 节点变 1 节点')
    })
  })

  test('不相似 pair 不合并（保留两个独立节点）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'cat', type: 'entity', attributes: { species: 'feline' } })
      cn.addNode({ id: 'dog', type: 'entity', attributes: { species: 'canine' } })
      const sim = cn.getNode('cat').similarity(cn.getNode('dog'))
      assert.ok(sim < 0.6, `cat vs dog 相似度 ${sim} 应 < 0.6`)

      const episodes = []
      for (let i = 0; i < 6; i++) {
        episodes.push({ concepts: ['cat', 'dog'], timestamp: mockNow + i * 1000 })
      }
      const result = cn.learnConcepts({ episodes, now: mockNow + 6 * 1000 })
      assert.equal(result.merged.length, 0, '不相似 pair 不合并')
      assert.equal(cn.size, 2, '保留 2 节点')
    })
  })
})

// ----------------------------------------------------------------------------
// 4 重护栏实测
// ----------------------------------------------------------------------------

describe('CatsNet.learnConcepts —— 4 重护栏', () => {
  test('护栏 #2 minCount 5：count=4 不归纳新概念', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'anchor' })
      const episodes = []
      for (let i = 0; i < 4; i++) {
        episodes.push({ concepts: ['anchor', 'newbie'], timestamp: mockNow + i * 1000 })
      }
      const result = cn.learnConcepts({ episodes, now: mockNow + 4 * 1000 })
      assert.equal(result.added.length, 0, 'count=4 不满足 minCount=5，不归纳')
      assert.equal(cn.hasNode('newbie'), false)
    })
  })

  test('护栏 #2+3 minConfidence 0.7 + Laplace：count=5 conf=0.714 入选', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'anchor' })
      const episodes = []
      for (let i = 0; i < 5; i++) {
        episodes.push({ concepts: ['anchor', 'newbie'], timestamp: mockNow + i * 1000 })
      }
      const result = cn.learnConcepts({ episodes, now: mockNow + 5 * 1000 })
      assert.equal(result.added.length, 1, 'count=5 入选')
      // 验证 confidence = 5/(5+2) = 0.714
      near(cn.getNode('newbie').confidence, 5 / 7, 'newbie confidence = 5/7 ≈ 0.714')
    })
  })

  test('护栏 #3 maxNew 10：单次新增不超过 10', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'anchor' })
      // 12 个不同新概念，每个都跟 anchor 共现 5 次
      const episodes = []
      for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 5; j++) {
          episodes.push({ concepts: ['anchor', `new${i}`], timestamp: mockNow + j * 1000 })
        }
      }
      const result = cn.learnConcepts({ episodes, now: mockNow + 5 * 1000, maxNew: 10 })
      assert.equal(result.added.length, 10, 'maxNew=10 严格执行')
    })
  })

  test('护栏 #4 half-life 1 周：1 周前的低 count pair 被衰减掉', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'anchor' })
      // 5 次共现，但都在 1 周前
      const oldEpisodes = []
      for (let i = 0; i < 5; i++) {
        oldEpisodes.push({ concepts: ['anchor', 'old_newbie'], timestamp: mockNow - WEEK_MS + i * 1000 })
      }
      // 跑 learnConcepts now = mockNow，5 次的 pair 在 1 周前 effectiveCount = 5 × 0.5 = 2.5 < minCount=5
      const result = cn.learnConcepts({ episodes: oldEpisodes, now: mockNow })
      assert.equal(result.added.length, 0, '1 周前 5 次共现衰减后 < 5，不归纳')
    })
  })

  test('护栏 #1 LRU 10k：插入 100k pair 不爆内存（最终 size <= 10000）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const episodes = []
      // 100k episode，每个含 2 个不同 pair（i+100k vs i）
      for (let i = 0; i < 1000; i++) {
        const e = [`n${i}`, `m${i}`]
        episodes.push({ concepts: e, timestamp: mockNow + i })
      }
      cn.learnConcepts({ episodes, now: mockNow + 1000 })
      assert.ok(cn.cooccurrence.size <= 10000, `cooccurrence.size = ${cn.cooccurrence.size} 应 <= 10000`)
    })
  })
})

// ----------------------------------------------------------------------------
// learnConcepts 冷概念降权
// ----------------------------------------------------------------------------

describe('CatsNet.learnConcepts —— 冷概念降权', () => {
  test('100 天前 lastActivatedAt 的节点被降权（v0.5.1 R6：salience × 0.5）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const old = cn.addNode({
        id: 'cold_node',
        level: 'semantic',
        confidence: 0.8,
        activation: 0.1, // < 0.3 阈值
        lastActivatedAt: mockNow - 100 * DAY_MS, // 100 天前
      })
      // v0.5.1 R6：默认 salience = confidence（构造器逻辑），所以初始 salience = 0.8
      const before = old.salience
      const result = cn.learnConcepts({ now: mockNow, episodes: [] })
      assert.ok(result.demoted.length >= 1, '至少 1 个 demoted')
      const entry = result.demoted.find((d) => d.id === 'cold_node')
      assert.ok(entry, 'cold_node 在 demoted 列表')
      // v0.5.1 R6：字段名从 beforeConfidence/afterConfidence 迁 beforeSalience/afterSalience
      assert.equal(entry.beforeSalience, before, 'beforeSalience = 0.8（默认 = confidence）')
      near(entry.afterSalience, before * 0.5, '降权后 salience = 0.4')
      // confidence 不再被改动（统一降权机制走 salience，confidence 保持证据强度）
      assert.equal(old.confidence, 0.8, 'confidence 不被 learnConcepts 冷降权改动')
    })
  })

  test('活跃节点（最近激活）不被降权', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const active = cn.addNode({
        id: 'active_node',
        level: 'semantic',
        confidence: 0.8,
        activation: 0.5,
        lastActivatedAt: mockNow - 1 * DAY_MS, // 1 天前
      })
      const result = cn.learnConcepts({ now: mockNow, episodes: [] })
      const entry = result.demoted.find((d) => d.id === 'active_node')
      assert.equal(entry, undefined, '1 天前激活的节点不降权')
    })
  })

  test('高激活但久未访问的节点也不降权（activation >= 0.3）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const hot = cn.addNode({
        id: 'hot_node',
        level: 'semantic',
        confidence: 0.8,
        activation: 0.7, // 高激活
        lastActivatedAt: mockNow - 100 * DAY_MS,
      })
      const result = cn.learnConcepts({ now: mockNow, episodes: [] })
      const entry = result.demoted.find((d) => d.id === 'hot_node')
      assert.equal(entry, undefined, '高激活节点即使 100 天不访问也不降权')
    })
  })

  test('coldDays 自定义：50 天阈值也能降权', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      const node = cn.addNode({
        id: 'semi_cold',
        level: 'semantic',
        confidence: 0.6,
        activation: 0.1,
        lastActivatedAt: mockNow - 60 * DAY_MS,
      })
      // v0.5.1 R6：默认 salience = confidence = 0.6
      const before = node.salience
      const result = cn.learnConcepts({ now: mockNow, episodes: [], coldDays: 50 })
      const entry = result.demoted.find((d) => d.id === 'semi_cold')
      assert.ok(entry, 'coldDays=50 时 60 天前节点降权')
      // v0.5.1 R6：验证 salience 字段被减半（统一降权机制）
      assert.equal(entry.beforeSalience, before, 'beforeSalience = 0.6')
      near(entry.afterSalience, before * 0.5, 'afterSalience = 0.3')
    })
  })
})

// ----------------------------------------------------------------------------
// learnConcepts 与 episodic memory 集成
// ----------------------------------------------------------------------------

describe('CatsNet.learnConcepts —— 与 episodic memory 集成', () => {
  test('不传 episodes 时从 projection.getMemories() 拉', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      // 直接造一些抽象空间节点，让 projection 能写入
      cn.addNode({ id: 'risk' })
      cn.addNode({ id: 'stop_loss' })
      // 5 条记忆（每条 concept 数 = 2）
      for (let i = 0; i < 5; i++) {
        cn.projectMemory({
          id: `mem${i}`,
          concepts: ['risk', 'stop_loss'],
          strength: 0.9,
        })
      }
      // 不传 episodes
      const result = cn.learnConcepts({ now: mockNow })
      assert.equal(result.recordedPairs, 5, '从 projection 拉 5 个 pair-records')
    })
  })

  test('手动传 episodes 时优先使用（不读 projection）', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'risk' })
      cn.addNode({ id: 'stop_loss' })
      cn.projectMemory({ id: 'm_old', concepts: ['risk', 'stop_loss'], strength: 0.9 })
      // 手动传 3 个 episode
      const result = cn.learnConcepts({
        episodes: [
          { concepts: ['risk', 'stop_loss'] },
          { concepts: ['risk', 'stop_loss'] },
          { concepts: ['risk', 'stop_loss'] },
        ],
        now: mockNow,
      })
      assert.equal(result.recordedPairs, 3, '优先用传入的 3 个 episode')
    })
  })
})

// ----------------------------------------------------------------------------
// 合并后的连接 / 记忆重定向
// ----------------------------------------------------------------------------

describe('CatsNet.learnConcepts —— 合并副作用', () => {
  test('合并后指向 removee 的连接被重定向到 keeper', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      // 三个高度相似节点
      const a = cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'foo' }, confidence: 0.9 })
      const b = cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'foo' }, confidence: 0.85 })
      const c = cn.addNode({ id: 'c', type: 'entity' })
      // c 连接到 a
      c.connect('a', 0.7, 'association')
      // 触发合并：5 次 a-b 共现
      const episodes = []
      for (let i = 0; i < 5; i++) {
        episodes.push({ concepts: ['a', 'b'], timestamp: mockNow + i * 1000 })
      }
      cn.learnConcepts({ episodes, now: mockNow + 5 * 1000 })
      // 合并后：keeper 是 a（conf 更高）；c 原本连 a，a 仍在；b 已被合并到 a
      assert.ok(cn.hasNode('a'), 'a (keeper) 保留')
      assert.ok(!cn.hasNode('b'), 'b (removee) 被删除')
      // c 仍连 a（不需要重定向），但如果 c 连 b，则 b 的连接应重定向到 a
      // 这里 c 直接连 a，没问题；用一个新连接测一下：d 连 b
      cn.addNode({ id: 'd' })
      // 重新构造场景
      const cn2 = new CatsNet()
      const a2 = cn2.addNode({ id: 'a', type: 'entity', attributes: { name: 'foo' }, confidence: 0.9 })
      const b2 = cn2.addNode({ id: 'b', type: 'entity', attributes: { name: 'foo' }, confidence: 0.85 })
      const d2 = cn2.addNode({ id: 'd' })
      d2.connect('b', 0.5, 'causal')
      const ep2 = []
      for (let i = 0; i < 5; i++) ep2.push({ concepts: ['a', 'b'], timestamp: mockNow + i * 1000 })
      cn2.learnConcepts({ episodes: ep2, now: mockNow + 5 * 1000 })
      assert.ok(!cn2.hasNode('b'), 'b 被删除')
      // d 应该重定向连接到 a
      const dConn = cn2.getNode('d').getConnections()
      const toA = dConn.find((c) => c.targetId === 'a')
      assert.ok(toA, 'd 的连接从 b 重定向到 a')
      assert.equal(toA.weight, 0.5, '重定向保留原 weight')
    })
  })

  test('合并后 projection memory.concepts[] 中的 id 被重定向', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'a', type: 'entity', attributes: { name: 'foo' }, confidence: 0.9 })
      cn.addNode({ id: 'b', type: 'entity', attributes: { name: 'foo' }, confidence: 0.85 })
      // 写入一条 memory 含 b
      cn.projectMemory({ id: 'm1', concepts: ['a', 'b'], strength: 0.9 })
      // 触发合并
      const episodes = []
      for (let i = 0; i < 5; i++) {
        episodes.push({ concepts: ['a', 'b'], timestamp: mockNow + i * 1000 })
      }
      cn.learnConcepts({ episodes, now: mockNow + 5 * 1000 })
      // memory.concepts 中 b → a
      const mem = cn.projection.get('m1')
      assert.ok(mem, 'memory 仍在')
      assert.ok(mem.concepts.includes('a'), 'a 保留')
      assert.ok(!mem.concepts.includes('b'), 'b 被重定向走（应只剩 a）')
    })
  })
})

// ----------------------------------------------------------------------------
// Serializer 集成
// ----------------------------------------------------------------------------

describe('CatsNet —— Serializer 集成（cooccurrence 字段）', () => {
  test('serialize/deserialize round-trip 保留 CooccurrenceTracker', () => {
    withMockTime(() => {
      const cn = new CatsNet()
      cn.addNode({ id: 'x' })
      cn.cooccurrence.recordPair('a', 'b', 3, mockNow)
      cn.cooccurrence.recordPair('c', 'd', 7, mockNow)
      const ser = new Serializer()
      const snap = ser.serialize(cn.serialize())
      assert.ok(snap.cooccurrence, 'snapshot 含 cooccurrence 字段')
      assert.equal(snap.cooccurrence.pairs.length, 2)
      // 加载到新 CatsNet
      const cn2 = new CatsNet()
      const loaded = ser.deserialize(snap)
      cn2.deserialize(loaded)
      assert.equal(cn2.cooccurrence.size, 2, 'cooccurrence 完整恢复')
      // 也保留 maxPairs/minCount/halfLifeHours
      assert.equal(cn2.cooccurrence.maxPairs, 10000)
    })
  })

  test('save/load 文件 round-trip 保留 CooccurrenceTracker', () => {
    withMockTime(() => {
      const tmp = mkdtempSync(join(tmpdir(), 'catsnet-learn-'))
      try {
        const cn = new CatsNet()
        cn.cooccurrence.recordPair('a', 'b', 5, mockNow)
        const file = join(tmp, 'snap.json')
        cn.save(file)
        const cn2 = new CatsNet()
        cn2.load(file)
        assert.equal(cn2.cooccurrence.size, 1)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  })

  test('向后兼容：旧快照无 cooccurrence 字段仍可加载（空 tracker）', () => {
    // 模拟 v0.3.0 之前的快照（无 cooccurrence 字段）
    const legacySnap = {
      format: 'cats-net',
      version: '1.0.0',
      savedAt: '2026-01-01T00:00:00.000Z',
      nodes: [{ id: 'a', name: 'a', type: 'abstract', level: 'semantic', attributes: {}, activation: 0, confidence: 1, granularity: 1, connections: [], history: [] }],
      memory: [],
      meta: {},
      // 故意不写 cooccurrence
    }
    const ser = new Serializer()
    const loaded = ser.deserialize(legacySnap)
    const cn = new CatsNet()
    cn.deserialize(loaded)
    assert.ok(cn.cooccurrence instanceof CooccurrenceTracker)
    assert.equal(cn.cooccurrence.size, 0, '旧快照加载后 cooccurrence 为空')
  })
})

// ----------------------------------------------------------------------------
// learnConcepts 易错点 / 边界
// ----------------------------------------------------------------------------

describe('CatsNet.learnConcepts —— 边界与异常', () => {
  test('非法 minConfidence 抛 TypeError', () => {
    const cn = new CatsNet()
    assert.throws(() => cn.learnConcepts({ minConfidence: 0 }), TypeError)
    assert.throws(() => cn.learnConcepts({ minConfidence: -1 }), TypeError)
  })

  test('非法 maxNew 抛 TypeError', () => {
    const cn = new CatsNet()
    assert.throws(() => cn.learnConcepts({ maxNew: -1 }), TypeError)
  })

  test('空 episodes 且 projection 为空：返回空结果', () => {
    const cn = new CatsNet()
    const result = cn.learnConcepts()
    assert.deepEqual(result.added, [])
    assert.deepEqual(result.merged, [])
    assert.equal(result.recordedPairs, 0)
  })

  test('已 abort 的 CatsNet 调 learnConcepts 抛错', () => {
    const cn = new CatsNet()
    cn.abort()
    assert.throws(() => cn.learnConcepts(), /紧急终止/)
  })

  test('episodes 中含非法元素（无 concepts 字段）不抛错', () => {
    const cn = new CatsNet()
    assert.doesNotThrow(() => {
      cn.learnConcepts({
        episodes: [
          null,
          {},
          { concepts: null },
          { concepts: 'not-array' },
          { concepts: ['a'] }, // length < 2
          { concepts: ['a', 'b'] }, // 有效
        ],
      })
    })
  })
})
