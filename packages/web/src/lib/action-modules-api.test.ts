import { actionModuleDetailSchema, moduleContentSchema } from '@cairn/shared'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createActionModule,
  saveActionModuleDraft,
  updateActionModuleMeta,
  publishActionModule,
  deleteActionModule,
} from './action-modules-api'

afterEach(() => vi.unstubAllGlobals())
it('模块写请求均带 JSON Content-Type，包含 OCC 和幂等键', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const detail = actionModuleDetailSchema.parse({
    id,
    targetId: id,
    name: '测试',
    key: 'review.http',
    tags: [],
    aliases: [],
    intentExamples: [],
    draftRevision: 0,
    draftContent: null,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  })
  const fetch = vi.fn(async (url: string) => {
    const body = String(url).includes('/delete')
      ? {
          id,
          deletedAt: '2026-09-16T00:00:00.000Z',
          deletedBy: { id, displayName: '测试', kind: 'console' },
          accepted: true,
        }
      : { ...detail, ok: true }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  await createActionModule({
    targetId: id,
    name: '测试',
    key: 'review.http',
    idempotencyKey: 'create-review',
  })
  await updateActionModuleMeta(id, { baseRevision: 0, name: '修改' })
  const content = moduleContentSchema.parse({
    contract: { effectCeiling: 'READ_ONLY' },
    implementations: [
      {
        implementationKey: 'default',
        kind: 'structured_steps',
        steps: [],
        outputMapping: {},
      },
    ],
  })
  await saveActionModuleDraft(id, { baseRevision: 1, content })
  await publishActionModule(id, {
    expectedRevision: 2,
    idempotencyKey: 'publish-review',
    confirmedWarnings: [],
  })
  await deleteActionModule(id)
  expect(fetch).toHaveBeenCalledTimes(5)
  for (const call of fetch.mock.calls as unknown as [string, RequestInit][]) {
    expect(new Headers(call[1].headers).get('Content-Type')).toBe(
      'application/json'
    )
  }
})
