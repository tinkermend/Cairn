export const SNAKE_NODE_WIDTH = 236
export const SNAKE_NODE_HEIGHT = 132
export const SNAKE_COLUMN_GAP = 48
export const SNAKE_ROW_PITCH = 164

export function snakeColumns(width: number, count: number) {
  return Math.max(
    1,
    Math.min(
      count,
      Math.floor(
        (width - 48 + SNAKE_COLUMN_GAP) / (SNAKE_NODE_WIDTH + SNAKE_COLUMN_GAP)
      )
    )
  )
}

/** Centers remain symmetric around FlowGram's existing vertical axis. */
export function snakePosition(index: number, columns: number) {
  const row = Math.floor(index / columns)
  const column = row % 2 ? columns - 1 - (index % columns) : index % columns
  return {
    x: (column - (columns - 1) / 2) * (SNAKE_NODE_WIDTH + SNAKE_COLUMN_GAP),
    y: row * SNAKE_ROW_PITCH,
  }
}

export function snakePort(
  index: number,
  columns: number,
  direction: 'input' | 'output'
) {
  const offset = index % columns
  if (direction === 'input' && offset === 0) return 'topCenter'
  if (direction === 'output' && offset === columns - 1) return 'bottomCenter'
  const reversed = Math.floor(index / columns) % 2 === 1
  return direction === 'input'
    ? reversed
      ? 'rightCenter'
      : 'leftCenter'
    : reversed
      ? 'leftCenter'
      : 'rightCenter'
}
