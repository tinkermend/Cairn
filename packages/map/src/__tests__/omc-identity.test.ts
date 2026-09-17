import { describe, expect, it } from 'vitest'
import {
  isNoiseMapRoute,
  mapImplementationKey,
  type MapConditionSnapshot,
  type MapObservation,
  type MapProjectionState,
  type MapVerification,
} from '@cairn/shared'
import { classifyRoute, matchObjectIdentity, matchPageIdentity } from '../identity.js'
import { chooseImplementation, evaluateCondition } from '../conditions.js'
import { attributeVerification, lifecycleFromEvidence } from '../verification.js'
import { planProjectionBatch, projectionWorkingSetHints } from '../projection.js'
import { queryMap } from '../query.js'
import type { MapFactPageItem } from '../ports.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const accountId = '66666666-6666-4666-8666-666666666666'

function condition(overrides: Partial<MapConditionSnapshot> = {}): MapConditionSnapshot {
  return {
    targetId,
    accountBinding: { presence: 'known', targetAccountId: accountId },
    permissionProfile: { source: 'rbac', version: 'v1' },
    workspace: 'ops',
    locale: 'zh-CN',
    viewport: { category: 'desktop', widthPx: 1440, heightPx: 900 },
    unknownFields: [],
    ...overrides,
  }
}

function observation(input: {
  id: string
  url: string
  label?: string
  region?: string
  role?: string
  locale?: string
  workspace?: string
  viewport?: MapConditionSnapshot['viewport']
  permission?: { source: string; version: string }
  truncated?: boolean
  empty?: boolean
  ready?: boolean
  loading?: boolean
  virtualized?: boolean
  judgement?: MapObservation['judgement']
}): MapObservation {
  return {
    id: input.id,
    schemaVersion: 1,
    targetId,
    dedupeKey: `run:${input.id}:before:0`,
    observedAt: '2026-09-16T00:00:00.000Z',
    collectorVersion: 'map-collector@1',
    sourceType: 'formal_run',
    sourceRef: {
      sourceType: 'formal_run',
      runId: '22222222-2222-4222-8222-222222222222',
      stepRunId: '33333333-3333-4333-8333-333333333333',
      attemptId: input.id,
    },
    phase: 'after_action',
    localSequence: 0,
    sourceEventKey: `evt:${input.id}`,
    conditionSnapshot: condition({
      locale: input.locale ?? 'zh-CN',
      workspace: input.workspace ?? 'ops',
      viewport: input.viewport ?? { category: 'desktop', widthPx: 1440, heightPx: 900 },
      permissionProfile: input.permission ?? { source: 'rbac', version: 'v1' },
    }),
    topUrlPattern: input.url,
    framePath: [],
    originChain: ['https://shop.example'],
    surfaceCapability: { frames: 'ok', a11y: 'ok', canvas: 'unknown', shadow: 'ok' },
    regionRefs: [{ key: input.region ?? 'main', kind: 'action_object' }],
    nodeSetKind: 'action_object',
    completeness: input.truncated ? 'partial' : 'complete',
    truncated: Boolean(input.truncated),
    missingReasons: input.truncated ? ['TRUNCATED'] : [],
    semanticSummary: {
      predicates: [
        ...(input.label ? [{ name: 'label', value: input.label }] : []),
        ...(input.role ? [{ name: 'role', value: input.role }] : []),
        ...(input.ready !== undefined ? [{ name: 'ready', value: input.ready }] : []),
        ...(input.empty !== undefined ? [{ name: 'empty', value: input.empty }] : []),
        ...(input.loading ? [{ name: 'loading', value: true }] : []),
        ...(input.virtualized ? [{ name: 'virtualized', value: true }] : []),
      ],
    },
    stateSummary: {
      regions: {
        list: {
          ...(input.empty !== undefined ? { empty: input.empty } : {}),
          ...(input.ready !== undefined ? { ready: input.ready } : {}),
        },
      },
    },
    structuralSummary: { nodeCount: 8, truncated: Boolean(input.truncated) },
    evidenceRefs: [],
    captureStatus: 'observed',
    judgement: input.judgement,
  }
}

