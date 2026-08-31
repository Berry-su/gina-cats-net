# 股票交易核心模块 —— 说明文档

> 模块状态：**已交付（第五个大模块）**  
> 所属项目：Gina Agent 后端核心  
> 本文对应代码版本：`0.1.0`  
> 模块位置：`src/trading/`（原 `src/business/trading/` 占位已迁移至此）

---

## 1. 模块定位

股票交易核心是整个项目中最安全敏感的业务模块，实现从行情到执行的全链路，
并将**风控设计为硬性前置门控**（hard gate）——策略信号产生后、订单发出前必须逐条通过风控。

```
行情 tick
   │
   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ market-data  │ → │   strategy   │ → │ risk-control │ → │  position    │
│ 行情抽象层    │   │  策略信号     │   │  硬性风控门控  │   │  仓位/执行    │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
                         (TradingEngine 编排)
```

---

## 2. 目录结构

```
src/trading/
├── index.js            # 统一导出
├── market-data.js      # 行情抽象层（Provider 基类 + Mock 源）
├── strategy.js         # 策略信号（基类 + 均线交叉 / 突破）
├── position.js         # 仓位管理与盈亏计算
├── risk-control.js     # 风控规则（硬门控 + 止损止盈 + 防爆仓 + 防连续开仓）
└── trading-engine.js   # 主引擎（编排 + 安全机制 + 可选集成）
```

---

## 3. 核心组件

### 3.1 MarketDataProvider —— 行情抽象层

- 统一 Tick 结构：`{ symbol, timestamp, open, high, low, close, volume }`
- `MarketDataProvider` 基类：`registerSymbol` / `onTick` / `start` / `stop` / `_emit`
- `MockMarketDataProvider`：随机游走模拟行情，`generateTick()` 可手动驱动（测试友好）
- 接入真实行情时只需继承基类并调用 `_emit`，引擎无需改动

### 3.2 Strategy —— 策略信号

- 信号结构：`{ action: 'buy'|'sell'|'hold', size?, reason }`
- `MovingAverageStrategy`：短期均线上穿长期 → buy，下穿 → sell
- `BreakoutStrategy`：突破前高 → buy，跌破前低 → sell

### 3.3 PositionManager —— 仓位管理

- 资金模型：现金权益，开仓扣成本、平仓回补
- 加仓按加权均价更新持仓
- 计算浮动盈亏 `getUnrealizedPnl` / 总市值 `getTotalMarketValue`

### 3.4 RiskController —— 风控规则（核心安全层）

| 保护类型 | 规则 |
|----------|------|
| 仓位约束 | 单标的占比、总持仓比率、单笔数量上限 |
| 止损止盈 | 浮亏/浮盈比例触发，由引擎每 tick 主动检查 |
| 防爆仓 | 每日最大亏损额（触发熔断）、最大回撤（峰值权益监控） |
| 防连续恶性开仓 | 时间窗口内同方向密集开仓超限则拒绝 |

`checkOrder(order, context)` 返回 `{ approved, reasons[] }`，任一规则不通过即拒绝开仓。
熔断由 `recordTrade`（每日亏损）/ `updateEquity`（回撤）自动置位。

### 3.5 TradingEngine —— 主引擎

每根 tick 的处理流程：

1. 更新最新价，维护权益峰值（回撤监控）
2. **主动检查该标的持仓的止损/止盈**（不依赖策略信号）
3. 计算策略信号
4. buy → 构造订单 → 风控硬门控 → 通过开仓 / 拒绝记录原因；sell → 平仓
5. 关键事件可选集成（记忆 / 概念 / 状态机）

---

## 4. 安全机制（与其余四模块一致）

1. **异常容错**：全流程 try/catch，异常不外泄，返回降级结果；
2. **防失控拦截**：风控硬门控 + 每日亏损熔断 + 回撤熔断 + 防连续开仓 + 单笔数量上限；
3. **紧急终止**：`abort() / clearAbort() / isAborted()` + `_guard()`。

---

## 5. 可选集成（依赖单向、可降级）

- `memoryManager`：开/平仓、止损止盈、风控拒绝事件写入工作记忆（`source='trade'`）
- `catsNet`：激活已存在的标的符号概念
- `stateMachine`：开/平仓触发 `trade_open` / `trade_close` 事件

未注入时降级为纯交易引擎。

---

## 6. 运行方式

```bash
# 运行全部单元测试（122 用例）
npm test

# 单独运行交易模块测试
node --test tests/trading.test.js
```

示例：

```js
import {
  MockMarketDataProvider, MovingAverageStrategy,
  PositionManager, RiskController, TradingEngine,
} from './src/trading/index.js'

const engine = new TradingEngine({
  strategy: new MovingAverageStrategy(),
  positionManager: new PositionManager({ initialEquity: 100000 }),
  riskController: new RiskController(),
})

// 手动驱动（或 engine.start() 接入 Mock 定时行情）
const r = engine.processTick({ symbol: 'AAPL', timestamp: Date.now(), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 })
```

---

## 7. 交付范围说明

本次交付 **股票交易核心** 一个大模块（行情抽象 + 策略信号 + 仓位管理 + 风控 + 止损止盈 + 防爆仓/防连续开仓 + 单元测试 + 本文档）。
其余模块（毫米波 SOS、机械狼）仍按约束暂不实现。