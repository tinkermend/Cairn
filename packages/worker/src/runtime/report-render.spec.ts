import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import type { ObjectStore } from '@cairn/storage'
import { cleanupReportWorkspaces, copyBoundedObject, renderReportDocx, renderReportPdf, writeReportZip } from './report-render'
import { crc32 } from './report-layout'
import { reportLines } from './report-content'

const document = {
  stage: 'final' as const,
  title: '商城 2026-09-19 运行报告',
  timeZone: 'Asia/Shanghai',
  generatedAt: '2026-09-19T12:00:00.000Z',
  asOf: '2026-09-19T12:00:00.000Z',
  source: { kind: 'RUN', status: 'SUCCEEDED', targetName: '商城', scenarioName: '订单巡检', outcomeStatus: 'FAIL', evidenceStatus: 'INCOMPLETE',
    stepRuns: [{ name: '订单金额检查', status: 'SUCCEEDED', outcomeStatus: 'FAIL', attempts: [{ id: 'attempt-1', status: 'SUCCEEDED' }] }] },
  summary: { status: 'SUCCEEDED' },
  sections: [{ id: 'overview', title: '概述', required: true, blocks: [{ type: 'summary', data: { ok: true } }] }],
  gaps: ['证据仍在收集'],
}

describe('报告渲染', () => {
  it('Word 正文包含巡检结论和成员结果，PDF 嵌入中文字体', async () => {
    const docx = renderReportDocx(document)
    expect(docx.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004')
    expect(docx.toString('utf8')).toContain('商城 2026-09-19 运行报告')
    expect(docx.toString('utf8')).toContain('缺项')
    expect(docx.toString('utf8')).toContain('word/fonts/NotoSansCJKsc-Regular.odttf')
    expect(docx.toString('utf8')).toContain('订单金额检查：执行成功；业务结果：异常')
    expect(docx.toString('utf8')).not.toContain('"type":"summary"')
    expect(reportLines(document).some((line) => line.text.includes('业务结论：异常'))).toBe(true)

    const pdf = await renderReportPdf(document)
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-')
    expect(pdf.toString('latin1')).toMatch(/\/FontFile[23]/)
    expect(pdf.toString('latin1')).toContain('/ToUnicode')
  })

  it('长集合报告分页且末尾成员、跳过原因和缺项都进入统一正文', async () => {
    const suite = { ...document, source: { kind: 'SUITE_RUN', status: 'COMPLETED', verdict: 'anomalies_found', groups: [{ id: 'orders', name: '订单检查' }], counts: { planned: 50, succeeded: 49, skipped: 1 },
      items: Array.from({ length: 50 }, (_, ordinal) => ({ memberId: `member-${ordinal}`, ordinal, displayName: `成员 ${ordinal + 1}`, admission: ordinal === 49 ? 'SKIPPED' : 'SETTLED', runStatus: ordinal === 49 ? 'CANCELLED' : 'SUCCEEDED', outcomeStatus: 'PASS', childRunId: `run-${ordinal}`, scenarioVersionId: `version-${ordinal}`, skipReason: ordinal === 49 ? 'failure_policy_stop' : null })),
    } }
    const lines = reportLines(suite)
    expect(lines.some((line) => line.text.includes('成员 50'))).toBe(true)
    expect(lines.some((line) => line.text === '分组：未分组')).toBe(true)
    expect(lines.some((line) => line.text.includes('跳过原因：按失败策略停止'))).toBe(true)
    const pdf = await renderReportPdf(suite)
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1)
  })

  it('两种格式对超大正文都明确拒绝，不无限分配渲染内存', async () => {
    const oversized = { ...document, gaps: ['长'.repeat(4 * 1024 * 1024)] }
    expect(() => renderReportDocx(oversized)).toThrow('报告内容超过渲染上限')
    await expect(renderReportPdf(oversized)).rejects.toThrow('报告内容超过渲染上限')
  })

  it('关闭可选章节与成功详情仍保留异常、未知及重试失败事实，成员按冻结分组展示', () => {
    const run = { ...document.source, evidence: [{ evidenceId: 'index-only', type: 'trace', status: 'available' }], stepRuns: [
      { name: '通过步骤', status: 'SUCCEEDED', outcomeStatus: 'PASS', attempts: [{ id: 'success-only', status: 'SUCCEEDED' }] },
      { name: '失败后成功', status: 'SUCCEEDED', outcomeStatus: 'PASS', attempts: [{ id: 'retry-failed', status: 'FAILED', error: { code: 'CHECK_FAILED', message: '首次检查失败' } }, { id: 'retried', status: 'SUCCEEDED' }] },
      { name: '未知步骤', status: 'SUCCEEDED', outcomeStatus: 'UNKNOWN', attempts: [] },
      { name: '告警步骤', status: 'SUCCEEDED', outcomeStatus: 'WARN', attempts: [] },
    ] }
    const compact = { ...document, source: run, sections: [{ id: 'result', title: '结果', required: true, blocks: [{ type: 'result', detailLevel: 'summary', includeSuccessDetails: false, includeEvidenceIndex: false, includeAttemptHistory: false }] }] }
    const lines = reportLines(compact).map((line) => line.text).join('\n')
    expect(lines).not.toContain('index-only'); expect(lines).not.toContain('success-only')
    expect(lines).toContain('首次检查失败'); expect(lines).toContain('未知步骤'); expect(lines).toContain('告警步骤'); expect(lines).toContain('证据仍在收集')
    const grouped = reportLines({ ...compact, source: { kind: 'SUITE_RUN', groups: [{ id: 'b', name: '第二组' }, { id: 'a', name: '第一组' }], items: [{ memberId: 'm1', groupId: 'a', displayName: '检查甲', ordinal: 0, run }, { memberId: 'm2', groupId: 'b', displayName: '检查乙', ordinal: 1, run }] } }).map((line) => line.text).join('\n')
    expect(grouped.indexOf('分组：第二组')).toBeLessThan(grouped.indexOf('检查乙'))
    expect(grouped.indexOf('检查乙')).toBeLessThan(grouped.indexOf('分组：第一组'))
    expect(grouped).toContain('1. 检查甲'); expect(grouped).toContain('2. 检查乙')
    const unevaluated = reportLines({ ...compact, source: { kind: 'SUITE_RUN', status: 'COMPLETED', verdict: 'incomplete', items: [] } }).map((line) => line.text).join('\n')
    expect(unevaluated).toContain('执行状态：已完成；业务结论：结论不完整')
    expect(unevaluated).not.toContain('未完整执行')
  })

  it('Logo 放在封面，截图和可编辑表格保留独立引用', async () => {
    const body = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#153658' } }).jpeg().toBuffer()
    const images = [{ id: 'screen', body, width: 80, height: 40, kind: 'screenshot' as const, caption: '检查截图' }, { id: 'logo', body, width: 80, height: 40, kind: 'logo' as const, caption: '组织标识' }]
    const xml = renderReportDocx(document, images).toString('utf8')
    expect(xml.indexOf('r:embed="img1"')).toBeLessThan(xml.indexOf(document.title))
    expect(xml.indexOf('r:embed="img0"')).toBeGreaterThan(xml.indexOf('<w:tbl>'))
    const pdf = await renderReportPdf(document, images)
    expect((pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? [])).toHaveLength(2)
  })

  it('流式取材按实际大小限流、校验摘要，拒绝超限和损坏对象', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'report-copy-test-'))
    const body = Buffer.alloc(2 * 1024 * 1024 + 9, 65), requests: number[] = []
    const store = { get: async (_key: string, range: { start: number; end: number }) => {
      requests.push(range.end - range.start + 1)
      return { body: body.subarray(range.start, range.end + 1), head: { byteSize: null }, range: { start: range.start, end: Math.min(range.end, body.length - 1), size: body.length } }
    } } as unknown as ObjectStore
    const signal = new AbortController().signal
    try {
      const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
      const copied = await copyBoundedObject(store, 'source', join(directory, 'valid'), body.length, signal, digest)
      expect(copied).toEqual({ byteSize: body.length, digest }); expect(Math.max(...requests)).toBeLessThanOrEqual(1024 * 1024)
      await expect(copyBoundedObject(store, 'source', join(directory, 'large'), 1024, signal)).rejects.toThrow('上限')
      await expect(copyBoundedObject(store, 'source', join(directory, 'broken'), body.length, signal, 'sha256:wrong')).rejects.toThrow('摘要不一致')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('ZIP 中文文件名与 CRC 正确，清理崩溃残留时保留活跃工作目录', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'report-zip-test-'))
    try {
      const body = Buffer.from('中文报告材料'), source = join(directory, 'source')
      await writeFile(source, body)
      const path = join(directory, 'reports.zip')
      await writeReportZip(path, [{ name: '总报告/巡检.pdf', path: source }], new AbortController().signal)
      const zipped = await readFile(path)
      expect(zipped.readUInt32LE(14)).toBe(crc32(body)); expect(zipped.subarray(30, 30 + zipped.readUInt16LE(26)).toString()).toBe('总报告/巡检.pdf')
      const stale = join(directory, 'cairn-report-old001'), active = join(directory, 'cairn-report-new001')
      await mkdir(stale); await mkdir(active); await utimes(stale, new Date(0), new Date(0))
      expect(await cleanupReportWorkspaces(directory)).toBe(1)
      expect((await stat(active)).isDirectory()).toBe(true); await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