function emptyState(): MapProjectionState {
  return {
    targetId,
    projectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    generation: 1,
    status: 'active',
    cursor: 0,
    revision: 0,
    identityRevision: 0,
    pages: [],
    objects: [],
    implementations: [],
    descriptors: [],
    assignments: [],
    assets: [],
    aliases: [],
  }
}

function fact(obs: MapObservation, ingestSeq: number): MapFactPageItem {
  return { type: 'observation', ingestSeq, observation: obs, contentAvailability: 'available' }
}

describe('OMC 身份与条件', () => {
  it('默认知识视图把空白和无效路由当成噪声', () => {
    expect(isNoiseMapRoute('nullblank')).toBe(true)
    expect(isNoiseMapRoute('about:blank')).toBe(true)
    expect(isNoiseMapRoute('chrome-error://chromewebdata/')).toBe(true)
    expect(isNoiseMapRoute('https://unknown.invalid/')).toBe(true)
    expect(isNoiseMapRoute('')).toBe(true)
    expect(isNoiseMapRoute('https://shop.example/orders')).toBe(false)
    expect(isNoiseMapRoute('http://61.144.35.2:18804/front/login')).toBe(false)
  })

  it('OMC01 同模板订单归同页，不同 module 与未知参数区分', () => {
    const a = classifyRoute({ url: 'https://shop.example/orders/111' })
    const b = classifyRoute({ url: 'https://shop.example/orders/222' })
    const orders = classifyRoute({ url: 'https://shop.example/console?module=orders' })
    const customers = classifyRoute({ url: 'https://shop.example/console?module=customers' })
    const unknown = classifyRoute({ url: 'https://shop.example/console?ref=keep-me' })
    expect(a.allocationKey).toBe(b.allocationKey)
    expect(orders.allocationKey).not.toBe(customers.allocationKey)
    expect(unknown.reasons.some((reason) => reason.startsWith('unknown-kept'))).toBe(true)
    expect(unknown.routeToken).toContain('ref=keep-me')
    const plan = planProjectionBatch({
      state: emptyState(),
      facts: [
        fact(observation({ id: '55555555-5555-4555-8555-555555555551', url: 'https://shop.example/orders/111' }), 1),
        fact(observation({ id: '55555555-5555-4555-8555-555555555552', url: 'https://shop.example/orders/222' }), 2),
        fact(
          observation({ id: '55555555-5555-4555-8555-555555555553', url: 'https://shop.example/console?module=orders' }),
          3,
        ),
        fact(
          observation({
            id: '55555555-5555-4555-8555-555555555554',
            url: 'https://shop.example/console?module=customers',
          }),
          4,
        ),
      ],
      now: '2026-09-16T00:00:00.000Z',
    })
    const orderIdPages = plan.pages.filter((page) => page.routeTemplate.includes('/orders'))
    expect(new Set(orderIdPages.map((page) => page.allocationKey)).size).toBe(1)
    expect(plan.pages.filter((page) => page.routeTemplate.includes('module=')).map((page) => page.allocationKey)).toHaveLength(2)
  })

  it('OMC02 有映射的改名延续，两区域同名保存不合并', () => {
    const first = observation({
      id: '55555555-5555-4555-8555-555555555561',
      url: 'https://shop.example/console',
      label: '发布',
      role: 'button',
      region: 'toolbar',
    })
    const page = matchPageIdentity({ observation: first, pages: [] })
    const original = matchObjectIdentity({
      observation: first,
      pageAllocationKey: page.allocation.allocationKey,
      objects: [],
      aliases: [],
    })
    const renamedObservation = observation({
      id: '55555555-5555-4555-8555-555555555562',
      url: 'https://shop.example/console',
      label: 'Publish',
      role: 'button',
      region: 'toolbar',
    })
    const renamedKey = matchObjectIdentity({
      observation: renamedObservation,
      pageAllocationKey: page.allocation.allocationKey,
      objects: [],
      aliases: [],
    }).allocationKey
    const renamed = matchObjectIdentity({
      observation: renamedObservation,
      pageAllocationKey: page.allocation.allocationKey,
      objects: [],
      aliases: [
        {
          revision: 1,
          action: 'alias',
          oldAllocationKey: renamedKey,
          newAllocationKey: original.allocationKey,
        },
      ],
    })
    expect(renamed.reasons).toContain('identity-alias')
    const saveA = matchObjectIdentity({
      observation: observation({
        id: '55555555-5555-4555-8555-555555555563',
        url: 'https://shop.example/console',
        label: '保存',
        role: 'button',
        region: 'dialog-a',
      }),
      pageAllocationKey: page.allocation.allocationKey,
      objects: [],
      aliases: [],
    })
    const saveB = matchObjectIdentity({
      observation: observation({
        id: '55555555-5555-4555-8555-555555555564',
        url: 'https://shop.example/console',
        label: '保存',
        role: 'button',
        region: 'dialog-b',
      }),
      pageAllocationKey: page.allocation.allocationKey,
      objects: [],
      aliases: [],
    })
    expect(saveA.allocationKey).not.toBe(saveB.allocationKey)
  })

  it('OMC03 中英/视口/角色并存且不互相 supersede', () => {
    const variants = [
      condition(),
      condition({ locale: 'en' }),
      condition({ viewport: { category: 'mobile', widthPx: 390, heightPx: 844 } }),
      condition({ permissionProfile: { source: 'rbac', version: 'admin' } }),
    ]
    const keys = variants.map((item) => mapImplementationKey(item))
    expect(new Set(keys).size).toBe(4)
    const plan = planProjectionBatch({
      state: emptyState(),
      facts: variants.map((item, index) =>
        fact(
          observation({
            id: `55555555-5555-4555-8555-55555555557${index}`,
            url: 'https://shop.example/console',
            label: '保存',
            locale: item.locale,
            viewport: item.viewport,
            permission: item.permissionProfile,
          }),
          index + 1,
        ),
      ),
      now: '2026-09-16T00:00:00.000Z',
    })
    expect(plan.implementations).toHaveLength(4)
    expect(plan.assets.every((asset) => asset.changeCount === 0)).toBe(true)
  })

  it('OMC04 workspace 未知为 UNKNOWN，变化则新条件', () => {
    const required = condition()
    const unknown = condition({ workspace: undefined, unknownFields: ['workspace'] })
    expect(evaluateCondition(required, unknown)).toBe('unknown')
    expect(evaluateCondition(required, condition({ workspace: 'finance' }))).toBe('unsatisfied')
    const choice = chooseImplementation(unknown, [
      { key: 'ops', condition: required },
      { key: 'finance', condition: condition({ workspace: 'finance' }) },
    ])
    expect(choice.match).toBe('unknown')
    expect(choice.reasons).toContain('required-field-unknown')
  })

  it('OMC05 empty+ready 与截断不造删除', () => {
    const plan = planProjectionBatch({
      state: emptyState(),
      facts: [
        fact(
          observation({
            id: '55555555-5555-4555-8555-555555555581',
            url: 'https://shop.example/list',
            empty: true,
            ready: true,
            virtualized: true,
            truncated: true,
          }),
          1,
        ),
      ],
      now: '2026-09-16T00:00:00.000Z',
    })
    expect(plan.assets[0]?.rejectReasons).toContain('coverage-unknown')
    expect(plan.assets[0]?.lifecycle).not.toBe('RETIRED')
    const attribution = attributeVerification({
      verification: verification('identity', 'rejected'),
      observations: [
        observation({
          id: '55555555-5555-4555-8555-555555555582',
          url: 'https://shop.example/list',
          truncated: true,
        }),
      ],
    })
    expect(attribution.deleteObject).toBe(false)
    expect(attribution.miss).toBe(false)
    expect(attribution.coverage).toBe('unknown')
  })

  it('OMC06 点对业务拒绝与点错 Toast 成功分维，importance 不降', () => {
    const correct = observation({
      id: '55555555-5555-4555-8555-555555555591',
      url: 'https://shop.example/form',
      judgement: { identity: { verdict: 'confirmed' }, locator: { verdict: 'confirmed' } },
    })
    const wrong = observation({
      id: '55555555-5555-4555-8555-555555555592',
      url: 'https://shop.example/form',
      judgement: { identity: { verdict: 'unknown', note: 'wrong-click' } },
    })
    const business = attributeVerification({
      verification: verification('business', 'rejected'),
      observations: [correct],
    })
    const toast = attributeVerification({
      verification: verification('business', 'confirmed'),
      observations: [wrong],
    })
    expect(business.dimension).toBe('business')
    expect(business.verdict).toBe('rejected')
    expect(business.importanceDelta).toBe(0)
    expect(toast.allowSuccessCount).toBe(false)
    expect(toast.importanceDelta).toBe(0)
    expect(lifecycleFromEvidence({ hasObservation: true, dimensions: [{ dimension: 'business', verdict: 'rejected', confirmedCount: 0, rejectedCount: 1, unknownCount: 0 }] })).toBe('DEGRADED')
  })

  it('OMF 选中候选的同 Attempt 回流只作审计，不把自己升格为未来候选证据', () => {
    const obs = observation({
      id: '55555555-5555-4555-8555-5555555555b1',
      url: 'https://shop.example/orders',
      label: '订单标题',
    })
    const feedback = verification('locator', 'confirmed')
    feedback.observationIds = [obs.id]
    feedback.verificationSource = {
      ...feedback.verificationSource,
      ruleRef: 'map-consumption-feedback',
      sourceEventKey: 'map-consumption:decision-1',
      sourceVersion: 'map-consumption@1',
    }
    const plan = planProjectionBatch({
      state: emptyState(),
      facts: [
        fact(obs, 1),
        { type: 'verification', ingestSeq: 2, verification: feedback, contentAvailability: 'available' },
      ],
      now: '2026-09-16T00:00:00.000Z',
    })
    expect(plan.assets[0]?.dimensions).toEqual([])
  })

  it('OMC07 重复观察不重复计数，首次失败仍可见', () => {
    const obs = observation({
      id: '55555555-5555-4555-8555-5555555555a1',
      url: 'https://shop.example/form',
      label: '提交',
    })
    const first = planProjectionBatch({
      state: emptyState(),
      facts: [fact(obs, 1)],
      now: '2026-09-16T00:00:00.000Z',
    })
    const pageId = '33333333-3333-4333-8333-333333333333'
    const objectId = '44444444-4444-4444-8444-444444444444'
    const page = first.pages[0]!
    const object = first.objects[0]!
    const second = planProjectionBatch({
      state: {
        ...emptyState(),
        pages: [
          {
            id: pageId,
            allocationKey: page.allocationKey,
            kind: page.kind,
            routeTemplate: page.routeTemplate,
          },
        ],
        objects: [
          {
            id: objectId,
            allocationKey: object.allocationKey,
            pageId,
            pageAllocationKey: object.pageAllocationKey,
            regionKey: object.regionKey,
            stableToken: object.stableToken,
          },
        ],
        assignments: [{ observationId: obs.id, assignmentRevision: 1 }],
        assets: [
          {
            assetRefKey: 'p:x:o:x:i:x:d:0',
            pageId,
            objectId,
            implementationKey: first.assets[0]?.implementationKey,
            lifecycle: 'OBSERVED',
            importance: 0,
            executable: false,
            rejectReasons: [],
            dimensions: [
              { dimension: 'business', verdict: 'rejected', confirmedCount: 0, rejectedCount: 1, unknownCount: 0 },
            ],
            sampleCount: 1,
            changeCount: 0,
          },
        ],
      },
      facts: [fact(obs, 2)],
      now: '2026-09-16T00:00:00.000Z',
    })
    expect(first.assets[0]?.sampleCount).toBe(1)
    expect(second.assets).toHaveLength(1)
    expect(second.assets[0]?.sampleCount).toBe(1)
    expect(second.assets[0]?.dimensions.some((item) => item.verdict === 'rejected')).toBe(true)
  })

  it('计划只带本批脏资产，超过 200 条存量不撑爆契约', () => {
    const obs = observation({
      id: '55555555-5555-4555-8555-5555555555c1',
      url: 'https://shop.example/orders/9',
      label: '提交',
    })
    const facts = [fact(obs, 1)]
    const hints = projectionWorkingSetHints(facts)
    expect(hints.pageAllocationKeys).toHaveLength(1)
    expect(hints.objectAllocationKeys).toHaveLength(1)
    expect(hints.observationIds).toEqual([obs.id])
    const untouched = Array.from({ length: 201 }, (_, index) => ({
      id: `33333333-3333-4333-8333-33333333${String(index).padStart(4, '0')}`,
      allocationKey: `page:v1:top:stock${String(index).padStart(3, '0')}:top`,
      kind: 'top' as const,
      routeTemplate: `https://shop.example/stock/${index}`,
    }))
    const plan = planProjectionBatch({
      state: {
        ...emptyState(),
        pages: untouched,
        assets: untouched.map((page) => ({
          assetRefKey: `p:${page.id}:o:x:i:x:d:0`,
          pageId: page.id,
          lifecycle: 'OBSERVED' as const,
          importance: 0,
          executable: false,
          rejectReasons: [],
          dimensions: [],
          sampleCount: 1,
          changeCount: 0,
        })),
      },
      facts,
      now: '2026-09-16T00:00:00.000Z',
    })
    expect(plan.assets.length).toBeLessThanOrEqual(2)
    expect(plan.pages).toHaveLength(1)
    expect(plan.assets.some((asset) => asset.pageAllocationKey === hints.pageAllocationKeys[0])).toBe(true)
  })

  it('OMC13 查询冻结视图不跟 latest', () => {
    const result = queryMap(
      {
        targetId,
        viewRef: { kind: 'release', releaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', manifestDigest: 'a'.repeat(64) },
        identityRevision: 1,
        assets: [
          {
            assetRef: { targetId, pageId: '33333333-3333-4333-8333-333333333333', objectId: '44444444-4444-4444-8444-444444444444', implementationKey: 'impl:v1:zh-CN:desktop:rbac.v1:ops:u', descriptorVersion: 1 },
            assetRefKey: 'frozen-v1',
            lifecycle: 'VERIFIED',
            importance: 0,
            executable: true,
            rejectReasons: [],
            dimensions: [],
            sampleCount: 1,
            changeCount: 0,
            evidenceAvailability: 'available',
          },
        ],
      },
      {
        targetId,
        view: { kind: 'release', releaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', manifestDigest: 'a'.repeat(64) },
        limit: 10,
      },
    )
    expect(result.usedRefs[0]?.descriptorVersion).toBe(1)
    expect(result.viewRef.kind).toBe('release')
  })

  it('装载层标记 candidateOverflow 时直接 AMBIGUOUS', () => {
    const result = queryMap(
      {
        targetId,
        viewRef: { kind: 'projection', projectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cursor: 0, revision: 0 },
        identityRevision: 0,
        candidateOverflow: true,
        assets: [],
      },
      {
        targetId,
        view: { kind: 'projection', projectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        limit: 10,
      },
    )
    expect(result.matchResult).toBe('AMBIGUOUS')
    expect(result.candidates).toEqual([])
  })
})

function verification(dimension: MapVerification['dimension'], verdict: MapVerification['verdict']): MapVerification {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    schemaVersion: 1,
    targetId,
    dedupeKey: `ver:${dimension}:${verdict}`,
    observationIds: ['55555555-5555-4555-8555-555555555591'],
    dimension,
    verdict,
    claim: { proposition: `${dimension}:${verdict}` },
    evidenceRefs: [],
    evaluatedAt: '2026-09-16T00:00:01.000Z',
    evaluatorVersion: 'map-verify@1',
    verificationSource: {
      kind: 'rule',
      runId: '22222222-2222-4222-8222-222222222222',
      stepRunId: '33333333-3333-4333-8333-333333333333',
      ruleRef: 'rule.v1',
      sourceEventKey: 'evt:ver',
      sourceVersion: 'v1',
    },
  }
}
