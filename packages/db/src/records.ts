// Logical persistence records. Native schema parity and contract tests guard this shape.
import type {
  AttemptStatus,
  EvidenceStatus,
  EvidenceType,
  JsonValue,
  RunEvidenceStatus,
  RunSnapshot,
  RunStatus,
  ScenarioDefinition,
  ScenarioDocument,
  ScenarioAuthoringDocumentV2,
  ModuleManifest,
  ScenarioStatus,
  StepRunStatus,
  PurgeReason,
  StoredObjectStatus,
  AuthCapabilityTier,
  IdentityState,
  SessionAuthState,
  SessionHealth,
  SessionLeaseOwnerKind,
  SessionLeasePurpose,
  SessionLeaseStatus,
  SessionOperationKind,
  SessionOperationOrigin,
  SessionOperationStatus,
  SessionProfileCleanup,
  SessionProfileState,
  SessionReusePolicy,
  SessionStatus,
  RunLeaseStatus,
  WorkerStatus,
  RecordingEvent,
  RecordingItem,
  ResourceDeletedBy,
  TargetCaptchaDefinition,
} from '@cairn/shared'

export type ConsoleAccount = {
  id: string
  displayName: string
  email: string | null
  status: 'active' | 'disabled'
  createdAt: Date
  updatedAt: Date
}

export type NewConsoleAccount = {
  displayName: string
  id?: string | undefined
  email?: string | null | undefined
  status?: 'active' | 'disabled' | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
}

export type ConsoleIdentity = {
  id: string
  createdAt: Date
  consoleAccountId: string
  provider: string
  subject: string
  secret: string | null
  lastUsedAt: Date | null
}

export type NewConsoleIdentity = {
  consoleAccountId: string
  provider: string
  subject: string
  id?: string | undefined
  createdAt?: Date | undefined
  secret?: string | null | undefined
  lastUsedAt?: Date | null | undefined
}

export type ConsoleRole = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  key: string
  description: string | null
  kind: 'custom' | 'system'
}

export type NewConsoleRole = {
  name: string
  key: string
  id?: string | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
  description?: string | null | undefined
  kind?: 'custom' | 'system' | undefined
}

export type ConsoleRolePermission = { consoleRoleId: string; permission: string }

export type ConsoleAccountRole = {
  consoleAccountId: string
  consoleRoleId: string
  assignedAt: Date
  assignedByConsoleAccountId: string | null
}

export type ConsoleAuditEvent = {
  id: string
  createdAt: Date
  actorConsoleAccountId: string | null
  action: string
  resource: string
  resourceId: string | null
  summary: string
}

export type NewConsoleAuditEvent = {
  action: string
  resource: string
  summary: string
  id?: string | undefined
  createdAt?: Date | undefined
  actorConsoleAccountId?: string | null | undefined
  resourceId?: string | null | undefined
}

export type Target = {
  id: string
  name: string
  status: 'active' | 'disabled'
  createdAt: Date
  updatedAt: Date
  code: string
  entryUrl: string
  loginUrl: string | null
  authMethod: 'password' | 'manual'
  captchaMode: 'none' | 'image' | 'slider' | 'sms' | 'other'
  loginFields: {
    username?: { by: 'id' | 'name' | 'css'; value: string }
    password?: { by: 'id' | 'name' | 'css'; value: string }
    submit?: { by: 'id' | 'name' | 'css'; value: string }
  } | null
  captcha: TargetCaptchaDefinition | null
  currentAuthProfileRevision: number | null
  sessionPolicy: Record<string, unknown> | null
  sensitiveSelectors: string[]
  deletedAt: Date | null
  deletedBy: ResourceDeletedBy | null
}

