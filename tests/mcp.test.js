/**
 * MCP 工具调度模块 —— 单元测试
 *
 * 运行：node --test tests/mcp.test.js
 * 或：  npm test
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  Tool,
  ToolRegistry,
  ToolInvoker,
  MCPScheduler,
  BREAKER_STATE,
} from '../src/mcp/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
describe('Tool —— 工具定义', () => {
  test('构造与字段', () => {
    const t = new Tool({ name: 'add', description: '加法', handler: async () => 1, tags: ['math'] })
    assert.equal(t.name, 'add')
    assert.equal(t.description, '加法')
    assert.deepEqual(t.tags, ['math'])
  })

  test('非法 name / handler 抛异常', () => {
    assert.throws(() => new Tool({ name: '', handler: async () => {} }), TypeError)
    assert.throws(() => new Tool({ name: 'x' }), TypeError)
  })

  test('validate 参数校验', () => {
    const t = new Tool({
      name: 'x',
      handler: async () => {},
      parameters: { required: ['a'], properties: { a: { type: 'number' }, b: { type: 'string' } } },
    })
    assert.equal(t.validate({ a: 1 }).valid, true)
    assert.equal(t.validate({}).valid, false) // 缺 a
    assert.equal(t.validate({ a: 'x' }).valid, false) // a 类型错
  })
})

// ---------------------------------------------------------------------------
describe('ToolRegistry —— 工具注册表', () => {
  function build() {
    const r = new ToolRegistry()
    r.register(new Tool({ name: 'get_price', description: '查询价格', handler: async () => 1, tags: ['market'] }))
    r.register(new Tool({ name: 'send_alert', description: '发送告警', handler: async () => 1, tags: ['sos'] }))
    return r
  }

  test('注册 / 获取 / 注销', () => {
    const r = build()
    assert.equal(r.size, 2)
    assert.ok(r.has('get_price'))
    assert.ok(r.get('get_price') instanceof Tool)
    assert.ok(r.unregister('get_price'))
    assert.ok(!r.has('get_price'))
  })

  test('按名称模糊查找', () => {
    const r = build()
    assert.equal(r.findByName('price').length, 1)
    assert.equal(r.findByName('价格').length, 1)
  })

  test('按标签查找', () => {
    const r = build()
    assert.equal(r.findByTag('sos').length, 1)
    assert.equal(r.findByTag('sos')[0].name, 'send_alert')
  })

  test('综合搜索', () => {
    const r = build()
    assert.equal(r.search('告警').length, 1)
    assert.equal(r.search('market').length, 1)
  })

  test('validate 校验已注册工具参数', () => {
    const r = new ToolRegistry()
    r.register(new Tool({
      name: 'x', handler: async () => {},
      parameters: { required: ['n'], properties: { n: { type: 'number' } } },
    }))
    assert.equal(r.validate('x', { n: 1 }).valid, true)
    assert.equal(r.validate('x', {}).valid, false)
    assert.equal(r.validate('missing', {}).valid, false)
  })
})

// ---------------------------------------------------------------------------
describe('ToolInvoker —— 调用器', () => {
  test('成功调用返回结果', async () => {
    const tool = new Tool({ name: 'add', handler: async (args) => args.a + args.b })
    const invoker = new ToolInvoker({ retries: 0 })
    const r = await invoker.invoke(tool, { a: 1, b: 2 })
    assert.equal(r.ok, true)
    assert.equal(r.result, 3)
  })

  test('调用失败返回 error（不抛异常）', async () => {
    const tool = new Tool({ name: 'faulty', handler: () => { throw new Error('boom') } })
    const invoker = new ToolInvoker({ retries: 0 })
    const r = await invoker.invoke(tool, {})
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'error')
    assert.ok(r.error.includes('boom'))
  })

  test('超时保护', async () => {
    const tool = new Tool({ name: 'slow', handler: async () => { await sleep(60); return 1 } })
    const invoker = new ToolInvoker({ timeoutMs: 20, retries: 0 })
    const r = await invoker.invoke(tool, {})
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'error')
    assert.ok(r.error.includes('超时'))
  })

  test('重试后成功', async () => {
    let calls = 0
    const tool = new Tool({
      name: 'flaky',
      handler: async () => { calls++; if (calls < 3) throw new Error('temp'); return 'ok' },
    })
    const invoker = new ToolInvoker({ retries: 2 })
    const r = await invoker.invoke(tool, {})
    assert.equal(r.ok, true)
    assert.equal(calls, 3)
  })

  test('熔断器：连续失败后断开', async () => {
    const tool = new Tool({ name: 'faulty', handler: async () => { throw new Error('x') } })
    const invoker = new ToolInvoker({ failureThreshold: 2, retries: 0 })
    await invoker.invoke(tool, {}) // failures=1
    await invoker.invoke(tool, {}) // failures=2 -> open
    assert.equal(invoker.getBreakerState('faulty').state, BREAKER_STATE.OPEN)
    const r = await invoker.invoke(tool, {}) // 被拒绝
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'breaker-open')
  })

  test('熔断器：恢复窗口后 half-open 试探成功闭合', async () => {
    let mode = 'fail'
    const tool = new Tool({ name: 'flaky', handler: async () => { if (mode === 'fail') throw new Error('x'); return 'ok' } })
    const invoker = new ToolInvoker({ failureThreshold: 1, recoveryTimeout: 20, retries: 0 })
    await invoker.invoke(tool, {}) // 失败 -> open
    assert.equal(invoker.getBreakerState('flaky').state, BREAKER_STATE.OPEN)
    await sleep(30) // 超过恢复窗口
    mode = 'success'
    const r = await invoker.invoke(tool, {}) // half-open 试探成功
    assert.equal(r.ok, true)
    assert.equal(invoker.getBreakerState('flaky').state, BREAKER_STATE.CLOSED)
  })

  test('resetBreaker 复位熔断器', async () => {
    const tool = new Tool({ name: 'f', handler: async () => { throw new Error('x') } })
    const invoker = new ToolInvoker({ failureThreshold: 1, retries: 0 })
    await invoker.invoke(tool, {})
    assert.equal(invoker.getBreakerState('f').state, BREAKER_STATE.OPEN)
    invoker.resetBreaker('f')
    assert.equal(invoker.getBreakerState('f').state, BREAKER_STATE.CLOSED)
  })
})

// ---------------------------------------------------------------------------
describe('MCPScheduler —— 调度主类', () => {
  function build(options = {}) {
    const s = new MCPScheduler({ ...options, retries: 0 })
    s.register(new Tool({
      name: 'get_price',
      description: '查询价格',
      parameters: { required: ['symbol'], properties: { symbol: { type: 'string' } } },
      handler: async (args) => ({ symbol: args.symbol, price: 100 }),
      tags: ['market'],
    }))
    return s
  }

  test('注册与发现', () => {
    const s = build()
    assert.ok(s.hasTool('get_price'))
    assert.equal(s.discover('价格').length, 1)
    assert.equal(s.listTools().length, 1)
  })

  test('动态调用成功', async () => {
    const s = build()
    const r = await s.call('get_price', { symbol: 'AAPL' })
    assert.equal(r.ok, true)
    assert.equal(r.result.price, 100)
  })

  test('工具不存在返回 not-found', async () => {
    const s = build()
    const r = await s.call('nope')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-found')
  })

  test('参数校验失败返回 invalid-arguments', async () => {
    const s = build()
    const r = await s.call('get_price', {}) // 缺 symbol
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'invalid-arguments')
  })

  test('紧急终止：abort 后调用被拒绝', async () => {
    const s = build()
    s.abort()
    await assert.rejects(() => s.call('get_price', { symbol: 'A' }), (e) => e.code === 'ABORTED')
    s.clearAbort()
    assert.equal((await s.call('get_price', { symbol: 'A' })).ok, true)
  })

  test('集成记忆系统：调用写入工作记忆', async () => {
    const observations = []
    const memoryManager = { addObservation: (o) => observations.push(o) }
    const s = build({ memoryManager })
    await s.call('get_price', { symbol: 'A' })
    assert.equal(observations.length, 1)
    assert.ok(observations[0].content.includes('get_price'))
  })

  test('集成 CATS-Net：调用激活已存在概念', async () => {
    const activations = []
    const catsNet = {
      getNode: (id) => (id === 'get_price' ? {} : null),
      activate: (id, amt) => activations.push({ id, amt }),
    }
    const s = build({ catsNet })
    await s.call('get_price', { symbol: 'A' })
    assert.equal(activations.length, 1)
    assert.equal(activations[0].id, 'get_price')
  })

  test('无集成时降级运行', async () => {
    const s = build()
    const r = await s.call('get_price', { symbol: 'A' })
    assert.equal(r.ok, true)
  })
})