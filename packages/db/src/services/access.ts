import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ACTIVE_RUN_STATUSES,
  hasAllPermissions,
  stepUsesBrowser,
  externalRunBodySchema,
  externalRunSchema,
  hasAiSteps,
  isAiCallEvidence,
  issueServiceCredentialSchema,
  isIpAllowedByAllowlist,
  serviceAdmissionSchema,
  serviceCallerBodySchema,
  serviceCallerDetailSchema,
  serviceCallerListSchema,
  serviceCallerQueryValueSchema,
  serviceCallerSchema,
  serviceCallerStatusBodySchema,
  serviceCredentialPolicySchema,
  serviceCredentialSchema,
  serviceCredentialMetadataBodySchema,
  serviceCredentialCatalogSchema,
  serviceIpWhitelistBodySchema,
  servicePageQuerySchema,
  servicePrincipalSchema,
  serviceRequestLogItemSchema,
  serviceRequestLogListSchema,
  serviceRequestLogQuerySchema,
  serviceRequestLogRecordSchema,
  serviceOutstandingRunListSchema,
  serviceRunCancelResultSchema,
  type AiExecutionConfig,
  type ExternalRunBody,
  type IssueServiceCredential,
  type ServiceCallerBody,
  type ServiceCallerQuery,
  type ServiceCallerQueryValue,
  type ServiceCallerStatusBody,
  type ServiceCredentialMetadataBody,
  type ServiceIpWhitelistBody,
  type ServiceCredentialPolicy,
  type ServiceRequestLogQuery,
  type ServiceRequestLogRecord,
  type ServiceOutstandingRunQuery,
  type ServicePageQuery,
  type ServicePrincipal,
  type ServiceScope,
} from "@cairn/shared";
import type { Db } from "../client.js";
import { atomic, clockNow, locked, schemaFor } from "../native.js";
import { newId } from "../id.js";
import { recordAudit, type AuditActor } from "../audit/record.js";
import {
  badRequest,
  conflict,
  DomainError,
  forbidden,
  notFound,
} from "../runs/errors.js";
import {
  createRunWithSnapshot,
  getRun,
  requestRunCancel,
} from "../runs/runs.js";
import { sha256Hex } from "../runs/digest.js";
import { actorPermissions } from "../credentials/access.js";
import {
  assertTargetPermission,
  lockConsoleAuthorization,
  targetScopeFilter,
  targetScopeFor,
  type TargetScope,
} from "../console/target-authorization.js";
import { cursorFilter, encodeCursor } from "../cursor.js";

const outstanding = ACTIVE_RUN_STATUSES;
const denied = () =>
  new DomainError(
    "unauthorized",
    "SERVICE_CREDENTIAL_INVALID",
    "服务凭据无效或已停用",
  );
const digestSecret = (secret: string) =>
  createHash("sha256").update("cairn-service-key-v1\0").update(secret).digest();
const iso = (d: Date | null) => d?.toISOString() ?? null;
function page<T extends { id: string }>(rows: T[], limit: number) {
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : undefined,
  };
}
type ServiceCallerCursor = {
  version: 1;
  sortBy: ServiceCallerQueryValue["sortBy"];
  sortOrder: ServiceCallerQueryValue["sortOrder"];
  search: string;
  status: ServiceCallerQueryValue["status"];
  includeArchived: boolean;
  limit: number;
  sortValue: string | number;
  id: string;
};
const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const asciiLower = (value: string) =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());
const asciiLowerColumn = (column: SQL) =>
  [...ASCII_UPPERCASE].reduce(
    (value, upper, index) =>
      sql`replace(${value}, ${upper}, ${ASCII_LOWERCASE[index]!})`,
    column,
  );
