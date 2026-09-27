import { createFileRoute } from '@tanstack/react-router'
import { SettingsKeybindings } from '@/features/settings/keybindings'

export const Route = createFileRoute('/_authenticated/settings/keybindings')({
  component: SettingsKeybindings,
})
