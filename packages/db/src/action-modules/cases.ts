import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  compareModuleCaseOutputs,
  COMPILER_VERSION,
  MAX_TEST_BATCH_CASES,
  type CreateModuleTestCaseBody,
  type CreateModuleTestBatchBody,
  type ExecutionActor,
  type JsonValue,
  type ModuleCaseExecution,
  type ModuleCaseResult,
  type ModuleContent,
  type ModuleTestCase,
  type ModuleTestBatch,
  type RunModuleTestCaseBody,
  type ScenarioAuthoringDocumentV2,
  type UpdateModuleTestCaseBody,
} from '@cairn/shared'
import { expandAuthoringDocument, moduleContentDigest, type LoadedModuleVersion } from '@cairn/authoring'
import { atomic, locked, schemaFor } from '../native.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { sha256Hex, computeContentDigest, computeContractDigest } from './digest.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { createRunWithSnapshot } from '../runs/runs.js'
import { getOrCreateModuleVerificationScenario } from '../runs/scenarios.js'
import { recordAudit } from '../audit/record.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iso(date: Date | string | null | undefined): string {
  if (!date) return new Date().toISOString()
  return typeof date === 'string' ? date : date.toISOString()
}

function unwrapDb(db: any): Db {
  return db && typeof db === 'object' && 'db' in db ? db.db : db
}

export function computeSampleReview(
  inputs: Record<string, unknown>,
  expectedOutputs: Record<string, unknown>,
  confirmed = true,
  reviewedBy = 'system',
  reviewedAt = new Date().toISOString(),
) {
  return {
    reviewedBy,
    reviewedAt,
    inputsDigest: sha256Hex(inputs),
    outputsDigest: sha256Hex(expectedOutputs),
    confirmed,
  }
}

async function writableModule(
  db: Db,
  moduleId: string,
  actorId: string,
  permission = 'module:write',
) {
  await lockConsoleAuthorization(db, actorId)
  const { actionModules, targets } = schemaFor(db)
  const [candidate] = await db
    .select({ targetId: actionModules.targetId })
    .from(actionModules)
    .where(eq(actionModules.id, moduleId))
  if (!candidate) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  const [target] = await locked(
    db,
    db.select().from(targets).where(eq(targets.id, candidate.targetId)),
  )
  if (!target || target.deletedAt) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  const [module] = await locked(
    db,
    db
      .select()
      .from(actionModules)
      .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt))),
  )
  if (!module) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  await assertTargetPermission(db, actorId, module.targetId, permission)
  return module
}

function verifySampleReview(
  inputs: Record<string, unknown>,
  expectedOutputs: Record<string, unknown>,
  review: { inputsDigest: string; outputsDigest: string; confirmed: boolean },
) {
  if (!review.confirmed) {
    throw badRequest('MODULE_CASE_REVIEW_REQUIRED', '保存用例前必须确认样本审阅')
  }
  const inDigest = sha256Hex(inputs)
  const outDigest = sha256Hex(expectedOutputs)
  if (review.inputsDigest !== inDigest || review.outputsDigest !== outDigest) {
    throw badRequest('MODULE_CASE_REVIEW_REQUIRED', '样本输入或预期输出与审阅摘要不一致，请重新审阅确认')
  }
}

// ---------------------------------------------------------------------------
// 1. List Module Test Cases
// ---------------------------------------------------------------------------

export async function listModuleTestCases(
  db: Db,
  moduleId: string,
  actorId?: string,
): Promise<{ items: (ModuleTestCase & { latestResult?: ModuleCaseResult })[] }> {
  const uDb = unwrapDb(db)
  const { actionModules, moduleTestCases, moduleCaseExecutions, moduleCaseResults } = schemaFor(uDb)
  const [mod] = await uDb
    .select({ targetId: actionModules.targetId })
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
  if (!mod) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  if (actorId) await assertTargetPermission(uDb, actorId, mod.targetId, 'module:read')

  const cases = await uDb
    .select()
    .from(moduleTestCases)
    .where(eq(moduleTestCases.moduleId, moduleId))
    .orderBy(desc(moduleTestCases.createdAt))

  if (cases.length === 0) return { items: [] }

  const caseIds = cases.map((c) => c.id)

  // Load latest execution results for these cases
  const execs = await uDb
    .select({
      caseId: moduleCaseExecutions.caseId,
      executionId: moduleCaseExecutions.id,
      runId: moduleCaseExecutions.runId,
      resultId: moduleCaseResults.id,
      revision: moduleCaseResults.revision,
      status: moduleCaseResults.status,
      outcomeMatched: moduleCaseResults.outcomeMatched,
      outputsMatched: moduleCaseResults.outputsMatched,
      evidenceComplete: moduleCaseResults.evidenceComplete,
      failureReason: moduleCaseResults.failureReason,
      details: moduleCaseResults.details,
      projectorVersion: moduleCaseResults.projectorVersion,
      createdAt: moduleCaseResults.createdAt,
      settledAt: moduleCaseResults.settledAt,
    })
    .from(moduleCaseExecutions)
    .innerJoin(moduleCaseResults, eq(moduleCaseResults.executionId, moduleCaseExecutions.id))
    .where(inArray(moduleCaseExecutions.caseId, caseIds))
    .orderBy(desc(moduleCaseExecutions.createdAt), desc(moduleCaseResults.revision))

  const latestResultByCase = new Map<string, ModuleCaseResult>()
  for (const e of execs) {
    if (!latestResultByCase.has(e.caseId)) {
      latestResultByCase.set(e.caseId, {
        id: e.resultId,
        executionId: e.executionId,
        caseId: e.caseId,
        runId: e.runId,
        revision: e.revision,
        status: e.status,
        outcomeMatched: e.outcomeMatched ?? undefined,
        outputsMatched: e.outputsMatched ?? undefined,
        evidenceComplete: e.evidenceComplete ?? undefined,
        failureReason: e.failureReason ?? undefined,
        details: (e.details as Record<string, JsonValue>) ?? undefined,
        projectorVersion: e.projectorVersion,
        createdAt: iso(e.createdAt),
        settledAt: e.settledAt ? iso(e.settledAt) : undefined,
      })
    }
  }

  const items = cases.map((c) => ({
    id: c.id,
    moduleId: c.moduleId,
    name: c.name,
    revision: c.revision,
    contractDigest: c.contractDigest,
    inputs: c.inputs as Record<string, JsonValue>,
    expectedModuleOutcome: c.expectedModuleOutcome,
    expectedFailureCode: c.expectedFailureCode ?? undefined,
    expectedOutputs: c.expectedOutputs as Record<string, JsonValue>,
    implementationKey: c.implementationKey,
    releaseGate: c.releaseGate,
    targetAccountId: c.targetAccountId ?? undefined,
    sampleReview: c.sampleReview,
    status: c.status,
    createdBy: c.createdBy,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
    latestResult: latestResultByCase.get(c.id),
  }))

  return { items }
}

