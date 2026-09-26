import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import type { ObjectStore } from '@cairn/storage'
import { cleanupReportWorkspaces, copyBoundedObject, renderReportHtml, writeReportZip } from './report-render'
import { crc32 } from './report-layout'
import { reportLines } from './report-content'

const document = {
  stage: 'final' as const,
  title: '商城 2026-09-19 运行报告',
  timeZone: 'Asia/Shanghai',
  generatedAt: '2026-09-19T12:00:00.000Z',
  asOf: '2026-09-19T12:00:00.000Z',
  source: {
    kind: 'RUN',
    status: 'SUCCEEDED',
    targetName: '商城',
    scenarioName: '订单巡检',
    outcomeStatus: 'FAIL',
    evidenceStatus: 'INCOMPLETE',
    stepRuns: [{ name: '订单金额检查', status: 'SUCCEEDED', outcomeStatus: 'FAIL', attempts: [{ id: 'attempt-1', status: 'SUCCEEDED' }] }],
  },
  summary: { status: 'SUCCEEDED' },
  sections: [{ id: 'overview', title: '概述', required: true, blocks: [{ type: 'summary', data: { ok: true } }] }],
  gaps: ['证据仍在收集'],
}

describe('报告渲染与交付（自包含 HTML 双模板）', () => {
  it('单场景模板：渲染完整的自包含 HTML，包含步骤流水、断言判定与打印样式，无外部网络依赖', async () => {
    const body = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#153658' } }).jpeg().toBuffer()
    const images = [
      { id: 'screen', body, width: 80, height: 40, kind: 'screenshot' as const, caption: '订单金额检查截图' },
      { id: 'logo', body, width: 80, height: 40, kind: 'logo' as const, caption: '组织标识' },
    ]

    const html = renderReportHtml(document, images)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('商城 2026-09-19 运行报告')
    expect(html).toContain('订单金额检查')
    expect(html).toContain('执行成功')
    expect(html).toContain('异常')
    expect(html).toContain('data:image/jpeg;base64,')
    expect(html).toContain('@media print')
    expect(html).toContain('openLightbox')
    expect(html).toContain('filterItems')
    expect(html).toContain('缺项说明')

    // 零外部资源依赖（自包含断言）
    expect(html).not.toMatch(/src=["']https?:\/\//)
    expect(html).not.toMatch(/href=["']https?:\/\//)
  })

  it('场景集巡检模板：正确呈现 0-100 健康分大卡、并发节约率、跨模块对照大表与聚合异常', async () => {
    const suiteDocument = {
      ...document,
      title: '核心业务晨检 2026-09-26 巡检报告',
      source: {
        kind: 'SUITE_RUN',
        status: 'COMPLETED',
        verdict: 'anomalies_found',
        targetName: '核心中台',
        suiteName: '业务晨检',
        items: [
          { memberId: 'm1', ordinal: 0, displayName: '登录认证', admission: 'SETTLED', runStatus: 'SUCCEEDED', outcomeStatus: 'PASS', childRunId: 'run-1' },
          { memberId: 'm2', ordinal: 1, displayName: '支付结算', admission: 'SETTLED', runStatus: 'FAILED', outcomeStatus: 'FAIL', childRunId: 'run-2' },
        ],
      },
      sections: [
        {
          id: 'summary',
          title: '汇总',
          required: true,
          blocks: [
            {
              type: 'suite_business_summary',
              healthScore: 92,
              healthGrade: 'EXCELLENT',
              totalCount: 10,
              normalCount: 9,
              warningCount: 0,
              anomalousCount: 1,
              skippedCount: 0,
              wallClockMs: 25000,
              childDurationMs: 80000,
              savedPercent: 68,
              gridRows: [
                {
                  ordinal: 0,
                  memberId: 'm1',
                  displayName: '用户登录',
                  scenarioName: '登录认证',
                  status: 'NORMAL',
                  summary: '成功登录中台',
                  metrics: { token_valid: true },
                  dataRow: { user_id: '1001' },
                  durationMs: 3200,
                  hasFindings: false,
                },
                {
                  ordinal: 1,
                  memberId: 'm2',
                  displayName: '支付网关',
                  scenarioName: '支付结算',
                  status: 'ANOMALOUS',
                  summary: '网关超时',
                  metrics: { timeout: true },
                  dataRow: { gateway: 'wxpay' },
                  durationMs: 12000,
                  hasFindings: true,
                },
              ],
              aggregatedFindings: [
                {
                  memberId: 'm2',
                  displayName: '支付结算',
                  title: '支付通道超时未响应',
                  severity: 'HIGH',
                  detail: '超过 10 秒无 ACK',
                  evidenceId: 'ev-pay-err',
                },
              ],
            },
          ],
        },
      ],
      gaps: [],
    }

    const html = renderReportHtml(suiteDocument)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('场景集巡检总报告')
    expect(html).toContain('92')
    expect(html).toContain('优 (EXCELLENT)')
    expect(html).toContain('68%')
    expect(html).toContain('核心业务巡检对照总表')
    expect(html).toContain('跨场景聚合核心异常')
    expect(html).toContain('支付通道超时未响应')
    expect(html).toContain('ev-pay-err')
    expect(html).not.toMatch(/src=["']https?:\/\//)
  })

  it('关闭可选章节与成功详情仍保留异常、未知及重试失败事实，成员按冻结分组展示', () => {
    const run = {
      ...document.source,
      evidence: [{ evidenceId: 'index-only', type: 'trace', status: 'available' }],
      stepRuns: [
        { name: '通过步骤', status: 'SUCCEEDED', outcomeStatus: 'PASS', attempts: [{ id: 'success-only', status: 'SUCCEEDED' }] },
        { name: '失败后成功', status: 'SUCCEEDED', outcomeStatus: 'PASS', attempts: [{ id: 'retry-failed', status: 'FAILED', error: { code: 'CHECK_FAILED', message: '首次检查失败' } }, { id: 'retried', status: 'SUCCEEDED' }] },
        { name: '未知步骤', status: 'SUCCEEDED', outcomeStatus: 'UNKNOWN', attempts: [] },
        { name: '告警步骤', status: 'SUCCEEDED', outcomeStatus: 'WARN', attempts: [] },
      ],
    }
    const compact = {
      ...document,
      source: run,
      sections: [
        {
          id: 'result',
          title: '结果',
          required: true,
          blocks: [
            {
              type: 'result',
              detailLevel: 'summary',
              includeSuccessDetails: false,
              includeEvidenceIndex: false,
              includeAttemptHistory: false,
            },
          ],
        },
      ],
    }
    const lines = reportLines(compact).map((line) => line.text).join('\n')
    expect(lines).not.toContain('index-only')
    expect(lines).not.toContain('success-only')
    expect(lines).toContain('首次检查失败')
    expect(lines).toContain('未知步骤')
    expect(lines).toContain('告警步骤')
    expect(lines).toContain('证据仍在收集')
  })

  it('流式取材按实际大小限流、校验摘要，拒绝超限和损坏对象', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'report-copy-test-'))
    const body = Buffer.alloc(2 * 1024 * 1024 + 9, 65), requests: number[] = []
    const store = {
      get: async (_key: string, range: { start: number; end: number }) => {
        requests.push(range.end - range.start + 1)
        return {
          body: body.subarray(range.start, range.end + 1),
          head: { byteSize: null },
          range: { start: range.start, end: Math.min(range.end, body.length - 1), size: body.length },
        }
      },
    } as unknown as ObjectStore
    const signal = new AbortController().signal
    try {
      const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
      const copied = await copyBoundedObject(store, 'source', join(directory, 'valid'), body.length, signal, digest)
      expect(copied).toEqual({ byteSize: body.length, digest })
      expect(Math.max(...requests)).toBeLessThanOrEqual(1024 * 1024)
      await expect(copyBoundedObject(store, 'source', join(directory, 'large'), 1024, signal)).rejects.toThrow('上限')
      await expect(copyBoundedObject(store, 'source', join(directory, 'broken'), body.length, signal, 'sha256:wrong')).rejects.toThrow('摘要不一致')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('ZIP 中文文件名与 CRC 正确，清理崩溃残留时保留活跃工作目录', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'report-zip-test-'))
    try {
      const body = Buffer.from('中文报告材料')
      const source = join(directory, 'source')
      await writeFile(source, body)
      const path = join(directory, 'reports.zip')
      await writeReportZip(path, [{ name: '总报告/巡检.html', path: source }], new AbortController().signal)
      const zipped = await readFile(path)
      expect(zipped.readUInt32LE(14)).toBe(crc32(body))
      expect(zipped.subarray(30, 30 + zipped.readUInt16LE(26)).toString()).toBe('总报告/巡检.html')
      const stale = join(directory, 'cairn-report-old001')
      const active = join(directory, 'cairn-report-new001')
      await mkdir(stale)
      await mkdir(active)
      await utimes(stale, new Date(0), new Date(0))
      expect(await cleanupReportWorkspaces(directory)).toBe(1)
      expect((await stat(active)).isDirectory()).toBe(true)
      await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
