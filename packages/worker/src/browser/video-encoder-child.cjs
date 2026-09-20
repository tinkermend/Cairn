'use strict'

// @ffmpeg/core 0.11 是 GPL/nonfree WASM，只在一次性编码子进程里加载，不进 shared / web / api。
const { readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const dir = process.argv[2]
const outPath = process.argv[3]
const fps = Number(process.argv[4] || '2') || 2
const maxBytes = process.argv[5] || '134217728'

if (!dir || !outPath) {
  process.stderr.write('用法: video-encoder-child.cjs <jpegDir> <out.webm> [fps] [maxBytes]\n')
  process.exit(2)
}

const createFFmpegCore = require('@ffmpeg/core')
const wasmBinary = readFileSync(require.resolve('@ffmpeg/core/dist/ffmpeg-core.wasm'))

function listJpeg(names) {
  return names.filter((name) => name.endsWith('.jpg')).sort()
}

function buildConcat(frames, sealedTMs) {
  const lines = ['ffconcat version 1.0']
  for (let i = 0; i < frames.length; i += 1) {
    const next = i + 1 < frames.length ? frames[i + 1].tMs : sealedTMs
    const durationMs = Math.max(1, Math.round(next - frames[i].tMs))
    lines.push(`file '${String(frames[i].file).replace(/'/g, "'\\''")}'`)
    lines.push(`duration ${(durationMs / 1000).toFixed(3)}`)
  }
  if (frames.length > 0) lines.push(`file '${String(frames[frames.length - 1].file).replace(/'/g, "'\\''")}'`)
  return `${lines.join('\n')}\n`
}

function resampleGrid(frames, sealedTMs, rate) {
  const span = Math.max(0, sealedTMs)
  const count = Math.max(1, Math.round((span * rate) / 1000))
  const picked = []
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : Math.round((i * span) / count)
    while (cursor + 1 < frames.length && frames[cursor + 1].tMs <= t) cursor += 1
    picked.push(frames[cursor])
  }
  return picked
}

function honorsTimeline(decoded, sealedTMs) {
  return (
    Number.isFinite(decoded.decodedFrames) &&
    decoded.decodedFrames >= 1 &&
    Number.isFinite(decoded.decodedDurationMs) &&
    Math.abs(decoded.decodedDurationMs - sealedTMs) <= 1000
  )
}

function parseDecodeLog(text) {
  let decodedDurationMs = 0
  const duration = text.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (duration) {
    decodedDurationMs = Math.round(
      (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
    )
  }
  let decodedFrames = 0
  for (const match of text.matchAll(/frame=\s*(\d+)/g)) {
    decodedFrames = Number(match[1])
  }
  return { decodedDurationMs, decodedFrames }
}

async function runFfmpeg(args, files, collectErr = false) {
  const logs = []
  let ended
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('VP8 编码超时')), 120_000)
    ended = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  const core = await createFFmpegCore({
    wasmBinary,
    print: (message) => {
      if (String(message) === 'FFMPEG_END') ended()
    },
    printErr: (message) => {
      if (collectErr) logs.push(String(message))
    },
  })
  for (const [name, bytes] of files) {
    core.FS.writeFile(name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }
  const run = core.cwrap('proxy_main', 'number', ['number', 'number'])
  const argv = ['./ffmpeg', '-nostdin', '-y', ...args]
  const argsPtr = core._malloc(argv.length * 4)
  argv.forEach((value, index) => {
    const size = core.lengthBytesUTF8(value) + 1
    const buf = core._malloc(size)
    core.stringToUTF8(value, buf, size)
    core.setValue(argsPtr + 4 * index, buf, 'i32')
  })
  run(argv.length, argsPtr)
  await finished
  return { core, logs: logs.join('\n') }
}

function isWebm(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
}

const encodeArgs = ['-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-fs', String(maxBytes), 'out.webm']

async function encodeCfr(files, rate) {
  const { core } = await runFfmpeg(['-framerate', String(rate), '-i', 'frame_%05d.jpg', ...encodeArgs], files)
  return core.FS.readFile('out.webm')
}

async function encodeConcat(files, concatText) {
  const withList = [...files, ['timeline.concat', Buffer.from(concatText)]]
  const { core } = await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'timeline.concat', '-vsync', 'vfr', ...encodeArgs], withList)
  return core.FS.readFile('out.webm')
}

async function encodeCopyConcat(files, concatText) {
  const withList = [...files, ['segments.concat', Buffer.from(concatText)]]
  const { core } = await runFfmpeg(
    ['-f', 'concat', '-safe', '0', '-i', 'segments.concat', '-c', 'copy', '-fs', String(maxBytes), 'out.webm'],
    withList,
  )
  return core.FS.readFile('out.webm')
}

