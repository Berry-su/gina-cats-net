/**
 * 分析师团队 —— 统一导出入口
 *
 * 子分身（分析师团队）+ Gina 整合器，共享同一个大脑。
 * 权限链：分析师分析 → Gina 整合判断 → 用户授权 → 才可下单。
 */

export { normalizeSnapshot, createMockSnapshot } from './market-snapshot.js'
export { Analyst, Opinion, VIEWS, VIEW_LABELS } from './analyst.js'
export { createSharedBrain } from './brain.js'
export { MacroAnalyst } from './macro-analyst.js'
export { FundamentalAnalyst } from './fundamental-analyst.js'
export { TechnicalAnalyst } from './technical-analyst.js'
export { FundFlowAnalyst } from './fundflow-analyst.js'
export { SentimentAnalyst } from './sentiment-analyst.js'
export { RiskOfficer } from './risk-officer.js'
export { AnalystTeam, createAnalystTeam } from './analyst-team.js'
export { Integrator } from './integrator.js'