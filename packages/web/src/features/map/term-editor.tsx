import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TerminologyEntry } from '@cairn/shared'
import { updateMapTerm, retireMapTerm } from '@/lib/map-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KnowledgeSources } from './knowledge-sources'

export function TermEditor({
  term,
  canReview,
}: {
  term: TerminologyEntry
  canReview: boolean
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(term.canonicalName)
  const [aliases, setAliases] = useState(term.aliases.join('，'))
  const [meaning, setMeaning] = useState(term.meaning)
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: (action: 'save' | 'confirm' | 'retire') =>
      action === 'retire'
        ? retireMapTerm(term.targetId, term.termId, {
            expectedRevision: term.revision,
            reason: reason.trim(),
          })
        : updateMapTerm(term.targetId, term.termId, {
            expectedRevision: term.revision,
            canonicalName: name.trim(),
            aliases: aliases
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
            meaning: meaning.trim(),
            termStatus: action === 'confirm' ? 'confirmed' : undefined,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['map', term.targetId, 'terms'],
      })
      setOpen(false)
    },
  })
  const writable = canReview && term.termStatus !== 'retired'
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (mutation.isPending) return
        setOpen(value)
        if (value) {
          setName(term.canonicalName)
          setAliases(term.aliases.join('，'))
          setMeaning(term.meaning)
          setReason('')
          mutation.reset()
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size='sm' variant='outline'>
          查看术语
        </Button>
      </DialogTrigger>
      <DialogContent className='max-h-[85vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>
            {term.canonicalName} · r{term.revision}
          </DialogTitle>
        </DialogHeader>
        <div className='space-y-3'>
          <Label htmlFor={`term-name-${term.termId}`}>规范名称</Label>
          <Input
            id={`term-name-${term.termId}`}
            maxLength={128}
            value={name}
            disabled={!writable || mutation.isPending}
            onChange={(e) => setName(e.target.value)}
          />
          <Label htmlFor={`term-alias-${term.termId}`}>别名（逗号分隔）</Label>
          <Input
            id={`term-alias-${term.termId}`}
            value={aliases}
            disabled={!writable || mutation.isPending}
            onChange={(e) => setAliases(e.target.value)}
          />
          <Label htmlFor={`term-meaning-${term.termId}`}>业务含义</Label>
          <Input
            id={`term-meaning-${term.termId}`}
            maxLength={2048}
            value={meaning}
            disabled={!writable || mutation.isPending}
            onChange={(e) => setMeaning(e.target.value)}
          />
          {term.conditionSnapshot ? (
            <details>
              <summary>适用条件与未知项</summary>
              <pre className='overflow-auto text-small break-all whitespace-pre-wrap'>
                {JSON.stringify(term.conditionSnapshot, null, 2)}
              </pre>
            </details>
          ) : (
            <p className='text-small text-muted-foreground'>
              未登记适用条件，不能据此证明任意条件下都适用。
            </p>
          )}
          <KnowledgeSources targetId={term.targetId} sources={term.sources} />
          {mutation.isError ? (
            <p role='alert' className='text-small text-destructive'>
              {mutation.error.message}。输入已保留。
            </p>
          ) : null}
          {writable ? (
            <>
              <div className='flex flex-wrap gap-2'>
                <Button
                  disabled={
                    !name.trim() || !meaning.trim() || mutation.isPending
                  }
                  loading={mutation.isPending}
                  onClick={() => mutation.mutate('save')}
                >
                  保存修改
                </Button>
                {term.termStatus === 'candidate' ? (
                  <Button
                    variant='outline'
                    disabled={
                      !name.trim() || !meaning.trim() || mutation.isPending
                    }
                    onClick={() => mutation.mutate('confirm')}
                  >
                    确认术语
                  </Button>
                ) : null}
              </div>
              <Label htmlFor={`term-reason-${term.termId}`}>退役原因</Label>
              <Input
                id={`term-reason-${term.termId}`}
                maxLength={512}
                value={reason}
                disabled={mutation.isPending}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                variant='outline'
                disabled={!reason.trim() || mutation.isPending}
                onClick={() => mutation.mutate('retire')}
              >
                退役术语
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
