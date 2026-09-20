import { describe, expect, it } from 'vitest'
import {
  aggregateSuiteVerdict,
  assertPublishedSuiteDocument,
  mergeSuiteMemberInput,
  resolveSuiteMemberAccountId,
  substituteReportTitle,
  sanitizeReportFileName,
  contentDispositionAttachment,
  reportConfigOverrideSchema,
} from '../index.js'

describe('场景集规则', () => {
  it('输入按公共、成员、本次覆盖浅合并', () => {
    expect(
      mergeSuiteMemberInput({
        sharedInput: { a: 1, b: 2 },
        memberInput: { b: 3, c: 4 },
        runOverride: { c: 5 },
      }),
    ).toEqual({ a: 1, b: 3, c: 5 })
  })

  it('账号按本次成员、成员配置、本次默认、集合默认解析', () => {
    expect(
      resolveSuiteMemberAccountId({
        runMemberAccountId: 'r',
        memberAccountId: 'm',
        runDefaultAccountId: 'rd',
        suiteDefaultAccountId: 'sd',
      }),
    ).toBe('r')
    expect(resolveSuiteMemberAccountId({ suiteDefaultAccountId: 'sd' })).toBe('sd')
  })

  it('有业务 FAIL 即发现异常；编排结束不等于全部通过', () => {
    expect(
      aggregateSuiteVerdict([
        { admission: 'SETTLED', runStatus: 'SUCCEEDED', outcomeStatus: 'FAIL' },
        { admission: 'SETTLED', runStatus: 'SUCCEEDED', outcomeStatus: 'PASS' },
      ]),
    ).toBe('anomalies_found')
    expect(
      aggregateSuiteVerdict([
        { admission: 'SETTLED', runStatus: 'FAILED', outcomeStatus: 'NOT_EVALUATED' },
        { admission: 'SKIPPED' },
      ]),
    ).toBe('incomplete')
    expect(
      aggregateSuiteVerdict([
        { admission: 'SETTLED', runStatus: 'SUCCEEDED', outcomeStatus: 'PASS' },
        { admission: 'SETTLED', runStatus: 'SUCCEEDED', outcomeStatus: 'WARN' },
      ]),
    ).toBe('pass_with_warnings')
    expect(
      aggregateSuiteVerdict([{ admission: 'SETTLED', runStatus: 'SUCCEEDED', outcomeStatus: 'PASS' }]),
    ).toBe('all_pass')
  })

  it('空集合不能发布', () => {
    expect(assertPublishedSuiteDocument({ schemaVersion: 1, groups: [], members: [], sharedInput: {}, failurePolicy: 'continue', autoGenerateFinalReport: false })).toEqual([
      expect.objectContaining({ code: 'SUITE_EMPTY' }),
    ])
  })

  it('支持自动报告及总、子报告默认配置，引用有效性由领域层校验', () => {
    const issues = assertPublishedSuiteDocument({ schemaVersion: 1, groups: [], members: [{ memberId: 'one', ordinal: 0, scenarioId: 'scenario', scenarioVersionId: 'version', input: {}, reportProfileId: 'member-profile' }], sharedInput: {}, failurePolicy: 'continue', autoGenerateFinalReport: true, reportProfileId: 'profile' })
    expect(issues).toEqual([])
  })
})

describe('报告标题', () => {
  it('只覆盖标题不会注入默认时区、详略和选图范围', () => {
    expect(reportConfigOverrideSchema.parse({ title: '本次标题' })).toEqual({ title: '本次标题' })
  })
  it('替换已知变量并拒绝未知变量与危险文件名', () => {
    expect(substituteReportTitle('{systemName} {executedDate} 运行报告', { systemName: '商城', executedDate: '2026-09-19' })).toBe(
      '商城 2026-09-19 运行报告',
    )
    expect(() => substituteReportTitle('{secret}', {})).toThrow(/未知标题变量/)
    expect(() => substituteReportTitle('{secret_1}', {})).toThrow(/未知标题变量/)
    expect(sanitizeReportFileName('a/b:c*.docx')).toBe('a_b_c_.docx')
    expect(contentDispositionAttachment('gin web脚手架 报告.docx')).toBe(
      `attachment; filename="report.docx"; filename*=UTF-8''${encodeURIComponent('gin web脚手架 报告.docx')}`,
    )
    expect(contentDispositionAttachment('report.pdf')).toBe(
      'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf',
    )
    const longName = `${'长'.repeat(100)}.docx`
    expect(contentDispositionAttachment(longName)).toContain('filename="report.docx"')
    expect(decodeURIComponent(contentDispositionAttachment(longName).split("UTF-8''")[1]!)).toBe(`${'长'.repeat(75)}.docx`)
    expect(sanitizeReportFileName(`${'a'.repeat(79)}😀`)).toBe(`${'a'.repeat(79)}😀`)
    expect(decodeURIComponent(contentDispositionAttachment(`${'😀'.repeat(100)}.pdf`).split("UTF-8''")[1]!)).toBe(`${'😀'.repeat(76)}.pdf`)
    expect(contentDispositionAttachment("巡检 (O'Brien).pdf")).toContain('%28O%27Brien%29.pdf')
  })
})
