import { type INestApplication, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { openIsolatedDb } from '@cairn/db/testing'
import {
  getOrCreatePlatformConfig,
  getPlatformConfig,
  newId,
  RbacStore,
  registerStandaloneSecret,
  updatePlatformConfig,
  type AuditActor,
} from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  PERMISSIONS,
  type PlatformConfigDocument,
  type SecretRef,
} from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { LocalSecretProvider } from '../secrets/local-secret-provider'
import { listenForSupertest } from '../__tests__/http-app'
import { PlatformConfigController } from './platform-config.controller'
import { PlatformConfigService } from './platform-config.service'

const originalUrl = 'https://original.example/v1'
const changedUrl = 'https://changed.example/v1'
const testKey = 'review-only-fake-key'
const secrets = new LocalSecretProvider(Buffer.alloc(32, 7))
const enabled = (secretRef: SecretRef, baseUrl = originalUrl): PlatformConfigDocument => ({
  ...FACTORY_PLATFORM_CONFIG,
  browserAi: {
    ...FACTORY_PLATFORM_CONFIG.browserAi,
    enabled: true,
    baseUrl,
    secretRef,
    model: 'demo',
    modelFamily: 'openai',
  },
})

describe('平台配置凭据绑定（真实仓储与 HTTP）', () => {
  let db: Awaited<ReturnType<typeof openIsolatedDb>>
  let service: PlatformConfigService
  let actor: AuditActor
  let app: INestApplication
  let fetchMock: ReturnType<typeof vi.fn>
  async function save(document: PlatformConfigDocument) {
    const current = (await getPlatformConfig(db))!
    return service.update(
      { document, expectedRevision: current.revision, reason: '测试变更' },
      actor,
    )
  }
  async function register(baseUrl = originalUrl) {
    return (await service.registerSecret({ baseUrl, apiKey: testKey }, actor)).secretRef
  }
  beforeAll(async () => {
    db = await openIsolatedDb(`cairn_cfg_binding_${newId().replaceAll('-', '')}`)
    const rbac = new RbacStore(db, {
      hash: async (v) => v,
      verify: async (v, h) => v === h,
    })
    const role = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    actor = await rbac.createAccount(
      { email: 'binding-admin', displayName: '绑定测试', password: 'test-password', roleIds: [role.id] },
      null,
    )
    await getOrCreatePlatformConfig(db)
    service = new PlatformConfigService(db, secrets)
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().account = { ...actor, permissions: [...PERMISSIONS] }
        return true
      },
    }
    const module = await Test.createTestingModule({
      controllers: [PlatformConfigController],
      providers: [
        Reflector,
        { provide: PlatformConfigService, useValue: service },
        { provide: APP_GUARD, useValue: guard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    await listenForSupertest(app)
  })
  beforeEach(async () => {
    await save(FACTORY_PLATFORM_CONFIG)
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => {
    await app?.close()
    await db?.close()
  })

  it('登记必须带地址；未保存配置前，测试也只能把密钥发到已绑定 origin', async () => {
    await request(app.getHttpServer())
      .post('/platform-config/secrets')
      .send({ apiKey: testKey })
      .expect(400)
    const secretRef = await register()
    const body = { model: 'demo', modelFamily: 'openai', secretRef }
    const rejected = await request(app.getHttpServer())
      .post('/platform-config/test-connection')
      .send({ ...body, baseUrl: changedUrl })
      .expect(400)
    expect(rejected.body.code).toBe('AI_CONFIG_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
    await request(app.getHttpServer())
      .post('/platform-config/test-connection')
      .send({ ...body, baseUrl: 'https://ORIGINAL.example:443/v2' })
      .expect(200)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://original.example/v2/models')
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${testKey}`)
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined()
  })

  it('停用、重新启用和连接测试都不能把原服务密钥绑定到新地址', async () => {
    const secretRef = await register()
    const first = enabled(secretRef)
    await save(first)
    await save({ ...first, browserAi: { ...first.browserAi, enabled: false } })
    const changed = enabled(secretRef, changedUrl)
    await expect(
      save({ ...changed, browserAi: { ...changed.browserAi, enabled: false } }),
    ).rejects.toMatchObject({ response: { code: 'AI_CONFIG_INVALID' } })
    await expect(save(changed)).rejects.toMatchObject({ response: { code: 'AI_CONFIG_INVALID' } })
    await expect(
      service.testConnection({
        baseUrl: changedUrl,
        model: 'demo',
        modelFamily: 'openai',
        secretRef,
      }),
    ).rejects.toMatchObject({ response: { code: 'AI_CONFIG_INVALID' } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(
      (await save(enabled(await register(changedUrl), changedUrl))).document.browserAi.enabled,
    ).toBe(true)
  })

  it('换新密钥后仍能恢复旧修订；引用和明文格式不漂移', async () => {
    const oldRef = await register()
    const old = await save(enabled(oldRef))
    const next = await save(enabled(await register(changedUrl), changedUrl))
    const restored = await service.restore(
      { revision: old.revision, expectedRevision: next.revision, reason: '恢复旧服务' },
      actor,
    )
    expect(restored.document).toEqual(old.document)
    expect(restored.revision).toBe(next.revision + 1)
    await service.testConnection({
      baseUrl: originalUrl,
      model: 'demo',
      modelFamily: 'openai',
      secretRef: oldRef,
    })
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${testKey}`)
  })

  it('恢复历史中不匹配的绑定会被拒绝，当前配置不变', async () => {
    const secretRef = await register()
    const current = (await getPlatformConfig(db))!
    const bad = await updatePlatformConfig(db, {
      expectedRevision: current.revision,
      actor,
      reason: '模拟旧缺陷写入',
      document: enabled(secretRef, changedUrl),
    })
    const safe = await save(FACTORY_PLATFORM_CONFIG)
    await expect(
      service.restore(
        { revision: bad.revision, expectedRevision: safe.revision, reason: '恢复错误绑定' },
        actor,
      ),
    ).rejects.toMatchObject({ response: { code: 'AI_CONFIG_INVALID' } })
    expect((await getPlatformConfig(db))!.revision).toBe(safe.revision)
  })

  it('无绑定、未知 provider 和不存在的引用不能测试，也不能通过停用配置取得绑定', async () => {
    const secretId = newId()
    await registerStandaloneSecret(db, {
      id: secretId,
      ciphertext: secrets.encrypt(secretId, testKey),
    })
    for (const secretRef of [
      { provider: 'local', secretId },
      { provider: 'vault', secretId },
      { provider: 'local', secretId: newId() },
    ]) {
      const document = enabled(secretRef)
      await expect(
        save({ ...document, browserAi: { ...document.browserAi, enabled: false } }),
      ).rejects.toMatchObject({ response: { code: 'AI_CONFIG_INVALID' } })
      await request(app.getHttpServer())
        .post('/platform-config/test-connection')
        .send({ baseUrl: originalUrl, model: 'demo', modelFamily: 'openai', secretRef })
        .expect(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('平台 AI 连通测试走 chat/completions，空正文仍成功', async () => {
    const secretRef = await register()
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'think' } }] }),
        { status: 200 },
      ),
    )
    const result = await request(app.getHttpServer())
      .post('/platform-config/test-connection')
      .send({ baseUrl: originalUrl, model: 'deepseek-chat', provider: 'deepseek', secretRef })
      .expect(200)
    expect(result.body.ok).toBe(true)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://original.example/v1/chat/completions')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'error', method: 'POST' })
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as Record<string, unknown>
    expect(sent.max_tokens).toBe(1)
    expect(sent).not.toHaveProperty('response_format')
    // DeepSeek defaults to reasoning unless the request explicitly disables it.
    expect(sent.thinking).toEqual({ type: 'disabled' })
    expect(sent).not.toHaveProperty('modelFamily')
  })

  it('启用助手缺提供商时 validate/update 拒绝；GET 与 restore 不因提供商失败', async () => {
    const secretRef = await register()
    // 出厂已预填提供商；缺提供商是存量启用文档的形态，须显式去掉这个键。
    const { provider: _factoryProvider, ...platformAiWithoutProvider } =
      FACTORY_PLATFORM_CONFIG.platformAi
    const legacy = {
      ...FACTORY_PLATFORM_CONFIG,
      platformAi: {
        ...platformAiWithoutProvider,
        enabled: true,
        baseUrl: originalUrl,
        model: 'deepseek-chat',
        secretRef,
      },
    }
    const seeded = await updatePlatformConfig(db, {
      expectedRevision: (await getPlatformConfig(db))!.revision,
      actor,
      reason: '模拟缺提供商的存量启用文档',
      document: legacy,
    })
    const current = await request(app.getHttpServer()).get('/platform-config').expect(200)
    expect(current.body.document.platformAi.enabled).toBe(true)
    expect(current.body.document.platformAi.provider).toBeUndefined()
    expect(current.body.document.platformAi.thinkingMode).toBe('off')

    const rejected = await request(app.getHttpServer())
      .post('/platform-config/validate')
      .send({ document: legacy })
      .expect(400)
    expect(rejected.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'document.platformAi.provider' })]),
    )
    await request(app.getHttpServer())
      .post('/platform-config/update')
      .send({ expectedRevision: seeded.revision, reason: '补超时', document: {
        ...legacy,
        execution: { ...legacy.execution, defaultTimeoutMs: 45_000 },
      } })
      .expect(400)
    await expect(service.resolvePlatformAiAccess()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    const factory = await save(FACTORY_PLATFORM_CONFIG)
    const restored = await service.restore(
      { revision: seeded.revision, expectedRevision: factory.revision, reason: '恢复缺提供商修订' },
      actor,
    )
    expect(restored.document.platformAi.enabled).toBe(true)
    expect(restored.document.platformAi.provider).toBeUndefined()
  })
})
