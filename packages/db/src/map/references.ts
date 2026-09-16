import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import {
  compileScenarioDocument,
  mapAssetRefKey,
  isAuthoringDocumentV2,
  normalizeAuthoringDocument,
  mapBindingRemoveBodySchema,
  mapImpactSourceSchema,
  mapReferenceListResponseSchema,
  mapScanStartResponseSchema,
  mapScenarioBindingSchema,
  parseScenarioDocument,
  type MapImpactQuery,
  type MapListQuery,
  type MapScenarioBindingBody,
  type ScenarioDocument,
} from '@cairn/shared'
import type { ExecutionActor } from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'
import { sha256Hex } from '../runs/digest.js'
import { canonicalJson } from '@cairn/shared'
import { mapNotFound, mapReferenceUnresolved } from './errors.js'
import { assetKey, requireMapAsset, decodeMapCursor, encodeMapCursor, listDigest, requireLiveTarget, resolveMapView } from './view.js'
import { loadIdentityAliases } from './identities.js'

function explicitStepDocument(input: unknown): ScenarioDocument {
  if (!isAuthoringDocumentV2(input)) return parseScenarioDocument(input)
  const document = normalizeAuthoringDocument(input)
  return { schemaVersion: 1, inputs: document.inputs, steps: document.nodes.flatMap(node => node.kind === 'step' ? [node.step] : []) }
}

function slotKey(body: { scopeKind?: string; stepId?: string; assetRef: { pageId?: string } }): string {
  if (body.scopeKind === 'page_context') return `page:${body.assetRef.pageId ?? 'x'}`
  return `step:${body.stepId}`
}

async function lockDraft(tx: Db, scenarioId: string, expectedRevision: number, targetId: string) {
  const { scenarioDrafts, scenarios } = schemaFor(tx)
  const [scenario] = await locked(
    tx,
    tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))),
  )
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  if (scenario.targetId !== targetId) mapReferenceUnresolved('场景不属于该目标系统')
  const [draft] = await locked(tx, tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)))
  if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
  if (draft.revision !== expectedRevision) {
    throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
      revision: draft.revision,
      document: draft.document,
    })
  }
  return { scenario, draft }
}