// ---------------------------------------------------------------------------
// 2. Get Module Test Case
// ---------------------------------------------------------------------------

export async function getModuleTestCase(
  db: Db,
  moduleId: string,
  caseId: string,
  actorId?: string,
): Promise<ModuleTestCase & { latestResult?: ModuleCaseResult }> {
  const uDb = unwrapDb(db)
  const { actionModules, moduleTestCases, moduleCaseExecutions, moduleCaseResults } = schemaFor(uDb)
  const [mod] = await uDb
    .select({ targetId: actionModules.targetId })
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
  if (!mod) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  if (actorId) await assertTargetPermission(uDb, actorId, mod.targetId, 'module:read')

  const [row] = await uDb
    .select()
    .from(moduleTestCases)
    .where(and(eq(moduleTestCases.id, caseId), eq(moduleTestCases.moduleId, moduleId)))
    .limit(1)

  if (!row) throw notFound('MODULE_CASE_NOT_FOUND', '测试用例不存在')

  const [latestExec] = await uDb
    .select({
      caseId: moduleCaseExecutions.caseId,
      executionId: moduleCaseExecutions.id,
      runId: moduleCaseExecutions.runId,
      resultId: moduleCaseResults.id,
      revision: moduleCaseResults.revision,
      status: moduleCaseResults.status,
      outcomeMatched: moduleCaseResults.outcomeMatched,
      outputsMatched: moduleCaseResults.outputsMatched,
      evidenceComplete: moduleCaseResults.evidenceComplete,
      failureReason: moduleCaseResults.failureReason,
      details: moduleCaseResults.details,
      projectorVersion: moduleCaseResults.projectorVersion,
      createdAt: moduleCaseResults.createdAt,
      settledAt: moduleCaseResults.settledAt,
    })
    .from(moduleCaseExecutions)
    .innerJoin(moduleCaseResults, eq(moduleCaseResults.executionId, moduleCaseExecutions.id))
    .where(eq(moduleCaseExecutions.caseId, caseId))
    .orderBy(desc(moduleCaseExecutions.createdAt), desc(moduleCaseResults.revision))
    .limit(1)

  return {
    id: row.id,
    moduleId: row.moduleId,
    name: row.name,
    revision: row.revision,
    contractDigest: row.contractDigest,
    inputs: row.inputs as Record<string, JsonValue>,
    expectedModuleOutcome: row.expectedModuleOutcome,
    expectedFailureCode: row.expectedFailureCode ?? undefined,
    expectedOutputs: row.expectedOutputs as Record<string, JsonValue>,
    implementationKey: row.implementationKey,
    releaseGate: row.releaseGate,
    targetAccountId: row.targetAccountId ?? undefined,
    sampleReview: row.sampleReview,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    latestResult: latestExec
      ? {
          id: latestExec.resultId,
          executionId: latestExec.executionId,
          caseId: latestExec.caseId,
          runId: latestExec.runId,
          revision: latestExec.revision,
          status: latestExec.status,
          outcomeMatched: latestExec.outcomeMatched ?? undefined,
          outputsMatched: latestExec.outputsMatched ?? undefined,
          evidenceComplete: latestExec.evidenceComplete ?? undefined,
          failureReason: latestExec.failureReason ?? undefined,
          details: (latestExec.details as Record<string, JsonValue>) ?? undefined,
          projectorVersion: latestExec.projectorVersion,
          createdAt: iso(latestExec.createdAt),
          settledAt: latestExec.settledAt ? iso(latestExec.settledAt) : undefined,
        }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// 3. Create Module Test Case
// ---------------------------------------------------------------------------

export async function createModuleTestCase(
  db: Db,
  moduleId: string,
  input: CreateModuleTestCaseBody & { actor: ExecutionActor },
): Promise<ModuleTestCase> {
  const { moduleTestCases } = schemaFor(db)
  const now = new Date()

  verifySampleReview(input.inputs, input.expectedOutputs, input.sampleReview)

  return atomic(db, async (tx) => {
    const mod = await writableModule(tx as unknown as Db, moduleId, input.actor.id)
    if (!mod.draftContent) {
      throw badRequest('MODULE_IMPLEMENTATION_EMPTY', '草稿为空，不能创建用例')
    }
    const content = mod.draftContent as ModuleContent
    const contractDigest = computeContractDigest(content.contract)
    const id = newId()

    await tx.insert(moduleTestCases).values({
      id,
      moduleId,
      name: input.name,
      revision: 1,
      contractDigest,
      inputs: input.inputs,
      expectedModuleOutcome: input.expectedModuleOutcome,
      expectedFailureCode: input.expectedFailureCode,
      expectedOutputs: input.expectedOutputs,
      implementationKey: input.implementationKey,
      releaseGate: input.releaseGate,
      targetAccountId: input.targetAccountId,
      sampleReview: input.sampleReview,
      status: 'ACTIVE',
      createdBy: input.actor.id,
      createdAt: now,
      updatedAt: now,
    })

    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'module_case.create',
      'module',
      moduleId,
      `创建测试用例：${input.name}`,
    )

    return getModuleTestCase(tx as unknown as Db, moduleId, id)
  })
}

// ---------------------------------------------------------------------------
// 4. Update Module Test Case
// ---------------------------------------------------------------------------

export async function updateModuleTestCase(
  db: Db,
  moduleId: string,
  caseId: string,
  input: UpdateModuleTestCaseBody & { actor: ExecutionActor },
): Promise<ModuleTestCase> {
  const { moduleTestCases } = schemaFor(db)
  const now = new Date()

  return atomic(db, async (tx) => {
    const mod = await writableModule(tx as unknown as Db, moduleId, input.actor.id)
    const [existing] = await locked(
      tx,
      tx.select().from(moduleTestCases).where(and(eq(moduleTestCases.id, caseId), eq(moduleTestCases.moduleId, moduleId))),
    )
    if (!existing) throw notFound('MODULE_CASE_NOT_FOUND', '测试用例不存在')

    const baseRevision = input.baseRevision ?? (input as any).revision
    if (existing.revision !== baseRevision) {
      throw conflict('MODULE_CASE_CONFLICT', '测试用例已被他人更新', {
        currentRevision: existing.revision,
      })
    }

    const nextInputs = input.inputs ?? (existing.inputs as Record<string, JsonValue>)
    const nextOutputs = input.expectedOutputs ?? (existing.expectedOutputs as Record<string, JsonValue>)

    if (input.inputs !== undefined || input.expectedOutputs !== undefined) {
      if (!input.sampleReview) {
        throw badRequest('MODULE_CASE_REVIEW_REQUIRED', '修改输入或预期输出须提交审阅凭据')
      }
      verifySampleReview(nextInputs, nextOutputs, input.sampleReview)
    }

    const content = mod.draftContent as ModuleContent | undefined
    const currentContractDigest = content ? computeContractDigest(content.contract) : existing.contractDigest

    const patch: Record<string, unknown> = {
      revision: existing.revision + 1,
      contractDigest: currentContractDigest,
      updatedAt: now,
    }
    if (input.name !== undefined) patch.name = input.name
    if (input.inputs !== undefined) patch.inputs = input.inputs
    if (input.expectedModuleOutcome !== undefined) patch.expectedModuleOutcome = input.expectedModuleOutcome
    if (input.expectedFailureCode !== undefined) patch.expectedFailureCode = input.expectedFailureCode
    if (input.expectedOutputs !== undefined) patch.expectedOutputs = input.expectedOutputs
    if (input.implementationKey !== undefined) patch.implementationKey = input.implementationKey
    if (input.releaseGate !== undefined) patch.releaseGate = input.releaseGate
    if (input.targetAccountId !== undefined) patch.targetAccountId = input.targetAccountId
    if (input.sampleReview !== undefined) patch.sampleReview = input.sampleReview
    if (input.status !== undefined) patch.status = input.status

    await tx.update(moduleTestCases).set(patch).where(eq(moduleTestCases.id, caseId))

    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'module_case.update',
      'module',
      moduleId,
      `更新测试用例 r${existing.revision + 1}：${patch.name ?? existing.name}`,
    )

    return getModuleTestCase(tx as unknown as Db, moduleId, caseId)
  })
}

