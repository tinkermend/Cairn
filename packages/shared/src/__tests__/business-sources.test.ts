import { describe, expect, it } from 'vitest'
import {
  BUSINESS_SOURCE_CURSOR_EXPIRED,
  businessRecordDtoSchema,
  businessRecordsResponseSchema,
  businessSourceMappingConfigSchema,
  previewBusinessSourceResponseSchema,
  targetBusinessSourceDtoSchema,
  targetBusinessSourceSnapshotDtoSchema,
} from '../business-sources.js'

describe('business-sources contracts', () => {
  it('validates mapping config schema', () => {
    const validConfig = {
      keyColumn: 'supplier_code',
      displayNameColumn: 'supplier_name',
      statusColumn: 'status',
      fieldWhitelist: ['supplier_code', 'supplier_name', 'category', 'region'],
      sensitiveFields: ['bank_account', 'tax_id'],
    }
    const parsed = businessSourceMappingConfigSchema.parse(validConfig)
    expect(parsed.keyColumn).toBe('supplier_code')
    expect(parsed.fieldWhitelist).toHaveLength(4)

    // Reject empty key
    expect(() =>
      businessSourceMappingConfigSchema.parse({
        ...validConfig,
        keyColumn: '',
      }),
    ).toThrow()

    // Reject empty whitelist
    expect(() =>
      businessSourceMappingConfigSchema.parse({
        ...validConfig,
        fieldWhitelist: [],
      }),
    ).toThrow()
  })

  it('validates target business source DTO schema', () => {
    const validSource = {
      id: '018e1234-5678-7000-8000-000000000001',
      targetId: '018e1234-5678-7000-8000-000000000002',
      entityType: 'manufacturer',
      sourceKind: 'dataset_snapshot' as const,
      currentSnapshotId: '018e1234-5678-7000-8000-000000000003',
      bindingRevision: 2,
      status: 'active' as const,
      ownerAccountId: '018e1234-5678-7000-8000-000000000004',
      approverAccountId: '018e1234-5678-7000-8000-000000000005',
      approvedAt: new Date().toISOString(),
      declaredSourceAsOf: new Date().toISOString(),
      declaredByAccountId: '018e1234-5678-7000-8000-000000000004',
      declarationBasis: 'ERP 导出月度清单',
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      completenessBasis: '快照全量扫描',
      completenessStatus: 'complete' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const parsed = targetBusinessSourceDtoSchema.parse(validSource)
    expect(parsed.status).toBe('active')
    expect(parsed.bindingRevision).toBe(2)
  })

  it('validates snapshot DTO and validation summary', () => {
    const validSnapshot = {
      id: '018e1234-5678-7000-8000-000000000003',
      sourceBindingId: '018e1234-5678-7000-8000-000000000001',
      targetId: '018e1234-5678-7000-8000-000000000002',
      entityType: 'manufacturer',
      datasetId: '018e1234-5678-7000-8000-000000000010',
      datasetName: '2026年厂家名单.xlsx',
      buildStatus: 'ready' as const,
      rulesVersion: 1,
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        fieldWhitelist: ['code', 'name'],
      },
      validationSummary: {
        totalRows: 150,
        validCount: 150,
        rejectedCount: 0,
        issues: [],
      },
      sourceObservedAt: '2026-09-20T00:00:00.000Z',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const parsed = targetBusinessSourceSnapshotDtoSchema.parse(validSnapshot)
    expect(parsed.buildStatus).toBe('ready')
    expect(parsed.validationSummary?.validCount).toBe(150)
  })

  it('validates business record DTO and response list', () => {
    const record = {
      id: '018e1234-5678-7000-8000-000000000100',
      snapshotId: '018e1234-5678-7000-8000-000000000003',
      targetId: '018e1234-5678-7000-8000-000000000002',
      entityType: 'manufacturer',
      recordKey: 'M-001',
      displayName: ' Acme Corp',
      recordStatus: 'active',
      originalDatasetId: '018e1234-5678-7000-8000-000000000010',
      datasetRowId: '018e1234-5678-7000-8000-000000000020',
      datasetRowIndex: 0,
      payload: { code: 'M-001', name: 'Acme Corp', tier: 1 },
      createdAt: new Date().toISOString(),
    }
    const parsedRecord = businessRecordDtoSchema.parse(record)
    expect(parsedRecord.recordKey).toBe('M-001')

    const response = {
      items: [parsedRecord],
      nextCursor: 'next-page-cursor',
      snapshotId: '018e1234-5678-7000-8000-000000000003',
      bindingRevision: 1,
      coverage: {
        status: 'complete' as const,
        completenessBasis: '全量快照扫描完成',
        observedAt: '2026-09-20T00:00:00.000Z',
        importedAt: new Date().toISOString(),
      },
    }
    const parsedResponse = businessRecordsResponseSchema.parse(response)
    expect(parsedResponse.items).toHaveLength(1)
    expect(BUSINESS_SOURCE_CURSOR_EXPIRED).toBe('BUSINESS_SOURCE_CURSOR_EXPIRED')
  })

  it('validates preview response schema', () => {
    const preview = {
      previewRows: [
        {
          rowIndex: 0,
          recordKey: 'MFG-1',
          displayName: 'Beta Tech',
          recordStatus: 'active',
          payload: { code: 'MFG-1', name: 'Beta Tech' },
          isValid: true,
        },
        {
          rowIndex: 1,
          recordKey: null,
          displayName: 'No Key Tech',
          payload: { code: '', name: 'No Key Tech' },
          isValid: false,
          rejectReason: '业务主键列 "code" 为空',
        },
      ],
      validationDigest: {
        sampleCount: 2,
        sampleValidCount: 1,
        sampleRejectedCount: 1,
        potentialDuplicateKeys: [],
      },
    }
    const parsed = previewBusinessSourceResponseSchema.parse(preview)
    expect(parsed.previewRows).toHaveLength(2)
    expect(parsed.validationDigest.sampleRejectedCount).toBe(1)
  })
})