export async function upsertMapScenarioBinding(
  db: Db,
  targetId: string,
  body: MapScenarioBindingBody,
  actor: ExecutionActor,
) {
  const target = await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { draft } = await lockDraft(tx, body.scenarioId, body.expectedDraftRevision, targetId)
    await requireMapAsset(tx, targetId, body.assetRef)
    if (body.basis !== 'explicit_user') mapReferenceUnresolved('控制台只能确认 explicit_user 绑定')
    let document = explicitStepDocument(body.document ?? draft.document)
    if (body.scopeKind === 'version') {
      const { scenarioVersions } = schemaFor(tx)
      const [version] = await tx.select().from(scenarioVersions).where(eq(scenarioVersions.id, body.scenarioVersionId!)).limit(1)
      if (!version || version.scenarioId !== body.scenarioId || version.kind !== 'published') mapReferenceUnresolved('注释版本不存在')
      document = parseScenarioDocument(version.definition)
    }
    if (body.stepId && !document.steps.some(step => step.id === body.stepId)) mapReferenceUnresolved('步骤不属于该场景定义')
    if (body.scopeKind === 'page_context' && !body.assetRef.pageId) mapReferenceUnresolved('页面引用必须指定 pageId')
    if (body.document) {
      const document = parseScenarioDocument(body.document) as ScenarioDocument
      compileScenarioDocument(document, { mode: 'save', target: { exists: true, status: target.status } })
      const now = await clockNow(tx)
      const { scenarioDrafts, scenarios } = schemaFor(tx)
      await tx
        .update(scenarioDrafts)
        .set({
          revision: draft.revision + 1,
          document,
          updatedByConsoleAccountId: actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, body.scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, body.scenarioId))
      await reconcileMapDraftBindingsTx(tx, { scenarioId: body.scenarioId, targetId, revision: draft.revision + 1, document })
    }
    const now = await clockNow(tx)
    const { mapScenarioBindings, mapObjectDescriptors } = schemaFor(tx)
    const descriptors = body.assetRef.objectId ? await tx.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.objectId, body.assetRef.objectId)) : []
    const descriptor = descriptors.find(row => row.implementationKey === body.assetRef.implementationKey && row.descriptorVersion === body.assetRef.descriptorVersion)
    const slot = slotKey(body)
    const versionSlot = body.scopeKind === 'version' ? body.scenarioVersionId! : 'draft'
    const [existing] = await tx
      .select()
      .from(mapScenarioBindings)
      .where(
        and(
          eq(mapScenarioBindings.targetId, targetId),
          eq(mapScenarioBindings.scenarioId, body.scenarioId),
          eq(mapScenarioBindings.scopeKind, body.scopeKind),
          eq(mapScenarioBindings.slotKey, slot),
          eq(mapScenarioBindings.versionSlot, versionSlot),
        ),
      )
      .limit(1)
    const values = {
      targetId,
      scenarioId: body.scenarioId,
      slotKey: slot,
      stepId: body.stepId ?? null,
      assetRefKey: mapAssetRefKey(body.assetRef),
      pageId: body.assetRef.pageId ?? null,
      objectId: body.assetRef.objectId ?? null,
      implementationKey: body.assetRef.implementationKey ?? null,
      descriptorVersion: body.assetRef.descriptorVersion ?? null,
      basis: body.basis,
      scopeKind: body.scopeKind,
      draftRevision: body.document ? draft.revision + 1 : draft.revision,
      scenarioVersionId: body.scopeKind === 'version' ? body.scenarioVersionId! : null,
      versionSlot,
      descriptorDigest: sha256Hex(canonicalJson(descriptor ? { features: descriptor.features, condition: descriptor.conditionSnapshot, descriptorVersion: descriptor.descriptorVersion } : body.assetRef)),
      confirmedBy: actor.id,
      confirmedAt: now,
      resolution: 'resolved' as const,
      sourceRef: body.scopeKind === 'version' ? { kind: 'annotation' } : null,
      status: 'active',
      updatedAt: now,
    }
    if (existing?.scopeKind === 'version' && existing.sourceRef?.kind !== 'annotation') mapReferenceUnresolved('不能覆盖冻结的版本绑定')
    if (existing) {
      await tx.update(mapScenarioBindings).set(values).where(eq(mapScenarioBindings.id, existing.id))
      await recordAudit(tx, actor, 'map.bind', 'map_binding', existing.id, '更新场景地图绑定')
      return getBinding(tx, existing.id)
    }
    const id = newId()
    await insertRows(tx, mapScenarioBindings, { id, ...values, createdAt: now })
    await recordAudit(tx, actor, 'map.bind', 'map_binding', id, '创建场景地图绑定')
    return getBinding(tx, id)
  })
}

async function getBinding(db: Db, bindingId: string) {
  const { mapScenarioBindings } = schemaFor(db)
  const [row] = await db.select().from(mapScenarioBindings).where(eq(mapScenarioBindings.id, bindingId)).limit(1)
  if (!row) mapNotFound('地图绑定不存在')
  return toBindingDto(row)
}

function toBindingDto(row: {
  id: string
  targetId: string
  scenarioId: string
  stepId: string | null
  assetRefKey: string
  pageId: string | null
  objectId: string | null
  implementationKey: string | null
  descriptorVersion: number | null
  basis: string
  scopeKind: string
  draftRevision: number | null
  scenarioVersionId: string | null
  descriptorDigest: string | null
  confirmedBy: string | null
  confirmedAt: Date | null
  resolution: string
  sourceRef: Record<string, unknown> | null
}) {
  return mapScenarioBindingSchema.parse({
    bindingId: row.id,
    targetId: row.targetId,
    scenarioId: row.scenarioId,
    stepId: row.stepId ?? undefined,
    assetRef: {
      targetId: row.targetId,
      pageId: row.pageId ?? undefined,
      objectId: row.objectId ?? undefined,
      implementationKey: row.implementationKey ?? undefined,
      descriptorVersion: row.descriptorVersion ?? undefined,
    },
    assetRefKey: row.assetRefKey,
    basis: row.basis,
    scope:
      row.scopeKind === 'version' && row.scenarioVersionId
        ? { kind: 'version', scenarioVersionId: row.scenarioVersionId }
        : row.scopeKind === 'page_context'
          ? { kind: 'page_context' }
          : { kind: 'draft', revision: row.draftRevision ?? 0 },
    descriptorDigest: row.descriptorDigest ?? undefined,
    confirmedBy: row.confirmedBy ?? undefined,
    confirmedAt: row.confirmedAt?.toISOString(),
    resolution: row.resolution,
    sourceRef: row.sourceRef ?? undefined,
  })
}