export type NewTarget = {
  name: string
  code: string
  entryUrl: string
  id?: string | undefined
  status?: 'active' | 'disabled' | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
  loginUrl?: string | null | undefined
  authMethod?: 'password' | 'manual' | undefined
  captchaMode?: 'none' | 'image' | 'slider' | 'sms' | 'other' | undefined
  loginFields?:
    | {
        username?: { by: 'id' | 'name' | 'css'; value: string }
        password?: { by: 'id' | 'name' | 'css'; value: string }
        submit?: { by: 'id' | 'name' | 'css'; value: string }
      }
    | null
    | undefined
  captcha?: TargetCaptchaDefinition | null | undefined
  sensitiveSelectors?: string[] | undefined
  currentAuthProfileRevision?: number | null | undefined
  deletedAt?: Date | null | undefined
  deletedBy?: ResourceDeletedBy | null | undefined
}

export type TargetAccount = {
  id: string
  displayName: string
  status: 'active' | 'disabled'
  createdAt: Date
  updatedAt: Date
  targetId: string
  username: string
  secretProvider: string | null
  secretId: string | null
  expectedIdentity: string | null
  usage: 'business' | 'map' | 'both'
  mapUsageGuard: string | null
  configRevision: number
  deletedAt: Date | null
  deletedBy: ResourceDeletedBy | null
}

export type NewTargetAccount = {
  displayName: string
  targetId: string
  username: string
  id?: string | undefined
  status?: 'active' | 'disabled' | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
  secretProvider?: string | null | undefined
  secretId?: string | null | undefined
  expectedIdentity?: string | null | undefined
  usage?: 'business' | 'map' | 'both' | undefined
  mapUsageGuard?: string | null | undefined
  configRevision?: number | undefined
  deletedAt?: Date | null | undefined
  deletedBy?: ResourceDeletedBy | null | undefined
}

export type SecretRow = {
  id: string
  createdAt: Date
  updatedAt: Date
  provider: string
  ciphertext: Buffer<ArrayBufferLike>
}

export type ScenarioRow = {
  id: string
  name: string
  status: 'active' | 'disabled'
  purpose?: 'user' | 'module_verification' | 'map_job' | null
  createdAt: Date
  updatedAt: Date
  targetId: string
  createdByConsoleAccountId: string
  deletedAt: Date | null
  deletedBy: ResourceDeletedBy | null
}

export type ScenarioVersionRow = {
  id: string
  createdAt: Date
  kind: 'published' | 'trial'
  createdByConsoleAccountId: string
  scenarioId: string
  versionNo: number | null
  definition: ScenarioDefinition
  compilerVersion: number
  sourceDigest: string
  authoringDocument?: ScenarioAuthoringDocumentV2 | null
  moduleManifest?: ModuleManifest | null
}

export type ScenarioDraftRow = {
  updatedAt: Date
  scenarioId: string
  revision: number
  document: ScenarioAuthoringDocumentV2 | ScenarioDocument
  updatedByConsoleAccountId: string
}

export type ScenarioModuleRefRow = {
  id: string
  scenarioId: string
  scenarioVersionId: string | null
  invocationId: string
  moduleId: string
  moduleVersionId: string | null
  createdAt: Date
}

