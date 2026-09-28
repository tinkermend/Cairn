import type { AssistantObjectRefKind, AssistantPageKind } from '@cairn/shared'

/** 路由参数到助手对象的映射：idParam 必须是该路由路径里的 `$参数`。 */
export interface RouteAssistantObjectRef {
  kind: AssistantObjectRefKind
  idParam: string
}

/** 叶路由在 staticData.assistant 上声明的助手元数据；pageKind / kind 取自 shared 契约，tsc 直接校验。 */
export interface RouteAssistantMeta {
  routeKey: string
  pageKind: AssistantPageKind
  primaryObject?: RouteAssistantObjectRef
  /** 复合路由的父级范围，例如会话账号页所属的 Target。 */
  scopeRefs?: readonly RouteAssistantObjectRef[]
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    assistant?: RouteAssistantMeta
  }
}
