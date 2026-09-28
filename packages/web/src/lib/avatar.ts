import { createAvatar } from '@dicebear/core'
import { bottts } from '@dicebear/collection'
import { DEFAULT_AVATAR_STYLE, PRESET_AVATAR_SEEDS } from '@cairn/shared'

const avatarCache = new Map<string, string>()

/**
 * 解析头像键，格式为 `<style>:<seed>` 或纯 `<seed>`。
 * 默认风格为 `bottts`。
 */
export function parseAvatarKey(avatarKey?: string | null): { style: string; seed: string } | null {
  if (!avatarKey || typeof avatarKey !== 'string') return null
  const trimmed = avatarKey.trim()
  if (!trimmed) return null

  const colonIdx = trimmed.indexOf(':')
  if (colonIdx > 0) {
    const style = trimmed.slice(0, colonIdx)
    const seed = trimmed.slice(colonIdx + 1)
    return { style: style || DEFAULT_AVATAR_STYLE, seed }
  }
  return { style: DEFAULT_AVATAR_STYLE, seed: trimmed }
}

/**
 * 将头像键转换为 SVG Data URI。纯本地生成并带内存缓存。
 */
export function getAvatarDataUri(avatarKey?: string | null): string | null {
  const parsed = parseAvatarKey(avatarKey)
  if (!parsed || !parsed.seed) return null

  const cacheKey = `${parsed.style}:${parsed.seed}`
  const cached = avatarCache.get(cacheKey)
  if (cached) return cached

  try {
    // 当前首选风格为 bottts
    const avatar = createAvatar(bottts, {
      seed: parsed.seed,
      radius: 0,
    })
    const dataUri = avatar.toDataUri()
    avatarCache.set(cacheKey, dataUri)
    return dataUri
  } catch {
    // 生成失败时返回 null，由调用方决定降级展示。
    return null
  }
}

/**
 * 预设头像列表
 */
export const PRESET_AVATARS: string[] = PRESET_AVATAR_SEEDS.map(
  (seed: string) => `${DEFAULT_AVATAR_STYLE}:${seed}`,
)

/** 未选择头像时的预览造型，避免空态只剩问号。 */
export const DEFAULT_PREVIEW_AVATAR = PRESET_AVATARS[0] ?? `${DEFAULT_AVATAR_STYLE}:cairn-bot-1`
