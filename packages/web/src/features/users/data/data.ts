import { Eye, Shield, UserCheck } from 'lucide-react'
import {
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  type AccountStatus,
} from '@cairn/shared'

export const callTypes = new Map<AccountStatus, string>([
  ['active', 'bg-teal-100/30 text-teal-900 dark:text-teal-200 border-teal-200'],
  [
    'disabled',
    'bg-destructive/10 dark:bg-destructive/50 text-destructive dark:text-primary border-destructive/10',
  ],
])

const ROLE_ICONS = {
  admin: Shield,
  operator: UserCheck,
  viewer: Eye,
} as const

export const roles = SYSTEM_ROLE_KEYS.map((key) => ({
  label: SYSTEM_ROLE_DEFINITIONS[key].name,
  value: key,
  icon: ROLE_ICONS[key],
}))