// ---------------------------------------------------------------------------
// 5. Delete Module Test Case
// ---------------------------------------------------------------------------

export async function deleteModuleTestCase(
  db: Db,
  moduleId: string,
  caseId: string,
  actor: ExecutionActor,
): Promise<{ success: boolean }> {
  const { moduleTestCases } = schemaFor(db)
  return atomic(db, async (tx) => {
    await writableModule(tx as unknown as Db, moduleId, actor.id)
    const [existing] = await locked(
      tx,
      tx.select().from(moduleTestCases).where(and(eq(moduleTestCases.id, caseId), eq(moduleTestCases.moduleId, moduleId))),
    )
    if (!existing) throw notFound('MODULE_CASE_NOT_FOUND', '测试用例不存在')

    await tx.delete(moduleTestCases).where(eq(moduleTestCases.id, caseId))

    await recordAudit(
      tx as unknown as Db,
      actor,
      'module_case.delete',
      'module',
      moduleId,
      `删除测试用例：${existing.name}`,
    )

    return { success: true }
  })
}

// ---------------------------------------------------------------------------
// 6. Run Module Test Case
// ---------------------------------------------------------------------------

export async function runModuleTestCase(
  db: Db,
  moduleId: string,
  caseId: string,
  input: RunModuleTestCaseBody & { actor: ExecutionActor },
): Promise<{ executionId: string; runId: string; caseId: string; status: string }> {
  const {
    actionModules,
    actionModuleVersions,
    moduleTestCases,
    moduleCaseExecutions,
    moduleCaseResults,
    scenarioVersions,
  } = schemaFor(db)

  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx as unknown as Db, input.actor.id)
    const [testCase] = await locked(
      tx,
      tx.select().from(moduleTestCases).where(and(eq(moduleTestCases.id, caseId), eq(moduleTestCases.moduleId, moduleId))),
    )
    if (!testCase) throw notFound('MODULE_CASE_NOT_FOUND', '测试用例不存在')

    const [mod] = await locked(
      tx,
      tx.select().from(actionModules).where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt))),
    )
    if (!mod) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
    await assertTargetPermission(tx as unknown as Db, input.actor.id, mod.targetId, 'run:execute')

    let content: ModuleContent
    let moduleDraftRevision: number | undefined
    let moduleVersionId: string | undefined

    if (input.mode === 'published') {
      const [latest] = await tx
        .select()
        .from(actionModuleVersions)
        .where(eq(actionModuleVersions.moduleId, moduleId))
        .orderBy(desc(actionModuleVersions.versionNo))
        .limit(1)
      if (!latest) throw badRequest('MODULE_NOT_PUBLISHED', '模块尚未发布正式版本')
      content = latest.content as ModuleContent
      moduleVersionId = latest.id
    } else {
      if (!mod.draftContent) throw badRequest('MODULE_IMPLEMENTATION_EMPTY', '草稿为空，不能执行用例')
      content = mod.draftContent as ModuleContent
      moduleDraftRevision = mod.draftRevision
    }

    const currentContractDigest = computeContractDigest(content.contract)
    if (testCase.contractDigest !== currentContractDigest) {
      await tx
        .update(moduleTestCases)
        .set({ status: 'INCOMPATIBLE', updatedAt: new Date() })
        .where(eq(moduleTestCases.id, caseId))
      throw badRequest('MODULE_CASE_INCOMPATIBLE', '用例契约摘要与当前模块不一致，需重新审阅并更新预期')
    }

    const contentDigest = computeContentDigest(content)
    const implementationKey = testCase.implementationKey
    if (!content.implementations.some((impl) => impl.implementationKey === implementationKey)) {
      throw badRequest('MODULE_IMPLEMENTATION_UNKNOWN', `模块没有实现「${implementationKey}」`)
    }

    const { scenarioId } = await getOrCreateModuleVerificationScenario(tx as unknown as Db, {
      moduleId,
      actor: input.actor,
    })

    // Construct single-invocation authoring document
    const inputBindings: Record<string, { kind: 'literal'; value: unknown }> = {}
    for (const [k, v] of Object.entries((testCase.inputs as Record<string, JsonValue>) ?? {})) {
      inputBindings[k] = { kind: 'literal', value: v }
    }

    const outputBindings: Record<string, string> = {}
    for (const out of content.contract.outputs) {
      outputBindings[out.key] = out.key
    }

    const authoringDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId: newId(),
          name: `用例验证 [${testCase.name}]`,
          moduleId: mod.id,
          moduleDraft: moduleDraftRevision !== undefined
            ? {
                moduleId: mod.id,
                revision: moduleDraftRevision,
                contentDigest,
              }
            : undefined,
          moduleVersionId,
          implementationKey,
          inputBindings: inputBindings as any,
          outputBindings,
        },
      ],
    }

    const loadedModule: LoadedModuleVersion = {
      moduleId: mod.id,
      targetId: mod.targetId,
      name: mod.name,
      moduleKey: mod.key,
      versionId: moduleVersionId,
      draftRevision: moduleDraftRevision,
      versionNo: 1,
      publicationStatus: (input.mode === 'published' ? 'published' : 'draft') as any,
      content,
      contentDigest,
      contractDigest: currentContractDigest,
      implementationDigest: sha256Hex(content.implementations),
    }

    const loadedModules = new Map<string, LoadedModuleVersion>()
    if (loadedModule.versionId) {
      loadedModules.set(loadedModule.versionId, loadedModule)
    } else {
      loadedModules.set(loadedModule.moduleId, loadedModule)
    }

    const expansion = expandAuthoringDocument(authoringDoc, {
      targetId: mod.targetId,
      mode: 'trial',
      loadedModules,
    })

    if (!expansion.ok || !expansion.definition) {
      throw badRequest('MODULE_COMPILE_BLOCKED', '用例场景展开失败', {
        diagnostics: expansion.diagnostics,
      })
    }

    // Synthesize independent scenario version
    const versionId = newId()
    const now = new Date()

    await tx.insert(scenarioVersions).values({
      id: versionId,
      scenarioId,
      versionNo: null,
      kind: 'trial',
      definition: expansion.definition,
      moduleManifest: expansion.manifest,
      sourceDigest: expansion.sourceDigest,
      compilerVersion: COMPILER_VERSION,
      createdByConsoleAccountId: input.actor.id,
      createdAt: now,
    })

    // Create Run
    const { detail: runDetail } = await createRunWithSnapshot(tx as unknown as Db, {
      scenarioId,
      scenarioVersionId: versionId,
      targetAccountId: input.targetAccountId ?? testCase.targetAccountId ?? undefined,
      input: {},
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      debugMode: 'runThrough',
      allowTrialVersion: true,
    })

    const executionId = newId()
    await tx.insert(moduleCaseExecutions).values({
      id: executionId,
      caseId: testCase.id,
      moduleId,
      caseRevision: testCase.revision,
      runId: runDetail.id,
      comparatorVersion: 'v1',
      moduleDraftRevision,
      moduleVersionId,
      contentDigest,
      implementationKey,
      targetAccountId: input.targetAccountId ?? testCase.targetAccountId,
      frozenInputs: testCase.inputs as Record<string, JsonValue>,
      frozenExpectedOutcome: testCase.expectedModuleOutcome,
      frozenExpectedFailureCode: testCase.expectedFailureCode,
      frozenExpectedOutputs: testCase.expectedOutputs as Record<string, JsonValue>,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.actor.id,
      createdAt: now,
    })

    await tx.insert(moduleCaseResults).values({
      id: newId(),
      executionId,
      caseId: testCase.id,
      runId: runDetail.id,
      revision: 1,
      status: 'PENDING',
      createdAt: now,
    })

    const execution: ModuleCaseExecution = {
      id: executionId,
      caseId: testCase.id,
      moduleId,
      caseRevision: testCase.revision,
      runId: runDetail.id,
      comparatorVersion: 'v1',
      moduleDraftRevision,
      moduleVersionId,
      contentDigest,
      implementationKey,
      targetAccountId: input.targetAccountId ?? testCase.targetAccountId ?? undefined,
      frozenInputs: testCase.inputs as Record<string, JsonValue>,
      frozenExpectedOutcome: testCase.expectedModuleOutcome,
      frozenExpectedFailureCode: testCase.expectedFailureCode ?? undefined,
      frozenExpectedOutputs: testCase.expectedOutputs as Record<string, JsonValue>,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.actor.id,
      createdAt: iso(now),
    }

    return {
      execution,
      run: runDetail,
      executionId,
      runId: runDetail.id,
      caseId: testCase.id,
      status: 'PENDING',
    }
  })
}

