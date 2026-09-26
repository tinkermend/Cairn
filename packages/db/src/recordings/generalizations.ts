import { and, eq, isNull } from 'drizzle-orm'
import {
  COMPILER_VERSION,
  DEMONSTRATION_ADAPTER_VERSION,
  RECORDING_GENERALIZATION_RULE_VERSION,
  authoringSteps,
  canonicalJson,
  recordingGeneralizationDtoSchema,
  syncSha256,
  type DemonstrationDecision,
  type GeneralizationRound,
  type HandoffCreateScenarioBody,
  type RecordingGeneralizationDto,
  type RecordingImportReceipt,
  type SaveGeneralizationDecisionsBody,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
  type ScenarioDocument,
  type SubmitGeneralizationRoundBody,
  walkAuthoringNodes,
} from '@cairn/shared'
import {
  foldRecordingGeneralization,
  generateQuickActionRound,
  interpretGeneralizationIntent,
  suggestDemonstration,
} from '@cairn/authoring'
import type { Db } from '../client.js'
import { locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { assertDemonstrationOwner } from './demonstrations.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { expandWithLoader, getScenario, syncScenarioModuleRefsTx } from '../runs/scenarios.js'
import type { RecordingGeneralizationRow } from '../schema/demonstration.js'

function toDto(row: RecordingGeneralizationRow, candidateDoc?: ScenarioAuthoringDocumentV2): RecordingGeneralizationDto {
  return recordingGeneralizationDtoSchema.parse({
    id: row.id,
    recordingDraftId: row.recordingDraftId,
    revision: row.revision,
    status: row.status,
    factDigest: row.factDigest,
    suggestionDigest: row.suggestionDigest,
    adapterVersion: row.adapterVersion,
    ruleVersion: row.ruleVersion,
    candidateDigest: row.candidateDigest,
    decisions: row.decisions,
    rounds: row.rounds,
    candidateDocument: candidateDoc,
    handedOffScenarioId: row.handedOffScenarioId ?? null,
    handedOffReceiptId: row.handedOffReceiptId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export async function getOrCreateRecordingGeneralization(
  db: Db,
  recordingDraftId: string,
  actorId: string,
): Promise<{ generalization: RecordingGeneralizationDto; candidateDocument?: ScenarioAuthoringDocumentV2 }> {
  await assertDemonstrationOwner(db, recordingDraftId, actorId)
  const { recordingDemonstrationSources, recordingGeneralizations } = schemaFor(db)

  const [sourceRow] = await db
    .select()
    .from(recordingDemonstrationSources)
    .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
    .limit(1)

  if (!sourceRow) {
    throw notFound('RECORDING_SOURCE_NOT_FOUND', '示教录制来源不存在')
  }

  const source = sourceRow.source
  const [existing] = await db
    .select()
    .from(recordingGeneralizations)
    .where(eq(recordingGeneralizations.recordingDraftId, recordingDraftId))
    .limit(1)

  if (existing) {
    const foldRes = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: existing.decisions,
      rounds: existing.rounds,
    })
    const doc = foldRes.ok ? foldRes.document : undefined
    return {
      generalization: toDto(existing, doc),
      candidateDocument: doc,
    }
  }

  // 初始化工作层
  const suggestions = suggestDemonstration(source)
  const baseDecisions: DemonstrationDecision[] = suggestions.map((item) => {
    if (item.status === 'mapped') {
      return { id: item.id, disposition: 'accept' }
    }
    return { id: item.id, disposition: 'discard', reason: '未决动作默认舍弃' }
  })

  const foldRes = foldRecordingGeneralization({
    source,
    recordingDraftId,
    baseDecisions,
    rounds: [],
  })

  if (!foldRes.ok) {
    throw badRequest('RECORDING_FOLD_FAILED', `初始化工作层折叠失败：${foldRes.error.message}`)
  }

  const suggestionDigest = syncSha256(canonicalJson(suggestions))
  const newRow: RecordingGeneralizationRow = {
    id: newId(),
    recordingDraftId,
    revision: 1,
    status: 'editing',
    factDigest: sourceRow.factDigest,
    suggestionDigest,
    adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
    ruleVersion: RECORDING_GENERALIZATION_RULE_VERSION,
    candidateDigest: foldRes.candidateDigest,
    decisions: baseDecisions,
    rounds: [],
    handedOffScenarioId: null,
    handedOffReceiptId: null,
    createdByConsoleAccountId: actorId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  await db.insert(recordingGeneralizations).values(newRow)

  return {
    generalization: toDto(newRow, foldRes.document),
    candidateDocument: foldRes.document,
  }
}

export async function saveRecordingGeneralizationDecisions(
  db: Db,
  recordingDraftId: string,
  body: SaveGeneralizationDecisionsBody,
  actor: AuditActor,
): Promise<{ generalization: RecordingGeneralizationDto; candidateDocument?: ScenarioAuthoringDocumentV2 }> {
  let resultDto: RecordingGeneralizationDto | undefined
  let candidateDoc: ScenarioAuthoringDocumentV2 | undefined

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    await lockConsoleAuthorization(txDb, actor.id)
    await assertDemonstrationOwner(txDb, recordingDraftId, actor.id, true)

    const { recordingGeneralizations, recordingDemonstrationSources } = schemaFor(txDb)
    const [row] = await locked(
      txDb,
      txDb
        .select()
        .from(recordingGeneralizations)
        .where(eq(recordingGeneralizations.recordingDraftId, recordingDraftId))
        .limit(1),
    )

    if (!row) {
      throw notFound('GENERALIZATION_NOT_FOUND', '泛化工作层不存在')
    }
    if (row.status === 'handed_off') {
      throw conflict('RECORDING_GENERALIZATION_LOCKED', '该录制草稿已完成回填，处于只读锁定状态')
    }
    if (row.revision !== body.revision) {
      throw conflict('RECORDING_GENERALIZATION_REVISION_CONFLICT', '工作层版本已发生变更，请刷新重试')
    }

    const [sourceRow] = await txDb
      .select()
      .from(recordingDemonstrationSources)
      .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
      .limit(1)

    if (!sourceRow) {
      throw notFound('RECORDING_SOURCE_NOT_FOUND', '示教录制来源不存在')
    }

    let foldRes = foldRecordingGeneralization({
      source: sourceRow.source,
      recordingDraftId,
      baseDecisions: body.decisions,
      rounds: row.rounds,
    })

    let currentRounds = [...row.rounds]
    if (!foldRes.ok && foldRes.invalidatedRoundId) {
      // 若修改基础决策导致依赖步骤失效，将受影响轮次标记为 invalidated
      const invId = foldRes.invalidatedRoundId
      currentRounds = currentRounds.map((r) =>
        r.roundId === invId ? { ...r, status: 'invalidated' as const } : r,
      )
      foldRes = foldRecordingGeneralization({
        source: sourceRow.source,
        recordingDraftId,
        baseDecisions: body.decisions,
        rounds: currentRounds,
      })
    }

    if (!foldRes.ok) {
      throw badRequest('RECORDING_FOLD_FAILED', `更新决策折叠失败：${foldRes.error.message}`)
    }

    const newRevision = row.revision + 1
    const now = new Date()

    await txDb
      .update(recordingGeneralizations)
      .set({
        decisions: body.decisions,
        rounds: currentRounds,
        revision: newRevision,
        candidateDigest: foldRes.candidateDigest,
        updatedAt: now,
      })
      .where(eq(recordingGeneralizations.id, row.id))

    await recordAudit(
      txDb,
      actor,
      'recording.update',
      'recording_draft',
      row.recordingDraftId,
      `更新了录制逐项决策基线 (r${newRevision})`,
    )

    const updatedRow: RecordingGeneralizationRow = {
      ...row,
      decisions: body.decisions,
      rounds: currentRounds,
      revision: newRevision,
      candidateDigest: foldRes.candidateDigest,
      updatedAt: now,
    }

    candidateDoc = foldRes.document
    resultDto = toDto(updatedRow, candidateDoc)
  })

  return {
    generalization: resultDto!,
    candidateDocument: candidateDoc,
  }
}

export async function submitRecordingGeneralizationRound(
  db: Db,
  recordingDraftId: string,
  body: SubmitGeneralizationRoundBody,
  actor: AuditActor,
): Promise<{
  generalization: RecordingGeneralizationDto
  candidateDocument?: ScenarioAuthoringDocumentV2
  round: GeneralizationRound
}> {
  let resultDto: RecordingGeneralizationDto | undefined
  let candidateDoc: ScenarioAuthoringDocumentV2 | undefined
  let finalizedRound: GeneralizationRound | undefined

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    await lockConsoleAuthorization(txDb, actor.id)
    const draftRow = await assertDemonstrationOwner(txDb, recordingDraftId, actor.id, true)

    const { recordingGeneralizations, recordingDemonstrationSources, datasets, targets, targetAccounts } =
      schemaFor(txDb)

    const [row] = await locked(
      txDb,
      txDb
        .select()
        .from(recordingGeneralizations)
        .where(eq(recordingGeneralizations.recordingDraftId, recordingDraftId))
        .limit(1),
    )

    if (!row) throw notFound('GENERALIZATION_NOT_FOUND', '泛化工作层不存在')
    if (row.status === 'handed_off') {
      throw conflict('RECORDING_GENERALIZATION_LOCKED', '该录制草稿已完成回填，处于只读锁定状态')
    }
    if (row.revision !== body.revision) {
      throw conflict('RECORDING_GENERALIZATION_REVISION_CONFLICT', '工作层版本已发生变更，请刷新重试')
    }

    const [sourceRow] = await txDb
      .select()
      .from(recordingDemonstrationSources)
      .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
      .limit(1)

    if (!sourceRow) throw notFound('RECORDING_SOURCE_NOT_FOUND', '示教录制来源不存在')

    // 获取当前候选文档
    const curFold = foldRecordingGeneralization({
      source: sourceRow.source,
      recordingDraftId,
      baseDecisions: row.decisions,
      rounds: row.rounds,
    })

    if (!curFold.ok) {
      throw badRequest('RECORDING_FOLD_FAILED', `折叠现有文档失败：${curFold.error.message}`)
    }

    if (body.quickAction) {
      // 规则快捷泛化
      // 1. 获取目标数据集 (严格限定在当前 targetId 下)
      const targetDatasetsRows = await txDb
        .select()
        .from(datasets)
        .where(and(eq(datasets.targetId, draftRow.targetId), isNull(datasets.deletedAt)))

      const targetDatasets = targetDatasetsRows.map((ds) => ({
        id: ds.id,
        name: ds.name,
        schema: ds.columnsMeta.map((col) => ({
          key: col.key,
          name: col.name,
          type: col.type,
          sampleValues: col.sampleValues,
        })),
      }))

      // 2. 检查目标认证配置
      const [targetRow] = await txDb
        .select()
        .from(targets)
        .where(and(eq(targets.id, draftRow.targetId), isNull(targets.deletedAt)))
        .limit(1)

      const [authAccount] = await txDb
        .select()
        .from(targetAccounts)
        .where(and(eq(targetAccounts.targetId, draftRow.targetId), isNull(targetAccounts.deletedAt)))
        .limit(1)

      const targetHasAuth = Boolean(
        targetRow?.loginUrl ||
          targetRow?.loginFields ||
          targetRow?.currentAuthProfileRevision ||
          authAccount,
      )

      const roundId = newId()
      const ruleRes = generateQuickActionRound({
        recordingDraftId,
        roundId,
        action: body.quickAction as any,
        targetStepId: body.targetStepId,
        targetSourceId: body.targetSourceId,
        source: sourceRow.source,
        currentDocument: curFold.document,
        targetDatasets,
        targetHasAuth,
      })

      if (!ruleRes.ok) {
        throw badRequest(ruleRes.error.code, ruleRes.error.message)
      }

      finalizedRound = ruleRes.round
    } else if (body.intent) {
      // G3: 自然语言意图泛化（支持正反例解释、负例安全阻断与规则降级）
      const targetDatasetsRows = await txDb
        .select()
        .from(datasets)
        .where(and(eq(datasets.targetId, draftRow.targetId), isNull(datasets.deletedAt)))

      const targetDatasets = targetDatasetsRows.map((ds) => ({
        id: ds.id,
        name: ds.name,
        schema: ds.columnsMeta.map((col) => ({
          key: col.key,
          name: col.name,
          type: col.type,
          sampleValues: col.sampleValues,
        })),
      }))

      const [targetRow] = await txDb
        .select()
        .from(targets)
        .where(and(eq(targets.id, draftRow.targetId), isNull(targets.deletedAt)))
        .limit(1)

      const [authAccount] = await txDb
        .select()
        .from(targetAccounts)
        .where(and(eq(targetAccounts.targetId, draftRow.targetId), isNull(targetAccounts.deletedAt)))
        .limit(1)

      const targetHasAuth = Boolean(
        targetRow?.loginUrl ||
          targetRow?.loginFields ||
          targetRow?.currentAuthProfileRevision ||
          authAccount,
      )

      const roundId = newId()
      const nlpRes = interpretGeneralizationIntent({
        recordingDraftId,
        roundId,
        intent: body.intent,
        targetStepId: body.targetStepId,
        targetSourceId: body.targetSourceId,
        source: sourceRow.source,
        currentDocument: curFold.document,
        targetDatasets,
        targetHasAuth,
      })

      if (!nlpRes.ok) {
        throw badRequest(nlpRes.error.code, nlpRes.error.message)
      }

      finalizedRound = nlpRes.round
    } else {
      throw badRequest('INVALID_GENERALIZATION_REQUEST', '必须提供自然语言意图或快捷操作')
    }

    const nextRounds = [...row.rounds, finalizedRound]
    const newRevision = row.revision + 1
    const now = new Date()

    await txDb
      .update(recordingGeneralizations)
      .set({
        rounds: nextRounds,
        revision: newRevision,
        updatedAt: now,
      })
      .where(eq(recordingGeneralizations.id, row.id))

    await recordAudit(
      txDb,
      actor,
      'recording.update',
      'recording_draft',
      row.recordingDraftId,
      `生成了泛化轮次「${finalizedRound.intent ?? finalizedRound.roundId}」`,
    )

    const updatedRow: RecordingGeneralizationRow = {
      ...row,
      rounds: nextRounds,
      revision: newRevision,
      updatedAt: now,
    }

    candidateDoc = curFold.document
    resultDto = toDto(updatedRow, candidateDoc)
  })

  return {
    generalization: resultDto!,
    candidateDocument: candidateDoc,
    round: finalizedRound!,
  }
}

