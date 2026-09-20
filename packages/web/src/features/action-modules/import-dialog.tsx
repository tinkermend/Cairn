import { useState, useRef } from 'react'
import {
  moduleContentSchema,
  type ModuleContent,
} from '@cairn/shared'
import { AlertCircle, FileUp, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

import type { ModuleTestFixture } from './fixtures-panel'

export type ImportedModuleMeta = {
  name?: string
  description?: string
  capabilityKey?: string
  tags?: string[]
}

export interface ImportModuleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (
    content: ModuleContent,
    meta?: ImportedModuleMeta,
    fixtures?: ModuleTestFixture[]
  ) => void
}

export function ImportModuleDialog({
  open,
  onOpenChange,
  onImport,
}: ImportModuleDialogProps) {
  const [jsonText, setJsonText] = useState('')
  const [errorDetails, setErrorDetails] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result
      if (typeof content === 'string') {
        setJsonText(content)
        setErrorDetails([])
      }
    }
    reader.readAsText(file)
  }

  const handleValidateAndImport = () => {
    setErrorDetails([])
    if (!jsonText.trim()) {
      setErrorDetails(['请输入或上传有效的 JSON 文本'])
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      setErrorDetails([`JSON 语法解析失败: ${e instanceof Error ? e.message : '非法的 JSON 格式'}`])
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      setErrorDetails(['导入的内容必须是标准的 JSON 对象'])
      return
    }

    const rawObj = parsed as Record<string, unknown>
    // 兼容外层包裹结构或平铺结构
    const candidateContent = (rawObj.content ?? {
      contract: rawObj.contract,
      implementations: rawObj.implementations,
    }) as Record<string, unknown>

    if (
      candidateContent?.contract &&
      typeof candidateContent.contract === 'object' &&
      'effectCeiling' in candidateContent.contract &&
      typeof (candidateContent.contract as Record<string, unknown>).effectCeiling === 'string'
    ) {
      const contract = { ...(candidateContent.contract as Record<string, unknown>) }
      contract.effectCeiling = String(contract.effectCeiling).toUpperCase()
      candidateContent.contract = contract
    }

    const result = moduleContentSchema.safeParse(candidateContent)
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue) => `[${issue.path.join('.') || 'root'}] ${issue.message}`
      )
      setErrorDetails(errors)
      return
    }

    const meta: ImportedModuleMeta = {}
    if (typeof rawObj.name === 'string' && rawObj.name.trim()) {
      meta.name = rawObj.name.trim()
    }
    if (typeof rawObj.description === 'string') {
      meta.description = rawObj.description.trim()
    }
    if (typeof rawObj.capabilityKey === 'string') {
      meta.capabilityKey = rawObj.capabilityKey.trim()
    }
    if (Array.isArray(rawObj.tags)) {
      meta.tags = rawObj.tags.filter((t): t is string => typeof t === 'string')
    }

    const fixtures = Array.isArray(rawObj.fixtures)
      ? (rawObj.fixtures as ModuleTestFixture[])
      : undefined

    if (fixtures && fixtures.length > 0) {
      onImport(
        result.data,
        Object.keys(meta).length > 0 ? meta : undefined,
        fixtures
      )
    } else {
      onImport(result.data, Object.keys(meta).length > 0 ? meta : undefined)
    }
    onOpenChange(false)
    setJsonText('')
    setErrorDetails([])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Upload className='size-4 text-primary' />
            导入动作模块定义
          </DialogTitle>
          <DialogDescription>
            支持从导出的 JSON 文件或备份中恢复模块契约与步骤编排。导入将替换当前工作区草稿。
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-3.5'>
          <div className='flex items-center justify-between'>
            <label
              htmlFor='import-module-json-textarea'
              className='text-small font-medium text-foreground'
            >
              JSON 内容定义
            </label>
            <div className='flex items-center gap-2'>
              <input
                ref={fileInputRef}
                type='file'
                accept='.json,application/json'
                className='hidden'
                onChange={handleFileUpload}
              />
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='h-7 gap-1.5 text-label'
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className='size-3.5' />
                上传 JSON 文件
              </Button>
            </div>
          </div>

          <Textarea
            id='import-module-json-textarea'
            aria-label='JSON 内容定义'
            placeholder='粘贴导出的动作模块 JSON 内容...'
            rows={10}
            className='font-mono text-small'
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value)
              if (errorDetails.length > 0) setErrorDetails([])
            }}
          />

          {errorDetails.length > 0 && (
            <div
              role='alert'
              className='max-h-40 space-y-1 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-small text-destructive'
            >
              <div className='flex items-center gap-1.5 font-medium'>
                <AlertCircle className='size-4 shrink-0' />
                <span>JSON 校验未通过 ({errorDetails.length} 项问题)</span>
              </div>
              <ul className='list-inside list-disc space-y-0.5 ps-1 text-label'>
                {errorDetails.slice(0, 8).map((err, i) => (
                  <li key={i} className='truncate font-mono'>
                    {err}
                  </li>
                ))}
                {errorDetails.length > 8 && (
                  <li className='text-muted-foreground'>
                    ...还有 {errorDetails.length - 8} 项问题未列出
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className='gap-2 sm:gap-0'>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type='button' onClick={handleValidateAndImport}>
            校验并应用至草稿
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
