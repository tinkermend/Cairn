import { describe, expect, it } from 'vitest'

describe('监控页不得有定时刷新', () => {
  const sources = import.meta.glob('./*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>

  it('源码里没有 refetchInterval / EventSource / 页面级 setInterval，也不走 use-health', () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith('.test.tsx') && !file.endsWith('.test.ts'))
      .filter(([, code]) =>
        /\brefetchInterval\b|\brefetchIntervalInBackground\b|\bsetInterval\b|\bEventSource\b|\buse-health\b|\buseHealth\b/.test(
          code,
        ),
      )
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