export async function removeMapScenarioBinding(
  db: Db,
  targetId: string,
  bindingId: string,
  body: unknown,
  actor: ExecutionActor,
) {
  const parsed = mapBindingRemoveBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapScenarioBindings } = schemaFor(tx)
    const [row] = await tx.select().from(mapScenarioBindings).where(eq(mapScenarioBindings.id, bindingId)).limit(1)
    if (!row || row.targetId !== targetId) mapNotFound('地图绑定不存在')
    if (row.scopeKind === 'version' && (row.sourceRef as { kind?: string } | null)?.kind !== 'annotation') {
      mapReferenceUnresolved('已冻结的版本绑定不能直接删除')
    }
    await lockDraft(tx, row.scenarioId, parsed.expectedDraftRevision, targetId)
    const now = await clockNow(tx)
    await tx.update(mapScenarioBindings).set({ status: 'removed', updatedAt: now }).where(eq(mapScenarioBindings.id, bindingId))
    await recordAudit(tx, actor, 'map.unbind', 'map_binding', bindingId, '解除场景地图绑定')
    return { bindingId, removed: true }
  })
}

export async function reconcileMapDraftBindingsTx(tx: Db, input: { scenarioId: string; targetId: string; revision: number; document: unknown }) {
  const { mapScenarioBindings } = schemaFor(tx)
  const rows = await tx.select().from(mapScenarioBindings).where(and(eq(mapScenarioBindings.scenarioId, input.scenarioId), eq(mapScenarioBindings.versionSlot, 'draft'), eq(mapScenarioBindings.status, 'active')))
  const ids = new Set(explicitStepDocument(input.document).steps.map(step => step.id))
  const now = await clockNow(tx)
  for (const row of rows) await tx.update(mapScenarioBindings).set({
    status: row.targetId !== input.targetId || (row.stepId && !ids.has(row.stepId)) ? 'removed' : 'active',
    draftRevision: input.revision, updatedAt: now,
  }).where(eq(mapScenarioBindings.id, row.id))
}