// ---------------------------------------------------------------------------
// 7. Settle Module Case Result (结算器)
// ---------------------------------------------------------------------------

export async function settleModuleCaseResult(db: Db, runId: string): Promise<void> {
  const uDb = unwrapDb(db)
  const {
    moduleCaseExecutions,
    moduleCaseResults,
    moduleInvocationResults,
    moduleTestBatches,
    runs,
  } = schemaFor(uDb)

  const [execution] = await uDb
    .select()
    .from(moduleCaseExecutions)
    .where(eq(moduleCaseExecutions.runId, runId))
    .limit(1)

  if (!execution) return

  await atomic(uDb, async (tx) => {
    const [runRow] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!runRow) return

    const [invResult] = await tx
      .select()
      .from(moduleInvocationResults)
      .where(eq(moduleInvocationResults.runId, runId))
      .limit(1)

    const actualOutcome = invResult?.outcome ?? (runRow.status === 'SUCCEEDED' ? 'VERIFIED' : 'FAILED_IMPLEMENTATION')
    const actualErrorCode = invResult?.errorCode ?? (runRow.status === 'FAILED' ? 'EXECUTION_FAILED' : undefined)

    // Check outcome match
    let outcomeMatched = actualOutcome === execution.frozenExpectedOutcome
    if (outcomeMatched && execution.frozenExpectedFailureCode) {
      outcomeMatched = actualErrorCode === execution.frozenExpectedFailureCode
    }

    // Check outputs match
    const actualOutputs = (runRow.context as Record<string, unknown>) ?? {}
    const { matched: outputsMatched, mismatches } = compareModuleCaseOutputs(
      execution.frozenExpectedOutputs as Record<string, unknown>,
      actualOutputs,
    )

    // Check evidence completeness
    const evidenceComplete = invResult ? invResult.verificationStrength === 'sufficient' : true

    let status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'FAIL'
    let failureReason: string | undefined

    if (runRow.status === 'NEEDS_REVIEW' || actualOutcome === 'NEEDS_REVIEW') {
      status = 'INCONCLUSIVE'
      failureReason = '运行需要人工复审 (NEEDS_REVIEW)'
    } else if (runRow.status === 'CANCELLED' || actualOutcome === 'CANCELLED') {
      status = 'INCONCLUSIVE'
      failureReason = '执行已取消'
    } else if (invResult?.attribution === 'EXTERNAL_INFRA') {
      status = 'INCONCLUSIVE'
      failureReason = `基础设施故障 (${invResult.errorCode ?? 'INFRA_ERROR'})`
    } else if (outcomeMatched && outputsMatched && evidenceComplete) {
      status = 'PASS'
    } else {
      status = 'FAIL'
      const reasons: string[] = []
      if (!outcomeMatched) {
        reasons.push(`模块结果不匹配：预期 ${execution.frozenExpectedOutcome}${execution.frozenExpectedFailureCode ? `(${execution.frozenExpectedFailureCode})` : ''}，实际 ${actualOutcome}${actualErrorCode ? `(${actualErrorCode})` : ''}`)
      }
      if (!outputsMatched) {
        reasons.push(`输出不匹配：${Object.keys(mismatches).join('、')}`)
      }
      if (!evidenceComplete) {
        reasons.push('证据不完整')
      }
      failureReason = reasons.join('；')
    }

    const now = new Date()
    await tx
      .update(moduleCaseResults)
      .set({
        status,
        outcomeMatched,
        outputsMatched,
        evidenceComplete,
        failureReason,
        details: { mismatches: mismatches as unknown as JsonValue, actualOutcome, actualErrorCode: actualErrorCode ?? null } as Record<string, JsonValue>,
        settledAt: now,
      })
      .where(and(eq(moduleCaseResults.executionId, execution.id), eq(moduleCaseResults.revision, 1)))

    // Check if this execution belongs to a batch
    const batches = await tx
      .select()
      .from(moduleTestBatches)
      .where(and(eq(moduleTestBatches.moduleId, execution.moduleId), eq(moduleTestBatches.status, 'RUNNING')))

    for (const b of batches) {
      const ids = (b.caseExecutionIds as string[]) ?? []
      if (ids.includes(execution.id)) {
        const nextPassed = b.passedCases + (status === 'PASS' ? 1 : 0)
        const nextFailed = b.failedCases + (status !== 'PASS' ? 1 : 0)
        const allDone = nextPassed + nextFailed >= b.totalCases

        await tx
          .update(moduleTestBatches)
          .set({
            passedCases: nextPassed,
            failedCases: nextFailed,
            status: allDone ? 'COMPLETED' : (status === 'INCONCLUSIVE' ? 'HALTED' : 'RUNNING'),
            haltReason: status === 'INCONCLUSIVE' ? `用例执行异常停派：${failureReason}` : undefined,
            updatedAt: now,
          })
          .where(eq(moduleTestBatches.id, b.id))
      }
    }
  })
}

