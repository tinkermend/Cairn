window.__labEvents = window.__labEvents || []

function labRecord(type, extra) {
  window.__labEvents.push({
    type,
    t: Date.now(),
    href: location.href,
    ...extra,
  })
}

document.addEventListener(
  'click',
  (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    labRecord('click', {
      id: target.id || '',
      tag: target.tagName,
    })
  },
  true,
)

document.addEventListener(
  'input',
  (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return
    labRecord('input', { id: target.id || '' })
  },
  true,
)

labRecord('navigate', { id: '', tag: 'HTML' })