const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function usesLegacyServiceCallerCursor(query: ServiceCallerQueryValue) {
  return (
    query.sortBy === "id" &&
    query.sortOrder === "asc" &&
    query.search === "" &&
    query.status === "all" &&
    !query.includeArchived
  );
}
function encodeServiceCallerCursor(
  query: ServiceCallerQueryValue,
  row: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    outstandingRuns: number;
  },
) {
  const sortValue =
    query.sortBy === "createdAt"
      ? row.createdAt.toISOString()
      : query.sortBy === "updatedAt"
        ? row.updatedAt.toISOString()
        : query.sortBy === "outstandingRuns"
          ? row.outstandingRuns
          : row.id;
  return Buffer.from(
    JSON.stringify({
      version: 1,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      search: query.search,
      status: query.status,
      includeArchived: query.includeArchived,
      limit: query.limit,
      sortValue,
      id: row.id,
    } satisfies ServiceCallerCursor),
  ).toString("base64url");
}
function decodeServiceCallerCursor(
  cursor: string | undefined,
  query: ServiceCallerQueryValue,
): ServiceCallerCursor | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object") throw new Error("shape");
    const parsed = value as Record<string, unknown>;
    const {
      version,
      sortBy,
      sortOrder,
      search,
      status,
      includeArchived,
      limit,
      sortValue,
      id,
    } = parsed;
    if (
      version !== 1 ||
      sortBy !== query.sortBy ||
      sortOrder !== query.sortOrder ||
      search !== query.search ||
      status !== query.status ||
      includeArchived !== query.includeArchived ||
      limit !== query.limit ||
      !isUuid(id)
    )
      throw new Error("shape");
    if (
      sortBy === "outstandingRuns" &&
      (typeof sortValue !== "number" ||
        !Number.isInteger(sortValue) ||
        sortValue < 0)
    )
      throw new Error("shape");
    if (sortBy === "id" && (!isUuid(sortValue) || sortValue !== id))
      throw new Error("shape");
    if (
      (sortBy === "createdAt" || sortBy === "updatedAt") &&
      (typeof sortValue !== "string" ||
        Number.isNaN(new Date(sortValue).getTime()))
    )
      throw new Error("shape");
    return {
      version: 1,
      sortBy: sortBy as ServiceCallerQueryValue["sortBy"],
      sortOrder: sortOrder as ServiceCallerQueryValue["sortOrder"],
      search: search as string,
      status: status as ServiceCallerQueryValue["status"],
      includeArchived: includeArchived as boolean,
      limit: limit as number,
      sortValue: sortValue as string | number,
      id,
    };
  } catch {
    throw badRequest(
      "SERVICE_CURSOR_INVALID",
      "分页游标无效，请从首页重新查询",
    );
  }
}
async function assertConsolePermissions(
  db: Db,
  actorId: string,
  required: readonly string[],
) {
  await lockConsoleAuthorization(db, actorId);
  if (!hasAllPermissions(await actorPermissions(db, actorId), required))
    throw forbidden("FORBIDDEN", "当前账号没有执行此服务管理操作的权限");
}
async function callerRow(db: Db, id: string) {
  const { serviceCallers } = schemaFor(db);
  // ponytail: one lock per caller serializes admission and governance; split only if measured throughput requires it.
  const [row] = await locked(
    db,
    db.select().from(serviceCallers).where(eq(serviceCallers.id, id)),
  );
  if (!row) throw notFound("SERVICE_NOT_FOUND", "服务调用方不存在");
  return row;
}
async function credentialRow(db: Db, callerId: string, id: string) {
  const { serviceCredentials } = schemaFor(db);
  const [row] = await db
    .select()
    .from(serviceCredentials)
    .where(
      and(
        eq(serviceCredentials.id, id),
        eq(serviceCredentials.callerId, callerId),
      ),
    );
  if (!row) throw notFound("CREDENTIAL_NOT_FOUND", "服务凭据不存在");
  return row;
}
async function credentialDto(
  db: Db,
  row: Awaited<ReturnType<typeof credentialRow>>,
) {
  const { credentialTargetGrants: tg, credentialTargetAccountGrants: ag } =
    schemaFor(db);
  const grants = await db.select().from(tg).where(eq(tg.credentialId, row.id));
  const accounts = await db
    .select()
    .from(ag)
    .where(eq(ag.credentialId, row.id));
  const now = await clockNow(db);
  return serviceCredentialSchema.parse({
    ...row,
    status: row.revokedAt
      ? "revoked"
      : row.expiresAt <= now
        ? "expired"
        : row.suspendedAt
          ? "suspended"
          : "active",
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    suspendedAt: iso(row.suspendedAt),
    lastUsedAt: iso(row.lastUsedAt),
    grants: grants.map((g) => ({
      targetId: g.targetId,
      allowAnonymous: g.allowAnonymous === 1,
      accountIds: accounts
        .filter((a) => a.targetId === g.targetId)
        .map((a) => a.targetAccountId),
    })),
  });
}
async function callerDto(
  db: Db,
  row: Awaited<ReturnType<typeof callerRow>>,
  counts?: { outstandingRuns: number; credentialCount: number },
) {
  const { runs, serviceCredentials } = schemaFor(db);
  const resolvedCounts = counts ?? {
    outstandingRuns: Number(
      (
        await db
          .select({ n: count() })
          .from(runs)
          .where(
            and(
              eq(runs.serviceCallerId, row.id),
              isNull(runs.deletedAt),
              inArray(runs.status, [...outstanding]),
            ),
          )
      )[0]?.n ?? 0,
    ),
    credentialCount: Number(
      (
        await db
          .select({ n: count() })
          .from(serviceCredentials)
          .where(eq(serviceCredentials.callerId, row.id))
      )[0]?.n ?? 0,
    ),
  };
  return {
    ...row,
    outstandingRuns: resolvedCounts.outstandingRuns,
    credentialCount: resolvedCounts.credentialCount,
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
function assertCallerWritable(caller: { archivedAt: Date | null }) {
  if (caller.archivedAt)
    throw conflict(
      "SERVICE_ARCHIVED",
      "服务调用方已归档，不能再修改或签发凭据",
    );
}
export async function listServiceCallers(db: Db, query: ServiceCallerQuery) {
  const q = serviceCallerQueryValueSchema.parse(query);
  const legacy = usesLegacyServiceCallerCursor(q);
  const legacyCursor =
    legacy && q.cursor ? (isUuid(q.cursor) ? q.cursor : null) : undefined;
  if (legacy && q.cursor && !legacyCursor)
    throw badRequest(
      "SERVICE_CURSOR_INVALID",
      "分页游标无效，请从首页重新查询",
    );
  const cursor = legacy ? undefined : decodeServiceCallerCursor(q.cursor, q);
  const { runs, serviceCallers, serviceCredentials } = schemaFor(db);
  const outstandingRuns = sql<number>`(
    select count(*) from ${runs}
    where ${and(
      eq(runs.serviceCallerId, serviceCallers.id),
      isNull(runs.deletedAt),
      inArray(runs.status, [...outstanding]),
    )}
  )`;
  const credentialCount = sql<number>`(
    select count(*) from ${serviceCredentials}
    where ${eq(serviceCredentials.callerId, serviceCallers.id)}
  )`;
  const search = asciiLower(q.search);
  const direction = q.sortOrder === "asc" ? asc : desc;
  const idDirection = q.sortOrder === "asc" ? asc : desc;
  const idAfter = (value: string) =>
    q.sortOrder === "asc"
      ? gt(serviceCallers.id, value)
      : lt(serviceCallers.id, value);
  let after: SQL | undefined;
  if (legacyCursor) after = gt(serviceCallers.id, legacyCursor);
  else if (cursor && q.sortBy === "id") after = idAfter(cursor.id);
  else if (cursor && q.sortBy === "createdAt") {
    const value = new Date(cursor.sortValue as string);
    after = or(
      q.sortOrder === "asc"
        ? gt(serviceCallers.createdAt, value)
        : lt(serviceCallers.createdAt, value),
      and(eq(serviceCallers.createdAt, value), idAfter(cursor.id)),
    );
  } else if (cursor && q.sortBy === "updatedAt") {
    const value = new Date(cursor.sortValue as string);
    after = or(
      q.sortOrder === "asc"
        ? gt(serviceCallers.updatedAt, value)
        : lt(serviceCallers.updatedAt, value),
      and(eq(serviceCallers.updatedAt, value), idAfter(cursor.id)),
    );
  } else if (cursor && q.sortBy === "outstandingRuns") {
    const value = cursor.sortValue as number;
    after = or(
      q.sortOrder === "asc"
        ? gt(outstandingRuns, value)
        : lt(outstandingRuns, value),
      and(eq(outstandingRuns, value), idAfter(cursor.id)),
    );
  }
  const sortColumn =
    q.sortBy === "createdAt"
      ? serviceCallers.createdAt
      : q.sortBy === "updatedAt"
        ? serviceCallers.updatedAt
        : q.sortBy === "outstandingRuns"
          ? outstandingRuns
          : serviceCallers.id;
  const rows = await db
    .select({ caller: serviceCallers, outstandingRuns, credentialCount })
    .from(serviceCallers)
    .where(
      and(
        q.includeArchived ? undefined : isNull(serviceCallers.archivedAt),
        q.status === "all" ? undefined : eq(serviceCallers.status, q.status),
        search
          ? or(
              sql`position(${search} in ${asciiLowerColumn(sql`${serviceCallers.name}`)}) > 0`,
              sql`position(${search} in ${asciiLowerColumn(sql`${serviceCallers.owner}`)}) > 0`,
            )
          : undefined,
        after,
      ),
    )
    .orderBy(direction(sortColumn), idDirection(serviceCallers.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit);
  return serviceCallerListSchema.parse({
    items: await Promise.all(
      items.map((row) =>
        callerDto(db, row.caller, {
          outstandingRuns: Number(row.outstandingRuns),
          credentialCount: Number(row.credentialCount),
        }),
      ),
    ),
    nextCursor:
      rows.length > q.limit
        ? legacy
          ? items[items.length - 1]!.caller.id
          : encodeServiceCallerCursor(q, {
              id: items[items.length - 1]!.caller.id,
              createdAt: items[items.length - 1]!.caller.createdAt,
              updatedAt: items[items.length - 1]!.caller.updatedAt,
              outstandingRuns: Number(items[items.length - 1]!.outstandingRuns),
            })
        : undefined,
  });
}
export async function getServiceCaller(db: Db, id: string) {
  const { serviceCredentials } = schemaFor(db);
  const caller = await callerRow(db, id);
  const credentials = await db
    .select()
    .from(serviceCredentials)
    .where(eq(serviceCredentials.callerId, id))
    .orderBy(asc(serviceCredentials.createdAt));
  return serviceCallerDetailSchema.parse({
    caller: await callerDto(db, caller),
    credentials: await Promise.all(
      credentials.map((c) => credentialDto(db, c)),
    ),
  });
}
export async function saveServiceCaller(
  db: Db,
  id: string | null,
  body: ServiceCallerBody,
  actor: AuditActor,
) {
  const value = serviceCallerBodySchema.parse(body),
    callerId = id ?? newId();
  await atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const { serviceCallers } = schemaFor(tx),
      now = await clockNow(tx);
    if (id) {
      assertCallerWritable(await callerRow(tx, id));
      await tx
        .update(serviceCallers)
        .set({ ...value, updatedAt: now })
        .where(eq(serviceCallers.id, id));
    } else
      await tx
        .insert(serviceCallers)
        .values({ id: callerId, ...value, createdAt: now, updatedAt: now });
    await recordAudit(
      tx,
      actor,
      id ? "service.update" : "service.create",
      "service",
      callerId,
      id ? "更新服务调用方与资源限制" : "创建服务调用方",
    );
  });
  return getServiceCaller(db, callerId);
}
export async function setServiceCallerStatus(
  db: Db,
  id: string,
  body: ServiceCallerStatusBody,
  actor: AuditActor,
) {
  const value = serviceCallerStatusBodySchema.parse(body);
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const caller = await callerRow(tx, id);
    assertCallerWritable(caller);
    if (caller.status === value.status)
      return serviceCallerSchema.parse(await callerDto(tx, caller));
    const { serviceCallers } = schemaFor(tx);
    const now = await clockNow(tx);
    await tx
      .update(serviceCallers)
      .set({ status: value.status, updatedAt: now })
      .where(eq(serviceCallers.id, id));
    await recordAudit(
      tx,
      actor,
      "service.status",
      "service",
      id,
      `${value.status === "active" ? "启用" : "停用"}服务调用方`,
    );
    return serviceCallerSchema.parse(
      await callerDto(tx, await callerRow(tx, id)),
    );
  });
}
export async function setServiceCallerIpWhitelist(
  db: Db,
  id: string,
  body: ServiceIpWhitelistBody,
  actor: AuditActor,
) {
  const value = serviceIpWhitelistBodySchema.parse(body);
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const caller = await callerRow(tx, id);
    assertCallerWritable(caller);
    if (
      caller.ipWhitelist.length === value.entries.length &&
      caller.ipWhitelist.every((entry, index) => entry === value.entries[index])
    )
      return serviceCallerSchema.parse(await callerDto(tx, caller));
    const { serviceCallers } = schemaFor(tx);
    const now = await clockNow(tx);
    await tx
      .update(serviceCallers)
      .set({ ipWhitelist: value.entries, updatedAt: now })
      .where(eq(serviceCallers.id, id));
    await recordAudit(
      tx,
      actor,
      "service.ip_whitelist",
      "service",
      id,
      value.entries.length
        ? `更新来源 IP 白名单（${value.entries.length} 条）`
        : "清空来源 IP 白名单",
    );
    return serviceCallerSchema.parse(
      await callerDto(tx, await callerRow(tx, id)),
    );
  });
}
export async function archiveServiceCaller(
  db: Db,
  id: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const caller = await callerRow(tx, id);
    if (caller.archivedAt)
      return serviceCallerSchema.parse(await callerDto(tx, caller));
    const { runs, serviceCallers } = schemaFor(tx);
    const [active] = await tx
      .select({ n: count() })
      .from(runs)
      .where(
        and(
          eq(runs.serviceCallerId, id),
          isNull(runs.deletedAt),
          inArray(runs.status, [...outstanding]),
        ),
      );
    if (Number(active?.n ?? 0) > 0)
      throw conflict(
        "SERVICE_HAS_OUTSTANDING_RUNS",
        "仍有未结束运行，处理完成后才能归档",
      );
    const now = await clockNow(tx);
    await tx
      .update(serviceCallers)
      .set({ status: "disabled", archivedAt: now, updatedAt: now })
      .where(eq(serviceCallers.id, id));
    await recordAudit(
      tx,
      actor,
      "service.archive",
      "service",
      id,
      "归档服务调用方",
    );
    return serviceCallerSchema.parse(
      await callerDto(tx, await callerRow(tx, id)),
    );
  });
}
export async function listServiceOutstandingRuns(
  db: Db,
  callerId: string,
  query: ServiceOutstandingRunQuery,
  actor: AuditActor,
) {
  const q = servicePageQuerySchema.parse(query);
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:read", "run:read"]);
    await callerRow(tx, callerId);
    const {
      runs,
      scenarios,
      scenarioVersions,
      serviceCredentials,
      targets,
      targetAccounts,
      stepRuns,
    } = schemaFor(tx);
    const permissions = await actorPermissions(tx, actor.id);
    const targetReadScope = await targetScopeFor(tx, actor.id, "target:read");
    const runReadScope = await targetScopeFor(tx, actor.id, "run:read");
    const runCancelScope = await targetScopeFor(tx, actor.id, "run:cancel");
    const runReviewScope = await targetScopeFor(tx, actor.id, "run:review");
    const targetScope = and(
      targetScopeFilter(runs.targetId, targetReadScope),
      targetScopeFilter(runs.targetId, runReadScope),
    );
    const activeFilter = and(
      eq(runs.serviceCallerId, callerId),
      isNull(runs.deletedAt),
      inArray(runs.status, [...outstanding]),
    );
    const all = await tx.select({ n: count() }).from(runs).where(activeFilter);
    const visible = await tx
      .select({ n: count() })
      .from(runs)
      .where(and(activeFilter, targetScope));
    const observedAt = await clockNow(tx);
    const rows = await tx
      .select({
        run: runs,
        scenarioName: scenarios.name,
        scenarioVersionNo: scenarioVersions.versionNo,
        credentialName: serviceCredentials.name,
        targetName: targets.name,
        targetAccountName: targetAccounts.displayName,
      })
      .from(runs)
      .innerJoin(scenarios, eq(scenarios.id, runs.scenarioId))
      .innerJoin(
        scenarioVersions,
        eq(scenarioVersions.id, runs.scenarioVersionId),
      )
      .innerJoin(
        serviceCredentials,
        eq(serviceCredentials.id, runs.serviceCredentialId),
      )
      .innerJoin(targets, eq(targets.id, runs.targetId))
      .leftJoin(targetAccounts, eq(targetAccounts.id, runs.targetAccountId))
      .where(
        and(
          activeFilter,
          targetScope,
          q.cursor ? gt(runs.id, q.cursor) : undefined,
        ),
      )
      .orderBy(asc(runs.id))
      .limit(q.limit + 1);
    const result = page(
      rows.map((row) => ({ ...row, id: row.run.id })),
      q.limit,
    );
    const runIds = result.items.map((row) => row.run.id);
    const steps = runIds.length
      ? await tx
          .select({
            runId: stepRuns.runId,
            ordinal: stepRuns.ordinal,
            name: stepRuns.name,
            status: stepRuns.status,
          })
          .from(stepRuns)
          .where(inArray(stepRuns.runId, runIds))
      : [];
    const current = new Map<
      (typeof steps)[number]["runId"],
      (typeof steps)[number]
    >();
    for (const step of steps) {
      const existing = current.get(step.runId);
      const priority = (status: string) =>
        status === "RUNNING"
          ? 0
          : status === "FAILED"
            ? 1
            : status === "PENDING"
              ? 3
              : 2;
      if (
        priority(step.status) < 3 &&
        (!existing ||
          priority(step.status) < priority(existing.status) ||
          (priority(step.status) === priority(existing.status) &&
            step.ordinal > existing.ordinal))
      )
        current.set(step.runId, step);
    }
    const inScope = (scope: TargetScope, targetId: string) =>
      scope.all || scope.ids.includes(targetId);
    const canRequestCancel = hasAllPermissions(permissions, [
      "service:write",
      "run:cancel",
    ]);
    const canSubmitReview = hasAllPermissions(permissions, ["run:review"]);
    return serviceOutstandingRunListSchema.parse({
      nextCursor: result.nextCursor,
      outstandingRuns: Number(all[0]?.n ?? 0),
      visibleOutstandingRuns: Number(visible[0]?.n ?? 0),
      observedAt: iso(observedAt),
      items: result.items.map((row) => {
        const step = current.get(row.run.id);
        const admission = serviceAdmissionSchema.parse(
          row.run.serviceAdmission,
        );
        return {
          id: row.run.id,
          scenarioId: row.run.scenarioId,
          scenarioName: row.scenarioName,
          scenarioVersionId: row.run.scenarioVersionId,
          scenarioVersionNo: row.scenarioVersionNo,
          targetId: row.run.targetId,
          targetName: row.targetName,
          targetAccountId: row.run.targetAccountId,
          targetAccountName: row.targetAccountName,
          status: row.run.status,
          cancelRequested: row.run.cancelRequestedAt !== null,
          currentStepIndex: step?.ordinal ?? null,
          currentStepName: step?.name ?? null,
          createdAt: iso(row.run.createdAt),
          startedAt: iso(row.run.startedAt),
          durationSeconds: Math.max(
            0,
            Math.floor(
              (observedAt.getTime() - row.run.createdAt.getTime()) / 1000,
            ),
          ),
          idempotencyKey: row.run.idempotencyKey ?? admission.requestId,
          credentialId: row.run.serviceCredentialId!,
          credentialName: row.credentialName,
          canCancel:
            canRequestCancel &&
            row.run.status !== "NEEDS_REVIEW" &&
            row.run.cancelRequestedAt === null &&
            inScope(targetReadScope, row.run.targetId) &&
            inScope(runCancelScope, row.run.targetId),
          canReview:
            row.run.status === "NEEDS_REVIEW" &&
            canSubmitReview &&
            inScope(targetReadScope, row.run.targetId) &&
            inScope(runReviewScope, row.run.targetId),
        };
      }),
    });
  });
}
export async function cancelServiceOutstandingRun(
  db: Db,
  callerId: string,
  runId: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, [
      "service:write",
      "run:cancel",
    ]);
    // Caller -> target scope -> Run keeps the governance/admission lock direction one-way.
    await callerRow(tx, callerId);
    const { runs } = schemaFor(tx);
    const [run] = await tx
      .select({ targetId: runs.targetId })
      .from(runs)
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.serviceCallerId, callerId),
          isNull(runs.deletedAt),
        ),
      )
      .limit(1);
    if (!run) throw notFound("RUN_NOT_FOUND", "运行不存在或不属于此调用方");
    await assertTargetPermission(tx, actor.id, run.targetId, "run:cancel");
    const detail = await requestRunCancel(tx, runId, {
      kind: "console",
      id: actor.id,
    });
    const observedAt = await clockNow(tx);
    return serviceRunCancelResultSchema.parse({
      runId: detail.id,
      status: detail.status,
      cancelRequested: detail.cancelRequested,
      occupiesServiceCapacity: (outstanding as readonly string[]).includes(
        detail.status,
      ),
      observedAt: iso(observedAt),
    });
  });
}
async function replaceGrants(
  db: Db,
  credentialId: string,
  grants: ServiceCredentialPolicy["grants"],
) {
  const {
    credentialTargetGrants: tg,
    credentialTargetAccountGrants: ag,
    targets,
    targetAccounts,
  } = schemaFor(db);
  for (const g of grants) {
    const [t] = await db
      .select({ id: targets.id })
      .from(targets)
      .where(eq(targets.id, g.targetId));
    if (!t) throw badRequest("GRANT_TARGET_INVALID", "授权目标不存在");
    if (g.accountIds.length) {
      const accounts = await db
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(
          and(
            eq(targetAccounts.targetId, g.targetId),
            inArray(targetAccounts.id, g.accountIds),
          ),
        );
      if (accounts.length !== g.accountIds.length)
        throw badRequest("GRANT_ACCOUNT_MISMATCH", "授权账号不属于目标系统");
    }
  }
  await db.delete(ag).where(eq(ag.credentialId, credentialId));
  await db.delete(tg).where(eq(tg.credentialId, credentialId));
  for (const g of grants) {
    await db
      .insert(tg)
      .values({
        credentialId,
        targetId: g.targetId,
        allowAnonymous: g.allowAnonymous ? 1 : 0,
      });
    if (g.accountIds.length)
      await db.insert(ag).values(
        g.accountIds.map((targetAccountId) => ({
          credentialId,
          targetId: g.targetId,
          targetAccountId,
        })),
      );
  }
}
export async function issueServiceCredential(
  db: Db,
  callerId: string,
  body: IssueServiceCredential,
  actor: AuditActor,
) {
  const value = issueServiceCredentialSchema.parse(body),
    id = newId(),
    secret = randomBytes(32).toString("base64url");
  const credential = await atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const { serviceCredentials } = schemaFor(tx);
    assertCallerWritable(await callerRow(tx, callerId));
    const [total] = await tx
      .select({ n: count() })
      .from(serviceCredentials)
      .where(eq(serviceCredentials.callerId, callerId));
    if (Number(total!.n) >= 200)
      throw conflict(
        "CREDENTIAL_LIMIT",
        "每个调用方最多保留 200 个凭据，请建立新的调用方",
      );
    const now = await clockNow(tx);
    await tx.insert(serviceCredentials).values({
      id,
      callerId,
      name: value.name,
      scopes: value.scopes,
      secretDigest: digestSecret(secret).toString("hex"),
      metadataRevision: 1,
      notes: null,
      expiresAt: new Date(now.getTime() + value.expiresInDays * 86400000),
      createdByConsoleAccountId: actor.id,
      createdAt: now,
    });
    await replaceGrants(tx, id, value.grants);
    await recordAudit(
      tx,
      actor,
      "credential.issue",
      "service",
      callerId,
      `签发凭据 ${id}`,
    );
    const issued = await credentialRow(tx, callerId, id);
    const { syncServiceKeyProjection } =
      await import("../credentials/index.js");
    await syncServiceKeyProjection(tx, {
      credentialId: id,
      name: value.name,
      notes: null,
      expiresAt: issued.expiresAt,
      actor,
    });
    return credentialDto(tx, issued);
  });
  return { credential, token: `cairn_sk_${id}.${secret}` };
}
export async function updateServiceCredential(
  db: Db,
  callerId: string,
  id: string,
  body: ServiceCredentialPolicy | null,
  actor: AuditActor,
) {
  const value =
    body === null ? null : serviceCredentialPolicySchema.parse(body);
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const { serviceCredentials } = schemaFor(tx);
    const caller = await callerRow(tx, callerId);
    if (value) assertCallerWritable(caller);
    const current = await credentialRow(tx, callerId, id),
      now = await clockNow(tx);
    if (value && (current.revokedAt || current.expiresAt <= now))
      throw conflict("CREDENTIAL_INACTIVE", "已吊销或过期凭据不可修改");
    if (value && current.name !== value.name)
      throw conflict(
        "CREDENTIAL_METADATA_UPDATE_REQUIRED",
        "请通过凭据展示信息接口修改名称",
      );
    await tx
      .update(serviceCredentials)
      .set({
        ...(value
          ? { scopes: value.scopes }
          : { revokedAt: current.revokedAt ?? now }),
        revision: current.revision + 1,
      })
      .where(eq(serviceCredentials.id, id));
    if (value) await replaceGrants(tx, id, value.grants);
    await recordAudit(
      tx,
      actor,
      value ? "credential.update" : "credential.revoke",
      "service",
      callerId,
      `${value ? "更新" : "吊销"}凭据 ${id}`,
    );
    return credentialDto(tx, await credentialRow(tx, callerId, id));
  });
}
export async function setServiceCredentialSuspended(
  db: Db,
  callerId: string,
  id: string,
  suspended: boolean,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const caller = await callerRow(tx, callerId);
    assertCallerWritable(caller);
    const current = await credentialRow(tx, callerId, id);
    const now = await clockNow(tx);
    if (current.revokedAt || current.expiresAt <= now) {
      if (!suspended)
        throw conflict(
          "CREDENTIAL_REACTIVATION_UNAVAILABLE",
          "已吊销或过期凭据不能恢复使用",
        );
      throw conflict("CREDENTIAL_INACTIVE", "已吊销或过期凭据不能冻结");
    }
    if ((current.suspendedAt !== null) === suspended)
      return credentialDto(tx, current);
    const { serviceCredentials } = schemaFor(tx);
    await tx
      .update(serviceCredentials)
      .set({ suspendedAt: suspended ? now : null })
      .where(eq(serviceCredentials.id, id));
    await recordAudit(
      tx,
      actor,
      suspended ? "credential.suspend" : "credential.reactivate",
      "credential",
      id,
      `${suspended ? "冻结" : "恢复"}服务凭据`,
    );
    return credentialDto(tx, await credentialRow(tx, callerId, id));
  });
}
export async function updateServiceCredentialMetadata(
  db: Db,
  callerId: string,
  id: string,
  body: ServiceCredentialMetadataBody,
  actor: AuditActor,
) {
  const value = serviceCredentialMetadataBodySchema.parse(body);
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:write"]);
    const caller = await callerRow(tx, callerId);
    assertCallerWritable(caller);
    const current = await credentialRow(tx, callerId, id);
    if (current.metadataRevision !== value.expectedMetadataRevision)
      throw conflict(
        "CREDENTIAL_METADATA_CONFLICT",
        "凭据展示信息已被更新，请刷新后重试",
      );
    const { serviceCredentials } = schemaFor(tx);
    await tx
      .update(serviceCredentials)
      .set({
        name: value.name,
        notes: value.notes,
        metadataRevision: current.metadataRevision + 1,
      })
      .where(eq(serviceCredentials.id, id));
    const { syncServiceKeyProjection } =
      await import("../credentials/index.js");
    await syncServiceKeyProjection(tx, {
      credentialId: id,
      name: value.name,
      notes: value.notes,
      updateMetadata: true,
      expiresAt: current.expiresAt,
      actor,
    });
    await recordAudit(
      tx,
      actor,
      "credential.metadata",
      "credential",
      id,
      "更新服务凭据展示信息",
    );
    return credentialDto(tx, await credentialRow(tx, callerId, id));
  });
}

