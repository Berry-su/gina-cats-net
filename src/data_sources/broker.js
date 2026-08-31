/**
 * 真实数据源 —— 交易经纪商接口 (broker.js)
 *
 * 下单执行层的抽象接口 + 同花顺骨架实现。
 * 权限硬约束：placeOrder 必须显式传入 authorized=true 才可能执行；未授权一律拒绝，
 * 与「只有用户授权 Gina 才能下单」的权限链保持一致（授权闸门在此二次兜底）。
 *
 * 说明：A 股程序化下单通常走券商量化通道（迅投 QMT/miniQMT，多为 Windows）或同花顺 iFinD
 * 交易接口；本骨架仅定义接口与授权门，等确定通道/账号后实现具体下单逻辑。
 */

export class BrokerAdapter {
  get name() { return 'base' }

  /**
   * 下单（买入/卖出）。
   * @param {object} order { symbol, side:'buy'|'sell', size, price }
   * @param {object} [options]
   * @param {boolean} [options.authorized] 用户是否已授权
   * @returns {Promise<object>} { status, reason, orderId? }
   */
  async placeOrder(_order, _options = {}) {
    return { status: 'not_connected', reason: `${this.name} 未接入` }
  }

  /** 撤单。 */
  async cancelOrder(_orderId) {
    return { status: 'not_connected', reason: `${this.name} 未接入` }
  }

  /** 查询持仓。 */
  async getPositions() {
    return []
  }

  /** 查询账户资金。 */
  async getAccount() {
    return null
  }
}

/**
 * 同花顺交易骨架（未接入，仅定义授权门与接口）。
 */
export class TonghuashunBrokerAdapter extends BrokerAdapter {
  get name() { return '同花顺' }

  constructor({ accountId = '' } = {}) {
    super()
    this.accountId = accountId
  }

  async placeOrder(order, { authorized = false } = {}) {
    // 授权硬门：未授权一律拒绝
    if (!authorized) {
      return { status: 'rejected', reason: '未获用户授权，禁止下单' }
    }
    if (!order || !order.symbol || !['buy', 'sell'].includes(order.side)) {
      return { status: 'rejected', reason: '订单非法' }
    }
    // TODO: 接入真实同花顺下单通道（QMT/迅投 或 iFinD），完成后返回真实委托号
    return { status: 'not_connected', reason: '同花顺交易通道未接入（待配置券商账号/授权通道）' }
  }
}