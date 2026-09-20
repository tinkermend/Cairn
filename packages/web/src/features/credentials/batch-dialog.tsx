import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  CredentialBatch,
  CredentialBatchCreateBody,
  CredentialListItem,
  CredentialValidityWrite,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import {
  createCredentialBatch,
  fetchCredential,
  fetchCredentialBatch,
  resolveCredentialImport,
  submitCredentialBatchItem,
} from '@/lib/credentials-api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PasswordInput } from '@/components/password-input'
import { StatusBadge } from '@/components/status-badge'
import {
  downloadExcel,
  guessMapping,
  IMPORT_FIELDS,
  mappedRows,
  templateRows,
  type ExcelBook,
  type ImportMapping,
} from './excel'
import { credentialRequestId } from './id'
import {
  defaultValidityFields,
  toValidityWrite,
  ValidityInput,
  validityPreview,
  localDateTime,
  type ValidityFormFields,
} from './validity-fields'

type CredentialBatchItem = CredentialBatch['items'][number]

type Row = {
  key: string
  line: number
  item: CredentialListItem | null
  label: string
  password: string
  validity: ValidityFormFields
  selected: boolean
  error?: string
  receipt?: CredentialBatchItem
  unknown?: boolean
  skip?: boolean
  startedAt?: string
  passwordJob?: boolean
}
type Job = {
  body: CredentialBatchCreateBody
  batchId?: string
  rowKeys: string[]
}
type StorageJob = {
  batchId?: string
  body?: CredentialBatchCreateBody
  lines?: { itemId: string; line: number }[]
}
const rowOf = (item: CredentialListItem, line: number): Row => ({
  key: credentialRequestId(),
  line,
  item,
  label: `${item.target?.name ?? item.subjectLabel} · ${item.name} · ${item.safeIdentifier}`,
  password: '',
  validity: defaultValidityFields(item.validityPolicy),
  selected: true,
})
const describeError = (e: unknown) =>
  e instanceof ApiRequestError || e instanceof Error
    ? e.message
    : '请求未完成，请稍后查询结果'

