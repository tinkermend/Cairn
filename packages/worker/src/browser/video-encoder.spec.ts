import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import jpeg from 'jpeg-js'
import { computeRunVideoCoverage } from '@cairn/shared'
import { encodeJpegDirectoryToWebm, encodeJpegFilesToWebm, isPlayableWebm } from './video-encoder.js'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function solidJpeg(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return Uint8Array.from(jpeg.encode({ data, width, height }, 60).data)
}

describe('encodeJpegFilesToWebm', () => {
  it('把 JPEG 帧编成可播 WebM，而不是 JPEG 目录', async () => {
    const red = solidJpeg(64, 48, 220, 20, 20)
    const blue = solidJpeg(64, 48, 20, 40, 200)
    expect(red[0]).toBe(0xff)
    expect(red[1]).toBe(0xd8)
    const encoded = await encodeJpegFilesToWebm({
      frames: [red, blue, red],
      fps: 2,
      maxBytes: 512_000,
    })
    expect(isPlayableWebm(encoded.bytes)).toBe(true)
    expect(encoded.bytes[0]).not.toBe(0xff)
    expect(Buffer.from(encoded.bytes.subarray(0, 64)).includes(Buffer.from('webm'))).toBe(true)
    expect(encoded.truncated).toBe(false)
    expect(encoded.decodedFrames).toBeGreaterThanOrEqual(1)
    expect(encoded.decodedDurationMs).toBeGreaterThan(0)
  }, 60_000)

  it('VE13：4 字节 EBML 头不是可解码证明', () => {
    const header = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])
    expect(isPlayableWebm(header)).toBe(true)
    expect(header.byteLength).toBe(4)
  })

  it('按时间轴编码时片长接近采集区间', async () => {
    const red = solidJpeg(64, 48, 220, 20, 20)
    const blue = solidJpeg(64, 48, 20, 40, 200)
    const dir = await mkdtemp(join(tmpdir(), 'cairn-vp8-t-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'frame_00000.jpg'), red)
    await writeFile(join(dir, 'frame_00001.jpg'), blue)
    const encoded = await encodeJpegDirectoryToWebm({
      dir,
      fps: 2,
      maxBytes: 512_000,
      timeline: {
        frames: [
          { file: 'frame_00000.jpg', tMs: 0 },
          { file: 'frame_00001.jpg', tMs: 4_000 },
        ],
        sealedTMs: 5_000,
      },
    })
    expect(encoded.decodedFrames).toBeGreaterThanOrEqual(1)
    expect(Math.abs(encoded.decodedDurationMs - 5_000)).toBeLessThanOrEqual(1_000)
  }, 60_000)

  it('三十多帧的长采集区间不能被编成单帧 40ms', async () => {
    const red = solidJpeg(64, 48, 220, 20, 20)
    const blue = solidJpeg(64, 48, 20, 40, 200)
    const dir = await mkdtemp(join(tmpdir(), 'cairn-vp8-long-'))
    await mkdir(dir, { recursive: true })
    const frames = []
    for (let i = 0; i < 37; i += 1) {
      const file = `frame_${String(i).padStart(5, '0')}.jpg`
      await writeFile(join(dir, file), i % 2 === 0 ? red : blue)
      frames.push({ file, tMs: i * 1_200 })
    }
    const encoded = await encodeJpegDirectoryToWebm({
      dir,
      fps: 2,
      maxBytes: 2_000_000,
      timeline: { frames, sealedTMs: 43_200 },
    })
    expect(encoded.decodedFrames).toBeGreaterThan(1)
    expect(Math.abs(encoded.decodedDurationMs - 43_200)).toBeLessThanOrEqual(1_000)
    expect(encoded.bytes.byteLength).toBeGreaterThan(1_000)
    const segments = (await readdir(dir)).filter((name) => name.startsWith('segment_') && name.endsWith('.webm'))
    expect(segments.length).toBeGreaterThan(1)
  }, 90_000)

  it('VE09：第二段编码中杀子进程，JPEG 与已落盘段保留，重试不误报完整', async () => {
    const red = solidJpeg(160, 120, 220, 20, 20)
    const blue = solidJpeg(160, 120, 20, 40, 200)
    const dir = await mkdtemp(join(tmpdir(), 'cairn-ve09-'))
    await mkdir(dir, { recursive: true })
    const frames: Array<{ file: string; tMs: number }> = []
    const writeFrame = async (index: number, tMs: number) => {
      const file = `frame_${String(index).padStart(5, '0')}.jpg`
      await writeFile(join(dir, file), index % 2 === 0 ? red : blue)
      frames.push({ file, tMs })
    }
    await writeFrame(0, 0)
    await writeFrame(1, 3_000)
    for (let i = 0; i < 16; i += 1) {
      await writeFrame(2 + i, 8_000 + i * 450)
    }
    const jpegNames = frames.map((frame) => frame.file)
    const sealedTMs = 16_000
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ frames, sealedTMs }))

    const childScript = join(dirname(fileURLToPath(import.meta.url)), 'video-encoder-child.cjs')
    const child = spawn(process.execPath, [childScript, dir, join(dir, 'out.webm'), '2', '2000000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if ((await readdir(dir)).includes('segment_000.webm')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect((await readdir(dir)).includes('segment_000.webm')).toBe(true)
    child.kill('SIGKILL')
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    expect(exited.signal === 'SIGKILL' || (exited.code !== 0 && exited.code !== null)).toBe(true)

    const afterKill = await readdir(dir)
    for (const name of jpegNames) {
      expect(afterKill).toContain(name)
    }
    expect(afterKill).toContain('segment_000.webm')

    const encoded = await encodeJpegDirectoryToWebm({
      dir,
      fps: 2,
      maxBytes: 2_000_000,
      timeline: { frames, sealedTMs },
    })
    const afterRecover = await readdir(dir)
    for (const name of jpegNames) {
      expect(afterRecover).toContain(name)
    }
    expect(afterRecover).toContain('segment_000.webm')
    expect(isPlayableWebm(encoded.bytes)).toBe(true)
    expect(encoded.decodedFrames).toBeGreaterThanOrEqual(1)

    const coverage = computeRunVideoCoverage({
      frames,
      capturedSpanMs: sealedTMs,
      decodedDurationMs: encoded.decodedDurationMs,
      truncated: encoded.truncated,
      finalFrame: 'captured',
    })
    expect(['complete', 'partial']).toContain(coverage.status)
    if (coverage.status === 'complete') {
      expect(Math.abs(encoded.decodedDurationMs - sealedTMs)).toBeLessThanOrEqual(1_000)
    } else {
      expect(coverage.gaps.length).toBeGreaterThan(0)
    }
  }, 180_000)
})
