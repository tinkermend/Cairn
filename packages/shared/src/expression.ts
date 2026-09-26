import { z } from 'zod'
import type { JsonValue } from './wire.js'
import type { OutputShape } from './output-schema.js'

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------

export const MAX_EXPR_DEPTH = 8
export const MAX_EXPR_NODES = 64
export const MAX_LITERAL_STRING_LENGTH = 1024
export const MAX_RUNTIME_STRING_LENGTH = 16 * 1024 // 16 KB
export const MAX_RUNTIME_LIST_ITEMS = 200

export const EXPR_FUNCTIONS = [
  // 文本
  'trim',
  'lower',
  'upper',
  'concat',
  'substring',
  'replace',
  'split',
  'join',
  'length',
  // 数字
  'toNumber',
  'extractNumber',
  'round',
  'abs',
  'min',
  'max',
  'sum',
  // 判空与缺省
  'exists',
  'isEmpty',
  'coalesce',
  // 正则
  'regexExtract',
  // 列表
  'first',
  'last',
  'at',
  'includes',
  'pluck',
] as const

export type ExprFunction = (typeof EXPR_FUNCTIONS)[number]

export const EXPR_COMPARE_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'ends_with',
  'matches',
] as const
export type ExprCompareOp = (typeof EXPR_COMPARE_OPS)[number]

export const EXPR_LOGIC_OPS = ['and', 'or'] as const
export type ExprLogicOp = (typeof EXPR_LOGIC_OPS)[number]

// ---------------------------------------------------------------------------
// AST Types
// ---------------------------------------------------------------------------

export type ExprLiteral = {
  kind: 'literal'
  value: string | number | boolean | null
}

export type ExprRef = {
  kind: 'ref'
  key: string
  field?: string
}

export type ExprCall = {
  kind: 'call'
  fn: ExprFunction
  args: Expr[]
}

export type ExprCompare = {
  kind: 'compare'
  op: ExprCompareOp
  left: Expr
  right: Expr
}

export type ExprLogic = {
  kind: 'logic'
  op: ExprLogicOp
  args: Expr[]
}

export type ExprNot = {
  kind: 'not'
  arg: Expr
}

export type Expr =
  | ExprLiteral
  | ExprRef
  | ExprCall
  | ExprCompare
  | ExprLogic
  | ExprNot

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const exprFunctionSchema = z.enum(EXPR_FUNCTIONS)
export const exprCompareOpSchema = z.enum(EXPR_COMPARE_OPS)
export const exprLogicOpSchema = z.enum(EXPR_LOGIC_OPS)

export const exprLiteralSchema = z.strictObject({
  kind: z.literal('literal'),
  value: z
    .union([z.string().max(MAX_LITERAL_STRING_LENGTH), z.number(), z.boolean(), z.null()]),
})

export const exprRefSchema = z.strictObject({
  kind: z.literal('ref'),
  key: z.string().trim().min(1).max(64),
  field: z.string().trim().min(1).max(64).optional(),
})

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    exprLiteralSchema,
    exprRefSchema,
    z.strictObject({
      kind: z.literal('call'),
      fn: exprFunctionSchema,
      args: z.array(exprSchema).max(16),
    }),
    z.strictObject({
      kind: z.literal('compare'),
      op: exprCompareOpSchema,
      left: exprSchema,
      right: exprSchema,
    }),
    z.strictObject({
      kind: z.literal('logic'),
      op: exprLogicOpSchema,
      args: z.array(exprSchema).min(1).max(16),
    }),
    z.strictObject({
      kind: z.literal('not'),
      arg: exprSchema,
    }),
  ]),
)

export const conditionSchema = exprSchema

// ---------------------------------------------------------------------------
// Safe Regex Validation
// ---------------------------------------------------------------------------

/**
 * 校验受限正则：
 * - 长度 <= 128
 * - 仅允许 i 标志
 * - 禁止环视 lookahead / lookbehind (?=, (?!, (?<=, (?<!
 * - 禁止反向引用 \1, \2 等
 * - 禁止嵌套量词如 (a+)+, (a*)* 杜绝 ReDoS
 */
