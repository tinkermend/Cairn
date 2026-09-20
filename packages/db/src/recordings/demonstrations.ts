import { and, eq, isNull } from 'drizzle-orm'
import {
  DEMONSTRATION_PROTOCOL,
  MAX_AUTHORING_NODES,
  applyDemonstrationBodySchema,
  canonicalJson,
  createDemonstrationBodySchema,
  demonstrationDetailSchema,
  normalizeAuthoringDocument,
  recordingImportReceiptSchema,
  syncSha256,
  type ApplyDemonstrationBody,
  type CreateDemonstrationBody,
  type PreviewDemonstrationBody,
  type DemonstrationDetail,
  type DemonstrationPreview,
  type RecordingImportReceipt,
} from '@cairn/shared'
import {
  applyDemonstrationToDocument,
  DemonstrationApplyError,
  demonstrationFactDigest,
  previewDemonstration,
  sanitizeDemonstrationSource,
  suggestDemonstration,
} from '@cairn/authoring'
import type { Db } from '../client.js'
import { locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import {
  assertTargetPermission,
  lockConsoleAuthorization,
} from '../console/target-authorization.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { expandWithLoader, getScenario, syncScenarioModuleRefsTx } from '../runs/scenarios.js'
import { assertBindingAcceptsUpload, attachBindingDraft } from './recordings.js'
import type { RecordingImportReceiptRow } from '../schema/authoring.js'

export async function assertDemonstrationOwner(db: Db, id: string, actorId: string, write = false) {
  const { recordingDrafts, targets } = schemaFor(db)
  const query = db
    .select()
    .from(recordingDrafts)
    .where(and(eq(recordingDrafts.id, id), isNull(recordingDrafts.deletedAt)))
    .limit(1)
  const [row] = write ? await locked(db, query) : await query
  if (
    !row ||
    row.createdByConsoleAccountId !== actorId ||
    row.sourceProtocol !== DEMONSTRATION_PROTOCOL
  )
    throw notFound('RECORDING_NOT_FOUND', '示教录制不存在')
  await assertTargetPermission(db, actorId, row.targetId, 'workflow:write')
  await assertTargetPermission(db, actorId, row.targetId, 'target:read')
  const [target] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, row.targetId), isNull(targets.deletedAt)))
    .limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标不存在')
  return row
}

export async function getDemonstration(
  db: Db,
  id: string,
  actorId: string,
): Promise<DemonstrationDetail> {
  const row = await assertDemonstrationOwner(db, id, actorId)
  const { recordingDemonstrationSources, recordingArtifacts } = schemaFor(db)
  const [source] = await db
    .select()
    .from(recordingDemonstrationSources)
    .where(eq(recordingDemonstrationSources.recordingDraftId, id))
    .limit(1)
  if (!source) throw notFound('RECORDING_NOT_FOUND', '示教来源不存在')
  const artifacts = await db
    .select()
    .from(recordingArtifacts)
    .where(eq(recordingArtifacts.recordingDraftId, id))
  return demonstrationDetailSchema.parse({
    recordingDraftId: id,
    source: source.source,
    factDigest: source.factDigest,
    receivedAt: source.receivedAt.toISOString(),
    createdBy: row.createdByConsoleAccountId,
    artifacts: artifacts.map((a) => ({
      id: a.id,
      clientAssetId: a.clientAssetId,
      status: a.status,
      expiresAt: a.expiresAt.toISOString(),
      generationId: a.generationId,
    })),
  })
}

