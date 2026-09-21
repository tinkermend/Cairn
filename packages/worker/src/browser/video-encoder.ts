import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TimedJpegFrame } from './video-timeline.js'

export type EncodeJpegFilesToWebmInput = {
  frames: Uint8Array[]
  fps?: number
  maxBytes: number
}

export type EncodeJpegDirectoryToWebmInput = {
  dir: string
  fps?: number
  maxBytes: number
  timeline?: {
    frames: TimedJpegFrame[]
    sealedTMs: number
  }
}

export type EncodeJpegFilesToWebmResult = {
  path: string
  byteSize: number
  bytes?: Uint8Array
  truncated: boolean
  truncateReason?: 'max_bytes'
  decodedDurationMs: number
  decodedFrames: number
  timingMode: 'concat' | 'grid' | 'cfr'
}

function childScript(): string {
  return join(__dirname, 'video-encoder-child.cjs')
}

type EncoderMeta = {
  decodedDurationMs: number
  decodedFrames: number
  timingMode: 'concat' | 'grid' | 'cfr'
}

function spawnEncoder(dir: string, outPath: string, fps: number, maxBytes: number): Promise<EncoderMeta> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript(), dir, outPath, String(fps), String(maxBytes)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk))
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(detail || `VP8 编码失败（退出码 ${code ?? 'null'}）`))
        return
      }
      try {
        const meta = JSON.parse(Buffer.concat(stdout).toString('utf8')) as EncoderMeta
        if (!Number.isFinite(meta.decodedDurationMs) || !Number.isFinite(meta.decodedFrames) || meta.decodedFrames < 1) {
          throw new Error('编码子进程未回报解码结果')
        }
        if (meta.timingMode !== 'concat' && meta.timingMode !== 'grid' && meta.timingMode !== 'cfr') {
          throw new Error('编码子进程时间模式无效')
        }
        resolve(meta)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** 廉价 EBML 前缀检查，不能单独当作可播或完整。 */
export function isPlayableWebm(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

export async function isPlayableWebmFile(filePath: string): Promise<boolean> {
  const fd = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await fd.read(buffer, 0, 4, 0)
    return bytesRead >= 4 && isPlayableWebm(buffer)
  } finally {
    await fd.close()
  }
}

async function encodeDirectoryOnce(
  input: EncodeJpegDirectoryToWebmInput,
): Promise<EncodeJpegFilesToWebmResult> {
  const fps = input.fps && input.fps > 0 ? input.fps : 2
  if (input.timeline) {
    await writeFile(join(input.dir, 'timeline.json'), JSON.stringify(input.timeline))
  }
  const outPath = join(input.dir, 'out.webm')
  const meta = await spawnEncoder(input.dir, outPath, fps, input.maxBytes)
  if (!(await isPlayableWebmFile(outPath))) {
    throw new Error('编码结果不是可播 WebM')
  }
  const fileStat = await stat(outPath)
  const truncated = fileStat.size >= input.maxBytes
  return {
    path: outPath,
    byteSize: fileStat.size,
    truncated,
    truncateReason: truncated ? 'max_bytes' : undefined,
    decodedDurationMs: meta.decodedDurationMs,
    decodedFrames: meta.decodedFrames,
    timingMode: meta.timingMode,
  }
}

export async function encodeJpegDirectoryToWebm(
  input: EncodeJpegDirectoryToWebmInput,
): Promise<EncodeJpegFilesToWebmResult> {
  try {
    return await encodeDirectoryOnce(input)
  } catch (first) {
    try {
      return await encodeDirectoryOnce(input)
    } catch {
      throw first
    }
  }
}

export async function encodeJpegFilesToWebm(
  input: EncodeJpegFilesToWebmInput,
): Promise<EncodeJpegFilesToWebmResult> {
  if (input.frames.length === 0) {
    throw new Error('没有可编码的录像帧')
  }
  const dir = await mkdtemp(join(tmpdir(), 'cairn-vp8-'))
  try {
    await mkdir(dir, { recursive: true })
    for (const [index, frame] of input.frames.entries()) {
      await writeFile(join(dir, `frame_${String(index).padStart(5, '0')}.jpg`), frame)
    }
    const result = await encodeJpegDirectoryToWebm({
      dir,
      fps: input.fps,
      maxBytes: input.maxBytes,
    })
    const bytes = await readFile(result.path)
    return { ...result, bytes }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
