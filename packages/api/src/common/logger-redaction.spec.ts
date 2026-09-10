import { Writable } from 'node:stream'
import express from 'express'
import pinoHttp from 'pino-http'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { buildApiLoggerOptions } from './logger-options'

/**
 * 凭证不进日志。
 *
 * 只断言 buildApiLoggerOptions 的返回值等于某几个字符串是不够的——
 * 真正要证明的是 pino-http 的默认 req 序列化器被脱敏规则盖住了。
 * 所以这里起一条真实的中间件链路，让它按实际路径把日志写出来。
 */
function collectLines() {
  const lines: string[] = []
  let notify: (() => void) | undefined
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk).trim())
      notify?.()
      cb()
    },
  })
  return {
    stream,
    lines,
    /** 等到出现匹配行；超时即失败，不静默通过 */
    async waitFor(pattern: RegExp, timeoutMs = 2_000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = lines.find((line) => pattern.test(line))
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`等待日志超时。已收到：\n${lines.join('\n')}`)
        }
        await new Promise<void>((resolve) => {
          notify = resolve
          setTimeout(resolve, 25)
        })
      }
    },
  }
}

async function requestThroughLogger(headers: Record<string, string>) {
  const collector = collectLines()
  const httpLogger = pinoHttp(
    buildApiLoggerOptions({ service: 'cairn-api', level: 'info' }),
    collector.stream,
  )

  const app = express()
  app.use(httpLogger)
  app.get('/probe', (_req, res) => {
    res.json({ ok: true })
  })

  let call = request(app).get('/probe')
  for (const [name, value] of Object.entries(headers)) call = call.set(name, value)
  await call.expect(200)

  return collector
}

describe('请求日志的凭证脱敏与字段语义', () => {
  it('authorization 与 cookie 落盘即 [redacted]，不含可重放的令牌', async () => {
    const collector = await requestThroughLogger({
      authorization: 'Bearer secret-replayable-token',
      cookie: 'cairn_session=secret-session-value',
    })

    const line = await collector.waitFor(/request completed/)

    expect(line).toContain('[redacted]')
    expect(line).not.toContain('secret-replayable-token')
    expect(line).not.toContain('secret-session-value')
  })

  it('日志字段是 requestId，不是 runId 冒充', async () => {
    const collector = await requestThroughLogger({ 'x-cairn-request-id': 'req-log-1' })

    const line = await collector.waitFor(/request completed/)

    expect(JSON.parse(line)).toMatchObject({ requestId: 'req-log-1' })
    expect(JSON.parse(line)).not.toHaveProperty('runId')
  })

  it('网关的 x-request-id 也能被日志采用', async () => {
    const collector = await requestThroughLogger({ 'x-request-id': 'gw-log-1' })

    const line = await collector.waitFor(/request completed/)

    expect(JSON.parse(line)).toMatchObject({ requestId: 'gw-log-1' })
  })

  it('响应里的 set-cookie 同样被脱敏——会话令牌不能从响应侧漏出去', async () => {
    const collector = collectLines()
    const httpLogger = pinoHttp(
      buildApiLoggerOptions({ service: 'cairn-api', level: 'info' }),
      collector.stream,
    )
    const app = express()
    app.use(httpLogger)
    app.get('/session', (_req, res) => {
      res.setHeader('set-cookie', 'cairn_session=secret-response-token; HttpOnly')
      res.json({ ok: true })
    })

    await request(app).get('/session').expect(200)
    const line = await collector.waitFor(/request completed/)

    expect(line).toContain('[redacted]')
    expect(line).not.toContain('secret-response-token')
  })
})
