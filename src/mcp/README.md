# MCP 工具调度模块（已交付）

Gina Agent 的 MCP 工具调度，实现工具注册、发现与动态调用（含超时/重试/熔断）。

- `Tool`：工具定义（name/description/parameters/handler/tags）
- `ToolRegistry`：注册表（注册/发现/搜索/参数校验）
- `ToolInvoker`：调用器（单次超时 + 重试 + 熔断器 open→half-open→closed）
- `MCPScheduler`：主入口（安全机制 + 可选 memoryManager/catsNet 集成）

> 详细设计见 [docs/mcp.md](../../docs/mcp.md)。

用法：

```js
import { MCPScheduler, Tool } from './index.js'

const scheduler = new MCPScheduler({ timeoutMs: 5000 })
scheduler.register(new Tool({
  name: 'get_price',
  description: '查询标的现价',
  parameters: { required: ['symbol'], properties: { symbol: { type: 'string' } } },
  handler: async (args) => ({ symbol: args.symbol, price: 100 }),
}))

const r = await scheduler.call('get_price', { symbol: 'AAPL' })
console.log(r.result) // { symbol: 'AAPL', price: 100 }
```