export async function updateRecordingGeneralizationRoundStatus(
  db: Db,
  recordingDraftId: string,
  roundId: string,
  action: 'accept' | 'reject' | 'revert',
  actor: AuditActor,
): Promise<{ generalization: RecordingGeneralizationDto; candidateDocument?: ScenarioAuthoringDocumentV2 }> {
  let resultDto: RecordingGeneralizationDto | undefined
  let candidateDoc: ScenarioAuthoringDocumentV2 | undefined

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    await lockConsoleAuthorization(txDb, actor.id)
    await assertDemonstrationOwner(txDb, recordingDraftId, actor.id, true)

    const { recordingGeneralizations, recordingDemonstrationSources } = schemaFor(txDb)
    const [row] = await locked(
      txDb,
      txDb
        .select()
        .from(recordingGeneralizations)
        .where(eq(recordingGeneralizations.recordingDraftId, recordingDraftId))
        .limit(1),
    )

    if (!row) throw notFound('GENERALIZATION_NOT_FOUND', '泛化工作层不存在')
    if (row.status === 'handed_off') {
      throw conflict('RECORDING_GENERALIZATION_LOCKED', '该录制草稿已完成回填，处于只读锁定状态')
    }

    const roundIndex = row.rounds.findIndex((r) => r.roundId === roundId)
    if (roundIndex < 0) {
      throw notFound('ROUND_NOT_FOUND', `未找到泛化轮次「${roundId}」`)
    }

    let updatedRounds = [...row.rounds]
    if (action === 'revert') {
      // 回退某轮及其后续的所有已采纳轮次
      updatedRounds = updatedRounds.map((r, idx) => {
        if (idx >= roundIndex && (r.status === 'accepted' || r.roundId === roundId)) {
          return { ...r, status: 'reverted' as const }
        }
        return r
      })
    } else if (action === 'accept') {
      const targetRound = updatedRounds[roundIndex]
      if (targetRound) {
        updatedRounds[roundIndex] = {
          ...targetRound,
          status: 'accepted',
        }
      }
    } else if (action === 'reject') {
      const targetRound = updatedRounds[roundIndex]
      if (targetRound) {
        updatedRounds[roundIndex] = {
          ...targetRound,
          status: 'rejected',
        }
      }
    }

    const [sourceRow] = await txDb
      .select()
      .from(recordingDemonstrationSources)
      .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
      .limit(1)

    if (!sourceRow) throw notFound('RECORDING_SOURCE_NOT_FOUND', '示教录制来源不存在')

    const foldRes = foldRecordingGeneralization({
      source: sourceRow.source,
      recordingDraftId,
      baseDecisions: row.decisions,
      rounds: updatedRounds,
    })

    if (!foldRes.ok) {
      throw badRequest('RECORDING_FOLD_FAILED', `更新轮次状态失败：${foldRes.error.message}`)
    }

    const newRevision = row.revision + 1
    const now = new Date()

    await txDb
      .update(recordingGeneralizations)
      .set({
        rounds: updatedRounds,
        candidateDigest: foldRes.candidateDigest,
        revision: newRevision,
        updatedAt: now,
      })
      .where(eq(recordingGeneralizations.id, row.id))

    await recordAudit(
      txDb,
      actor,
      'recording.update',
      'recording_draft',
      row.recordingDraftId,
      `${action === 'accept' ? '采纳' : action === 'reject' ? '拒绝' : '回退'}了泛化轮次「${roundId}」`,
    )

    const updatedRow: RecordingGeneralizationRow = {
      ...row,
      rounds: updatedRounds,
      candidateDigest: foldRes.candidateDigest,
      revision: newRevision,
      updatedAt: now,
    }

    candidateDoc = foldRes.document
    resultDto = toDto(updatedRow, candidateDoc)
  })

  return {
    generalization: resultDto!,
    candidateDocument: candidateDoc,
  }
}

