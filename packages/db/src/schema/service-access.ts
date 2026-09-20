import {
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ServiceRequestLogDiagnostic,
  ServiceRequestSummary,
  ServiceScope,
} from "@cairn/shared";
import { cairnSchema, consoleAccounts } from "./console.js";
import { targets, targetAccounts } from "./targets.js";
import { newId } from "../id.js";

export const serviceCallers = cairnSchema.table(
  "service_callers",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    status: text("status").notNull().default("active"),
    requestsPerMinute: integer("requests_per_minute").notNull().default(60),
    maxOutstandingRuns: integer("max_outstanding_runs").notNull().default(2),
    runTimeoutSeconds: integer("run_timeout_seconds").notNull().default(600),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }),
    windowRequests: integer("window_requests").notNull().default(0),
    /** 空数组表示不限制来源；写入前由共享 CIDR 契约规范化。 */
    ipWhitelist: jsonb("ip_whitelist").$type<string[]>().notNull().default([]),
    /** 软归档：保留治理与审计事实，拒绝新的服务访问。 */
    archivedAt: timestamp("archived_at", { withTimezone: true, precision: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("service_callers_archived_status_created_idx").on(
      t.archivedAt,
      t.status,
      t.createdAt,
      t.id,
    ),
  ],
);
export const serviceCredentials = cairnSchema.table(
  "service_credentials",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    callerId: uuid("caller_id")
      .notNull()
      .references(() => serviceCallers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    secretDigest: text("secret_digest").notNull(),
    scopes: jsonb("scopes").$type<ServiceScope[]>().notNull(),
    revision: integer("revision").notNull().default(1),
    /** 与 scopes/grants 的 authorization revision 分离。 */
    metadataRevision: integer("metadata_revision").notNull().default(1),
    notes: text("notes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", {
      withTimezone: true,
      precision: 3,
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdByConsoleAccountId: uuid("created_by_console_account_id")
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("service_credentials_caller_id_idx").on(t.callerId, t.id),
  ],
);
export const credentialTargetGrants = cairnSchema.table(
  "credential_target_grants",
  {
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => serviceCredentials.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "restrict" }),
    allowAnonymous: integer("allow_anonymous").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.credentialId, t.targetId] })],
);
export const credentialTargetAccountGrants = cairnSchema.table(
  "credential_target_account_grants",
  {
    credentialId: uuid("credential_id").notNull(),
    targetId: uuid("target_id").notNull(),
    targetAccountId: uuid("target_account_id")
      .notNull()
      .references(() => targetAccounts.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.credentialId, t.targetId, t.targetAccountId] }),
    index("credential_account_target_idx").on(t.targetId, t.targetAccountId),
  ],
);

/**
 * Authenticated open/v1 request facts. Invalid or unverifiable bearer strings do not
 * get a row: associating attacker-provided key ids with a caller would poison that
 * caller's diagnostic history.
 */
export const serviceRequestLogs = cairnSchema.table(
  "service_request_logs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    callerId: uuid("caller_id")
      .notNull()
      .references(() => serviceCallers.id, { onDelete: "restrict" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => serviceCredentials.id, { onDelete: "restrict" }),
    requestId: text("request_id").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    clientIp: text("client_ip"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    diagnostic: jsonb("diagnostic").$type<ServiceRequestLogDiagnostic>(),
    requestSummary: jsonb("request_summary").$type<ServiceRequestSummary>(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("service_request_logs_caller_created_idx").on(
      t.callerId,
      t.createdAt,
      t.id,
    ),
    index("service_request_logs_caller_request_idx").on(
      t.callerId,
      t.requestId,
      t.id,
    ),
    index("service_request_logs_retention_idx").on(t.createdAt, t.id),
  ],
);
