import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '@cairn/db'
import { AppModule } from '../app.module'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { unusedChangeHint } from '../__tests__/http-app'

/**
 * 宪法「业务接口」：平台 API 对外只使用 GET 与 POST。
 *
 * 这条检查读的是 Express 装配完成后的真实路由表，不是源码里的装饰器
 * 文本——无论 @Patch、@Put、@Delete 还是 @All 挂到具体路径，只要最终
 * 暴露出去就会在这里失败。源码扫描做不到这一点。
 */

/** setGlobalPrefix 的前缀中间件与 404 兜底会登记整套 HTTP 方法。它们不是业务接口。 */
const INFRA_ALL_METHOD_PATHS = new Set(['/health'])

type RouteLayer = { route?: { path?: unknown; methods?: Record<string, boolean> } }

function collectRoutes(app: INestApplication) {
  const instance = app.getHttpAdapter().getInstance() as Record<string, unknown>
  const router = (instance.router ?? instance._router) as { stack?: RouteLayer[] } | undefined
  const stack = router?.stack
  if (!stack?.length) throw new Error('拿不到 Express 路由表，这条检查已经失效，必须先修检查本身')
  return stack.flatMap((layer) => {
    if (!layer.route) return []
    return [{ path: String(layer.route.path), methods: Object.keys(layer.route.methods ?? {}) }]
  })
}

describe('对外 HTTP 方法', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB_HANDLE)
      .useValue({
        ping: vi.fn(async () => true),
        close: vi.fn(async () => {}),
        driver: 'postgres',
        poolStats: () => null,
      } satisfies DbHandle)
      .overrideProvider(CHANGE_HINT)
      .useValue(unusedChangeHint)
      .compile()

    app = moduleRef.createNestApplication({ logger: false })
    app.setGlobalPrefix('api', { exclude: ['health'] })
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('每个业务路由只用 GET 或 POST', () => {
    const offenders = collectRoutes(app)
      .filter((r) => r.methods.length === 1)
      .filter((r) => r.methods[0] !== 'get' && r.methods[0] !== 'post')
      .map((r) => `${r.methods[0]?.toUpperCase()} ${r.path}`)
    expect(offenders).toEqual([])
  })

  it('登记全套方法的层只能是通配前缀与 404 兜底', () => {
    const offenders = collectRoutes(app)
      .filter((r) => r.methods.length > 1)
      .filter((r) => !r.path.includes('*') && !INFRA_ALL_METHOD_PATHS.has(r.path))
      .map((r) => r.path)
    expect(offenders).toEqual([])
  })
})
