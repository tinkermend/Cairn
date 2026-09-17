import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type EncodeJpegFilesToWebmInput = {
  frames: Uint8Array[]
  fps?: number
  maxBytes: number
}

export type EncodeJpegDirectoryToWebmInput = {
  dir: string
  fps?: number
  maxBytes: number
}

export type EncodeJpegFilesToWebmResult = {
  bytes: Uint8Array
  truncated: boolean
  truncateReason?: 'max_bytes'
}

function childScript(): string {
  return join(__dirname, 'video-encoder-child.cjs')
}

function spawnEncoder(dir: string, outPath: string, fps: number, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript(), dir, outPath, String(fps), String(maxBytes)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk))
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(detail || `VP8 编码失败（退出码 ${code ?? 'null'}）`))
    })
  })
}

export function isPlayableWebm(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

export async function encodeJpegDirectoryToWebm(
  input: EncodeJpegDirectoryToWebmInput,
): Promise<EncodeJpegFilesToWebmResult> {
  const fps = input.fps && input.fps > 0 ? input.fps : 2
  const outPath = join(input.dir, 'out.webm')
  await spawnEncoder(input.dir, outPath, fps, input.maxBytes)
  const bytes = await readFile(outPath)
  if (!isPlayableWebm(bytes)) {
    throw new Error('编码结果不是可播 WebM')
  }
  const truncated = bytes.byteLength >= input.maxBytes
  return {
    bytes,
    truncated,
    truncateReason: truncated ? 'max_bytes' : undefined,
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
    return await encodeJpegDirectoryToWebm({
      dir,
      fps: input.fps,
      maxBytes: input.maxBytes,
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
