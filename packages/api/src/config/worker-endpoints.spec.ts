import { describe, expect, it } from 'vitest'
import { parseWorkerEndpoints } from '@cairn/shared'
import { withLocalWorkerEndpoints } from './worker-endpoints'

describe('local Worker endpoint defaults', () => {
  it('routes the single Worker and all four default role IDs to their loopback ports', () => {
    expect(parseWorkerEndpoints(withLocalWorkerEndpoints({}).CAIRN_WORKER_ENDPOINTS)).toEqual({
      'local-worker': 'http://127.0.0.1:8091',
      'local-worker-executor': 'http://127.0.0.1:8092',
      'local-worker-scheduler': 'http://127.0.0.1:8093',
      'local-worker-analyst': 'http://127.0.0.1:8094',
      'local-worker-maintenance': 'http://127.0.0.1:8095',
    })
  })

  it('preserves an explicitly configured endpoint map', () => {
    const env = { CAIRN_WORKER_ENDPOINTS: 'remote-worker=https://worker.example.test' }
    expect(withLocalWorkerEndpoints(env)).toBe(env)
  })
})