export function BatchDialog({
  open,
  onOpenChange,
  items,
  source = 'selection',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: CredentialListItem[]
  source?: 'selection' | 'excel'
}) {
  const client = useQueryClient()
  const userId = useAuthStore((s) => s.auth.user?.id)
  const storageKey = `credential-batch-receipts:${userId}`
  const [rows, setRows] = useState<Row[]>(() =>
    items
      .filter((i) => i.capabilities.canReplace)
      .map((item, index) => rowOf(item, index + 1))
  )
  const [kind, setKind] = useState<'password_replace' | 'metadata'>(
    'password_replace'
  )
  const [phase, setPhase] = useState<'edit' | 'preview' | 'results'>('edit')
  const [busy, setBusy] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [resumable, setResumable] = useState(false)
  const [recoveringPending, setRecoveringPending] = useState(false)
  const [uncertainRegistration, setUncertainRegistration] = useState(false)
  const [error, setError] = useState('')
  const [book, setBook] = useState<ExcelBook | null>(null)
  const [sheet, setSheet] = useState('0')
  const [mapping, setMapping] = useState<ImportMapping>({})
  const [defaultTargetCode, setDefaultTargetCode] = useState('')
  const [common, setCommon] = useState(defaultValidityFields())
  const [applyCommon, setApplyCommon] = useState(false)
  const [page, setPage] = useState(0)
  const [savedJobs, setSavedJobs] = useState<StorageJob[]>(() => {
    try {
      const parsed: unknown = JSON.parse(
        sessionStorage.getItem(storageKey) ?? '[]'
      )
      return Array.isArray(parsed)
        ? parsed.filter(
            (r): r is StorageJob =>
              r &&
              (typeof r.batchId === 'string' ||
                typeof r.body?.idempotencyKey === 'string')
          )
        : []
    } catch {
      return []
    }
  })
  const jobs = useRef<Job[]>([])
  const worker = useRef<Worker | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopped = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stopped.current = true
      worker.current?.terminate()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  const update = (key: string, patch: Partial<Row>) =>
    setRows((old) =>
      old.map((row) => (row.key === key ? { ...row, ...patch } : row))
    )
  const accepted = rows.filter((r) => r.selected && r.item && !r.error)
  const close = () => {
    if (!busy) {
      setRows([])
      setBook(null)
      jobs.current = []
      onOpenChange(false)
    }
  }
  const remember = (batchId: string | undefined, job: Job) =>
    setSavedJobs((old) => {
      const next = [
        ...old.filter(
          (x) =>
            x.body?.idempotencyKey !== job.body.idempotencyKey &&
            (!batchId || x.batchId !== batchId)
        ),
        {
          batchId,
          body: job.body,
          lines: job.body.items.map((item, i) => ({
            itemId: item.itemId,
            line: rows.find((r) => r.key === job.rowKeys[i])?.line ?? i + 1,
          })),
        },
      ].slice(-20)
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        /* Receipt remains available in this workspace. */
      }
      return next
    })
  const applyReceipts = (batch: CredentialBatch, job: Job) => {
    setRows((old) =>
      old.map((row) => {
        const index = job.rowKeys.indexOf(row.key)
        if (index < 0) return row
        const receipt = batch.items.find(
          (i) => i.itemId === job.body.items[index]?.itemId
        )
        if (!receipt) return row
        return {
          ...row,
          receipt,
          unknown: false,
          ...(receipt.status === 'succeeded' ? { password: '' } : {}),
          ...(receipt.credentialId === null
            ? { item: null, label: '账号不存在或已无权限', password: '' }
            : {}),
        }
      })
    )
  }
  const readFile = async (file?: File) => {
    if (!file) return
    setError('')
    setBook(null)
    setRows([])
    jobs.current = []
    if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
      setError('请选择不超过 5 MiB 的 .xlsx 文件')
      return
    }
    setBusy(true)
    try {
      const bytes = await file.arrayBuffer()
      const w = new Worker(new URL('./excel.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.current = w
      setParsing(true)
      const stop = () => {
        w.terminate()
        worker.current = null
        if (timer.current) clearTimeout(timer.current)
        setBusy(false)
        setParsing(false)
      }
      timer.current = setTimeout(() => {
        stop()
        setError('解析超过 10 秒，已停止；请拆分文件后重试')
      }, 10_000)
      w.onerror = () => {
        stop()
        setError('工作簿读取失败，请检查文件格式')
      }
      w.onmessage = (
        event: MessageEvent<{ book?: ExcelBook; error?: string }>
      ) => {
        stop()
        if (event.data.book) {
          setBook(event.data.book)
          setSheet('0')
          setMapping(guessMapping(event.data.book.sheets[0]!))
        } else setError(event.data.error ?? '工作簿读取失败')
      }
      w.postMessage(bytes, [bytes])
    } catch {
      setBusy(false)
      setError('无法读取所选文件')
    }
  }
  const match = async () => {
    if (!book) return
    setBusy(true)
    setError('')
    try {
      const imported = mappedRows(
        book.sheets[Number(sheet)]!,
        mapping,
        defaultTargetCode
      )
      if (!imported.length) throw new Error('工作表没有数据行')
      const candidates = imported.filter((r) => !r.error && !r.skip)
      const result = candidates.length
        ? await resolveCredentialImport({
            version: 1,
            rows: candidates.map((r) => r.match),
          })
        : { rows: [] }
      setRows(
        imported.map((row) => {
          const found = result.rows.find((r) => r.row === row.row)
          const item = found?.item ?? null
          let error = row.error || found?.error || ''
          let validity = defaultValidityFields(item?.validityPolicy)
          if (row.values.mode) {
            const mode = (
              {
                days: 'days',
                天: 'days',
                months: 'months',
                月: 'months',
                permanent: 'permanent',
                永久: 'permanent',
              } as Record<string, ValidityFormFields['validityMode']>
            )[row.values.mode]
            if (!mode)
              error ||=
                '有效期单位须为 days / months / permanent 或天 / 月 / 永久'
            else
              validity = {
                validityMode: mode,
                validityAmount: row.values.amount ?? '',
                validityTimeZone:
                  row.values.timeZone ?? validity.validityTimeZone,
              }
          } else if (row.values.amount || row.values.timeZone)
            error ||= '填写有效期数量或时区时，请同时填写单位'
          return {
            ...(item
              ? rowOf(item, row.row)
              : {
                  key: credentialRequestId(),
                  line: row.row,
                  label: `第 ${row.row} 行：${row.values.targetCode ?? ''} · ${row.values.username ?? ''}`,
                }),
            item,
            password: row.values.password ?? '',
            skip: row.skip,
            startedAt: row.values.startedAt
              ? new Date(row.values.startedAt).toISOString()
              : undefined,
            validity,
            selected: !error && !!item,
            error,
          }
        })
      )
      setPage(0)
      setBook(null)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const preview = async () => {
    setError('')
    setBusy(true)
    try {
      const selected = rows.filter((r) => r.selected)
      if (!selected.length || selected.length > 1000)
        throw new Error('请选择 1–1000 个账号')
      const next = [...rows]
      for (const row of selected) {
        if (row.error || !row.item)
          throw new Error(`第 ${row.line} 行：${row.error || '未匹配账号'}`)
        if (
          kind === 'password_replace' &&
          (!row.password.length || row.password.length > 256)
        )
          throw new Error(`第 ${row.line} 行：请填写 1–256 字符的新密码`)
        try {
          toValidityWrite(applyCommon ? common : row.validity)
        } catch {
          throw new Error(`第 ${row.line} 行：请设置有效期或选择永久`)
        }
        if (
          row.startedAt &&
          (!Number.isFinite(Date.parse(row.startedAt)) ||
            Date.parse(row.startedAt) > Date.now())
        )
          throw new Error(`第 ${row.line} 行：起算时间不能晚于当前时间`)
        const current = await fetchCredential(row.item.id)
        if (
          !current.capabilities.canReplace ||
          (source === 'excel' && !current.capabilities.canImport)
        )
          throw new Error(`第 ${row.line} 行：账号已无维护权限`)
        if (current.revision !== row.item.revision)
          throw new Error(
            `第 ${row.line} 行：账号已被更新，请重新加载或重新导入后核对`
          )
        next[next.findIndex((r) => r.key === row.key)] = {
          ...row,
          item: current,
          validity: applyCommon ? { ...common } : row.validity,
        }
      }
      setRows(next)
      setPhase('preview')
      setPage(0)
      if (!recoveringPending) jobs.current = []
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    setResumable(true)
    setBusy(true)
    stopped.current = false
    setError('')
    setPhase('results')
    setPage(0)
    try {
      if (!jobs.current.length) {
        const chosen = rows.filter(
          (r) =>
            r.selected &&
            r.item &&
            !r.error &&
            r.receipt?.status !== 'succeeded'
        )
        const limit = kind === 'password_replace' ? 50 : 200
        for (let offset = 0; offset < chosen.length; offset += limit) {
          const chunk = chosen.slice(offset, offset + limit)
          jobs.current.push({
            rowKeys: chunk.map((r) => r.key),
            body: {
              kind,
              source,
              idempotencyKey: credentialRequestId(),
              items: chunk.map((r) => ({
                itemId: credentialRequestId(),
                credentialId: r.item!.id,
                targetId: r.item!.targetId!,
                targetAccountId: r.item!.targetAccountId!,
                expectedRevision: r.item!.revision,
                ...(kind === 'metadata'
                  ? {
                      validity: toValidityWrite(r.validity),
                      ...(!r.item!.validityStartedAt &&
                      r.validity.validityMode !== 'permanent'
                        ? { startedAt: new Date().toISOString() }
                        : {}),
                    }
                  : {}),
              })),
            },
          })
        }
      }
      for (const job of jobs.current) {
        if (stopped.current || !mounted.current) break
        let batch: CredentialBatch
        try {
          remember(job.batchId, job)
          batch =
            job.batchId && job.body.kind !== 'metadata'
              ? await fetchCredentialBatch(job.batchId)
              : await createCredentialBatch(job.body)
          job.batchId = batch.batchId
          setUncertainRegistration(false)
          remember(batch.batchId, job)
          applyReceipts(batch, job)
        } catch (e) {
          setUncertainRegistration(true)
          setError(
            `批次登记或查询失败：${describeError(e)}。可使用“查询并继续”恢复，不会生成重复批次。`
          )
          break
        }
        if (job.body.kind === 'metadata') continue
        for (const [index, key] of job.rowKeys.entries()) {
          if (stopped.current || !mounted.current) break
          const itemId = job.body.items[index]!.itemId
          if (
            batch.items.find((i) => i.itemId === itemId)?.status === 'succeeded'
          )
            continue
          const row = rows.find((r) => r.key === key)
          if (!row || !row.selected) continue
          if (!row.password) {
            update(key, { error: '请补填密码后继续原批次' })
            continue
          }
          try {
            const validity: CredentialValidityWrite = {
              ...toValidityWrite(row.validity),
              ...(row.startedAt ? { startedAt: row.startedAt } : {}),
            }
            batch = await submitCredentialBatchItem(batch.batchId, itemId, {
              idempotencyKey: itemId,
              password: row.password,
              validity,
            })
            applyReceipts(batch, job)
          } catch (e) {
            if (e instanceof ApiRequestError && e.status < 500)
              update(key, { error: e.message })
            else {
              update(key, { unknown: true })
              try {
                batch = await fetchCredentialBatch(batch.batchId)
                applyReceipts(batch, job)
              } catch {
                /* Keep uncertain status for explicit reconciliation. */
              }
            }
          }
        }
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ['credentials'] }),
        client.invalidateQueries({ queryKey: ['target'] }),
      ])
    } finally {
      setBusy(false)
    }
  }
  const recover = async () => {
    setBusy(true)
    setError('')
    try {
      const restored: Row[] = []
      const restoredJobs: Job[] = []
      for (const job of savedJobs) {
        const batch = job.batchId
          ? await fetchCredentialBatch(job.batchId)
          : job.body
            ? await createCredentialBatch(job.body)
            : null
        if (!batch) continue
        const rowKeys: string[] = []
        const body: CredentialBatchCreateBody = job.body ?? {
          kind: batch.kind,
          source,
          idempotencyKey: credentialRequestId(),
          items: batch.items
            .filter((i) => i.credentialId)
            .map((i) => ({
              itemId: i.itemId,
              credentialId: i.credentialId!,
              expectedRevision: i.expectedRevision,
            })),
        }
        // Persisted work plans contain identifiers and maintenance metadata only.
        // Passwords are always re-entered after closing this workspace.
        const receipts = body.items
          .map((i) => batch.items.find((r) => r.itemId === i.itemId))
          .filter((r): r is CredentialBatchItem => !!r)
        for (const receipt of receipts) {
          let item: CredentialListItem | null = null
          if (receipt.credentialId) {
            try {
              item = await fetchCredential(receipt.credentialId)
            } catch {
              /* Access may have changed. */
            }
          }
          const restoredRow: Row = {
            ...(item
              ? rowOf(item, restored.length + 1)
              : {
                  key: credentialRequestId(),
                  line: restored.length + 1,
                  label: '账号不存在或已无权限',
                }),
            item,
            password: '',
            line:
              job.lines?.find((l) => l.itemId === receipt.itemId)?.line ??
              restored.length + 1,
            selected: false,
            validity: defaultValidityFields(item?.validityPolicy),
            receipt,
            passwordJob: batch.kind === 'password_replace',
          }
          rowKeys.push(restoredRow.key)
          restored.push(restoredRow)
        }
        restoredJobs.push({ body, batchId: batch.batchId, rowKeys })
      }
      setRows(restored)
      jobs.current = restoredJobs
      setResumable(restoredJobs.length > 0)
      setUncertainRegistration(false)
      setPhase('results')
      setPage(0)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const success = rows.filter((r) => r.receipt?.status === 'succeeded').length
  const downloadReport = async () => {
    setBusy(true)
    setError('')
    try {
      const report: string[][] = [['行号', '账号', '状态', '错误原因']]
      for (const row of rows) {
        let readable = !row.item
        if (row.item) {
          try {
            await fetchCredential(row.item.id)
            readable = true
          } catch {
            readable = false
          }
        }
        report.push([
          String(row.line),
          readable ? row.label : '对象已不可访问',
          readable
            ? (row.receipt?.status ?? (row.unknown ? '结果待确认' : '未提交'))
            : '不可访问',
          readable ? (row.receipt?.errorMessage ?? row.error ?? '') : '',
        ])
      }
      downloadExcel(report, '凭据更新结果.xlsx')
    } catch {
      setError('结果下载失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  const failed = rows.filter(
    (r) =>
      r.receipt?.status === 'failed' ||
      r.receipt?.status === 'conflict' ||
      r.error
  ).length
  const pageRows = rows.slice(page * 20, page * 20 + 20)
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close()
      }}
    >
      <DialogContent className='flex max-h-[92vh] w-[96vw] flex-col gap-4 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-7xl'>
        <DialogHeader>
          <DialogTitle>
            {source === 'excel' ? 'Excel 批量更新账号凭据' : '批量维护账号凭据'}
          </DialogTitle>
          <DialogDescription>
            {phase === 'edit'
              ? '选择 / 导入账号 → 编辑内容 → 预览确认 → 查看逐条结果'
              : phase === 'preview'
                ? '核对账号与有效期后提交。保存本平台密码，不会修改目标系统上的密码。'
                : '逐条保存，成功项不会重复执行；失败项可保留输入后重新处理。'}
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 space-y-4 overflow-y-auto'>
          {phase === 'edit' && (
            <>
              <div className='flex flex-wrap items-center gap-3'>
                {source === 'selection' && (
                  <Select
                    value={kind}
                    onValueChange={(v) => setKind(v as typeof kind)}
                  >
                    <SelectTrigger className='w-52' aria-label='批量维护内容'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='password_replace'>
                        更新密码及有效期
                      </SelectItem>
                      <SelectItem value='metadata'>仅设置有效期</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {source === 'excel' && (
                  <label className='flex flex-wrap items-center gap-2 text-label'>
                    选择 .xlsx 文件
                    <Input
                      aria-label='上传 Excel'
                      type='file'
                      accept='.xlsx'
                      className='w-64'
                      disabled={busy}
                      onChange={(e) => {
                        void readFile(e.target.files?.[0])
                        e.target.value = ''
                      }}
                    />
                  </label>
                )}
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    setError('')
                    try {
                      const fresh = []
                      for (const i of items) {
                        const current = await fetchCredential(i.id)
                        if (!current.capabilities.canImport)
                          throw new Error('所选账号已无导入权限')
                        fresh.push(current)
                      }
                      downloadExcel(
                        templateRows(fresh),
                        '账号凭据更新模板.xlsx'
                      )
                    } catch (e) {
                      setError(describeError(e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  下载{items.length ? '所选账号' : ''}模板
                </Button>
                {savedJobs.length > 0 && (
                  <Button
                    variant='ghost'
                    disabled={busy}
                    onClick={() => void recover()}
                  >
                    查看最近提交结果
                  </Button>
                )}
              </div>
              {parsing && (
                <Button
                  variant='outline'
                  onClick={() => {
                    worker.current?.terminate()
                    worker.current = null
                    if (timer.current) clearTimeout(timer.current)
                    setBusy(false)
                    setParsing(false)
                    setBook(null)
                    setError('解析已取消')
                  }}
                >
                  取消解析
                </Button>
              )}
              {source === 'excel' && (
                <p className='text-label text-muted-foreground'>
                  最多 1000 行、5
                  MiB。账号和密码列须为文本；支持选择工作表、自定义列名，密码中的空格会保留。
                </p>
              )}
              {source === 'excel' && (
                <label className='block space-y-2'>
                  <span className='text-label'>
                    整表默认目标系统编码（可选）
                  </span>
                  <Input
                    className='max-w-sm'
                    placeholder='所有行属于同一系统时填写'
                    value={defaultTargetCode}
                    onChange={(e) => setDefaultTargetCode(e.target.value)}
                  />
                </label>
              )}
              {book && (
                <div className='space-y-4 rounded-md border border-border-divider p-4'>
                  <Select
                    value={sheet}
                    onValueChange={(v) => {
                      setSheet(v)
                      setMapping(guessMapping(book.sheets[Number(v)]!))
                    }}
                  >
                    <SelectTrigger className='w-64' aria-label='工作表'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {book.sheets.map((s, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {s.name}（{Math.max(s.rows.length - 1, 0)} 行）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className='grid gap-3 sm:grid-cols-3'>
                    {IMPORT_FIELDS.map((field) => (
                      <label key={field.key} className='space-y-2'>
                        <span className='text-label'>{field.label}</span>
                        <Select
                          value={
                            mapping[field.key] === undefined
                              ? 'none'
                              : String(mapping[field.key])
                          }
                          onValueChange={(v) =>
                            setMapping((old) => {
                              const next = { ...old }
                              if (v === 'none') delete next[field.key]
                              else next[field.key] = Number(v)
                              return next
                            })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='none'>不使用</SelectItem>
                            {book.sheets[Number(sheet)]?.rows[0]?.cells.map(
                              (cell, index) => (
                                <SelectItem key={index} value={String(index)}>
                                  第 {index + 1} 列：{cell?.text || '空列名'}
                                </SelectItem>
                              )
                            )}
                          </SelectContent>
                        </Select>
                      </label>
                    ))}
                  </div>
                  <Button loading={busy} onClick={() => void match()}>
                    匹配账号并校验权限
                  </Button>
                </div>
              )}
              {rows.length > 0 && (
                <div className='space-y-3 rounded-md border border-border-divider p-4'>
                  <label className='flex items-center gap-2 text-label'>
                    <Checkbox
                      checked={applyCommon}
                      onCheckedChange={(v) => setApplyCommon(v === true)}
                    />
                    为所选账号统一设置有效期
                  </label>
                  {applyCommon ? (
                    <ValidityInput value={common} onChange={setCommon} />
                  ) : (
                    <p className='text-label text-muted-foreground'>
                      继承各账号当前有效期；未设置的账号需逐条填写或使用统一设置。
                    </p>
                  )}
                  {kind === 'metadata' && (
                    <p className='text-label text-muted-foreground'>
                      保留已有起算时间。尚无起算时间的账号将从提交时开始计算。
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {phase === 'results' && (
            <div aria-live='polite' className='flex flex-wrap gap-4'>
              <span>成功 {success}</span>
              <span>失败 / 冲突 {failed}</span>
              <span>待提交 / 待确认 {rows.length - success - failed}</span>
            </div>
          )}
          {rows.length > 0 && (
            <div className='rounded-md border border-border-divider'>
              <Table>
                <TableHeader>
                  <TableRow>
                    {phase === 'edit' && <TableHead>选择</TableHead>}
                    <TableHead>行</TableHead>
                    <TableHead>所属目标系统</TableHead>
                    <TableHead>账号名称 / 登录名</TableHead>
                    {kind === 'password_replace' && (
                      <TableHead>新密码</TableHead>
                    )}
                    <TableHead>有效期</TableHead>
                    <TableHead>起算 / 到期时间</TableHead>
                    <TableHead>
                      {phase === 'results' ? '保存结果' : '校验'}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((row) => (
                    <TableRow key={row.key}>
                      {phase === 'edit' && (
                        <TableCell>
                          <Checkbox
                            aria-label={`选择第${row.line}行`}
                            checked={row.selected}
                            disabled={!row.item || !!row.error}
                            onCheckedChange={(v) =>
                              update(row.key, { selected: v === true })
                            }
                          />
                        </TableCell>
                      )}
                      <TableCell>{row.line}</TableCell>
                      <TableCell className='min-w-44'>
                        <span>{row.item?.target?.name ?? '未匹配目标'}</span>
                        <p className='text-label text-muted-foreground'>
                          {row.item?.target?.code}
                        </p>
                      </TableCell>
                      <TableCell className='min-w-48'>
                        <span>{row.item?.name ?? row.label}</span>
                        <p className='text-label text-muted-foreground'>
                          {row.item?.safeIdentifier}
                        </p>
                      </TableCell>
                      {kind === 'password_replace' && (
                        <TableCell className='min-w-48'>
                          {phase === 'edit' ? (
                            <PasswordInput
                              aria-label={`第${row.line}行新密码`}
                              autoComplete='new-password'
                              value={row.password}
                              maxLength={256}
                              onChange={(e) =>
                                update(row.key, { password: e.target.value })
                              }
                            />
                          ) : row.receipt?.status === 'succeeded' ? (
                            '已保存并清空输入'
                          ) : row.password ? (
                            '••••••••'
                          ) : (
                            '未保留密码'
                          )}
                        </TableCell>
                      )}
                      <TableCell className='min-w-44'>
                        {phase === 'edit' && !applyCommon ? (
                          <div className='flex items-center gap-2'>
                            <Select
                              value={row.validity.validityMode}
                              onValueChange={(v) =>
                                update(row.key, {
                                  validity: {
                                    ...row.validity,
                                    validityMode:
                                      v as ValidityFormFields['validityMode'],
                                  },
                                })
                              }
                            >
                              <SelectTrigger
                                aria-label={`第${row.line}行有效期`}
                                className='w-24'
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value='days'>天</SelectItem>
                                <SelectItem value='months'>月</SelectItem>
                                <SelectItem value='permanent'>永久</SelectItem>
                              </SelectContent>
                            </Select>
                            {row.validity.validityMode !== 'permanent' && (
                              <Input
                                aria-label={`第${row.line}行有效期数量`}
                                className='w-20'
                                inputMode='numeric'
                                value={row.validity.validityAmount}
                                onChange={(e) =>
                                  update(row.key, {
                                    validity: {
                                      ...row.validity,
                                      validityAmount: e.target.value,
                                    },
                                  })
                                }
                              />
                            )}
                          </div>
                        ) : (phase === 'edit' && applyCommon
                            ? common
                            : row.validity
                          ).validityMode === 'permanent' ? (
                          '永久'
                        ) : (
                          `${(phase === 'edit' && applyCommon ? common : row.validity).validityAmount || '未设置'} ${(phase === 'edit' && applyCommon ? common : row.validity).validityMode === 'days' ? '天' : '个月'}`
                        )}
                      </TableCell>
                      <TableCell className='min-w-56'>
                        {phase === 'edit' && kind === 'password_replace' && (
                          <Input
                            aria-label={`第${row.line}行起算时间`}
                            type='datetime-local'
                            value={localDateTime(row.startedAt)}
                            onChange={(e) =>
                              update(row.key, {
                                startedAt: e.target.value
                                  ? new Date(e.target.value).toISOString()
                                  : undefined,
                              })
                            }
                          />
                        )}
                        <p className='text-label text-muted-foreground'>
                          {row.startedAt ||
                          (kind === 'metadata' && row.item?.validityStartedAt)
                            ? validityPreview(
                                phase === 'edit' && applyCommon
                                  ? common
                                  : row.validity,
                                row.startedAt ?? row.item?.validityStartedAt
                              )
                            : '从成功保存时起算'}
                        </p>
                      </TableCell>
                      <TableCell className='min-w-48'>
                        {row.unknown ? (
                          <StatusBadge tone='warning'>结果待确认</StatusBadge>
                        ) : row.receipt ? (
                          <>
                            <StatusBadge
                              tone={
                                row.receipt.status === 'succeeded'
                                  ? 'success'
                                  : row.receipt.status === 'pending_material'
                                    ? 'neutral'
                                    : 'error'
                              }
                            >
                              {
                                {
                                  succeeded: '保存成功',
                                  failed: '保存失败',
                                  conflict: '版本冲突',
                                  pending_material: '待提交',
                                }[row.receipt.status]
                              }
                            </StatusBadge>
                            <p className='mt-1 text-label text-destructive'>
                              {row.receipt.errorMessage}
                            </p>
                          </>
                        ) : (
                          <span
                            className={
                              row.error
                                ? 'text-destructive'
                                : 'text-muted-foreground'
                            }
                          >
                            {row.error ||
                              (row.skip ? '空密码，跳过更新' : '') ||
                              (row.selected ? '已匹配' : '不提交')}
                          </span>
                        )}
                        {row.receipt && row.error && (
                          <p className='text-label text-destructive'>
                            {row.error}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className='flex items-center justify-between border-t border-border-divider p-3'>
                <span className='text-label'>
                  共 {rows.length} 行 · 已选 {accepted.length} 行
                </span>
                <div className='flex items-center gap-3'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={page === 0}
                    onClick={() => setPage((v) => v - 1)}
                  >
                    上一页
                  </Button>
                  <span className='text-label'>第 {page + 1} 页</span>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={(page + 1) * 20 >= rows.length}
                    onClick={() => setPage((v) => v + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </div>
          )}
          {error && (
            <p role='alert' className='text-label text-destructive'>
              {error}
            </p>
          )}
        </div>
        <div className='flex flex-wrap justify-end gap-2 border-t border-border-divider pt-4'>
          <Button variant='outline' disabled={busy} onClick={close}>
            关闭
          </Button>
          {phase === 'edit' && (
            <Button
              loading={busy}
              disabled={!accepted.length || !!book}
              onClick={() => void preview()}
            >
              预览 {accepted.length} 条更新
            </Button>
          )}
          {phase === 'preview' && (
            <>
              {rows.some((r) => r.error || r.skip || !r.selected) && (
                <p className='mr-auto self-center text-label text-muted-foreground'>
                  仅提交已选择且通过校验的 {accepted.length}{' '}
                  条，其余行不会修改。
                </p>
              )}
              <Button variant='outline' onClick={() => setPhase('edit')}>
                返回编辑
              </Button>
              <Button loading={busy} onClick={() => void submit()}>
                确认提交 {accepted.length} 条
              </Button>
            </>
          )}
          {phase === 'results' && (
            <>
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => void downloadReport()}
              >
                下载结果（不含密码）
              </Button>
              {busy ? (
                <Button
                  variant='outline'
                  onClick={() => {
                    stopped.current = true
                  }}
                >
                  停止后续提交
                </Button>
              ) : (
                <>
                  <Button
                    variant='outline'
                    disabled={!resumable}
                    onClick={() => void submit()}
                  >
                    查询并继续
                  </Button>
                  {rows.some(
                    (r) =>
                      r.receipt?.status === 'pending_material' &&
                      r.item &&
                      !r.password &&
                      r.passwordJob !== false
                  ) && (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setRows((old) =>
                          old
                            .filter(
                              (r) =>
                                r.receipt?.status === 'pending_material' &&
                                r.item &&
                                r.passwordJob !== false
                            )
                            .map((r) => ({
                              ...r,
                              selected: true,
                              error: undefined,
                            }))
                        )
                        setKind('password_replace')
                        setRecoveringPending(true)
                        setPhase('edit')
                        setPage(0)
                      }}
                    >
                      补填待提交密码
                    </Button>
                  )}
                  <Button
                    disabled={
                      uncertainRegistration ||
                      rows.some(
                        (r) =>
                          r.unknown || r.receipt?.status === 'pending_material'
                      )
                    }
                    onClick={() => {
                      setRows((old) =>
                        old
                          .filter((r) => r.receipt?.status !== 'succeeded')
                          .map((r) => ({
                            ...r,
                            selected: !!r.item,
                            receipt: undefined,
                            unknown: false,
                            error: r.item ? undefined : r.error,
                          }))
                      )
                      jobs.current = []
                      setRecoveringPending(false)
                      setResumable(false)
                      setPhase('edit')
                      setPage(0)
                    }}
                  >
                    处理未成功项
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
