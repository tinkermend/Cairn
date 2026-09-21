import type { ComponentProps } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './dropdown-menu'
import {
  SelectChevron,
  selectItemClassName,
  selectPanelClassName,
  selectTriggerClassName,
} from './select'

type MultiSelectFieldProps = Omit<
  ComponentProps<'button'>,
  'value' | 'onChange' | 'children'
> & {
  value: string[]
  onValueChange: (value: string[]) => void
  options: { value: string; label: string; disabled?: boolean }[]
  placeholder?: string
}

export function MultiSelectField({
  value,
  onValueChange,
  options,
  placeholder = '未选择',
  className,
  disabled,
  ...props
}: MultiSelectFieldProps) {
  const selected = options.filter((option) => value.includes(option.value))
  const label = selected.map((option) => option.label).join('、')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          {...props}
          type='button'
          disabled={disabled}
          data-size='default'
          className={cn(selectTriggerClassName, 'w-full', className)}
        >
          <span className='min-w-0 truncate' title={label || undefined}>
            {label || (value.length ? `已选 ${value.length} 项` : placeholder)}
          </span>
          <SelectChevron />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='start'
        className={cn(
          selectPanelClassName,
          'max-w-(--radix-dropdown-menu-content-available-width) min-w-(--radix-dropdown-menu-trigger-width) motion-reduce:animate-none'
        )}
      >
        {options.length === 0 ? (
          <p className='px-2 py-2 text-sm text-muted-foreground'>暂无可选项</p>
        ) : (
          options.map((option) => (
            <DropdownMenuPrimitive.CheckboxItem
              key={option.value}
              className={selectItemClassName}
              checked={value.includes(option.value)}
              disabled={option.disabled}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onValueChange(
                  checked
                    ? [...value, option.value]
                    : value.filter((item) => item !== option.value)
                )
              }
            >
              <span className='min-w-0 break-words'>{option.label}</span>
              <span className='absolute inset-e-2 flex size-3.5 items-center justify-center'>
                <DropdownMenuPrimitive.ItemIndicator>
                  <CheckIcon className='size-4 text-selection-foreground' />
                </DropdownMenuPrimitive.ItemIndicator>
              </span>
            </DropdownMenuPrimitive.CheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