export async function handoffCreateScenario(
  db: Db,
  recordingDraftId: string,
  body: HandoffCreateScenarioBody,
  actor: AuditActor,
): Promise<{ scenario: ScenarioDetailDto; receipt: RecordingImportReceipt; generalization: RecordingGeneralizationDto }> {
  let createdScenarioId = ''
  let createdReceipt: RecordingImportReceipt | undefined
  let updatedGeneralizationDto: RecordingGeneralizationDto | undefined

  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    await lockConsoleAuthorization(txDb, actor.id)
    const draftRow = await assertDemonstrationOwner(txDb, recordingDraftId, actor.id, true)
    await assertTargetPermission(txDb, actor.id, draftRow.targetId, 'workflow:write')

    const {
      recordingGeneralizations,
      recordingDemonstrationSources,
      scenarios,
      scenarioDrafts,
      scenarioVersions,
      recordingImportReceipts,
    } = schemaFor(txDb)

    const [row] = await locked(
      txDb,
      txDb
        .select()
        .from(recordingGeneralizations)
        .where(eq(recordingGeneralizations.recordingDraftId, recordingDraftId))
        .limit(1),
    )

    if (!row) throw notFound('GENERALIZATION_NOT_FOUND', '泛化工作层不存在')
    if (row.status === 'handed_off') {
      throw conflict('RECORDING_GENERALIZATION_LOCKED', '该录制草稿已完成回填，不能重复新建场景回填')
    }
    if (row.revision !== body.revision) {
      throw conflict('RECORDING_GENERALIZATION_REVISION_CONFLICT', '工作层版本冲突，请刷新后重试')
    }
    if (row.candidateDigest !== body.candidateDigest) {
      throw conflict('RECORDING_DIGEST_MISMATCH', '提交的候选文档摘要与服务端计算不一致')
    }

    const [sourceRow] = await txDb
      .select()
      .from(recordingDemonstrationSources)
      .where(eq(recordingDemonstrationSources.recordingDraftId, recordingDraftId))
      .limit(1)

    if (!sourceRow) throw notFound('RECORDING_SOURCE_NOT_FOUND', '示教录制来源不存在')

    const foldRes = foldRecordingGeneralization({
      source: sourceRow.source,
      recordingDraftId,
      baseDecisions: row.decisions,
      rounds: row.rounds,
    })

    if (!foldRes.ok) {
      throw badRequest('RECORDING_FOLD_FAILED', `折叠候选文档失败：${foldRes.error.message}`)
    }

    // 编译检查
    const expansion = await expandWithLoader(
      txDb,
      draftRow.targetId,
      foldRes.document,
      'preview',
      true,
    )
    if (!expansion.ok) {
      throw badRequest('SCENARIO_COMPILE_BLOCKED', '回填的候选场景未通过编译', {
        diagnostics: expansion.diagnostics,
      })
    }

    const scenarioId = newId()
    const versionId = newId()
    const now = new Date()
    const compiledDef: ScenarioDocument = expansion.definition ?? {
      schemaVersion: 1,
      inputs: foldRes.document.inputs,
      steps: authoringSteps(foldRes.document),
      ...(foldRes.document.resolution ? { resolution: foldRes.document.resolution } : {}),
      ...(foldRes.document.locatorPlan ? { locatorPlan: foldRes.document.locatorPlan } : {}),
    }
    const digest = expansion.sourceDigest ?? syncSha256(canonicalJson(compiledDef))

    // 1. 创建场景记录
    await txDb.insert(scenarios).values({
      id: scenarioId,
      targetId: draftRow.targetId,
      name: body.name,
      status: 'active',
      purpose: 'user',
      createdByConsoleAccountId: actor.id,
      createdAt: now,
      updatedAt: now,
    })

    // 2. 创建初始发布版本（使场景具备完整版本链）
    await txDb.insert(scenarioVersions).values({
      id: versionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      definition: compiledDef,
      compilerVersion: COMPILER_VERSION,
      sourceDigest: digest,
      createdByConsoleAccountId: actor.id,
      createdAt: now,
    })

    // 3. 创建首版草稿（从录制回填生成的场景草稿版本为 2，以 baseRevision: 1 生成回填回执）
    await txDb.insert(scenarioDrafts).values({
      scenarioId,
      revision: 2,
      document: foldRes.document,
      updatedByConsoleAccountId: actor.id,
      updatedAt: now,
    })

    await syncScenarioModuleRefsTx(txDb, scenarioId, null, foldRes.document)

    // 3. 构建回填回执与 sourceMap
    const sourceMap: RecordingImportReceipt['sourceMap'] = walkAuthoringNodes(foldRes.document)
      .map((i) => i.node)
      .filter((n): n is Extract<typeof n, { kind: 'step' }> => n.kind === 'step')
      .map((n) => {
        const step = n.step
        const origin = n.origin
        const sIds = origin?.kind === 'recording' ? origin.sourceIds ?? [] : []
        const matchedFacts = sourceRow.source.facts.filter((f) =>
          f.sourceIds.some((id) => sIds.includes(id)),
        )
        return {
          sourceIndexes: matchedFacts.map((f) => f.sequence),
          stepId: step.id,
          disposition: 'accept' as const,
        }
      })

    const receiptId = newId()
    const receiptRow = {
      id: receiptId,
      scenarioId,
      recordingDraftId,
      createdByConsoleAccountId: actor.id,
      idempotencyKey: newId(),
      requestDigest: body.candidateDigest,
      sourceDigest: row.factDigest,
      normalizerVersion: row.ruleVersion,
      baseRevision: 1,
      newRevision: 2,
      insertAnchor: { kind: 'start' as const },
      sourceMap,
      demonstration: {
        protocolVersion: 'demonstration@1' as const,
        factDigest: row.factDigest,
        suggestionDigest: row.suggestionDigest,
        adapterVersion: row.adapterVersion,
        ruleVersion: row.ruleVersion,
        placement: { kind: 'start' as const },
        decisions: row.decisions,
        sourceMap: [],
      },
      createdAt: now,
    }

    await txDb.insert(recordingImportReceipts).values(receiptRow)

    // 4. 将工作层标记为 handed_off 并绑定
    const newGeneralizationRevision = row.revision + 1
    await txDb
      .update(recordingGeneralizations)
      .set({
        status: 'handed_off',
        handedOffScenarioId: scenarioId,
        handedOffReceiptId: receiptId,
        revision: newGeneralizationRevision,
        updatedAt: now,
      })
      .where(eq(recordingGeneralizations.id, row.id))

    await recordAudit(
      txDb,
      actor,
      'scenario.create',
      'scenario',
      scenarioId,
      `以录制草稿新建场景「${body.name}」`,
    )
    await recordAudit(
      txDb,
      actor,
      'recording.update',
      'recording_draft',
      draftRow.id,
      `录制草稿已原子回填至场景「${body.name}」(${scenarioId})`,
    )

    createdScenarioId = scenarioId
    createdReceipt = {
      id: receiptRow.id,
      scenarioId: receiptRow.scenarioId,
      recordingDraftId: receiptRow.recordingDraftId,
      sourceDigest: receiptRow.sourceDigest,
      normalizerVersion: receiptRow.normalizerVersion,
      baseRevision: receiptRow.baseRevision,
      newRevision: receiptRow.newRevision,
      insertedStepIds: sourceMap.map((s) => s.stepId!).filter(Boolean),
      sourceMap: receiptRow.sourceMap,
      createdAt: receiptRow.createdAt.toISOString(),
      demonstration: receiptRow.demonstration,
    }

    const updatedRow: RecordingGeneralizationRow = {
      ...row,
      status: 'handed_off',
      handedOffScenarioId: scenarioId,
      handedOffReceiptId: receiptId,
      revision: newGeneralizationRevision,
      updatedAt: now,
    }
    updatedGeneralizationDto = toDto(updatedRow, foldRes.document)
  })

  const scenario = await getScenario(db, createdScenarioId)
  return {
    scenario,
    receipt: createdReceipt!,
    generalization: updatedGeneralizationDto!,
  }
}
