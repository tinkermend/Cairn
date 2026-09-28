import { describe, expect, it } from 'vitest'
import {
  TARGET_CONFIG_FORM_FIELDS,
  targetConfigFieldHelp,
  targetConfigFieldValueLabel,
  targetConfigFormFieldSchemas,
  targetFormProposalSchema,
  validateTargetFormProposalChange,
  sanitizeProposalChanges,
} from '../assistant-form.js'
import { createTargetBodySchema, updateTargetBodySchema } from '../target.js'

describe('target config assistant form contract', () => {
  it('generates UI validators from exactly the code-defined fields', () => {
    expect(Object.keys(targetConfigFormFieldSchemas)).toEqual(
      TARGET_CONFIG_FORM_FIELDS.map((field) => field.id)
    )
    expect(
      TARGET_CONFIG_FORM_FIELDS.every((field) => field.help.length > 0)
    ).toBe(true)
  })

  it('shares create/update constraints for core API fields and handles optional defaults', () => {
    const base = {
      code: 'target-a',
      name: '目标 A',
      entryUrl: 'https://example.com',
    }
    expect(createTargetBodySchema.safeParse(base).success).toBe(true)
    for (const fieldId of ['code', 'name', 'entryUrl'] as const) {
      expect(
        validateTargetFormProposalChange(
          { fieldId, value: base[fieldId] },
          'create'
        )
      ).toBeNull()
    }
    expect(updateTargetBodySchema.safeParse({ name: '目标 B' }).success).toBe(
      true
    )
    expect(
      validateTargetFormProposalChange(
        { fieldId: 'code', value: 'target-b' },
        'edit'
      )
    ).toContain('不可修改')
    expect(
      validateTargetFormProposalChange(
        { fieldId: 'loginLeaveTimeoutSeconds', value: '' },
        'create'
      )
    ).toBeNull()
    expect(
      validateTargetFormProposalChange(
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
        'create'
      )
    ).toBeNull()
    expect(
      validateTargetFormProposalChange(
        { fieldId: 'loginLeaveTimeoutSeconds', value: '0' },
        'create'
      )
    ).not.toBeNull()
    expect(
      validateTargetFormProposalChange(
        { fieldId: 'loginLeaveTimeoutSeconds', value: '86401' },
        'create'
      )
    ).not.toBeNull()
    expect(
      validateTargetFormProposalChange(
        { fieldId: 'entryUrl', value: 'https://user:secret@example.com' },
        'create'
      )
    ).not.toBeNull()
  })

  it('validates TargetFormProposal schema for proposal rendering and adoption', () => {
    const validProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '建议配置名称为系统A，超时30秒',
      changes: [
        { fieldId: 'name', value: '系统A' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ],
    }
    expect(targetFormProposalSchema.safeParse(validProposal).success).toBe(true)

    // Mode must be create or edit
    expect(
      targetFormProposalSchema.safeParse({
        ...validProposal,
        mode: 'invalid_mode',
      }).success
    ).toBe(false)

    // Changes array cannot be empty
    expect(
      targetFormProposalSchema.safeParse({
        ...validProposal,
        changes: [],
      }).success
    ).toBe(false)

    // Unknown fieldId must be rejected
    expect(
      targetFormProposalSchema.safeParse({
        ...validProposal,
        changes: [{ fieldId: 'unknownField', value: '123' }],
      }).success
    ).toBe(false)
  })

  it('provides field help and value labels based on code definitions', () => {
    const help = targetConfigFieldHelp('loginLeaveTimeoutSeconds')
    expect(help).toContain('留空使用当前平台配置')
    expect(help).toContain('自动填写并提交后')

    expect(targetConfigFieldValueLabel('landingSettleMode', 'default')).toBe('按平台整理')
    expect(targetConfigFieldValueLabel('landingSettleMode', 'off')).toBe('不自动整理')
    expect(targetConfigFieldValueLabel('name', '')).toBe('留空')
    expect(targetConfigFieldValueLabel('name', '测试名称')).toBe('测试名称')
  })

  it('supports pendingFields and clarifyPrompt in TargetFormProposal schema', () => {
    const proposalWithPending = {
      kind: 'target_form',
      mode: 'create',
      summary: '已规划系统名称与编码，待补充入口地址',
      changes: [
        { fieldId: 'name', value: '财务系统' },
        { fieldId: 'code', value: 'finance-system' },
      ],
      pendingFields: ['entryUrl'],
      clarifyPrompt: '请提供财务系统的入口地址（URL）：',
    }
    const result = targetFormProposalSchema.safeParse(proposalWithPending)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pendingFields).toEqual(['entryUrl'])
      expect(result.data.clarifyPrompt).toBe('请提供财务系统的入口地址（URL）：')
    }
  })

  it('sanitizes dummy URLs and detects missing required entryUrl on create mode', () => {
    const rawChanges = [
      { fieldId: 'name', value: '财务系统' } as const,
      { fieldId: 'code', value: 'finance-system' } as const,
      { fieldId: 'entryUrl', value: 'https://finance.example.com' } as const,
    ]
    const sanitized = sanitizeProposalChanges([...rawChanges], 'create')
    // entryUrl with example.com must be stripped from cleanChanges
    expect(sanitized.cleanChanges.some((c) => c.fieldId === 'entryUrl')).toBe(false)
    expect(sanitized.cleanChanges).toHaveLength(2)
    // entryUrl must be detected as pending
    expect(sanitized.detectedPendingFields).toContain('entryUrl')

    // When valid entryUrl is provided, it is kept and pendingFields does not have entryUrl
    const validChanges = [
      { fieldId: 'name', value: '财务系统' } as const,
      { fieldId: 'code', value: 'finance-system' } as const,
      { fieldId: 'entryUrl', value: 'https://finance.oa.internal' } as const,
    ]
    const sanitizedValid = sanitizeProposalChanges([...validChanges], 'create')
    expect(sanitizedValid.cleanChanges).toHaveLength(3)
    expect(sanitizedValid.detectedPendingFields).not.toContain('entryUrl')
  })
})

