export type PickedElement = {
  selector: string
  ariaSnapshot?: string
}

export function formatPickedElement(info: PickedElement): string {
  const selector = info.selector.trim()
  if (!selector) return '未识别到元素'
  const role = selector.match(/internal:role=([^\s\[]+)/)
  const name = selector.match(/\[name="([^"]+)"/i) ?? selector.match(/\[name='([^']+)'/i)
  if (role && name) return `${role[1]} · ${name[1]}`
  if (name) return name[1]
  if (selector.length > 96) return `${selector.slice(0, 93)}…`
  return selector
}