export async function createDemonstration(
  db: Db,
  raw: CreateDemonstrationBody,
  actor: AuditActor,
): Promise<DemonstrationDetail> {
  const body = createDemonstrationBodySchema.parse(raw)
  const source = sanitizeDemonstrationSource(body.source)
  if (source.omittedConfig.length && !body.acknowledgedOmittedConfig)
    throw badRequest('DEMONSTRATION_CONFIG_UNCONFIRMED', '请确认文件配置不会被应用到运行环境')
  const factDigest = demonstrationFactDigest(source)
  const payloadDigest = syncSha256(canonicalJson({ source, name: body.name }))
  let recordingId = ''
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingDrafts, recordingDemonstrationSources, recordingArtifacts, targets } =
      schemaFor(tx)
    await lockConsoleAuthorization(tx, actor.id)
    await assertTargetPermission(tx, actor.id, source.targetId, 'workflow:write')
    const [target] = await locked(
      tx,
      tx
        .select()
        .from(targets)
        .where(and(eq(targets.id, source.targetId), isNull(targets.deletedAt)))
        .limit(1),
    )
    if (!target) throw notFound('TARGET_NOT_FOUND', '目标不存在')
    if (target.status !== 'active') throw conflict('TARGET_DISABLED', '目标已停用')
    const [existing] = await tx
      .select()
      .from(recordingDrafts)
      .where(
        and(
          eq(recordingDrafts.createdByConsoleAccountId, actor.id),
          eq(recordingDrafts.idempotencyKey, body.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.deletedAt || existing.payloadDigest !== payloadDigest)
        throw conflict('RECORDING_IDEMPOTENCY_CONFLICT', '该请求键已用于不同或已删除的录制')
      recordingId = existing.id
      return
    }
    if (source.bindingId)
      await assertBindingAcceptsUpload(tx, source.bindingId, actor.id, source.targetId)
    recordingId = newId()
    const suggestions = suggestDemonstration(source)
    const now = new Date()
    await tx.insert(recordingDrafts).values({
      id: recordingId,
      targetId: source.targetId,
      createdByConsoleAccountId: actor.id,
      recordingId: source.captureId,
      sourceVersion: source.importProfile,
      sourceProtocol: DEMONSTRATION_PROTOCOL,
      idempotencyKey: body.idempotencyKey,
      payloadDigest,
      name: body.name,
      eventCount: source.facts.length,
      itemCount: suggestions.length,
      unresolvedCount: suggestions.filter((s) => s.status === 'unresolved').length,
      events: [],
      diagnostics: source.omittedConfig.map((key) => `已确认不应用配置 ${key}`),
      items: suggestions.map((s, index) => ({
        index,
        sourceIndexes: source.facts
          .filter((f) => f.sourceIds.some((id) => s.sourceIds.includes(id)))
          .map((f) => f.sequence),
        status: s.status === 'mapped' ? 'mapped' : 'unresolved',
        sourceAction: s.action,
        name: s.step?.name ?? s.outcome?.meaning.slice(0, 128) ?? s.action,
        diagnostics: s.diagnostics,
      })),
      createdAt: now,
      updatedAt: now,
    })
    await tx
      .insert(recordingDemonstrationSources)
      .values({ recordingDraftId: recordingId, source, factDigest, receivedAt: now })
    for (const manifest of source.assetManifest)
      await tx.insert(recordingArtifacts).values({
        id: newId(),
        recordingDraftId: recordingId,
        clientAssetId: manifest.clientAssetId,
        manifest,
        status: 'pending',
        expiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
        updatedAt: now,
      })
    if (source.bindingId) await attachBindingDraft(tx, source.bindingId, actor.id, recordingId)
    await recordAudit(
      tx,
      actor,
      'recording.create',
      'recording',
      recordingId,
      `保存示教来源，共 ${source.facts.length} 项`,
    )
  })
  return getDemonstration(db, recordingId, actor.id)
}

async function loadPreview(
  db: Db,
  scenarioId: string,
  body: PreviewDemonstrationBody,
  actorId: string,
  lock: boolean,
) {
  const { scenarios, scenarioDrafts } = schemaFor(db)
  const query = db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  const [scenario] = lock ? await locked(db, query) : await query
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  await assertTargetPermission(db, actorId, scenario.targetId, 'workflow:write')
  const draftQuery = db
    .select()
    .from(scenarioDrafts)
    .where(eq(scenarioDrafts.scenarioId, scenarioId))
    .limit(1)
  const [draft] = lock ? await locked(db, draftQuery) : await draftQuery
  if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
  if (draft.revision !== body.baseRevision)
    throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已变化，请保留决定并重新预览', {
      revision: draft.revision,
    })
  if (lock) await assertDemonstrationOwner(db, body.recordingDraftId, actorId, true)
  const demonstration = await getDemonstration(db, body.recordingDraftId, actorId)
  if (demonstration.source.targetId !== scenario.targetId)
    throw badRequest('RECORDING_BINDING_FORBIDDEN', '来源与场景必须属于同一目标')
  const document = normalizeAuthoringDocument(draft.document)
  const preview = previewDemonstration({
    source: demonstration.source,
    recordingDraftId: body.recordingDraftId,
    scenarioId,
    baseRevision: draft.revision,
    placement: body.placement,
    remainingCapacity: Math.max(0, MAX_AUTHORING_NODES - document.nodes.length),
  })
  return { scenario, draft, document, preview, demonstration }
}

export async function previewDemonstrationImport(
  db: Db,
  scenarioId: string,
  body: PreviewDemonstrationBody,
  actorId: string,
): Promise<DemonstrationPreview> {
  return (await loadPreview(db, scenarioId, body, actorId, false)).preview
}

function receiptDto(row: RecordingImportReceiptRow): RecordingImportReceipt {
  return recordingImportReceiptSchema.parse({
    id: row.id,
    scenarioId: row.scenarioId,
    recordingDraftId: row.recordingDraftId,
    sourceDigest: row.sourceDigest,
    normalizerVersion: row.normalizerVersion,
    baseRevision: row.baseRevision,
    newRevision: row.newRevision,
    sourceMap: row.sourceMap,
    demonstration: row.demonstration ?? undefined,
    insertedStepIds: [...new Set(row.sourceMap.flatMap((s) => (s.stepId ? [s.stepId] : [])))],
    createdAt: row.createdAt.toISOString(),
  })
}

