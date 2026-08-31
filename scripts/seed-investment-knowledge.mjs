/**
 * 知识植入脚本 —— 将顶尖投资书籍、交易技术与股神案例植入 GINA 大脑
 *
 * 与 seed-knowledge.mjs 同源，但支持三类型知识（book/technique/case），
 * 并在已有「市场危机知识」快照存在时自动合并到同一大脑，形成统一知识体系。
 *
 * 流程：读取数据 → (可选)加载已有危机大脑 → 注册概念/连接 →
 *       逐条写入工作记忆 → 批量转移短期 → 巩固长期(投影抽象空间) → 持久化 → 检索验证。
 *
 * 运行：node scripts/seed-investment-knowledge.mjs [可选：数据文件路径]
 * 默认数据：./data/investment-knowledge.json
 * 合并基座：./data/market-knowledge-brain.json + market-knowledge-memory.json（可选）
 */

import { readFileSync, existsSync } from 'node:fs'
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
const dataPath = process.argv[2] ?? join(rootDir, 'data', 'investment-knowledge.json')
const data = JSON.parse(readFileSync(dataPath, 'utf8'))
const concepts = Array.isArray(data.concepts) ? data.concepts : []
const connections = Array.isArray(data.connections) ? data.connections : []
const knowledge = Array.isArray(data.knowledge) ? data.knowledge : []

section('GINA 知识植入 —— 投资书籍 / 交易技术 / 股神案例')
kv('数据文件', dataPath)
kv('概念节点数', concepts.length)
kv('连接数', connections.length)
kv('知识条目数', knowledge.length)
kv('知识类型分布', [
  `书籍 ${knowledge.filter((k) => k.type === 'book').length}`,
  `技术 ${knowledge.filter((k) => k.type === 'technique').length}`,
  `案例 ${knowledge.filter((k) => k.type === 'case').length}`,
].join('，'))

// ---------------------------------------------------------------------------
// 2. 构建/合并 CATS-Net 抽象空间
// ---------------------------------------------------------------------------
section('Step 1 · 构建抽象空间（含已有危机大脑合并）')

const crisisBrain = join(rootDir, 'data', 'market-knowledge-brain.json')
const crisisMem = join(rootDir, 'data', 'market-knowledge-memory.json')

let brain
let mm
let merged = false

if (existsSync(crisisBrain) && existsSync(crisisMem)) {
  brain = new CatsNet({ maxIterations: 200, timeoutMs: 10000 })
  mm = new MemoryManager({
    catsNet: brain,
    working: { capacity: 7 },
    shortTerm: { capacity: 2000 },
    longTerm: { capacity: 5000 },
  })
  try {
    brain.load(crisisBrain)
    mm.load(crisisMem)
    merged = true
  } catch (err) {
    console.log(`  合并已有大脑失败，改用全新大脑: ${err.message}`)
    brain = new CatsNet({ maxIterations: 200, timeoutMs: 10000 })
    mm = new MemoryManager({
      catsNet: brain,
      working: { capacity: 7 },
      shortTerm: { capacity: 2000 },
      longTerm: { capacity: 5000 },
    })
  }
} else {
  brain = new CatsNet({ maxIterations: 200, timeoutMs: 10000 })
  mm = new MemoryManager({
    catsNet: brain,
    working: { capacity: 7 },
    shortTerm: { capacity: 2000 },
    longTerm: { capacity: 5000 },
  })
}

kv('是否合并已有危机大脑', merged ? `是（节点 ${brain.size}，长期记忆 ${mm.longTerm.size}）` : '否（全新）')

// 注册概念（已存在则跳过，避免覆盖危机概念）
let added = 0
for (const c of concepts) {
  if (!c || typeof c.id !== 'string') continue
  if (brain.hasNode(c.id)) continue
  brain.addNode(new ConceptNode(c))
  added++
}
kv('新增概念节点', added)

// 建立带权连接（两端存在才连接）
let linkCount = 0
for (const link of connections) {
  const from = brain.getNode(link.from)
  const to = brain.getNode(link.to)
  if (!from || !to) continue
  from.connect(link.to, link.weight ?? 1, link.type ?? 'association', true)
  linkCount++
}
kv('新增连接', linkCount)

// ---------------------------------------------------------------------------
// 3. 三种类型知识注入
// ---------------------------------------------------------------------------
section('Step 2 · 知识注入：工作记忆 → 短期记忆 → 长期记忆（含投影）')

