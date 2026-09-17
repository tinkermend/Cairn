import {
  LOCATOR_BY,
  MAX_FRAME_DEPTH,
  RELATIVE_ANCHOR_SCOPES,
  observationShowsFragileCss,
  type LocatorBy,
  type RelativeAnchorScope,
  type TargetDescriptor,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuthoringObserve } from '../observe'
import { ANCHOR_LABELS, BY_LABELS } from './labels'

export function TargetFields({
  target,
  disabled,
  optional,
  onChange,
}: {
  target: TargetDescriptor
  disabled?: boolean
  optional?: boolean
  onChange: (target: TargetDescriptor) => void
}) {
  const observe = useAuthoringObserve()
  const candidates =
    target.candidates.length > 0
      ? target.candidates
      : [{ by: 'label' as const, value: '' }]
  const frames = target.framePath ?? []
  const observeDisabled = disabled && !observe.holding
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Label>页面元素{optional ? '（可选）' : ''}</Label>
        <div className='flex flex-wrap gap-2'>
          {observe.canIndicate ? (
            <Button
              type='button'
              size='sm'
              disabled={observeDisabled}
              onClick={() => {
                if (!observe.holding) {
                  observe.highlightTarget(target)
                  return
                }
                observe.setPickMode(true)
              }}
            >
              {observe.pickMode ? '在画面上点选…' : '在页面上指认'}
            </Button>
          ) : null}
          {observe.canHighlight ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={observeDisabled}
              onClick={() => observe.highlightTarget(target)}
            >
              校验高亮
            </Button>
          ) : null}
          {observe.holding && observe.canDebugHold ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={
                observeDisabled ||
                !(observe.lastPicked || observe.highlight?.target)
              }
              onClick={() => observe.applyForTrial()}
            >
              本次验证
            </Button>
          ) : null}
          {observe.holding ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={observeDisabled}
              onClick={() => observe.writeBack()}
            >
              写回草稿
            </Button>
          ) : null}
          {observe.overlayStepId ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              disabled={observeDisabled}
              onClick={() => observe.clearOverlay(observe.overlayStepId!)}
            >
              恢复原始快照
            </Button>
          ) : null}
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={disabled || candidates.length >= 5}
            onClick={() => {
              const extra = { by: 'label' as const, value: '' }
              const last = candidates[candidates.length - 1]
              onChange({
                ...target,
                candidates:
                  last?.by === 'css'
                    ? [...candidates.slice(0, -1), extra, last]
                    : [...candidates, extra],
              })
            }}
          >
            添加候选
          </Button>
        </div>
      </div>
      {observe.overlayStepId ? (
        <p className='text-small text-status-warning-foreground'>
          正在使用临时覆盖目标，只影响本次再试。
        </p>
      ) : null}
      {observe.highlight?.outcome === 'AMBIGUOUS' &&
      observe.highlight.alternatives?.length ? (
        <ul
          className='list-disc space-y-1 ps-5 text-small text-status-warning-foreground'
          aria-label='多个匹配'
        >
          {observe.highlight.alternatives.map((item) => (
            <li key={`${item.index}-${item.reason}`}>{item.reason}</li>
          ))}
        </ul>
      ) : null}
      {observe.highlight && observationShowsFragileCss(observe.highlight) ? (
        <p className='text-small text-status-warning-foreground'>
          当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色。
        </p>
      ) : null}
      {candidates.map((candidate, index) => (
        <div key={`${candidate.by}-${index}`} className='space-y-2'>
          <div className='grid gap-2 sm:grid-cols-[7rem_1fr_auto]'>
            <Select
              value={candidate.by}
              disabled={disabled}
              onValueChange={(value) => {
                const by = value as LocatorBy
                const updated = {
                  ...candidate,
                  by,
                  name: by === 'role' ? candidate.name : undefined,
                }
                const next =
                  by === 'css' && index !== candidates.length - 1
                    ? [
                        ...candidates.filter(
                          (_, itemIndex) => itemIndex !== index
                        ),
                        updated,
                      ]
                    : candidates.map((item, itemIndex) =>
                        itemIndex === index ? updated : item
                      )
                onChange({ ...target, candidates: next })
              }}
            >
              <SelectTrigger
                className='w-full'
                aria-label={`定位候选 ${index + 1}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATOR_BY.map((by) => (
                  <SelectItem
                    key={by}
                    value={by}
                    disabled={
                      by === 'css' &&
                      index !== candidates.length - 1 &&
                      candidates.some((item) => item.by === 'css')
                    }
                  >
                    {BY_LABELS[by]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={candidate.value}
              disabled={disabled}
              aria-label={
                candidate.by === 'role'
                  ? `角色 ${index + 1}`
                  : `定位值 ${index + 1}`
              }
              placeholder={
                candidate.by === 'role' ? '按钮 / 文本框' : undefined
              }
              onChange={(event) => {
                const next = candidates.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, value: event.target.value }
                    : item
                )
                onChange({ ...target, candidates: next })
              }}
            />
            {candidates.length > 1 ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...target,
                    candidates: candidates.filter(
                      (_, itemIndex) => itemIndex !== index
                    ),
                  })
                }
              >
                移除
              </Button>
            ) : null}
          </div>
          {candidate.by === 'role' ? (
            <Input
              value={candidate.name ?? ''}
              disabled={disabled}
              aria-label={`角色名称 ${index + 1}`}
              placeholder='无障碍名称（可选）'
              onChange={(event) => {
                const next = candidates.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, name: event.target.value.trim() || undefined }
                    : item
                )
                onChange({ ...target, candidates: next })
              }}
            />
          ) : null}
        </div>
      ))}
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <Label>Frame 路径（可选）</Label>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={disabled || frames.length >= MAX_FRAME_DEPTH}
            onClick={() =>
              onChange({ ...target, framePath: [...frames, { selector: '' }] })
            }
          >
            添加 Frame
          </Button>
        </div>
        {frames.map((frame, index) => (
          <div key={`frame-${index}`} className='flex gap-2'>
            <Input
              value={frame.selector ?? frame.name ?? frame.urlPattern ?? ''}
              disabled={disabled}
              aria-label={`Frame ${index + 1}`}
              placeholder='iframe 选择器'
              onChange={(event) => {
                onChange({
                  ...target,
                  framePath: frames.map((item, itemIndex) =>
                    itemIndex === index
                      ? { selector: event.target.value }
                      : item
                  ),
                })
              }}
            />
            <Button
              type='button'
              variant='ghost'
              size='sm'
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...target,
                  framePath: frames.filter(
                    (_, itemIndex) => itemIndex !== index
                  ),
                })
              }
            >
              移除
            </Button>
          </div>
        ))}
      </div>
      <div className='space-y-2'>
        <label className='flex items-center gap-2 text-small'>
          <input
            type='checkbox'
            checked={Boolean(target.anchor)}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...target,
                anchor: event.target.checked
                  ? { withinText: '', scope: 'nearest' }
                  : undefined,
              })
            }
          />
          相对锚点
        </label>
        {target.anchor ? (
          <div className='grid gap-2 sm:grid-cols-2'>
            <Input
              value={target.anchor.withinText}
              disabled={disabled}
              aria-label='锚点文本'
              placeholder='附近可见文本'
              onChange={(event) =>
                onChange({
                  ...target,
                  anchor: { ...target.anchor!, withinText: event.target.value },
                })
              }
            />
            <Select
              value={target.anchor.scope}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...target,
                  anchor: {
                    ...target.anchor!,
                    scope: value as RelativeAnchorScope,
                  },
                })
              }
            >
              <SelectTrigger className='w-full' aria-label='锚点范围'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATIVE_ANCHOR_SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {ANCHOR_LABELS[scope]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
    </div>
  )
}