export async function applyDemonstrationImport(
  db: Db,
  scenarioId: string,
  raw: ApplyDemonstrationBody,
  actor: AuditActor,
  options: { executableTypes?: readonly string[] } = {},
) {
  const body = applyDemonstrationBodySchema.parse(raw)
  const requestDigest = syncSha256(canonicalJson({ scenarioId, ...body }))
  let receipt: RecordingImportReceipt | undefined
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingImportReceipts, scenarios, scenarioDrafts } = schemaFor(tx)
    await lockConsoleAuthorization(tx, actor.id)
    const current = await loadPreviewForReplay(tx, scenarioId, actor.id)
    await assertDemonstrationOwner(tx, body.recordingDraftId, actor.id)
    const [existing] = await tx
      .select()
      .from(recordingImportReceipts)
      .where(
        and(
          eq(recordingImportReceipts.createdByConsoleAccountId, actor.id),
          eq(recordingImportReceipts.idempotencyKey, body.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.requestDigest !== requestDigest || existing.scenarioId !== scenarioId)
        throw conflict('RECORDING_IMPORT_CONFLICT', '该请求键已用于不同场景、位置或决定')
      receipt = receiptDto(existing)
      return
    }
    const [imported] = await tx
      .select()
      .from(recordingImportReceipts)
      .where(
        and(
          eq(recordingImportReceipts.scenarioId, scenarioId),
          eq(recordingImportReceipts.recordingDraftId, body.recordingDraftId),
        ),
      )
      .limit(1)
    if (imported) throw conflict('RECORDING_IMPORT_CONFLICT', '该录制已回填此场景')
    const state = await loadPreview(tx, scenarioId, body, actor.id, true)
    let next
    try {
      next = applyDemonstrationToDocument(state.document, state.preview, body)
    } catch (error) {
      if (error instanceof DemonstrationApplyError) throw badRequest(error.code, error.message)
      throw error
    }
    const expanded = await expandWithLoader(
      tx,
      current.targetId,
      next.document,
      'preview',
      true,
      options,
    )
    if (!expanded.ok)
      throw badRequest('SCENARIO_COMPILE_BLOCKED', '回填后的草稿未通过编译', {
        diagnostics: expanded.diagnostics,
      })
    const newRevision = state.draft.revision + 1
    const now = new Date()
    await tx
      .update(scenarioDrafts)
      .set({
        document: next.document,
        revision: newRevision,
        updatedByConsoleAccountId: actor.id,
        updatedAt: now,
      })
      .where(eq(scenarioDrafts.scenarioId, scenarioId))
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
    await syncScenarioModuleRefsTx(tx, scenarioId, null, next.document)
    const sourceMap: RecordingImportReceipt['sourceMap'] = next.sourceMap.map((s) => ({
      sourceIndexes: state.demonstration.source.facts
        .filter((f) => f.sourceIds.some((id) => s.sourceIds.includes(id)))
        .map((f) => f.sequence),
      stepId: s.nodeId,
      disposition: s.disposition as 'accept' | 'replace' | 'discard',
      ...(s.disposition === 'discard'
        ? {
            reason:
              body.decisions.find(
                (d) =>
                  d.disposition === 'discard' &&
                  state.preview.suggestions
                    .find((p) => p.id === d.id)
                    ?.sourceIds.some((id) => s.sourceIds.includes(id)),
              )?.disposition === 'discard'
                ? '用户明确放弃，详见决定'
                : '用户明确放弃',
          }
        : {}),
    }))
    const row = {
      id: newId(),
      scenarioId,
      recordingDraftId: body.recordingDraftId,
      createdByConsoleAccountId: actor.id,
      idempotencyKey: body.idempotencyKey,
      requestDigest,
      sourceDigest: body.factDigest,
      normalizerVersion: body.ruleVersion,
      baseRevision: state.draft.revision,
      newRevision,
      insertAnchor:
        body.placement.kind === 'after'
          ? { kind: 'after' as const, stepId: body.placement.nodeId }
          : { kind: 'start' as const },
      sourceMap,
      demonstration: {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        factDigest: body.factDigest,
        suggestionDigest: body.suggestionDigest,
        adapterVersion: body.adapterVersion,
        ruleVersion: body.ruleVersion,
        placement: body.placement,
        decisions: body.decisions,
        sourceMap: next.sourceMap,
      },
      createdAt: now,
    }
    await tx.insert(recordingImportReceipts).values(row)
    await recordAudit(
      tx,
      actor,
      'scenario.update',
      'scenario',
      scenarioId,
      `示教回填草稿 r${newRevision}`,
    )
    receipt = receiptDto(row)
  })
  return { receipt: receipt!, scenario: await getScenario(db, scenarioId, options) }
}

async function loadPreviewForReplay(db: Db, scenarioId: string, actorId: string) {
  const { scenarios } = schemaFor(db)
  const [scenario] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  await assertTargetPermission(db, actorId, scenario.targetId, 'workflow:write')
  return scenario
}