function serviceRequestLogDto(row: {
  log: {
    id: string;
    callerId: string;
    credentialId: string;
    requestId: string;
    method: string;
    path: string;
    statusCode: number;
    latencyMs: number;
    clientIp: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    diagnostic: unknown;
    requestSummary: unknown;
    createdAt: Date;
  };
  credentialName: string | null;
}) {
  return serviceRequestLogItemSchema.parse({
    ...row.log,
    credentialName: row.credentialName,
    diagnostic: row.log.diagnostic ?? null,
    requestSummary: row.log.requestSummary ?? null,
    createdAt: iso(row.log.createdAt),
  });
}

export async function recordServiceRequestLog(
  db: Db,
  record: ServiceRequestLogRecord,
) {
  const value = serviceRequestLogRecordSchema.parse(record);
  const { serviceCredentials, serviceRequestLogs } = schemaFor(db);
  // The API only reaches this path after a constant-time credential verification. Keep
  // the relationship check here as a second invariant: a programming error must not
  // write one caller's diagnostic fact under another caller's credential.
  const [credential] = await db
    .select({ id: serviceCredentials.id })
    .from(serviceCredentials)
    .where(
      and(
        eq(serviceCredentials.id, value.credentialId),
        eq(serviceCredentials.callerId, value.callerId),
      ),
    )
    .limit(1);
  if (!credential) return { recorded: false as const };
  const now = await clockNow(db);
  await db
    .insert(serviceRequestLogs)
    .values({ id: newId(), ...value, createdAt: now });
  return { recorded: true as const };
}

