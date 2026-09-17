'use strict'

// @ffmpeg/core 0.11 是 GPL/nonfree WASM，只在一次性编码子进程里加载，不进 shared / web / api。
const { readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const dir = process.argv[2]
const outPath = process.argv[3]
const fps = process.argv[4] || '2'
const maxBytes = process.argv[5] || '134217728'

if (!dir || !outPath) {
  process.stderr.write('用法: video-encoder-child.cjs <jpegDir> <out.webm> [fps] [maxBytes]\n')
  process.exit(2)
}

const createFFmpegCore = require('@ffmpeg/core')
const wasmBinary = readFileSync(require.resolve('@ffmpeg/core/dist/ffmpeg-core.wasm'))

async function main() {
  const frames = readdirSync(dir)
    .filter((name) => name.endsWith('.jpg'))
    .sort()
  if (frames.length === 0) {
    throw new Error('没有可编码的录像帧')
  }

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
    printErr: () => undefined,
  })

  for (const name of frames) {
    core.FS.writeFile(name, new Uint8Array(readFileSync(join(dir, name))))
  }

  const run = core.cwrap('proxy_main', 'number', ['number', 'number'])
  const args = [
    './ffmpeg',
    '-nostdin',
    '-y',
    '-framerate',
    String(fps),
    '-i',
    'frame_%05d.jpg',
    '-c:v',
    'libvpx',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '600k',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-auto-alt-ref',
    '0',
    '-fs',
    String(maxBytes),
    'out.webm',
  ]
  const argsPtr = core._malloc(args.length * 4)
  args.forEach((value, index) => {
    const size = core.lengthBytesUTF8(value) + 1
    const buf = core._malloc(size)
    core.stringToUTF8(value, buf, size)
    core.setValue(argsPtr + 4 * index, buf, 'i32')
  })
  run(args.length, argsPtr)
  await finished
  const bytes = core.FS.readFile('out.webm')
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 4 ||
    bytes[0] !== 0x1a ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0xdf ||
    bytes[3] !== 0xa3
  ) {
    throw new Error('编码结果不是可播 WebM')
  }
  writeFileSync(outPath, bytes)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
