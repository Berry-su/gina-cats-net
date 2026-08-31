/**
 * CATS-Net 抽象空间内核 —— 统一导出入口
 *
 * 供上层业务模块（记忆系统、状态机、MCP、交易、SOS 等后续模块）引用。
 */

export { CatsNet } from './cats-net.js'
export { ConceptNode, CONCEPT_TYPES, ACTIVATION_MIN, ACTIVATION_MAX } from './concept-node.js'
export {
  ConflictResolver,
  CONFLICT_TYPES,
  RESOLUTION_STRATEGIES,
} from './conflict-resolver.js'
export {
  Serializer,
  CATS_NET_FORMAT,
  CATS_NET_VERSION,
} from './serializer.js'
export { MemoryProjection, MemoryEntry } from './memory-projection.js'