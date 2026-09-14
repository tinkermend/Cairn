export type SseFrame = {
  id?: string
  event: string
  data: string
  retry?: number
}

/**
 * 按 MDN SSE 规则解析 UTF-8 分片：字段、多行 data、注释心跳、CRLF。
 */
export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  let id: string | undefined
  let retry: number | undefined

  const dispatch = () => {
    if (data.length === 0 && !event) return
    onFrame({
      event: event || 'message',
      data: data.join('\n'),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    })
    event = ''
    data = []
    retry = undefined
  }

  const consumeLine = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
    else if (field === 'retry') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) retry = parsed
    }
  }

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      buffer = buffer.replace(/\r\n/g, '\n')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (done) {
        if (buffer.length > 0) consumeLine(buffer)
        dispatch()
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
