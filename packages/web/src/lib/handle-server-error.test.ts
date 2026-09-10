import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from './api-client'
import { handleServerError } from './handle-server-error'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
  },
}))

function apiError(status: number, message: string, code = 'REQUEST_FAILED') {
  return new ApiRequestError(status, { code, message, requestId: 'req-1' })
}

beforeEach(() => {
  vi.mocked(toastError).mockClear()
})

describe('handleServerError', () => {
  it('shows a generic message when the error is not recognised', () => {
    handleServerError(new Error('network'))

    expect(toastError).toHaveBeenCalledWith('Something went wrong!')
  })

  it('maps a plain object with status 204 to the no-content message', () => {
    handleServerError({ status: 204 })

    expect(toastError).toHaveBeenCalledWith('No content.')
  })

  it('shows the server message carried by ApiRequestError', () => {
    handleServerError(apiError(422, '工作流未绑定 Target', 'SCENARIO_NOT_BOUND'))

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('工作流未绑定 Target'))
  })

  it('appends the requestId in development so the toast can be traced to server logs', () => {
    handleServerError(apiError(500, '服务器内部错误', 'INTERNAL_ERROR'))

    expect(toastError).toHaveBeenCalledWith('服务器内部错误（req-1）')
  })

  it('hides the requestId in production', () => {
    vi.stubEnv('DEV', false)

    handleServerError(apiError(500, '服务器内部错误', 'INTERNAL_ERROR'))

    expect(toastError).toHaveBeenCalledWith('服务器内部错误')
  })

  it('logs the error to the console in development', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = new Error('logged')

    handleServerError(err)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(err)

    log.mockRestore()
  })

  it('does not log the error to the console in production', () => {
    vi.stubEnv('DEV', false)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = new Error('not logged')

    handleServerError(err)

    expect(log).not.toHaveBeenCalled()

    log.mockRestore()
  })
})
