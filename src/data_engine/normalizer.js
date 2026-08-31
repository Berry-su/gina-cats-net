/**
 * 数据采集引擎 —— 归一化 (normalizer.js)
 *
 * 不同数据源产出结构各异的原始数据，统一归一化为标准结构，供下游（异动扫描/分析师团队）消费：
 *   - NewsItem  新闻条目；
 *   - QuoteItem 行情条目。
 */

function clampNum(value, min, max, fallback = 0) {
  const n = typeof value === 'number' && !Number.isNaN(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

let newsSeq = 0
function nextNewsId() {
  newsSeq += 1
  return `news_${Date.now().toString(36)}_${newsSeq}`
}

/**
 * 归一化新闻条目。
 * @param {object} raw
 * @returns {object|null} 非法输入返回 null
 */
export function normalizeNews(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : nextNewsId(),
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    outlet: typeof raw.outlet === 'string' ? raw.outlet : (raw.source ?? ''),
    title,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    publishedAt: typeof raw.publishedAt === 'number' ? raw.publishedAt : Date.now(),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    symbols: Array.isArray(raw.symbols) ? raw.symbols.filter((s) => typeof s === 'string') : [],
    importance: clampNum(raw.importance, 0, 1, 0.5),
  }
}

/**
 * 归一化行情条目。
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeQuote(raw) {
  if (!raw || typeof raw !== 'object') return null
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
  if (!symbol) return null

  const price = typeof raw.price === 'number' && !Number.isNaN(raw.price) ? raw.price : null
  if (price == null || price <= 0) return null
  const prevClose = typeof raw.prevClose === 'number' && raw.prevClose > 0 ? raw.prevClose : price
  const changePercent = typeof raw.changePercent === 'number' && !Number.isNaN(raw.changePercent)
    ? raw.changePercent
    : (price - prevClose) / prevClose
  const changeAmount = typeof raw.changeAmount === 'number' ? raw.changeAmount : price - prevClose

  return {
    symbol,
    name: typeof raw.name === 'string' && raw.name ? raw.name : symbol,
    market: raw.market === 'CN' ? 'CN' : 'US',
    price,
    prevClose,
    changePercent,
    changeAmount,
    open: typeof raw.open === 'number' ? raw.open : prevClose,
    high: typeof raw.high === 'number' ? raw.high : Math.max(price, prevClose),
    low: typeof raw.low === 'number' ? raw.low : Math.min(price, prevClose),
    volume: typeof raw.volume === 'number' && raw.volume >= 0 ? raw.volume : 0,
    avgVolume: typeof raw.avgVolume === 'number' && raw.avgVolume >= 0 ? raw.avgVolume : 0,
    dragonTiger: !!raw.dragonTiger,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
  }
}

/** 去重行情（同一 symbol 保留最新/后到者）。 */
export function dedupeQuotes(quotes) {
  const map = new Map()
  for (const q of quotes) {
    if (q && q.symbol) map.set(q.symbol, q)
  }
  return Array.from(map.values())
}

/** 去重新闻（同一 title 只保留一条）。 */
export function dedupeNews(news) {
  const seen = new Set()
  return news.filter((n) => {
    if (!n || !n.title || seen.has(n.title)) return false
    seen.add(n.title)
    return true
  })
}

/** 去重（同一 symbol 只保留一条，用于财报/资金流等富化数据）。 */
export function dedupeBySymbol(items) {
  const map = new Map()
  if (!Array.isArray(items)) return []
  for (const it of items) {
    if (it && typeof it.symbol === 'string' && it.symbol) map.set(it.symbol, it)
  }
  return Array.from(map.values())
}