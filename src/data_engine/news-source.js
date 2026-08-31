/**
 * 数据采集引擎 —— 权威新闻源 (news-source.js)
 *
 * 新闻源的抽象接口与 Mock 实现。真实接入时（华尔街日报/彭博/财新/上证报等）需各自继承
 * NewsSource 并实现 fetch() 调用对应 API / 抓取器，注入 DataEngine 即可；本模块不绑定具体网络实现。
 *
 * MockNewsSource 提供离线可跑通的权威来源样例新闻，供开发与测试使用。
 */

/** 权威新闻来源清单（真实接入时的标识与中文名）。 */
export const AUTHORITATIVE_SOURCES = Object.freeze([
  { source: 'WSJ', outlet: '华尔街日报', market: 'US' },
  { source: 'Bloomberg', outlet: '彭博', market: 'US' },
  { source: 'Reuters', outlet: '路透社', market: 'US' },
  { source: 'FT', outlet: '金融时报', market: 'US' },
  { source: 'Caixin', outlet: '财新', market: 'CN' },
  { source: 'SSE', outlet: '上海证券报', market: 'CN' },
  { source: 'CS', outlet: '中国证券报', market: 'CN' },
  { source: 'ST', outlet: '证券时报', market: 'CN' },
])

/**
 * 新闻源基类。
 */
export class NewsSource {
  /** @param {object} [options] */
  constructor({ source = 'unknown', outlet = '' } = {}) {
    this.source = source
    this.outlet = outlet || source
  }

  /** 子类实现：抓取一批原始新闻（返回数组）。 */
  async fetch() {
    return []
  }

  /** 停止/清理（子类覆盖）。 */
  async stop() {}
}

/**
 * 默认新闻样例池（离线演示用，覆盖宏观/公司/市场三类）。
 */
export const DEFAULT_NEWS_POOL = [
  { title: '美联储主席就利率路径发表讲话，市场关注降息时点', summary: '官员表态偏鸽派，利率期货隐含年内降息预期升温。', tags: ['宏观', '利率', '美联储'], symbols: [], importance: 0.9 },
  { title: '央行开展公开市场操作，释放流动性信号', summary: '资金面维持宽松，隔夜回购利率回落。', tags: ['宏观', '流动性', '央行'], symbols: [], importance: 0.85 },
  { title: '大型科技公司发布超预期财报，净利润同比大幅增长', summary: '云计算与广告业务强劲，盘后股价走强。', tags: ['财报', '科技'], symbols: ['MSFT', 'GOOGL'], importance: 0.8 },
  { title: '新能源汽车龙头单月交付量创历史新高', summary: '产能爬坡叠加海外扩张，交付数据超机构预期。', tags: ['汽车', '新能源', '财报'], symbols: ['TSLA'], importance: 0.75 },
  { title: '地缘政治紧张局势升温，原油与避险资产波动加剧', summary: '市场风险偏好回落，黄金与美债受追捧。', tags: ['地缘', '原油', '避险'], symbols: ['XOM'], importance: 0.7 },
  { title: '北向资金单日净买入额创阶段新高', summary: '外资加速流入核心资产，龙头白马获加仓。', tags: ['资金', '北向'], symbols: ['600519', '000858'], importance: 0.75 },
  { title: '监管层就资本市场改革释放最新政策信号', summary: '强调提升上市公司质量与投资者回报。', tags: ['政策', '监管'], symbols: [], importance: 0.8 },
  { title: '某消费龙头提价公告引发市场关注', summary: '成本传导与需求韧性再受关注，相关板块波动。', tags: ['消费', '公司'], symbols: ['600519'], importance: 0.6 },
  { title: '半导体设备出口管制消息扰动全球芯片股', summary: '供应链担忧升温，芯片板块整体承压。', tags: ['半导体', '贸易', '地缘'], symbols: ['NVDA'], importance: 0.7 },
  { title: '银行间市场利率异动，资金面骤然收紧', summary: '季末因素叠加缴税影响，短端利率快速上行。', tags: ['流动性', '资金'], symbols: ['601318'], importance: 0.65 },
  { title: '多只个股登上龙虎榜，游资博弈痕迹明显', summary: '题材股换手加剧，机构与游资席位分歧加大。', tags: ['龙虎榜', '题材'], symbols: [], importance: 0.55 },
  { title: '财政部发布减税降费相关政策，稳增长加力', summary: '财政政策协同发力，基建与消费方向获提振。', tags: ['政策', '财政', '宏观'], symbols: [], importance: 0.7 },
].map((n, i) => ({ ...n, id: `mock_news_${i + 1}` }))

/**
 * 离线 Mock 新闻源：从样例池循环取若干条，标注来源出处。
 */
export class MockNewsSource extends NewsSource {
  /**
   * @param {object} [options]
   * @param {string} [options.source] 来源标识
   * @param {string} [options.outlet] 来源中文名
   * @param {Array} [options.pool] 新闻池
   * @param {number} [options.count] 每次抓取条数
   */
  constructor({ source = 'WSJ', outlet = '华尔街日报', pool = DEFAULT_NEWS_POOL, count = 5, startAt = 0 } = {}) {
    super({ source, outlet })
    this.pool = Array.isArray(pool) && pool.length ? pool : DEFAULT_NEWS_POOL
    this.count = typeof count === 'number' && count > 0 ? count : 5
    this._cursor = typeof startAt === 'number' && startAt >= 0 ? Math.floor(startAt) : 0
  }

  async fetch() {
    const out = []
    for (let i = 0; i < this.count; i++) {
      const item = this.pool[this._cursor % this.pool.length]
      this._cursor += 1
      out.push({
        ...item,
        source: this.source,
        outlet: this.outlet,
        publishedAt: Date.now(),
      })
    }
    return out
  }
}

/** 便捷：构建默认多个权威来源的 Mock 新闻源（各源起始偏移避免内容完全重复）。 */
export function createMockNewsSources({ count = 4 } = {}) {
  return AUTHORITATIVE_SOURCES.slice(0, count).map(
    (s, i) => new MockNewsSource({ source: s.source, outlet: s.outlet, count: 4, startAt: i * 4 }),
  )
}