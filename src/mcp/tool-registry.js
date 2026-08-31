/**
 * MCP 工具调度模块 —— 工具注册表 (ToolRegistry)
 *
 * 负责工具的定义、注册、发现与参数校验：
 *   - Tool：工具的元数据（名称/描述/参数 schema/tags）与执行函数 handler（async）；
 *   - ToolRegistry：工具容器，支持按名称精确查找、按名称/描述模糊搜索、按标签检索；
 *   - 参数校验：基于 JSON Schema 子集（required + type），在调用前拦截非法入参。
 *
 * handler 约定为 async 函数（或返回 Promise 的函数），调用方一律 await。
 */

/** 判断值是否符合 schema 声明的类型。 */
function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && !Number.isNaN(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    default: return true // 未知类型不做严格校验
  }
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 基于 JSON Schema 子集校验参数。
 * @param {object} parameters 形如 { type:'object', properties:{...}, required:[...] }
 * @param {object} args       实际入参
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateArguments(parameters, args) {
  const errors = []
  const params = parameters && typeof parameters === 'object' ? parameters : {}
  const properties = params.properties && typeof params.properties === 'object' ? params.properties : {}
  const required = Array.isArray(params.required) ? params.required : []
  const actual = args && typeof args === 'object' ? args : {}

  for (const key of required) {
    if (!(key in actual)) errors.push(`缺少必填参数: ${key}`)
  }
  for (const [key, schema] of Object.entries(properties)) {
    if (key in actual && schema && typeof schema === 'object' && schema.type) {
      if (!typeMatches(schema.type, actual[key])) {
        errors.push(`参数 ${key} 类型不匹配: 期望 ${schema.type}，实际 ${typeOf(actual[key])}`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

export class Tool {
  /**
   * @param {object} options
   * @param {string} options.name         唯一工具名
   * @param {string} [options.description] 描述
   * @param {object} [options.parameters]  JSON Schema 子集 { properties, required }
   * @param {Function} options.handler     async 执行函数 (args, context) => any
   * @param {string[]} [options.tags]      能力标签
   */
  constructor({ name, description = '', parameters = {}, handler, tags = [] } = {}) {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('Tool 需要非空字符串 name')
    if (typeof handler !== 'function') throw new TypeError('Tool 需要 handler 函数')
    this.name = name
    this.description = description
    this.parameters = parameters && typeof parameters === 'object' ? parameters : {}
    this.handler = handler
    this.tags = Array.isArray(tags) ? tags : []
  }

  /** 校验参数（单工具视角）。 */
  validate(args) {
    return validateArguments(this.parameters, args)
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      tags: [...this.tags],
    }
  }
}

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, Tool>} */
    this.tools = new Map()
  }

  get size() {
    return this.tools.size
  }

  /**
   * 注册工具（同名覆盖）。
   * @param {Tool|object} tool
   * @returns {Tool}
   */
  register(tool) {
    const t = tool instanceof Tool ? tool : new Tool(tool)
    this.tools.set(t.name, t)
    return t
  }

  /**
   * 注销工具。
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    return this.tools.delete(name)
  }

  /** 按名称精确获取。 */
  get(name) {
    return this.tools.get(name)
  }

  /** 是否存在。 */
  has(name) {
    return this.tools.has(name)
  }

  /** 列出全部工具（只读副本）。 */
  list() {
    return Array.from(this.tools.values())
  }

  /** 返回全部工具名。 */
  names() {
    return Array.from(this.tools.keys())
  }

  /**
   * 按名称或描述模糊匹配（不区分大小写）。
   * @param {string} query
   * @returns {Tool[]}
   */
  findByName(query) {
    const q = String(query).toLowerCase()
    return this.list().filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    )
  }

  /**
   * 按标签精确匹配。
   * @param {string} tag
   * @returns {Tool[]}
   */
  findByTag(tag) {
    return this.list().filter((t) => t.tags.includes(tag))
  }

  /**
   * 综合搜索：名称 + 描述 + 标签。
   * @param {string} query
   * @returns {Tool[]}
   */
  search(query) {
    const q = String(query).toLowerCase()
    return this.list().filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)),
    )
  }

  /**
   * 校验某个已注册工具的入参。
   * @param {string} name
   * @param {object} args
   * @returns {{valid:boolean, errors:string[]}}
   */
  validate(name, args) {
    const tool = this.get(name)
    if (!tool) return { valid: false, errors: [`工具不存在: ${name}`] }
    return tool.validate(args)
  }
}