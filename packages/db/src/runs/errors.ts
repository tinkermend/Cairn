export type DomainErrorKind = 'not_found' | 'conflict' | 'bad_request' | 'forbidden' | 'unavailable' | 'unauthorized' | 'rate_limited'

export class DomainError extends Error {
  readonly kind: DomainErrorKind
  readonly code: string
  readonly details?: unknown

  constructor(kind: DomainErrorKind, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'DomainError'
    this.kind = kind
    this.code = code
    this.details = details
  }
}

export function notFound(code: string, message: string, details?: unknown): DomainError {
  return new DomainError('not_found', code, message, details)
}

export function conflict(code: string, message: string, details?: unknown): DomainError {
  return new DomainError('conflict', code, message, details)
}

export function badRequest(code: string, message: string, details?: unknown): DomainError {
  return new DomainError('bad_request', code, message, details)
}

export function forbidden(code: string, message: string, details?: unknown): DomainError {
  return new DomainError('forbidden', code, message, details)
}

export function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  if (error instanceof Error && error.cause) return pgCode(error.cause)
  return undefined
}

export function constraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    return String((error as { constraint: unknown }).constraint)
  }
  if (error instanceof Error) {
    const foreign = /CONSTRAINT [`"']([^`"']+)[`"'] FOREIGN KEY/.exec(error.message)
    if (foreign) return foreign[1]
    const mysql = /for key ['`](?:[^.'`]+\.)?([^'`]+)['`]/.exec(error.message)
    if (mysql) return mysql[1]
    const sqlite = /UNIQUE constraint failed: (.+)/.exec(error.message)
    if (sqlite) {
      const columns = sqlite[1]!.split(', ').join(',')
      const names: Record<string, string> = {
        'browser_sessions.target_id,browser_sessions.target_account_id':
          'browser_sessions_key_live_idx',
        'run_leases.run_id': 'run_leases_active_idx',
        'session_leases.session_id': 'session_leases_active_idx',
        'scenarios.target_id,scenarios.name': 'scenarios_target_name_idx',
        'runs.created_by_console_account_id,runs.idempotency_key': 'runs_idempotency_idx',
        'recording_drafts.created_by_console_account_id,recording_drafts.idempotency_key':
          'recording_drafts_actor_idempotency_idx',
        'recording_import_receipts.scenario_id,recording_import_receipts.recording_draft_id':
          'recording_import_receipts_scenario_draft_idx',
        'recording_import_receipts.created_by_console_account_id,recording_import_receipts.idempotency_key':
          'recording_import_receipts_actor_idempotency_idx',
        'targets.code': 'targets_code_idx',
        'target_accounts.target_id,target_accounts.username': 'target_accounts_target_username_idx',
        'evidences.run_id': 'evidences_run_incomplete_idx',
      }
      return names[columns] ?? columns
    }
    if (error.cause) return constraintName(error.cause)
  }
  return undefined
}

export function mapRestriction(
  error: unknown,
  foreignKey?: 'target_account' | 'target' | 'scenario',
): DomainError | undefined {
  if (isUniqueViolation(error)) {
    const name = constraintName(error) ?? ''
    if (name.includes('scenarios_target_name')) {
      return conflict('SCENARIO_NAME_CONFLICT', '该目标系统下场景名已存在')
    }
    if (name.includes('runs_idempotency')) {
      return conflict('RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的运行输入')
    }
    if (name.includes('recording_drafts_actor_idempotency')) {
      return conflict('RECORDING_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的录制内容')
    }
    if (name.includes('recording_import_receipts_scenario_draft')) {
      return conflict('RECORDING_IMPORT_CONFLICT', '该录制批次已经回填到此场景')
    }
    if (name.includes('recording_import_receipts_actor_idempotency')) {
      return conflict('RECORDING_IMPORT_CONFLICT', '相同幂等键对应不同的导入请求')
    }
  }
  if (isForeignKeyViolation(error)) {
    const name = constraintName(error) ?? ''
    if (name.includes('target_account') || foreignKey === 'target_account') {
      return conflict('TARGET_ACCOUNT_HAS_RUNS', '请先处理引用该目标账号的运行')
    }
    // scenarios.target_id 必须先于笼统的 scenario 匹配，否则会误报 SCENARIO_HAS_RUNS
    if (name.includes('scenarios') && name.includes('target_id')) {
      return conflict('TARGET_HAS_SCENARIOS', '请先删除该目标系统下的场景')
    }
    if (name.includes('recording_drafts') && name.includes('target_id')) {
      return conflict('TARGET_HAS_RECORDINGS', '请先处理该目标系统下的录制草稿')
    }
    if (
      name.includes('scenario_id') ||
      name.includes('runs_scenario') ||
      foreignKey === 'scenario'
    ) {
      return conflict('SCENARIO_HAS_RUNS', '请先删除该场景下的运行')
    }
  }
  return undefined
}

export function databaseErrorKind(
  error: unknown,
): 'unique' | 'foreign_key' | 'check' | 'retryable' | undefined {
  const code = pgCode(error)
  const detail =
    error && typeof error === 'object'
      ? (error as { errno?: number; errcode?: number; cause?: unknown })
      : {}
  if (
    code === '23505' ||
    code === 'ER_DUP_ENTRY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    detail.errno === 1062 ||
    [1555, 2067].includes(detail.errcode ?? 0)
  )
    return 'unique'
  if (
    code === '23503' ||
    code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    ['ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED_2'].includes(code ?? '') ||
    detail.errcode === 787 ||
    (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed'))
  )
    return 'foreign_key'
  if (
    code === '23514' ||
    code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    code === 'SQLITE_CONSTRAINT_CHECK' ||
    detail.errcode === 275
  )
    return 'check'
  if (
    ['40001', '40P01', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code ?? '') ||
    (detail.errcode ?? -1) % 256 === 5
  )
    return 'retryable'
  return detail.cause ? databaseErrorKind(detail.cause) : undefined
}
export function isUniqueViolation(error: unknown): boolean {
  return databaseErrorKind(error) === 'unique'
}
export function isForeignKeyViolation(error: unknown): boolean {
  return databaseErrorKind(error) === 'foreign_key'
}

export function failure(
  kind: DomainErrorKind,
  value: string | { code: string; message: string },
): DomainError {
  const defaults = {
    conflict: 'CONFLICT',
    not_found: 'NOT_FOUND',
    bad_request: 'BAD_REQUEST',
    forbidden: 'FORBIDDEN',
    unavailable: 'SERVICE_UNAVAILABLE',
    unauthorized: 'UNAUTHORIZED',
    rate_limited: 'RATE_LIMITED',
  }
  return typeof value === 'string'
    ? new DomainError(kind, defaults[kind], value)
    : new DomainError(kind, value.code, value.message)
}

/** Kept only for PG-specific historical tests. */
export const mapPgRestriction = mapRestriction
