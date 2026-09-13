import {
  FACTORY_PLATFORM_CONFIG,
  localSecretRef,
  platformConfigDocumentSchema,
  type PlatformConfigDocument,
} from '@cairn/shared'
import type { ApiEnv } from './env'

export function buildPlatformBootstrapDocument(
  env: ApiEnv,
  secretId?: string,
): { document: PlatformConfigDocument; reason: string } {
  const notes: string[] = ['初始化：按当前真实生效行为导入']
  const document: PlatformConfigDocument = {
    ...FACTORY_PLATFORM_CONFIG,
    browserAi: { ...FACTORY_PLATFORM_CONFIG.browserAi },
  }
  const complete = Boolean(
    env.CAIRN_BROWSER_AI_ENABLED &&
      env.CAIRN_BROWSER_AI_BASE_URL &&
      env.CAIRN_BROWSER_AI_MODEL &&
      env.CAIRN_BROWSER_AI_MODEL_FAMILY &&
      secretId,
  )
  if (complete) {
    document.browserAi = {
      enabled: true,
      baseUrl: env.CAIRN_BROWSER_AI_BASE_URL,
      model: env.CAIRN_BROWSER_AI_MODEL,
      modelFamily: env.CAIRN_BROWSER_AI_MODEL_FAMILY,
      secretRef: localSecretRef(secretId!),
      requestTimeoutMs: env.CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS,
      stepMaxCalls: env.CAIRN_BROWSER_AI_STEP_MAX_CALLS,
      maxOutputTokens: env.CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS,
    }
    notes.push('已导入当时生效的浏览器 AI 部署配置')
  } else if (env.CAIRN_BROWSER_AI_ENABLED) {
    notes.push('环境声称启用浏览器 AI 但配置不完整，已按未启用初始化')
  }
  notes.push('会话空闲/最大寿命按代码默认导入，未激活未被消费的会话 env')
  return {
    document: platformConfigDocumentSchema.parse(document),
    reason: notes.join('；'),
  }
}
