# 记忆系统模块 —— 说明文档

> 模块状态：**已交付（第二个大模块）**  
> 所属项目：Gina Agent 后端核心  
> 本文对应代码版本：`0.1.0`

---

## 1. 模块定位

记忆系统实现 Gina Agent 的**三层记忆分层**，模拟人类认知记忆的巩固过程：

```
感知 / 观察
   │  addObservation()
   ▼
┌──────────────┐   shiftToShortTerm()   ┌─────────────────┐   consolidate()   ┌────────────────┐
│  工作记忆     │ ───────────────────▶ │    短期记忆       │ ───────────────▶ │   长期记忆      │
│  (当前焦点)   │                        │   (近期情节)      │   + CATS-Net 投影  │  (知识沉淀)     │
└──────────────┘                        └─────────────────┘                    └────────────────┘
   容量小 / 快遗忘                        容量中 / 中遗忘                       容量大 / 慢遗忘
```

它与 CATS-Net 抽象空间内核的关系：**记忆系统委托 CATS-Net 的 `MemoryProjection` 完成
「经历 → 抽象空间痕迹」的语义投影**，但依赖方向严格单向（`src/memory → src/cats_net`），
且通过构造注入实现，因此记忆系统也可在无内核环境下**降级独立运行**。

---

## 2. 目录结构

```
src/memory/
├── index.js              # 统一导出
├── working-memory.js     # 工作记忆
├── short-term-memory.js  # 短期记忆
├── long-term-memory.js   # 长期记忆
└── memory-manager.js     # 编排器（巩固流水线 + CATS-Net 对接 + 安全机制）
```

---

## 3. 三层记忆

### 3.1 工作记忆 WorkingMemory

| 属性 | 默认值 | 说明 |
|------|--------|------|
| capacity | 7 | 容量极小（Miller 7±2 定律） |
| decayRate | 0.3 | 遗忘极快 |
| minImportance | 0.01 | 低于该重要性清除 |

- 条目字段：`id / content / tags / concepts / importance / timestamp`
- 容量满时：淘汰「重要性最低且最旧」的条目
- `decay()`：重要性快速衰减，过低清除
- `shiftOut()`：导出全部条目供转移到短期

### 3.2 短期记忆 ShortTermMemory

| 属性 | 默认值 | 说明 |
|------|--------|------|
| capacity | 20 | 容量中等 |
| decayRate | 0.1 | 遗忘中等 |
| minStrength | 0.05 | 低于该强度清除 |

- 条目字段：`id / label / content / concepts / tags / strength / timestamp`
- `retrieve(query)`：按概念/标签 Jaccard 重合度 × 强度检索
- `listConsolidatable(threshold)`：列出可巩固的高强度条目

### 3.3 长期记忆 LongTermMemory

| 属性 | 默认值 | 说明 |
|------|--------|------|
| capacity | 1000 | 容量大 |
| decayRate | 0.01 | 遗忘极慢 |
| minStrength | 0.1 | 低于该强度清除 |

- 条目字段：在短期基础上新增 `abstractSpaceRef`（抽象空间投影引用）
- 支持 `addFromShortTerm(stmEntry, { abstractSpaceRef })` 完成巩固迁移

---

## 4. 巩固流水线与 CATS-Net 对接

编排器 `MemoryManager` 的核心方法：

```js
addObservation(obs)                    // 感知 → 工作记忆
shiftToShortTerm()                     // 工作 → 短期（随后清空工作记忆）
consolidate({ minStrength, maxConsolidate })  // 短期 → 长期 + 抽象空间投影
retrieve(query, { limit })             // 跨层检索
retrieveAbstract(queryConcepts)        // 委托 CATS-Net 唤回抽象空间痕迹
```

**核心对接点**在 `consolidate()`：

```js
if (this.hasAbstractSpace()) {
  const proj = this.catsNet.projectMemory({
    id, label, content, concepts, strength,
  })
  abstractSpaceRef = [...proj.concepts]   // 建立「记忆条目 <-> 概念节点」双向链接
}
this.longTerm.addFromShortTerm(stmEntry, { abstractSpaceRef })
```

- 已接入内核：每条巩固记忆会投影到抽象空间，激发相关概念，长期条目记录 `abstractSpaceRef`；
- 未接入内核 / 投影失败：**降级处理**，仍写入长期记忆，仅缺抽象空间引用，不崩溃。

---

## 5. 安全机制（与 CATS-Net 一致）

1. **异常容错**：所有 `catsNet` 调用包 `try/catch`，内核异常时降级；
2. **死循环/膨胀拦截**：`consolidate.maxConsolidate` 批量上限 + 三层容量上限 + `retrieve.limit`；
3. **紧急终止**：`abort() / clearAbort() / isAborted()` + `_guard()`，
   终止后操作抛 `code === 'ABORTED'` 的异常。

---

## 6. 运行方式

```bash
# 运行全部单元测试（含 CATS-Net 33 + 记忆系统 17 = 50 用例）
npm test

# 单独运行记忆系统测试
node --test tests/memory.test.js
```

示例：

```js
import { MemoryManager } from './src/memory/index.js'
import { CatsNet } from './src/cats_net/index.js'

const brain = new CatsNet()
brain.addNode({ id: 'market_drop', name: '市场下跌' })

const memory = new MemoryManager({ catsNet: brain })
memory.addObservation({ content: '市场下跌触发止损', concepts: ['market_drop'], importance: 1 })
memory.shiftToShortTerm()
const { consolidated, projected } = memory.consolidate({ minStrength: 0.6 })
// consolidated=1, projected=1，且 brain.projection.size 增加、market_drop 被激活
```

---

## 7. 交付范围说明

本次交付 **记忆系统** 一个大模块（含三层记忆 + 编排器 + CATS-Net 对接 + 单元测试 + 本文档）。
其余模块（状态机、MCP 调度、股票交易、毫米波 SOS、机械狼）仍按约束暂不实现。