function partitionSegments(frames, sealedTMs, segmentMs = 8000) {
  if (frames.length === 0) return []
  const windows = []
  let start = 0
  for (let i = 1; i <= frames.length; i += 1) {
    const last = i === frames.length
    const endT = last ? sealedTMs : frames[i].tMs
    if (last || endT - frames[start].tMs >= segmentMs) {
      windows.push({
        frames: frames.slice(start, i),
        fromMs: frames[start].tMs,
        toMs: Math.max(endT, frames[start].tMs + 1),
      })
      start = i
    }
  }
  return windows
}

function segmentHostName(index) {
  return `segment_${String(index).padStart(3, '0')}.webm`
}

async function encodeSegment(seg, index) {
  const hostName = segmentHostName(index)
  const hostPath = join(dir, hostName)
  if (existsSync(hostPath)) {
    const existing = readFileSync(hostPath)
    if (isWebm(existing)) return { name: hostName, bytes: existing }
  }
  const remapped = seg.frames.map((frame, index) => ({
    file: `frame_${String(index).padStart(5, '0')}.jpg`,
    tMs: frame.tMs - seg.fromMs,
  }))
  const jpegFiles = remapped.map((frame, index) => [frame.file, readFileSync(join(dir, seg.frames[index].file))])
  const sealedRel = Math.max(1, seg.toMs - seg.fromMs)
  let bytes
  try {
    bytes = await encodeConcat(jpegFiles, buildConcat(remapped, sealedRel))
    if (!isWebm(bytes)) throw new Error('concat 结果不是 WebM')
    const decoded = await decodeWebm(bytes)
    if (!honorsTimeline(decoded, sealedRel)) throw new Error('concat 未保住采集区间')
  } catch {
    const rate = Math.max(1, seg.frames.length / Math.max(0.001, sealedRel / 1000))
    bytes = await encodeCfr(jpegFiles, rate)
  }
  if (!isWebm(bytes)) throw new Error('分段编码结果不是可播 WebM')
  writeFileSync(hostPath, bytes)
  return { name: hostName, bytes }
}

async function decodeWebm(bytes) {
  const { logs } = await runFfmpeg(['-i', 'in.webm', '-f', 'null', '-'], [['in.webm', bytes]], true)
  return parseDecodeLog(logs)
}

async function main() {
  const names = listJpeg(readdirSync(dir))
  if (names.length === 0) {
    throw new Error('没有可编码的录像帧')
  }

  const timelinePath = join(dir, 'timeline.json')
  let timingMode = 'cfr'
  let bytes

  if (existsSync(timelinePath)) {
    const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'))
    const frames = Array.isArray(timeline.frames) ? timeline.frames : []
    const sealedTMs = Number(timeline.sealedTMs)
    if (frames.length === 0 || !Number.isFinite(sealedTMs)) {
      throw new Error('录像时间轴不完整')
    }
    const windows = partitionSegments(frames, sealedTMs)
    try {
      const segments = []
      for (let i = 0; i < windows.length; i += 1) {
        segments.push(await encodeSegment(windows[i], i))
      }
      if (segments.length === 1) {
        bytes = segments[0].bytes
        timingMode = 'concat'
      } else {
        const list = ['ffconcat version 1.0', ...segments.map((seg) => `file '${seg.name}'`)].join('\n') + '\n'
        const webmFiles = segments.map((seg) => [seg.name, seg.bytes])
        bytes = await encodeCopyConcat(webmFiles, list)
        if (!isWebm(bytes) || !honorsTimeline(await decodeWebm(bytes), sealedTMs)) {
          throw new Error('分段拼接未保住采集区间')
        }
        timingMode = 'concat'
      }
    } catch {
      const jpegFiles = names.map((name) => [name, readFileSync(join(dir, name))])
      try {
        bytes = await encodeConcat(jpegFiles, buildConcat(frames, sealedTMs))
        if (!isWebm(bytes)) throw new Error('concat 结果不是 WebM')
        const decoded = await decodeWebm(bytes)
        if (!honorsTimeline(decoded, sealedTMs)) throw new Error('concat 未保住采集区间')
        timingMode = 'concat'
      } catch {
        const rate = Math.max(1, frames.length / Math.max(0.001, sealedTMs / 1000))
        bytes = await encodeCfr(jpegFiles, rate)
        timingMode = 'cfr'
      }
    }
  } else {
    const jpegFiles = names.map((name) => [name, readFileSync(join(dir, name))])
    bytes = await encodeCfr(jpegFiles, fps)
  }

  if (!isWebm(bytes)) {
    throw new Error('编码结果不是可播 WebM')
  }

  const decoded = await decodeWebm(bytes)
  if (!Number.isFinite(decoded.decodedFrames) || decoded.decodedFrames < 1) {
    throw new Error('编码结果无法解码')
  }

  writeFileSync(outPath, bytes)
  process.stdout.write(JSON.stringify({
    decodedDurationMs: Math.max(0, decoded.decodedDurationMs),
    decodedFrames: decoded.decodedFrames,
    timingMode,
  }))
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
