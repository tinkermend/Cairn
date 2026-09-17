import { describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { encodeJpegFilesToWebm, isPlayableWebm } from './video-encoder.js'

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
  }, 60_000)
})
