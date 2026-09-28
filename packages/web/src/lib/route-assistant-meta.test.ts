import { describe, expect, it } from 'vitest'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import type { RouteAssistantMeta } from './route-assistant-meta'

// 核心叶路由必须声明助手元数据；新增核心页时在这里登记。
const CORE_ROUTE_IDS = [
  '/_authenticated/',
  '/_authenticated/runs/',
  '/_authenticated/runs/$runId/',
  '/_authenticated/scenarios/',
  '/_authenticated/scenarios/$scenarioId/',
  '/_authenticated/targets/',
  '/_authenticated/targets/$targetId/',
  '/_authenticated/targets/$targetId/map/',
  '/_authenticated/platform-config/',
  '/_authenticated/sessions/',
  '/_authenticated/sessions/$targetId/',
  '/_authenticated/sessions/$targetId/$accountId/',
  '/_authenticated/schedules/',
  '/_authenticated/datasets/',
]

// 路由 id 在 router 初始化路由树时才生成；这里只建实例，不导航、不渲染。
const router = createRouter({ routeTree, context: { queryClient: undefined! } })
const routes = Object.values(router.routesById) as AnyRoute[]
const declared = routes
  .map((route) => ({ id: route.id as string, meta: route.options.staticData?.assistant }))
  .filter((entry): entry is { id: string; meta: RouteAssistantMeta } => Boolean(entry.meta))

function pathParams(id: string) {
  return new Set([...id.matchAll(/\$(\w+)/g)].map((match) => match[1]))
}

describe('路由助手元数据', () => {
  it('核心叶路由都存在且声明了 staticData.assistant', () => {
    const ids = new Set(routes.map((route) => route.id))
    for (const id of CORE_ROUTE_IDS) {
      expect(ids.has(id), `路由不存在：${id}`).toBe(true)
      expect(declared.some((entry) => entry.id === id), `缺少 staticData.assistant：${id}`).toBe(true)
    }
  })

  it('routeKey 全局唯一', () => {
    const keys = declared.map((entry) => entry.meta.routeKey)
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])
  })

  it('primaryObject / scopeRefs 引用的参数都在路由路径里', () => {
    for (const { id, meta } of declared) {
      const params = pathParams(id)
      for (const ref of [meta.primaryObject, ...(meta.scopeRefs ?? [])]) {
        if (ref) expect(params.has(ref.idParam), `${id} 引用了路径里没有的参数 ${ref.idParam}`).toBe(true)
      }
    }
  })

  it('带实体参数的详情页必须声明主对象，页面类型与对象种类对应', () => {
    for (const { id, meta } of declared) {
      const params = pathParams(id)
      if (params.size === 0) continue
      expect(meta.primaryObject, `${id} 必须声明 primaryObject`).toBeDefined()
      if (params.has('runId')) {
        expect(meta.pageKind, id).toBe('run')
        expect(meta.primaryObject?.kind, id).toBe('run')
      }
      if (params.has('scenarioId')) {
        expect(['studio', 'scenario'], id).toContain(meta.pageKind)
        expect(meta.primaryObject?.kind, id).toBe('scenario')
      }
      if (params.has('targetId')) {
        expect(['target', 'session'], id).toContain(meta.pageKind)
      }
      if (params.has('accountId')) {
        expect(meta.scopeRefs?.some((ref) => ref.idParam === 'targetId'), `${id} 必须用 scopeRefs 表达父级 Target`).toBe(true)
      }
    }
  })
})
