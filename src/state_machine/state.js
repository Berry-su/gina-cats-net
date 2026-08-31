/**
 * 状态机模块 —— 状态定义 (State)
 *
 * State 表示状态机中的一个状态节点，既可被 FSM（有限状态机）使用，
 * 也可被 HSM（层次状态机）使用：
 *   - `parent` 建立父子层次（HSM 使用，FSM 中恒为 null）；
 *   - `onEntry` / `onExit` 是分别在进入/退出该状态时执行的副作用动作，
 *     接收一个 `context`（业务上下文），可用于打点、资源申请/释放、日志等。
 */

export class State {
  /**
   * @param {object} options
   * @param {string} options.id         唯一标识（必填）
   * @param {string} [options.name]     展示名，缺省取 id
   * @param {string|null} [options.parent] 父状态 id（HSM 层次）
   * @param {Function|null} [options.onEntry]  进入动作 (context) => void
   * @param {Function|null} [options.onExit]   退出动作 (context) => void
   */
  constructor({ id, name, parent = null, onEntry = null, onExit = null } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('State 需要非空字符串 id')
    }
    this.id = id
    this.name = typeof name === 'string' && name.length > 0 ? name : id
    this.parent = parent
    this.onEntry = typeof onEntry === 'function' ? onEntry : null
    this.onExit = typeof onExit === 'function' ? onExit : null
  }
}