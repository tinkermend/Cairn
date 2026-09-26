import {
  Building2,
  Cloud,
  Database,
  Factory,
  Globe2,
  Landmark,
  Layers,
  ShoppingBag,
  type LucideIcon,
} from 'lucide-react'
import {
  DEFAULT_TARGET_ACCENT_KEY,
  DEFAULT_TARGET_ICON_KEY,
  type TargetAccentKey,
  type TargetIconKey,
} from '@cairn/shared'
import { cn } from '@/lib/utils'

export const TARGET_ICON_OPTIONS: ReadonlyArray<{ key: TargetIconKey; label: string }> = [
  { key: 'globe', label: '地球' },
  { key: 'building', label: '楼宇' },
  { key: 'layers', label: '层级' },
  { key: 'database', label: '数据' },
  { key: 'cloud', label: '云' },
  { key: 'shopping-bag', label: '商城' },
  { key: 'landmark', label: '机构' },
  { key: 'factory', label: '工厂' },
]

export const TARGET_ACCENT_OPTIONS: ReadonlyArray<{ key: TargetAccentKey; label: string }> = [
  { key: 'blue', label: '主蓝' },
  { key: 'pine', label: '松绿' },
  { key: 'slate', label: '石板灰' },
  { key: 'teal', label: '青绿' },
  { key: 'amber', label: '暖金' },
  { key: 'violet', label: '薰衣草紫' },
  { key: 'rose', label: '浅玫瑰' },
]

const ICONS: Record<TargetIconKey, LucideIcon> = {
  globe: Globe2,
  building: Building2,
  layers: Layers,
  database: Database,
  cloud: Cloud,
  'shopping-bag': ShoppingBag,
  landmark: Landmark,
  factory: Factory,
}

type TargetIdentityIconProps = {
  iconKey?: TargetIconKey
  accentKey?: TargetAccentKey
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function TargetIdentityIcon({
  iconKey = DEFAULT_TARGET_ICON_KEY,
  accentKey = DEFAULT_TARGET_ACCENT_KEY,
  size = 'md',
  className,
}: TargetIdentityIconProps) {
  const Icon = ICONS[iconKey] ?? ICONS[DEFAULT_TARGET_ICON_KEY]
  return (
    <span
      aria-hidden='true'
      data-accent={accentKey}
      className={cn(
        'target-identity-icon inline-flex shrink-0 items-center justify-center rounded-xl',
        size === 'lg' ? 'size-12' : size === 'sm' ? 'size-8' : 'size-10',
        className,
      )}
    >
      <Icon className={size === 'lg' ? 'size-6' : size === 'sm' ? 'size-4' : 'size-5'} />
    </span>
  )
}
