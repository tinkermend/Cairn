import { describe, expect, it } from 'vitest'
import { readSseStream, type SseFrame } from './sse'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  await readSseStream(stream, (frame) => frames.push(frame))
  return frames
}

describe('readSseStream', () => {
  it('拼回跨分片的字段', async () => {
    const frames = await collect(streamOf('eve', 'nt: ready\n', 'data: {"kind":"ready"}\n\n'))
    expect(frames).toEqual([{ event: 'ready', data: '{"kind":"ready"}' }])
  })

  it('接受 CRLF 与多行 data', async () => {
    const frames = await collect(streamOf('event: run.created\r\ndata: {"a":1}\r\ndata: {"b":2}\r\n\r\n'))
    expect(frames).toEqual([{ event: 'run.created', data: '{"a":1}\n{"b":2}' }])
  })

  it('忽略注释心跳，并保留 id', async () => {
    const frames = await collect(
      streamOf(': keepalive\n\nid: run-1:3\nevent: run.status_changed\ndata: {"seq":3}\n\n'),
    )
    expect(frames).toEqual([
      { event: 'run.status_changed', data: '{"seq":3}', id: 'run-1:3' },
    ])
  })

  it('没有 event 字段时回落到 message', async () => {
    const frames = await collect(streamOf('data: ping\n\n'))
    expect(frames).toEqual([{ event: 'message', data: 'ping' }])
  })
})
