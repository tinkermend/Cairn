import type { Page, Locator } from 'playwright'
import {
  type ChallengeType,
  type ChallengeOutcome,
  type ChallengeHandler,
  type TargetCaptchaDefinition,
  type LoginLocator,
  BUILTIN_CAPTCHA_FINGERPRINTS,
} from '@cairn/shared'
import { solveImageCaptcha, type ImageCaptchaOptions } from './image-solver.js'
import { solveSliderCaptcha, type SliderCaptchaOptions } from './slider-solver.js'
import { expectedPatternFor, type CharsetRange } from './charset-range.js'

export interface CaptchaSolveHints {
  charsetRange?: CharsetRange
  expectedLength?: number
  colors?: string[]
}

export interface DetectedChallenge {
  type: ChallengeType
  source: string
  confidence: number
  locators: {
    // IMAGE_CAPTCHA
    image?: Locator
    input?: Locator
    // SLIDER_CAPTCHA
    knob?: Locator
    containerOrBg?: Locator
  }
  solveHints?: CaptchaSolveHints
}

export interface DispatcherSolveOptions extends ImageCaptchaOptions, SliderCaptchaOptions {
  timeoutMs?: number
}

function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
}

function cssEscapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function resolveLoginLocator(page: Page, locator: LoginLocator): Locator {
  if (locator.by === 'id') return page.locator(`#${cssEscape(locator.value)}`)
  if (locator.by === 'name') return page.locator(`[name="${cssEscapeAttr(locator.value)}"]`)
  return page.locator(locator.value)
}

/**
 * 探测当前页面是否存在验证码挑战：
 * 1. 优先根据 TargetAuth 显式配置的 captcha 字段进行定位
 * 2. 若未配置或为 AUTO，按内置特征指纹库逐一探查页面可见元素
 */
export async function detectChallenge(
  page: Page,
  captchaConfig?: TargetCaptchaDefinition | null,
): Promise<DetectedChallenge | null> {
  // 1. 显式配置探测（AUTO 也先试已填的定位器，再回落到指纹库）
  if (captchaConfig) {
    const tryImage = captchaConfig.type === 'IMAGE' || captchaConfig.type === 'AUTO'
    const trySlider = captchaConfig.type === 'SLIDER' || captchaConfig.type === 'AUTO'
    if (tryImage && captchaConfig.image) {
      const img = resolveLoginLocator(page, captchaConfig.image.imageLocator)
      const inp = resolveLoginLocator(page, captchaConfig.image.inputLocator)
      const visible = await img.isVisible().catch(() => false)
      if (visible) {
        return {
          type: 'IMAGE_CAPTCHA',
          source: 'EXPLICIT_TARGET_CONFIG',
          confidence: 1.0,
          locators: { image: img, input: inp },
          solveHints: {
            charsetRange: captchaConfig.image.charsetRange,
            expectedLength: captchaConfig.image.expectedLength,
            colors: captchaConfig.image.colors,
          },
        }
      }
    }

    if (trySlider && captchaConfig.slider?.knobLocator) {
      const knob = resolveLoginLocator(page, captchaConfig.slider.knobLocator)
      const bg = captchaConfig.slider.bgLocator
        ? resolveLoginLocator(page, captchaConfig.slider.bgLocator)
        : captchaConfig.slider.containerLocator
          ? resolveLoginLocator(page, captchaConfig.slider.containerLocator)
          : undefined
      const visible = await knob.isVisible().catch(() => false)
      if (visible) {
        return {
          type: 'SLIDER_CAPTCHA',
          source: 'EXPLICIT_TARGET_CONFIG',
          confidence: 1.0,
          locators: { knob, containerOrBg: bg },
        }
      }
    }
  }

  // 2. 指纹库智能匹配
  for (const rule of BUILTIN_CAPTCHA_FINGERPRINTS) {
    if (rule.challengeType === 'IMAGE_CAPTCHA') {
      if (rule.detectors.imageSelector && rule.detectors.inputSelector) {
        const img = page.locator(rule.detectors.imageSelector).first()
        const inp = page.locator(rule.detectors.inputSelector).first()
        const [imgVis, inpVis] = await Promise.all([
          img.isVisible().catch(() => false),
          inp.isVisible().catch(() => false),
        ])
        if (imgVis && inpVis) {
          return {
            type: 'IMAGE_CAPTCHA',
            source: `FINGERPRINT:${rule.id}`,
            confidence: rule.confidence,
            locators: { image: img, input: inp },
            solveHints: {
              charsetRange: rule.charsetRange,
              expectedLength: rule.expectedLength,
              colors: rule.colors,
            },
          }
        }
      }
    } else if (rule.challengeType === 'SLIDER_CAPTCHA') {
      if (rule.detectors.knobSelector) {
        const knob = page.locator(rule.detectors.knobSelector).first()
        const knobVis = await knob.isVisible().catch(() => false)
        if (knobVis) {
          const container = rule.detectors.containerSelector
            ? page.locator(rule.detectors.containerSelector).first()
            : undefined
          return {
            type: 'SLIDER_CAPTCHA',
            source: `FINGERPRINT:${rule.id}`,
            confidence: rule.confidence,
            locators: { knob, containerOrBg: container },
          }
        }
      }
    }
  }

  return null
}

