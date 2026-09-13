import {
  DomainError,
  forbidden,
  getPlatformConfig,
  loadScenarioVersion,
  type DbHandle,
} from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  executableStepTypesFor,
  hasAiSteps,
  hasPermission,
  platformRuntimeDefaultsFrom,
  resolveAiExecutionFromPlatform,
  scenarioCapabilitiesFor,
  type AiExecutionConfig,
  type PlatformConfigDocument,
  type ScenarioCapabilities,
} from '@cairn/shared'
import { config } from './env'
import type { RequestAccount } from '../common/request-account'

export function platformDocumentOrFactory(document?: PlatformConfigDocument | null) {
  return document ?? FACTORY_PLATFORM_CONFIG
}

export function browserAiCapabilitiesFrom(
  document: PlatformConfigDocument,
  revision: number,
): ScenarioCapabilities {
  return scenarioCapabilitiesFor({
    browserAiEnabled: document.browserAi.enabled,
    defaults: platformRuntimeDefaultsFrom(document, revision),
  })
}

export function executableTypesFrom(document: PlatformConfigDocument = FACTORY_PLATFORM_CONFIG) {
  return executableStepTypesFor(document.browserAi.enabled)
}

export function resolveAiExecution(
  steps: readonly { type: string; policy?: { timeoutMs?: number; retryLimit?: number } }[],
  document: PlatformConfigDocument,
  extras: { revision: number; hangWaitMs?: number },
): AiExecutionConfig | undefined {
  try {
    return resolveAiExecutionFromPlatform(steps, document, {
      revision: extras.revision,
      hangWaitMs: extras.hangWaitMs ?? config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
    })
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AI_CONFIG_INVALID'
    throw new DomainError(
      'bad_request',
      code,
      error instanceof Error ? error.message : '浏览器仿真 AI 配置无效',
    )
  }
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

export async function loadPlatformForRuntime(db: DbHandle): Promise<{
  document: PlatformConfigDocument
  revision: number
}> {
  const current = await getPlatformConfig(db)
  return {
    document: platformDocumentOrFactory(current?.document),
    revision: current?.revision ?? 1,
  }
}

export async function resolveRunAiExecution(
  db: DbHandle,
  input: { scenarioId: string; scenarioVersionId?: string; actor: RequestAccount },
): Promise<AiExecutionConfig | undefined> {
  const { version } = await loadScenarioVersion(db, input.scenarioId, input.scenarioVersionId)
  assertAiExecutePermission(input.actor, version.definition.steps)
  const platform = await loadPlatformForRuntime(db)
  return resolveAiExecution(version.definition.steps, platform.document, {
    revision: platform.revision,
  })
}
