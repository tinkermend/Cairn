import * as React from 'react'
import { RECORDER_SOURCE_VERSION, type RecordingBindingDto, type TargetDto } from '@cairn/shared'
import type { ElementInfo, Mode, Source } from '@recorder/recorderTypes'
import { describeAttachment } from './attachment'
import { canAttachRecorder, canReadTargets, canUploadRecording } from './auth-gate'
import {
  CairnApiError,
  RECORDING_UPLOAD_DENIED_HINT,
  ensureHostPermission,
  fetchMe,
  fetchTargets,
  formatCairnError,
  formatRecordingUploadError,
  login,
  studioReturnUrl,
  uploadRecording,
} from './api'
import { bindingTargetUrl, resolveStudioBinding } from './binding'
import { DEFAULT_ENVIRONMENT_ID } from './config'
import { formatPickedElement } from './inspect'
import { recordingItemMeta } from './labels'
import { LoginForm } from './login-form'
import { CAIRN_OPEN_TARGET, requestAttach, requestDetach, requestStatus, type CairnAttachStatus } from './messages'
import { previewRecording } from './preview'
import {
  clearAuth,
  loadCairnSession,
  saveAuth,
  saveEnvironmentId,
  saveTargetId,
  type CairnSession,
} from './session'
import { describeStepTarget, stepDetailJson } from './step-detail'
import './workbench.css'

type Props = {
  sources: Source[]
  mode: Mode
  picked: ElementInfo | null
}

const RECORDING_MODES: Mode[] = ['recording', 'recording-inspecting', 'assertingText', 'assertingVisibility']
const INSPECT_MODES: Mode[] = ['inspecting', 'recording-inspecting']

/** 引擎只认「高亮这个定位」，没有「取消高亮」；用一个必然匹配不到的定位收掉上一次高亮。 */
const NO_HIGHLIGHT = 'css=cairn-no-such-element'

function dispatchMode(mode: Mode) {
  return window.dispatch?.({ event: 'setMode', params: { mode } })
}