export async function freezeMapDraftBindingsTx(
  tx: Db,
  input: { scenarioId: string; targetId: string; scenarioVersionId: string },
) {
  const { mapScenarioBindings, scenarioVersions } = schemaFor(tx)
  const [version] = await tx.select().from(scenarioVersions).where(eq(scenarioVersions.id, input.scenarioVersionId)).limit(1)
  const stepIds = new Set(parseScenarioDocument(version!.definition).steps.map(step => step.id))
  const drafts = await tx
    .select()
    .from(mapScenarioBindings)
    .where(
      and(
        eq(mapScenarioBindings.scenarioId, input.scenarioId),
        eq(mapScenarioBindings.targetId, input.targetId),
        or(eq(mapScenarioBindings.scopeKind, 'draft'), eq(mapScenarioBindings.scopeKind, 'page_context'))!,
        eq(mapScenarioBindings.status, 'active'),
      ),
    )
  const now = await clockNow(tx)
  await tx
    .delete(mapScenarioBindings)
    .where(
      and(
        eq(mapScenarioBindings.scenarioId, input.scenarioId),
        eq(mapScenarioBindings.scopeKind, 'version'),
        eq(mapScenarioBindings.versionSlot, input.scenarioVersionId),
      ),
    )
  for (const row of drafts) {
    if (row.stepId && !stepIds.has(row.stepId)) continue;
    await insertRows(tx, mapScenarioBindings, {
      id: newId(),
      targetId: input.targetId,
      scenarioId: input.scenarioId,
      slotKey: row.slotKey,
      stepId: row.stepId,
      assetRefKey: row.assetRefKey,
      pageId: row.pageId,
      objectId: row.objectId,
      implementationKey: row.implementationKey,
      descriptorVersion: row.descriptorVersion,
      basis: row.basis,
      scopeKind: 'version',
      draftRevision: null,
      scenarioVersionId: input.scenarioVersionId,
      versionSlot: input.scenarioVersionId,
      descriptorDigest: row.descriptorDigest,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt ?? now,
      resolution: row.resolution,
      sourceRef: { kind: 'publish-freeze', fromBindingId: row.id },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
  }
}

export async function listMapReferences(
  db: Db,
  targetId: string,
  query: MapListQuery & { visible: boolean },
) {
  await requireLiveTarget(db, targetId)
  const { mapReferenceCandidates, mapReferenceScanHeads, mapScenarioBindings, scenarios } = schemaFor(db)
  const [scan] = await db.select().from(mapReferenceScanHeads).where(eq(mapReferenceScanHeads.targetId, targetId)).limit(1)
  if (!query.visible) {
    return mapReferenceListResponseSchema.parse({
      items: [],
      restricted: true,
      scanStatus: scan?.status ?? 'idle',
      scanCompleteness: (scan?.completeness as 'complete' | 'partial' | 'unknown') ?? 'unknown',
    })
  }
  const bindings = await db
    .select()
    .from(mapScenarioBindings)
    .where(and(eq(mapScenarioBindings.targetId, targetId), eq(mapScenarioBindings.status, 'active')))
  const candidates = await db.select().from(mapReferenceCandidates).where(eq(mapReferenceCandidates.targetId, targetId))
  const scenarioRows = await db.select().from(scenarios).where(and(eq(scenarios.targetId, targetId), isNull(scenarios.deletedAt)))
  const names = new Map(scenarioRows.map((row) => [row.id, row.name]))
  const items = [
    ...bindings.filter(row => names.has(row.scenarioId))
      .filter(row => !query.scenarioId || row.scenarioId === query.scenarioId)
      .filter(row => !query.stepId || row.stepId === query.stepId)
      .filter(row => !query.scopeKind || row.scopeKind === query.scopeKind)
      .filter(row => !query.assetRefKey || row.assetRefKey === query.assetRefKey)
      .map((row) => ({
      grade: 'confirmed_reference' as const,
      bindingId: row.id,
      scenarioId: row.scenarioId,
      scenarioName: names.get(row.scenarioId),
      stepId: row.stepId ?? undefined,
      assetRefKey: row.assetRefKey,
      resolution: row.resolution,
      reasons: ['explicit-binding'],
      scope: toBindingDto(row).scope,
      sortKey: `c:${row.id}`,
    })),
    ...candidates
      .filter(row => names.has(row.scenarioId) && !query.scopeKind)
      .filter(row => !query.scenarioId || row.scenarioId === query.scenarioId)
      .filter(row => !query.stepId || row.stepId === query.stepId)
      .filter(row => !query.assetRefKey || row.assetRefKey === query.assetRefKey)
      .filter((row) => !bindings.some((binding) => binding.scenarioId === row.scenarioId && binding.assetRefKey === row.assetRefKey))
      .map((row) => ({
        grade: 'potential_match' as const,
        scenarioId: row.scenarioId,
        scenarioName: names.get(row.scenarioId),
        stepId: row.stepId,
        assetRefKey: row.assetRefKey,
        reasons: row.reasons,
        sortKey: `p:${row.id}`,
      })),
  ].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)
  const digest = sha256Hex(canonicalJson({ targetId, kind: 'references', search: query.search, scenarioId: query.scenarioId, stepId: query.stepId, scopeKind: query.scopeKind, assetRefKey: query.assetRefKey }))
  const after = query.cursor ? decodeMapCursor(query.cursor, digest) : undefined
  const filtered = (after ? items.filter((item) => item.sortKey > after) : items).filter((item) => {
    if (query.search && !`${item.scenarioName ?? ''} ${item.assetRefKey}`.includes(query.search)) return false
    return true
  })
  const page = filtered.slice(0, query.limit + 1)
  const hasMore = page.length > query.limit
  const shown = hasMore ? page.slice(0, query.limit) : page
  return mapReferenceListResponseSchema.parse({
    items: shown.map(({ sortKey: _s, ...item }) => item),
    nextCursor: hasMore ? encodeMapCursor(digest, shown.at(-1)!.sortKey) : undefined,
    restricted: false,
    scanStatus: scan?.status ?? 'idle',
    scanCompleteness: (scan?.completeness as 'complete' | 'partial' | 'unknown') ?? 'unknown',
  })
}

export async function loadMapImpactSource(
  db: Db,
  targetId: string,
  query: MapImpactQuery,
  visible: boolean,
) {
  await requireLiveTarget(db, targetId)
  if (!visible) return mapImpactSourceSchema.parse({ restricted: true, changedAssetKeys: [], bindings: [], candidates: [], visibleScenarioIds: [], scannedScenarioIds: [], scenarioNames: {} })
  const { mapReferenceCandidates, mapReferenceScanHeads, mapReleaseItems, mapScenarioBindings, scenarios } = schemaFor(db)
  const changed = new Set<string>()
  if (query.assetRefKey) changed.add(query.assetRefKey)
  if (query.fromReleaseId && query.toReleaseId) {
    await resolveMapView(db, targetId, { releaseId: query.fromReleaseId })
    await resolveMapView(db, targetId, { releaseId: query.toReleaseId })
    const fromItems = await db.select().from(mapReleaseItems).where(eq(mapReleaseItems.releaseId, query.fromReleaseId))
    const toItems = await db.select().from(mapReleaseItems).where(eq(mapReleaseItems.releaseId, query.toReleaseId))
    const toKeys = new Set(toItems.map(item => `${item.assetRefKey}:${item.lifecycle}`))
    for (const item of fromItems) if (!toKeys.has(`${item.assetRefKey}:${item.lifecycle}`)) changed.add(item.assetRefKey)
    const fromKeys = new Set(fromItems.map((item) => `${item.assetRefKey}:${item.lifecycle}`))
    for (const item of toItems) {
      if (!fromKeys.has(`${item.assetRefKey}:${item.lifecycle}`)) changed.add(item.assetRefKey)
    }
  }
  const bindings = await db
    .select()
    .from(mapScenarioBindings)
    .where(and(eq(mapScenarioBindings.targetId, targetId), eq(mapScenarioBindings.status, 'active')))
  const candidates = await db.select().from(mapReferenceCandidates).where(eq(mapReferenceCandidates.targetId, targetId))
  const scenarioRows = await db.select().from(scenarios).where(and(eq(scenarios.targetId, targetId), isNull(scenarios.deletedAt)))
  const [scan] = await db.select().from(mapReferenceScanHeads).where(eq(mapReferenceScanHeads.targetId, targetId)).limit(1)
  const names = new Map(scenarioRows.map((row) => [row.id, row.name]))
  if (!query.assetRefKey && !query.fromReleaseId) {
    for (const ref of [...bindings, ...candidates]) changed.add(ref.assetRefKey)
  }
  return mapImpactSourceSchema.parse({
    restricted: false,
    changedAssetKeys: [...changed],
    identityAliases: await loadIdentityAliases(db, targetId, 1_000_000_000),
    bindings: bindings.filter(row => names.has(row.scenarioId)).map(row => ({
      assetRef: toBindingDto(row).assetRef,
      bindingId: row.id, scenarioId: row.scenarioId, scenarioName: names.get(row.scenarioId),
      stepId: row.stepId ?? undefined, assetRefKey: row.assetRefKey, resolution: row.resolution, scope: toBindingDto(row).scope,
    })),
    candidates: candidates.filter(row => names.has(row.scenarioId)).map(row => ({
      scenarioId: row.scenarioId, scenarioName: names.get(row.scenarioId), stepId: row.stepId, assetRefKey: row.assetRefKey, reasons: row.reasons,
    })),
    visibleScenarioIds: scenarioRows.map(row => row.id),
    scannedScenarioIds: scenarioRows.filter(row => scan?.requestedAt && row.updatedAt <= scan.requestedAt && (scan.completeness === 'complete' || (scan.lastScenarioId && row.id <= scan.lastScenarioId))).map(row => row.id),
    scenarioNames: Object.fromEntries(names),
  })
}

export async function startMapReferenceScan(db: Db, targetId: string, actor: ExecutionActor) {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapReferenceScanHeads, mapReferenceCandidates, targets } = schemaFor(tx)
    await locked(tx, tx.select({ id: targets.id }).from(targets).where(eq(targets.id, targetId)))
    const now = await clockNow(tx)
    const [head] = await tx.select().from(mapReferenceScanHeads).where(eq(mapReferenceScanHeads.targetId, targetId)).limit(1)
    if (head?.status === 'running') return mapScanStartResponseSchema.parse({ status: head.status, completeness: head.completeness, scannedCount: head.scannedCount })
    await tx.delete(mapReferenceCandidates).where(eq(mapReferenceCandidates.targetId, targetId))
    if (head) {
      await tx
        .update(mapReferenceScanHeads)
        .set({ status: 'running', completeness: 'unknown', scannedCount: 0, lastScenarioId: null, requestedAt: now, updatedAt: now })
        .where(eq(mapReferenceScanHeads.targetId, targetId))
    } else {
      await tx.insert(mapReferenceScanHeads).values({
        targetId,
        status: 'running',
        completeness: 'unknown',
        scannedCount: 0,
        requestedAt: now,
        updatedAt: now,
      })
    }
    await recordAudit(tx, actor, 'map.scan', 'map', targetId, '开始扫描场景地图候选')
    const [current] = await tx.select().from(mapReferenceScanHeads).where(eq(mapReferenceScanHeads.targetId, targetId)).limit(1)
    return mapScanStartResponseSchema.parse({
      status: current!.status,
      completeness: current!.completeness as 'complete' | 'partial' | 'unknown',
      scannedCount: current!.scannedCount,
    })
  })
}

