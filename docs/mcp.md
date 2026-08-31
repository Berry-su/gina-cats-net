# MCP 工具调度模块 —— 说明文档

> 模块状态：**已交付（第四个大模块）**  
> 所属项目：Gina Agent 后端核心  
> 本文对应代码版本：`0.1.0`

---

## 1. 模块定位

MCP 工具调度模块为 Gina Agent 提供**工具注册、发现与动态调用**能力，
并对异步工具调用实施安全管理（超时 / 重试 / 熔断）。

```
┌──────────────────────────────────────────────────────────┐
│                       MCPScheduler                        │
│  安全闸门 · 紧急终止 · 可选 memoryManager/catsNet 集成      │
│  ┌─────────────────────┐   ┌────────────────────────────┐ │
│  │     ToolRegistry     │   │        ToolInvoker         │ │
│  │ 注册/发现/参数校验    │   │  超时(Promise.race)         │ │
│  │  Tool 定义           │   │  重试 + 熔断器              │ │
│  └─────────────────────┘   └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 目录结构

```
src/mcp/
├── index.js            # 统一导出
├── tool-registry.js    # Tool 定义 + ToolRegistry（注册/发现/参数校验）
├── tool-invoker.js     # ToolInvoker（超时/重试/熔断器）
└── mcp-scheduler.js    # MCPScheduler 主类（安全 + 可选集成）
```

---

## 3. 核心组件

### 3.1 Tool —— 工具定义

字段：`name`、`description`、`parameters`（JSON Schema 子集 `{ properties, required }`）、
`handler`（async 函数 `(args, context) => any`）、`tags`。

### 3.2 ToolRegistry —— 注册表

- `register / unregister / get / has / list`
- 发现：`findByName`（名称/描述模糊）、`findByTag`（标签）、`search`（综合）
- 参数校验：`validateArguments` 基于 `required` + `type` 在调用前拦截非法入参

### 3.3 ToolInvoker —— 调用器（三层防护）

| 防护 | 实现 |
|------|------|
| 调用超时 | 单次调用 `Promise.race` 与 `setTimeout` 独立超时 |
| 重试 | 失败/超时按 `retries` 重试 |
| 熔断器 | 连续失败达 `failureThreshold` 后断开；经 `recoveryTimeout` 进入 half-open 试探，成功闭合 |

熔断器三态：`closed → open → half-open → closed`。

### 3.4 MCPScheduler —— 调度主类

调用流程：`_guard → 工具查找 → 参数校验 → invoker.invoke → 集成 → 返回`。

返回统一结构：`{ ok, result?, reason?, error?, tool }`，异常绝不外泄。

---

## 4. 安全机制（与 CATS-Net / 记忆 / 状态机一致）

1. **异常容错**：handler 异常 / Promise 拒绝统一归集到返回对象；
2. **失控拦截**：单次超时 + 重试上限 + 熔断器，防止对故障工具恶性循环调用；
3. **紧急终止**：`abort() / clearAbort() / isAborted()` + `_guard()`。

---

## 5. 可选集成（依赖单向、可降级）

- `memoryManager`：调用后写入工作记忆（记录工具调用历史）；
- `catsNet`：调用后激活已存在的工具名概念（语义关联）；
- `stateMachine`：预留字段，供上层将工具调用映射为状态事件（本模块不主动触发）。

未注入任何外部模块时降级为纯调度器。

---

## 6. 运行方式

```bash
# 运行全部单元测试（CATS-Net 33 + 记忆 17 + 状态机 23 + MCP 23 = 96 用例）
npm test

# 单独运行 MCP 测试
node --test tests/mcp.test.js
```

示例：

```js
import { MCPScheduler, Tool } from './src/mcp/index.js'

const scheduler = new MCPScheduler({ timeoutMs: 5000, retries: 1, failureThreshold: 3 })

scheduler.register(new Tool({
  name: 'get_price',
  description: '查询标的现价',
  parameters: { required: ['symbol'], properties: { symbol: { type: 'string' } } },
  handler: async (args) => ({ symbol: args.symbol, price: 100 }),
  tags: ['market'],
}))

const r = await scheduler.call('get_price', { symbol: 'AAPL' })
// r.ok === true, r.result === { symbol:'AAPL', price:100 }
console.log(scheduler.discover('市场')) // 按描述发现工具
```

---

## 7. 交付范围说明

本次交付 **MCP 工具调度** 一个大模块（工具定义 + 注册/发现 + 动态调用 + 超时/重试/熔断 + 可选集成 + 单元测试 + 本文档）。
其余模块（股票交易、毫米波 SOS、机械狼）仍按约束暂不实现。