// ---------------------------------------------------------------------------
// 8. Recompute Module Case Result
// ---------------------------------------------------------------------------

export async function recomputeModuleCaseResult(
  db: Db,
  executionId: string,
  actorId: string,
): Promise<ModuleCaseResult> {
  const { moduleCaseExecutions, moduleCaseResults, moduleInvocationResults, runs } = schemaFor(db)

  return atomic(db, async (tx) => {
    const [execution] = await locked(
      tx,
      tx.select().from(moduleCaseExecutions).where(eq(moduleCaseExecutions.id, executionId)),
    )
    if (!execution) throw notFound('MODULE_CASE_EXECUTION_NOT_FOUND', '执行快照不存在')

    const [runRow] = await tx.select().from(runs).where(eq(runs.id, execution.runId)).limit(1)
    if (!runRow) throw notFound('RUN_NOT_FOUND', 'Run 不存在')

    const [invResult] = await tx
      .select()
      .from(moduleInvocationResults)
      .where(eq(moduleInvocationResults.runId, execution.runId))
      .limit(1)

    const actualOutcome = invResult?.outcome ?? (runRow.status === 'SUCCEEDED' ? 'VERIFIED' : 'FAILED_IMPLEMENTATION')
    const actualErrorCode = invResult?.errorCode ?? (runRow.status === 'FAILED' ? 'EXECUTION_FAILED' : undefined)

    let outcomeMatched = actualOutcome === execution.frozenExpectedOutcome
    if (outcomeMatched && execution.frozenExpectedFailureCode) {
      outcomeMatched = actualErrorCode === execution.frozenExpectedFailureCode
    }

    const actualOutputs = (runRow.context as Record<string, unknown>) ?? {}
    const { matched: outputsMatched, mismatches } = compareModuleCaseOutputs(
      execution.frozenExpectedOutputs as Record<string, unknown>,
      actualOutputs,
    )
    const evidenceComplete = invResult ? invResult.verificationStrength === 'sufficient' : true

    let status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'FAIL'
    let failureReason: string | undefined

    if (runRow.status === 'NEEDS_REVIEW' || actualOutcome === 'NEEDS_REVIEW') {
      status = 'INCONCLUSIVE'
      failureReason = '运行需要人工复审 (NEEDS_REVIEW)'
    } else if (runRow.status === 'CANCELLED' || actualOutcome === 'CANCELLED') {
      status = 'INCONCLUSIVE'
      failureReason = '执行已取消'
    } else if (invResult?.attribution === 'EXTERNAL_INFRA') {
      status = 'INCONCLUSIVE'
      failureReason = `基础设施故障 (${invResult.errorCode ?? 'INFRA_ERROR'})`
    } else if (outcomeMatched && outputsMatched && evidenceComplete) {
      status = 'PASS'
    } else {
      status = 'FAIL'
      const reasons: string[] = []
      if (!outcomeMatched) reasons.push(`结果不匹配：预期 ${execution.frozenExpectedOutcome}，实际 ${actualOutcome}`)
      if (!outputsMatched) reasons.push(`输出不匹配：${Object.keys(mismatches).join('、')}`)
      if (!evidenceComplete) reasons.push('证据不完整')
      failureReason = reasons.join('；')
    }

    const [maxRev] = await tx
      .select({ maxRev: sql<number>`MAX(${moduleCaseResults.revision})` })
      .from(moduleCaseResults)
      .where(eq(moduleCaseResults.executionId, executionId))
    const nextRev = (maxRev?.maxRev ?? 1) + 1
    const resultId = newId()
    const now = new Date()

    const details: Record<string, JsonValue> = {
      mismatches: mismatches as unknown as JsonValue,
      actualOutcome,
      actualErrorCode: actualErrorCode ?? null,
    }

    await tx.insert(moduleCaseResults).values({
      id: resultId,
      executionId,
      caseId: execution.caseId,
      runId: execution.runId,
      revision: nextRev,
      status,
      outcomeMatched,
      outputsMatched,
      evidenceComplete,
      failureReason,
      details,
      projectorVersion: 'v1',
      createdAt: now,
      settledAt: now,
    })

    return {
      id: resultId,
      executionId,
      caseId: execution.caseId,
      runId: execution.runId,
      revision: nextRev,
      status,
      outcomeMatched,
      outputsMatched,
      evidenceComplete,
      failureReason,
      details,
      projectorVersion: 'v1',
      createdAt: iso(now),
      settledAt: iso(now),
    }
  })
}

