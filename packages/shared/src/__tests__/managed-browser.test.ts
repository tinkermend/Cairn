import { describe, expect, it } from 'vitest'
import {
  DEV_INTERNAL_AUTH_SECRET,
  acquireAuthControlBodySchema,
  browserAuthInputCommandSchema,
  browserCommandSchema,
  clickInputSchema,
  decodeCredentialKey,
  canObserveManagedFrames,
  managedBrowserMetaSchema,
  parseWorkerEndpoints,
  requireInternalSecret,
  signInternalHeaders,
  stepSchema,
  verifyInternalHeaders,
} from '../index.js'

const pageRef = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  sessionGeneration: 1,
  pageId: '00000000-0000-4000-8000-000000000002',
  documentEpoch: 0,
}

describe('click pageAfter', () => {
  it('缺省保持旧形状', () => {
    expect(
      clickInputSchema.parse({
        target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '确定' }] },
      }),
    ).not.toHaveProperty('pageAfter')
  })

  it('接受 popup 并拒绝未知字段', () => {
    expect(
      clickInputSchema.parse({
        target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '打开' }] },
        pageAfter: 'popup',
      }).pageAfter,
    ).toBe('popup')
    expect(() =>
      clickInputSchema.parse({
        target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '打开' }] },
        extra: true,
      }),
    ).toThrow()
  })

  it('step 与 command 同步可选字段', () => {
    const step = stepSchema.parse({
      id: '00000000-0000-4000-8000-000000000011',
      name: '打开子窗',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '打开' }] },
        pageAfter: 'popup',
      },
    })
    expect(step.type === 'click' && step.input.pageAfter).toBe('popup')
    expect(
      browserCommandSchema.parse({
        type: 'click',
        target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '打开' }] },
      }),
    ).not.toHaveProperty('pageAfter')
  })
})

describe('auth input whitelist', () => {
  it('接受 composition 完成后的中文，拒绝脚本字段', () => {
    const parsed = browserAuthInputCommandSchema.parse({
      type: 'insert_text',
      pageRef,
      commandId: '00000000-0000-4000-8000-000000000021',
      seq: 1,
      frameId: 'main',
      viewport: { width: 1280, height: 720 },
      text: '验证码一二三',
    })
    expect(parsed.type).toBe('insert_text')
    if (parsed.type === 'insert_text') {
      expect(parsed.text).toBe('验证码一二三')
    }
    expect(() =>
      browserAuthInputCommandSchema.parse({
        type: 'evaluate',
        pageRef,
        commandId: '00000000-0000-4000-8000-000000000022',
        seq: 1,
        frameId: 'main',
        viewport: { width: 1280, height: 720 },
        expression: '1',
      }),
    ).toThrow()
  })
})

describe('internal HMAC', () => {
  it('默认 Worker 地址映射指向 loopback', () => {
    expect(parseWorkerEndpoints(undefined)['local-worker']).toBe('http://127.0.0.1:8091')
  })

  it('签名往返成功，过期或改 body 失败', async () => {
    const secret = requireInternalSecret(DEV_INTERNAL_AUTH_SECRET)
    expect(decodeCredentialKey(DEV_INTERNAL_AUTH_SECRET)?.byteLength).toBe(32)
    const input = {
      method: 'POST' as const,
      path: '/internal/managed-browser/auth-control/acquire',
      body: '{"runId":"x"}',
      expiresUnix: Math.floor(Date.now() / 1000) + 10,
      actorId: '00000000-0000-4000-8000-000000000031',
      runId: '00000000-0000-4000-8000-000000000032',
      sessionGeneration: 2,
      workerInstanceId: '00000000-0000-4000-8000-000000000033',
    }
    const headers = await signInternalHeaders(secret, input)
    expect(
      await verifyInternalHeaders(secret, { ...input, signature: headers['x-cairn-internal-signature']! }),
    ).toBe(true)
    expect(
      await verifyInternalHeaders(secret, {
        ...input,
        body: '{"runId":"y"}',
        signature: headers['x-cairn-internal-signature']!,
      }),
    ).toBe(false)
    expect(
      await verifyInternalHeaders(secret, {
        ...input,
        expiresUnix: input.expiresUnix - 120,
        signature: headers['x-cairn-internal-signature']!,
      }),
    ).toBe(false)
  })

  it('节点健康签名与业务 HMAC 互不通用', async () => {
    const { signNodeHealthHeaders, verifyNodeHealthHeaders, WORKER_NODE_HEALTH_PATH } = await import(
      '../internal-auth.js'
    )
    const secret = requireInternalSecret(DEV_INTERNAL_AUTH_SECRET)
    const node = {
      method: 'GET' as const,
      path: WORKER_NODE_HEALTH_PATH,
      body: '',
      expiresUnix: Math.floor(Date.now() / 1000) + 10,
      workerId: 'local-worker',
    }
    const headers = await signNodeHealthHeaders(secret, node)
    expect(
      await verifyNodeHealthHeaders(secret, { ...node, signature: headers['x-cairn-node-signature']! }),
    ).toBe(true)
    expect(
      await verifyNodeHealthHeaders(secret, {
        ...node,
        workerId: 'other-worker',
        signature: headers['x-cairn-node-signature']!,
      }),
    ).toBe(false)
    expect(
      await verifyInternalHeaders(secret, {
        method: 'GET',
        path: WORKER_NODE_HEALTH_PATH,
        body: '',
        expiresUnix: node.expiresUnix,
        actorId: '00000000-0000-4000-8000-000000000031',
        runId: '00000000-0000-4000-8000-000000000032',
        sessionGeneration: 0,
        workerInstanceId: 'local-worker',
        signature: headers['x-cairn-node-signature']!,
      }),
    ).toBe(false)
  })
})

