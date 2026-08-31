# 状态机模块 —— 说明文档

> 模块状态：**已交付（第三个大模块）**  
> 所属项目：Gina Agent 后端核心  
> 本文对应代码版本：`0.1.0`

---

## 1. 模块定位

状态机模块提供 Gina Agent 的**控制流程建模**能力，实现有限状态机 (FSM) 与
层次状态机 (HSM)，支持带守卫条件的迁移，并内建防失控安全机制。

```
┌─────────────────────────────────────────────────────────┐
│                     StateMachine                          │
│  迁移超时保护 · 紧急终止 · 可选 CATS-Net / 记忆系统集成     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                        HSM                          │ │
│  │  父子层次 · 级联 entry/exit · history 伪状态          │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │                     FSM                          │ │ │
│  │  │  状态/迁移表 · 守卫 · 迁移执行 · 振荡检测           │ │ │
│  │  │  State · Transition                              │ │ │
│  │  └─────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 目录结构

```
src/state_machine/
├── index.js            # 统一导出
├── state.js            # 状态定义（State）
├── transition.js       # 迁移与守卫（Transition + and/or/not）
├── fsm.js              # 有限状态机核心
├── hsm.js              # 层次状态机扩展
└── state-machine.js    # 主入口（安全 + 可选集成）
```

---

## 3. 核心组件

### 3.1 State —— 状态定义

字段：`id`（唯一）、`name`、`parent`（父状态，HSM 用）、`onEntry` / `onExit`（进入/退出动作）。

### 3.2 Transition —— 迁移与守卫

字段：`from`、`to`、`event`、`guard`（前置谓词 `(ctx) => boolean`）、`action`（副作用）。

守卫组合子：

```js
import { and, or, not } from './src/state_machine/index.js'
const safeGuard = and((c) => c.ready, not((c) => c.fault))
```

### 3.3 FSM —— 有限状态机

- 迁移查找：`getTransition(from, event)`，key 为 `${from}:${event}`；
- 迁移执行顺序：`guard 校验 → 退出旧状态 onExit → 迁移 action → 进入新状态 onEntry`；
- 返回结构化结果 `{ ok, from, to, event, reason?, error? }`，异常不外泄；
- **振荡检测**：维护迁移历史，识别 `A→B→A→B` 往返循环并阻断（返回 `reason: 'oscillation'`）。

### 3.4 HSM —— 层次状态机

- 父子层次：通过 `State.parent` 描述，`setParent()` 可显式建立；
- 级联进入/退出：迁移时按 **LCA（最低共同祖先）** 切分，退出旧链、进入新链；
- history 伪状态：`registerHistory(parentId, fallback)` 返回 `hist:<parentId>`，
  作为迁移目标时解析为「该父状态最近活动的子状态」，实现回到上次离开位置。

### 3.5 StateMachine —— 主类

在 HSM 之上叠加：

| 能力 | 说明 |
|------|------|
| 迁移超时 | `timeoutMs`，单次迁移超时即置位紧急终止 |
| 紧急终止 | `abort() / clearAbort() / isAborted()` + `_guard()` |
| 记忆集成 | 迁移成功写入 `memoryManager` 工作记忆（可选） |
| 抽象空间集成 | 迁移后激活 `catsNet` 中已存在的目标概念（可选） |

依赖方向严格单向 `state_machine → cats_net / memory`，通过构造注入，未注入时降级为纯状态机。

---

## 4. 安全机制（与 CATS-Net / 记忆系统一致）

1. **异常容错**：动作副作用异常不切换状态，返回 `reason: 'error'`；
2. **死循环 / 振荡拦截**：迁移历史滑动窗口识别往返振荡并阻断；
3. **紧急终止 + 复位**：`abort()` 强制拒绝后续迁移；`reset()` 回到初始态；超时自动置位终止。

---

## 5. 运行方式

```bash
# 运行全部单元测试（CATS-Net 33 + 记忆 17 + 状态机 23 = 73 用例）
npm test

# 单独运行状态机测试
node --test tests/state-machine.test.js
```

示例：

```js
import { StateMachine, State, Transition, and } from './src/state_machine/index.js'

const sm = new StateMachine({ initialState: 'idle' })
sm.addState(new State({ id: 'idle', name: '空闲' }))
sm.addState(new State({ id: 'running', name: '运行中' }))
sm.addTransition(new Transition({
  from: 'idle', to: 'running', event: 'start',
  guard: and((c) => c.ready, (c) => !c.fault),
}))
sm.start()
const r = sm.transition('start', { ready: true, fault: false }) // ok:true
```

---

## 6. 交付范围说明

本次交付 **状态机** 一个大模块（FSM + HSM + 迁移守卫 + 安全机制 + 可选集成 + 单元测试 + 本文档）。
其余模块（MCP 调度、股票交易、毫米波 SOS、机械狼）仍按约束暂不实现。