# 股票交易核心模块（已交付）

Gina Agent 的股票交易核心，实现行情接入、策略信号、仓位管理、严格风控、止损止盈与防爆仓保护。

- `MarketDataProvider` / `MockMarketDataProvider`：行情抽象层（模拟 + 可扩展真实源）
- `Strategy` / `MovingAverageStrategy` / `BreakoutStrategy`：策略信号计算
- `PositionManager`：仓位跟踪与盈亏计算
- `RiskController`：硬性前置风控（止损止盈 + 防爆仓 + 防连续恶性开仓）
- `TradingEngine`：主引擎（行情→策略→风控→执行 编排 + 安全 + 可选集成）

> 详细设计见 [docs/trading.md](../../docs/trading.md)。

用法：

```js
import { MockMarketDataProvider, MovingAverageStrategy, PositionManager, RiskController, TradingEngine } from './index.js'

const engine = new TradingEngine({
  strategy: new MovingAverageStrategy(),
  positionManager: new PositionManager({ initialEquity: 100000 }),
  riskController: new RiskController(),
})

// 手动驱动一轮（也可 engine.start() 接入 Mock 行情定时驱动）
engine.processTick({ symbol: 'AAPL', timestamp: Date.now(), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 })
```

> 说明：本模块位于 `src/trading/`（原 `src/business/trading/` 占位已迁移至此）。