import { describe, expect, it } from 'vitest'
import {
  collectCrossCheckTexts,
  cssAttrEscape,
  cssViewportPoint,
  inspectPointElement,
  MIDSCENE_LOCATE_SDK,
  resolvedSelector,
} from './resolved-handle.js'

describe('点到元素句柄', () => {
  it('按 DPR 把设备像素换算成 CSS 视口坐标', () => {
    expect(MIDSCENE_LOCATE_SDK).toBe('1.12.6')
    expect(cssViewportPoint([200, 80], 2)).toEqual({ x: 100, y: 40 })
    expect(cssViewportPoint([100, 50], 0)).toEqual({ x: 100, y: 50 })
  })

  it('一次性属性选择器可转义引号', () => {
    expect(resolvedSelector('a"b')).toBe('[data-cairn-resolved="a\\"b"]')
    expect(cssAttrEscape('x\\y')).toBe('x\\\\y')
  })

  it('命中 iframe 记 FRAME_UNSUPPORTED，空点记 AI_NOT_FOUND', () => {
    expect(inspectPointElement({ element: null })).toEqual({ ok: false, reason: 'AI_NOT_FOUND' })
    expect(inspectPointElement({ element: { tagName: 'IFRAME' } })).toEqual({
      ok: false,
      reason: 'FRAME_UNSUPPORTED',
    })
    expect(inspectPointElement({ element: { tagName: 'BUTTON' }, texts: ['提交'] })).toMatchObject({
      ok: true,
      tagName: 'BUTTON',
      container: false,
      texts: ['提交'],
    })
    expect(inspectPointElement({ element: { tagName: 'TD' } })).toMatchObject({
      ok: true,
      container: true,
    })
  })

  it('交叉确认文本不含整块 textContent，容器不用 innerText', () => {
    expect(
      collectCrossCheckTexts({
        ariaLabel: '查询',
        ownText: '',
        innerText: '查询 以及整表其它文字',
        container: false,
      }),
    ).toEqual(['查询', '查询 以及整表其它文字'])
    expect(
      collectCrossCheckTexts({
        ownText: '',
        innerText: '单元格里塞了整行订单号和按钮',
        container: true,
      }),
    ).toEqual([])
  })
})
