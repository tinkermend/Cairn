import { Controller, INestApplication, Post, Body } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenForSupertest } from '../__tests__/http-app'
import { configureBodyParsers, isManagedBrowserWritePath } from './body-parsers'

@Controller('runs')
class ProbeController {
  @Post()
  create(@Body() body: unknown) {
    return { size: Buffer.byteLength(JSON.stringify(body ?? {})) }
  }

  @Post(':runId/browser/auth-control/input')
  input(@Body() body: unknown) {
    return { size: Buffer.byteLength(JSON.stringify(body ?? {})) }
  }

  @Post(':runId/resume-auth')
  resume(@Body() body: unknown) {
    return { size: Buffer.byteLength(JSON.stringify(body ?? {})) }
  }
}

describe('请求体上限', () => {
  let app: INestApplication
  const runId = '66666666-6666-4666-8666-666666666666'

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    configureBodyParsers(app)
    app.setGlobalPrefix('api')
    await listenForSupertest(app)
  })

  afterAll(async () => {
    await app.close()
  })

  it('识别受管浏览器与续跑路径，不误伤普通创建 Run', () => {
    expect(isManagedBrowserWritePath(`/api/runs/${runId}/browser/auth-control/input`)).toBe(true)
    expect(isManagedBrowserWritePath(`/api/runs/${runId}/resume-auth`)).toBe(true)
    expect(isManagedBrowserWritePath(`/runs/${runId}/browser`)).toBe(true)
    expect(isManagedBrowserWritePath('/api/runs')).toBe(false)
    expect(isManagedBrowserWritePath(`/api/runs/${runId}/cancel`)).toBe(false)
  })

  it('浏览器输入与续跑超过 64 KiB 拒绝，普通 Run 创建仍可用 1 MiB', async () => {
    const over = { pad: 'a'.repeat(70 * 1024) }
    await request(app.getHttpServer())
      .post(`/api/runs/${runId}/browser/auth-control/input`)
      .send(over)
      .expect(413)
    await request(app.getHttpServer()).post(`/api/runs/${runId}/resume-auth`).send(over).expect(413)
    const created = await request(app.getHttpServer()).post('/api/runs').send(over).expect(201)
    expect(created.body.size).toBeGreaterThan(65536)
  })
})
