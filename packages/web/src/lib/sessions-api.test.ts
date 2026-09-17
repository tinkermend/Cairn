import { expect, it } from 'vitest'
import { sessionObserveQuery } from './sessions-api'

it('observe 只在目标和账号成对时带过滤，避免系统页只传 targetId 被契约拒绝', () => {
  expect(sessionObserveQuery({ targetId: 't1' })).toEqual({ cursor: undefined })
  expect(sessionObserveQuery({ accountId: 'a1' })).toEqual({ cursor: undefined })
  expect(sessionObserveQuery({ targetId: 't1', accountId: 'a1', cursor: '9' })).toEqual({
    targetId: 't1',
    accountId: 'a1',
    cursor: '9',
  })
})
