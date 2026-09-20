import { z } from "zod";
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from "./wire.js";
import { runInputSchema, runStatusSchema } from "./run.js";
import { idempotencyKeySchema, stepRunDtoSchema } from "./run-api.js";
import { scenarioInputDeclSchema } from "./step.js";
import {
  normalizeIpAddress,
  normalizeIpAllowlist,
  normalizeIpCidr,
} from "./service-network.js";

export const SERVICE_SCOPES = [
  "run:execute",
  "run:read",
  "run:cancel",
  "evidence:read",
  "ai:execute",
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];
export const serviceScopesSchema = z
  .array(z.enum(SERVICE_SCOPES))
  .min(1)
  .max(5)
  .refine((xs) => new Set(xs).size === xs.length, "权限不得重复")
  .refine(
    (xs) => !xs.includes("evidence:read") || xs.includes("run:read"),
    "读取证据需要读取运行权限",
  );

export const serviceCallerBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  owner: z.string().trim().min(1).max(128),
  status: z.enum(["active", "disabled"]).default("active"),
  requestsPerMinute: z.number().int().min(1).max(600).default(60),
  maxOutstandingRuns: z.number().int().min(1).max(20).default(2),
  runTimeoutSeconds: z.number().int().min(1).max(3600).default(600),
});
export type ServiceCallerBody = z.infer<typeof serviceCallerBodySchema>;
const serviceIpCidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    const normalized = normalizeIpCidr(value);
    if (normalized) return normalized;
    ctx.addIssue({
      code: "custom",
      message: "IP 白名单项必须是合法 IPv4、IPv6 或 CIDR",
    });
    return z.NEVER;
  });
const serviceIpAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    const normalized = normalizeIpAddress(value);
    if (normalized) return normalized;
    ctx.addIssue({ code: "custom", message: "客户端 IP 地址无效" });
    return z.NEVER;
  });
export const serviceIpWhitelistBodySchema = z
  .strictObject({ entries: z.array(serviceIpCidrSchema).max(64).default([]) })
  .superRefine((body, ctx) => {
    if (normalizeIpAllowlist(body.entries)) return;
    ctx.addIssue({
      code: "custom",
      path: ["entries"],
      message: "白名单项不得重复，且最多 64 条",
    });
  })
  .transform((body) => ({ entries: normalizeIpAllowlist(body.entries)! }));
export type ServiceIpWhitelistBody = z.infer<
  typeof serviceIpWhitelistBodySchema
>;
export const serviceCallerSchema = serviceCallerBodySchema
  .extend({
    id: entityIdSchema,
    /** 归档保留审计与历史 Run；不再允许新接入或管理性写入。 */
    archivedAt: utcInstantSchema.nullable(),
    createdAt: utcInstantSchema,
    updatedAt: utcInstantSchema,
    outstandingRuns: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    /** 空数组代表不限制来源；非空时每个开放请求必须命中其中一项。 */
    ipWhitelist: z.array(serviceIpCidrSchema).max(64),
  })
  .strip();
export type ServiceCallerDto = z.infer<typeof serviceCallerSchema>;

/**
 * 控制台列表与 open/v1 的 UUID 游标分开。HTTP query 只允许精确的
 * `true` / `false`，不能让 z.coerce.boolean() 把字符串 `false` 当成真。
 */
const serviceBooleanQuerySchema = z
  .union([z.literal("true"), z.literal("false")])
  .optional()
  .transform((value) => value === "true");
const serviceCallerQueryFields = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(64).default(""),
  status: z.enum(["all", "active", "disabled"]).default("all"),
  sortBy: z
    .enum(["id", "createdAt", "updatedAt", "outstandingRuns"])
    .default("id"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
};
export const serviceCallerQuerySchema = z.strictObject({
  ...serviceCallerQueryFields,
  includeArchived: serviceBooleanQuerySchema,
});
/** 已解析的领域查询；数据库入口不应再把 boolean 当 HTTP 字符串重新解析。 */
export const serviceCallerQueryValueSchema = z.strictObject({
  ...serviceCallerQueryFields,
  includeArchived: z.boolean().default(false),
});
/** 调用方可提交的部分查询；默认值由运行时 schema 统一补齐。 */
export type ServiceCallerQuery = z.input<typeof serviceCallerQueryValueSchema>;
export type ServiceCallerQueryValue = z.output<
  typeof serviceCallerQueryValueSchema
