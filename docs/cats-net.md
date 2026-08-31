# CATS-Net 抽象空间内核 —— 模块说明文档

> 模块状态：**已交付（第一个大模块）**  
> 所属项目：Gina Agent 后端核心  
> 本文对应代码版本：`0.1.0`

---

## 1. 模块定位

CATS-Net（Cognitive Abstract Thought Space Network，认知抽象思维空间网络）是 Gina Agent
的**认知底座**。它将离散的感知输入抽象为一组相互连接的概念节点，并模拟类脑的激活扩散、
竞争抑制、时间衰减、证据累积、语义融合与记忆投影等机制，为上层业务（决策、交易、急救等）
提供统一的概念表示与推理空间。

本模块完整实现四大核心能力，**无简化、无阉割**：

| 能力 | 说明 | 对应文件 |
|------|------|----------|
| 概念抽象节点 | 类脑概念表示、激活/抑制/衰减、带权连接、语义相似度、概念融合 | `concept-node.js` |
| 冲突消解 | 语义重叠、属性矛盾、激活竞争、连接不一致的检测与消解 | `conflict-resolver.js` |
| 持久化序列化 | 版本化快照、schema 校验、原子写入、反序列化水合 | `serializer.js` |
| 记忆投影 | 情境记忆→抽象空间痕迹、记忆唤回、强化与遗忘 | `memory-projection.js` |

---

## 2. 目录结构

```
项目根/
├── package.json                    # ESM 项目，node >= 18
├── main.js                         # 入口：内核自检（控制台日志）
├── src/
│   ├── cats_net/                   # ★ CATS-Net 内核（本次交付）
│   │   ├── index.js               #   统一导出
│   │   ├── cats-net.js            #   内核主类（聚合 + 安全机制）
│   │   ├── concept-node.js        #   概念抽象节点
│   │   ├── conflict-resolver.js   #   冲突消解
│   │   ├── serializer.js          #   持久化序列化
│   │   └── memory-projection.js   #   记忆投影
│   ├── memory/                     # 记忆系统（预留，后续模块）
│   ├── state_machine/              # 状态机（预留，后续模块）
│   ├── mcp/                        # MCP 工具调度（预留，后续模块）
│   └── business/
│       ├── trading/                # 股票交易核心（预留，后续模块）
│       ├── sos/                    # 毫米波 SOS 急救（预留，后续模块）
│       └── mech_wolf/              # 机械狼 22 路关节（预留，暂不实现）
├── tests/
│   └── cats-net.test.js            # 单元测试（33 用例）
└── docs/
    └── cats-net.md                 # 本文档
```

> **机械狼说明**：`src/business/mech_wolf/` 为预留空目录，22 路关节相关接口全部暂不实现，
> 待硬件样品落地后再生成代码。

---

## 3. 四大核心组件

### 3.1 ConceptNode —— 概念抽象节点

概念节点是抽象空间的最小语义单元，字段与行为如下：

- **字段**：`id`、`name`、`type`（entity/abstract/relation/action/attribute）、
  `attributes`（number|string 键值对）、`activation`（激活值 [0,1]）、
  `confidence`（置信度/证据强度 [0,1]）、`granularity`（粒度，越大越抽象）、
  `connections`（带权连接）、`history`（激活历史，供审计与衰减）。
- **类脑行为**：
  - `activate / deactivate`：兴奋性 / 抑制性输入，激活值裁剪到 [0,1]；
  - `decay`：时间衰减（激活 + 轻微置信度遗忘）；
  - `strengthen / weaken`：证据累积 / 矛盾削弱置信度；
  - `connect / disconnect`：建立/移除带权连接（禁止自连接）；
  - `similarity`：语义相似度 = 类型相似度(0.3) + 文本属性 Jaccard(0.4) + 数值属性余弦(0.3)；
  - `merge`：概念融合（数值加权平均、字符串取高置信、连接取并集且权重平均、粒度取大）；
  - `findAttributeConflicts`：检测同名属性的矛盾。

### 3.2 ConflictResolver —— 冲突消解

检测四类冲突并消解（类脑机制的工程映射）：

| 冲突类型 | 判定 | 消解策略 |
|----------|------|----------|
| 语义重叠 | 相似度 ≥ 0.8 | **merge**：融合冗余节点 |
| 属性矛盾 | 同名属性取值冲突 | **arbitrate**：按置信度仲裁 / 严重分歧时 **split**：拆分 |
| 激活竞争 | 激活接近且争夺共享连接 | **suppress**：胜者全拿，抑制弱者 |
| 连接不一致 | 双向连接权重不对称 | **arbitrate**：取平均并回写 |

`resolveAll` 内置去重与 `maxResolutions` 处理上限，防止同一冲突反复触发。

### 3.3 Serializer —— 持久化序列化

- 版本化快照（`format: cats-net` + `version: 1.0.0` + `savedAt`）；
- 写入前 / 读取后双向 schema 校验；
- **原子写入**：先写临时文件再 `rename`，避免中途崩溃损坏；
- 读取时把节点数组水合成 `ConceptNode` 实例。

### 3.4 MemoryProjection —— 记忆投影

- `project`：将情境记忆投影到空间，形成激活模式痕迹并激发对应概念；
- `retrieve`：按 Jaccard 重合度 × 记忆强度唤回相关记忆；
- `reinforce / decayAll`：记忆强化 / 遗忘。

> 注：本组件是「内核级记忆投影」，与独立的 `src/memory`（记忆系统，后续模块）不同。

---

## 4. 内核主类与安全机制（CatsNet）

`CatsNet` 聚合四大组件，对外提供统一流水线：

```
感知输入 process(perception)
   → 概念抽象（缺失概念自动创建）
   → 激活扩散 spreadActivation（带迭代上限 + 收敛提前终止）
   → 冲突消解 resolveConflicts（带上限）
   → 记忆投影 projectMemory（可选）
   → 返回结构化结果
```

**三类安全机制（约束 #3）**：

1. **异常容错**：所有公开入口做输入校验；`process` 全程 try/catch，异常统一归集到返回对象，不外泄。
2. **死循环拦截**：激活扩散 `maxIterations` + 传播衰减收敛 + 冲突消解 `maxResolutions` + 总超时 `timeoutMs`。
3. **紧急终止**：`abort()` 置位终止旗标，受保护操作经 `_guard()` 立即中断；`process` 返回 `aborted: true` 而非抛异常；`clearAbort()` 可恢复。

---

## 5. 运行方式

```bash
# 启动内核自检（纯控制台日志，无任何 Web UI）
node main.js

# 运行单元测试（33 用例）
npm test
# 或
node --test tests/cats-net.test.js
```

---

## 6. 与后续模块的衔接

- **记忆系统**（`src/memory`）：将调用 `MemoryProjection` 完成分层记忆库的编码与唤回。
- **状态机 / MCP**（`src/state_machine`、`src/mcp`）：将上层状态与工具动作映射为概念节点，
  通过 `CatsNet.process` 做语义推理。
- **交易 / SOS**（`src/business/trading`、`src/business/sos`）：业务规则与风控阈值可作为概念
  属性与连接进入抽象空间，利用冲突消解与记忆投影做决策辅助。

---

## 7. 交付范围说明

本次仅交付 **CATS-Net 抽象空间内核** 一个大模块（含单元测试 + 入口自检 + 本文档）。
其余模块（记忆系统、状态机、MCP 调度、股票交易、毫米波 SOS）及**机械狼 22 路关节**
均按约束要求**暂不实现**，预留目录与占位标记已就位。