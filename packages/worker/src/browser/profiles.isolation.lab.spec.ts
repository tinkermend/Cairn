/**
 * 同一 Worker 进程同时拉起两台 Chromium，核对 slot 1 / slot 2 的用户数据目录互不串。
 * 无 Chromium 时跳过。
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchSession, stopSession, type BrowserHandle } from './runtime'
import { ensureProfileDir } from './profiles'
import { testOccupancyGrant, withTestOccupancy } from './test-occupancy'

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    const browser = await Promise.race([
      chromium.launch({ headless: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
    ])
    await browser.close()
    return true
  } catch {
    return false
  }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法绑定本地端口'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}/`)
    })
  })
}

function chromiumPidsUsing(profileDir: string): number[] {
  const marker = `--user-data-dir=${profileDir}`
  const listing = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  return listing.split('\n').flatMap((line) => {
    const at = line.indexOf(marker)
    if (at < 0 || !/(chrome|chromium)/i.test(line)) return []
    const next = line[at + marker.length]
    if (next && next !== ' ' && next !== '"') return []
    const pid = Number(line.trim().split(/\s+/)[0])
    return Number.isFinite(pid) ? [pid] : []
  })
}

async function originState(handle: BrowserHandle, url: string): Promise<{ slot: string | null; cookie: string }> {
  await handle.basePage.goto(url, { waitUntil: 'domcontentloaded' })
  return handle.basePage.evaluate(() => ({
    slot: localStorage.getItem('cairn-slot'),
    cookie: document.cookie,
  }))
}

describe('同一进程两套独立 Chromium Profile', { timeout: 120_000 }, () => {
  let hasBrowser = false
  let server: Server | undefined
  let baseUrl = ''
  let root = ''

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
    if (!hasBrowser) return
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>slot</title>')
    })
    baseUrl = await listen(server)
    root = mkdtempSync(join(tmpdir(), 'cairn-slot-profiles-'))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('slot 1 与 slot 2 同时在线，Cookie 与 localStorage 不共享，重开仍各回各盘', async () => {
    if (!hasBrowser) return
    const key = { targetId: 'target-slot', targetAccountId: 'account-slot' }
    const slot1 = ensureProfileDir(root, key, 1)
    const slot2 = ensureProfileDir(root, key, 2)
    expect(slot1.profileDir).toBe(join(root, 'target-slot', 'account-slot'))
    expect(slot2.profileDir).toBe(join(root, 'target-slot', 'account-slot', '2'))

    const grant = testOccupancyGrant({
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    })
    const first = await withTestOccupancy(async () => {
      const left = await launchSession(slot1.profileDir, { headless: true })
      const right = await launchSession(slot2.profileDir, { headless: true })
      try {
        expect(left.context.browser()?.isConnected()).toBe(true)
        expect(right.context.browser()?.isConnected()).toBe(true)
        expect(left.profileDir).not.toBe(right.profileDir)
        const leftPids = chromiumPidsUsing(slot1.profileDir)
        const rightPids = chromiumPidsUsing(slot2.profileDir)
        expect(leftPids.length).toBeGreaterThan(0)
        expect(rightPids.length).toBeGreaterThan(0)
        expect(leftPids.some((pid) => rightPids.includes(pid))).toBe(false)

        await left.basePage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
        await left.basePage.evaluate(() => {
          localStorage.setItem('cairn-slot', 'one')
          document.cookie = 'cairn_slot=one; path=/; max-age=3600'
        })
        const isolated = await originState(right, baseUrl)
        const kept = await originState(left, baseUrl)
        return { isolated, kept }
      } finally {
        await stopSession(left)
        await stopSession(right)
      }
    }, grant)

    expect(first.kept).toEqual({ slot: 'one', cookie: 'cairn_slot=one' })
    expect(first.isolated).toEqual({ slot: null, cookie: '' })

    const reopened = await withTestOccupancy(async () => {
      const left = await launchSession(slot1.profileDir, { headless: true })
      const right = await launchSession(slot2.profileDir, { headless: true })
      try {
        return {
          kept: await originState(left, baseUrl),
          isolated: await originState(right, baseUrl),
        }
      } finally {
        await stopSession(left)
        await stopSession(right)
      }
    }, grant)

    expect(reopened.kept).toEqual({ slot: 'one', cookie: 'cairn_slot=one' })
    expect(reopened.isolated).toEqual({ slot: null, cookie: '' })
  })
})