>;

export const serviceTargetGrantSchema = z
  .strictObject({
    targetId: entityIdSchema,
    allowAnonymous: z.boolean().default(false),
    accountIds: z.array(entityIdSchema).max(100).default([]),
  })
  .refine(
    (x) => new Set(x.accountIds).size === x.accountIds.length,
    "目标账号不得重复",
  );
export const serviceCredentialPolicySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  scopes: serviceScopesSchema,
  grants: z
    .array(serviceTargetGrantSchema)
    .max(100)
    .refine(
      (xs) => new Set(xs.map((x) => x.targetId)).size === xs.length,
      "目标系统不得重复",
    ),
});
export const issueServiceCredentialSchema =
  serviceCredentialPolicySchema.extend({
    expiresInDays: z.number().int().min(1).max(365).default(90),
  });
export type ServiceCredentialPolicy = z.infer<
  typeof serviceCredentialPolicySchema
>;
export type IssueServiceCredential = z.infer<
  typeof issueServiceCredentialSchema
>;
export const serviceCredentialSchema = serviceCredentialPolicySchema
  .extend({
    id: entityIdSchema,
    callerId: entityIdSchema,
    revision: z.number().int().positive(),
    /** 名称和备注的独立版本，不会使已有 Key 的授权立即失效。 */
    metadataRevision: z.number().int().positive(),
    notes: z.string().max(2000).nullable(),
    status: z.enum(["active", "suspended", "expired", "revoked"]),
    expiresAt: utcInstantSchema,
    revokedAt: utcInstantSchema.nullable(),
    suspendedAt: utcInstantSchema.nullable(),
    lastUsedAt: utcInstantSchema.nullable(),
    createdAt: utcInstantSchema,
  })
  .strip();
export type ServiceCredentialDto = z.infer<typeof serviceCredentialSchema>;
export const serviceCredentialMetadataBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  notes: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .transform((value) => (value === "" ? null : value)),
  expectedMetadataRevision: z.number().int().positive(),
});
export type ServiceCredentialMetadataBody = z.infer<
  typeof serviceCredentialMetadataBodySchema
>;

export const serviceCallerStatusBodySchema = z.strictObject({
  status: z.enum(["active", "disabled"]),
});
export type ServiceCallerStatusBody = z.infer<
  typeof serviceCallerStatusBodySchema
>;
export const serviceCallerDetailSchema = z.object({
  caller: serviceCallerSchema,
  credentials: z.array(serviceCredentialSchema),
});
export const serviceCallerListSchema = z.object({
  items: z.array(serviceCallerSchema),
  nextCursor: z.string().min(1).max(2048).optional(),
});
export const issuedServiceCredentialSchema = z.object({
  credential: serviceCredentialSchema,
  token: z.string(),
});

export const servicePrincipalSchema = z.strictObject({
  kind: z.literal("service"),
  requestId: z.string().min(1).max(128).optional(),
  id: entityIdSchema,
  credentialId: entityIdSchema,
  scopes: serviceScopesSchema,
});
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>;
export const executionActorSchema = z.union([
  z.object({ kind: z.literal("console").optional(), id: entityIdSchema }),
  servicePrincipalSchema,
]);
export type ExecutionActor = z.infer<typeof executionActorSchema>;
export const serviceAdmissionSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().min(1).max(128),
  credentialRevision: z.number().int().positive(),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  scopes: serviceScopesSchema,
  maxOutstandingRuns: z.number().int().positive(),
  runTimeoutSeconds: z.number().int().positive(),
});
export type ServiceAdmission = z.infer<typeof serviceAdmissionSchema>;

