import { afterEach, describe, expect, it } from 'vitest'
import type { PostgresDbEnv } from '@cairn/shared'
import { createChangeHint, publishChangeHint, resetChangeHintPublisher } from '../test-entry.js'

const deadEnv: PostgresDbEnv = {
  CAIRN_DB_DRIVER: 'postgres',
  CAIRN_DB_HOST: '127.0.0.1',
  CAIRN_DB_PORT: 1,
  CAIRN_DB_NAME: 'cairn',
  CAIRN_DB_USER: 'cairn',
  CAIRN_DB_PASSWORD: 'cairn',
  CAIRN_DB_SCHEMA: 'cairn',
}

const runId = '66666666-6666-4666-8666-666666666666'

describe('变化提示对运行进程隔离', () => {
  afterEach(() => {
    resetChangeHintPublisher()
  })

  it('不可达端口上的首次并发发布不会变成未处理拒绝', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const bus = createChangeHint({ hint: 'postgres', namespace: 'fault', dbEnv: deadEnv })
    try {
      publishChangeHint({ runId, eventSeq: 1 })
      publishChangeHint({ runId, eventSeq: 2 })
      await Promise.all([
        bus.publish({ namespace: 'fault', runId, eventSeq: 3 }).catch(() => undefined),
        bus.publish({ namespace: 'fault', runId, eventSeq: 4 }).catch(() => undefined),
      ])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(rejections).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
      await bus.close()
    }
  })
})
