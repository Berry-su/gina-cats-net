/**
 * 状态机模块 —— 单元测试
 *
 * 运行：node --test tests/state-machine.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  State,
  Transition,
  FSM,
  HSM,
  StateMachine,
  and,
  or,
  not,
} from '../src/state_machine/index.js'

// ---------------------------------------------------------------------------
describe('State —— 状态定义', () => {
  test('构造与默认值', () => {
    const s = new State({ id: 'idle' })
    assert.equal(s.id, 'idle')
    assert.equal(s.name, 'idle')
    assert.equal(s.parent, null)
    assert.equal(s.onEntry, null)
    assert.equal(s.onExit, null)
  })

  test('非法 id 抛异常', () => {
    assert.throws(() => new State({ id: '' }), TypeError)
  })

  test('自动函数化 entry/exit', () => {
    const s = new State({ id: 'x', onEntry: () => 1, onExit: () => 2 })
    assert.equal(typeof s.onEntry, 'function')
    assert.equal(typeof s.onExit, 'function')
  })
})

// ---------------------------------------------------------------------------
describe('Transition —— 迁移与守卫', () => {
  test('构造', () => {
    const t = new Transition({ from: 'a', to: 'b', event: 'go' })
    assert.equal(t.from, 'a')
    assert.equal(t.to, 'b')
    assert.equal(t.event, 'go')
  })

  test('isAllowed：无守卫允许、守卫 false 拒绝', () => {
    const free = new Transition({ from: 'a', to: 'b', event: 'go' })
    assert.equal(free.isAllowed({}), true)
    const gated = new Transition({ from: 'a', to: 'b', event: 'go', guard: (c) => c.ok })
    assert.equal(gated.isAllowed({ ok: true }), true)
    assert.equal(gated.isAllowed({ ok: false }), false)
  })

  test('守卫组合子 and/or/not', () => {
    const g1 = (c) => c.a
    const g2 = (c) => c.b
    assert.equal(and(g1, g2)({ a: true, b: true }), true)
    assert.equal(and(g1, g2)({ a: true, b: false }), false)
    assert.equal(or(g1, g2)({ a: false, b: true }), true)
    assert.equal(or(g1, g2)({ a: false, b: false }), false)
    assert.equal(not(g1)({ a: false }), true)
  })
})

// ---------------------------------------------------------------------------
describe('FSM —— 有限状态机', () => {
  function buildFsm() {
    const fsm = new FSM({ initialState: 'idle' })
    fsm.addState(new State({ id: 'idle' }))
    fsm.addState(new State({ id: 'running' }))
    fsm.addTransition(new Transition({ from: 'idle', to: 'running', event: 'start' }))
    fsm.addTransition(new Transition({ from: 'running', to: 'idle', event: 'stop' }))
    return fsm
  }

  test('启动进入初始状态', () => {
    const fsm = buildFsm()
    fsm.start()
    assert.equal(fsm.getCurrentStateId(), 'idle')
  })

  test('迁移执行顺序：exit → action → entry', () => {
    const order = []
    const fsm = new FSM({ initialState: 'a' })
    fsm.addState(new State({ id: 'a', onExit: () => order.push('exit-a') }))
    fsm.addState(new State({ id: 'b', onEntry: () => order.push('entry-b') }))
    fsm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go', action: () => order.push('action') }))
    fsm.start()
    const r = fsm.transition('go')
    assert.equal(r.ok, true)
    assert.deepEqual(order, ['exit-a', 'action', 'entry-b'])
  })

  test('守卫拒绝返回 guard-rejected', () => {
    const fsm = new FSM({ initialState: 'a' })
    fsm.addState(new State({ id: 'a' }))
    fsm.addState(new State({ id: 'b' }))
    fsm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go', guard: (c) => c.ok }))
    fsm.start()
    const r = fsm.transition('go', { ok: false })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'guard-rejected')
    assert.equal(fsm.getCurrentStateId(), 'a')
  })

  test('无迁移返回 no-transition', () => {
    const fsm = buildFsm()
    fsm.start()
    const r = fsm.transition('unknown')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-transition')
  })

  test('canTransition 校验迁移与守卫', () => {
    const fsm = new FSM({ initialState: 'a' })
    fsm.addState(new State({ id: 'a' }))
    fsm.addState(new State({ id: 'b' }))
    fsm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go', guard: (c) => c.ok }))
    fsm.start()
    assert.equal(fsm.canTransition('go', { ok: true }), true)
    assert.equal(fsm.canTransition('go', { ok: false }), false)
    assert.equal(fsm.canTransition('nope'), false)
  })

  test('振荡检测：阻断 A→B→A→B 往返', () => {
    const fsm = buildFsm()
    fsm.start()
    fsm.transition('start') // idle -> running
    fsm.transition('stop')  // running -> idle
    fsm.transition('start') // idle -> running
    // 接下来 running -> idle 会形成往返振荡，应被阻断
    const r = fsm.transition('stop')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'oscillation')
  })

  test('动作异常不切换状态', () => {
    const fsm = new FSM({ initialState: 'a' })
    fsm.addState(new State({ id: 'a' }))
    fsm.addState(new State({ id: 'b' }))
    fsm.addTransition(new Transition({
      from: 'a', to: 'b', event: 'go',
      action: () => { throw new Error('boom') },
    }))
    fsm.start()
    const r = fsm.transition('go')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'error')
    assert.equal(fsm.getCurrentStateId(), 'a')
  })

  test('reset 回到初始状态并清空历史', () => {
    const fsm = buildFsm()
    fsm.start()
    fsm.transition('start')
    assert.equal(fsm.getCurrentStateId(), 'running')
    fsm.reset()
    assert.equal(fsm.getCurrentStateId(), 'idle')
    assert.equal(fsm.getHistory().length, 0)
  })

  test('getSnapshot 输出运行时位置', () => {
    const fsm = buildFsm()
    fsm.start()
    const snap = fsm.getSnapshot()
    assert.equal(snap.currentState, 'idle')
    assert.equal(snap.transitionCount, 0)
  })
})

// ---------------------------------------------------------------------------
describe('HSM —— 层次状态机', () => {
  function buildHsm() {
    const hsm = new HSM({ initialState: 'child1' })
    hsm.addState(new State({ id: 'root', onEntry: () => {}, onExit: () => {} }))
    hsm.addState(new State({ id: 'child1', parent: 'root' }))
    hsm.addState(new State({ id: 'child2', parent: 'root' }))
    hsm.addTransition(new Transition({ from: 'child1', to: 'child2', event: 'switch' }))
    return hsm
  }

  test('同级子状态迁移：级联进入/退出', () => {
    const order = []
    const hsm = new HSM({ initialState: 'child1' })
    hsm.addState(new State({ id: 'root', onEntry: () => order.push('root.enter'), onExit: () => order.push('root.exit') }))
    hsm.addState(new State({ id: 'child1', parent: 'root', onEntry: () => order.push('c1.enter'), onExit: () => order.push('c1.exit') }))
    hsm.addState(new State({ id: 'child2', parent: 'root', onEntry: () => order.push('c2.enter'), onExit: () => order.push('c2.exit') }))
    hsm.addTransition(new Transition({ from: 'child1', to: 'child2', event: 'switch' }))

    hsm.start() // root.enter, c1.enter
    order.length = 0
    const r = hsm.transition('switch') // c1.exit, c2.enter（不重复 root）
    assert.equal(r.ok, true)
    assert.deepEqual(order, ['c1.exit', 'c2.enter'])
  })

  test('setParent 建立层次', () => {
    const hsm = new HSM()
    hsm.addState(new State({ id: 'p' }))
    hsm.addState(new State({ id: 'c' }))
    hsm.setParent('c', 'p')
    assert.equal(hsm.getState('c').parent, 'p')
    assert.throws(() => hsm.setParent('x', 'p'), Error)
  })

  test('history 伪状态恢复上次子状态', () => {
    const hsm = new HSM({ initialState: 'child1' })
    hsm.addState(new State({ id: 'root' }))
    hsm.addState(new State({ id: 'child1', parent: 'root' }))
    hsm.addState(new State({ id: 'child2', parent: 'root' }))
    hsm.addState(new State({ id: 'outside' }))
    hsm.addTransition(new Transition({ from: 'child1', to: 'child2', event: 'switch' }))
    hsm.addTransition(new Transition({ from: 'child2', to: 'outside', event: 'leave' }))
    const hist = hsm.registerHistory('root', 'child1')
    hsm.addTransition(new Transition({ from: 'outside', to: hist, event: 'back' }))

    hsm.start() // child1
    hsm.transition('switch') // child1 -> child2（root 的 history 记录 child2）
    hsm.transition('leave')  // child2 -> outside
    const r = hsm.transition('back') // outside -> hist:root -> child2
    assert.equal(r.ok, true)
    assert.equal(hsm.getCurrentStateId(), 'child2')
  })
})

// ---------------------------------------------------------------------------
describe('StateMachine —— 主类（安全与集成）', () => {
  test('紧急终止：abort 后迁移抛 ABORTED', () => {
    const sm = new StateMachine({ initialState: 'a' })
    sm.addState(new State({ id: 'a' }))
    sm.addState(new State({ id: 'b' }))
    sm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go' }))
    sm.start()
    sm.abort()
    assert.ok(sm.isAborted())
    assert.throws(() => sm.transition('go'), (e) => e.code === 'ABORTED')
    sm.clearAbort()
    assert.equal(sm.transition('go').ok, true)
  })

  test('无集成时降级为纯状态机', () => {
    const sm = new StateMachine({ initialState: 'a' })
    sm.addState(new State({ id: 'a' }))
    sm.addState(new State({ id: 'b' }))
    sm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go' }))
    sm.start()
    const r = sm.transition('go')
    assert.equal(r.ok, true)
    assert.equal(sm.getCurrentStateId(), 'b')
  })

  test('集成记忆系统：迁移写入工作记忆', () => {
    const observations = []
    const memoryManager = {
      addObservation(obs) { observations.push(obs) },
    }
    const sm = new StateMachine({ initialState: 'a', memoryManager })
    sm.addState(new State({ id: 'a' }))
    sm.addState(new State({ id: 'b' }))
    sm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go' }))
    sm.start()
    sm.transition('go')
    assert.equal(observations.length, 1)
    assert.ok(observations[0].content.includes('a'))
    assert.ok(observations[0].content.includes('b'))
  })

  test('集成 CATS-Net：迁移激活已存在的目标概念', () => {
    const activations = []
    const catsNet = {
      getNode: (id) => id === 'b' ? {} : null,
      activate: (id, amt) => activations.push({ id, amt }),
    }
    const sm = new StateMachine({ initialState: 'a', catsNet })
    sm.addState(new State({ id: 'a' }))
    sm.addState(new State({ id: 'b' }))
    sm.addTransition(new Transition({ from: 'a', to: 'b', event: 'go' }))
    sm.start()
    sm.transition('go')
    assert.equal(activations.length, 1)
    assert.equal(activations[0].id, 'b')
  })

  test('迁移超时保护：超时置位紧急终止', () => {
    const sm = new StateMachine({ initialState: 'a', timeoutMs: 1 })
    sm.addState(new State({ id: 'a' }))
    sm.addState(new State({ id: 'b' }))
    sm.addTransition(new Transition({
      from: 'a', to: 'b', event: 'go',
      // 忙等 5ms，确保超过 1ms 阈值
      action: () => { const s = Date.now(); while (Date.now() - s < 5) {} },
    }))
    sm.start()
    const r = sm.transition('go')
    assert.equal(r.timedOut, true)
    assert.ok(sm.isAborted())
  })
})