import { describe, expect, it } from 'vitest'
import {
  evaluateExpression,
  formatExpressionReadable,
  inferExpressionShape,
  validateExpression,
  validateSafeRegexPattern,
  type Expr,
} from '../expression'

describe('expression.ts - CF-B 受控表达式引擎', () => {
  describe('安全正则校验 (validateSafeRegexPattern)', () => {
    it('接受安全正则', () => {
      expect(validateSafeRegexPattern('^sales_.*\\.xlsx$').valid).toBe(true)
      expect(validateSafeRegexPattern('[0-9]{3,4}', 'i').valid).toBe(true)
    })

    it('拒绝非法修饰符', () => {
      expect(validateSafeRegexPattern('abc', 'g').valid).toBe(false)
    })

    it('拒绝环视断言', () => {
      expect(validateSafeRegexPattern('(?=abc)').valid).toBe(false)
      expect(validateSafeRegexPattern('(?<=abc)').valid).toBe(false)
    })

    it('拒绝反向引用', () => {
      expect(validateSafeRegexPattern('(a)\\1').valid).toBe(false)
    })

    it('拒绝嵌套量词', () => {
      expect(validateSafeRegexPattern('(a+)+').valid).toBe(false)
      expect(validateSafeRegexPattern('(a*)*').valid).toBe(false)
    })

    it('拒绝超长正则 (>128)', () => {
      expect(validateSafeRegexPattern('a'.repeat(129)).valid).toBe(false)
    })
  })

  describe('AST 限制校验 (validateExpression)', () => {
    it('拒绝深度超限 (>8)', () => {
      let expr: Expr = { kind: 'literal', value: 1 }
      for (let i = 0; i < 9; i++) {
        expr = { kind: 'not', arg: expr }
      }
      const res = validateExpression(expr)
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.code).toBe('EXPR_LIMIT_EXCEEDED')
      }
    })

    it('拒绝 matches 右操作数使用不安全正则', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'matches',
        left: { kind: 'ref', key: 'filename' },
        right: { kind: 'literal', value: '(?=dangerous)' },
      }
      const res = validateExpression(expr)
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.code).toBe('EXPR_PATTERN_UNSAFE')
      }
    })
  })

  describe('求值器 (evaluateExpression)', () => {
    it('字面量与基本比较', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'literal', value: 100 },
        right: { kind: 'literal', value: 50 },
      }
      const res = evaluateExpression(expr, {})
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe(true)
    })

    it('引用上下文变量', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'ref', key: 'user', field: 'name' },
        right: { kind: 'literal', value: 'Alice' },
      }
      const res = evaluateExpression(expr, { user: { name: 'Alice' } })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe(true)
    })

    it('字段缺失或值为空时报未解析，而不是当成假', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'ref', key: 'price', field: 'amount' },
        right: { kind: 'literal', value: 100 },
      }
      const missingField = evaluateExpression(expr, { price: {} })
      expect(missingField.ok).toBe(false)
      if (!missingField.ok) expect(missingField.code).toBe('EXPR_UNRESOLVED_REF')

      const nullValue = evaluateExpression({ kind: 'ref', key: 'amount' }, { amount: null })
      expect(nullValue.ok).toBe(false)
      if (!nullValue.ok) expect(nullValue.code).toBe('EXPR_UNRESOLVED_REF')
    })

    it('exists 与 coalesce 不吞掉计算错误', () => {
      const existsExpr: Expr = {
        kind: 'call',
        fn: 'exists',
        args: [{ kind: 'call', fn: 'toNumber', args: [{ kind: 'literal', value: '约100件' }] }],
      }
      const existsRes = evaluateExpression(existsExpr, {})
      expect(existsRes.ok).toBe(false)
      if (!existsRes.ok) expect(existsRes.message).toContain('toNumber')

      const coalesceExpr: Expr = {
        kind: 'call',
        fn: 'coalesce',
        args: [
          { kind: 'call', fn: 'toNumber', args: [{ kind: 'literal', value: '约100件' }] },
          { kind: 'literal', value: 0 },
        ],
      }
      const coalesceRes = evaluateExpression(coalesceExpr, {})
      expect(coalesceRes.ok).toBe(false)
    })

    it('比较会记下参与计算的引用值', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'ref', key: 'price' },
        right: { kind: 'literal', value: 100 },
      }
      const res = evaluateExpression(expr, { price: 1999 })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.operands).toEqual({ price: 1999 })
    })

    it('上下文变量缺失报错', () => {
      const expr: Expr = {
        kind: 'ref',
        key: 'missingVar',
      }
      const res = evaluateExpression(expr, {})
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe('EXPR_UNRESOLVED_REF')
        expect(res.message).toContain('缺少 missingVar')
      }
    })

    it('exists() 允许缺失且返回 false', () => {
      const expr: Expr = {
        kind: 'call',
        fn: 'exists',
        args: [{ kind: 'ref', key: 'missingVar' }],
      }
      const res = evaluateExpression(expr, {})
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe(false)
    })

    it('coalesce() 忽略缺失并降级到默认值', () => {
      const expr: Expr = {
        kind: 'call',
        fn: 'coalesce',
        args: [
          { kind: 'ref', key: 'missingVar' },
          { kind: 'literal', value: 'defaultVal' },
        ],
      }
      const res = evaluateExpression(expr, {})
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe('defaultVal')
    })

    it('toNumber() 严格解析货币、千分位、全角数字', () => {
      const cases = [
        { input: '¥1,999.00', expected: 1999 },
        { input: ' $ 2,500.50 ', expected: 2500.5 },
        { input: '１２３４５', expected: 12345 },
      ]
      for (const { input, expected } of cases) {
        const expr: Expr = {
          kind: 'call',
          fn: 'toNumber',
          args: [{ kind: 'literal', value: input }],
        }
        const res = evaluateExpression(expr, {})
        expect(res.ok).toBe(true)
        if (res.ok) expect(res.value).toBe(expected)
      }

      // 非数字报错
      const invalidExpr: Expr = {
        kind: 'call',
        fn: 'toNumber',
        args: [{ kind: 'literal', value: '约100件' }],
      }
      const resInvalid = evaluateExpression(invalidExpr, {})
      expect(resInvalid.ok).toBe(false)
      if (!resInvalid.ok) {
        expect(resInvalid.message).toContain('toNumber 的参数不是数字：“约100件”')
      }
    })

    it('extractNumber() 宽松提取文本中的数字', () => {
      const expr: Expr = {
        kind: 'call',
        fn: 'extractNumber',
        args: [{ kind: 'literal', value: '订单总计约 100 件商品' }],
      }
      const res = evaluateExpression(expr, {})
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe(100)
    })

    it('matches 正则比较操作符', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'matches',
        left: { kind: 'literal', value: 'report_2026_09.csv' },
        right: { kind: 'literal', value: '^report_\\d{4}_\\d{2}\\.csv$' },
      }
      const res = evaluateExpression(expr, {})
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toBe(true)
    })

    it('列表函数 first, last, at, includes, pluck', () => {
      const context = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      }
      const pluckExpr: Expr = {
        kind: 'call',
        fn: 'pluck',
        args: [{ kind: 'ref', key: 'users' }, { kind: 'literal', value: 'name' }],
      }
      const res = evaluateExpression(pluckExpr, context)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value).toEqual(['Alice', 'Bob'])
    })
  })

  describe('可读格式化 (formatExpressionReadable)', () => {
    it('正确生成可读字符串', () => {
      const expr: Expr = {
        kind: 'compare',
        op: 'gt',
        left: {
          kind: 'call',
          fn: 'toNumber',
          args: [{ kind: 'ref', key: 'price' }],
        },
        right: { kind: 'literal', value: 10000 },
      }
      expect(formatExpressionReadable(expr)).toBe('toNumber(price) > 10000')
    })
  })

  describe('类型推断 (inferExpressionShape)', () => {
    it('正确推断标量与列表形状', () => {
      expect(
        inferExpressionShape(
          { kind: 'call', fn: 'toNumber', args: [{ kind: 'literal', value: '1' }] },
          {},
        ),
      ).toEqual({ kind: 'scalar', type: 'number' })

      expect(
        inferExpressionShape(
          { kind: 'call', fn: 'split', args: [{ kind: 'literal', value: 'a,b' }] },
          {},
        ),
      ).toEqual({
        kind: 'list',
        item: { kind: 'scalar', type: 'string' },
        maxItems: 200,
      })
    })
  })
})

