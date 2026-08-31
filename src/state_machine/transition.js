/**
 * 状态机模块 —— 迁移与守卫 (Transition)
 *
 * Transition 描述从源状态到目标状态的迁移规则：
 *   - `event`   触发事件名；
 *   - `guard`   前置守卫（谓词）—— 返回 true 才允许迁移，false 则迁移被拒绝；
 *   - `action`  迁移副作用 —— 迁移成立后、进入目标状态前执行。
 *
 * 守卫是可组合的纯谓词函数，本文件同时提供 `and` / `or` / `not` 组合子，
 * 便于构造「多条件同时满足」「任一满足」「条件取反」等复合守卫。
 */

export class Transition {
  /**
   * @param {object} options
   * @param {string} options.from   源状态 id
   * @param {string} options.to     目标状态 id（HSM 中可为 history 伪状态 id）
   * @param {string} options.event  触发事件名
   * @param {Function|null} [options.guard]  守卫 (context) => boolean
   * @param {Function|null} [options.action] 动作 (context) => void
   */
  constructor({ from, to, event, guard = null, action = null } = {}) {
    if (typeof from !== 'string' || from.length === 0) throw new TypeError('Transition 需要非空 from')
    if (typeof to !== 'string' || to.length === 0) throw new TypeError('Transition 需要非空 to')
    if (typeof event !== 'string' || event.length === 0) throw new TypeError('Transition 需要非空 event')

    this.from = from
    this.to = to
    this.event = event
    this.guard = typeof guard === 'function' ? guard : null
    this.action = typeof action === 'function' ? action : null
  }

  /** 计算该迁移在当前上下文下是否被守卫放行（无守卫视为允许）。 */
  isAllowed(context = {}) {
    return this.guard === null || this.guard(context) === true
  }
}

/**
 * 组合守卫：全部满足才通过。
 * @param {...Function} guards
 * @returns {Function} (context) => boolean
 */
export function and(...guards) {
  return (context) => guards.every((g) => g(context))
}

/**
 * 组合守卫：任一满足即通过。
 * @param {...Function} guards
 * @returns {Function} (context) => boolean
 */
export function or(...guards) {
  return (context) => guards.some((g) => g(context))
}

/**
 * 组合守卫：取反。
 * @param {Function} guard
 * @returns {Function} (context) => boolean
 */
export function not(guard) {
  return (context) => !guard(context)
}