const TYPE_META = {
  book: { prefix: '书籍', source: 'investment_book', tag: '投资书籍' },
  technique: { prefix: '交易技术', source: 'investment_technique', tag: '交易技术' },
  case: { prefix: '股神案例', source: 'investor_case', tag: '股神案例' },
}

function buildContent(item) {
  const meta = TYPE_META[item.type] ?? { prefix: '知识', source: 'investment', tag: '' }
  const parts = [`[${meta.prefix}] ${item.name}`]
  if (item.author) parts.push(`作者：${item.author}`)
  if (item.person) parts.push(`人物：${item.person}`)
  parts.push(`年份：${item.year ?? ''}`)
  parts.push(`类别：${item.category ?? ''}`)
  parts.push(`内容：${item.summary ?? ''}`)
  parts.push(`要点：${(item.keyPoints ?? []).join('；')}`)
  return parts.join(' | ')
}

const IMPORTANCE = 0.95
const BATCH = 7
let injected = 0

for (const item of knowledge) {
  const meta = TYPE_META[item.type] ?? { source: 'investment', tag: '' }
  mm.addObservation({
    id: item.id,
    content: buildContent(item),
    concepts: Array.isArray(item.concepts) ? item.concepts : [],
    tags: [item.category ?? '', meta.tag, '投资知识', '股神课堂'],
    source: meta.source,
    importance: IMPORTANCE,
  })
  injected++
  if (injected % BATCH === 0) mm.shiftToShortTerm()
}
if (knowledge.length % BATCH !== 0) mm.shiftToShortTerm()

kv('已写入并转移短期', injected)

const consolidated = mm.consolidate({ minStrength: 0.6, maxConsolidate: 5000 })
kv('巩固到长期记忆', consolidated.consolidated)
kv('成功投影到抽象空间', consolidated.projected)
kv('暂未巩固', consolidated.skipped)

// ---------------------------------------------------------------------------
// 4. 检索验证
// ---------------------------------------------------------------------------
section('Step 3 · 检索召回验证')

const queries = [
  { label: '价值投资 + 安全边际', q: ['value_investing', 'margin_of_safety'] },
  { label: '趋势跟踪 + 技术分析', q: ['trend_following', 'technical_analysis'] },
  { label: '反身性 + 做空', q: ['reflexivity', 'short_selling'] },
  { label: '行为金融 + 交易心理', q: ['behavior_finance', 'trading_psychology'] },
  { label: '仓位管理 + 止损风控', q: ['position_sizing', 'stop_loss'] },
]

for (const { label, q } of queries) {
  const results = mm.retrieve(q, { limit: 5 })
  console.log(`\n  ◆ 查询「${label}」 → 命中 ${results.length} 条`)
  for (const r of results) {
    const name = r.entry.label || r.entry.content?.slice(0, 28)
    console.log(`    · [${r.layer}] ${name}  分数=${r.score.toFixed(3)}`)
  }
}

section('Step 4 · 抽象空间记忆痕迹')
kv('抽象空间记忆痕迹总数', brain.projection.size)
const absHits = brain.retrieveMemory(['value_investing', 'moat'], { limit: 5 })
for (const { entry, score } of absHits) {
  kv(`    · ${entry.label}`, `score=${score.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// 5. 持久化
// ---------------------------------------------------------------------------
section('Step 5 · 持久化快照')

const brainSnapshot = join(rootDir, 'data', 'gina-knowledge-brain.json')
const memorySnapshot = join(rootDir, 'data', 'gina-knowledge-memory.json')
brain.save(brainSnapshot)
mm.save(memorySnapshot)
kv('CATS-Net 快照（合并后）', brainSnapshot)
kv('记忆系统快照（合并后）', memorySnapshot)

// ---------------------------------------------------------------------------
// 6. 汇总
// ---------------------------------------------------------------------------
section('植入完成 · 统计汇总')
const stats = mm.stats()
kv('工作记忆', stats.working)
kv('短期记忆', stats.shortTerm)
kv('长期记忆', stats.longTerm)
kv('CATS-Net 概念节点', brain.size)
kv('CATS-Net 记忆痕迹', brain.projection.size)
kv('抽象空间接入', stats.hasAbstractSpace ? '正常' : '降级')

console.log(`\n${divider}`)
console.log('  ✅ 投资书籍 / 交易技术 / 股神案例已全部植入 GINA 大脑')
console.log(divider)