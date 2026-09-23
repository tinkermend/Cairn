import type { ExecutableStepType } from '@cairn/shared'
import {
  AlertCircle,
  Clock,
  Compass,
  Download,
  FileText,
  Keyboard,
  ListFilter,
  MessageSquare,
  MousePointerClick,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
  Upload,
} from 'lucide-react'

export interface StepTypeIconProps {
  type: ExecutableStepType | string
  className?: string
}

export function StepTypeIcon({ type, className = 'size-3.5 shrink-0' }: StepTypeIconProps) {
  switch (type) {
    case 'navigate':
      return <Compass className={className} />
    case 'click':
      return <MousePointerClick className={className} />
    case 'fill':
      return <TextCursorInput className={className} />
    case 'select':
      return <ListFilter className={className} />
    case 'keyboard':
      return <Keyboard className={className} />
    case 'wait':
    case 'delay':
      return <Clock className={className} />
    case 'assert':
      return <ShieldCheck className={className} />
    case 'extract':
      return <FileText className={className} />
    case 'ai_action':
    case 'ai_extract':
    case 'ai_assert':
      return <Sparkles className={className} />
    case 'download':
      return <Download className={className} />
    case 'upload':
      return <Upload className={className} />
    case 'echo':
      return <MessageSquare className={className} />
    case 'fail':
      return <AlertCircle className={className} />
    default:
      return <FileText className={className} />
  }
}