// Bound depth before the recursive JSON schema is invoked at this trust boundary.
const boundedInputSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const pending: [unknown, number][] = [[value, 0]];
    while (pending.length) {
      const [item, depth] = pending.pop()!;
      if (depth > 8) {
        ctx.addIssue({ code: "custom", message: "输入嵌套最多 8 层" });
        return;
      }
      if (item && typeof item === "object") {
        for (const child of Object.values(item))
          pending.push([child, depth + 1]);
      }
    }
  })
  .pipe(runInputSchema);
export const externalRunBodySchema = z.strictObject({
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  targetAccountId: entityIdSchema.optional(),
  input: boundedInputSchema.default({}),
  idempotencyKey: idempotencyKeySchema,
});
export type ExternalRunBody = z.infer<typeof externalRunBodySchema>;
export const servicePageQuerySchema = z.strictObject({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ServicePageQuery = z.infer<typeof servicePageQuerySchema>;

export const serviceRequestLogDiagnosticSchema = z.strictObject({
  category: z
    .enum([
      "authorization",
      "credential",
      "network",
      "rate_limit",
      "request",
      "internal",
    ])
    .optional(),
  retryAfter: z.number().int().positive().optional(),
});
export type ServiceRequestLogDiagnostic = z.infer<
  typeof serviceRequestLogDiagnosticSchema
>;
export const serviceRequestSummarySchema = z
  .strictObject({
    scenarioId: entityIdSchema.optional(),
    scenarioVersionId: entityIdSchema.optional(),
    targetAccountId: entityIdSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    inputKeys: z.array(z.string().min(1).max(128)).max(64).optional(),
  })
  .nullable();
export type ServiceRequestSummary = z.infer<typeof serviceRequestSummarySchema>;
/** Internal write contract: it intentionally contains no Authorization header or request values. */
export const serviceRequestLogRecordSchema = z.strictObject({
  callerId: entityIdSchema,
  credentialId: entityIdSchema,
  requestId: z.string().min(1).max(128),
  method: z.enum(["GET", "POST"]),
  path: z
    .string()
    .regex(/^\/api\/open\/v1(?:\/|$)/)
    .max(255),
  statusCode: z.number().int().min(100).max(599),
  latencyMs: z.number().int().min(0).max(86_400_000),
  clientIp: serviceIpAddressSchema.nullable(),
  errorCode: z.string().min(1).max(128).nullable(),
  /** Stable, platform-authored explanation only; never an untrusted exception message. */
  errorMessage: z.string().min(1).max(512).nullable(),
  diagnostic: serviceRequestLogDiagnosticSchema.nullable(),
  requestSummary: serviceRequestSummarySchema,
});
export type ServiceRequestLogRecord = z.infer<
  typeof serviceRequestLogRecordSchema
>;
export const serviceRequestLogItemSchema = serviceRequestLogRecordSchema.extend(
  {
    id: entityIdSchema,
    credentialName: z.string().min(1).max(128).nullable(),
    createdAt: utcInstantSchema,
  },
);
export type ServiceRequestLogItem = z.infer<typeof serviceRequestLogItemSchema>;
export const serviceRequestLogListSchema = z.object({
  items: z.array(serviceRequestLogItemSchema),
  nextCursor: z.string().min(1).max(2048).optional(),
});
const serviceRequestLogQueryFields = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  statusCategory: z.enum(["all", "2xx", "4xx", "5xx"]).default("all"),
  requestId: z.string().trim().min(1).max(128).optional(),
  startAt: utcInstantSchema.optional(),
  endAt: utcInstantSchema.optional(),
};
export const serviceRequestLogQuerySchema = z
  .strictObject(serviceRequestLogQueryFields)
  .superRefine((query, ctx) => {
    if (
      !query.startAt ||
      !query.endAt ||
      new Date(query.startAt) <= new Date(query.endAt)
    )
      return;
    ctx.addIssue({
      code: "custom",
      path: ["endAt"],
      message: "结束时间必须不早于开始时间",
    });
  });
/** HTTP callers may omit defaulted filters; repositories parse into the value schema above. */
export type ServiceRequestLogQuery = z.input<
  typeof serviceRequestLogQuerySchema
>;
export type ServiceRequestLogQueryValue = z.output<
  typeof serviceRequestLogQuerySchema
>;

export const serviceCredentialCatalogScenarioSchema = z.object({
  scenarioId: entityIdSchema,
  name: z.string().min(1).max(256),
  versionId: entityIdSchema,
  versionNo: z.number().int().positive(),
  inputs: z.array(scenarioInputDeclSchema),
  hasAi: z.boolean(),
});
export const serviceCredentialCatalogSchema = z.object({
  credentialId: entityIdSchema,
  credentialName: z.string().min(1).max(128),
  items: z.array(
    z.object({
      targetId: entityIdSchema,
      targetName: z.string().min(1).max(256),
      allowAnonymous: z.boolean(),
      accounts: z.array(
        z.object({ id: entityIdSchema, name: z.string().min(1).max(256) }),
      ),
      scenarios: z.array(serviceCredentialCatalogScenarioSchema),
    }),
  ),
});
export type ServiceCredentialCatalog = z.infer<
  typeof serviceCredentialCatalogSchema
>;

/** 在途 Run 沿用服务开放 API 的 UUID 前向游标。 */
export const serviceOutstandingRunQuerySchema = servicePageQuerySchema;
export type ServiceOutstandingRunQuery = ServicePageQuery;
export const serviceOutstandingRunSchema = z.object({
  id: entityIdSchema,
  scenarioId: entityIdSchema,
  scenarioName: z.string().min(1).max(256),
  scenarioVersionId: entityIdSchema,
  scenarioVersionNo: z.number().int().positive(),
  targetId: entityIdSchema,
  targetName: z.string().min(1).max(256),
  targetAccountId: entityIdSchema.nullable(),
  targetAccountName: z.string().min(1).max(256).nullable(),
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  currentStepIndex: z.number().int().nonnegative().nullable(),
  currentStepName: z.string().min(1).max(256).nullable(),
  createdAt: utcInstantSchema,
  startedAt: utcInstantSchema.nullable(),
  durationSeconds: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128),
  credentialId: entityIdSchema,
  credentialName: z.string().min(1).max(128),
  canCancel: z.boolean(),
  canReview: z.boolean(),
});
export type ServiceOutstandingRunDto = z.infer<
  typeof serviceOutstandingRunSchema
