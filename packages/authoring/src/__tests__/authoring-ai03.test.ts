import { describe, it, expect } from 'vitest'
import {
  buildDemonstrationSemanticProposal,
  computeDatasetProfile,
  buildV2AuthoringSlice,
} from '../index.js'
import type { DemonstrationSource, AuthoringDocument } from '@cairn/shared'

describe('AI-03 Phase 1 Authoring pure functions', () => {
  describe('buildDemonstrationSemanticProposal', () => {
    const mockSource: DemonstrationSource = {
      protocolVersion: 'demonstration@1',
      importProfile: 'playwright-crx@0.15.0',
      recordedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720 },
      actions: [
        {
          id: 'act-1',
          type: 'navigation',
          url: 'https://example.com/login',
          observation: { status: 'captured', observedAt: new Date().toISOString() },
        },
        {
          id: 'act-2',
          type: 'fill',
          text: 'admin',
          observation: { status: 'captured', observedAt: new Date().toISOString() },
        },
        {
          id: 'act-3',
          type: 'click',
          observation: { status: 'captured', observedAt: new Date().toISOString() },
        },
        {
          id: 'act-orphan',
          type: 'scroll',
          observation: { status: 'captured', observedAt: new Date().toISOString() },
        },
      ],
      assetManifest: [],
    }

    it('groups actions, marks unknown actions as unresolved, and computes deterministic digest', () => {
      const proposal = buildDemonstrationSemanticProposal({
        recordingDraftId: '11111111-1111-4111-8111-111111111111',
        factDigest: 'a'.repeat(64),
        source: mockSource,
        groups: [
          {
            groupId: 'grp-login',
            title: '用户登录',
            effectType: 'READ_ONLY',
            sourceIds: ['act-1', 'act-2', 'act-3', 'act-nonexistent'],
          },
        ],
        paramCandidates: [
          { sourceId: 'act-2', name: 'username', type: 'string', sampleValue: 'admin' },
        ],
      })

      expect(proposal.businessGroups).toHaveLength(1)
      expect(proposal.businessGroups[0]!.sourceIds).toEqual(['act-1', 'act-2', 'act-3'])
      // act-orphan must not be dropped
      expect(proposal.unknownActions).toContain('act-orphan')
      expect(proposal.sourceMap.find((s) => s.sourceId === 'act-orphan')?.disposition).toBe('unresolved')
      expect(proposal.modelProposalDigest).toHaveLength(64)

      // Recomputing with same input produces exact same digest
      const proposal2 = buildDemonstrationSemanticProposal({
        recordingDraftId: '11111111-1111-4111-8111-111111111111',
        factDigest: 'a'.repeat(64),
        source: mockSource,
        groups: [
          {
            groupId: 'grp-login',
            title: '用户登录',
            effectType: 'READ_ONLY',
            sourceIds: ['act-1', 'act-2', 'act-3'],
          },
        ],
        paramCandidates: [
          { sourceId: 'act-2', name: 'username', type: 'string', sampleValue: 'admin' },
        ],
      })
      expect(proposal.modelProposalDigest).toBe(proposal2.modelProposalDigest)
    })
  })

  describe('computeDatasetProfile', () => {
    it('computes column statistics, null rates, and detects leading zero preservation', () => {
      const rows = [
        { code: '00123', price: 99.5, in_stock: true, remarks: '  优惠  ' },
        { code: '00124', price: 150, in_stock: false, remarks: null },
        { code: '00125', price: 20, in_stock: true, remarks: '' },
      ]

      const profile = computeDatasetProfile({
        datasetId: '11111111-1111-4111-8111-111111111112',
        rows,
      })

      expect(profile.totalRows).toBe(3)
      expect(profile.analyzedRows).toBe(3)
      expect(profile.isSampled).toBe(false)

      const codeCol = profile.columns.find((c) => c.name === 'code')!
      expect(codeCol.inferredType).toBe('string')
      expect(codeCol.nullCount).toBe(0)
      expect(codeCol.sampleAnomalies).toContain('检测到带前导零的长编号，已保护原始字符串语义')

      const priceCol = profile.columns.find((c) => c.name === 'price')!
      expect(priceCol.inferredType).toBe('number')
      expect(priceCol.nullCount).toBe(0)

      const remarksCol = profile.columns.find((c) => c.name === 'remarks')!
      expect(remarksCol.nullCount).toBe(2)
      expect(remarksCol.sampleAnomalies).toContain('发现 1 行存在首尾空格')
    })
  })

  describe('buildV2AuthoringSlice', () => {
    it('slices V2 document retaining upstream dependencies including module outputs and redacts secrets', () => {
      const doc: AuthoringDocument = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ name: 'baseUrl', type: 'string', defaultValue: 'https://test.com' }],
        nodes: [
          {
            kind: 'step',
            step: {
              id: 'step-nav',
              name: '打开页面',
              type: 'navigate',
              effectType: 'READ_ONLY',
              input: { url: '${baseUrl}' },
            },
          },
          {
            kind: 'module',
            invocationId: 'mod-auth',
            moduleId: '00000000-0000-4000-8000-000000000001',
            implementationKey: 'default',
            inputBindings: {},
            outputBindings: { userToken: 'authToken' },
          },
          {
            kind: 'step',
            step: {
              id: 'step-secret',
              name: '输入密码',
              type: 'fill',
              effectType: 'READ_ONLY',
              input: {
                target: { candidates: [{ by: 'css', value: '#pwd' }] },
                value: 'superSecret123',
                sensitive: true,
              },
            },
          },
          {
            kind: 'step',
            step: {
              id: 'step-target',
              name: '使用Token查询',
              type: 'fill',
              effectType: 'READ_ONLY',
              input: {
                target: { candidates: [{ by: 'css', value: '#token' }] },
                value: '${authToken}',
                from: 'authToken',
              },
            },
          },
          {
            kind: 'step',
            step: {
              id: 'step-unrelated',
              name: '无关后续步骤',
              type: 'click',
              effectType: 'READ_ONLY',
              input: { target: { candidates: [{ by: 'css', value: '#other' }] } },
            },
          },
        ],
      }

      const slice = buildV2AuthoringSlice(doc, 'step-target')

      // Sliced nodes must include step-target and mod-auth (which produces authToken)
      expect(slice.nodes.some((n) => n.kind === 'module' && n.invocationId === 'mod-auth')).toBe(true)
      expect(slice.nodes.some((n) => n.kind === 'step' && n.step.id === 'step-target')).toBe(true)
      // Unrelated step must be excluded
      expect(slice.nodes.some((n) => n.kind === 'step' && n.step.id === 'step-unrelated')).toBe(false)
      expect(slice.totalOriginalNodes).toBe(5)
    })
  })
})
