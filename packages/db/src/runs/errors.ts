export type DomainErrorKind = 'not_found' | 'conflict' | 'bad_request'

export class DomainError extends Error {
  readonly kind: DomainErrorKind
  readonly code: string

  constructor(kind: DomainErrorKind, code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.kind = kind
    this.code = code
  }
}

export function notFound(code: string, message: string): DomainError {
  return new DomainError('not_found', code, message)
}

export function conflict(code: string, message: string): DomainError {
  return new DomainError('conflict', code, message)
}

export function badRequest(code: string, message: string): DomainError {
  return new DomainError('bad_request', code, message)
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
  if (error instanceof Error && error.cause) return constraintName(error.cause)
  return undefined
}

export function mapPgRestriction(error: unknown): DomainError | undefined {
  if (pgCode(error) === '23505') {
    const name = constraintName(error) ?? ''
    if (name.includes('scenarios_target_name')) {
      return conflict('SCENARIO_NAME_CONFLICT', '该目标系统下场景名已存在')
    }
    if (name.includes('runs_idempotency')) {
      return conflict('RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的运行输入')
    }
  }
  if (pgCode(error) === '23503') {
    const name = constraintName(error) ?? ''
    if (name.includes('target_account')) {
      return conflict('TARGET_ACCOUNT_HAS_RUNS', '请先处理引用该目标账号的运行')
    }
    // scenarios.target_id 必须先于笼统的 scenario 匹配，否则会误报 SCENARIO_HAS_RUNS
    if (name.includes('scenarios') && name.includes('target_id')) {
      return conflict('TARGET_HAS_SCENARIOS', '请先删除该目标系统下的场景')
    }
    if (name.includes('scenario_id') || name.includes('runs_scenario')) {
      return conflict('SCENARIO_HAS_RUNS', '请先删除该场景下的运行')
    }
  }
  return undefined
}
