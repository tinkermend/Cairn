import { runPlacement, type RunDetailDto, type StepRunDto } from '@cairn/shared'

const RUN_ID = '44444444-4444-4444-8444-444444444444'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const SCENARIO_VERSION_ID = '55555555-5555-4555-8555-555555555555'
const CREATED_AT = '2026-09-11T02:00:00.000Z'

/** 按 RunDetailDto 契约构造的完整运行详情夹具；只覆盖测试关心的字段。 */
export function makeRunDetail(overrides: Partial<RunDetailDto> = {}): RunDetailDto {
  return {
    executionOrigin: 'standalone',
    id: RUN_ID,
    status: 'QUEUED',
    cancelRequested: false,
    targetId: TARGET_ID,
    targetName: '演示商城',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: SCENARIO_ID,
    scenarioName: '下单巡检',
    scenarioVersionId: SCENARIO_VERSION_ID,
    createdAt: CREATED_AT,
    startedAt: null,
    finishedAt: null,
    evidenceStatus: 'PENDING',
    outcomeStatus: 'NOT_EVALUATED',
    lease: null,
    debugMode: 'runThrough',
    outcomeResults: [],
    placement: runPlacement({
      state: 'not_applicable',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
    }),
    snapshot: {
      schemaVersion: 1,
      runId: RUN_ID,
      targetId: TARGET_ID,
      scenarioId: SCENARIO_ID,
      scenarioVersionId: SCENARIO_VERSION_ID,
      steps: [],
      input: {},
      createdAt: CREATED_AT,
    },
    context: {},
    stepRuns: [],
    ...overrides,
  }
}

/** 按 StepRunDto 契约构造的步骤运行夹具。 */
export function makeStepRun(overrides: Partial<StepRunDto> & Pick<StepRunDto, 'id' | 'stepId'>): StepRunDto {
  return {
    name: overrides.stepId,
    type: 'click',
    ordinal: 0,
    status: 'PENDING',
    outcomeStatus: 'NOT_EVALUATED',
    startedAt: null,
    finishedAt: null,
    attempts: [],
    ...overrides,
  }
}
