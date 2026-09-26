import { describe, expect, it } from 'vitest'
import { parseReportTitle, renderReportTitleV2, reportTitleSources } from '../report-title-template.js'
import { createReportBodySchema, reportConfigTitleSources, substituteReportTitle } from '../reports.js'

describe('report title template v2', () => {
  it('recognizes variables and source scope with UTF-16 offsets', () => {
    const title = '报告😀 {scenarioName} 完成'
    const variable = parseReportTitle(title, 'RUN').find((part) => part.kind === 'variable')!
    expect(title.slice(variable.start, variable.end)).toBe('{scenarioName}')
    expect(reportTitleSources(title)).toEqual(['RUN'])
    expect(parseReportTitle(title, 'SUITE_RUN').find((part) => part.kind === 'unavailable')?.key).toBe('scenarioName')
    expect(reportTitleSources('{scenarioName} {suiteName}')).toEqual([])
  })

  it('reports malformed braces and unknown names', () => {
    for (const title of ['{}', '{oops}', '{systemName', '{{systemName}}', '多余}', '{systemName}}']) {
      expect(parseReportTitle(title).some((part) => part.message)).toBe(true)
      expect(() => renderReportTitleV2(title, {}, 'RUN')).toThrow()
    }
  })

  it('renders escaped literal braces and keeps unavailable values explicit', () => {
    expect(renderReportTitleV2('\\{固定\\} {systemName}', { systemName: '业务系统' }, 'RUN')).toBe('{固定} 业务系统')
    expect(renderReportTitleV2('{systemName}', {}, 'RUN')).toBe('{systemName}')
  })

  it('保留旧版标题的原有替换结果', () => {
    expect(substituteReportTitle('{{systemName}}', { systemName: '业务系统' })).toBe('{业务系统}')
    expect(substituteReportTitle('{}', {})).toBe('{}')
    expect(reportConfigTitleSources({ title: '{{systemName}}', timeZone: 'Asia/Shanghai', detailLevel: 'detailed', screenshotScope: 'anomalies', includeSuccessDetails: true, includeEvidenceIndex: true, includeAttemptHistory: true })).toEqual(['RUN', 'SUITE_RUN'])
  })

  it('客户端报告覆盖不能指定或降级标题语法版本', () => {
    const body = { subject: { kind: 'RUN', runId: '11111111-1111-4111-8111-111111111111' }, scope: 'run', stage: 'final', config: { titleSyntaxVersion: 2 }, idempotencyKey: 'key' }
    expect(createReportBodySchema.safeParse(body).success).toBe(false)
  })
})
