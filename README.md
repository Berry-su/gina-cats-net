# `@berrysu/gina-core`

> GINA 的大脑内核——CATS-Net 概念网络 + 8 大层架构的真理源。
>
> **项目归属**：Berry.Su 独立项目，跟白龙马 / `xiaoyuanda666-ship-it` 仓库/账号**没有任何关系**。
> **包命名**：`@berrysu/gina-core`（Berry.Su owner，前缀跟 macOS appId `com.berrysu.gina` / 版权 holder `Berry.Su` 一致）

---

## 1. 它是什么

`@berrysu/gina-core` 是 GINA 项目的**内核真理源（source of truth）**——所有 8 大层（L0~L7）架构的演进、版本化、对外发布都在这一个仓完成。

它**不是**应用壳（Electron 主循环在主仓 `Berry-su/GINA`），也**不是**UI（独立仓 `Berry-su/gina-ui`）。它是「**脑**」——可被任意上层应用以 pnpm + `file:` 软链接方式嵌入的纯 JavaScript 内核库。

整个 GINA 项目的**护城河独立性**就靠这一层：未来无论融资估值、独立开源、还是被收购剥离，「脑」都能独立存在。

---

## 2. 跟主仓的关系

```
┌─────────────────────────────────────────────────────────────┐
│  Berry-su/GINA         (主仓 = 产品应用层, Electron 完整版)  │
│  ├── electron/         桌面壳                              │
│  ├── src/index.js      8 大层 runtime                      │
│  └── package.json      依赖 @berrysu/gina-core (file:...)  │
│         │                                                   │
│         │  pnpm + file: 绝对路径软链接                      │
│         ▼                                                   │
│  Berry-su/gina-cats-net  (= 本仓 = @berrysu/gina-core)     │
│  ├── src/  (9 子目录 = 脑本体)                              │
│  ├── package.json  name=@berrysu/gina-core, private=true    │
│  ├── README.md  (本文件)                                    │
│  └── LICENSE  (MIT)                                         │
└─────────────────────────────────────────────────────────────┘
```

主仓通过 `file:` 软链接引入本仓：

```jsonc
// 主仓 package.json
{
  "dependencies": {
    "@berrysu/gina-core": "file:/Users/ahs/Desktop/GINA/gina增加计划登记"
  }
}
```

按需 import 子路径：

```js
// 仅加载 CATS-Net 子图（不挂载其余 8 大层）
import { CatsNet, ConceptNode } from '@berrysu/gina-core/cats_net'
import { MemoryManager } from '@berrysu/gina-core/memory'
import { StateMachine } from '@berrysu/gina-core/state_machine'
```

> **架构细节**：参见 `~/Desktop/gina迭代增强计划/03-架构决策/ADR-001-CATS-Net-软分层与pnpm迁移_2026-09-01.md`（29KB）

---

## 3. 9 个子目录（exports 子路径）

本仓的 9 个子目录对应 GINA 完整大脑的 9 个核心模块，每个都是独立的 `exports` 子路径，主仓按需 import（tree-shaking 生效，bundle 体积不增长）。

| 子目录 | exports 路径 | 角色 | 关键文件 |
|---|---|---|---|
| **`cats_net/`** | `@berrysu/gina-core/cats_net` | **L3 · CATS-Net 概念网络**（脑的核心） | `cats-net.js`（扩散算法）、`concept-node.js`（节点 + 层次）、`conflict-resolver.js`、`memory-projection.js`、`serializer.js` |
| **`memory/`** | `@berrysu/gina-core/memory` | **L2 · 三层记忆**（短/长/工作） | `short-term-memory.js`、`long-term-memory.js`、`working-memory.js`、`memory-manager.js` |
| **`state_machine/`** | `@berrysu/gina-core/state_machine` | **L5 · 状态机**（FSM + HSM + 嵌套） | `fsm.js`、`hsm.js`、`state.js`、`transition.js` |
| **`analysts/`** | `@berrysu/gina-core/analysts` | **L7 · 6 分析师 + 整合器** | `fundamental-analyst.js`、`macro-analyst.js`、`fundflow-analyst.js`、`market-snapshot.js`、`risk-officer.js`、`integrator.js` |
| **`data_engine/`** | `@berrysu/gina-core/data_engine` | L2~L7 共享 · 数据流水线 | `abnormal-scanner.js`、`analysis-pipeline.js`、`normalizer.js`、`scheduler.js` |
| **`data_sources/`** | `@berrysu/gina-core/data_sources` | L2 · 数据源适配（broker/Tushare/RSS/US） | `broker.js`、`tushare.js`、`rss-news.js`、`us-market.js`、`http-client.js` |
| **`mcp/`** | `@berrysu/gina-core/mcp` | L6 · 工具市场基础设施 | `mcp-scheduler.js`、`tool-registry.js`、`tool-invoker.js` |
| **`trading/`** | `@berrysu/gina-core/trading` | L7 · 交易引擎 + 策略 + 风控 | `trading-engine.js`、`strategy.js`、`risk-control.js`、`position.js`、`market-data.js` |
| **`business/`** | `@berrysu/gina-core/business` | 业务模块（机器狼 / SOS / 交易编排） | `mech_wolf/`、`sos/`、`trading/` |

