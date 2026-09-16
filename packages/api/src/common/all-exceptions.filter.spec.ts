import { ConflictException, type ArgumentsHost } from '@nestjs/common'
import { expect, it, vi } from 'vitest'
import { AllExceptionsFilter } from './all-exceptions.filter'

function fixture(flags: Record<string, boolean> = {}) {
  const response = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    ...flags,
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  }
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId: 'stream-test', originalUrl: '/frames' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost
  return { response, host }
}

it('SSE 已发送响应头后只关闭流，不追加 JSON 错误体', () => {
  const { response, host } = fixture({ headersSent: true })
  new AllExceptionsFilter().catch(new Error('upstream disconnected'), host)
  expect(response.end).toHaveBeenCalledOnce()
  expect(response.status).not.toHaveBeenCalled()
  expect(response.json).not.toHaveBeenCalled()
})

it.each(['destroyed', 'writableEnded'])('已 %s 的响应不再次写入', (flag) => {
  const { response, host } = fixture({ [flag]: true })
  new AllExceptionsFilter().catch(new Error('aborted'), host)
  expect(response.end).not.toHaveBeenCalled()
  expect(response.json).not.toHaveBeenCalled()
})

it('尚未发送响应头时保留领域错误契约', () => {
  const { response, host } = fixture()
  new AllExceptionsFilter().catch(
    new ConflictException({
      code: 'AUTH_CONTROL_INVALID',
      message: '控制权已失效',
    }),
    host,
  )
  expect(response.status).toHaveBeenCalledWith(409)
  expect(response.json).toHaveBeenCalledWith({
    code: 'AUTH_CONTROL_INVALID',
    message: '控制权已失效',
    requestId: 'stream-test',
  })
})
