/**
 * 分析师团队 —— 共享大脑引导 (brain.js)
 *
 * 所有分析师分身共享同一个 Gina 大脑：
 *   - 同一个 CatsNet 抽象空间 + 同一个 MemoryManager 分层记忆；
 *   - 复用已植入的危机/投资知识，通过 KnowledgeAdvisor / MarketRegimeAdvisor 提供体系化依据。
 *
 * createSharedBrain() 会优先加载统一快照 data/gina-knowledge-*.json，不存在则降级为空大脑，
 * 保证「有快照即具备先验知识，无快照也能跑通规则」。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { CatsNet } from '../cats_net/index.js'
import { MemoryManager } from '../memory/index.js'
import { KnowledgeAdvisor, MarketRegimeAdvisor } from '../trading/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dirname, '..', '..', 'data')

/**
 * 构建/复用共享大脑。
 * @param {object} [options]
 * @param {CatsNet|null} [options.brain]        外部提供的 CATS-Net（优先复用）
 * @param {MemoryManager|null} [options.memoryManager] 外部提供的记忆管理器（优先复用）
 * @returns {{catsNet:CatsNet, memoryManager:MemoryManager, knowledgeAdvisor:KnowledgeAdvisor, regimeAdvisor:MarketRegimeAdvisor}}
 */
export function createSharedBrain({ brain = null, memoryManager = null } = {}) {
  let catsNet = brain
  let mm = memoryManager

  if (!catsNet) {
    catsNet = new CatsNet({ maxIterations: 200, timeoutMs: 10000 })
    const brainPath = join(dataDir, 'gina-knowledge-brain.json')
    if (existsSync(brainPath)) {
      try { catsNet.load(brainPath) } catch { /* 忽略损坏快照 */ }
    }
  }

  if (!mm) {
    mm = new MemoryManager({
      catsNet,
      working: { capacity: 7 },
      shortTerm: { capacity: 2000 },
      longTerm: { capacity: 5000 },
    })
    const memPath = join(dataDir, 'gina-knowledge-memory.json')
    if (existsSync(memPath)) {
      try { mm.load(memPath) } catch { /* 忽略损坏快照 */ }
    }
  }

  const knowledgeAdvisor = new KnowledgeAdvisor({ catsNet, memoryManager: mm })
  const regimeAdvisor = new MarketRegimeAdvisor({ catsNet, memoryManager: mm })

  return { catsNet, memoryManager: mm, knowledgeAdvisor, regimeAdvisor }
}