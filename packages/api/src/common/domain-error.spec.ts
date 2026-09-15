import { ForbiddenException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { classifyAccountRecheck } from './domain-error'

describe('classifyAccountRecheck', () => {
  it('只有明确的身份失败才是 UNAUTHORIZED', () => {
    expect(classifyAccountRecheck(new NotFoundException('账号不存在'))).toBe('UNAUTHORIZED')
    expect(classifyAccountRecheck(new UnauthorizedException('登录已过期或无效'))).toBe('UNAUTHORIZED')
  })

  it('权限失败是 FORBIDDEN，基础设施失败是 INTERNAL', () => {
    expect(classifyAccountRecheck(new ForbiddenException('没有运行读取权限'))).toBe('FORBIDDEN')
    expect(classifyAccountRecheck(new ServiceUnavailableException())).toBe('INTERNAL')
    expect(classifyAccountRecheck(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(
      'INTERNAL',
    )
  })
})
