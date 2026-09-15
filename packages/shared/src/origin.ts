const UrlCtor = (
  globalThis as unknown as {
    URL: new (input: string, base?: string) => { origin: string; pathname: string; protocol: string }
  }
).URL

/** 从 Target 入口 / 登录 URL 抽出允许的页面源。非法入口返回空数组。 */
export function originsFromTargetUrls(entryUrl: string, loginUrl?: string | null): string[] {
  const origins = new Set<string>()
  try {
    origins.add(new UrlCtor(entryUrl).origin)
  } catch {
    return []
  }
  if (loginUrl) {
    try {
      origins.add(new UrlCtor(loginUrl, entryUrl).origin)
    } catch {
      // 忽略非法 loginUrl，仍用入口源
    }
  }
  return [...origins]
}

/** 插件观察页必须与 Target 入口同源；非法 URL 不得拿去发外部请求。 */
export function urlBelongsToTargetOrigins(url: string, allowed: readonly string[]): boolean {
  try {
    const parsed = new UrlCtor(url)
    if (parsed.origin === 'null' || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return false
    return allowed.some((item) => {
      try {
        return new UrlCtor(item).origin === parsed.origin
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

export function loginScopeFromTargetUrl(
  entryUrl: string,
  loginUrl?: string | null,
): { loginOrigin?: string; loginPath?: string } {
  if (!loginUrl) return {}
  try {
    const parsed = new UrlCtor(loginUrl, entryUrl)
    return { loginOrigin: parsed.origin, loginPath: parsed.pathname }
  } catch {
    return {}
  }
}