export async function listMapReferenceScanWork(db: Db, input: { limit?: number } = {}) {
  const { mapReferenceScanHeads } = schemaFor(db)
  return db
    .select()
    .from(mapReferenceScanHeads)
    .where(eq(mapReferenceScanHeads.status, 'running'))
    .limit(Math.min(input.limit ?? 4, 16))
}

export async function advanceMapReferenceScan(
  db: Db,
  input: {
    targetId: string
    batch: Array<{
      scenarioId: string
      scenarioVersionId?: string
      steps: Array<{ stepId: string; assetRefKey: string; pageId?: string; objectId?: string; reasons: string[] }>
    }>
    complete: boolean
    expectedLastScenarioId?: string | null
    requestedAt?: Date | null
  },
) {
  return atomic(db, async (tx) => {
    const { mapReferenceCandidates, mapReferenceScanHeads } = schemaFor(tx)
    const now = await clockNow(tx)
    const [head] = await locked(tx, tx.select().from(mapReferenceScanHeads).where(eq(mapReferenceScanHeads.targetId, input.targetId)))
    if (!head || head.status !== 'running' ||
      ('expectedLastScenarioId' in input && input.expectedLastScenarioId !== head.lastScenarioId) ||
      (input.requestedAt && input.requestedAt.getTime() !== head.requestedAt?.getTime())) return { scanned: 0, complete: false }
    for (const scenario of input.batch) {
      for (const step of scenario.steps) {
        const [existing] = await tx
          .select()
          .from(mapReferenceCandidates)
          .where(
            and(
              eq(mapReferenceCandidates.targetId, input.targetId),
              eq(mapReferenceCandidates.scenarioId, scenario.scenarioId),
              eq(mapReferenceCandidates.stepId, step.stepId),
              eq(mapReferenceCandidates.assetRefKey, step.assetRefKey),
            ),
          )
          .limit(1)
        if (existing) {
          await tx.update(mapReferenceCandidates).set({ reasons: step.reasons }).where(eq(mapReferenceCandidates.id, existing.id))
          continue
        }
        await insertRows(tx, mapReferenceCandidates, {
          id: newId(),
          targetId: input.targetId,
          scenarioId: scenario.scenarioId,
          scenarioVersionId: scenario.scenarioVersionId ?? null,
          stepId: step.stepId,
          assetRefKey: step.assetRefKey,
          pageId: step.pageId ?? null,
          objectId: step.objectId ?? null,
          reasons: step.reasons,
          createdAt: now,
        })
      }
    }
    const last = input.batch.at(-1)
    await tx
      .update(mapReferenceScanHeads)
      .set({
        status: input.complete ? 'complete' : 'running',
        completeness: input.complete ? 'complete' : 'partial',
        lastScenarioId: last?.scenarioId ?? head?.lastScenarioId ?? null,
        scannedCount: (head?.scannedCount ?? 0) + input.batch.length,
        updatedAt: now,
      })
      .where(eq(mapReferenceScanHeads.targetId, input.targetId))
    return { scanned: input.batch.length, complete: input.complete }
  })
}

