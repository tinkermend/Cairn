import type { TargetDescriptor } from '@cairn/shared'
import { TargetFields } from '@/features/authoring/fields/target'

export interface SectionTargetLocatorProps {
  target: TargetDescriptor
  disabled?: boolean
  optional?: boolean
  policy?: { resolution?: any; deepLocate?: boolean }
  onChange: (target: TargetDescriptor) => void
  onPolicyChange?: (policy: { resolution?: any; deepLocate?: boolean }) => void
  forceAdvanced?: boolean
}

export function SectionTargetLocator(props: SectionTargetLocatorProps) {
  return (
    <div data-testid='section-target-locator' className='pt-1'>
      <TargetFields {...props} />
    </div>
  )
}
