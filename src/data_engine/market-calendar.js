/**
 * 数据采集引擎 —— 交易时段日历 (market-calendar.js)
 *
 * 处理美国与中国市场的时差与交易时段，使采集「第一时间」对各自市场的更新做出反应：
 *   - US 使用 America/New_York（ET），CN 使用 Asia/Shanghai（CST）；
 *   - 定义各市场活跃时段（含盘前/盘中/盘后），用于判断「是否应采集」；
 *   - 计算「距下一次采集」的毫秒数：盘中按 intradayMinutes 定时，休市则等到下一时段开盘。
 *
 * 说明：真实「翻墙/代理」属于网络层职责，由真实数据源适配器处理（接入代理即可）；
 *       本模块只负责「何时采集」，与「如何联网」解耦。
 */

/** 各市场交易时段（单位：分钟，自当日 0 点起）。 */
export const SESSIONS = Object.freeze({
  US: {
    timezone: 'America/New_York',
    // 盘前 04:00-09:30、盘中 09:30-16:00、盘后 16:00-20:00
    windows: [[240, 570], [570, 960], [960, 1200]],
  },
  CN: {
    timezone: 'Asia/Shanghai',
    // 集合竞价+上午 09:15-11:30、下午 13:00-15:00（午间休市不采集）
    windows: [[555, 690], [780, 900]],
  },
})

export const TIMEZONES = Object.freeze({ US: 'America/New_York', CN: 'Asia/Shanghai' })

/**
 * 计算某一时刻在指定时区「当日分钟数」0..1439。
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number}
 */
export function minutesInTimeZone(date = new Date(), timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  })
  let h = 0
  let m = 0
  for (const p of fmt.formatToParts(date)) {
    if (p.type === 'hour') h = Number(p.value)
    if (p.type === 'minute') m = Number(p.value)
  }
  return ((h % 24) * 60 + m) % 1440
}

/**
 * 时段中文标签（供日志/推送可读）。
 * @param {'US'|'CN'} market
 * @param {number} minutesOfDay
 * @returns {string}
 */
export function sessionLabel(market, minutesOfDay) {
  if (market === 'US') {
    if (minutesOfDay < 240) return '休市'
    if (minutesOfDay < 570) return '盘前'
    if (minutesOfDay < 960) return '盘中'
    if (minutesOfDay < 1200) return '盘后'
    return '休市'
  }
  // CN
  if (minutesOfDay < 555) return '休市'
  if (minutesOfDay < 690) return '上午盘'
  if (minutesOfDay < 780) return '午间休市'
  if (minutesOfDay < 900) return '下午盘'
  return '休市'
}

/**
 * 判断某市场在给定分钟数是否处于「活跃时段」（应采集）。
 * @param {'US'|'CN'} market
 * @param {number} minutesOfDay
 * @returns {boolean}
 */
export function isActive(market, minutesOfDay) {
  const cfg = SESSIONS[market]
  if (!cfg) return false
  return cfg.windows.some(([s, e]) => minutesOfDay >= s && minutesOfDay < e)
}

/**
 * 获取某市场当前交易状态。
 * @param {'US'|'CN'} market
 * @param {Date} [now]
 * @returns {{market:string, minutesOfDay:number, label:string, active:boolean}}
 */
export function getSessionState(market, now = new Date()) {
  const minutesOfDay = minutesInTimeZone(now, SESSIONS[market]?.timezone)
  return {
    market,
    minutesOfDay,
    label: sessionLabel(market, minutesOfDay),
    active: isActive(market, minutesOfDay),
  }
}

/**
 * 计算距下一次采集的毫秒数（纯逻辑，便于测试）。
 * @param {'US'|'CN'} market
 * @param {object} options
 * @param {number} options.minutesOfDay 当前分钟数（该市场时区）
 * @param {number} [options.intradayMinutes] 盘中采集间隔（分钟）
 * @returns {number} 毫秒
 */
export function nextUpdateDelayMs(market, { minutesOfDay, intradayMinutes = 5 }) {
  const cfg = SESSIONS[market]
  if (!cfg) return 0
  const m = ((minutesOfDay % 1440) + 1440) % 1440
  const intradayMs = Math.max(1, intradayMinutes) * 60000

  // 活跃时段内：按盘中间隔，且不越出本时段
  for (const [s, e] of cfg.windows) {
    if (m >= s && m < e) {
      return Math.min(intradayMs, (e - m) * 60000)
    }
  }

  // 非活跃：等待下一时段开盘（跨日则等明天）
  let next = null
  for (const [s] of cfg.windows) {
    if (s > m) { next = s; break }
  }
  const delta = next != null ? next - m : (1440 - m) + cfg.windows[0][0]
  return delta * 60000
}

/**
 * 便捷：按真实当前时间计算距下次采集的毫秒数。
 * @param {'US'|'CN'} market
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.intradayMinutes]
 * @returns {number}
 */
export function nextUpdateDelay(market, { now = new Date(), intradayMinutes = 5 } = {}) {
  const cfg = SESSIONS[market]
  const minutesOfDay = minutesInTimeZone(now, cfg?.timezone)
  return nextUpdateDelayMs(market, { minutesOfDay, intradayMinutes })
}