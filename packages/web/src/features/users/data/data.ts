import { Eye, Shield, UserCheck } from 'lucide-react'
import {
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  type AccountStatus,
} from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'

export const callTypes = new Map<AccountStatus, StatusTone>([
  ['active', 'success'],
  ['disabled', 'neutral'],
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
