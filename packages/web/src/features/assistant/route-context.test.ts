import { describe, expect, it } from 'vitest'
import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { resolveRouteContext, toPageContext } from './route-context'
import { routeTree } from '@/routeTree.gen'

describe('resolveRouteContext (路由级页面感知底座)', () => {
  it('根路径精确匹配总览', () => {
    const res = resolveRouteContext('/')
    expect(res.page).toBe('home')
    expect(res.title).toBe('总览')
    expect(res.statusLabel).toBe('总览')
    expect(res.statusTone).toBe('neutral')
  })

  it('列表与详情前缀匹配：场景编排、运行记录、定时任务、目标系统', () => {
    expect(resolveRouteContext('/scenarios')).toMatchObject({
      page: 'scenario',
      title: '场景编排',
      statusLabel: '场景编排',
    })
    expect(resolveRouteContext('/scenarios/scenario-100')).toMatchObject({
      page: 'scenario',
      title: '场景编排',
    })
    expect(resolveRouteContext('/runs')).toMatchObject({
      page: 'run',
      title: '运行记录',
      statusLabel: '运行记录',
    })
    expect(resolveRouteContext('/runs/run-abcdef')).toMatchObject({
      page: 'run',
      title: '运行记录',
    })
    expect(resolveRouteContext('/schedules')).toMatchObject({
      page: 'schedule',
      title: '定时任务',
      statusLabel: '定时任务',
    })
    expect(resolveRouteContext('/targets')).toMatchObject({
      page: 'target',
      title: '目标系统',
    })
    expect(resolveRouteContext('/sessions')).toMatchObject({
      page: 'session',
      title: '账号会话',
    })
    expect(resolveRouteContext('/datasets')).toMatchObject({
      page: 'dataset',
      title: '数据集',
    })
    expect(resolveRouteContext('/platform-config')).toMatchObject({
      page: 'platform-config',
      title: '平台配置',
    })
  })

  it('前缀碰撞防范：/suite-runs 绝不可误判为 /suites（场景集）', () => {
    const suites = resolveRouteContext('/suites')
    expect(suites.title).toBe('场景集')

    const suiteRuns = resolveRouteContext('/suite-runs')
    expect(suiteRuns.title).toBe('集合运行')
    expect(suiteRuns.title).not.toBe('场景集')

    const suiteRunDetail = resolveRouteContext('/suite-runs/sr-123456')
    expect(suiteRunDetail.title).toBe('集合运行')
  })

  it('非菜单已登录合法路由兜底（/reports 等）', () => {
    const report = resolveRouteContext('/reports/rep-999')
    expect(report.title).toBe('测试报告')
    expect(report.page).toBe('other')
  })

  it('未知路由安全回退', () => {
    const fallback = resolveRouteContext('/some-nonexistent-path')
    expect(fallback.page).toBe('other')
    expect(fallback.title).toBe('识途平台')
  })

  it('遍历已登录路由树：断言每个已登录路由都能映射到合法页面类型与菜单名 (Acceptance Criterion 1)', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } })
    const allRoutes = Object.values(router.routesByPath)
    const authenticatedRoutes = allRoutes.filter((r) => {
      const fullPath = r.fullPath
      return (
        fullPath &&
        !fullPath.startsWith('/sign-in') &&
        !fullPath.startsWith('/401') &&
        !fullPath.startsWith('/403') &&
        !fullPath.startsWith('/404') &&
        !fullPath.startsWith('/500') &&
        !fullPath.startsWith('/503') &&
        !fullPath.startsWith('/public')
      )
    })

    expect(authenticatedRoutes.length).toBeGreaterThan(15)

    const allowedPages = new Set([
      'run',
      'scenario',
      'studio',
      'target',
      'session',
      'schedule',
      'dataset',
      'platform-config',
      'home',
      'other',
    ])

    for (const route of authenticatedRoutes) {
      const rawPath = route.fullPath
      const testPath = rawPath
        .replace(/\$([a-zA-Z0-9_]+)/g, 'mock-$1-id')
        .replace(/\/+/g, '/')

      const resolved = resolveRouteContext(testPath)
      expect(
        allowedPages.has(resolved.page),
        `Route ${rawPath} resolved to invalid page ${resolved.page}`,
      ).toBe(true)
      expect(resolved.title.trim().length, `Route ${rawPath} title is empty`).toBeGreaterThan(0)
      expect(
        resolved.statusLabel.trim().length,
        `Route ${rawPath} statusLabel is empty`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('toPageContext (契约数据转换)', () => {
  it('正确将 routeContext 转换为合法 AssistantPageContext', () => {
    const routeCtx = resolveRouteContext('/schedules')
    const pageCtx = toPageContext(routeCtx)
    expect(pageCtx).toMatchObject({
      version: 2,
      routeKey: 'schedule',
      pageKind: 'schedule',
      page: 'schedule',
    })
    expect(pageCtx?.primaryRef).toBeUndefined()
  })

  it('当存在 runId / scenarioId 等实体时生成 primaryRef', () => {
    const pageCtx = toPageContext({
      page: 'run',
      runId: 'run-8888',
    })
    expect(pageCtx).toMatchObject({
      version: 2,
      page: 'run',
      runId: 'run-8888',
      primaryRef: { kind: 'run', id: 'run-8888' },
    })
  })

  it('会话详情转换：正确映射 primaryRef、scopeRefs 与 view.selectedRef', () => {
    const pageCtx = toPageContext({
      page: 'session',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
      sessionId: 'sess-999',
    })
    expect(pageCtx).toMatchObject({
      version: 2,
      page: 'session',
      primaryRef: { kind: 'session', id: 'sess-999' },
      scopeRefs: [
        { kind: 'target', id: 'tgt-1' },
        { kind: 'account', id: 'acc-admin' },
      ],
      view: {
        selectedRef: { kind: 'session', id: 'sess-999' },
      },
    })
  })

  it('会话账号无实例时：回退映射 account 为 primaryRef', () => {
    const pageCtx = toPageContext({
      page: 'session',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
    })
    expect(pageCtx).toMatchObject({
      version: 2,
      page: 'session',
      primaryRef: { kind: 'account', id: 'acc-admin' },
      scopeRefs: [
        { kind: 'target', id: 'tgt-1' },
        { kind: 'account', id: 'acc-admin' },
      ],
    })
    expect(pageCtx?.view?.selectedRef).toBeUndefined()
  })
})