export async function loadTargetScanSource(db: Db, targetId: string, input: { afterScenarioId?: string | null; limit?: number } = {}) {
  const { mapImplementations, mapObjectDescriptors, mapPages, mapProjectionAssets, mapProjectionHeads, scenarioDrafts, scenarioVersions, scenarios } =
    schemaFor(db)
  const [head] = await db.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)).limit(1)
  const assets = head
    ? await db.select().from(mapProjectionAssets).where(eq(mapProjectionAssets.projectionId, head.currentProjectionId))
    : []
  const pages = await db.select().from(mapPages).where(eq(mapPages.targetId, targetId))
  const descriptors = await db.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.targetId, targetId))
  void mapImplementations
  const scenarioRows = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.targetId, targetId), isNull(scenarios.deletedAt), input.afterScenarioId ? gt(scenarios.id, input.afterScenarioId) : undefined))
    .orderBy(asc(scenarios.id))
    .limit(Math.min(input.limit ?? 9, 100))
  const ids = scenarioRows.map(row => row.id)
  const drafts = ids.length ? await db.select().from(scenarioDrafts).where(inArray(scenarioDrafts.scenarioId, ids)) : []
  const versions = ids.length ? await db.select().from(scenarioVersions).where(inArray(scenarioVersions.scenarioId, ids)) : []
  return {
    assets: assets.map((asset) => ({
      assetRefKey: asset.assetRefKey,
      pageId: asset.pageId ?? undefined,
      objectId: asset.objectId ?? undefined,
      routeTemplate: pages.find((page) => page.id === asset.pageId)?.routeTemplate,
      semanticName: descriptors.find((row) => row.objectId === asset.objectId)?.features
        ? String((descriptors.find((row) => row.objectId === asset.objectId)?.features as { semanticName?: string }).semanticName ?? '')
        : undefined,
    })),
    scenarios: scenarioRows.map((scenario) => {
      const published = versions
        .filter((row) => row.scenarioId === scenario.id && row.kind === 'published')
        .sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0]
      const draft = drafts.find((row) => row.scenarioId === scenario.id)
      const document = published?.definition ?? draft?.document
      return {
        scenarioId: scenario.id,
        scenarioVersionId: published?.id,
        document,
      }
    }),
  }
}

