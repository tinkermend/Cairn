import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveWorkerRoleConfig } from './worker-role-config.mjs'

describe('resolveWorkerRoleConfig', () => {
  it('给四个角色分配唯一的 ID 和端口，不改变单 Worker 默认端口', () => {
    const roles = resolveWorkerRoleConfig({})
    assert.deepEqual(roles.map(({ role }) => role), ['executor', 'scheduler', 'analyst', 'maintenance'])
    assert.deepEqual(roles.map(({ id }) => id), [
      'local-worker-executor',
      'local-worker-scheduler',
      'local-worker-analyst',
      'local-worker-maintenance',
    ])
    assert.deepEqual(roles.map(({ port }) => port), [8092, 8093, 8094, 8095])
    assert.deepEqual(roles.map(({ advertiseUrl }) => advertiseUrl), [
      'http://127.0.0.1:8092',
      'http://127.0.0.1:8093',
      'http://127.0.0.1:8094',
      'http://127.0.0.1:8095',
    ])
  })

  it('支持主机前缀和角色独立覆盖', () => {
    const roles = resolveWorkerRoleConfig({
      CAIRN_WORKER_ROLE_ID_PREFIX: 'host-a',
      CAIRN_WORKER_EXECUTOR_ID: 'host-a-runner-1',
      CAIRN_WORKER_EXECUTOR_PORT: '8102',
    })
    assert.equal(roles[0].id, 'host-a-runner-1')
    assert.equal(roles[0].port, 8102)
    assert.equal(roles[0].advertiseUrl, 'http://127.0.0.1:8102')
    assert.equal(roles[1].id, 'host-a-scheduler')
  })

  it('角色显式广告地址优先于本机默认地址', () => {
    const roles = resolveWorkerRoleConfig({
      CAIRN_WORKER_EXECUTOR_ADVERTISE_URL: 'https://worker.example.test:8102',
    })
    assert.equal(roles[0].advertiseUrl, 'https://worker.example.test:8102')
    assert.equal(roles[1].advertiseUrl, 'http://127.0.0.1:8093')
  })

  it('拒绝与 API、单 Worker 或其他角色冲突的端口和 ID', () => {
    assert.throws(() => resolveWorkerRoleConfig({ CAIRN_WORKER_EXECUTOR_PORT: '8091' }), /CAIRN_WORKER_INTERNAL_PORT/)
    assert.throws(() => resolveWorkerRoleConfig({ CAIRN_WORKER_EXECUTOR_PORT: '8093' }), /端口必须互不相同/)
    assert.throws(() => resolveWorkerRoleConfig({ CAIRN_WORKER_EXECUTOR_ID: 'local-worker-scheduler' }), /ID 必须互不相同/)
    assert.throws(() => resolveWorkerRoleConfig({ CAIRN_WORKER_EXECUTOR_PORT: 'bad' }), /端口/)
  })

  it('单 Worker 内部监听关闭时仍可给四个角色分配独立端口', () => {
    const roles = resolveWorkerRoleConfig({ CAIRN_WORKER_INTERNAL_PORT: '0' })
    assert.deepEqual(roles.map(({ port }) => port), [8092, 8093, 8094, 8095])
  })

  it('单 Worker 有广告 URL 时要求每个角色单独配置，拒绝重复入口', () => {
    assert.throws(() => resolveWorkerRoleConfig({ CAIRN_WORKER_ADVERTISE_URL: 'https://one.test' }), /CAIRN_WORKER_EXECUTOR_ADVERTISE_URL/)
    assert.throws(() => resolveWorkerRoleConfig({
      CAIRN_WORKER_EXECUTOR_ADVERTISE_URL: 'https://one.test',
      CAIRN_WORKER_SCHEDULER_ADVERTISE_URL: 'https://one.test',
    }), /广告 URL 必须互不相同/)
    assert.throws(() => resolveWorkerRoleConfig({
      CAIRN_WORKER_EXECUTOR_ADVERTISE_URL: 'https://ONE.test',
      CAIRN_WORKER_SCHEDULER_ADVERTISE_URL: 'https://one.test:443',
    }), /广告 URL 必须互不相同/)
  })
})