export function validateSafeRegexPattern(
  pattern: string,
  flags?: string,
): { valid: true; regex: RegExp } | { valid: false; reason: string } {
  if (!pattern || typeof pattern !== 'string') {
    return { valid: false, reason: '正则表达式模式不能为空' }
  }
  if (pattern.length > 128) {
    return { valid: false, reason: '正则表达式长度不能超过 128 字符' }
  }
  if (flags && flags !== 'i') {
    return { valid: false, reason: '正则表达式仅允许 i (大小写不敏感) 修饰符' }
  }

  // 检查环视
  if (/\(\?[=!<]/.test(pattern)) {
    return { valid: false, reason: '受限正则禁止使用环视断言 (Lookaround)' }
  }
  // 检查反向引用
  if (/\\[1-9]/.test(pattern) || /\\k<.+?>/.test(pattern)) {
    return { valid: false, reason: '受限正则禁止使用反向引用 (Backreference)' }
  }
  // 检查被重复的分组：组内含量词（(a+)+）或分支（(a|aa)+）都可能灾难性回溯
  const repeated = findRepeatedRiskyGroup(pattern)
  if (repeated === 'quantifier') {
    return { valid: false, reason: '受限正则禁止使用可能引起灾难性回溯的嵌套量词 (Nested Quantifier)' }
  }
  if (repeated === 'alternation') {
    return { valid: false, reason: '受限正则禁止对含分支的分组整体重复（如 (a|aa)+），可能引起灾难性回溯' }
  }

  try {
    const reg = new RegExp(pattern, flags || undefined)
    return { valid: true, regex: reg }
  } catch (err) {
    return { valid: false, reason: `正则表达式语法错误: ${(err as Error).message}` }
  }
}

/** 量词之后的字符是否构成「可重复多次」：+、*、{n,}、{n,m}（m > 1）。 */
function repeatsAt(pattern: string, index: number): boolean {
  const ch = pattern[index]
  if (ch === '+' || ch === '*') return true
  if (ch !== '{') return false
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index))
  if (!match) return false
  if (match[2] === undefined) return Number(match[1]) > 1
  return match[3] === '' || Number(match[3]) > 1
}

/**
 * 逐字符扫描（跳过转义与字符类），找被重复的分组中是否含量词或分支。
 * 标记沿嵌套向外传递，((a+))+ 与 ((a|b))+ 同样能识别。
 */
