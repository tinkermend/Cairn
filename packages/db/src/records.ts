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
  ScenarioStatus,
  StepRunStatus,
  PurgeReason,
  StoredObjectStatus,
  SessionAuthState,
  SessionHealth,
  SessionLeaseStatus,
  SessionReusePolicy,
  SessionStatus,
  RunLeaseStatus,
  WorkerStatus,
  RecordingEvent,
  RecordingItem,
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
  createdAt: Date
  updatedAt: Date
  targetId: string
  createdByConsoleAccountId: string
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
}

export type ScenarioDraftRow = {
  updatedAt: Date
  scenarioId: string
  revision: number
  document: ScenarioDocument
  updatedByConsoleAccountId: string
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
          trace?: 'always' | 'off' | 'on_failure' | undefined
          required?: ('output' | 'input' | 'screenshot' | 'trace' | 'error' | 'log')[] | undefined
          retainDays?: { screenshot?: number | undefined; trace?: number | undefined } | undefined
        }
      | undefined
    executorVersions?: Record<string, string> | undefined
    digest?: string | undefined
  }
  snapshotDigest: string
  context: Record<string, JsonValue>
  idempotencyKey: string | null
  idempotencyDigest: string | null
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
  type: 'output' | 'input' | 'screenshot' | 'trace' | 'error' | 'log'
  runId: string
  digest: string | null
  stepRunId: string | null
  attemptId: string | null
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
  runId: string
  digest: string | null
  objectKey: string
  contentType: string | null
  byteSize: number | null
  retainUntil: Date
  availableAt: Date | null
  purgedAt: Date | null
  purgeReason: 'expired' | 'upload_incomplete' | null
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
  generation: number
  fencingToken: number
  version: number
  profileKey: string
  reusePolicy: 'REUSE_PAGE' | 'NEW_PAGE' | 'RECREATE_SESSION'
  expiresAt: Date
  authHoldWorkerId: string | null
  authHoldExpiresAt: Date | null
  authHoldRunId: string | null
  authHoldSessionGeneration: number | null
  authHoldWorkerInstanceId: string | null
  authControlEpoch: number
  authControlActorId: string | null
  authControlTokenHash: string | null
  authControlExpiresAt: Date | null
  authControlPageId: string | null
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
  authHoldWorkerId?: string | null | undefined
  authHoldExpiresAt?: Date | null | undefined
  authHoldRunId?: string | null | undefined
  authHoldSessionGeneration?: number | null | undefined
  authHoldWorkerInstanceId?: string | null | undefined
  authControlEpoch?: number | undefined
  authControlActorId?: string | null | undefined
  authControlTokenHash?: string | null | undefined
  authControlExpiresAt?: Date | null | undefined
  authControlPageId?: string | null | undefined
  closeReason?: string | null | undefined
  closedAt?: Date | null | undefined
}

export type SessionLeaseRow = {
  id: string
  status: 'EXPIRED' | 'ACTIVE' | 'RELEASED' | 'REVOKED'
  runId: string
  expiresAt: Date
  sessionId: string
  sessionGeneration: number
  sessionFencingToken: number
  runFencingToken: number | null
  holderWorkerId: string
  acquiredAt: Date
  heartbeatAt: Date
  releasedAt: Date | null
  releaseReason: string | null
}

export type NewSessionLease = {
  status: 'EXPIRED' | 'ACTIVE' | 'RELEASED' | 'REVOKED'
  runId: string
  expiresAt: Date
  sessionId: string
  sessionGeneration: number
  sessionFencingToken: number
  holderWorkerId: string
  id?: string | undefined
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
}