> **9 子目录全进 gina-core 是 ADR-001 明确决策**——任何建议"先只搬 cats_net"都是"先跑通再说"陷阱，护城河完整性优先。

---

## 4. 安装 / 开发 / 测试

### 4.1 在主仓里使用（标准流程）

```bash
cd ~/Documents/BaiLongma-refactor-codebase
pnpm install   # 自动通过 file: 软链拉本仓最新版
pnpm test      # 跑 cats_net/analysts/verify-startup 自检
```

### 4.2 在本仓独立工作（内核改动）

```bash
cd ~/Desktop/GINA/gina增加计划登记

# 跑本仓自己的自检（不需要主仓环境）
pnpm test                # node --test tests/
pnpm run test:cats-net   # 单独跑 CATS-Net 套件

# 修改后 commit + push（先于主仓）
git add src/...
git commit -m "feat(cats_net): ..."
git push origin main
```

### 4.3 跨仓工作流（7 agent 协作契约）

> **强约束（gina-arch 红线）**：
> 1. 内核（`@berrysu/gina-core` 任何 `src/` 改动）**必须先** commit + push 到本仓
> 2. 主仓消费（`package.json` / import 路径变更）**必须后** commit + push
> 3. 禁止反序——主仓代码引用 gina-core 还不存在的 API 会让 CI 红

```bash
# 第 1 步：在本仓改内核
cd ~/Desktop/GINA/gina增加计划登记
git add src/cats_net/concept-node.js
git commit -m "feat(cats_net): add level field to ConceptNode"
git push origin main

# 第 2 步：主仓更新 file: 软链接
cd ~/Documents/BaiLongma-refactor-codebase
pnpm install   # 重读 file: 指向的本仓最新源

# 第 3 步：主仓消费新 API
# 编辑 src/.../some-module.js: import { ConceptNode } from '@berrysu/gina-core/cats_net'
git add .
git commit -m "feat: consume ConceptNode.level in main loop"
git push origin main
```

详细 7 agent 分工：`~/Desktop/gina迭代增强计划/04-团队/团队总览.md`

---

## 5. 版本与 Tag 策略（SemVer）

| Tag 格式 | 用途 | 触发 | 评审 |
|---|---|---|---|
| `core-v0.x.y` | 跟 SemVer 同步的内核发布 | gina-coder 推 main 后手动 `git tag core-v0.x.y` | **gina-arch 评审后**才允许推送 |
| `core-mvp-2026Q4` | 关键里程碑快照（融资 demo） | 老板拍板后打 | 老板 |
| `core-breaking-YYYY-MM-DD` | 破坏性变更预警 | 任何计划中的 MAJOR bump 前 7 天 | gina-arch |

- **起步**：`0.1.0`（MAJOR=0 = 任何 API 变更允许）
- **MAJOR**（1.0.0 →）：8 大层接口稳定，融资 demo 可引用版
- **MINOR**（0.x.0 → 0.y.0）：新增层 / 新增子路径 export / 新增 capability
- **PATCH**（0.x.y → 0.x.z）：bugfix / 重构 / 文档
- **禁止**：跨主版本 `src/` 子目录路径变更（破坏 `exports` 语义）

---

## 6. 架构引用

- **GINA 完整大脑路线图**（v0.1 · 2026-08-29）：`~/Desktop/gina迭代增强计划/05-设计文档/GINA完整大脑路线图_2026-08-29.md`
- **ADR-001 · CATS-Net 软分层与 pnpm 迁移**（2026-09-01）：`~/Desktop/gina迭代增强计划/03-架构决策/ADR-001-CATS-Net-软分层与pnpm迁移_2026-09-01.md`
- **GINA 任务看板**：`~/Desktop/项目工作台/任务看板-Gina.md`
- **7 agent 团队总览**：`~/Desktop/gina迭代增强计划/04-团队/团队总览.md`

---

## 7. 命名规范

- **GitHub owner**：`Berry-su`（大小写敏感，B 和 s 大写）
- **包名**：`@berrysu/gina-core`（小写，连字符）
- **macOS appId**：`com.berrysu.gina`（主仓专属）
- **版权 holder**：`Berry.Su`
- **本仓任何文件 / commit / `package.json` 均不应含 `xiaoyuanda` 标识**

---

## 8. 许可证

MIT — 详见 [LICENSE](./LICENSE) 文件。

Copyright © 2026 Berry.Su
