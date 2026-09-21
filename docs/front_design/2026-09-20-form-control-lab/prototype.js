const themes = [
  { id: 'current', letter: 'A', name: '原灰蓝', badge: '原样式对照', description: '灰蓝边界 · 轻微内阴影 · 蓝色聚焦', halo: '2px · 蓝色 15%', error: '错误时保留红色外光' },
  { id: 'blue', letter: 'B', name: '清透蓝', badge: '已选定', description: '更明确的蓝色 · 平整白底 · 柔和外光', halo: '3px · 蓝色 10%', error: '错误时红边，聚焦再加光晕' },
  { id: 'cyan', letter: 'C', name: '冷青蓝', badge: '候选 02', description: '偏青的冷蓝 · 清晰轮廓 · 紧凑外光', halo: '2px · 青蓝 14%', error: '错误时红边，聚焦再加光晕' },
]
const states = [
  ['default', '默认', 'Default'], ['hover', '悬停', 'Hover'], ['active', '按下', 'Active'],
  ['focus', '聚焦', 'Focus'], ['error', '错误', 'Error'], ['error-focus', '错误 + 聚焦', 'Error + focus'], ['disabled', '禁用', 'Disabled'],
]
let controlType = 'input'
let showPlaceholder = false
const contrast = (rgb) => {
  const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const channel = value / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return 1.05 / (channels.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0) + .05)
}
const rgbToHex = (rgb) => '#' + rgb.match(/[\d.]+/g).slice(0, 3).map(value => Math.round(Number(value)).toString(16).padStart(2, '0')).join('').toUpperCase()
function renderComparison() {
  const expanded = new Set([...document.querySelectorAll('.scheme-details[open]')].map(details => details.closest('.scheme').dataset.theme))
  const grid = document.querySelector('#comparison-grid')
  const content = {
    input: [showPlaceholder ? '例如：铁塔视联' : '铁塔视联', '请输入名称'],
    select: [showPlaceholder ? '请选择环境' : '预发布环境', '请选择环境'],
    textarea: [showPlaceholder ? '补充系统用途或注意事项。' : '用于场景验证与日常巡检。', '请输入说明'],
  }[controlType]
  grid.innerHTML = themes.map(theme => `<article class="scheme" data-theme="${theme.id}" aria-labelledby="title-${theme.id}">
    <header class="scheme-header"><div class="scheme-title"><span class="scheme-letter">${theme.letter}</span><h3 id="title-${theme.id}">${theme.name}</h3><span class="scheme-badge">${theme.badge}</span></div><p>${theme.description}</p></header>
    <div class="scheme-samples">${states.map(([state, label, english]) => `<div class="sample" data-state="${state}">
      <div class="sample-label"><span>${label}</span><small lang="en">${english}</small></div>
      <div class="control-display ${controlType === 'textarea' ? 'is-textarea' : ''} ${showPlaceholder || state.startsWith('error') ? 'is-placeholder' : ''}"><span>${state.startsWith('error') ? content[1] : content[0]}</span>${controlType === 'select' ? '<span class="chevron" aria-hidden="true"></span>' : ''}</div>
      ${state.startsWith('error') ? `<p class="sample-hint">${content[1]}后继续。</p>` : ''}
    </div>`).join('')}</div>
    <details class="scheme-details" ${expanded.has(theme.id) ? 'open' : ''}><summary>查看颜色与光晕</summary><dl><dt>默认边框</dt><dd data-color="default"></dd><dt>悬停边框</dt><dd data-color="hover"></dd><dt>聚焦边框</dt><dd data-color="focus"></dd><dt>聚焦光晕</dt><dd>${theme.halo}</dd><dt>对白底对比度</dt><dd class="contrast-value"></dd></dl></details>
  </article>`).join('')
  grid.querySelectorAll('.scheme').forEach(scheme => {
    for (const state of ['default', 'hover', 'focus']) {
      const color = getComputedStyle(scheme.querySelector(`[data-state="${state}"] .control-display`)).borderColor
      const cell = scheme.querySelector(`[data-color="${state}"]`)
      const swatch = document.createElement('span')
      swatch.className = 'color-swatch'
      swatch.style.backgroundColor = color
      swatch.setAttribute('aria-hidden', 'true')
      cell.append(swatch, rgbToHex(color))
      if (state === 'default') scheme.querySelector('.contrast-value').textContent = `${contrast(color).toFixed(2)} : 1`
    }
  })
}
document.querySelectorAll('[data-control]').forEach(button => button.addEventListener('click', () => {
  controlType = button.dataset.control
  document.querySelectorAll('[data-control]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
  renderComparison()
}))
document.querySelector('#show-placeholder').addEventListener('change', event => {
  showPlaceholder = event.target.checked
  renderComparison()
})

const form = document.querySelector('#demo-form')
const liveSurface = document.querySelector('#live-surface')
const nameInput = document.querySelector('#demo-name')
const environmentInput = document.querySelector('#demo-environment')
const environmentMenu = document.querySelector('#environment-options')
const environmentOptions = [...environmentMenu.querySelectorAll('[role="option"]')]
const enabledOptions = environmentOptions.filter(option => option.getAttribute('aria-disabled') !== 'true')
let highlightedOption = null
const urlInput = document.querySelector('#demo-url')
const result = document.querySelector('#form-result')
let pointerTarget = null
let pointerDown = false
function updateLiveState() {
  const focused = document.activeElement?.matches('.live-control') ? document.activeElement : null
  const target = focused || pointerTarget
  const invalid = target?.getAttribute('aria-invalid') === 'true'
  const state = invalid ? (focused ? '错误 + 聚焦' : '错误') : target?.getAttribute('aria-expanded') === 'true' ? '展开' : pointerDown && pointerTarget === target ? '按下' : focused ? '聚焦' : pointerTarget ? '悬停' : '默认'
  document.querySelector('#live-state').textContent = state
  document.querySelector('#live-field').textContent = target ? target.labels[0].textContent.replace(/\*|（选填）/g, '').trim() : '等待操作'
  document.querySelector('#live-state-dot').dataset.state = invalid ? 'error' : focused ? 'focus' : 'default'
  const explanations = {
    '默认': '边框安静地勾勒输入区域，点击后才出现聚焦光晕。',
    '悬停': '边框加深，提示这里可以输入或选择。',
    '按下': '按住时边框短暂加强，松开后进入持续的聚焦状态。',
    '聚焦': '颜色和光晕标记当前操作位置；用 Tab 也能得到相同反馈。',
    '展开': '触发器保持蓝色光晕；浅蓝底与勾选表示已选，细轮廓表示当前高亮。',
    '错误': '红色边框配合字段下方的文字，说明需要修正的内容。',
    '错误 + 聚焦': '保留错误边框与说明，同时显示错误色光晕。',
  }
  document.querySelector('#live-explanation').textContent = explanations[state]
}
form.querySelectorAll('.live-control').forEach(control => {
  control.addEventListener('pointerenter', () => { pointerTarget = control; updateLiveState() })
  control.addEventListener('pointerleave', () => { if (pointerTarget === control) pointerTarget = null; updateLiveState() })
  control.addEventListener('pointerdown', () => { pointerTarget = control; pointerDown = true; updateLiveState() })
  control.addEventListener('focus', updateLiveState)
  control.addEventListener('blur', () => requestAnimationFrame(updateLiveState))
  const onEdit = () => {
    if (control.getAttribute('aria-invalid') === 'true') validateControl(control)
    result.textContent = ''
    result.removeAttribute('data-success')
    updateLiveState()
  }
  control.addEventListener('input', onEdit)
  control.addEventListener('change', onEdit)
})
for (const eventName of ['pointerup', 'pointercancel']) document.addEventListener(eventName, () => { pointerDown = false; updateLiveState() })
document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => {
  const theme = themes.find(item => item.id === button.dataset.themeChoice)
  liveSurface.dataset.theme = theme.id
  document.querySelectorAll('[data-theme-choice]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
  document.querySelector('#live-theme-name').textContent = `${theme.letter} · ${theme.name}`
  updateLiveState()
}))

