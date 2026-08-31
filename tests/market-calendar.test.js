/**
 * 数据采集引擎 —— 交易时段日历与分区域调度 单元测试
 *
 * 运行：node --test tests/market-calendar.test.js
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSIONS,
  minutesInTimeZone,
  sessionLabel,
  isActive,
  nextUpdateDelayMs,
  MarketAwareScheduler,
} from '../src/data_engine/index.js'

describe('market-calendar —— 交易时段', () => {
  test('sessionLabel 区分美中各时段', () => {
    assert.equal(sessionLabel('US', 100), '休市')
    assert.equal(sessionLabel('US', 300), '盘前')
    assert.equal(sessionLabel('US', 600), '盘中')
    assert.equal(sessionLabel('US', 1000), '盘后')
    assert.equal(sessionLabel('US', 1300), '休市')
    assert.equal(sessionLabel('CN', 580), '上午盘')
    assert.equal(sessionLabel('CN', 720), '午间休市')
    assert.equal(sessionLabel('CN', 800), '下午盘')
    assert.equal(sessionLabel('CN', 60), '休市')
  })

  test('isActive 仅活跃时段为真', () => {
    assert.equal(isActive('US', 300), true)   // 盘前
    assert.equal(isActive('US', 600), true)   // 盘中
    assert.equal(isActive('US', 1300), false) // 休市
    assert.equal(isActive('CN', 720), false)  // 午间休市
    assert.equal(isActive('CN', 800), true)   // 下午盘
  })

  test('不合法的市场返回 false / 0 延迟', () => {
    assert.equal(isActive('XX', 600), false)
    assert.equal(nextUpdateDelayMs('XX', { minutesOfDay: 600 }), 0)
  })
})

describe('market-calendar —— 下次采集时刻', () => {
  test('盘中按间隔定时（不越出时段）', () => {
    // US 600 分钟处于盘中 [570,960]，间隔 5 分钟
    assert.equal(nextUpdateDelayMs('US', { minutesOfDay: 600, intradayMinutes: 5 }), 5 * 60000)
    // 接近收盘时封顶到时段结束
    assert.equal(nextUpdateDelayMs('US', { minutesOfDay: 958, intradayMinutes: 5 }), 2 * 60000)
  })

  test('休市时等到下一时段开盘', () => {
    // US 100 分钟（休市），下一开盘 240 → 140 分钟
    assert.equal(nextUpdateDelayMs('US', { minutesOfDay: 100, intradayMinutes: 5 }), 140 * 60000)
    // US 1300（盘后结束），跨日到明日 240
    assert.equal(nextUpdateDelayMs('US', { minutesOfDay: 1300, intradayMinutes: 5 }), 380 * 60000)
  })

  test('中国市场午间休市等到下午开盘', () => {
    assert.equal(nextUpdateDelayMs('CN', { minutesOfDay: 720, intradayMinutes: 5 }), 60 * 60000)
    // 收盘后跨日到次日 555
    assert.equal(nextUpdateDelayMs('CN', { minutesOfDay: 950, intradayMinutes: 5 }), 1045 * 60000)
  })

  test('minutesInTimeZone 返回合法分钟数', () => {
    const m = minutesInTimeZone(new Date('2026-08-19T04:00:00Z'), 'Asia/Shanghai')
    assert.ok(m >= 0 && m < 1440)
  })
})

describe('MarketAwareScheduler —— 分区域调度', () => {
  test('trigger 按区域执行 job（顺序多次都执行）', async () => {
    let usCount = 0
    let cnCount = 0
    const s = new MarketAwareScheduler({ us: async () => { usCount += 1 }, cn: async () => { cnCount += 1 } })
    await s.trigger('US')
    await s.trigger('US')
    await s.trigger('CN')
    assert.equal(usCount, 2)
    assert.equal(cnCount, 1)
  })

  test('trigger 防重入：并发触发只执行一次', async () => {
    let count = 0
    const s = new MarketAwareScheduler({ us: async () => { count += 1 } })
    const p1 = s.trigger('US')
    const p2 = s.trigger('US')
    await Promise.all([p1, p2])
    assert.equal(count, 1)
  })

  test('job 抛错不中断（走 onError）', async () => {
    const errors = []
    const s = new MarketAwareScheduler({ us: async () => { throw new Error('boom') }, onError: (e) => errors.push(e) })
    await s.trigger('US')
    assert.equal(errors.length, 1)
  })

  test('start/stop 与 abort', () => {
    const s = new MarketAwareScheduler({ us: async () => {} })
    s.start()
    assert.equal(s.isRunning(), true)
    s.stop()
    assert.equal(s.isRunning(), false)
    s.abort()
    assert.equal(s.isAborted(), true)
    s.clearAbort()
    assert.equal(s.isAborted(), false)
  })

  test('getNextDelay 返回非负毫秒数', () => {
    const s = new MarketAwareScheduler({ us: async () => {}, cn: async () => {} })
    assert.ok(s.getNextDelay('US') >= 0)
    assert.ok(s.getNextDelay('CN') >= 0)
  })
})