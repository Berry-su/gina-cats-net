/**
 * 知识植入脚本 —— 将历史市场风波案例植入 GINA 大脑
 *
 * 流程：读取结构化案例数据 → 注册 CATS-Net 概念节点并建立连接 →
 *       逐条写入工作记忆 → 批量转移短期记忆 → 巩固到长期记忆（同时投影至抽象空间）→
 *       持久化快照 → 运行多组检索验证召回效果。
 *
 * 运行：node scripts/seed-knowledge.mjs [可选：数据文件路径]
 * 默认数据：./data/market-crises.json
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { CatsNet, ConceptNode } from '../src/cats_net/index.js'
import { MemoryManager } from '../src/memory/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

const divider = '═'.repeat(64)

function section(title) {
  console.log(`\n${divider}`)
  console.log(`  ${title}`)
  console.log(divider)
}

function kv(key, value) {
  console.log(`  ${key}: ${value}`)
}

// ---------------------------------------------------------------------------
// 1. 读取数据
// ---------------------------------------------------------------------------
const dataPath = process.argv[2] ?? join(rootDir, 'data', 'market-crises.json')
const data = JSON.parse(readFileSync(dataPath, 'utf8'))
const concepts = Array.isArray(data.concepts) ? data.concepts : []
const connections = Array.isArray(data.connections) ? data.connections : []
const cases = Array.isArray(data.cases) ? data.cases : []

section('GINA 知识植入 —— 历史市场风波案例')
kv('数据文件', dataPath)
kv('概念节点数', concepts.length)
kv('连接数', connections.length)
kv('案例数', cases.length)

// ---------------------------------------------------------------------------
// 2. 构建 CATS-Net 抽象空间并注册概念
// ---------------------------------------------------------------------------
section('Step 1 · 注册概念节点到 CATS-Net 抽象空间')

const brain = new CatsNet({ maxIterations: 200, timeoutMs: 10000, decayFactor: 0.5 })

let conceptCount = 0
for (const c of concepts) {
  if (!c || typeof c.id !== 'string') continue
  brain.addNode(new ConceptNode(c))
  conceptCount++
}
kv('已注册概念节点', conceptCount)

// 建立带权连接（激活扩散通道）
let linkCount = 0
for (const link of connections) {
  const from = brain.getNode(link.from)
  const to = brain.getNode(link.to)
  if (!from || !to) continue
  from.connect(link.to, link.weight ?? 1, link.type ?? 'association', true)
  linkCount++
}
kv('已建立连接', linkCount)

// ---------------------------------------------------------------------------
// 3. 构建记忆管理器并接入 CATS-Net
// ---------------------------------------------------------------------------
section('Step 2 · 构建记忆系统并接入抽象空间')

const mm = new MemoryManager({
  catsNet: brain,
  working: { capacity: 7 },
  shortTerm: { capacity: 200 },
  longTerm: { capacity: 2000 },
})
kv('抽象空间接入', mm.hasAbstractSpace() ? '已接入' : '未接入（降级）')

// ---------------------------------------------------------------------------
// 4. 逐条写入工作记忆，分批转移到短期，最后统一巩固到长期
// ---------------------------------------------------------------------------
section('Step 3 · 案例注入：工作记忆 → 短期记忆 → 长期记忆（含抽象空间投影）')

const IMPORTANCE = 0.95
const BATCH = 7

let injected = 0
for (const c of cases) {
  const content = [
    `${c.name}（${c.year}年，${c.market}）`,
    `分类：${c.category}`,
    `触发：${c.trigger}`,
    `影响：${c.impact}`,
    `教训：${c.lesson}`,
  ].join(' | ')

  mm.addObservation({
    id: c.id,
    content,
    concepts: Array.isArray(c.concepts) ? c.concepts : [],
    tags: [c.region, c.category, '市场风波', '历史案例'],
    source: 'market_case',
    importance: IMPORTANCE,
  })
  injected++

  if (injected % BATCH === 0) {
    mm.shiftToShortTerm()
  }
}
// 冲刷剩余工作记忆
if (cases.length % BATCH !== 0) {
  mm.shiftToShortTerm()
}
kv('已写入工作记忆并转移短期', injected)

// 统一巩固到长期记忆（同时投影到 CATS-Net）
const consolidated = mm.consolidate({ minStrength: 0.6, maxConsolidate: 2000 })
kv('巩固到长期记忆', consolidated.consolidated)
kv('成功投影到抽象空间', consolidated.projected)
kv('暂未巩固（强度不足）', consolidated.skipped)

// ---------------------------------------------------------------------------
// 5. 检索验证
// ---------------------------------------------------------------------------
section('Step 4 · 检索召回验证')

const queries = [
  { label: '杠杆 + 泡沫 + 恐慌', q: ['leverage', 'bubble', 'panic'] },
  { label: '黑天鹅 + 恐慌', q: ['black_swan', 'panic'] },
  { label: '流动性危机', q: ['liquidity_crisis'] },
  { label: '政策市 + 监管', q: ['policy_market', 'regulation'] },
  { label: '止损风控', q: ['stop_loss'] },
]

for (const { label, q } of queries) {
  const results = mm.retrieve(q, { limit: 5 })
  console.log(`\n  ◆ 查询「${label}」 → 命中 ${results.length} 条`)
  for (const r of results) {
    const name = r.entry.label || r.entry.content?.slice(0, 24)
    console.log(`    · [${r.layer}] ${name}  分数=${r.score.toFixed(3)}`)
  }
}

// 直接从抽象空间唤回（验证记忆投影痕迹）
section('Step 5 · 抽象空间记忆痕迹唤回')
const abstractHits = brain.retrieveMemory(['leverage', 'panic'], { limit: 5 })
kv('抽象空间记忆痕迹总数', brain.projection.size)
kv('「杠杆+恐慌」唤回条数', abstractHits.length)
for (const { entry, score } of abstractHits) {
  kv(`    · ${entry.label}`, `score=${score.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// 6. 持久化
// ---------------------------------------------------------------------------
section('Step 6 · 持久化快照')

const brainSnapshot = join(rootDir, 'data', 'market-knowledge-brain.json')
const memorySnapshot = join(rootDir, 'data', 'market-knowledge-memory.json')
brain.save(brainSnapshot)
mm.save(memorySnapshot)
kv('CATS-Net 快照', brainSnapshot)
kv('记忆系统快照', memorySnapshot)

// ---------------------------------------------------------------------------
// 7. 汇总
// ---------------------------------------------------------------------------
section('植入完成 · 统计汇总')
const stats = mm.stats()
kv('工作记忆条目', stats.working)
kv('短期记忆条目', stats.shortTerm)
kv('长期记忆条目', stats.longTerm)
kv('CATS-Net 概念节点', brain.size)
kv('CATS-Net 记忆痕迹', brain.projection.size)
kv('抽象空间接入状态', stats.hasAbstractSpace ? '正常' : '降级')

console.log(`\n${divider}`)
console.log('  ✅ 历史市场风波经验已全部植入 GINA 大脑')
console.log(divider)