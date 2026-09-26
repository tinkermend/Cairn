import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import '@/styles/index.css'
import { StudioSplitterLayout } from './studio-splitter-layout'

describe('StudioSplitterLayout', () => {
  it('正确渲染三栏与分割手柄，在宽屏下初始宽度符合默认规范', async () => {
    const screen = await render(
      <div style={{ width: '1280px', height: '600px', display: 'flex' }}>
        <StudioSplitterLayout
          left={<div data-testid='left-content' className='h-full'>步骤管线</div>}
          center={<div data-testid='center-content' className='h-full'>受管舞台</div>}
          right={<div data-testid='right-content' className='h-full'>属性检查器</div>}
        />
      </div>
    )

    await expect.element(screen.getByTestId('left-content')).toBeInTheDocument()
    await expect.element(screen.getByTestId('center-content')).toBeInTheDocument()
    await expect.element(screen.getByTestId('right-content')).toBeInTheDocument()

    const leftHandle = screen.getByTestId('splitter-handle-left')
    const rightHandle = screen.getByTestId('splitter-handle-right')
    await expect.element(leftHandle).toBeInTheDocument()
    await expect.element(rightHandle).toBeInTheDocument()

    // 默认初始值：左 250px，右 400px
    const leftPane = screen.getByTestId('splitter-left-pane')
    const rightPane = screen.getByTestId('splitter-right-pane')
    expect(leftPane.element().style.width).toBe('250px')
    expect(rightPane.element().style.width).toBe('400px')
  })

  it('在超窄容器（< 768px）下自适应收缩左栏至上限 180px', async () => {
    const screen = await render(
      <div style={{ width: '600px', height: '600px', display: 'flex' }}>
        <StudioSplitterLayout
          left={<div>左栏</div>}
          center={<div>中栏</div>}
          right={<div>右栏</div>}
        />
      </div>
    )

    const leftPane = screen.getByTestId('splitter-left-pane')
    expect(leftPane.element().style.width).toBe('180px')
  })

  it('支持双击分割线重置为默认宽度', async () => {
    const screen = await render(
      <div style={{ width: '1280px', height: '600px', display: 'flex' }}>
        <StudioSplitterLayout
          left={<div className='h-full'>左栏</div>}
          center={<div className='h-full'>中栏</div>}
          right={<div className='h-full'>右栏</div>}
        />
      </div>
    )

    const leftHandle = screen.getByTestId('splitter-handle-left')
    await leftHandle.dblClick()

    const leftPane = screen.getByTestId('splitter-left-pane')
    expect(leftPane.element().style.width).toBe('250px')
  })

  it('支持 stage 舞台对焦模式：左栏紧凑为 48px，隐藏右栏与左手柄，中间最大化', async () => {
    const screen = await render(
      <div style={{ width: '1280px', height: '600px', display: 'flex' }}>
        <StudioSplitterLayout
          preset='stage'
          left={<div>左栏</div>}
          center={<div>中栏</div>}
          right={<div>右栏</div>}
        />
      </div>
    )

    const leftPane = screen.getByTestId('splitter-left-pane')
    expect(leftPane.element().style.width).toBe('48px')

    // 右栏与手柄在 stage 模式下隐藏
    expect(screen.getByTestId('splitter-right-pane').elements()).toHaveLength(0)
    expect(screen.getByTestId('splitter-handle-left').elements()).toHaveLength(0)
    await expect.element(screen.getByTestId('splitter-center-pane')).toBeInTheDocument()
  })

  it('支持 pipeline 编排对焦模式：隐藏中栏舞台，左侧与右侧平铺', async () => {
    const screen = await render(
      <div style={{ width: '1280px', height: '600px', display: 'flex' }}>
        <StudioSplitterLayout
          preset='pipeline'
          left={<div>左栏</div>}
          center={<div>中栏</div>}
          right={<div>右栏</div>}
        />
      </div>
    )

    expect(screen.getByTestId('splitter-center-pane').elements()).toHaveLength(0)
    await expect.element(screen.getByTestId('splitter-left-pane')).toBeInTheDocument()
    await expect.element(screen.getByTestId('splitter-right-pane')).toBeInTheDocument()
  })
})
