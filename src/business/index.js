/**
 * 业务模块聚合入口 —— 机器狼 / SOS 急救 / 交易业务
 *
 * 业务子模块各自独立演进，入口文件提供统一 export 占位。
 * 实际引用方按需 import 子模块（`@berrysu/gina-core/business/mech_wolf`）。
 *
 * 注意：pnpm exports 配置仅声明 `./business` 子路径，
 * 真正的子模块（mech_wolf/sos/trading）以子目录形式存在，
 * 主仓可直接 `@berrysu/gina-core/business/<sub>` 形式导入。
 */

export const BUSINESS_SUBMODULES = ['mech_wolf', 'sos', 'trading']