export async function listServiceRequestLogs(
  db: Db,
  callerId: string,
  query: ServiceRequestLogQuery,
  actor: AuditActor,
) {
  const q = serviceRequestLogQuerySchema.parse(query);
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:read"]);
    await callerRow(tx, callerId);
    const { serviceCredentials, serviceRequestLogs } = schemaFor(tx);
    const statusFilter =
      q.statusCategory === "2xx"
        ? and(
            gte(serviceRequestLogs.statusCode, 200),
            lt(serviceRequestLogs.statusCode, 300),
          )
        : q.statusCategory === "4xx"
          ? and(
              gte(serviceRequestLogs.statusCode, 400),
              lt(serviceRequestLogs.statusCode, 500),
            )
          : q.statusCategory === "5xx"
            ? and(
                gte(serviceRequestLogs.statusCode, 500),
                lt(serviceRequestLogs.statusCode, 600),
              )
            : undefined;
    const rows = await tx
      .select({
        log: serviceRequestLogs,
        credentialName: serviceCredentials.name,
      })
      .from(serviceRequestLogs)
      .innerJoin(
        serviceCredentials,
        eq(serviceCredentials.id, serviceRequestLogs.credentialId),
      )
      .where(
        and(
          eq(serviceRequestLogs.callerId, callerId),
          statusFilter,
          q.requestId
            ? eq(serviceRequestLogs.requestId, q.requestId)
            : undefined,
          q.startAt
            ? gte(serviceRequestLogs.createdAt, new Date(q.startAt))
            : undefined,
          q.endAt
            ? lte(serviceRequestLogs.createdAt, new Date(q.endAt))
            : undefined,
          cursorFilter(
            serviceRequestLogs.createdAt,
            serviceRequestLogs.id,
            q.cursor,
          ),
        ),
      )
      .orderBy(desc(serviceRequestLogs.createdAt), desc(serviceRequestLogs.id))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit);
    return serviceRequestLogListSchema.parse({
      items: items.map(serviceRequestLogDto),
      nextCursor:
        rows.length > q.limit
          ? encodeCursor(
              items[items.length - 1]!.log.createdAt,
              items[items.length - 1]!.log.id,
            )
          : undefined,
    });
  });
}