>;
export const serviceOutstandingRunListSchema = z.object({
  items: z.array(serviceOutstandingRunSchema),
  nextCursor: z.string().uuid().optional(),
  outstandingRuns: z.number().int().nonnegative(),
  visibleOutstandingRuns: z.number().int().nonnegative(),
  observedAt: utcInstantSchema,
});
export const serviceRunCancelResultSchema = z.object({
  runId: entityIdSchema,
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  occupiesServiceCapacity: z.boolean(),
  observedAt: utcInstantSchema,
});
export type ServiceRunCancelResult = z.infer<
  typeof serviceRunCancelResultSchema
>;
export const externalRunSchema = z.object({
  id: entityIdSchema,
  status: runStatusSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  createdAt: utcInstantSchema,
  startedAt: utcInstantSchema.nullable(),
  finishedAt: utcInstantSchema.nullable(),
  cancelRequested: z.boolean(),
  cancelReason: z.string().nullable(),
  evidenceStatus: z.enum(["PENDING", "COMPLETE", "INCOMPLETE"]),
  stepRuns: z.array(
    stepRunDtoSchema.omit({ attempts: true }).extend({
      attempts: z.array(
        z.object({
          id: entityIdSchema,
          attemptNo: z.number().int(),
          status: z.string(),
          startedAt: utcInstantSchema,
          finishedAt: utcInstantSchema.nullable(),
          errorCode: z.string().nullable(),
          output: jsonValueSchema.nullable(),
        }),
      ),
    }),
  ),
});
export type ExternalRunDto = z.infer<typeof externalRunSchema>;
export const evidenceReleaseBodySchema = z.strictObject({
  allowed: z.boolean(),
});