export const CairnPanel: React.FC<Props> = ({ sources, mode, picked }) => {
  const [session, setSession] = React.useState<CairnSession | null>(null)
  const [environmentId, setEnvironmentId] = React.useState<string>(DEFAULT_ENVIRONMENT_ID)
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [targetId, setTargetId] = React.useState('')
  const [targets, setTargets] = React.useState<TargetDto[]>([])
  const [busy, setBusy] = React.useState(false)
  const [loginError, setLoginError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<{
    tone: 'ok' | 'error' | 'info' | 'warning'
    text: string
    undo?: boolean
  } | null>(null)
  const [confirmClear, setConfirmClear] = React.useState(false)
  const [expanded, setExpanded] = React.useState<readonly number[]>([])
  // 删除只排除上传的行，引擎采到的 JSONL 一行不动。
  const [excluded, setExcluded] = React.useState<readonly number[]>([])
  const [attachment, setAttachment] = React.useState<CairnAttachStatus | null>(null)
  const removalRef = React.useRef<readonly number[] | null>(null)
  const attachedRef = React.useRef(false)
  const attemptRef = React.useRef<{ fingerprint: string; recordingId: string } | null>(null)
  const [binding, setBinding] = React.useState<RecordingBindingDto | null>(null)
  const openedTargetRef = React.useRef<string | null>(null)

  const preview = React.useMemo(() => {
    try {
      return previewRecording(sources, excluded)
    } catch (error) {
      return { error: error instanceof Error ? error.message : '录制还不能上传' }
    }
  }, [sources, excluded])

  const refresh = React.useCallback(async (opts?: { announceAuthFailure?: boolean }) => {
    const next = await loadCairnSession()
    setSession(next)
    setEnvironmentId(next.environmentId)
    if (!canAttachRecorder(next)) {
      setTargets([])
      return next
    }
    try {
      const me = await fetchMe()
      const account = {
        id: me.account.id,
        displayName: me.account.displayName,
        permissions: me.account.permissions,
      }
      await saveAuth({
        accessToken: next.accessToken,
        expiresIn: Math.max(60, Math.floor(((next.expiresAt ?? Date.now()) - Date.now()) / 1000)),
        account,
      })
      if (canReadTargets(account.permissions)) {
        const list = await fetchTargets()
        const active = list.items.filter((item) => item.status === 'active')
        setTargets(active)
        // 挂录制器会重载侧栏，这里把上次选的目标系统接回来。
        setTargetId((current) =>
          current || !active.some((item) => item.id === next.targetId) ? current : next.targetId,
        )
      } else {
        setTargets([])
      }
      setSession({ ...next, account })
      try {
        const nextBinding = await resolveStudioBinding()
        setBinding(nextBinding)
        if (nextBinding) {
          setTargetId(nextBinding.targetId)
          await saveTargetId(nextBinding.targetId)
          const url = bindingTargetUrl(nextBinding)
          if (url && openedTargetRef.current !== nextBinding.id) {
            openedTargetRef.current = nextBinding.id
            await chrome.runtime.sendMessage({ event: CAIRN_OPEN_TARGET, url }).catch(() => {})
          }
        }
      } catch (bindError) {
        setBinding(null)
        if (opts?.announceAuthFailure) throw bindError
      }
    } catch (error) {
      if (error instanceof CairnApiError && error.status === 401) {
        await clearAuth()
        setSession({ ...next, accessToken: '', account: null, expiresAt: null })
        setTargets([])
        if (opts?.announceAuthFailure) throw error
        return next
      }
      if (opts?.announceAuthFailure) throw error
    }
    return next
  }, [])

  React.useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  // 挂载、模式变化、步骤变化各问一次被录页面，不用定时器。
  React.useEffect(() => {
    let alive = true
    requestStatus()
      .then((status) => {
        if (!alive) return
        setAttachment(status)
        attachedRef.current = status.attached
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mode, sources])

  const onLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setLoginError(null)
    try {
      const environment = await saveEnvironmentId(environmentId)
      await ensureHostPermission(environment.origin)
      const result = await login({ email, password })
      await saveAuth({
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        account: {
          id: result.account.id,
          displayName: result.account.displayName,
          permissions: result.account.permissions,
        },
      })
      setPassword('')
      await refresh({ announceAuthFailure: true })
    } catch (error) {
      setLoginError(formatCairnError(error))
    } finally {
      setBusy(false)
    }
  }

  const onTargetId = (value: string) => {
    setTargetId(value)
    void saveTargetId(value)
  }

  const onLogout = async () => {
    await requestDetach().catch(() => {})
    await clearAuth()
    setTargets([])
    setTargetId('')
    setMessage(null)
    await refresh()
  }

  const onUpload = async () => {
    if (!targetId) {
      setMessage({ tone: 'error', text: '请先选择目标系统' })
      return
    }
    if (!preview || 'error' in preview) {
      setMessage({ tone: 'error', text: preview && 'error' in preview ? preview.error : '还没有可上传的操作' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const fingerprint = JSON.stringify(preview.events)
      if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
        attemptRef.current = { fingerprint, recordingId: crypto.randomUUID() }
      }
      const recordingId = attemptRef.current.recordingId
      const detail = await uploadRecording({
        targetId,
        recordingId,
        sourceVersion: RECORDER_SOURCE_VERSION,
        idempotencyKey: recordingId,
        bindingId: binding?.id,
        events: preview.events,
      })
      const returnUrl = binding ? studioReturnUrl(session?.apiOrigin ?? '', { ...binding, recordingDraftId: detail.id }) : ''
      setMessage({
        tone: 'ok',
        text: binding
          ? `已上传到场景「${binding.scenarioName}」，尚未回填。打开 Studio 预览导入。${detail.unresolvedCount ? ` ${detail.unresolvedCount} 项待处理。` : ''}`
          : `已上传「${detail.name}」，控制台「录制草稿」可查看。${detail.unresolvedCount ? ` ${detail.unresolvedCount} 项待处理。` : ''}`,
      })
      if (returnUrl) {
        setBinding({ ...binding!, recordingDraftId: detail.id })
      }
    } catch (error) {
      setMessage({ tone: 'error', text: formatRecordingUploadError(error) })
    } finally {
      setBusy(false)
    }
  }

  const onRecord = async () => {
    if (RECORDING_MODES.includes(mode)) {
      await dispatchMode('standby')
      return
    }
    const attached = await requestAttach('recording')
    if (!attached.ok) {
      setMessage({ tone: 'error', text: attached.error ?? '无法挂到当前标签页' })
      return
    }
    await dispatchMode('recording')
  }

  const onInspect = async () => {
    if (mode === 'recording-inspecting') {
      await dispatchMode('recording')
      return
    }
    if (mode === 'inspecting') {
      await dispatchMode('standby')
      return
    }
    const next = RECORDING_MODES.includes(mode) ? 'recording-inspecting' : 'inspecting'
    const attached = await requestAttach(next)
    if (!attached.ok) {
      setMessage({ tone: 'error', text: attached.error ?? '无法挂到当前标签页' })
      return
    }
    await dispatchMode(next)
  }

  const onClear = () => {
    window.dispatch?.({ event: 'clear' })
    setConfirmClear(false)
    setExpanded([])
    setExcluded([])
    removalRef.current = null
    attemptRef.current = null
    setMessage({ tone: 'info', text: '已清空本段未上传步骤' })
  }

  const toggleStep = (index: number) => {
    setExpanded((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index],
    )
  }

  // 手滑删错比误点更常见，所以不弹确认，给撤销。
  const onDeleteStep = (position: number, rows: readonly number[], name: string) => {
    if (!rows.length) return
    removalRef.current = rows
    setExcluded((current) => [...current, ...rows])
    setExpanded([])
    setMessage({ tone: 'info', text: `已删除第 ${position + 1} 步「${name}」`, undo: true })
  }

  const onUndoDelete = () => {
    const rows = removalRef.current
    if (!rows) return
    setExcluded((current) => current.filter((row) => !rows.includes(row)))
    removalRef.current = null
    setMessage({ tone: 'info', text: '已撤销删除' })
  }

  const highlight = (selector: string | null) => {
    if (!attachedRef.current) return
    window.dispatch?.({ event: 'highlightRequested', params: { selector: selector ?? NO_HIGHLIGHT } })
  }

  const loggedIn = session ? canAttachRecorder(session) : false
  if (!loggedIn) {
    return (
      <LoginForm
        environmentId={environmentId}
        onEnvironmentId={setEnvironmentId}
        email={email}
        password={password}
        onEmail={setEmail}
        onPassword={setPassword}
        busy={busy}
        error={loginError}
        onSubmit={(event) => void onLogin(event)}
      />
    )
  }

  const permissions = session?.account?.permissions ?? []
  const canUpload = canUploadRecording(permissions)
  const ready = preview && !('error' in preview) ? preview : null
  const items = ready?.items ?? []
  const recording = RECORDING_MODES.includes(mode)
  const inspecting = INSPECT_MODES.includes(mode)
  const uploadDisabled = busy || !canUpload || !targetId || !items.length || Boolean(preview && 'error' in preview)
  // 一屏只留一个最醒目的操作：还没录到步骤时是录制，录到了才轮到上传。
  const uploadIsPrimary = items.length > 0
  const attachmentLine = describeAttachment(attachment, {
    recording,
    stepCount: items.length,
    unresolvedCount: ready?.unresolvedCount ?? 0,
  })
  const status =
    message ??
    (preview && 'error' in preview
      ? { tone: 'error' as const, text: preview.error }
      : inspecting && picked
        ? { tone: 'info' as const, text: `当前元素：${formatPickedElement(picked)}` }
        : {
            tone: recording ? ('live' as const) : ('info' as const),
            text: attachmentLine.head,
            detail: attachmentLine.detail,
          })
  const statusClass =
    status.tone === 'error'
      ? ' cairn-status-error'
      : status.tone === 'ok'
        ? ' cairn-status-ok'
        : status.tone === 'warning'
          ? ' cairn-status-warning'
          : status.tone === 'live'
            ? ' cairn-status-live'
            : ''

  return (
    <div className='cairn-app'>
      <div className='cairn-top'>
        <div className='cairn-top-row'>
          <strong>识途录制器</strong>
          <span className='cairn-who'>
            {session?.account?.displayName}
            <button type='button' className='cairn-btn cairn-btn-ghost' disabled={busy} onClick={() => void onLogout()}>
              退出
            </button>
          </span>
        </div>
        {binding ? (
          <p className='cairn-hint'>
            正在为场景「{binding.scenarioName}」录制 {binding.targetName}
            {binding.recordingDraftId ? ' · 已上传，待 Studio 回填' : ''}
          </p>
        ) : null}
        <div className='cairn-field'>
          <label htmlFor='cairn-target'>目标系统</label>
          <select
            id='cairn-target'
            value={targetId}
            disabled={Boolean(binding)}
            onChange={(event) => onTargetId(event.target.value)}
          >
            <option value=''>选择目标系统</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type='button'
          className={`cairn-btn cairn-btn-block ${uploadIsPrimary ? 'cairn-btn-primary' : 'cairn-btn-secondary'}`}
          disabled={uploadDisabled}
          onClick={() => void onUpload()}
        >
          {busy ? '上传中…' : '上传到平台'}
        </button>
        {!canUpload ? <p className='cairn-hint'>{RECORDING_UPLOAD_DENIED_HINT}</p> : null}
        {binding?.recordingDraftId && session ? (
          <a className='cairn-hint' href={studioReturnUrl(session.apiOrigin, binding)} target='_blank' rel='noreferrer'>
            回到 Studio 预览回填
          </a>
        ) : null}
      </div>
      <div className='cairn-toolbar'>
        <button
          type='button'
          className={`cairn-btn ${uploadIsPrimary || recording ? 'cairn-btn-secondary' : 'cairn-btn-primary'}`}
          aria-pressed={recording}
          disabled={busy}
          onClick={() => void onRecord()}
        >
          {recording ? '停止录制' : items.length ? '继续录制' : '开始录制'}
        </button>
        <button
          type='button'
          className='cairn-btn cairn-btn-ghost'
          aria-pressed={inspecting}
          disabled={busy}
          onClick={() => void onInspect()}
        >
          {inspecting ? '停止选取' : '选取'}
        </button>
        <button type='button' className='cairn-btn cairn-btn-ghost' disabled={!items.length} onClick={() => setConfirmClear(true)}>
          清空
        </button>
      </div>
      {confirmClear ? (
        <div className='cairn-confirm'>
          清空本段未上传步骤？
          <button type='button' className='cairn-btn cairn-btn-secondary' onClick={onClear}>
            确认清空
          </button>
          <button type='button' className='cairn-btn cairn-btn-ghost' onClick={() => setConfirmClear(false)}>
            取消
          </button>
        </div>
      ) : (
        <div className={`cairn-status${statusClass}`} role='status'>
          {status.tone === 'live' ? <span className='cairn-live-dot' aria-hidden='true' /> : null}
          <div className='cairn-status-body'>
            <span>{status.text}</span>
            {'detail' in status && status.detail ? (
              <span className='cairn-status-detail'>{status.detail}</span>
            ) : null}
          </div>
          {'undo' in status && status.undo ? (
            <button type='button' className='cairn-step-toggle' onClick={onUndoDelete}>
              撤销
            </button>
          ) : null}
        </div>
      )}
      {items.length ? (
        <ol className='cairn-steps' onMouseLeave={() => highlight(null)}>
          {items.map((item, position) => {
            const target = describeStepTarget(item)
            const open = expanded.includes(item.index)
            const selector = ready?.selectors[position] ?? null
            return (
              <li
                key={`${item.index}-${item.sourceAction}`}
                className='cairn-step'
                onMouseEnter={() => highlight(selector)}
              >
                <div className='cairn-step-head'>
                  <span className='cairn-idx'>{item.index + 1}</span>
                  <span className='cairn-step-name'>
                    {item.name}
                    {target ? <span className='cairn-step-target'>{target}</span> : null}
                  </span>
                  <button
                    type='button'
                    className='cairn-step-toggle'
                    aria-expanded={open}
                    aria-controls={`cairn-step-raw-${item.index}`}
                    onFocus={() => highlight(selector)}
                    onClick={() => toggleStep(item.index)}
                  >
                    {open ? '收起' : '展开'}
                  </button>
                  <button
                    type='button'
                    className='cairn-step-toggle cairn-step-remove'
                    onClick={() => onDeleteStep(position, ready?.sourceRows[position] ?? [], item.name)}
                  >
                    删除
                  </button>
                </div>
                <p className={`cairn-meta${item.status === 'mapped' ? '' : ' cairn-meta-warning'}`}>{recordingItemMeta(item)}</p>
                {item.diagnostics.map((line) => (
                  <p key={line} className='cairn-meta cairn-meta-warning'>
                    {line}
                  </p>
                ))}
                {open ? (
                  <pre className='cairn-step-raw' id={`cairn-step-raw-${item.index}`}>
                    {stepDetailJson(item)}
                  </pre>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className='cairn-empty'>开始录制后，操作会按顺序列在这里。</p>
      )}
    </div>
  )
}