describe('auth-stage frame visibility', () => {
  it('终态操作和运行不再提供实时画面', () => {
    for (const runStatus of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'NEEDS_REVIEW']) {
      expect(canObserveManagedFrames({ runStatus, actorId: 'viewer' })).toBe(false)
    }
  })
  it('等待认证时只有未过期的当前控制者能看画面', () => {
    const now = Date.parse('2026-09-13T00:00:20.000Z')
    expect(
      canObserveManagedFrames({
        runStatus: 'RUNNING',
        actorId: 'viewer',
        controlActorId: null,
        controlExpiresAt: null,
        now,
      }),
    ).toBe(true)
    expect(
      canObserveManagedFrames({
        runStatus: 'WAITING_FOR_AUTH',
        actorId: 'viewer',
        controlActorId: null,
        controlExpiresAt: null,
        now,
      }),
    ).toBe(false)
    expect(
      canObserveManagedFrames({
        runStatus: 'WAITING_FOR_AUTH',
        actorId: 'controller',
        controlActorId: 'controller',
        controlExpiresAt: '2026-09-13T00:00:30.000Z',
        now,
      }),
    ).toBe(true)
    expect(
      canObserveManagedFrames({
        runStatus: 'WAITING_FOR_AUTH',
        actorId: 'viewer',
        controlActorId: 'controller',
        controlExpiresAt: '2026-09-13T00:00:30.000Z',
        now,
      }),
    ).toBe(false)
    expect(
      canObserveManagedFrames({
        runStatus: 'WAITING_FOR_AUTH',
        actorId: 'controller',
        controlActorId: 'controller',
        controlExpiresAt: '2026-09-13T00:00:10.000Z',
        now,
      }),
    ).toBe(false)
  })
})

describe('managed browser meta', () => {
  it('Worker 不可达时允许空页面列表', () => {
    expect(
      managedBrowserMetaSchema.parse({
        runId: '00000000-0000-4000-8000-000000000041',
        runStatus: 'WAITING_FOR_AUTH',
        sessionId: '00000000-0000-4000-8000-000000000042',
        sessionGeneration: 1,
        ownerWorkerId: 'local-worker',
        framesAvailable: false,
        viewingOtherPage: false,
        currentPage: null,
        pages: [],
        authHold: {
          expiresAt: '2026-09-13T00:00:00.000Z',
          runId: '00000000-0000-4000-8000-000000000041',
        },
        authControl: { epoch: 0, actorId: null, expiresAt: null, heldByViewer: false },
        capabilities: {
          screencast: 'open',
          authInput: 'open',
          popupHandoff: 'open',
          chineseInsertText: 'open',
        },
        degradedReason: 'worker_unreachable',
      }).framesAvailable,
    ).toBe(false)
    expect(acquireAuthControlBodySchema.parse({})).toEqual({})
  })
})
