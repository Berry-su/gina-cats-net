/**
 * 真实数据源 —— 配置加载 (config.js)
 *
 * 集中管理各数据源的密钥/token/代理配置，优先级：环境变量 > 配置文件 > 默认值。
 *   - 配置文件：data/data-sources.json（格式见 data/data-sources.example.json）
 *   - 环境变量：TUSHARE_TOKEN / ALPACA_KEY / ALPACA_SECRET / PROXY_URL / PROXY_ENABLED
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_CONFIG_PATH = join(__dirname, '..', '..', 'data', 'data-sources.json')

/**
 * 读取数据源配置。
 * @param {string} [path] 配置文件路径
 * @returns {object}
 */
export function loadDataSourcesConfig(path = DEFAULT_CONFIG_PATH) {
  let file = {}
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // 配置损坏则回退默认
    }
  }

  return {
    // 本地代理（Clash Verge 默认混合端口 7890；使用 TUN 模式则无需配置）
    proxy: process.env.PROXY_URL ?? file.proxy ?? 'http://127.0.0.1:7890',
    proxyEnabled: process.env.PROXY_ENABLED !== undefined
      ? process.env.PROXY_ENABLED === 'true'
      : (file.proxyEnabled ?? false),
    tushareToken: process.env.TUSHARE_TOKEN ?? file.tushare?.token ?? '',
    alpaca: {
      key: process.env.ALPACA_KEY ?? file.alpaca?.key ?? '',
      secret: process.env.ALPACA_SECRET ?? file.alpaca?.secret ?? '',
    },
    newsFeeds: Array.isArray(file.newsFeeds) ? file.newsFeeds : [],
    userAgent: file.userAgent ?? 'gina-agent/0.1 (research; contact: user)',
  }
}