// ---------------------------------------------------------------------------
// 9. Create Module Test Batch
// ---------------------------------------------------------------------------

export async function createModuleTestBatch(
  db: Db,
  moduleId: string,
  input: CreateModuleTestBatchBody & { actor: ExecutionActor },
): Promise<ModuleTestBatch> {
  if (input.caseIds.length === 0) {
    throw badRequest('INVALID_ARGUMENT', '用例列表不能为空')
  }
  if (input.caseIds.length > MAX_TEST_BATCH_CASES) {
    throw badRequest('BATCH_LIMIT_EXCEEDED', `批量回归每次最多执行 ${MAX_TEST_BATCH_CASES} 条用例`)
  }

  const { actionModules, moduleTestBatches, moduleTestCases } = schemaFor(db)
  const now = new Date()

  return atomic(db, async (tx) => {
    const [mod] = await locked(
      tx,
      tx.select().from(actionModules).where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt))),
    )
    if (!mod) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
    await assertTargetPermission(tx as unknown as Db, input.actor.id, mod.targetId, 'run:execute')

    const cases = await tx
      .select()
      .from(moduleTestCases)
      .where(and(eq(moduleTestCases.moduleId, moduleId), inArray(moduleTestCases.id, input.caseIds)))

    if (cases.length !== input.caseIds.length) {
      throw badRequest('MODULE_CASE_NOT_FOUND', '部分用例不存在或不属于当前模块')
    }

    const executionIds: string[] = []
    for (const c of cases) {
      const res = await runModuleTestCase(tx as unknown as Db, moduleId, c.id, {
        targetAccountId: input.targetAccountId,
        mode: 'draft',
        actor: input.actor,
      })
      executionIds.push(res.executionId)
    }

    const batchId = newId()
    await tx.insert(moduleTestBatches).values({
      id: batchId,
      moduleId,
      targetId: mod.targetId,
      targetAccountId: input.targetAccountId,
      totalCases: cases.length,
      passedCases: 0,
      failedCases: 0,
      status: 'RUNNING',
      caseExecutionIds: executionIds,
      confirmedBy: input.actor.id,
      createdAt: now,
      updatedAt: now,
    })

    return {
      id: batchId,
      moduleId,
      targetId: mod.targetId,
      targetAccountId: input.targetAccountId,
      totalCases: cases.length,
      passedCases: 0,
      failedCases: 0,
      status: 'RUNNING',
      caseExecutionIds: executionIds,
      confirmedBy: input.actor.id,
      createdAt: iso(now),
      updatedAt: iso(now),
    }
  })
}