function findRepeatedRiskyGroup(pattern: string): 'quantifier' | 'alternation' | null {
  const stack: Array<{ quantifier: boolean; alternation: boolean }> = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    const top = stack[stack.length - 1]
    if (ch === '(') {
      stack.push({ quantifier: false, alternation: false })
      continue
    }
    if (ch === '|') {
      if (top) top.alternation = true
      continue
    }
    if (ch === ')') {
      const group = stack.pop()
      if (!group) continue
      if (repeatsAt(pattern, i + 1)) {
        if (group.quantifier) return 'quantifier'
        if (group.alternation) return 'alternation'
      }
      const parent = stack[stack.length - 1]
      if (parent) {
        parent.quantifier ||= group.quantifier || repeatsAt(pattern, i + 1)
        parent.alternation ||= group.alternation
      }
      continue
    }
    if ((ch === '+' || ch === '*' || ch === '?' || ch === '{') && top && (ch !== '{' || repeatsAt(pattern, i))) {
      top.quantifier = true
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Expression AST Validation
// ---------------------------------------------------------------------------

export function countExprNodes(expr: Expr): number {
  switch (expr.kind) {
    case 'literal':
    case 'ref':
      return 1
    case 'not':
      return 1 + countExprNodes(expr.arg)
    case 'compare':
      return 1 + countExprNodes(expr.left) + countExprNodes(expr.right)
    case 'call':
    case 'logic':
      return 1 + expr.args.reduce((acc, a) => acc + countExprNodes(a), 0)
    default:
      return 1
  }
}

export function exprDepth(expr: Expr): number {
  switch (expr.kind) {
    case 'literal':
    case 'ref':
      return 1
    case 'not':
      return 1 + exprDepth(expr.arg)
    case 'compare':
      return 1 + Math.max(exprDepth(expr.left), exprDepth(expr.right))
    case 'call':
    case 'logic':
      return 1 + (expr.args.length > 0 ? Math.max(...expr.args.map(exprDepth)) : 0)
    default:
      return 1
  }
}

export function validateExpression(
  expr: Expr,
): { valid: true } | { valid: false; code: string; message: string } {
  const nodes = countExprNodes(expr)
  if (nodes > MAX_EXPR_NODES) {
    return {
      valid: false,
      code: 'EXPR_LIMIT_EXCEEDED',
      message: `表达式节点数 (${nodes}) 超过上限 (${MAX_EXPR_NODES})`,
    }
  }

  const depth = exprDepth(expr)
  if (depth > MAX_EXPR_DEPTH) {
    return {
      valid: false,
      code: 'EXPR_LIMIT_EXCEEDED',
      message: `表达式嵌套深度 (${depth}) 超过上限 (${MAX_EXPR_DEPTH})`,
    }
  }

  // 递归检查函数实参及正则安全
  function checkInner(node: Expr): { valid: true } | { valid: false; code: string; message: string } {
    if (node.kind === 'compare') {
      if (node.op === 'matches') {
        if (node.right.kind !== 'literal' || typeof node.right.value !== 'string') {
          return {
            valid: false,
            code: 'EXPR_PATTERN_UNSAFE',
            message: 'matches 比较操作符的右操作数必须是字面量正则表达式字符串',
          }
        }
        const safe = validateSafeRegexPattern(node.right.value)
        if (!safe.valid) {
          return { valid: false, code: 'EXPR_PATTERN_UNSAFE', message: safe.reason }
        }
      }
      const l = checkInner(node.left)
      if (!l.valid) return l
      return checkInner(node.right)
    }

    if (node.kind === 'call') {
      if (node.fn === 'regexExtract') {
        const patternNode = node.args[1]
        if (patternNode && patternNode.kind === 'literal' && typeof patternNode.value === 'string') {
          const safe = validateSafeRegexPattern(patternNode.value)
          if (!safe.valid) {
            return { valid: false, code: 'EXPR_PATTERN_UNSAFE', message: safe.reason }
          }
        }
      }
      for (const a of node.args) {
        const r = checkInner(a)
        if (!r.valid) return r
      }
    }

    if (node.kind === 'logic') {
      for (const a of node.args) {
        const r = checkInner(a)
        if (!r.valid) return r
      }
    }

    if (node.kind === 'not') {
      return checkInner(node.arg)
    }

    return { valid: true }
  }

  return checkInner(expr)
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

class UnresolvedRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnresolvedRefError'
  }
}

function refLabel(key: string, field?: string): string {
  return field ? `${key}.${field}` : key
}

function readRef(context: Record<string, unknown>, key: string, field?: string): unknown {
  if (FORBIDDEN_KEYS.has(key) || (field !== undefined && FORBIDDEN_KEYS.has(field))) {
    throw new Error(`禁止访问受保护属性: ${refLabel(key, field)}`)
  }
  if (!Object.hasOwn(context, key)) {
    throw new UnresolvedRefError(`上下文缺少 ${key}`)
  }
  const base = context[key]
  if (!field) {
    if (base === undefined || base === null) throw new UnresolvedRefError(`上下文缺少 ${key}`)
    return base
  }
  if (base === undefined || base === null || typeof base !== 'object' || Array.isArray(base)) {
    throw new UnresolvedRefError(`上下文缺少 ${refLabel(key, field)}`)
  }
  const record = base as Record<string, unknown>
  if (!Object.hasOwn(record, field) || record[field] === undefined || record[field] === null) {
    throw new UnresolvedRefError(`上下文缺少 ${refLabel(key, field)}`)
  }
  return record[field]
}

const MAX_OPERAND_TEXT = 256
const MAX_OPERAND_JSON = 2048

/** 判断依据只保留可读摘要：长文本、大对象截断，避免把整段页面内容写进证据。 */
function asOperand(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    return value.length > MAX_OPERAND_TEXT ? `${value.slice(0, MAX_OPERAND_TEXT)}…（共 ${value.length} 字）` : value
  }
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return null
    if (text.length <= MAX_OPERAND_JSON) return JSON.parse(text) as JsonValue
    return { truncated: true, preview: `${text.slice(0, MAX_OPERAND_TEXT)}…`, length: text.length }
  } catch {
    return null
  }
}

