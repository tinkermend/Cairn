import type { IModelClient } from './model-types.js'

export interface ModelRouteConfig {
  readonly routeKey: string
  readonly modelName: string
  readonly provider: string
  readonly baseUrl?: string
}

export interface ModelRouter {
  getClient(routeKey: string): IModelClient
  getRouteConfig(routeKey: string): ModelRouteConfig
}

export const MODEL_ROUTER = Symbol('MODEL_ROUTER')

export class MockModelRouter implements ModelRouter {
  private readonly clients = new Map<string, IModelClient>()
  private readonly configs = new Map<string, ModelRouteConfig>()
  private defaultClient?: IModelClient

  setRoute(routeKey: string, client: IModelClient, config?: Partial<ModelRouteConfig>): this {
    this.clients.set(routeKey, client)
    this.configs.set(routeKey, {
      routeKey,
      modelName: config?.modelName ?? `mock-${routeKey}`,
      provider: config?.provider ?? 'mock-provider',
      baseUrl: config?.baseUrl ?? 'http://127.0.0.1:0',
    })
    return this
  }

  setDefaultClient(client: IModelClient): this {
    this.defaultClient = client
    return this
  }

  getClient(routeKey: string): IModelClient {
    const client = this.clients.get(routeKey) ?? this.defaultClient
    if (!client) {
      throw new Error(`[MockModelRouter] 未配置 routeKey 为 "${routeKey}" 的模型客户端且无默认客户端`)
    }
    return client
  }

  getRouteConfig(routeKey: string): ModelRouteConfig {
    const cfg = this.configs.get(routeKey)
    if (cfg) return cfg
    return {
      routeKey,
      modelName: `fallback-${routeKey}`,
      provider: 'mock-provider',
      baseUrl: 'http://127.0.0.1:0',
    }
  }

  configuredRoutes(): string[] {
    return Array.from(this.clients.keys())
  }
}
