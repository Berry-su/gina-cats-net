# 状态机模块（已交付）

Gina Agent 的状态机，提供有限状态机 (FSM) 与层次状态机 (HSM) 及迁移守卫 (guard)。

- `State`：状态定义（含 onEntry/onExit、父状态 parent）
- `Transition`：迁移规则（from/to/event/guard/action）+ `and`/`or`/`not` 守卫组合子
- `FSM`：有限状态机核心（迁移执行、迁移历史、振荡检测）
- `HSM`：层次状态机（父子级联 entry/exit、history 伪状态）
- `StateMachine`：主入口（迁移超时保护、紧急终止、可选 CATS-Net / 记忆系统集成）

> 详细设计见 [docs/state-machine.md](../../docs/state-machine.md)。

用法：

```js
import { StateMachine, State, Transition } from './index.js'

const sm = new StateMachine({ initialState: 'idle' })
sm.addState(new State({ id: 'idle', name: '空闲' }))
sm.addState(new State({ id: 'running', name: '运行中' }))
sm.addTransition(new Transition({ from: 'idle', to: 'running', event: 'start', guard: (ctx) => ctx.ready }))
sm.start()
const r = sm.transition('start', { ready: true })
```