// ---------------------------------------------------------------------------
// 10. Get Module Test Batch
// ---------------------------------------------------------------------------

export async function getModuleTestBatch(
  db: Db,
  moduleId: string,
  batchId: string,
  actorId?: string,
): Promise<ModuleTestBatch & { executions: (ModuleCaseExecution & { result?: ModuleCaseResult })[] }> {
  const uDb = unwrapDb(db)
  const { actionModules, moduleTestBatches, moduleCaseExecutions, moduleCaseResults } = schemaFor(uDb)
  const [mod] = await uDb
    .select({ targetId: actionModules.targetId })
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
  if (!mod) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  if (actorId) await assertTargetPermission(uDb, actorId, mod.targetId, 'run:read')

  const [batch] = await uDb
    .select()
    .from(moduleTestBatches)
    .where(and(eq(moduleTestBatches.id, batchId), eq(moduleTestBatches.moduleId, moduleId)))
    .limit(1)

  if (!batch) throw notFound('MODULE_BATCH_NOT_FOUND', '回归测试批次不存在')

  const executionIds = (batch.caseExecutionIds as string[]) ?? []
  if (executionIds.length === 0) {
    return {
      id: batch.id,
      moduleId: batch.moduleId,
      targetId: batch.targetId,
      targetAccountId: batch.targetAccountId ?? undefined,
      totalCases: batch.totalCases,
      passedCases: batch.passedCases,
      failedCases: batch.failedCases,
      status: batch.status,
      haltReason: batch.haltReason ?? undefined,
      caseExecutionIds: executionIds,
      confirmedBy: batch.confirmedBy,
      createdAt: iso(batch.createdAt),
      updatedAt: iso(batch.updatedAt),
      executions: [],
    }
  }

  const execRows = await uDb
    .select()
    .from(moduleCaseExecutions)
    .where(inArray(moduleCaseExecutions.id, executionIds))

  const results = await uDb
    .select()
    .from(moduleCaseResults)
    .where(inArray(moduleCaseResults.executionId, executionIds))
    .orderBy(desc(moduleCaseResults.revision))

  const latestResultByExec = new Map<string, ModuleCaseResult>()
  for (const r of results) {
    if (!latestResultByExec.has(r.executionId)) {
      latestResultByExec.set(r.executionId, {
        id: r.id,
        executionId: r.executionId,
        caseId: r.caseId,
        runId: r.runId,
        revision: r.revision,
        status: r.status,
        outcomeMatched: r.outcomeMatched ?? undefined,
        outputsMatched: r.outputsMatched ?? undefined,
        evidenceComplete: r.evidenceComplete ?? undefined,
        failureReason: r.failureReason ?? undefined,
        details: (r.details as Record<string, JsonValue>) ?? undefined,
        projectorVersion: r.projectorVersion,
        createdAt: iso(r.createdAt),
        settledAt: r.settledAt ? iso(r.settledAt) : undefined,
      })
    }
  }

  const executions = execRows.map((e) => ({
    id: e.id,
    caseId: e.caseId,
    moduleId: e.moduleId,
    caseRevision: e.caseRevision,
    runId: e.runId,
    comparatorVersion: e.comparatorVersion,
    moduleDraftRevision: e.moduleDraftRevision ?? undefined,
    moduleVersionId: e.moduleVersionId ?? undefined,
    contentDigest: e.contentDigest,
    implementationKey: e.implementationKey,
    targetAccountId: e.targetAccountId ?? undefined,
    frozenInputs: e.frozenInputs as Record<string, JsonValue>,
    frozenExpectedOutcome: e.frozenExpectedOutcome,
    frozenExpectedFailureCode: e.frozenExpectedFailureCode ?? undefined,
    frozenExpectedOutputs: e.frozenExpectedOutputs as Record<string, JsonValue>,
    idempotencyKey: e.idempotencyKey ?? undefined,
    createdBy: e.createdBy,
    createdAt: iso(e.createdAt),
    result: latestResultByExec.get(e.id),
  }))

  return {
    id: batch.id,
    moduleId: batch.moduleId,
    targetId: batch.targetId,
    targetAccountId: batch.targetAccountId ?? undefined,
    totalCases: batch.totalCases,
    passedCases: batch.passedCases,
    failedCases: batch.failedCases,
    status: batch.status,
    haltReason: batch.haltReason ?? undefined,
    caseExecutionIds: executionIds,
    confirmedBy: batch.confirmedBy,
    createdAt: iso(batch.createdAt),
    updatedAt: iso(batch.updatedAt),
    executions,
  }
}