export type RunRow = {
  id: string
  status:
    | 'CANCELLED'
    | 'QUEUED'
    | 'RUNNING'
    | 'RECOVERING'
    | 'WAITING_FOR_AUTH'
    | 'NEEDS_REVIEW'
    | 'SUCCEEDED'
    | 'FAILED'
  createdAt: Date
  updatedAt: Date
  targetId: string
  createdByConsoleAccountId: string | null
  scenarioId: string
  scenarioVersionId: string
  targetAccountId: string | null
  evidenceStatus: 'PENDING' | 'COMPLETE' | 'INCOMPLETE'
  cancelRequestedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  snapshot: {
    schemaVersion: 1
    runId: string
    targetId: string
    scenarioId: string
    scenarioVersionId: string
    steps: (
      | {
          type: 'echo'
          input: { value?: JsonValue | undefined; from?: string | undefined }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'delay'
          input: { durationMs: number }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'fail'
          input: {
            message: string
            code?: string | undefined
            category?:
              | 'VALIDATION'
              | 'TIMEOUT'
              | 'CANCELLED'
              | 'EXECUTOR'
              | 'INFRASTRUCTURE'
              | 'UNKNOWN'
              | undefined
            retryable?: boolean | undefined
          }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'navigate'
          input: { url: string }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'click'
          input: {
            target: {
              framePath: {
                urlPattern?: string | undefined
                name?: string | undefined
                selector?: string | undefined
              }[]
              candidates: {
                by: 'css' | 'label' | 'title' | 'role' | 'text' | 'testId'
                value: string
                name?: string | undefined
              }[]
              anchor?: { withinText: string; scope: 'row' | 'nearest' } | undefined
            }
          }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'fill'
          input: {
            target: {
              framePath: {
                urlPattern?: string | undefined
                name?: string | undefined
                selector?: string | undefined
              }[]
              candidates: {
                by: 'css' | 'label' | 'title' | 'role' | 'text' | 'testId'
                value: string
                name?: string | undefined
              }[]
              anchor?: { withinText: string; scope: 'row' | 'nearest' } | undefined
            }
            value?: string | undefined
            from?: string | undefined
            sensitive?: boolean | undefined
          }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'extract'
          input: {
            target: {
              framePath: {
                urlPattern?: string | undefined
                name?: string | undefined
                selector?: string | undefined
              }[]
              candidates: {
                by: 'css' | 'label' | 'title' | 'role' | 'text' | 'testId'
                value: string
                name?: string | undefined
              }[]
              anchor?: { withinText: string; scope: 'row' | 'nearest' } | undefined
            }
            as: 'value' | 'text' | 'attribute'
            attribute?: string | undefined
          }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
      | {
          type: 'assert'
          input: {
            expect:
              | { kind: 'exists' }
              | { kind: 'visible' }
              | { kind: 'text_equals'; value: string }
              | { kind: 'text_contains'; value: string }
              | { kind: 'number_compare'; op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; value: number }
            target?:
              | {
                  framePath: {
                    urlPattern?: string | undefined
                    name?: string | undefined
                    selector?: string | undefined
                  }[]
                  candidates: {
                    by: 'css' | 'label' | 'title' | 'role' | 'text' | 'testId'
                    value: string
                    name?: string | undefined
                  }[]
                  anchor?: { withinText: string; scope: 'row' | 'nearest' } | undefined
                }
              | undefined
          }
          id: string
          name: string
          effectType: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
          outputKey?: string | undefined
          policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
        }
    )[]
    input: Record<string, JsonValue>
    createdAt: string
    targetAccountId?: string | undefined
    secretRef?: { provider: string; secretId: string } | undefined
    policy?: { timeoutMs?: number | undefined; retryLimit?: number | undefined } | undefined
    sessionPolicy?:
      | {
          reuse: 'REUSE_PAGE' | 'NEW_PAGE' | 'RECREATE_SESSION'
          idleTtlSeconds: number
          maxLifetimeSeconds: number
          leaseTtlSeconds: number
          authWaitSeconds: number
        }
      | undefined
    evidencePolicy?:
      | {
          screenshot?: 'always' | 'off' | 'on_failure' | undefined
          video?: 'always' | 'off' | undefined
          trace?: 'always' | 'off' | 'on_failure' | undefined
          required?: ('output' | 'input' | 'screenshot' | 'trace' | 'error' | 'log' | 'video')[] | undefined
          retainDays?: {
            screenshot?: number | undefined
            video?: number | undefined
            trace?: number | undefined
          } | undefined
        }
      | undefined
    executorVersions?: Record<string, string> | undefined
    digest?: string | undefined
  }
  snapshotDigest: string
  context: Record<string, JsonValue>
  idempotencyKey: string | null
  idempotencyDigest: string | null
  deletedAt: Date | null
  deletedBy: ResourceDeletedBy | null
}

export type StepRunRow = {
  id: string
  status: 'CANCELLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'SKIPPED'
  startedAt: Date | null
  finishedAt: Date | null
  runId: string
  stepId: string
  ordinal: number
}

export type AttemptRow = {
  id: string
  status: 'CANCELLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  output: JsonValue
  startedAt: Date
  finishedAt: Date | null
  error: JsonValue
  stepRunId: string
  attemptNo: number
}

export type EvidenceRow = {
  externalAccess?: number
  id: string
  status: 'available' | 'pending' | 'missing'
  createdAt: Date
  schemaVersion: number
  type: 'output' | 'input' | 'screenshot' | 'trace' | 'error' | 'log' | 'video'
  runId: string
  digest: string | null
  stepRunId: string | null
  attemptId: string | null
  artifactKey: string
  payload: JsonValue
  objectId: string | null
  objectKey: string | null
  contentType: string | null
  byteSize: number | null
  missingReason: string | null
  uploadAttempts: number
}

export type StoredObjectRow = {
  id: string
  status: 'available' | 'pending' | 'purged'
  createdAt: Date
  runId: string | null
  ownerKind: 'run' | 'artifact'
  artifactId: string | null
  digest: string | null
  objectKey: string
  contentType: string | null
  byteSize: number | null
  retainUntil: Date
  availableAt: Date | null
  deleteRequestedAt: Date | null
  purgedAt: Date | null
  purgeReason: PurgeReason | null
  purgeAttempts: number
  lastPurgeErrorAt: Date | null
}

export type BrowserSessionRow = {
  id: string
  status: 'CREATING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'LOST'
  createdAt: Date
  updatedAt: Date
  lastUsedAt: Date
  targetId: string
  targetAccountId: string
  idleTtlSeconds: number
  maxLifetimeSeconds: number
  health: 'UNKNOWN' | 'HEALTHY' | 'UNHEALTHY'
  authState: 'UNKNOWN' | 'AUTHENTICATED' | 'EXPIRED'
  ownerWorkerId: string
  ownerWorkerInstanceId: string | null
  generation: number
  fencingToken: number
  version: number
  profileKey: string
  reusePolicy: 'REUSE_PAGE' | 'NEW_PAGE' | 'RECREATE_SESSION'
  expiresAt: Date
  authControlEpoch: number
  authControlActorId: string | null
  authControlTokenHash: string | null
  authControlExpiresAt: Date | null
  authControlPageId: string | null
  lastAuthCheckedAt: Date | null
  lastAuthSuccessAt: Date | null
  lastAuthGeneration: number | null
  lastExpectedIdentity: string | null
  authValidUntil: Date | null
  authExpirySource: string | null
  lastAuthError: string | null
  authProfileRevision: number | null
  identityState: IdentityState | null
  identityVerifiedAt: Date | null
  observedTier: AuthCapabilityTier | null
  retainUntil: Date | null
  nextAuthCheckAt: Date | null
  reclaimMode: 'IDLE' | 'AUTH_DRIVEN'
  keepAliveUntil: Date | null
  keepAliveSeconds: number | null
  authProbeIntervalSeconds: number | null
  evictionPriority: number
  predecessorSessionId: string | null
  closeReason: string | null
  closedAt: Date | null
}

export type NewBrowserSession = {
  status: 'CREATING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'LOST'
  targetId: string
  targetAccountId: string
  idleTtlSeconds: number
  maxLifetimeSeconds: number
  ownerWorkerId: string
  ownerWorkerInstanceId?: string | null | undefined
  generation: number
  profileKey: string
  reusePolicy: 'REUSE_PAGE' | 'NEW_PAGE' | 'RECREATE_SESSION'
  expiresAt: Date
  id?: string | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
  lastUsedAt?: Date | undefined
  health?: 'UNKNOWN' | 'HEALTHY' | 'UNHEALTHY' | undefined
  authState?: 'UNKNOWN' | 'AUTHENTICATED' | 'EXPIRED' | undefined
  fencingToken?: number | undefined
  version?: number | undefined
  authControlEpoch?: number | undefined
  authControlActorId?: string | null | undefined
  authControlTokenHash?: string | null | undefined
  authControlExpiresAt?: Date | null | undefined
  authControlPageId?: string | null | undefined
  retainUntil?: Date | null | undefined
  nextAuthCheckAt?: Date | null | undefined
  reclaimMode?: 'IDLE' | 'AUTH_DRIVEN' | undefined
  keepAliveUntil?: Date | null | undefined
  keepAliveSeconds?: number | null | undefined
  authProbeIntervalSeconds?: number | null | undefined
  evictionPriority?: number | undefined
  predecessorSessionId?: string | null | undefined
  closeReason?: string | null | undefined
  closedAt?: Date | null | undefined
}

export type SessionLeaseRow = {
  id: string
  status: 'EXPIRED' | 'ACTIVE' | 'RELEASED' | 'REVOKED'
  runId: string | null
  expiresAt: Date
  sessionId: string
  sessionGeneration: number
  sessionFencingToken: number
  runFencingToken: number | null
  purpose: SessionLeasePurpose
  ownerKind: SessionLeaseOwnerKind
  operationId: string | null
  waitDeadlineAt: Date | null
  holderWorkerId: string
  acquiredAt: Date
  heartbeatAt: Date
  releasedAt: Date | null
  releaseReason: string | null
}

export type NewSessionLease = {
  status: 'EXPIRED' | 'ACTIVE' | 'RELEASED' | 'REVOKED'
  expiresAt: Date
  sessionId: string
  sessionGeneration: number
  sessionFencingToken: number
  holderWorkerId: string
  purpose: SessionLeasePurpose
  ownerKind: SessionLeaseOwnerKind
  id?: string | undefined
  runId?: string | null | undefined
  operationId?: string | null | undefined
  waitDeadlineAt?: Date | null | undefined
  runFencingToken?: number | null | undefined
  acquiredAt?: Date | undefined
  heartbeatAt?: Date | undefined
  releasedAt?: Date | null | undefined
  releaseReason?: string | null | undefined
}

export type WorkerRow = {
  id: string
  status: 'LOST' | 'READY' | 'DRAINING' | 'STOPPED'
  updatedAt: Date
  startedAt: Date
  heartbeatAt: Date
  instanceId: string
  capacity: number
  maxSessions: number
  stoppedAt: Date | null
  internalBaseUrl: string | null
  lostAfterSeconds: number | null
  heartbeatExpiresAt: Date | null
  liveHandleCount: number | null
  sampledSlotCount: number | null
  handleMismatchStreak: number
  protocolCapabilities: string[]
  sampledRssBytes: number | null
  sampledEventLoopDelayMs: number | null
  sampledCpuPercent: number | null
  sampledProfileBytes: number | null
  sampledProfileCount: number | null
  sampledProfileDiskFreeBytes: number | null
  sampledMidsceneBytes: number | null
  sampledBrowserProcessCount: number | null
  processClockSkewMs: number | null
  sampledDiskAt: Date | null
}

export type SessionOperationRow = {
  id: string
  targetId: string
  targetAccountId: string
  kind: SessionOperationKind
  kindParams: Record<string, unknown>
  origin: SessionOperationOrigin
  status: SessionOperationStatus
  expectedSessionId: string | null
  expectedGeneration: number | null
  idempotencyKey: string
  contentDigest: string
  authRuleRevision: number | null
  accountConfigDigest: string | null
  secretRefs: unknown[]
  resourcePolicy: Record<string, unknown> | null
  platformConfigRevision: number
  queueDeadlineAt: Date
  claimToken: string | null
  ownerWorkerId: string | null
  ownerWorkerInstanceId: string | null
  attemptNo: number
  errorCode: string | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

export type SessionProfileRow = {
  targetId: string
  targetAccountId: string
  revision: number
  locationWorkerId: string | null
  state: SessionProfileState
  pendingCleanups: SessionProfileCleanup[]
  updatedAt: Date
}

export type RunLeaseRow = {
  id: string
  status: 'EXPIRED' | 'ACTIVE' | 'RELEASED' | 'REVOKED'
  runId: string
  fencingToken: number
  expiresAt: Date
  holderWorkerId: string
  acquiredAt: Date
  heartbeatAt: Date
  releasedAt: Date | null
  releaseReason: string | null
}

export type RecordingDraftRow = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  targetId: string
  createdByConsoleAccountId: string
  idempotencyKey: string
  recordingId: string
  sourceVersion: string
  payloadDigest: string
  eventCount: number
  itemCount: number
  unresolvedCount: number
  events: {
    [x: string]: unknown
    name: string
    signals?: unknown[] | undefined
    selector?: string | undefined
    url?: string | undefined
    text?: string | undefined
    button?: string | undefined
    clickCount?: number | undefined
    modifiers?: number | undefined
    key?: string | undefined
    options?: string[] | undefined
    files?: string[] | undefined
    substring?: boolean | undefined
    value?: string | undefined
    checked?: boolean | undefined
    snapshot?: string | undefined
    pageAlias?: string | undefined
    framePath?: string[] | undefined
    locator?:
      | { kind: string; body?: unknown; options?: Record<string, unknown>; next?: unknown }
      | undefined
  }[]
  items: {
    index: number
    sourceIndexes: number[]
    status: 'mapped' | 'unresolved' | 'parameterized'
    sourceAction: string
    name: string
    diagnostics: string[]
    candidateStepType?: 'navigate' | 'click' | 'fill' | 'assert' | undefined
    input?: import('@cairn/shared').JsonValue | undefined
    pageAlias?: string | undefined
    framePath?: string[] | undefined
    sensitive?: boolean | undefined
  }[]
  diagnostics: string[]
  deletedAt: Date | null
  deletedBy: ResourceDeletedBy | null
}

export type NewRecordingDraftRow = {
  name: string
  targetId: string
  createdByConsoleAccountId: string
  idempotencyKey: string
  recordingId: string
  sourceVersion: string
  payloadDigest: string
  eventCount: number
  itemCount: number
  unresolvedCount: number
  events: {
    [x: string]: unknown
    name: string
    signals?: unknown[] | undefined
    selector?: string | undefined
    url?: string | undefined
    text?: string | undefined
    button?: string | undefined
    clickCount?: number | undefined
    modifiers?: number | undefined
    key?: string | undefined
    options?: string[] | undefined
    files?: string[] | undefined
    substring?: boolean | undefined
    value?: string | undefined
    checked?: boolean | undefined
    snapshot?: string | undefined
    pageAlias?: string | undefined
    framePath?: string[] | undefined
    locator?:
      | { kind: string; body?: unknown; options?: Record<string, unknown>; next?: unknown }
      | undefined
  }[]
  items: {
    index: number
    sourceIndexes: number[]
    status: 'mapped' | 'unresolved' | 'parameterized'
    sourceAction: string
    name: string
    diagnostics: string[]
    candidateStepType?: 'navigate' | 'click' | 'fill' | 'assert' | undefined
    input?: import('@cairn/shared').JsonValue | undefined
    pageAlias?: string | undefined
    framePath?: string[] | undefined
    sensitive?: boolean | undefined
  }[]
  diagnostics: string[]
  id?: string | undefined
  createdAt?: Date | undefined
  updatedAt?: Date | undefined
  deletedAt?: Date | null | undefined
  deletedBy?: ResourceDeletedBy | null | undefined
}

export type { ActionModuleRow, ActionModuleVersionRow } from './schema/action-modules.js'