function normalizeFullWidthDigits(str: string): string {
  return str.replace(/[\uff10-\uff19]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  )
}

function parseNumberStrict(raw: unknown): number {
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw
  if (typeof raw !== 'string') {
    throw new Error(`toNumber 参数不是有效类型: ${typeof raw}`)
  }
  let s = raw.trim()
  if (!s) throw new Error('toNumber 参数为空字符串')
  // 转换全角数字
  s = normalizeFullWidthDigits(s)
  // 去除货币符号与逗号
  s = s.replace(/^[¥$€£元\s]+/, '').replace(/[¥$€£元\s]+$/, '')
  s = s.replace(/,/g, '').trim()
  const num = Number(s)
  if (Number.isNaN(num)) {
    throw new Error(`toNumber 的参数不是数字：“${raw}”`)
  }
  return num
}

function parseNumberLenient(raw: unknown): number | null {
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw
  if (typeof raw !== 'string') return null
  let s = normalizeFullWidthDigits(raw)
  s = s.replace(/,/g, '')
  const match = /[-+]?\d+(?:\.\d+)?/.exec(s)
  if (!match) return null
  const num = Number(match[0])
  return Number.isNaN(num) ? null : num
}

export type EvaluateExprResult =
  | { ok: true; value: JsonValue; operands: Record<string, JsonValue> }
  | { ok: false; code: 'EXPR_EVAL_ERROR' | 'EXPR_UNRESOLVED_REF' | 'EXPR_LIMIT_EXCEEDED'; message: string }

export function evaluateExpression(
  expr: Expr,
  context: Record<string, unknown>,
): EvaluateExprResult {
  const operands: Record<string, JsonValue> = {}
  try {
    const raw = evalInner(expr, context, operands)
    if (raw === undefined) {
      return { ok: false, code: 'EXPR_EVAL_ERROR', message: '表达式没有结果' }
    }
    return { ok: true, value: raw as JsonValue, operands }
  } catch (err) {
    const msg = (err as Error).message
    if (err instanceof UnresolvedRefError) {
      return { ok: false, code: 'EXPR_UNRESOLVED_REF', message: msg }
    }
    if (msg.includes('超过上限') || msg.includes('超限')) {
      return { ok: false, code: 'EXPR_LIMIT_EXCEEDED', message: msg }
    }
    return { ok: false, code: 'EXPR_EVAL_ERROR', message: msg }
  }
}

