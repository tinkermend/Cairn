import { monitorEventLoopDelay } from 'node:perf_hooks'

const delay = monitorEventLoopDelay({ resolution: 20 })
delay.enable()

let lastCpu = process.cpuUsage()
let lastHr = process.hrtime.bigint()

export function sampleProcessResources(): {
  rssBytes: number
  eventLoopDelayMs: number
  cpuPercent: number
} {
  const rssBytes = process.memoryUsage().rss
  const eventLoopDelayMs = delay.mean / 1e6
  delay.reset()
  const cpu = process.cpuUsage(lastCpu)
  const now = process.hrtime.bigint()
  const elapsedUs = Number(now - lastHr) / 1000
  lastCpu = process.cpuUsage()
  lastHr = now
  const raw = elapsedUs > 0 ? ((cpu.user + cpu.system) / elapsedUs) * 100 : 0
  return {
    rssBytes,
    eventLoopDelayMs,
    cpuPercent: Math.min(100, Math.max(0, Math.round(raw))),
  }
}
