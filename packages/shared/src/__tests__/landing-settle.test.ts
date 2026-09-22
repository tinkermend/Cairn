import { describe, expect, it } from 'vitest'
import {
  canOfferLandingSettle,
  classifyDismissLabel,
  isAppShellOverlay,
  isInterstitialAuthPath,
  isUnusableSettleUrl,
  needsLandingSettleCatchUp,
  pickDismissButton,
  resolveLandingSettleConfig,
  skippedLandingSettle,
} from '../landing-settle.js'

describe('classifyDismissLabel', () => {
  it('允许关闭类全等与有限后缀', () => {
    expect(classifyDismissLabel('关闭')).toBe('allow')
    expect(classifyDismissLabel('关闭窗口')).toBe('allow')
    expect(classifyDismissLabel('Got it')).toBe('allow')
    expect(classifyDismissLabel('Skip tour')).toBe('allow')
  })

  it('禁止用关闭前缀匹配任意关闭…', () => {
    expect(classifyDismissLabel('关闭账号')).toBe('none')
    expect(classifyDismissLabel('关闭通知')).toBe('none')
  })

  it('拒绝同意／开始类', () => {
    expect(classifyDismissLabel('立即体验')).toBe('deny')
    expect(classifyDismissLabel('Accept all')).toBe('deny')
    expect(classifyDismissLabel('Get started')).toBe('deny')
    expect(classifyDismissLabel('确定')).toBe('deny')
  })

  it('优先点允许表按钮', () => {
    expect(pickDismissButton(['立即体验', '知道了'])).toBe('知道了')
    expect(pickDismissButton(['Get started'])).toBeNull()
  })
})

describe('isInterstitialAuthPath', () => {
  it('识别 MFA／OAuth 路径', () => {
    expect(isInterstitialAuthPath('https://a.example/mfa', 'https://a.example/app')).toBe(true)
    expect(isInterstitialAuthPath('https://a.example/oauth/authorize', 'https://a.example/')).toBe(
      true,
    )
    expect(isInterstitialAuthPath('https://a.example/login#/otp', 'https://a.example/app')).toBe(true)
  })

  it('入口自己叫 verify 时不因该词跳过', () => {
    expect(
      isInterstitialAuthPath('https://a.example/verify', 'https://a.example/verify'),
    ).toBe(false)
    expect(
      isInterstitialAuthPath('https://a.example/account/verify', 'https://a.example/app'),
    ).toBe(true)
  })
})

describe('isAppShellOverlay', () => {
  it('满视口且无关闭钮当壳', () => {
    expect(
      isAppShellOverlay({
        width: 1920,
        height: 1080,
        viewportWidth: 1920,
        viewportHeight: 1080,
        hasAllowButton: false,
      }),
    ).toBe(true)
    expect(
      isAppShellOverlay({
        width: 1920,
        height: 1080,
        viewportWidth: 1920,
        viewportHeight: 1080,
        hasAllowButton: true,
      }),
    ).toBe(false)
    expect(
      isAppShellOverlay({
        width: 400,
        height: 300,
        viewportWidth: 1920,
        viewportHeight: 1080,
        hasAllowButton: false,
      }),
    ).toBe(false)
  })
})

describe('needsLandingSettleCatchUp', () => {
  it('没有整理事件则补跑', () => {
    expect(
      needsLandingSettleCatchUp(
        [{ type: 'auth.attempt_started', sessionId: 's', seq: 1 }],
        's',
      ),
    ).toBe(true)
  })

  it('登录尝试之后已有整理则不补跑', () => {
    expect(
      needsLandingSettleCatchUp(
        [
          { type: 'auth.attempt_started', sessionId: 's', seq: 1 },
          { type: 'auth.landing_settled', sessionId: 's', seq: 2 },
          { type: 'auth.verified', sessionId: 's', seq: 3 },
        ],
        's',
      ),
    ).toBe(false)
  })

  it('再次 attempt 之后没有整理则补跑', () => {
    expect(
      needsLandingSettleCatchUp(
        [
          { type: 'auth.landing_settled', sessionId: 's', seq: 2 },
          { type: 'auth.attempt_started', sessionId: 's', seq: 4 },
        ],
        's',
      ),
    ).toBe(true)
  })
})

describe('resolveLandingSettleConfig', () => {
  it('目标覆盖不超过登录超时，off 保持模式', () => {
    expect(
      resolveLandingSettleConfig({
        mode: 'off',
        targetTimeoutMs: 20_000,
        platformBudgetMs: 8_000,
        loginTimeoutMs: 10_000,
      }),
    ).toMatchObject({ mode: 'off', budgetMs: 10_000 })
    expect(
      resolveLandingSettleConfig({
        platformBudgetMs: 8_000,
        platformWatchMs: 1_500,
        loginTimeoutMs: 60_000,
      }).watchMs,
    ).toBe(1_500)
  })
})

describe('guards', () => {
  it('不可用 URL 与整理按钮资格', () => {
    expect(isUnusableSettleUrl('about:blank')).toBe(true)
    expect(isUnusableSettleUrl('https://a.example/app')).toBe(false)
    expect(canOfferLandingSettle({ status: 'ready' })).toBe(true)
    expect(canOfferLandingSettle({ status: 'needs_check' })).toBe(true)
    expect(canOfferLandingSettle({ status: 'ready', occupyingRunId: 'r' })).toBe(false)
    expect(canOfferLandingSettle({ status: 'identity_mismatch' })).toBe(false)
    expect(skippedLandingSettle('mode_off').skippedReason).toBe('mode_off')
  })
})