// ---------------------------------------------------------------------------
// 11. Assert Release Gate Satisfied
// ---------------------------------------------------------------------------

export async function assertReleaseGateSatisfied(
  db: Db,
  moduleId: string,
  content: ModuleContent,
  skipReleaseGate?: boolean,
): Promise<void> {
  if (skipReleaseGate) return

  const uDb = unwrapDb(db)
  const { moduleTestCases, moduleCaseExecutions, moduleCaseResults } = schemaFor(uDb)
  const currentContractDigest = computeContractDigest(content.contract)
  const currentContentDigest = computeContentDigest(content)

  const activeGateCases = await uDb
    .select()
    .from(moduleTestCases)
    .where(
      and(
        eq(moduleTestCases.moduleId, moduleId),
        eq(moduleTestCases.releaseGate, true),
        eq(moduleTestCases.status, 'ACTIVE'),
      ),
    )

  // If no test cases exist yet, release gate blocks publishing
  if (activeGateCases.length === 0) {
    throw conflict(
      'MODULE_TEST_CASES_FAILED',
      '发布门禁未通过：缺少已通过的回归测试用例。每个实现至少需要 1 个正向 releaseGate 测试用例通过。',
    )
  }

  // Check each active gate case is compatible with current contractDigest
  for (const c of activeGateCases) {
    if (c.contractDigest !== currentContractDigest) {
      throw conflict(
        'MODULE_TEST_CASES_FAILED',
        `用例「${c.name}」与当前契约不兼容，需重新审阅并更新预期后再发布`,
      )
    }
  }

  // Check each case has a latest result on currentContentDigest that is PASS
  const verifiedImpls = new Set<string>()
  for (const c of activeGateCases) {
    const [latestExec] = await uDb
      .select({
        executionId: moduleCaseExecutions.id,
        implementationKey: moduleCaseExecutions.implementationKey,
        frozenExpectedOutcome: moduleCaseExecutions.frozenExpectedOutcome,
        resultStatus: moduleCaseResults.status,
      })
      .from(moduleCaseExecutions)
      .innerJoin(moduleCaseResults, eq(moduleCaseResults.executionId, moduleCaseExecutions.id))
      .where(
        and(
          eq(moduleCaseExecutions.caseId, c.id),
          eq(moduleCaseExecutions.contentDigest, currentContentDigest),
        ),
      )
      .orderBy(desc(moduleCaseExecutions.createdAt), desc(moduleCaseResults.revision))
      .limit(1)

    if (!latestExec || latestExec.resultStatus !== 'PASS') {
      throw conflict(
        'MODULE_TEST_CASES_FAILED',
        `发布门禁未通过：用例「${c.name}」在当前内容摘要下尚未通过（状态：${latestExec?.resultStatus ?? '未执行'}）`,
      )
    }

    if (latestExec.frozenExpectedOutcome === 'VERIFIED') {
      verifiedImpls.add(latestExec.implementationKey)
    }
  }

  // Verify each implementation has at least one positive releaseGate PASS
  for (const impl of content.implementations) {
    if (!verifiedImpls.has(impl.implementationKey)) {
      throw conflict(
        'MODULE_TEST_CASES_FAILED',
        `实现「${impl.implementationKey}」缺少正向 releaseGate 测试用例 PASS 结果`,
      )
    }
  }
}
