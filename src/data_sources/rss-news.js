/**
 * 真实数据源 —— 权威新闻 RSS 适配器 (rss-news.js)
 *
 * 通过 RSS 抓取权威新闻（华尔街日报/彭博/财新等是否提供公开 RSS 视订阅情况而定，
 * 可在 data/data-sources.json 的 newsFeeds 里配置实际可访问的 feed url）。
 * 内置轻量 RSS 解析器（无第三方依赖）。
 */

import { NewsSource } from '../data_engine/index.js'
import { proxiedFetch } from './http-client.js'

/** 示例权威 feed（是否能访问取决于订阅/网络；生产请配置真实可用的 feed）。 */
export const DEFAULT_NEWS_FEEDS = [
  { outlet: '路透社', source: 'Reuters', market: 'US', url: 'https://feeds.reuters.com/reuters/businessNews' },
  { outlet: '路透社', source: 'Reuters', market: 'CN', url: 'https://feeds.reuters.com/reuters/chinaNews' },
]

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function tag(content, name) {
  const m = content.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))
  return m ? decodeEntities(m[1]) : ''
}

/**
 * 解析 RSS XML 为条目列表（纯逻辑，便于测试）。
 * @param {string} xml
 * @returns {Array<{title:string, link:string, description:string, pubDate:string}>}
 */
export function parseRss(xml = '') {
  const items = []
  const blocks = xml.split(/<item[\s>]/).slice(1)
  for (const block of blocks) {
    const title = tag(block, 'title')
    if (!title) continue
    items.push({
      title,
      link: tag(block, 'link'),
      description: tag(block, 'description'),
      pubDate: tag(block, 'pubDate'),
    })
  }
  return items
}

/**
 * RSS 新闻源（实现 NewsSource，可直接注入 DataEngine）。
 */
export class RssNewsSource extends NewsSource {
  /**
   * @param {object} [options]
   * @param {string} [options.outlet]  来源中文名
   * @param {string} [options.source]  来源标识
   * @param {string} [options.market]  US/CN
   * @param {string} [options.url]     RSS feed url
   * @param {string} [options.proxyUrl]
   */
  constructor({ outlet = '', source = '', market = 'US', url = '', proxyUrl = null } = {}) {
    super({ source, outlet })
    this.market = market
    this.url = url
    this.proxyUrl = proxyUrl
  }

  async fetch() {
    if (!this.url) return []
    const resp = await proxiedFetch(this.url, {
      proxyUrl: this.proxyUrl,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    })
    const xml = await resp.text()
    return parseRss(xml).map((it) => ({
      source: this.source,
      outlet: this.outlet,
      title: it.title,
      summary: it.description,
      url: it.link,
      publishedAt: it.pubDate ? new Date(it.pubDate).getTime() : Date.now(),
      tags: [this.market === 'CN' ? 'A股' : '美股', '新闻'],
      symbols: [],
    }))
  }
}

/** 便捷：按配置批量构建 RSS 新闻源。 */
export function createRssNewsSources(feeds = DEFAULT_NEWS_FEEDS, { proxyUrl = null } = {}) {
  return (Array.isArray(feeds) ? feeds : []).map(
    (f) => new RssNewsSource({ ...f, proxyUrl }),
  )
}