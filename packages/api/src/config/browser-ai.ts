import {
  DomainError,
  forbidden,
  loadScenarioVersion,
  type DbHandle,
} from '@cairn/db'
import {
  aiExecutionFromEnv,
  executableStepTypesFor,
  hasAiSteps,
  hasPermission,
  scenarioCapabilitiesFor,
  type AiExecutionConfig,
  type ScenarioCapabilities,
} from '@cairn/shared'
import { config } from './env'
import type { RequestAccount } from '../common/request-account'

export function browserAiCapabilities(): ScenarioCapabilities {
  return scenarioCapabilitiesFor({
    browserAiEnabled: config.CAIRN_BROWSER_AI_ENABLED,
  })
}

export function executableTypes(): string[] {
  return executableStepTypesFor(config.CAIRN_BROWSER_AI_ENABLED)
}

export function resolveAiExecution(steps: readonly { type: string }[]): AiExecutionConfig | undefined {
  if (!hasAiSteps(steps)) return undefined
  if (!config.CAIRN_BROWSER_AI_ENABLED) {
    throw new DomainError('bad_request', 'AI_DISABLED', '浏览器仿真 AI 未启用')
  }
  if (
    !config.CAIRN_BROWSER_AI_BASE_URL ||
    !config.CAIRN_BROWSER_AI_MODEL ||
    !config.CAIRN_BROWSER_AI_MODEL_FAMILY
  ) {
    throw new DomainError('bad_request', 'AI_CONFIG_INVALID', '浏览器仿真 AI 配置不完整')
  }
  return aiExecutionFromEnv({
    CAIRN_BROWSER_AI_BASE_URL: config.CAIRN_BROWSER_AI_BASE_URL,
    CAIRN_BROWSER_AI_MODEL: config.CAIRN_BROWSER_AI_MODEL,
    CAIRN_BROWSER_AI_MODEL_FAMILY: config.CAIRN_BROWSER_AI_MODEL_FAMILY,
    CAIRN_BROWSER_AI_API_KEY_SECRET_ID: config.CAIRN_BROWSER_AI_API_KEY_SECRET_ID,
    CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS: config.CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS,
    CAIRN_BROWSER_AI_HANG_WAIT_MS: config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
    CAIRN_BROWSER_AI_STEP_MAX_CALLS: config.CAIRN_BROWSER_AI_STEP_MAX_CALLS,
    CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS: config.CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS,
  })
}

export function assertAiExecutePermission(
  actor: RequestAccount,
  steps: readonly { type: string }[],
): void {
  if (!hasAiSteps(steps)) return
  if (!hasPermission(actor.permissions, 'ai:execute')) {
    throw forbidden('AI_EXECUTE_FORBIDDEN', '缺少 ai:execute，不能运行含 AI 步骤的场景')
  }
}

export async function resolveRunAiExecution(
  db: DbHandle,
  input: { scenarioId: string; scenarioVersionId?: string; actor: RequestAccount },
): Promise<AiExecutionConfig | undefined> {
  const { version } = await loadScenarioVersion(db, input.scenarioId, input.scenarioVersionId)
  assertAiExecutePermission(input.actor, version.definition.steps)
  return resolveAiExecution(version.definition.steps)
}
