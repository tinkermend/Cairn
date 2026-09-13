const UrlCtor = (
  globalThis as unknown as {
    URL: new (input: string, base?: string) => { origin: string; pathname: string }
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
