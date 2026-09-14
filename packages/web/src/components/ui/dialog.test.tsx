import { useState } from 'react'
import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './alert-dialog'
import { Button } from './button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

function Sample({ confirmation }: { confirmation: boolean }) {
  const [open, setOpen] = useState(false)
  const Root = confirmation ? AlertDialog : Dialog
  const Content = confirmation ? AlertDialogContent : DialogContent
  const Title = confirmation ? AlertDialogTitle : DialogTitle
  const Description = confirmation ? AlertDialogDescription : DialogDescription
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开弹窗</Button>
      <Root open={open} onOpenChange={setOpen}>
        <Content>
          <Title>验收弹窗</Title>
          <Description>受控弹窗，没有内置 Trigger。</Description>
          <Button onClick={() => setOpen(false)}>完成并关闭</Button>
        </Content>
      </Root>
    </>
  )
}

it.each([false, true])(
  '受控弹窗关闭后恢复入口焦点（确认框：%s）',
  async (confirmation) => {
    const screen = await render(<Sample confirmation={confirmation} />)
    const trigger = screen.getByRole('button', { name: '打开弹窗' })
    await trigger.click()
    await screen.getByRole('button', { name: '完成并关闭' }).click()
    await expect.poll(() => document.activeElement).toBe(trigger.element())
  }
)
