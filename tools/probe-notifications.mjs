#!/usr/bin/env node
// Backward-compatibility wrapper: delegates to probe-outbound.mjs
console.warn(
  '[cairn:deprecated] probe-notifications.mjs is deprecated; forwarding to probe-outbound.mjs',
)
await import('./probe-outbound.mjs')
