import { INestApplication } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { signReportToken } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { listenForSupertest } from '../__tests__/http-app'
import { PublicReportsController } from './public-reports.controller'
import { ReportsService } from './reports.service'

const suiteRunId = '11111111-1111-4111-8111-111111111111'
const testSecret = 'cairn-test-jwt-secret-at-least-16-chars'

describe('PublicReportsController HTTP 契约 (AC05)', () => {
  let app: INestApplication
  const mockService = {
    getPublicReportView: vi.fn(async (token: string) => {
      // Basic verification simulating service logic
      if (!token || token === 'invalid-token' || token.endsWith('tampered')) {
        const { ForbiddenException } = await import('@nestjs/common')
        throw new ForbiddenException({ code: 'REPORT_TOKEN_INVALID', message: '无效或已过期的报告访问令牌' })
      }
      return {
        report: { id: 'rep-01', subject: { kind: 'SUITE_RUN', suiteRunId } },
        revision: { id: 'rev-01' },
        document: { title: '巡检总报告' },
        tokenPayload: { suiteRunId, exp: Math.floor(Date.now() / 1000) + 3600 },
      }
    }),
  }

  beforeAll(async () => {
    process.env['CAIRN_JWT_SECRET'] = testSecret
    const module = await Test.createTestingModule({
      controllers: [PublicReportsController],
      providers: [
        { provide: ReportsService, useValue: mockService },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()

    app = module.createNestApplication()
    await listenForSupertest(app)
  })

  afterAll(async () => {
    await app.close()
  })

  it('有效签名 Token 可免登录正常访问报告只读视图', async () => {
    const validToken = await signReportToken(
      {
        suiteRunId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'readonly_report',
      },
      testSecret,
    )

    const res = await request(app.getHttpServer())
      .get(`/public/reports/view?token=${validToken}`)
      .expect(200)

    expect(res.body.report.id).toBe('rep-01')
    expect(res.body.document.title).toBe('巡检总报告')
    expect(mockService.getPublicReportView).toHaveBeenCalledWith(validToken)
  })

  it('篡改或无效 Token 返回 403 明确拒绝', async () => {
    await request(app.getHttpServer())
      .get('/public/reports/view?token=invalid-token')
      .expect(403)

    const validToken = await signReportToken(
      {
        suiteRunId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        scope: 'readonly_report',
      },
      testSecret,
    )

    await request(app.getHttpServer())
      .get(`/public/reports/view?token=${validToken}.tampered`)
      .expect(403)
  })
})
