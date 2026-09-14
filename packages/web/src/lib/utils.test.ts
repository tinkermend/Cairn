import { describe, expect, it } from 'vitest'
import { cn, getPageNumbers } from './utils'

it('合并语义字号时保留文字颜色，并正确覆盖默认及响应式字号', () => {
  for (const size of ['page', 'section', 'stat', 'body', 'small', 'label']) {
    expect(cn('text-sm text-primary-foreground', `text-${size}`)).toBe(
      `text-primary-foreground text-${size}`
    )
    expect(cn(`text-${size}`, 'text-destructive')).toBe(
      `text-${size} text-destructive`
    )
  }
  expect(
    cn(
      'text-sm text-primary-foreground md:text-sm',
      'text-body md:text-section'
    )
  ).toBe('text-primary-foreground text-body md:text-section')
})

describe('getPageNumbers', () => {
  it('returns all pages when total is at most 5', () => {
    expect(getPageNumbers(1, 3)).toEqual([1, 2, 3])
    expect(getPageNumbers(3, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('shows ellipsis near the beginning', () => {
    expect(getPageNumbers(1, 10)).toEqual([1, 2, 3, 4, '...', 10])
    expect(getPageNumbers(3, 10)).toEqual([1, 2, 3, 4, '...', 10])
  })

  it('shows ellipsis near the end', () => {
    expect(getPageNumbers(10, 10)).toEqual([1, '...', 7, 8, 9, 10])
    expect(getPageNumbers(9, 10)).toEqual([1, '...', 7, 8, 9, 10])
  })

  it('shows ellipsis on both side in the middle', () => {
    expect(getPageNumbers(5, 10)).toEqual([1, '...', 4, 5, 6, '...', 10])
  })

  it('handles current page greater than total pages', () => {
    expect(getPageNumbers(6, 5)).toEqual([1, 2, 3, 4, 5])
    expect(getPageNumbers(11, 10)).toEqual([1, '...', 7, 8, 9, 10])
  })
})