function highlightOption(option) {
  highlightedOption = option
  environmentOptions.forEach(item => {
    if (item === option) item.dataset.highlighted = 'true'
    else delete item.dataset.highlighted
  })
  if (option) {
    environmentInput.setAttribute('aria-activedescendant', option.id)
    option.scrollIntoView({ block: 'nearest' })
  } else environmentInput.removeAttribute('aria-activedescendant')
}
function closeEnvironmentMenu(restoreFocus = false) {
  environmentMenu.hidden = true
  environmentInput.setAttribute('aria-expanded', 'false')
  highlightOption(null)
  if (restoreFocus) environmentInput.focus()
  updateLiveState()
}
function openEnvironmentMenu() {
  environmentMenu.hidden = false
  environmentInput.setAttribute('aria-expanded', 'true')
  const rect = environmentInput.getBoundingClientRect()
  const height = environmentMenu.offsetHeight
  const above = innerHeight - rect.bottom < height + 12 && rect.top > height + 12
  environmentMenu.dataset.side = above ? 'top' : 'bottom'
  environmentMenu.style.maxHeight = `${Math.max(72, Math.min(240, above ? rect.top - 12 : innerHeight - rect.bottom - 12))}px`
  highlightOption(enabledOptions.find(option => option.dataset.value === environmentInput.value) ?? enabledOptions[0])
  updateLiveState()
}
function chooseEnvironment(option, restoreFocus = true) {
  if (!option || option.getAttribute('aria-disabled') === 'true') return
  environmentInput.value = option.dataset.value
  document.querySelector('#environment-value').value = option.dataset.value
  document.querySelector('#environment-text').textContent = option.querySelector('span').textContent
  environmentInput.classList.remove('is-placeholder')
  environmentOptions.forEach(item => item.setAttribute('aria-selected', String(item === option)))
  closeEnvironmentMenu(restoreFocus)
  environmentInput.dispatchEvent(new Event('change', { bubbles: true }))
}
environmentInput.addEventListener('click', () => {
  if (environmentMenu.hidden) openEnvironmentMenu()
  else closeEnvironmentMenu()
})
environmentInput.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !environmentMenu.hidden) {
    event.preventDefault()
    closeEnvironmentMenu(true)
  } else if (event.key === 'Tab' && !environmentMenu.hidden) {
    chooseEnvironment(highlightedOption, false)
  } else if (['Enter', ' '].includes(event.key)) {
    event.preventDefault()
    if (environmentMenu.hidden) openEnvironmentMenu()
    else chooseEnvironment(highlightedOption)
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (environmentMenu.hidden) {
      openEnvironmentMenu()
      if (event.key === 'ArrowUp' || event.key === 'End') highlightOption(enabledOptions.at(-1))
    } else {
      const index = enabledOptions.indexOf(highlightedOption)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabledOptions.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabledOptions.length) % enabledOptions.length
      highlightOption(enabledOptions[next])
    }
  }
})
environmentOptions.forEach(option => {
  option.addEventListener('pointerdown', event => event.preventDefault())
  option.addEventListener('pointermove', () => { if (option.getAttribute('aria-disabled') !== 'true') highlightOption(option) })
  option.addEventListener('click', () => chooseEnvironment(option))
})
document.addEventListener('pointerdown', event => {
  if (!environmentMenu.hidden && !document.querySelector('#environment-widget').contains(event.target)) closeEnvironmentMenu()
})
environmentInput.addEventListener('blur', () => { if (!environmentMenu.hidden) closeEnvironmentMenu() })
function validateControl(control) {
  let message = ''
  if (control === nameInput && !control.value.trim()) message = '请填写名称。'
  if (control === environmentInput && !control.value) message = '请选择环境。'
  if (control === urlInput && control.value && !control.validity.valid) message = '请填写完整网址，例如 https://example.com。'
  const messageNode = document.getElementById(control.getAttribute('aria-describedby'))
  if (messageNode) messageNode.textContent = message
  if (message) control.setAttribute('aria-invalid', 'true')
  else control.removeAttribute('aria-invalid')
  return !message
}
form.addEventListener('submit', event => {
  event.preventDefault()
  const controls = [nameInput, environmentInput, urlInput]
  controls.forEach(validateControl)
  const firstInvalid = controls.find(control => control.getAttribute('aria-invalid') === 'true')
  if (firstInvalid) {
    result.textContent = '请先检查标红的字段。已填写的内容会保留。'
    result.removeAttribute('data-success')
    firstInvalid.focus()
  } else {
    result.textContent = '示例校验通过。可以切换配色，继续比较。'
    result.dataset.success = 'true'
  }
  updateLiveState()
})
form.addEventListener('reset', () => {
  environmentInput.value = ''
  document.querySelector('#environment-text').textContent = '请选择环境'
  environmentInput.classList.add('is-placeholder')
  environmentOptions.forEach(option => option.setAttribute('aria-selected', 'false'))
  closeEnvironmentMenu()
  form.querySelectorAll('[aria-invalid]').forEach(control => control.removeAttribute('aria-invalid'))
  form.querySelectorAll('.field-message').forEach(message => { message.textContent = '' })
  result.textContent = ''
  result.removeAttribute('data-success')
  pointerTarget = null
  pointerDown = false
  requestAnimationFrame(updateLiveState)
})
renderComparison()