export async function getServiceRequestLog(
  db: Db,
  callerId: string,
  id: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:read"]);
    await callerRow(tx, callerId);
    const { serviceCredentials, serviceRequestLogs } = schemaFor(tx);
    const [row] = await tx
      .select({
        log: serviceRequestLogs,
        credentialName: serviceCredentials.name,
      })
      .from(serviceRequestLogs)
      .innerJoin(
        serviceCredentials,
        eq(serviceCredentials.id, serviceRequestLogs.credentialId),
      )
      .where(
        and(
          eq(serviceRequestLogs.callerId, callerId),
          eq(serviceRequestLogs.id, id),
        ),
      )
      .limit(1);
    if (!row)
      throw notFound("SERVICE_REQUEST_LOG_NOT_FOUND", "调用排障记录不存在");
    return serviceRequestLogDto(row);
  });
}

export const SERVICE_REQUEST_LOG_RETENTION_DAYS = 7;
export const SERVICE_REQUEST_LOG_REAP_BATCH = 1000;
export async function reapServiceRequestLogs(
  db: Db,
  input: { now?: Date; limit?: number } = {},
): Promise<{ scanned: number; deleted: number }> {
  const limit = Math.max(
    1,
    Math.min(
      input.limit ?? SERVICE_REQUEST_LOG_REAP_BATCH,
      SERVICE_REQUEST_LOG_REAP_BATCH,
    ),
  );
  return atomic(db, async (tx) => {
    const now = input.now ?? (await clockNow(tx));
    const cutoff = new Date(
      now.getTime() - SERVICE_REQUEST_LOG_RETENTION_DAYS * 86_400_000,
    );
    const { serviceRequestLogs } = schemaFor(tx);
    const rows = await tx
      .select({ id: serviceRequestLogs.id })
      .from(serviceRequestLogs)
      .where(lt(serviceRequestLogs.createdAt, cutoff))
      .orderBy(asc(serviceRequestLogs.createdAt), asc(serviceRequestLogs.id))
      .limit(limit);
    if (!rows.length) return { scanned: 0, deleted: 0 };
    await tx.delete(serviceRequestLogs).where(
      inArray(
        serviceRequestLogs.id,
        rows.map((row) => row.id),
      ),
    );
    return { scanned: rows.length, deleted: rows.length };
  });
}

