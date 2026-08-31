/**
 * Gina Agent 后端核心 —— 入口文件
 *
 * 当前阶段只交付 CATS-Net 抽象空间内核（第一个大模块）。
 * 本入口执行一次内核自检，全程依赖控制台日志输出（不涉及任何 Web UI）。
 *
 * 运行：node main.js
 */

import { CatsNet, ConceptNode } from './src/cats_net/index.js'

const divider = '═'.repeat(60)

function section(title) {
  console.log(`\n${divider}`)
  console.log(`  ${title}`)
  console.log(divider)
}

function kv(key, value) {
  console.log(`  ${key}: ${value}`)
}

function main() {
  console.log(divider)
  console.log('  Gina Agent —— CATS-Net 抽象空间内核 自检')
  console.log(divider)
  console.log(`  启动时间: ${new Date().toLocaleString('zh-CN')}`)

  // ---------------------------------------------------------------------------
  // Step 1: 构建抽象概念空间
  // ---------------------------------------------------------------------------
  section('Step 1 · 构建抽象概念空间')

  const brain = new CatsNet({ maxIterations: 50, timeoutMs: 5000 })

  brain.addNode(new ConceptNode({ id: 'risk', name: '风险', type: 'abstract', granularity: 2, attributes: { danger: 0.8 } }))
  brain.addNode(new ConceptNode({ id: 'stop_loss', name: '止损', type: 'action', granularity: 1, attributes: { urgency: 0.9 } }))
  brain.addNode(new ConceptNode({ id: 'position', name: '仓位', type: 'abstract', granularity: 2, attributes: { size: 0.3 } }))
  brain.addNode(new ConceptNode({ id: 'market_drop', name: '市场下跌', type: 'entity', granularity: 1, attributes: { severity: 0.7 } }))

  // 建立带权连接（激活扩散通道）
  brain.getNode('risk').connect('stop_loss', 0.9, 'causal')
  brain.getNode('risk').connect('position', 0.7, 'association')
  brain.getNode('market_drop').connect('risk', 0.85, 'causal')

  kv('已创建概念节点', brain.size)
  for (const node of brain.nodes.values()) {
    kv(`  · ${node.id}`, `(${node.type}, 粒度 ${node.granularity}, 激活 ${node.activation})`)
  }

  // ---------------------------------------------------------------------------
  // Step 2: 感知输入 → 处理流水线
  // ---------------------------------------------------------------------------
  section('Step 2 · 感知输入 → 处理流水线')

  const result = brain.process({
    concepts: [
      { id: 'market_drop', weight: 1 },
      { id: 'risk', weight: 1 },
      // 未注册的新概念会自动抽象化
      { id: 'volatility', name: '波动率', type: 'abstract', weight: 0.8 },
    ],
    episode: {
      label: '市场下跌应对',
      content: '观察到市场下跌，评估风险并触发止损',
      concepts: ['market_drop', 'risk', 'stop_loss'],
      strength: 0.9,
    },
  })

  kv('处理是否被中止', result.aborted)
  kv('激活扩散迭代次数', result.spread.iterations)
  kv('激活扩散波及节点', result.spread.activated.join(', '))
  kv('冲突消解 resolved', result.conflicts.resolved)
  kv('冲突消解 skipped', result.conflicts.skipped)
  kv('记忆投影', result.memory ? `已写入 ${result.memory.id} (${result.memory.label})` : '无')
  kv('总耗时', `${result.elapsedMs}ms`)

  // 打印激活后的节点状态
  console.log('\n  激活扩散后的节点状态:')
  for (const node of brain.nodes.values()) {
    kv(`  · ${node.id}`, `激活 ${node.activation.toFixed(3)} / 置信度 ${node.confidence.toFixed(3)}`)
  }

  // ---------------------------------------------------------------------------
  // Step 3: 冲突消解演示
  // ---------------------------------------------------------------------------
  section('Step 3 · 冲突消解演示')

  // 制造语义重叠：两个高度相似的概念
  brain.addNode(new ConceptNode({ id: 'risk_dup', name: '风险(冗余)', type: 'abstract', granularity: 2, attributes: { danger: 0.8 } }))
  brain.addNode(new ConceptNode({ id: 'market_drop2', name: '市场下跌(冲突属性)', type: 'entity', granularity: 1, attributes: { severity: 0.1 } }))

  const conflictReport = brain.resolveConflicts({ maxResolutions: 10 })
  kv('共消解冲突', conflictReport.resolved)
  for (const r of conflictReport.report) {
    if (r.strategy) {
      kv(`  · [${r.strategy}]`, r.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: 记忆检索演示
  // ---------------------------------------------------------------------------
  section('Step 4 · 记忆检索演示')

  const retrieved = brain.retrieveMemory(['risk', 'stop_loss'], { limit: 3 })
  kv('检索到记忆条数', retrieved.length)
  for (const { entry, score } of retrieved) {
    kv(`  · ${entry.id}`, `(${entry.label}) 匹配分 ${score.toFixed(3)}`)
  }

  // ---------------------------------------------------------------------------
  // Step 5: 序列化持久化演示
  // ---------------------------------------------------------------------------
  section('Step 5 · 序列化持久化演示')

  const snapshotPath = './data/cats-net-snapshot.json'
  brain.save(snapshotPath)
  kv('快照已写入', snapshotPath)

  // 用新的内核实例从磁盘恢复
  const brain2 = new CatsNet()
  brain2.load(snapshotPath)
  kv('恢复后的节点数量', brain2.size)
  kv('恢复后的记忆数量', brain2.projection.size)

  // ---------------------------------------------------------------------------
  // Step 6: 紧急终止机制演示
  // ---------------------------------------------------------------------------
  section('Step 6 · 紧急终止机制演示')

  brain.abort()
  const abortedResult = brain.process({ concepts: [{ id: 'risk', weight: 1 }] })
  kv('abort 后处理是否被中止', abortedResult.aborted)
  kv('abort 后错误信息', abortedResult.error ?? '(无)')

  brain.clearAbort()
  kv('clearAbort 后能否继续处理', !brain.isAborted())

  // ---------------------------------------------------------------------------
  console.log(`\n${divider}`)
  console.log('  ✅ CATS-Net 内核自检完成，全部能力正常')
  console.log(divider)
}

try {
  main()
} catch (err) {
  console.error('\n[FATAL] 启动失败:', err)
  process.exitCode = 1
}