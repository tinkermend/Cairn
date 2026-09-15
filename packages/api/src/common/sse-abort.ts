/**
 * Node 24 会在 GET 读完空 body 后立刻 `req.emit('close')`，且 `req.destroyed === true`。
 * 画面/进度 SSE 若把这件事当成客户端断开，会在写出首帧前结束，控制台一直空白。
 */
export function abortWhenSseClientDrops(
  req: { on(event: 'aborted', listener: () => void): void },
  res?: { on(event: 'close', listener: () => void): void; writableEnded?: boolean },
): AbortSignal {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  req.on('aborted', abort)
  res?.on('close', () => {
    if (!res.writableEnded) abort()
  })
  return controller.signal
}
