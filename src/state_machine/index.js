/**
 * 状态机模块 —— 统一导出入口
 *
 * 提供 FSM / HSM / StateMachine 及状态、迁移、守卫组合子，供上层业务模块引用。
 * 依赖方向单向 state_machine → cats_net / memory（通过 StateMachine 构造注入，可选）。
 */

export { State } from './state.js'
export { Transition, and, or, not } from './transition.js'
export { FSM } from './fsm.js'
export { HSM } from './hsm.js'
export { StateMachine } from './state-machine.js'