function evalInner(
  expr: Expr,
  context: Record<string, unknown>,
  operands: Record<string, JsonValue>,
): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value

    case 'ref': {
      const res = readRef(context, expr.key, expr.field)
      if (typeof res === 'string' && res.length > MAX_RUNTIME_STRING_LENGTH) {
        throw new Error(`${refLabel(expr.key, expr.field)} 的文本长度 (${res.length}) 超过上限 (${MAX_RUNTIME_STRING_LENGTH})`)
      }
      if (Array.isArray(res) && res.length > MAX_RUNTIME_LIST_ITEMS) {
        throw new Error(`${refLabel(expr.key, expr.field)} 的条数 (${res.length}) 超过上限 (${MAX_RUNTIME_LIST_ITEMS})`)
      }
      operands[refLabel(expr.key, expr.field)] = asOperand(res)
      return res
    }

    case 'not': {
      const v = evalInner(expr.arg, context, operands)
      return !v
    }

    case 'logic': {
      if (expr.op === 'and') {
        for (const a of expr.args) {
          const v = evalInner(a, context, operands)
          if (!v) return false
        }
        return true
      }
      if (expr.op === 'or') {
        for (const a of expr.args) {
          const v = evalInner(a, context, operands)
          if (v) return true
        }
        return false
      }
      return false
    }

    case 'compare': {
      const left = evalInner(expr.left, context, operands)
      const right = evalInner(expr.right, context, operands)

      switch (expr.op) {
        case 'eq':
          return left === right
        case 'ne':
          return left !== right
        case 'gt':
          return (left as any) > (right as any)
        case 'gte':
          return (left as any) >= (right as any)
        case 'lt':
          return (left as any) < (right as any)
        case 'lte':
          return (left as any) <= (right as any)
        case 'contains': {
          if (typeof left === 'string' && typeof right === 'string') {
            return left.includes(right)
          }
          if (Array.isArray(left)) {
            return left.includes(right)
          }
          return false
        }
        case 'starts_with':
          return typeof left === 'string' && typeof right === 'string' && left.startsWith(right)
        case 'ends_with':
          return typeof left === 'string' && typeof right === 'string' && left.endsWith(right)
        case 'matches': {
          if (typeof left !== 'string' || typeof right !== 'string') return false
          const reg = new RegExp(right, 'i')
          return reg.test(left)
        }
        default:
          return false
      }
    }

    case 'call': {
      return evalCall(expr.fn, expr.args, context, operands)
    }

    default:
      return null
  }
}

