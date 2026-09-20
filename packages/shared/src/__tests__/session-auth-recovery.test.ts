import { describe, expect, it } from 'vitest'
import {
  authGateClosedError,
  authGateDoesNotConsumeRetry,
  authRoutePath,
  classifyInterruptedAttempt,
  computeContextVersion,
  decideAuthRecovery,
  deriveRecoveryRule,
  FACTORY_RUN_AUTH_RECOVERY,
  inRunAuthVerifyAllowed,
  isContextRecoverable,
  NO_RUN_AUTH_RECOVERY,
  pageLooksLikeLogin,
  resolveRunAuthRecovery,
  shouldCloseAuthGate,
} from '../session-auth-recovery.js'
import type { AuthObservation } from '../session-auth.js'

const match: AuthObservation = {
  authState: 'AUTHENTICATED',
  identityState: 'MATCH',
  observedIdentity: 'alice',
  unknownClass: null,
  evidenceSummary: 'ok',
  authProfileRevision: 1,
  diagnosticCode: 'verified',
}

const expired: AuthObservation = {
  authState: 'EXPIRED',
  identityState: 'UNVERIFIED',
  observedIdentity: null,
  unknownClass: null,
  evidenceSummary: '失效条件 HTTP 401',
  authProfileRevision: 1,
  diagnosticCode: 'verified',
}

const mismatch: AuthObservation = {
  authState: 'AUTHENTICATED',
  identityState: 'MISMATCH',
  observedIdentity: 'bob',
  unknownClass: null,
  evidenceSummary: 'ok',
  authProfileRevision: 1,
  diagnosticCode: 'verified',
}

