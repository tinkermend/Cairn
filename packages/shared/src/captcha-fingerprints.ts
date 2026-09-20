import type { CaptchaFingerprintRule } from './session-auth.js'

export const BUILTIN_CAPTCHA_FINGERPRINTS: readonly CaptchaFingerprintRule[] = [
  {
    id: 'gin-vue-admin-image',
    name: 'Gin-Vue-Admin 默认图形验证码',
    challengeType: 'IMAGE_CAPTCHA',
    confidence: 0.95,
    charsetRange: 0,
    expectedLength: 6,
    detectors: {
      imageSelector: 'img[src^="data:image/png;base64"]',
      inputSelector: 'input[placeholder*="验证码"]',
    },
  },
  {
    id: 'vben-admin-slider',
    name: 'Vben Admin 滑动条验证码',
    challengeType: 'SLIDER_CAPTCHA',
    confidence: 0.95,
    detectors: {
      containerSelector: 'div:has(.vben-spine-text)',
      knobSelector: '.cursor-move',
    },
  },
  {
    id: 'element-generic-captcha',
    name: '通用 Element 体系图形验证码',
    challengeType: 'IMAGE_CAPTCHA',
    confidence: 0.7,
    detectors: {
      imageSelector: 'img[src*="captcha"], img[src*="verify"]',
      inputSelector: 'input[placeholder*="验证码"], input[name*="captcha"]',
    },
  },
  {
    id: 'generic-slider-captcha',
    name: '通用前端滑块组件',
    challengeType: 'SLIDER_CAPTCHA',
    confidence: 0.7,
    detectors: {
      containerSelector: '.slider-container, [class*="slider-captcha"], [class*="drag-verify"]',
      knobSelector: '.slider-knob, .drag-btn, [class*="slider-button"]',
    },
  },
] as const