export async function loadRunMapClues(db: Db, targetId: string, runId: string) {
  await requireLiveTarget(db, targetId)
  const { mapObservations, mapVerificationRefs, mapVerifications, runs } = schemaFor(db)
  const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), isNull(runs.deletedAt))).limit(1)
  if (!run || run.targetId !== targetId) throw notFound('RUN_NOT_FOUND', '运行不存在')
  const observations = await db
    .select()
    .from(mapObservations)
    .where(and(eq(mapObservations.targetId, targetId), eq(mapObservations.sourceRunId, runId)))
  const observationIds = observations.map((row) => row.id)
  const refs = observationIds.length
    ? await db.select().from(mapVerificationRefs).where(eq(mapVerificationRefs.targetId, targetId))
    : []
  const linked = refs.filter((row) => observationIds.includes(row.observationId)).map((row) => row.verificationId)
  const verifications = linked.length
    ? await db.select().from(mapVerifications).where(eq(mapVerifications.targetId, targetId))
    : []
  return {
    runId,
    targetId,
    rows: verifications
      .filter((row) => linked.includes(row.id))
      .map((row) => ({
        dimension: row.dimension,
        verdict: row.verdict,
        note: typeof (row.envelope as { note?: string }).note === 'string' ? (row.envelope as { note?: string }).note : undefined,
      })),
  }
}

export type RunMapClueRow = {
  dimension: 'identity' | 'locator' | 'action' | 'business'
  verdict: 'confirmed' | 'rejected' | 'unknown' | 'not_observed'
  note?: string
}