describe('运行中认证恢复契约', () => {
  it('步骤边界与周期性核验一律禁止（SM41）', () => {
    expect(inRunAuthVerifyAllowed('step_boundary')).toBe(false)
    expect(inRunAuthVerifyAllowed('periodic')).toBe(false)
    expect(inRunAuthVerifyAllowed('signal_confirm')).toBe(true)
    expect(inRunAuthVerifyAllowed('recovery')).toBe(true)
  })

  it('LEGACY 不关门；有信号且非 LEGACY 才关门', () => {
    const signals = [{ kind: 'navigated_to_login' as const, at: '2026-09-16T00:00:00.000Z', summary: '/login' }]
    expect(shouldCloseAuthGate({ capability: 'LEGACY', signals })).toBe(false)
    expect(shouldCloseAuthGate({ capability: 'LOGIN_VERIFIED', signals })).toBe(true)
    expect(shouldCloseAuthGate({ capability: 'IDENTITY_VERIFIED', signals: [] })).toBe(false)
  })

  it('按副作用类型分类中断 Attempt', () => {
    expect(classifyInterruptedAttempt({ effectType: 'SIDE_EFFECT', dispatched: false })).toBe('not_dispatched')
    expect(classifyInterruptedAttempt({ effectType: 'READ_ONLY', dispatched: true })).toBe('read_only_failed')
    expect(classifyInterruptedAttempt({ effectType: 'IDEMPOTENT', dispatched: true })).toBe('idempotent_failed')
    expect(classifyInterruptedAttempt({ effectType: 'SIDE_EFFECT', dispatched: true })).toBe('side_effect_dispatched')
    expect(authGateDoesNotConsumeRetry('not_dispatched')).toBe(true)
    expect(authGateDoesNotConsumeRetry('read_only_failed')).toBe(false)
  })

  it('确认仍 MATCH 则误报开门', () => {
    expect(
      decideAuthRecovery({
        capability: 'IDENTITY_VERIFIED',
        classification: 'not_dispatched',
        confirm: match,
        autoUsed: 0,
        manualUsed: 0,
        limits: FACTORY_RUN_AUTH_RECOVERY,
        contextRecoverable: true,
      }),
    ).toEqual({ kind: 'reopen' })
  })

  it('SIDE_EFFECT 已派发一律核查，即使确认 401', () => {
    expect(
      decideAuthRecovery({
        capability: 'IDENTITY_VERIFIED',
        classification: 'side_effect_dispatched',
        confirm: expired,
        autoUsed: 0,
        manualUsed: 0,
        limits: FACTORY_RUN_AUTH_RECOVERY,
        contextRecoverable: true,
      }),
    ).toEqual({ kind: 'review' })
  })

  it('LOGIN_VERIFIED 不重登；IDENTITY_VERIFIED 可自动恢复（SM42）', () => {
    const base = {
      classification: 'not_dispatched' as const,
      confirm: expired,
      autoUsed: 0,
      manualUsed: 0,
      limits: FACTORY_RUN_AUTH_RECOVERY,
      contextRecoverable: true,
    }
    expect(decideAuthRecovery({ ...base, capability: 'LOGIN_VERIFIED' })).toEqual({
      kind: 'fail',
      code: 'AUTH_CONTEXT_NOT_RECOVERABLE',
    })
    expect(decideAuthRecovery({ ...base, capability: 'IDENTITY_VERIFIED' })).toEqual({ kind: 'auto' })
    expect(decideAuthRecovery({ ...base, capability: 'LEGACY' })).toEqual({ kind: 'none' })
  })

  it('身份不符走人工；次数为 0 或用尽则 AUTH_RECOVERY_LIMIT（SM44D）', () => {
    expect(
      decideAuthRecovery({
        capability: 'IDENTITY_VERIFIED',
        classification: 'read_only_failed',
        confirm: mismatch,
        autoUsed: 0,
        manualUsed: 0,
        limits: FACTORY_RUN_AUTH_RECOVERY,
        contextRecoverable: true,
      }),
    ).toEqual({ kind: 'manual' })
    expect(
      decideAuthRecovery({
        capability: 'IDENTITY_VERIFIED',
        classification: 'not_dispatched',
        confirm: expired,
        autoUsed: 1,
        manualUsed: 0,
        limits: FACTORY_RUN_AUTH_RECOVERY,
        contextRecoverable: true,
      }),
    ).toEqual({ kind: 'manual' })
    expect(
      decideAuthRecovery({
        capability: 'IDENTITY_VERIFIED',
        classification: 'not_dispatched',
        confirm: expired,
        autoUsed: 0,
        manualUsed: 0,
        limits: { maxAutoRecoveriesPerRun: 0, maxManualRecoveriesPerRun: 0 },
        contextRecoverable: true,
      }),
    ).toEqual({ kind: 'fail', code: 'AUTH_RECOVERY_LIMIT' })
  })

  it('hash 登录页与后台页不能只靠 pathname 判断', () => {
    expect(
      pageLooksLikeLogin({
        pageUrl: 'http://demo.gin-vue-admin.com/#/login',
        loginUrl: 'http://demo.gin-vue-admin.com/#/login',
      }),
    ).toBe(true)
    expect(
      pageLooksLikeLogin({
        pageUrl: 'http://demo.gin-vue-admin.com/#/layout/dashboard',
        loginUrl: 'http://demo.gin-vue-admin.com/#/login',
      }),
    ).toBe(false)
    expect(
      pageLooksLikeLogin({
        pageUrl: 'http://demo.gin-vue-admin.com/',
        loginUrl: 'http://demo.gin-vue-admin.com/#/login',
      }),
    ).toBe(false)
    expect(authRoutePath('http://demo.gin-vue-admin.com/#/login')).toBe('/login')
    expect(authRoutePath('http://127.0.0.1:4177/login')).toBe('/login')
  })

  it('页面不可重建则无法安全续跑（SM13/SM16）', () => {
    const rule = deriveRecoveryRule({
      reuse: 'REUSE_PAGE',
      entryUrl: 'https://app.example/home',
      loginUrl: 'https://app.example/login',
      allowedOrigins: ['https://app.example'],
    })
    expect(isContextRecoverable({ rule, pageUrl: 'https://app.example/login' })).toBe(false)
    expect(isContextRecoverable({ rule, pageUrl: 'https://app.example/orders' })).toBe(true)
    expect(isContextRecoverable({ rule: { ...rule, reuse: 'NEW_PAGE' }, pageUrl: 'https://app.example/login' })).toBe(true)
    expect(
      decideAuthRecovery({
        capability: 'IDENTITY_VERIFIED',
        classification: 'not_dispatched',
        confirm: expired,
        autoUsed: 0,
        manualUsed: 0,
        limits: FACTORY_RUN_AUTH_RECOVERY,
        contextRecoverable: false,
      }),
    ).toEqual({ kind: 'fail', code: 'AUTH_CONTEXT_NOT_RECOVERABLE' })
  })

  it('旧快照缺字段按 0/0；contextVersion 对相同内容稳定', async () => {
    expect(resolveRunAuthRecovery(undefined)).toEqual(NO_RUN_AUTH_RECOVERY)
    const a = await computeContextVersion({ orderId: 1, name: 'a' })
    const b = await computeContextVersion({ name: 'a', orderId: 1 })
    const c = await computeContextVersion({ orderId: 2 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(authGateClosedError('not_dispatched').code).toBe('AUTH_GATE_CLOSED')
    expect(authGateClosedError('side_effect_dispatched').category).toBe('UNKNOWN')
  })
})
