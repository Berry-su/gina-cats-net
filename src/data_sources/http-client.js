/**
 * 真实数据源 —— HTTP 客户端（带代理） (http-client.js)
 *
 * 统一网络出口，支持 JSON 请求/超时/User-Agent。
 * 代理策略：
 *   - 推荐使用 Clash Verge 的「TUN 模式」（系统级透明代理），此时无需在代码里配代理，直连即可翻墙；
 *   - 若需显式 HTTP 代理，请 `npm i undici` 后把 config.proxyEnabled 设为 true（默认代理 http://127.0.0.1:7890）。
 */

/**
 * 构造代理 dispatcher（仅当启用了代理且安装 undici 时生效）。
 * @param {string|null} proxyUrl
 * @returns {Promise<object|undefined>}
 */
async function buildProxyDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined
  try {
    const mod = await import('undici')
    if (typeof mod?.ProxyAgent === 'function') {
      return new mod.ProxyAgent(proxyUrl)
    }
  } catch {
    // 未安装 undici → 回退直连（依赖 TUN 模式）
  }
  return undefined
}

/**
 * 发起请求并返回 Response。
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.proxyUrl]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {string|null} [options.body]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Response>}
 */
export async function proxiedFetch(url, {
  proxyUrl = null,
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 15000,
} = {}) {
  const dispatcher = await buildProxyDispatcher(proxyUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const opts = { method, headers, signal: controller.signal, redirect: 'follow' }
  if (body != null) opts.body = body
  if (dispatcher) opts.dispatcher = dispatcher

  try {
    let resp
    if (dispatcher) {
      const { fetch: ufetch } = await import('undici')
      resp = await ufetch(url, opts)
    } else {
      resp = await fetch(url, opts)
    }
    return resp
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 请求 JSON 并解析。
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const resp = await proxiedFetch(url, options)
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${url}`)
  }
  return resp.json()
}