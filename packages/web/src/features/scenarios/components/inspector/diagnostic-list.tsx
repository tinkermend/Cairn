import type { CompileDiagnostic } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { useAssistantStore } from '@/stores/assistant-store'
import { buildDiagnosticQuote } from '@/features/assistant/quote-helper'

export interface DiagnosticListProps {
  diagnostics: CompileDiagnostic[]
  onSelect?: (item: CompileDiagnostic) => void
}

export function DiagnosticList({
  diagnostics,
  onSelect,
}: DiagnosticListProps) {
  const setQuote = useAssistantStore((s) => s.setQuote)
  if (diagnostics.length === 0) {
    return <p className='text-small text-muted-foreground'>当前没有编译诊断。</p>
  }
  return (
    <ul className='space-y-2' aria-label='编译诊断'>
      {diagnostics.map((item) => (
        <li
          key={`${item.code}-${item.stepId ?? item.inputKey ?? 'global'}-${item.message}`}
          className='flex items-stretch gap-1.5'
        >
          <button
            type='button'
            className={
              item.severity === 'error'
                ? 'flex-1 rounded-md bg-status-error-background p-3 text-left text-small text-status-error-foreground'
                : 'flex-1 rounded-md bg-status-warning-background p-3 text-left text-small text-status-warning-foreground'
            }
            onClick={() => onSelect?.(item)}
          >
            {item.message}
          </button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='self-center h-8 px-2 text-label text-muted-foreground hover:text-foreground shrink-0'
            title='引用此诊断至识途助手'
            onClick={(e) => {
              e.stopPropagation()
              setQuote(
                buildDiagnosticQuote(
                  item.stepId ?? 'diagnostic',
                  `诊断 [${item.code}]`,
                  item.message,
                  { code: item.code, severity: item.severity, stepId: item.stepId }
                )
              )
            }}
          >
            求助
          </Button>
        </li>
      ))}
    </ul>
  )
}
