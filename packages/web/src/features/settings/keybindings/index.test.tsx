import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { SettingsKeybindings } from './index'
import { useKeybindingsStore } from '@/stores/keybindings-store'
import { setMockPlatformForTesting } from '@/lib/platform'

describe('SettingsKeybindings (快捷键偏好设置页)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    setMockPlatformForTesting('mac')
    localStorage.clear()
    useKeybindingsStore.getState().resetAll()
    await page.viewport(1280, 800)
  })

  afterEach(() => {
    localStorage.clear()
    useKeybindingsStore.getState().resetAll()
    setMockPlatformForTesting(null)
  })

  it('完整渲染快捷键列表，展示默认命令与键帽', async () => {
    await render(<SettingsKeybindings />)

    await expect.element(page.getByText('快捷键偏好')).toBeVisible()
    await expect.element(page.getByText('唤起/收起识途助手')).toBeVisible()
    await expect.element(page.getByText('打开全局速寻/命令盘')).toBeVisible()
    await expect.element(page.getByText('保存场景编排草稿')).toBeVisible()
    await expect.element(page.getByText('触发当前步骤/场景试跑')).toBeVisible()

    // 默认 Mac 模式下显示 ⌘J
    await expect.element(page.getByText('⌘J')).toBeVisible()
  })

  it('点击修改唤起录制模态框，录制并保存合法快捷键', async () => {
    await render(<SettingsKeybindings />)

    const editBtn = page.getByTestId('edit-shortcut-assistant.toggle')
    await editBtn.click()

    const dialog = page.getByTestId('key-record-dialog')
    await expect.element(dialog).toBeVisible()

    const captureArea = page.getByTestId('shortcut-capture-area')
    await expect.element(captureArea).toBeVisible()

    // 模拟在捕获区按下 Cmd+Shift+J (Mac)
    const keyEvent = new KeyboardEvent('keydown', {
      code: 'KeyJ',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    captureArea.element().dispatchEvent(keyEvent)

    // 弹窗中应显示录制后的键帽 ⌘⇧J
    await expect.element(dialog.getByText('⌘⇧J')).toBeVisible()

    // 点击保存
    const saveBtn = page.getByTestId('save-shortcut-btn')
    await expect.element(saveBtn).not.toBeDisabled()
    await saveBtn.click()

    // 弹窗关闭，且行内显示新按键与「已自定义」标记
    await expect.element(page.getByTestId('keybinding-row-assistant.toggle').getByText('已自定义')).toBeVisible()
    expect(useKeybindingsStore.getState().getEffectiveKey('assistant.toggle')).toBe('mod+shift+j')
  })

  it('录制违规快捷键（系统保留黑名单）时阻止保存并展示错误提示', async () => {
    await render(<SettingsKeybindings />)

    const editBtn = page.getByTestId('edit-shortcut-assistant.toggle')
    await editBtn.click()

    const captureArea = page.getByTestId('shortcut-capture-area')

    // 模拟按下 Cmd+W (系统绝对黑名单)
    const forbiddenEvent = new KeyboardEvent('keydown', {
      code: 'KeyW',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    captureArea.element().dispatchEvent(forbiddenEvent)

    // 应出现错误提示
    const errorMsg = page.getByTestId('shortcut-error-msg')
    await expect.element(errorMsg).toBeVisible()
    await expect.element(errorMsg).toHaveTextContent('系统保留')

    // 保存按钮应被禁用
    const saveBtn = page.getByTestId('save-shortcut-btn')
    await expect.element(saveBtn).toBeDisabled()
  })

  it('录制与其他已有命令冲突的快捷键时展示冲突提示并阻止保存', async () => {
    await render(<SettingsKeybindings />)

    const editBtn = page.getByTestId('edit-shortcut-assistant.toggle')
    await editBtn.click()

    const captureArea = page.getByTestId('shortcut-capture-area')

    // 模拟按下 Cmd+K (已被全局速寻占用)
    const conflictEvent = new KeyboardEvent('keydown', {
      code: 'KeyK',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    captureArea.element().dispatchEvent(conflictEvent)

    // 应提示冲突
    const errorMsg = page.getByTestId('shortcut-error-msg')
    await expect.element(errorMsg).toBeVisible()
    await expect.element(errorMsg).toHaveTextContent('冲突')

    // 保存按钮应被禁用
    const saveBtn = page.getByTestId('save-shortcut-btn')
    await expect.element(saveBtn).toBeDisabled()
  })

  it('关闭错误录制后改为编辑另一命令，录制状态从该命令当前键位重新开始', async () => {
    await render(<SettingsKeybindings />)
    await page.getByTestId('edit-shortcut-assistant.toggle').click()
    const captureArea = page.getByTestId('shortcut-capture-area')
    captureArea.element().dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyW', metaKey: true, bubbles: true, cancelable: true,
    }))
    await expect.element(page.getByTestId('shortcut-error-msg')).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()

    await page.getByTestId('edit-shortcut-palette.open').click()
    await expect.element(page.getByTestId('shortcut-capture-area').getByText('⌘K')).toBeVisible()
    await expect.element(page.getByTestId('shortcut-error-msg')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('save-shortcut-btn')).toBeDisabled()
  })

  it('支持单项快捷键恢复默认和全部一键重置', async () => {
    useKeybindingsStore.getState().setCustomKey('assistant.toggle', 'mod+shift+j')
    useKeybindingsStore.getState().setCustomKey('scenario.save', 'mod+shift+s')

    await render(<SettingsKeybindings />)

    // 初始应有两处已自定义
    await expect.element(page.getByTestId('keybinding-row-assistant.toggle').getByText('已自定义')).toBeVisible()
    await expect.element(page.getByTestId('keybinding-row-scenario.save').getByText('已自定义')).toBeVisible()

    // 点击重置单项 assistant.toggle
    const resetSingleBtn = page.getByTestId('reset-shortcut-assistant.toggle')
    await resetSingleBtn.click()

    expect(useKeybindingsStore.getState().isCustomized('assistant.toggle')).toBe(false)
    expect(useKeybindingsStore.getState().getEffectiveKey('assistant.toggle')).toBe('mod+j')

    // 点击顶部的「恢复全部默认」
    const resetAllBtn = page.getByTestId('reset-all-shortcuts-btn')
    await resetAllBtn.click()

    expect(useKeybindingsStore.getState().isCustomized('scenario.save')).toBe(false)
    expect(useKeybindingsStore.getState().getEffectiveKey('scenario.save')).toBe('mod+s')
  })
})
