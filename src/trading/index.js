/**
 * 交易模块 —— 统一导出入口
 *
 * 提供行情抽象、策略信号、仓位管理、风控规则与交易引擎，
 * 供上层业务与其余模块引用。可选集成依赖单向 trading → memory/cats_net/state_machine。
 */

export { MarketDataProvider, MockMarketDataProvider } from './market-data.js'
export { Strategy, MovingAverageStrategy, BreakoutStrategy } from './strategy.js'
export { PositionManager } from './position.js'
export { RiskController } from './risk-control.js'
export { TradingEngine } from './trading-engine.js'
export { MarketRegimeAdvisor, DANGER_WEIGHTS } from './market-regime.js'
export { KnowledgeAdvisor, FRAMEWORKS } from './knowledge-advisor.js'
export { KnowledgeAwareStrategy } from './knowledge-aware-strategy.js'