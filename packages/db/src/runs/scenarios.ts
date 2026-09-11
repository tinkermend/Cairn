import { asc, count, desc, eq } from 'drizzle-orm'
import {
  ScenarioValidationError,
  scenarioDefinitionFromSteps,
  scenarioDetailSchema,
  scenarioListResponseSchema,
  scenarioSchema,
  scenarioVersionListResponseSchema,
  scenarioVersionSchema,
  validateScenarioDefinition,
  type ScenarioDefinition,
  type ScenarioDetailDto,
  type ScenarioDto,
  type ScenarioListResponse,
  type ScenarioStatus,
  type ScenarioVersionDto,
  type ScenarioVersionListResponse,
  type Step,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { runs, scenarioVersions, scenarios } from '../schema/execution.js'
import { targets } from '../schema/targets.js'
import { badRequest, conflict, mapPgRestriction, notFound } from './errors.js'

function iso(value: Date): string {
  return value.toISOString()
}

function rethrow(error: unknown): never {
  if (error instanceof ScenarioValidationError) {
    throw badRequest(error.code, error.message)
  }
  const mapped = mapPgRestriction(error)
  if (mapped) throw mapped
  throw error
}

async function latestVersion(db: Db, scenarioId: string) {
  const [row] = await db
    .select()
    .from(scenarioVersions)
    .where(eq(scenarioVersions.scenarioId, scenarioId))
    .orderBy(desc(scenarioVersions.versionNo))
    .limit(1)
  if (!row) throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
  return row
}

function toScenarioDto(
  row: typeof scenarios.$inferSelect,
  latest: typeof scenarioVersions.$inferSelect,
): ScenarioDto {
  return scenarioSchema.parse({
    id: row.id,
    targetId: row.targetId,
    name: row.name,
    status: row.status,
    latestVersionId: latest.id,
    latestVersionNo: latest.versionNo,
    stepCount: latest.definition.steps.length,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

export async function getScenario(db: Db, scenarioId: string): Promise<ScenarioDetailDto> {
  const [row] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const latest = await latestVersion(db, scenarioId)
  return scenarioDetailSchema.parse({
    ...toScenarioDto(row, latest),
    steps: latest.definition.steps,
  })
}

export async function listScenarios(db: Db): Promise<ScenarioListResponse> {
  const rows = await db.select().from(scenarios).orderBy(asc(scenarios.createdAt), asc(scenarios.id))
  const items: ScenarioDto[] = []
  for (const row of rows) {
    const latest = await latestVersion(db, row.id)
    items.push(toScenarioDto(row, latest))
  }
  return scenarioListResponseSchema.parse({ items })
}

export async function listScenarioVersions(db: Db, scenarioId: string): Promise<ScenarioVersionListResponse> {
  const [row] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const versions = await db
    .select()
    .from(scenarioVersions)
    .where(eq(scenarioVersions.scenarioId, scenarioId))
    .orderBy(asc(scenarioVersions.versionNo))
  return scenarioVersionListResponseSchema.parse({
    items: versions.map((version) =>
      scenarioVersionSchema.parse({
        id: version.id,
        scenarioId: version.scenarioId,
        versionNo: version.versionNo,
        definition: version.definition,
        createdAt: iso(version.createdAt),
      }),
    ),
  })
}

export async function createScenarioWithVersion(
  db: Db,
  input: {
    targetId: string
    name: string
    steps: Step[]
    status?: ScenarioStatus
    actor: AuditActor
  },
): Promise<ScenarioDetailDto> {
  const definition = validateDefinition(input.steps)
  const [target] = await db.select().from(targets).where(eq(targets.id, input.targetId)).limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能新建场景')

  const id = newId()
  const versionId = newId()
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      await tx.insert(scenarios).values({
        id,
        targetId: input.targetId,
        name: input.name,
        status: input.status ?? 'active',
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId: id,
        versionNo: 1,
        definition,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.create',
        'scenario',
        id,
        `创建了 ${definition.steps.length} 步的场景「${input.name}」`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, id)
}

export async function updateScenarioMeta(
  db: Db,
  scenarioId: string,
  input: { name?: string; status?: ScenarioStatus; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const [current] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(scenarios)
        .set({
          name: input.name ?? current.name,
          status: input.status ?? current.status,
          updatedAt: now,
        })
        .where(eq(scenarios.id, scenarioId))
      if (input.name !== undefined && input.name !== current.name) {
        await recordAudit(tx as unknown as Db, input.actor, 'scenario.update', 'scenario', scenarioId, `改名为 ${input.name}`)
      }
      if (input.status !== undefined && input.status !== current.status) {
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          input.status === 'disabled' ? '停用' : '启用',
        )
      }
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

export async function appendScenarioVersion(
  db: Db,
  scenarioId: string,
  input: { steps: Step[]; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const definition = validateDefinition(input.steps)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      // 锁住父场景行再取 max(version_no)+1：并发追加不会各自读到同一个号再撞唯一索引。
      const [current] = await tx
        .select({ id: scenarios.id })
        .from(scenarios)
        .where(eq(scenarios.id, scenarioId))
        .limit(1)
        .for('update')
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

      const latest = await latestVersion(tx as unknown as Db, scenarioId)
      const versionNo = latest.versionNo + 1
      await tx.insert(scenarioVersions).values({
        id: newId(),
        scenarioId,
        versionNo,
        definition,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `追加了 ${definition.steps.length} 步的版本 ${versionNo}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

export async function deleteScenario(db: Db, scenarioId: string, actor: AuditActor): Promise<void> {
  const [current] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const runCount = await countRunsForScenario(db, scenarioId)
  if (runCount > 0) throw conflict('SCENARIO_HAS_RUNS', '请先删除该场景下的运行')
  try {
    await db.transaction(async (tx) => {
      await tx.delete(scenarioVersions).where(eq(scenarioVersions.scenarioId, scenarioId))
      await tx.delete(scenarios).where(eq(scenarios.id, scenarioId))
      await recordAudit(tx as unknown as Db, actor, 'scenario.delete', 'scenario', scenarioId, current.name)
    })
  } catch (error) {
    rethrow(error)
  }
}

export async function countRunsForScenario(db: Db, scenarioId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(runs).where(eq(runs.scenarioId, scenarioId))
  return Number(row?.n ?? 0)
}

export async function countScenariosForTarget(db: Db, targetId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(scenarios).where(eq(scenarios.targetId, targetId))
  return Number(row?.n ?? 0)
}

export async function loadScenarioVersion(
  db: Db,
  scenarioId: string,
  versionId?: string,
): Promise<{ scenario: typeof scenarios.$inferSelect; version: typeof scenarioVersions.$inferSelect }> {
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  if (versionId) {
    const [version] = await db.select().from(scenarioVersions).where(eq(scenarioVersions.id, versionId)).limit(1)
    if (!version || version.scenarioId !== scenarioId) {
      throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
    }
    return { scenario, version }
  }
  return { scenario, version: await latestVersion(db, scenarioId) }
}

function isZodError(error: unknown): error is { issues: { message: string }[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  )
}

function validateDefinition(steps: Step[]): ScenarioDefinition {
  try {
    return validateScenarioDefinition(scenarioDefinitionFromSteps(steps))
  } catch (error) {
    if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
    if (isZodError(error)) {
      throw badRequest('BAD_REQUEST', error.issues[0]?.message ?? '场景定义不合法')
    }
    throw error
  }
}
