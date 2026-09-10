import { describe, expect, it } from 'vitest'
import { mapPgRestriction } from '../runs/errors.js'

function pgError(code: string, constraint: string) {
  return Object.assign(new Error('pg'), { code, constraint })
}

describe('mapPgRestriction', () => {
  it('23505 场景重名 / 幂等冲突', () => {
    expect(mapPgRestriction(pgError('23505', 'scenarios_target_name_idx'))).toMatchObject({
      code: 'SCENARIO_NAME_CONFLICT',
    })
    expect(mapPgRestriction(pgError('23505', 'runs_idempotency_idx'))).toMatchObject({
      code: 'RUN_IDEMPOTENCY_CONFLICT',
    })
  })

  it('23503 按约束名区分三条删除冲突，不互相误报', () => {
    expect(mapPgRestriction(pgError('23503', 'runs_target_account_id_fkey'))).toMatchObject({
      code: 'TARGET_ACCOUNT_HAS_RUNS',
    })
    expect(mapPgRestriction(pgError('23503', 'scenarios_target_id_fkey'))).toMatchObject({
      code: 'TARGET_HAS_SCENARIOS',
    })
    expect(mapPgRestriction(pgError('23503', 'runs_scenario_id_fkey'))).toMatchObject({
      code: 'SCENARIO_HAS_RUNS',
    })
  })

  it('未识别的约束原样放过', () => {
    expect(mapPgRestriction(pgError('23503', 'console_accounts_pkey'))).toBeUndefined()
    expect(mapPgRestriction(new Error('nope'))).toBeUndefined()
  })
})
