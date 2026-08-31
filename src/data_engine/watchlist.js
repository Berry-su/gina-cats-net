/**
 * 数据采集引擎 —— 自选池 (watchlist.js)
 *
 * 定义需要覆盖的标的范围：市值前 500 美股 + 全部 A 股。
 * 真实生产时应由「按市值/成交额动态筛选」生成；此处提供：
 *   - 精选头部样例（有真实名称，便于演示与联调）；
 *   - buildWatchlist() 可按数量批量生成合成标的，模拟 500 美股 + N A股 的全市场覆盖。
 */

/** 美股头部样例（按市值，真实名称）。 */
export const US_TOP = [
  { symbol: 'AAPL', name: '苹果' },
  { symbol: 'MSFT', name: '微软' },
  { symbol: 'NVDA', name: '英伟达' },
  { symbol: 'GOOGL', name: '谷歌' },
  { symbol: 'AMZN', name: '亚马逊' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'TSLA', name: '特斯拉' },
  { symbol: 'BRK.B', name: '伯克希尔' },
  { symbol: 'JPM', name: '摩根大通' },
  { symbol: 'V', name: 'Visa' },
  { symbol: 'UNH', name: '联合健康' },
  { symbol: 'XOM', name: '埃克森美孚' },
  { symbol: 'JNJ', name: '强生' },
  { symbol: 'WMT', name: '沃尔玛' },
  { symbol: 'PG', name: '宝洁' },
]

/** A 股头部样例（真实名称）。 */
export const CN_TOP = [
  { symbol: '600519', name: '贵州茅台' },
  { symbol: '300750', name: '宁德时代' },
  { symbol: '601318', name: '中国平安' },
  { symbol: '600036', name: '招商银行' },
  { symbol: '000858', name: '五粮液' },
  { symbol: '000333', name: '美的集团' },
  { symbol: '601899', name: '紫金矿业' },
  { symbol: '600900', name: '长江电力' },
  { symbol: '601857', name: '中国石油' },
  { symbol: '002594', name: '比亚迪' },
]

/**
 * 生成自选池（头部样例 + 合成标的）。
 * @param {object} [options]
 * @param {number} [options.usCount] 美股合成数量（额外于 US_TOP）
 * @param {number} [options.cnCount] A 股合成数量（额外于 CN_TOP）
 * @returns {{us:Array<{symbol:string,name:string}>, cn:Array<{symbol:string,name:string}>}}
 */
export function buildWatchlist({ usCount = 500, cnCount = 100 } = {}) {
  const us = [...US_TOP]
  for (let i = 1; i <= usCount; i++) {
    us.push({ symbol: `US${String(i).padStart(4, '0')}`, name: `美股样本${i}` })
  }

  const cn = [...CN_TOP]
  for (let i = 1; i <= cnCount; i++) {
    const code = String((600000 + i)).slice(0, 6)
    cn.push({ symbol: code, name: `A股样本${i}` })
  }

  // 去重（防止 usCount 与样例撞码时出现重复）
  return {
    us: dedupe(us),
    cn: dedupe(cn),
  }
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    if (seen.has(x.symbol)) return false
    seen.add(x.symbol)
    return true
  })
}