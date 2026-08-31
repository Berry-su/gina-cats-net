/**
 * CATS-Net 抽象空间内核 —— 持久化序列化 (Serializer)
 *
 * 负责将内核快照在「内存态」与「磁盘持久化」之间安全转换，具备以下能力：
 *   - 版本化：快照携带 format / version，反序列化时校验，避免不兼容数据。
 *   - schema 校验：写入前与读取后双向校验结构合法性。
 *   - 原子写入：先写临时文件再 rename，避免写入中途崩溃导致文件损坏。
 *   - 节点水合：读取时将纯对象数组恢复为 ConceptNode 实例。
 *
 * 快照约定结构（snapshot）：
 *   {
 *     format: 'cats-net',
 *     version: '1.0.0',
 *     savedAt: 'ISO 时间戳',
 *     nodes: [ ConceptNode.toJSON(), ... ],
 *     memory: [ MemoryProjectionEntry.toJSON(), ... ],
 *     meta: { ... 任意附加元信息 ... },
 *   }
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConceptNode } from './concept-node.js'

/** 当前快照格式与版本。 */
export const CATS_NET_FORMAT = 'cats-net'
export const CATS_NET_VERSION = '1.0.0'

export class Serializer {
  /**
   * @param {object} [options]
   * @param {string} [options.format]  期望格式（默认 cats-net）
   * @param {string} [options.version] 期望版本（默认 1.0.0）
   */
  constructor({ format = CATS_NET_FORMAT, version = CATS_NET_VERSION } = {}) {
    this.format = format
    this.version = version
  }

  /**
   * schema 校验。返回 { valid, errors }，不抛异常。
   * @param {object} data
   * @returns {{valid:boolean, errors:string[]}}
   */
  validate(data) {
    const errors = []
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { valid: false, errors: ['快照必须是对象'] }
    }
    if (data.format !== this.format) {
      errors.push(`format 不匹配：期望 ${this.format}，实际 ${data.format}`)
    }
    if (data.version !== this.version) {
      errors.push(`version 不匹配：期望 ${this.version}，实际 ${data.version}`)
    }
    if (!Array.isArray(data.nodes)) {
      errors.push('nodes 必须是数组')
    } else {
      data.nodes.forEach((n, i) => {
        if (!n || typeof n !== 'object' || typeof n.id !== 'string') {
          errors.push(`nodes[${i}] 缺少合法 id`)
        }
      })
    }
    if (data.memory !== undefined && !Array.isArray(data.memory)) {
      errors.push('memory 必须是数组')
    }
    return { valid: errors.length === 0, errors }
  }

  /**
   * 将内存快照标准化为可持久化的纯对象（补全 format/version/savedAt）。
   * @param {object} snapshot 内核产出的快照（nodes 需为 ConceptNode.toJSON() 数组或等价纯对象）
   * @returns {object} 可直接 JSON.stringify 的纯对象
   */
  serialize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new TypeError('serialize 需要快照对象')
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
    const normalized = {
      format: this.format,
      version: this.version,
      savedAt: new Date().toISOString(),
      nodes,
      memory: Array.isArray(snapshot.memory) ? snapshot.memory : [],
      meta: snapshot.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {},
    }
    const { valid, errors } = this.validate(normalized)
    if (!valid) throw new Error(`快照校验失败: ${errors.join('; ')}`)
    return normalized
  }

  /**
   * 从持久化数据反序列化为内存快照（含 ConceptNode 实例化的 Map）。
   * @param {object} data
   * @returns {{format:string, version:string, savedAt:string, nodes:Map<string,ConceptNode>, memory:Array, meta:object}}
   */
  deserialize(data) {
    const { valid, errors } = this.validate(data)
    if (!valid) throw new Error(`反序列化校验失败: ${errors.join('; ')}`)

    const nodes = new Map()
    for (const raw of data.nodes) {
      const node = ConceptNode.fromJSON(raw)
      nodes.set(node.id, node)
    }
    return {
      format: data.format,
      version: data.version,
      savedAt: data.savedAt,
      nodes,
      memory: data.memory ?? [],
      meta: data.meta ?? {},
    }
  }

  /**
   * 原子写入文件：先写临时文件，再 rename 替换目标文件。
   * @param {string} filePath  目标文件绝对路径
   * @param {object} snapshot  内核快照
   * @returns {string} 写入后的文件路径
   */
  saveToFile(filePath, snapshot) {
    const json = JSON.stringify(this.serialize(snapshot), null, 2)
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmpPath, json, 'utf8')
    renameSync(tmpPath, filePath)
    return filePath
  }

  /**
   * 从文件加载并反序列化。
   * @param {string} filePath
   * @returns {object} 与 deserialize 相同的返回结构
   */
  loadFromFile(filePath) {
    if (!existsSync(filePath)) {
      throw new Error(`快照文件不存在: ${filePath}`)
    }
    const raw = readFileSync(filePath, 'utf8')
    let data
    try {
      data = JSON.parse(raw)
    } catch (err) {
      throw new Error(`快照文件 JSON 解析失败: ${err.message}`)
    }
    return this.deserialize(data)
  }
}