export async function getServiceCredentialCatalog(
  db: Db,
  callerId: string,
  credentialId: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ["service:read"]);
    await callerRow(tx, callerId);
    const credential = await credentialRow(tx, callerId, credentialId);
    const {
      credentialTargetAccountGrants: accountGrants,
      credentialTargetGrants: targetGrants,
      scenarios,
      scenarioVersions,
      targetAccounts,
      targets,
    } = schemaFor(tx);
    const grants = await tx
      .select({
        targetId: targets.id,
        targetName: targets.name,
        allowAnonymous: targetGrants.allowAnonymous,
      })
      .from(targetGrants)
      .innerJoin(targets, eq(targets.id, targetGrants.targetId))
      .where(
        and(
          eq(targetGrants.credentialId, credentialId),
          eq(targets.status, "active"),
          isNull(targets.deletedAt),
        ),
      )
      .orderBy(asc(targets.name), asc(targets.id));
    const items = await Promise.all(
      grants.map(async (grant) => {
        const [accounts, scenarioRows] = await Promise.all([
          tx
            .select({ id: targetAccounts.id, name: targetAccounts.displayName })
            .from(targetAccounts)
            .innerJoin(
              accountGrants,
              eq(accountGrants.targetAccountId, targetAccounts.id),
            )
            .where(
              and(
                eq(accountGrants.credentialId, credentialId),
                eq(accountGrants.targetId, grant.targetId),
                eq(targetAccounts.targetId, grant.targetId),
                isNull(targetAccounts.deletedAt),
              ),
            )
            .orderBy(asc(targetAccounts.displayName), asc(targetAccounts.id)),
          tx
            .select({
              scenarioId: scenarios.id,
              name: scenarios.name,
              versionId: scenarioVersions.id,
              versionNo: scenarioVersions.versionNo,
              definition: scenarioVersions.definition,
            })
            .from(scenarios)
            .innerJoin(
              scenarioVersions,
              eq(scenarioVersions.scenarioId, scenarios.id),
            )
            .where(
              and(
                eq(scenarios.targetId, grant.targetId),
                eq(scenarios.status, "active"),
                isNull(scenarios.deletedAt),
                eq(scenarioVersions.kind, "published"),
              ),
            )
            .orderBy(asc(scenarios.name), desc(scenarioVersions.versionNo)),
        ]);
        return {
          targetId: grant.targetId,
          targetName: grant.targetName,
          allowAnonymous: grant.allowAnonymous === 1,
          accounts,
          scenarios: scenarioRows.map((scenario) => ({
            scenarioId: scenario.scenarioId,
            name: scenario.name,
            versionId: scenario.versionId,
            versionNo: scenario.versionNo,
            inputs: scenario.definition.inputs ?? [],
            hasAi: hasAiSteps(scenario.definition.steps),
          })),
        };
      }),
    );
    return serviceCredentialCatalogSchema.parse({
      credentialId: credential.id,
      credentialName: credential.name,
      items,
    });
  });
}
type ServiceCredentialVerification = {
  callerId: string;
  credentialId: string;
};
type AuthenticateServiceOptions = {
  /** Undefined means a later in-request authorization check, not a network check. */
  clientIp?: string | null;
  onCredentialVerified?: (context: ServiceCredentialVerification) => void;
};

