import { monitorEventLoopDelay } from 'node:perf_hooks'

const delay = monitorEventLoopDelay({ resolution: 20 })
delay.enable()

export function sampleApiProcess(): { rssBytes: number; eventLoopDelayMs: number } {
  const rssBytes = process.memoryUsage().rss
  const eventLoopDelayMs = delay.mean / 1e6
  delay.reset()
  return { rssBytes, eventLoopDelayMs }
}
