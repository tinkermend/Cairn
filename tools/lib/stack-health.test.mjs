import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decideVerdict,
  decodeInternalSecret,
  isFailure,
  looksLikeHtml,
  parseHealthBody,
  parseWorkerNodeHealth,
  resolveScope,
  signWorkerNodeHealthHeaders,
} from './stack-health.mjs'

const okHealth = {
  status: 'ok',
  service: 'cairn-api',
  uptimeSeconds: 12,
  checks: { database: 'up', changeHint: 'unused' },
}

describe('resolveScope', () => {
  it('web 范围仍要求探 api，用来证明代理接通', () => {
    assert.deepEqual(resolveScope('web'), { api: true, worker: false, web: true })
  })

  it('拒绝未知范围', () => {
    assert.throws(() => resolveScope('frontend'), /未知探活范围/)
  })
})

describe('parseHealthBody', () => {
  it('接受与契约一致的响应，并补 changeHint 默认值', () => {
    const parsed = parseHealthBody(
      JSON.stringify({
        status: 'ok',
        service: 'cairn-api',
        uptimeSeconds: 1,
        checks: { database: 'up' },
      }),
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.value.checks.changeHint, 'unused')
  })

  it('拒绝非 JSON 和非法 status', () => {
    assert.equal(parseHealthBody('<html>').ok, false)
    assert.equal(parseHealthBody(JSON.stringify({ ...okHealth, status: 'fine' })).ok, false)
  })
})

describe('looksLikeHtml', () => {
  it('只把 200 的 HTML 当成页面活着', () => {
    assert.equal(looksLikeHtml('<!DOCTYPE html><html></html>', 200), true)
    assert.equal(looksLikeHtml('<html></html>', 500), false)
    assert.equal(looksLikeHtml('ok', 200), false)
  })
})

describe('decideVerdict', () => {
  const healthy = {
    requireApi: true,
    requireWorker: true,
    requireWeb: true,
    apiListen: true,
    workerListen: true,
    webListen: true,
    apiHealth: { ok: true, value: okHealth },
    workerHealth: { ok: true, value: { service: 'cairn-worker', loopAlive: true } },
    webPage: { ok: true },
    webHealth: { ok: true },
  }

  it('全绿是 STACK_OK', () => {
    assert.equal(decideVerdict(healthy).result, 'STACK_OK')
    assert.equal(isFailure('STACK_OK'), false)
  })

  it('端口没起来是 STACK_DOWN', () => {
    const verdict = decideVerdict({ ...healthy, apiListen: false })
    assert.equal(verdict.result, 'STACK_DOWN')
    assert.equal(verdict.fail, 'api 未监听')
    assert.equal(isFailure(verdict.result), true)
  })

  it('库挂了是 STACK_UNHEALTHY，即使 HTTP 还能回 degraded', () => {
    const verdict = decideVerdict({
      ...healthy,
      apiHealth: {
        ok: true,
        value: { ...okHealth, status: 'degraded', checks: { database: 'down', changeHint: 'unused' } },
      },
    })
    assert.equal(verdict.result, 'STACK_UNHEALTHY')
    assert.equal(verdict.fail, '数据库不可用')
  })

  it('页面在但代理探活失败，判定前后端未接通', () => {
    const verdict = decideVerdict({
      ...healthy,
      webHealth: { ok: false, error: '不可达' },
    })
    assert.equal(verdict.result, 'STACK_UNHEALTHY')
    assert.match(verdict.fail, /web→api/)
  })

  it('RMC07 在听但 loopAlive=false 必须 UNHEALTHY，不得只看 TCP', () => {
    const verdict = decideVerdict({
      ...healthy,
      workerListen: true,
      workerHealth: { ok: true, value: { service: 'cairn-worker', loopAlive: false } },
    })
    assert.equal(verdict.result, 'STACK_UNHEALTHY')
    assert.match(verdict.fail, /loopAlive/)
  })

  it('RMC07/RMC18 节点健康失败不得回退成只看监听', () => {
    const verdict = decideVerdict({
      ...healthy,
      workerListen: true,
      workerHealth: { ok: false, error: '缺少可用的 CAIRN_INTERNAL_AUTH_SECRET，禁止回退 TCP' },
    })
    assert.equal(verdict.result, 'STACK_UNHEALTHY')
    assert.match(verdict.fail, /CAIRN_INTERNAL_AUTH_SECRET/)
  })

  it('changeHint 降级默认不失败，--strict 才失败', () => {
    const input = {
      ...healthy,
      apiHealth: {
        ok: true,
        value: { ...okHealth, status: 'degraded', checks: { database: 'up', changeHint: 'down' } },
      },
    }
    assert.equal(decideVerdict(input).result, 'STACK_DEGRADED')
    assert.equal(decideVerdict(input).fail, null)
    assert.equal(isFailure('STACK_DEGRADED'), false)
    const strict = decideVerdict({ ...input, strict: true })
    assert.equal(strict.result, 'STACK_DEGRADED')
    assert.ok(strict.fail)
    assert.equal(isFailure(strict.result, true), true)
  })
})

describe('parseWorkerNodeHealth', () => {
  it('要求 cairn-worker 且读取 node.loopAlive', () => {
    const parsed = parseWorkerNodeHealth(
      JSON.stringify({
        status: 'ok',
        service: 'cairn-worker',
        uptimeSeconds: 1,
        checks: { database: 'up', changeHint: 'unused' },
        node: { workerId: 'local-worker', instanceId: 'i', lastTickAt: null, loopAlive: true, runningRunCount: 0, liveHandleCount: 0, shuttingDown: false },
      }),
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.value.loopAlive, true)
    assert.equal(
      parseWorkerNodeHealth(
        JSON.stringify({
          status: 'ok',
          service: 'cairn-api',
          uptimeSeconds: 1,
          checks: { database: 'up' },
        }),
      ).ok,
      false,
    )
  })
})

describe('signWorkerNodeHealthHeaders', () => {
  it('RMC18 只持 Worker ID 即可签名，不读 instanceId', () => {
    const secret = decodeInternalSecret('Y2Fpcm4tZGV2LW9ubHktaW50ZXJuYWwtYXV0aC1rMDE=')
    assert.ok(secret)
    const headers = signWorkerNodeHealthHeaders(secret, 'local-worker', 1_700_000_000)
    assert.equal(headers['x-cairn-node-worker'], 'local-worker')
    assert.equal(Object.values(headers).join(' ').includes('instance'), false)
  })
})
