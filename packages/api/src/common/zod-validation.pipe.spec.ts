import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ZodValidationPipe } from './zod-validation.pipe'

const schema = z.object({ name: z.string().min(1), age: z.coerce.number().int() })
const meta = { type: 'body' as const, metatype: undefined, data: undefined }

describe('ZodValidationPipe', () => {
  it('通过校验时返回解析后的值', () => {
    const pipe = new ZodValidationPipe(schema)
    expect(pipe.transform({ name: 'cairn', age: '3' }, meta)).toEqual({ name: 'cairn', age: 3 })
  })

  it('校验失败抛 BadRequestException', () => {
    const pipe = new ZodValidationPipe(schema)
    expect(() => pipe.transform({ name: '', age: 'x' }, meta)).toThrow(BadRequestException)
  })

  it('错误响应逐条列出字段路径与原因', () => {
    const pipe = new ZodValidationPipe(schema)
    try {
      pipe.transform({ age: 'x' }, meta)
      expect.unreachable('应当抛错')
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as {
        message: string
        issues: { path: string; code: string }[]
      }
      expect(body.message).toBe('请求参数校验失败')
      expect(body.issues.map((i) => i.path).sort()).toEqual(['age', 'name'])
    }
  })

  it('非 ZodError 原样抛出，不吞异常', () => {
    const exploding = { parse: () => { throw new TypeError('boom') } } as never
    const pipe = new ZodValidationPipe(exploding)
    expect(() => pipe.transform({}, meta)).toThrow(TypeError)
  })
})