async function access(
  db: Db,
  raw: ServicePrincipal,
  required: ServiceScope[],
  options?: Pick<AuthenticateServiceOptions, "clientIp">,
) {
  const actor = servicePrincipalSchema.parse(raw);
  const caller = await callerRow(db, actor.id),
    credential = await credentialRow(db, actor.id, actor.credentialId),
    now = await clockNow(db);
  if (
    caller.archivedAt ||
    caller.status !== "active" ||
    credential.revokedAt ||
    credential.expiresAt <= now
  )
    throw denied();
  if (credential.suspendedAt)
    throw new DomainError(
      "unauthorized",
      "CREDENTIAL_SUSPENDED",
      "服务凭据已被冻结",
    );
  if (
    options?.clientIp !== undefined &&
    !isIpAllowedByAllowlist(options.clientIp, caller.ipWhitelist)
  )
    throw forbidden("IP_FORBIDDEN", "请求来源 IP 不在调用方白名单中");
  if (!required.every((s) => credential.scopes.includes(s)))
    throw forbidden("SERVICE_SCOPE_DENIED", "服务凭据缺少所需权限");
  return {
    caller,
    credential,
    now,
    actor: { ...actor, scopes: credential.scopes },
  };
}
export async function authenticateService(
  db: Db,
  authorization: string | undefined,
  options?: AuthenticateServiceOptions,
): Promise<ServicePrincipal> {
  const m = /^Bearer cairn_sk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    authorization ?? "",
  );
  if (
    !m ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      m[1]!,
    )
  )
    throw denied();
  const { serviceCredentials } = schemaFor(db);
  const [found] = await db
    .select()
    .from(serviceCredentials)
    .where(eq(serviceCredentials.id, m[1]!));
  const actual = digestSecret(m[2]!),
    expected = Buffer.from(found?.secretDigest ?? "0".repeat(64), "hex");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual) ||
    !found
  )
    throw denied();
  options?.onCredentialVerified?.({
    callerId: found.callerId,
    credentialId: found.id,
  });
  const outcome = await atomic(db, async (tx) => {
    const { serviceCallers, serviceCredentials } = schemaFor(tx);
    const { caller, credential, now, actor } = await access(
      tx,
      {
        kind: "service",
        id: found.callerId,
        credentialId: found.id,
        scopes: found.scopes,
      },
      [],
      { clientIp: options?.clientIp ?? null },
    );
    const reset =
      !caller.windowStartedAt ||
      now.getTime() - caller.windowStartedAt.getTime() >= 60000;
    const used = reset ? 0 : caller.windowRequests;
    if (used >= caller.requestsPerMinute)
      return {
        limited: true as const,
        retryAfter: Math.max(
          1,
          Math.ceil(
            (caller.windowStartedAt!.getTime() + 60000 - now.getTime()) / 1000,
          ),
        ),
      };
    await tx
      .update(serviceCallers)
      .set({
        windowRequests: used + 1,
        windowStartedAt: reset ? now : caller.windowStartedAt,
      })
      .where(eq(serviceCallers.id, caller.id));
    await tx
      .update(serviceCredentials)
      .set({ lastUsedAt: now })
      .where(eq(serviceCredentials.id, credential.id));
    return { limited: false as const, actor };
  });
  if (outcome.limited)
    throw new DomainError(
      "rate_limited",
      "SERVICE_RATE_LIMIT",
      "调用频率超过限制",
      {
        retryAfter: outcome.retryAfter,
      },
    );
  return outcome.actor;
}
async function assertTarget(
  db: Db,
  credentialId: string,
  targetId: string,
  accountId?: string | null,
) {
  const { credentialTargetGrants: tg, credentialTargetAccountGrants: ag } =
    schemaFor(db);
  const [grant] = await db
    .select()
    .from(tg)
    .where(and(eq(tg.credentialId, credentialId), eq(tg.targetId, targetId)));
  if (!grant) throw forbidden("TARGET_SCOPE_DENIED", "目标系统不在授权范围");
  if (!accountId) {
    if (!grant.allowAnonymous)
      throw forbidden("ACCOUNT_SCOPE_DENIED", "未授权匿名执行");
    return;
  }
  const [account] = await db
    .select()
    .from(ag)
    .where(
      and(
        eq(ag.credentialId, credentialId),
        eq(ag.targetId, targetId),
        eq(ag.targetAccountId, accountId),
      ),
    );
  if (!account) throw forbidden("ACCOUNT_SCOPE_DENIED", "目标账号不在授权范围");
}
async function ownRun(db: Db, actor: ServicePrincipal, id: string) {
  const { runs } = schemaFor(db);
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, id),
        eq(runs.serviceCallerId, actor.id),
        isNull(runs.deletedAt),
      ),
    );
  if (!row) throw notFound("RUN_NOT_FOUND", "运行不存在");
  try {
    await assertTarget(
      db,
      actor.credentialId,
      row.targetId,
      row.targetAccountId,
    );
  } catch (error) {
    if (error instanceof DomainError && error.kind === "forbidden")
      throw notFound("RUN_NOT_FOUND", "运行不存在");
    throw error;
  }
  return row;
}
async function publicRun(db: Db, id: string, results = false) {
  const detail = await getRun(db, id),
    { runs } = schemaFor(db);
  const [row] = await db
    .select({ cancelReason: runs.cancelReason })
    .from(runs)
    .where(eq(runs.id, id));
  const { evidences } = schemaFor(db);
  const approved = results
    ? await db
        .select({ attemptId: evidences.attemptId, payload: evidences.payload })
        .from(evidences)
        .where(
          and(
            eq(evidences.runId, id),
            eq(evidences.type, "output"),
            eq(evidences.externalAccess, 1),
            eq(evidences.status, "available"),
          ),
        )
    : [];
  return externalRunSchema.parse({
    ...detail,
    cancelReason: row!.cancelReason,
    stepRuns: detail.stepRuns.map((s) => ({
      ...s,
      attempts: s.attempts.map((a) => ({
        ...a,
        errorCode: a.error?.code ?? null,
        output: approved.find((e) => e.attemptId === a.id)?.payload ?? null,
      })),
    })),
  });
}
export async function createServiceRun(
  db: Db,
  principal: ServicePrincipal,
  body: ExternalRunBody,
  requestId: string,
  aiExecution?: AiExecutionConfig,
  hangWaitMs?: number,
) {
  const input = externalRunBodySchema.parse(body);
  return atomic(db, async (tx) => {
    const { runs, scenarios, scenarioVersions } = schemaFor(tx);
    const { caller, credential, actor, now } = await access(tx, principal, [
      "run:execute",
    ]);
    const digest = sha256Hex({
      protocol: "open-v1",
      ...input,
      targetAccountId: input.targetAccountId ?? null,
    });
    const [existing] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.serviceCallerId, caller.id),
          eq(runs.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      await ownRun(tx, actor, existing.id);
      if (existing.idempotencyDigest !== digest)
        throw conflict(
          "RUN_IDEMPOTENCY_CONFLICT",
          "相同幂等键对应不同的运行输入",
        );
      if (
        hasAiSteps(existing.snapshot.steps) &&
        !credential.scopes.includes("ai:execute")
      )
        throw forbidden("SERVICE_SCOPE_DENIED", "服务凭据没有 AI 执行权限");
      return { detail: await publicRun(tx, existing.id), created: false };
    }
    const [resolved] = await tx
      .select({
        targetId: scenarios.targetId,
        definition: scenarioVersions.definition,
        kind: scenarioVersions.kind,
      })
      .from(scenarios)
      .innerJoin(
        scenarioVersions,
        eq(scenarioVersions.scenarioId, scenarios.id),
      )
      .where(
        and(
          eq(scenarios.id, input.scenarioId),
          eq(scenarioVersions.id, input.scenarioVersionId),
        ),
      );
    if (!resolved) throw notFound("SCENARIO_NOT_FOUND", "已发布场景版本不存在");
    await assertTarget(
      tx,
      credential.id,
      resolved.targetId,
      input.targetAccountId,
    );
    if (resolved.kind !== "published")
      throw badRequest("SCENARIO_VERSION_NOT_PUBLISHED", "只能执行已发布版本");
    if (
      hasAiSteps(resolved.definition.steps) &&
      !credential.scopes.includes("ai:execute")
    )
      throw forbidden("SERVICE_SCOPE_DENIED", "服务凭据没有 AI 执行权限");
    if (
      !input.targetAccountId &&
      resolved.definition.steps.some((step) => stepUsesBrowser(step.type))
    )
      throw badRequest(
        "SESSION_ACCOUNT_REQUIRED",
        "浏览器步骤需要授权的目标账号",
      );
    const [used] = await tx
      .select({ n: count() })
      .from(runs)
      .where(
        and(
          eq(runs.serviceCallerId, caller.id),
          isNull(runs.deletedAt),
          inArray(runs.status, [...outstanding]),
        ),
      );
    if (Number(used!.n) >= caller.maxOutstandingRuns)
      throw new DomainError(
        "rate_limited",
        "SERVICE_RUN_CAPACITY",
        "未结束运行数已达到限制",
        {
          retryAfter: 5,
        },
      );
    const result = await createRunWithSnapshot(tx, {
      ...input,
      actor: { ...actor, requestId },
      aiExecution,
      hangWaitMs,
      externalIdempotencyDigest: digest,
      deadlineAt: new Date(now.getTime() + caller.runTimeoutSeconds * 1000),
      serviceAdmission: serviceAdmissionSchema.parse({
        version: 1,
        requestId,
        credentialRevision: credential.revision,
        targetId: resolved.targetId,
        targetAccountId: input.targetAccountId ?? null,
        scopes: credential.scopes,
        maxOutstandingRuns: caller.maxOutstandingRuns,
        runTimeoutSeconds: caller.runTimeoutSeconds,
      }),
    });
    return {
      detail: await publicRun(tx, result.detail.id),
      created: result.created,
    };
  });
}
export async function getServiceRun(
  db: Db,
  principal: ServicePrincipal,
  id: string,
  cancel = false,
) {
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, [
      cancel ? "run:cancel" : "run:read",
    ]);
    await ownRun(tx, actor, id);
    if (cancel) await requestRunCancel(tx, id, actor);
    return publicRun(tx, id, actor.scopes.includes("run:read"));
  });
}
function allowedRun(db: Db, actor: ServicePrincipal) {
  const {
    runs: r,
    credentialTargetGrants: tg,
    credentialTargetAccountGrants: ag,
  } = schemaFor(db);
  return and(
    eq(r.serviceCallerId, actor.id),
    sql`EXISTS (SELECT 1 FROM ${tg} WHERE ${tg.credentialId} = ${actor.credentialId} AND ${tg.targetId} = ${r.targetId} AND ((${r.targetAccountId} IS NULL AND ${tg.allowAnonymous} = 1) OR EXISTS (SELECT 1 FROM ${ag} WHERE ${ag.credentialId} = ${actor.credentialId} AND ${ag.targetId} = ${r.targetId} AND ${ag.targetAccountId} = ${r.targetAccountId})))`,
  );
}
export async function listServiceRuns(
  db: Db,
  principal: ServicePrincipal,
  query: ServicePageQuery,
) {
  const q = servicePageQuerySchema.parse(query);
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, ["run:read"]),
      { runs } = schemaFor(tx);
    const result = page(
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            allowedRun(tx, actor),
            q.cursor ? gt(runs.id, q.cursor) : undefined,
          ),
        )
        .orderBy(asc(runs.id))
        .limit(q.limit + 1),
      q.limit,
    );
    return {
      ...result,
      items: await Promise.all(
        result.items.map((r) => publicRun(tx, r.id, true)),
      ),
    };
  });
}
export async function serviceCatalog(
  db: Db,
  principal: ServicePrincipal,
  query: ServicePageQuery,
  targetId?: string,
) {
  const q = servicePageQuerySchema.parse(query);
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, ["run:execute"]);
    const {
      targets: t,
      targetAccounts: a,
      credentialTargetGrants: tg,
      credentialTargetAccountGrants: ag,
      scenarios: s,
      scenarioVersions: v,
    } = schemaFor(tx);
    if (targetId) {
      const [grant] = await tx
        .select()
        .from(tg)
        .where(
          and(
            eq(tg.credentialId, actor.credentialId),
            eq(tg.targetId, targetId),
          ),
        );
      if (!grant) throw notFound("TARGET_NOT_FOUND", "目标系统不存在");
      const rows = await tx
        .select({
          id: v.id,
          scenarioId: s.id,
          name: s.name,
          versionNo: v.versionNo,
          definition: v.definition,
        })
        .from(s)
        .innerJoin(v, eq(v.scenarioId, s.id))
        .innerJoin(t, eq(t.id, s.targetId))
        .where(
          and(
            eq(s.targetId, targetId),
            eq(t.status, "active"),
            eq(s.status, "active"),
            eq(v.kind, "published"),
            q.cursor ? gt(v.id, q.cursor) : undefined,
          ),
        )
        .orderBy(asc(v.id))
        .limit(q.limit + 1);
      const result = page(rows, q.limit);
      return {
        ...result,
        items: result.items.map(({ definition, ...row }) => ({
          ...row,
          inputs: definition.inputs ?? [],
          hasAi: hasAiSteps(definition.steps),
        })),
      };
    }
    const rows = await tx
      .select({ id: t.id, name: t.name, allowAnonymous: tg.allowAnonymous })
      .from(t)
      .innerJoin(tg, eq(tg.targetId, t.id))
      .where(
        and(
          eq(tg.credentialId, actor.credentialId),
          eq(t.status, "active"),
          q.cursor ? gt(t.id, q.cursor) : undefined,
        ),
      )
      .orderBy(asc(t.id))
      .limit(q.limit + 1);
    const result = page(rows, q.limit);
    const items = [];
    for (const row of result.items) {
      const accounts = await tx
        .select({ id: a.id, name: a.displayName })
        .from(a)
        .innerJoin(ag, eq(ag.targetAccountId, a.id))
        .where(
          and(
            eq(ag.credentialId, actor.credentialId),
            eq(ag.targetId, row.id),
            eq(a.status, "active"),
          ),
        );
      items.push({
        ...row,
        allowAnonymous: row.allowAnonymous === 1,
        accounts,
      });
    }
    return { ...result, items };
  });
}
export async function releaseServiceEvidence(
  db: Db,
  runId: string,
  evidenceId: string,
  allowed: boolean,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    const { evidences: e } = schemaFor(tx);
    const [row] = await tx
      .select()
      .from(e)
      .where(and(eq(e.id, evidenceId), eq(e.runId, runId)));
    if (!row) throw notFound("EVIDENCE_NOT_FOUND", "证据不存在");
    if (
      allowed &&
      (row.status !== "available" ||
        !(
          (row.type === "screenshot" &&
            ["image/png", "image/jpeg", "image/webp"].includes(
              row.contentType ?? "",
            )) ||
          (row.type === "output" &&
            row.payload !== null &&
            !isAiCallEvidence(row.payload))
        ))
    )
      throw badRequest(
        "EVIDENCE_RELEASE_DENIED",
        "仅可发布已人工检查的截图或业务输出",
      );
    await tx
      .update(e)
      .set({ externalAccess: allowed ? 1 : 0 })
      .where(eq(e.id, evidenceId));
    await recordAudit(
      tx,
      actor,
      "evidence.release",
      "run",
      runId,
      `${allowed ? "允许" : "禁止"}证据对外访问 ${evidenceId}`,
    );
    return { id: evidenceId, externalAccess: allowed };
  });
}
export async function serviceEvidence(
  db: Db,
  principal: ServicePrincipal,
  runId: string,
  query: ServicePageQuery,
  evidenceId?: string,
) {
  const q = servicePageQuerySchema.parse(query);
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, [
      "run:read",
      "evidence:read",
    ]);
    await ownRun(tx, actor, runId);
    const { evidences: e } = schemaFor(tx);
    const rows = await tx
      .select()
      .from(e)
      .where(
        and(
          eq(e.runId, runId),
          eq(e.status, "available"),
          eq(e.externalAccess, 1),
          or(
            and(
              eq(e.type, "screenshot"),
              inArray(e.contentType, ["image/png", "image/jpeg", "image/webp"]),
            ),
            eq(e.type, "output"),
          ),
          evidenceId ? eq(e.id, evidenceId) : undefined,
          q.cursor ? gt(e.id, q.cursor) : undefined,
        ),
      )
      .orderBy(asc(e.id))
      .limit(q.limit + 1);
    if (evidenceId) {
      if (!rows[0]?.objectKey)
        throw notFound("EVIDENCE_NOT_FOUND", "证据不存在");
      return { object: rows[0], items: [] };
    }
    const result = page(rows, q.limit);
    return {
      ...result,
      object: undefined,
      items: result.items.map((r) => ({
        id: r.id,
        runId: r.runId,
        stepRunId: r.stepRunId,
        attemptId: r.attemptId,
        type: r.type,
        contentType: r.contentType,
        byteSize: r.byteSize,
        createdAt: iso(r.createdAt),
        ...(r.type === "output" ? { payload: r.payload } : {}),
      })),
    };
  });
}