describe('复查修复：受限正则与运行期上限', () => {
  it('拒绝被重复的含分支或含量词分组，包括嵌套写法', () => {
    for (const pattern of ['(a|aa)+', '(x|xy)*', '((a|b))+', '((a+))+', '(a?)+', '(ab|cd){2,}']) {
      expect(validateSafeRegexPattern(pattern).valid, pattern).toBe(false)
    }
  })

  it('放行常见的安全写法', () => {
    for (const pattern of ['SO-(\\d+)', '(a|b)?', '^订单号[:：]\\s*(\\w+)$', '[|(+]+', '\\(a|b\\)+', '(ab){2}']) {
      expect(validateSafeRegexPattern(pattern).valid, pattern).toBe(true)
    }
  })

  it('引用超过 16 KB 的文本或超过 200 项的列表即报超限', () => {
    const ref = { kind: 'ref' as const, key: 'v' }
    const tooLong = evaluateExpression({ kind: 'call', fn: 'length', args: [ref] }, { v: 'x'.repeat(16 * 1024 + 1) })
    expect(tooLong.ok ? '' : tooLong.code).toBe('EXPR_LIMIT_EXCEEDED')
    const tooMany = evaluateExpression({ kind: 'call', fn: 'length', args: [ref] }, { v: Array.from({ length: 201 }, (_, i) => i) })
    expect(tooMany.ok ? '' : tooMany.code).toBe('EXPR_LIMIT_EXCEEDED')
  })

  it('判断依据里的长文本做截断', () => {
    const res = evaluateExpression({ kind: 'call', fn: 'length', args: [{ kind: 'ref', key: 'v' }] }, { v: 'x'.repeat(1000) })
    expect(res.ok).toBe(true)
    const operand = res.ok ? String(res.operands.v) : ''
    expect(operand.length).toBeLessThan(300)
    expect(operand).toContain('共 1000 字')
  })
})