/**
 * 分发并求解探测到的验证码挑战
 */
export async function solveChallenge(
  page: Page,
  detected: DetectedChallenge,
  options?: DispatcherSolveOptions,
): Promise<ChallengeOutcome> {
  const startTime = Date.now()

  if (detected.type === 'IMAGE_CAPTCHA') {
    if (!detected.locators.image || !detected.locators.input) {
      return {
        solved: false,
        challengeType: 'IMAGE_CAPTCHA',
        handledBy: 'MACHINE',
        durationMs: Date.now() - startTime,
        error: '缺少图形验证码图片或输入框定位器',
      }
    }

    const hints = detected.solveHints ?? {}
    const result = await solveImageCaptcha(
      page,
      detected.locators.image,
      detected.locators.input,
      {
        ...options,
        charsetRange: options?.charsetRange ?? hints.charsetRange,
        expectedLength: options?.expectedLength ?? hints.expectedLength,
        colors: options?.colors ?? hints.colors,
        expectedPattern:
          options?.expectedPattern ??
          expectedPatternFor({
            charsetRange: options?.charsetRange ?? hints.charsetRange,
            expectedLength: options?.expectedLength ?? hints.expectedLength,
          }),
      },
    )
    return {
      solved: result.solved,
      challengeType: 'IMAGE_CAPTCHA',
      handledBy: 'MACHINE',
      confidence: result.confidence,
      durationMs: Date.now() - startTime,
      error: result.error,
    }
  }

  if (detected.type === 'SLIDER_CAPTCHA') {
    if (!detected.locators.knob) {
      return {
        solved: false,
        challengeType: 'SLIDER_CAPTCHA',
        handledBy: 'MACHINE',
        durationMs: Date.now() - startTime,
        error: '缺少滑块拖拽手柄定位器',
      }
    }

    const result = await solveSliderCaptcha(
      page,
      detected.locators.knob,
      detected.locators.containerOrBg,
      options,
    )
    return {
      solved: result.solved,
      challengeType: 'SLIDER_CAPTCHA',
      handledBy: 'MACHINE',
      confidence: result.solved ? 0.9 : 0.0,
      durationMs: result.durationMs,
      error: result.error,
    }
  }

  return {
    solved: false,
    challengeType: detected.type,
    handledBy: 'MACHINE',
    durationMs: Date.now() - startTime,
    error: `不支持的挑战类型: ${detected.type}`,
  }
}

export type WorkerChallengeContext = {
  page: Page
  captcha?: TargetCaptchaDefinition | null
  detected?: DetectedChallenge | null
  solveOptions?: DispatcherSolveOptions
}

export class ImageCaptchaHandler implements ChallengeHandler {
  readonly supportedType = 'IMAGE_CAPTCHA' as const

  async detect(context: unknown): Promise<boolean> {
    const ctx = context as WorkerChallengeContext
    const found = await detectChallenge(ctx.page, ctx.captcha)
    return found?.type === 'IMAGE_CAPTCHA'
  }

  async handle(context: unknown): Promise<ChallengeOutcome> {
    const ctx = context as WorkerChallengeContext
    const detected = ctx.detected ?? (await detectChallenge(ctx.page, ctx.captcha))
    if (!detected || detected.type !== 'IMAGE_CAPTCHA') {
      return {
        solved: false,
        challengeType: 'IMAGE_CAPTCHA',
        handledBy: 'MACHINE',
        durationMs: 0,
        error: '未探测到图形验证码',
      }
    }
    return solveChallenge(ctx.page, detected, ctx.solveOptions)
  }
}

export class SliderCaptchaHandler implements ChallengeHandler {
  readonly supportedType = 'SLIDER_CAPTCHA' as const

  async detect(context: unknown): Promise<boolean> {
    const ctx = context as WorkerChallengeContext
    const found = await detectChallenge(ctx.page, ctx.captcha)
    return found?.type === 'SLIDER_CAPTCHA'
  }

  async handle(context: unknown): Promise<ChallengeOutcome> {
    const ctx = context as WorkerChallengeContext
    const detected = ctx.detected ?? (await detectChallenge(ctx.page, ctx.captcha))
    if (!detected || detected.type !== 'SLIDER_CAPTCHA') {
      return {
        solved: false,
        challengeType: 'SLIDER_CAPTCHA',
        handledBy: 'MACHINE',
        durationMs: 0,
        error: '未探测到滑块验证码',
      }
    }
    return solveChallenge(ctx.page, detected, ctx.solveOptions)
  }
}

export const PHASE1_CHALLENGE_HANDLERS: readonly ChallengeHandler[] = [
  new ImageCaptchaHandler(),
  new SliderCaptchaHandler(),
]
