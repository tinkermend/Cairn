import type { ChangeHint } from '@cairn/shared'

export type ChangeHintDraft = {
  runId: string
  eventSeq: number
}

export type ChangeHintPublisher = (hint: ChangeHintDraft) => void

let publisher: ChangeHintPublisher | null = null

export function setChangeHintPublisher(fn: ChangeHintPublisher | null): void {
  publisher = fn
}

export function publishChangeHint(hint: ChangeHintDraft): void {
  publisher?.(hint)
}

export function resetChangeHintPublisher(): void {
  publisher = null
}

export type ChangeHintListener = (hint: ChangeHint) => void