function evalCall(
  fn: ExprFunction,
  args: Expr[],
  context: Record<string, unknown>,
  operands: Record<string, JsonValue>,
): unknown {
  // exists / coalesce 只吸收「引用缺失」。计算错误继续失败。
  if (fn === 'exists') {
    const firstArg = args[0]
    if (!firstArg) return false
    try {
      const val = evalInner(firstArg, context, operands)
      return val !== undefined && val !== null
    } catch (err) {
      if (err instanceof UnresolvedRefError) return false
      throw err
    }
  }

  if (fn === 'coalesce') {
    for (const a of args) {
      try {
        const val = evalInner(a, context, operands)
        if (val !== undefined && val !== null) return val
      } catch (err) {
        if (err instanceof UnresolvedRefError) continue
        throw err
      }
    }
    return null
  }

  const evaluated = args.map((a) => evalInner(a, context, operands))

  switch (fn) {
    // 文本函数
    case 'trim': {
      const s = String(evaluated[0] ?? '')
      return s.trim()
    }
    case 'lower': {
      const s = String(evaluated[0] ?? '')
      return s.toLowerCase()
    }
    case 'upper': {
      const s = String(evaluated[0] ?? '')
      return s.toUpperCase()
    }
    case 'concat': {
      const res = evaluated.map((v) => (v === null || v === undefined ? '' : String(v))).join('')
      if (res.length > MAX_RUNTIME_STRING_LENGTH) {
        throw new Error(`concat 结果长度 (${res.length}) 超过上限 (${MAX_RUNTIME_STRING_LENGTH})`)
      }
      return res
    }
    case 'substring': {
      const s = String(evaluated[0] ?? '')
      const start = Number(evaluated[1] ?? 0)
      const end = evaluated[2] !== undefined ? Number(evaluated[2]) : undefined
      return s.substring(start, end)
    }
    case 'replace': {
      const s = String(evaluated[0] ?? '')
      const search = String(evaluated[1] ?? '')
      const replacement = String(evaluated[2] ?? '')
      const res = s.replaceAll(search, replacement)
      if (res.length > MAX_RUNTIME_STRING_LENGTH) {
        throw new Error(`replace 结果长度 (${res.length}) 超过上限 (${MAX_RUNTIME_STRING_LENGTH})`)
      }
      return res
    }
    case 'split': {
      const s = String(evaluated[0] ?? '')
      const sep = String(evaluated[1] ?? '')
      const arr = s.split(sep)
      if (arr.length > MAX_RUNTIME_LIST_ITEMS) {
        throw new Error(`split 结果条数 (${arr.length}) 超过上限 (${MAX_RUNTIME_LIST_ITEMS})`)
      }
      return arr
    }
    case 'join': {
      const arr = evaluated[0]
      if (!Array.isArray(arr)) return ''
      const sep = String(evaluated[1] ?? ',')
      const res = arr.join(sep)
      if (res.length > MAX_RUNTIME_STRING_LENGTH) {
        throw new Error(`join 结果长度 (${res.length}) 超过上限 (${MAX_RUNTIME_STRING_LENGTH})`)
      }
      return res
    }
    case 'length': {
      const target = evaluated[0]
      if (typeof target === 'string' || Array.isArray(target)) {
        return target.length
      }
      return 0
    }

    // 数字函数
    case 'toNumber': {
      return parseNumberStrict(evaluated[0])
    }
    case 'extractNumber': {
      const n = parseNumberLenient(evaluated[0])
      if (n === null) {
        throw new Error(`extractNumber 未能在“${evaluated[0]}”中找到任何数字`)
      }
      return n
    }
    case 'round': {
      const num = Number(evaluated[0] ?? 0)
      const decimals = Number(evaluated[1] ?? 0)
      const factor = Math.pow(10, decimals)
      return Math.round(num * factor) / factor
    }
    case 'abs': {
      return Math.abs(Number(evaluated[0] ?? 0))
    }
    case 'min': {
      const nums = evaluated.flatMap((v) => (Array.isArray(v) ? v : [v])).map(Number)
      if (nums.length === 0) return 0
      return Math.min(...nums)
    }
    case 'max': {
      const nums = evaluated.flatMap((v) => (Array.isArray(v) ? v : [v])).map(Number)
      if (nums.length === 0) return 0
      return Math.max(...nums)
    }
    case 'sum': {
      const nums = evaluated.flatMap((v) => (Array.isArray(v) ? v : [v])).map(Number)
      return nums.reduce((acc, n) => acc + (Number.isNaN(n) ? 0 : n), 0)
    }

    // 判空
    case 'isEmpty': {
      const target = evaluated[0]
      if (target === null || target === undefined) return true
      if (typeof target === 'string') return target.trim().length === 0
      if (Array.isArray(target)) return target.length === 0
      if (typeof target === 'object') return Object.keys(target).length === 0
      return false
    }

    // 正则
    case 'regexExtract': {
      const text = String(evaluated[0] ?? '')
      const pattern = String(evaluated[1] ?? '')
      const group = Number(evaluated[2] ?? 0)
      const safe = validateSafeRegexPattern(pattern)
      if (!safe.valid) {
        throw new Error(`regexExtract 正则不合法: ${safe.reason}`)
      }
      const m = safe.regex.exec(text)
      if (!m) return null
      return m[group] ?? null
    }

    // 列表函数
    case 'first': {
      const arr = evaluated[0]
      if (!Array.isArray(arr) || arr.length === 0) return null
      return arr[0] ?? null
    }
    case 'last': {
      const arr = evaluated[0]
      if (!Array.isArray(arr) || arr.length === 0) return null
      return arr[arr.length - 1] ?? null
    }
    case 'at': {
      const arr = evaluated[0]
      const idx = Number(evaluated[1] ?? 0)
      if (!Array.isArray(arr)) return null
      return arr[idx] ?? null
    }
    case 'includes': {
      const arr = evaluated[0]
      const item = evaluated[1]
      if (!Array.isArray(arr)) return false
      return arr.includes(item)
    }
    case 'pluck': {
      const arr = evaluated[0]
      const field = String(evaluated[1] ?? '')
      if (!Array.isArray(arr) || !field) return []
      if (FORBIDDEN_KEYS.has(field)) return []
      return arr.map((item) =>
        item && typeof item === 'object' ? (item as Record<string, unknown>)[field] ?? null : null,
      )
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Type & OutputShape Inference
// ---------------------------------------------------------------------------

export function inferExpressionShape(
  expr: Expr,
  contextShapes: Record<string, OutputShape>,
): OutputShape {
  switch (expr.kind) {
    case 'literal': {
      if (typeof expr.value === 'string') return { kind: 'scalar', type: 'string' }
      if (typeof expr.value === 'number') return { kind: 'scalar', type: 'number' }
      if (typeof expr.value === 'boolean') return { kind: 'scalar', type: 'boolean' }
      return { kind: 'unknown' }
    }

    case 'ref': {
      const shape = contextShapes[expr.key]
      if (!shape) return { kind: 'unknown' }
      if (!expr.field) return shape
      if (shape.kind === 'object') {
        const found = shape.fields.find((f: { name: string; type: any }) => f.name === expr.field)
        if (found) return { kind: 'scalar', type: found.type }
      }
      return { kind: 'unknown' }
    }

    case 'not':
    case 'logic':
    case 'compare':
      return { kind: 'scalar', type: 'boolean' }

    case 'call': {
      switch (expr.fn) {
        case 'trim':
        case 'lower':
        case 'upper':
        case 'concat':
        case 'substring':
        case 'replace':
        case 'join':
        case 'regexExtract':
          return { kind: 'scalar', type: 'string' }

        case 'toNumber':
        case 'extractNumber':
        case 'round':
        case 'abs':
        case 'min':
        case 'max':
        case 'sum':
        case 'length':
          return { kind: 'scalar', type: 'number' }

        case 'exists':
        case 'isEmpty':
        case 'includes':
          return { kind: 'scalar', type: 'boolean' }

        case 'split':
          return {
            kind: 'list',
            item: { kind: 'scalar', type: 'string' },
            maxItems: MAX_RUNTIME_LIST_ITEMS,
          }

        case 'pluck':
          return {
            kind: 'list',
            item: { kind: 'scalar', type: 'json' },
            maxItems: MAX_RUNTIME_LIST_ITEMS,
          }

        case 'first':
        case 'last':
        case 'at':
        case 'coalesce':
          return { kind: 'unknown' }

        default:
          return { kind: 'unknown' }
      }
    }

    default:
      return { kind: 'unknown' }
  }
}

// ---------------------------------------------------------------------------
// Human-Readable Formatter
// ---------------------------------------------------------------------------

const COMPARE_OP_SYMBOLS: Record<ExprCompareOp, string> = {
  eq: '==',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: '包含',
  starts_with: '开始于',
  ends_with: '结束于',
  matches: '匹配',
}

export function formatExpressionReadable(expr: Expr): string {
  switch (expr.kind) {
    case 'literal': {
      if (typeof expr.value === 'string') return `"${expr.value}"`
      if (expr.value === null) return 'null'
      return String(expr.value)
    }
    case 'ref': {
      return expr.field ? `${expr.key}.${expr.field}` : expr.key
    }
    case 'not': {
      return `!(${formatExpressionReadable(expr.arg)})`
    }
    case 'logic': {
      const opStr = expr.op === 'and' ? ' && ' : ' || '
      return expr.args.map(formatExpressionReadable).join(opStr)
    }
    case 'compare': {
      const op = COMPARE_OP_SYMBOLS[expr.op] || expr.op
      return `${formatExpressionReadable(expr.left)} ${op} ${formatExpressionReadable(expr.right)}`
    }
    case 'call': {
      return `${expr.fn}(${expr.args.map(formatExpressionReadable).join(', ')})`
    }
    default:
      return ''
  }
}
