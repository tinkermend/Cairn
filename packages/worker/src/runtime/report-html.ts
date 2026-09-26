import type { JsonValue, ReportAiInterpretation, ReportDocument } from '@cairn/shared'

export type ReportImage = {
  id: string
  body: Buffer
  width: number
  height: number
  kind: 'logo' | 'screenshot'
  caption: string
}

export function escapeHtml(str: unknown): string {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STATUS_LABELS: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  SUCCEEDED: '执行成功',
  FAILED: '执行失败',
  CANCELLED: '已取消',
  NEEDS_REVIEW: '待核查',
  WAITING_FOR_AUTH: '等待认证',
  HOLDING: '已暂停',
  RECOVERING: '恢复中',
  COMPLETED: '已完成',
  WAITING: '等待中',
  PASS: '通过',
  FAIL: '异常',
  WARN: '提示',
  UNKNOWN: '未知',
  NOT_EVALUATED: '未评估',
  PENDING: '待处理',
  ACTIVE: '执行中',
  SETTLED: '已结束',
  SKIPPED: '已跳过',
  COMPLETE: '完整',
  INCOMPLETE: '不完整',
  NORMAL: '正常',
  WARNING: '警告',
  ANOMALOUS: '异常',
  EXCELLENT: '优',
  GOOD: '良',
  FAIR: '中',
  POOR: '差',
  INFO: '信息',
  HIGH: '高危',
  FATAL: '严重',
  all_pass: '全部通过',
  pass_with_warnings: '通过但有提示',
  anomalies_found: '发现异常',
  incomplete: '结论不完整',
}

function labelFor(status: unknown): string {
  if (status == null) return '未记录'
  const key = String(status)
  return STATUS_LABELS[key] ?? key
}

function badgeClass(status: unknown): string {
  if (status == null) return 'badge-neutral'
  const s = String(status).toUpperCase()
  if (['PASS', 'SUCCEEDED', 'NORMAL', 'EXCELLENT', 'GOOD', 'COMPLETE', 'ALL_PASS'].includes(s)) return 'badge-success'
  if (['FAIL', 'FAILED', 'ANOMALOUS', 'POOR', 'FATAL', 'HIGH', 'ANOMALIES_FOUND'].includes(s)) return 'badge-danger'
  if (['WARN', 'WARNING', 'FAIR', 'NEEDS_REVIEW', 'PASS_WITH_WARNINGS'].includes(s)) return 'badge-warning'
  if (['RUNNING', 'ACTIVE', 'INFO', 'RECOVERING'].includes(s)) return 'badge-info'
  return 'badge-neutral'
}

function formatDate(value: unknown, timeZone: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return escapeHtml(value)
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return escapeHtml(value)
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = (s % 60).toFixed(1)
  return `${m}m ${rem}s`
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function records(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  return Array.isArray(value) ? value.map(record) : []
}

// ---------------------------------------------------------------------------
// Shared CSS Stylesheet (Self-contained, Print-friendly, Dark/Light resilient)
// ---------------------------------------------------------------------------
const SHARED_STYLES = `
  :root {
    --bg-page: #f8fafc;
    --bg-card: #ffffff;
    --border-color: #e2e8f0;
    --border-subtle: #f1f5f9;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #94a3b8;
    --color-brand: #0284c7;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: var(--bg-page);
    color: var(--text-primary);
    font-family: var(--font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    padding-bottom: 60px;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 20px;
  }
  /* Top Bar */
  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .brand-logo-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-logo {
    max-height: 36px;
    max-width: 140px;
    object-fit: contain;
  }
  .platform-tag {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-brand);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .actions-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-card);
    color: var(--text-secondary);
    transition: all 0.15s ease;
    user-select: none;
  }
  .btn:hover {
    background: #f1f5f9;
    color: var(--text-primary);
    border-color: #cbd5e1;
  }
  .btn-primary {
    background: #0284c7;
    color: #ffffff;
    border-color: #0284c7;
  }
  .btn-primary:hover {
    background: #0369a1;
    border-color: #0369a1;
    color: #ffffff;
  }

  /* Header Card */
  .header-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
  }
  .header-title {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 8px;
    line-height: 1.3;
  }
  .header-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* Grid Layouts */
  .grid-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 16px 20px;
    box-shadow: 0 1px 2px 0 rgba(0,0,0,0.03);
  }
  .stat-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .stat-subtext {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 4px;
  }

  /* Health Score Large Showcase */
  .score-hero {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .score-circle {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    border: 4px solid currentColor;
    background: #ffffff;
    flex-shrink: 0;
  }
  .score-val { font-size: 22px; line-height: 1; }
  .score-max { font-size: 10px; opacity: 0.7; }

  /* Badges */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    border: 1px solid transparent;
  }
  .badge-success { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
  .badge-danger  { background: #fff1f2; color: #9f1239; border-color: #fecdd3; }
  .badge-warning { background: #fffbeb; color: #92400e; border-color: #fde68a; }
  .badge-info    { background: #f0f9ff; color: #0369a1; border-color: #bae6fd; }
  .badge-neutral { background: #f1f5f9; color: #475569; border-color: #cbd5e1; }

  /* Sections */
  .section {
    margin-bottom: 28px;
  }
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 10px;
  }
  .section-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Filter Pills */
  .filter-pills {
    display: flex;
    gap: 6px;
    background: #f1f5f9;
    padding: 3px;
    border-radius: 8px;
  }
  .pill {
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    transition: all 0.15s ease;
  }
  .pill:hover { color: var(--text-primary); }
  .pill.active {
    background: #ffffff;
    color: var(--color-brand);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }

  /* Tables */
  .table-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.03);
  }
  .table-responsive {
    width: 100%;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    text-align: left;
  }
  th {
    background: #f8fafc;
    color: var(--text-secondary);
    font-weight: 600;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
  }
  td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    vertical-align: middle;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background-color: #fbfcfe; }
  .table-num { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  /* Collapsible Accordion (details / summary) */
  details.step-accordion {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    margin-bottom: 10px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.02);
    transition: border-color 0.15s ease;
  }
  details.step-accordion[open] {
    border-color: #cbd5e1;
  }
  summary.step-summary {
    list-style: none;
    cursor: pointer;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    user-select: none;
  }
  summary.step-summary::-webkit-details-marker { display: none; }
  summary.step-summary:hover { background: #fbfcfe; }
  .step-header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }
  .step-idx {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
    min-width: 24px;
  }
  .step-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step-header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .step-chevron {
    width: 18px;
    height: 18px;
    color: var(--text-muted);
    transition: transform 0.2s ease;
  }
  details[open] .step-chevron {
    transform: rotate(180deg);
  }
  .step-body {
    padding: 16px 20px;
    border-top: 1px solid var(--border-subtle);
    background: #fbfcfe;
    font-size: 13px;
  }

  /* Screenshot Cards & Lightbox */
  .screenshot-gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 14px;
    margin-top: 12px;
  }
  .thumb-card {
    background: #ffffff;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    cursor: zoom-in;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .thumb-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
  .thumb-img {
    width: 100%;
    height: 140px;
    object-fit: cover;
    display: block;
    border-bottom: 1px solid var(--border-subtle);
  }
  .thumb-caption {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Lightbox Overlay */
  .lightbox-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.88);
    backdrop-filter: blur(4px);
    z-index: 10000;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .lightbox-overlay.active { display: flex; }
  .lightbox-content {
    max-width: 92vw;
    max-height: 82vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
  }
  .lightbox-caption {
    color: #f1f5f9;
    margin-top: 12px;
    font-size: 14px;
    font-weight: 500;
    text-align: center;
  }
  .lightbox-close {
    position: absolute;
    top: 20px;
    right: 24px;
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
    border: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    font-size: 20px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
  }
  .lightbox-close:hover { background: rgba(255, 255, 255, 0.3); }

  /* Key-Value Tag */
  .kv-tag {
    display: inline-flex;
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-mono);
    margin: 2px 4px 2px 0;
    border: 1px solid #e2e8f0;
  }
  .kv-key { color: var(--text-secondary); font-weight: 600; margin-right: 4px; }
  .kv-val { color: var(--text-primary); }

  /* Toast Notification */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #0f172a;
    color: #ffffff;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: none;
    z-index: 10001;
  }
  .toast.show { display: block; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

  /* AI Interpretation Card */
  .ai-card {
    background: linear-gradient(135deg, #f0fdf4 0%, #f8fafc 100%);
    border: 1px solid #bbf7d0;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);
  }
  .ai-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #dcfce7;
    padding-bottom: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ai-card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 700;
    color: #166534;
  }
  .ai-card-meta {
    font-size: 12px;
    color: #4b5563;
  }
  .ai-card-disclaimer {
    display: inline-block;
    background: #e2e8f0;
    color: #475569;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    margin-left: 6px;
  }
  .ai-alert-inconclusive {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 14px;
    color: #92400e;
    font-size: 13px;
  }
  .ai-observation {
    font-size: 14px;
    color: #1f2937;
    line-height: 1.6;
    margin-bottom: 14px;
    background: #ffffff;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
  }
  .ai-section-subtitle {
    font-size: 13px;
    font-weight: 700;
    color: #374151;
    margin-top: 14px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ai-finding-item {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 8px;
  }
  .ai-finding-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .ai-finding-title {
    font-weight: 600;
    font-size: 13px;
    color: #111827;
  }
  .ai-finding-detail {
    font-size: 13px;
    color: #4b5563;
    line-height: 1.5;
  }
  .ai-citation-pill {
    display: inline-flex;
    align-items: center;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    color: #334155;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-mono);
    margin-left: 4px;
  }
  .ai-suggestion-list {
    margin-left: 20px;
    font-size: 13px;
    color: #374151;
    line-height: 1.6;
  }

  /* Media Print Optimizations */
  @media print {
    @page { size: A4 portrait; margin: 12mm; }
    body { background: #ffffff !important; padding: 0 !important; color: #000000 !important; }
    .container { max-width: 100% !important; padding: 0 !important; }
    .no-print { display: none !important; }
    .header-card, .stat-card, .table-card, .ai-card, details.step-accordion {
      box-shadow: none !important;
      border-color: #cbd5e1 !important;
    }
    details.step-accordion { display: block !important; }
    details.step-accordion > * { display: block !important; }
    .step-chevron { display: none !important; }
    table, tr, .stat-card, .ai-card, details.step-accordion {
      break-inside: avoid !important;
      page-break-inside: avoid !important;
    }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
`

// ---------------------------------------------------------------------------
// Shared JavaScript Runtime (< 3KB Vanilla JS)
// ---------------------------------------------------------------------------
const SHARED_SCRIPT = `
  function openLightbox(src, caption) {
    var overlay = document.getElementById('lightbox-overlay');
    var img = document.getElementById('lightbox-img');
    var cap = document.getElementById('lightbox-cap');
    if (!overlay || !img) return;
    img.src = src;
    if (cap) cap.textContent = caption || '';
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox(e) {
    if (e && e.target && e.target.id === 'lightbox-img') return;
    var overlay = document.getElementById('lightbox-overlay');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeLightbox();
  });

  function copyText(text, label) {
    if (!navigator.clipboard) {
      alert('已复制：' + text);
      return;
    }
    navigator.clipboard.writeText(text).then(function() {
      showToast('已复制' + (label ? ' ' + label : '') + '到剪贴板');
    }).catch(function() {
      alert('复制失败，请手动选择复制');
    });
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 2500);
  }

  function filterItems(targetSelector, attrName, value, activeBtn) {
    var items = document.querySelectorAll(targetSelector);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var itemVal = item.getAttribute(attrName);
      if (value === 'ALL' || itemVal === value) {
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    }
    if (activeBtn && activeBtn.parentElement) {
      var pills = activeBtn.parentElement.querySelectorAll('.pill');
      for (var j = 0; j < pills.length; j++) pills[j].classList.remove('active');
      activeBtn.classList.add('active');
    }
  }
`

// ---------------------------------------------------------------------------
// AI Interpretation Card Renderer
// ---------------------------------------------------------------------------
export function renderAiInterpretationCard(ai: ReportAiInterpretation | undefined, timeZone: string): string {
  if (!ai) return ''

  const modelText = escapeHtml(ai.model)
  const dateText = formatDate(ai.generatedAt, timeZone)

  let inconclusiveHtml = ''
  if (ai.status === 'inconclusive') {
    inconclusiveHtml = `
      <div class="ai-alert-inconclusive">
        ⚠️ <strong>材料不足声明：</strong>当前运行证据与数据不足以得出全面判定。
      </div>`
  }

  let findingsHtml = ''
  if (ai.findings && ai.findings.length > 0) {
    findingsHtml = `
      <div class="ai-section-subtitle">主要异常与关键发现 (${ai.findings.length})</div>
      <div class="ai-findings-list">
        ${ai.findings.map((f) => {
          const citations = (f.citationIds || []).map((cid) => `<span class="ai-citation-pill">#${escapeHtml(cid)}</span>`).join('')
          return `
            <div class="ai-finding-item">
              <div class="ai-finding-detail">${escapeHtml(f.statement)} ${citations}</div>
            </div>`
        }).join('')}
      </div>`
  }

  let hypothesesHtml = ''
  if (ai.hypotheses && ai.hypotheses.length > 0) {
    hypothesesHtml = `
      <div class="ai-section-subtitle">原因分析与推测假设 (${ai.hypotheses.length})</div>
      <div class="ai-hypotheses-list">
        ${ai.hypotheses.map((h) => {
          const likelihoodBadge = h.likelihood === 'high' ? 'badge-danger' : h.likelihood === 'medium' ? 'badge-warning' : 'badge-neutral'
          const likelihoodLabel = h.likelihood === 'high' ? '高可能性' : h.likelihood === 'medium' ? '中等可能' : '低可能性'
          return `
            <div class="ai-finding-item">
              <div class="ai-finding-header">
                <span class="badge ${likelihoodBadge}">${likelihoodLabel}</span>
                <span class="ai-finding-title">${escapeHtml(h.cause)}</span>
              </div>
              <div class="ai-finding-detail"><strong>依据：</strong>${escapeHtml(h.basis)}</div>
            </div>`
        }).join('')}
      </div>`
  }

  let suggestionsHtml = ''
  if (ai.suggestions && ai.suggestions.length > 0) {
    suggestionsHtml = `
      <div class="ai-section-subtitle">建议排查与核验动作</div>
      <ol class="ai-suggestion-list">
        ${ai.suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
      </ol>`
  }

  return `
    <div class="ai-card">
      <div class="ai-card-header">
        <div class="ai-card-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          AI 辅助解读
        </div>
        <div class="ai-card-meta">
          生成时间：${dateText} · 模型：${modelText}
          <span class="ai-card-disclaimer">仅供辅助参考 · 不作为业务结论标准</span>
        </div>
      </div>
      ${inconclusiveHtml}
      <div class="ai-observation">
        <strong>总体观察：</strong>${escapeHtml(ai.observation)}
      </div>
      ${findingsHtml}
      ${hypothesesHtml}
      ${suggestionsHtml}
    </div>`
}

// ---------------------------------------------------------------------------
// Template A: Single Scenario Execution Template (RUN)
// ---------------------------------------------------------------------------
export function renderSingleScenarioHtml(document: ReportDocument, images: ReportImage[] = []): string {
  const source = record(document.source)
  const timeZone = document.timeZone || 'Asia/Shanghai'
  const logo = images.find((img) => img.kind === 'logo')
  const screenshots = images.filter((img) => img.kind === 'screenshot')

  const logoDataUri = logo ? `data:image/jpeg;base64,${logo.body.toString('base64')}` : null
  const imageMap = new Map<string, string>()
  for (const img of screenshots) {
    imageMap.set(img.id, `data:image/jpeg;base64,${img.body.toString('base64')}`)
  }

  const stepRuns = records(source.stepRuns)
  const loops = records(source.loops)
  const outcomeResults = records(source.outcomeResults)
  const evidenceList = records(source.evidence)

  const verdict = String(source.verdict ?? source.outcomeStatus ?? 'UNKNOWN')
  const runStatus = String(source.status ?? 'UNKNOWN')
  const evidenceStatus = String(source.evidenceStatus ?? 'UNKNOWN')

  const totalSteps = stepRuns.length
  const passedSteps = stepRuns.filter((s) => s.outcomeStatus === 'PASS' && s.status === 'SUCCEEDED').length
  const failedSteps = stepRuns.filter((s) => s.outcomeStatus === 'FAIL' || s.status === 'FAILED').length

  const started = source.startedAt ?? source.createdAt
  const finished = source.finishedAt
  const durationMs = started && finished ? Math.max(0, new Date(String(finished)).getTime() - new Date(String(started)).getTime()) : null

  const summaryText = `${document.title} | 业务结论: ${labelFor(verdict)} | 步骤: ${passedSteps}/${totalSteps} 通过 | 耗时: ${formatDuration(durationMs)}`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(document.title)} · 运行报告</title>
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <div class="container">
    <!-- Top Action Bar -->
    <div class="top-bar">
      <div class="brand-logo-wrap">
        ${logoDataUri ? `<img class="brand-logo" src="${logoDataUri}" alt="Logo"/>` : ''}
        <div>
          <div class="platform-tag">识途可观测场景执行平台 · 运行报告</div>
        </div>
      </div>
      <div class="actions-group no-print">
        <button class="btn" onclick="copyText('${escapeHtml(summaryText)}', '报告摘要')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          复制总结
        </button>
        <button class="btn btn-primary" onclick="window.print()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          打印 / 另存为 PDF
        </button>
      </div>
    </div>

    <!-- Title & Identity Card -->
    <div class="header-card">
      <h1 class="header-title">${escapeHtml(document.title)}</h1>
      ${document.subtitle ? `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:12px;">${escapeHtml(document.subtitle)}</div>` : ''}
      <div class="header-meta">
        <div class="meta-item"><strong>目标系统：</strong>${escapeHtml(source.targetName ?? '-')}</div>
        <div class="meta-item"><strong>场景名称：</strong>${escapeHtml(source.scenarioName ?? '-')}</div>
        <div class="meta-item"><strong>数据截至：</strong>${formatDate(document.asOf, timeZone)}</div>
        <div class="meta-item"><strong>生成时间：</strong>${formatDate(document.generatedAt, timeZone)}</div>
        <div class="meta-item"><strong>阶段：</strong>${document.stage === 'phase' ? '阶段快照' : '终稿'}</div>
        ${document.identity ? `<div class="meta-item"><strong>修订号：</strong>修订 ${escapeHtml(document.identity.revisionNo)}</div>` : ''}
      </div>
    </div>

    <!-- L1 综合看板 -->
    <div class="section">
      <div class="grid-cards">
        <div class="stat-card">
          <div class="stat-label">业务结论</div>
          <div class="stat-value">
            <span class="badge ${badgeClass(verdict)}" style="font-size:16px;padding:6px 12px;">${labelFor(verdict)}</span>
          </div>
          <div class="stat-subtext">执行状态：${labelFor(runStatus)}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">步骤通过率</div>
          <div class="stat-value">${passedSteps} <span style="font-size:14px;color:var(--text-muted);font-weight:400;">/ ${totalSteps}</span></div>
          <div class="stat-subtext">${totalSteps > 0 ? Math.round((passedSteps / totalSteps) * 100) : 0}% 步骤成功流转</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">总执行耗时</div>
          <div class="stat-value">${formatDuration(durationMs)}</div>
          <div class="stat-subtext">开始: ${formatDate(started, timeZone).split(' ')[1] || '-'}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">证据结算</div>
          <div class="stat-value">
            <span class="badge ${badgeClass(evidenceStatus)}">${labelFor(evidenceStatus)}</span>
          </div>
          <div class="stat-subtext">截图: ${screenshots.length} 张 · 证据项: ${evidenceList.length}</div>
        </div>
      </div>
    </div>

    ${renderAiInterpretationCard(document.aiInterpretation, timeZone)}

    <!-- L2 步骤执行流水与断言矩阵 -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          步骤执行流水与断言矩阵
        </div>
        <div class="filter-pills no-print">
          <button class="pill active" onclick="filterItems('.step-row', 'data-status', 'ALL', this)">全部 (${totalSteps})</button>
          <button class="pill" onclick="filterItems('.step-row', 'data-status', 'FAIL', this)">仅异常 (${failedSteps})</button>
          <button class="pill" onclick="filterItems('.step-row', 'data-status', 'PASS', this)">仅通过 (${passedSteps})</button>
        </div>
      </div>

      <div class="table-card">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width:50px;">序号</th>
                <th>步骤 / 断言描述</th>
                <th style="width:110px;">执行状态</th>
                <th style="width:100px;">业务结论</th>
                <th style="width:100px;">单步耗时</th>
                <th style="width:90px;">截图</th>
              </tr>
            </thead>
            <tbody>
              ${stepRuns.map((step, idx) => {
                const sOutcome = String(step.outcomeStatus ?? 'NOT_EVALUATED')
                const sStatus = String(step.status ?? 'UNKNOWN')
                const stepAttempts = records(step.attempts)
                const lastAttempt = stepAttempts[stepAttempts.length - 1]
                const stepDuration = lastAttempt?.durationMs != null ? formatDuration(Number(lastAttempt.durationMs)) : '-'
                const hasImg = screenshots.some((img) => img.caption && img.caption.includes(String(step.name)))

                return `
                <tr class="step-row" data-status="${sOutcome === 'FAIL' || sStatus === 'FAILED' ? 'FAIL' : 'PASS'}">
                  <td class="table-num">${idx + 1}</td>
                  <td>
                    <strong>${escapeHtml(step.name)}</strong>
                    ${step.skipReason ? `<div style="font-size:11px;color:var(--text-muted);">跳过原因：${escapeHtml(step.skipReason)}</div>` : ''}
                  </td>
                  <td><span class="badge ${badgeClass(sStatus)}">${labelFor(sStatus)}</span></td>
                  <td><span class="badge ${badgeClass(sOutcome)}">${labelFor(sOutcome)}</span></td>
                  <td>${stepDuration}</td>
                  <td>${hasImg ? `<span class="badge badge-info" style="font-size:11px;">有快照</span>` : '-'}</td>
                </tr>`
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- L3 步骤深度排查与证据回溯 -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          步骤深度排查与操作快照
        </div>
      </div>

      ${stepRuns.map((step, idx) => {
        const sOutcome = String(step.outcomeStatus ?? 'NOT_EVALUATED')
        const sStatus = String(step.status ?? 'UNKNOWN')
        const attempts = records(step.attempts)
        const matchedResults = outcomeResults.filter((r) => r.stepRunId === step.id)
        const stepLoop = loops.find((l) => l.headerStepRunId === step.id)
        const stepScreenshots = screenshots.filter((img) => img.caption && img.caption.includes(String(step.name)))

        return `
        <details class="step-accordion" ${idx === 0 || sOutcome === 'FAIL' || sStatus === 'FAILED' ? 'open' : ''}>
          <summary class="step-summary">
            <div class="step-header-left">
              <span class="step-idx">#${idx + 1}</span>
              <span class="step-name">${escapeHtml(step.name)}</span>
            </div>
            <div class="step-header-right">
              <span class="badge ${badgeClass(sStatus)}">${labelFor(sStatus)}</span>
              <span class="badge ${badgeClass(sOutcome)}">${labelFor(sOutcome)}</span>
              <svg class="step-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </summary>
          <div class="step-body">
            <!-- Outcome Assertions -->
            ${matchedResults.length ? `
              <div style="margin-bottom:12px;">
                <div style="font-weight:600;margin-bottom:4px;color:var(--text-secondary);font-size:12px;">断言判定：</div>
                ${matchedResults.map((res) => `
                  <div style="margin-bottom:4px;">
                    <span class="badge ${badgeClass(res.verdict)}">${labelFor(res.verdict)}</span>
                    <span style="margin-left:6px;font-weight:500;">${escapeHtml(res.meaning)}</span>
                    ${res.evidenceId ? `<span class="kv-tag"><span class="kv-key">证据:</span><span class="kv-val">${escapeHtml(res.evidenceId)}</span></span>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <!-- Loop Details if any -->
            ${stepLoop ? `
              <div style="margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;">
                <div style="font-weight:600;font-size:12px;color:var(--text-secondary);">循环处理（共 ${escapeHtml(stepLoop.total)} 项）：</div>
                <div style="font-size:12px;margin-top:2px;">成功: ${escapeHtml(stepLoop.succeeded)} · 失败: ${escapeHtml(stepLoop.failed)} · 跳过: ${escapeHtml(stepLoop.skipped)}</div>
              </div>
            ` : ''}

            <!-- Attempt History -->
            ${attempts.length ? `
              <div style="margin-bottom:12px;">
                <div style="font-weight:600;margin-bottom:4px;color:var(--text-secondary);font-size:12px;">执行尝试流水：</div>
                ${attempts.map((att, aIdx) => {
                  const err = record(att.error)
                  return `
                  <div style="padding:6px 10px;background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:4px;font-size:12px;">
                    <div style="display:flex;justify-content:space-between;">
                      <span>尝试 ${aIdx + 1} (${escapeHtml(att.id)})</span>
                      <span class="badge ${badgeClass(att.status)}">${labelFor(att.status)}</span>
                    </div>
                    ${err.message ? `<div style="color:#e11d48;margin-top:4px;font-family:var(--font-mono);">${escapeHtml(err.code)}: ${escapeHtml(err.message)}</div>` : ''}
                  </div>`
                }).join('')}
              </div>
            ` : ''}

            <!-- Inline Screenshots -->
            ${stepScreenshots.length ? `
              <div>
                <div style="font-weight:600;margin-bottom:6px;color:var(--text-secondary);font-size:12px;">操作快照（点击放大）：</div>
                <div class="screenshot-gallery">
                  ${stepScreenshots.map((img) => {
                    const uri = imageMap.get(img.id) || ''
                    return `
                    <div class="thumb-card" onclick="openLightbox('${uri}', '${escapeHtml(img.caption)}')">
                      <img class="thumb-img" src="${uri}" alt="${escapeHtml(img.caption)}"/>
                      <div class="thumb-caption">${escapeHtml(img.caption)}</div>
                    </div>`
                  }).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        </details>`
      }).join('')}
    </div>

    <!-- L4 全量截图画廊 (如果包含未关联截图) -->
    ${screenshots.length ? `
      <div class="section">
        <div class="section-header">
          <div class="section-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            全量证据快照画廊 (${screenshots.length} 张)
          </div>
        </div>
        <div class="screenshot-gallery">
          ${screenshots.map((img) => {
            const uri = imageMap.get(img.id) || ''
            return `
            <div class="thumb-card" onclick="openLightbox('${uri}', '${escapeHtml(img.caption)}')">
              <img class="thumb-img" src="${uri}" alt="${escapeHtml(img.caption)}"/>
              <div class="thumb-caption">${escapeHtml(img.caption)}</div>
            </div>`
          }).join('')}
        </div>
      </div>
    ` : ''}

    <!-- Gaps or Warnings if any -->
    ${document.gaps && document.gaps.length ? `
      <div class="section" style="padding:16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
        <strong style="color:#92400e;">缺项说明：</strong>
        <ul style="margin-left:20px;color:#b45309;font-size:13px;margin-top:6px;">
          ${document.gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}
        </ul>
      </div>
    ` : ''}
  </div>

  <!-- Lightbox Modal -->
  <div id="lightbox-overlay" class="lightbox-overlay" onclick="closeLightbox(event)">
    <button class="lightbox-close" onclick="closeLightbox(event)">&times;</button>
    <img id="lightbox-img" class="lightbox-content" src="" alt="放大图"/>
    <div id="lightbox-cap" class="lightbox-caption"></div>
  </div>

  <!-- Toast -->
  <div id="toast" class="toast"></div>

  <script>${SHARED_SCRIPT}</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Template B: Scenario Suite Inspection Template (SUITE_RUN)
// ---------------------------------------------------------------------------
export function renderSuiteInspectionHtml(document: ReportDocument, images: ReportImage[] = []): string {
  const source = record(document.source)
  const timeZone = document.timeZone || 'Asia/Shanghai'
  const logo = images.find((img) => img.kind === 'logo')
  const logoDataUri = logo ? `data:image/jpeg;base64,${logo.body.toString('base64')}` : null

  const suiteSummary = document.sections
    .flatMap((sec) => sec.blocks)
    .find((b) => b.type === 'suite_business_summary') as Record<string, JsonValue> | undefined

  const healthScore = suiteSummary ? Number(suiteSummary.healthScore ?? 100) : 100
  const healthGrade = suiteSummary ? String(suiteSummary.healthGrade ?? 'EXCELLENT') : 'EXCELLENT'
  const totalCount = suiteSummary ? Number(suiteSummary.totalCount ?? 0) : 0
  const normalCount = suiteSummary ? Number(suiteSummary.normalCount ?? 0) : 0
  const warningCount = suiteSummary ? Number(suiteSummary.warningCount ?? 0) : 0
  const anomalousCount = suiteSummary ? Number(suiteSummary.anomalousCount ?? 0) : 0
  const skippedCount = suiteSummary ? Number(suiteSummary.skippedCount ?? 0) : 0

  const wallClockMs = suiteSummary ? Number(suiteSummary.wallClockMs ?? 0) : 0
  const childDurationMs = suiteSummary ? Number(suiteSummary.childDurationMs ?? 0) : 0
  const savedPercent = suiteSummary ? Number(suiteSummary.savedPercent ?? 0) : 0

  const gridRows = suiteSummary ? records(suiteSummary.gridRows) : []
  const findings = suiteSummary ? records(suiteSummary.aggregatedFindings) : []
  const items = records(source.items)

  const summaryText = `${document.title} | 综合健康度: ${healthScore}分 (${labelFor(healthGrade)}) | 模块: ${normalCount}/${totalCount} 正常 | 并发节约: ${savedPercent}%`

  const gradeColor = healthScore >= 90 ? '#059669' : healthScore >= 75 ? '#0284c7' : healthScore >= 60 ? '#d97706' : '#dc2626'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(document.title)} · 场景集巡检总报告</title>
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <div class="container">
    <!-- Top Action Bar -->
    <div class="top-bar">
      <div class="brand-logo-wrap">
        ${logoDataUri ? `<img class="brand-logo" src="${logoDataUri}" alt="Logo"/>` : ''}
        <div>
          <div class="platform-tag">识途可观测场景执行平台 · 场景集巡检总报告</div>
        </div>
      </div>
      <div class="actions-group no-print">
        <button class="btn" onclick="copyText('${escapeHtml(summaryText)}', '巡检总结')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          复制巡检总结
        </button>
        <button class="btn btn-primary" onclick="window.print()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          打印 / 另存为 PDF
        </button>
      </div>
    </div>

    <!-- Title Card -->
    <div class="header-card">
      <h1 class="header-title">${escapeHtml(document.title)}</h1>
      ${document.subtitle ? `<div style="font-size:14px;color:var(--text-secondary);margin-bottom:12px;">${escapeHtml(document.subtitle)}</div>` : ''}
      <div class="header-meta">
        <div class="meta-item"><strong>目标系统：</strong>${escapeHtml(source.targetName ?? '-')}</div>
        <div class="meta-item"><strong>场景集名称：</strong>${escapeHtml(source.suiteName ?? '-')}</div>
        <div class="meta-item"><strong>数据截至：</strong>${formatDate(document.asOf, timeZone)}</div>
        <div class="meta-item"><strong>生成时间：</strong>${formatDate(document.generatedAt, timeZone)}</div>
        <div class="meta-item"><strong>总结论：</strong><span class="badge ${badgeClass(source.verdict)}">${labelFor(source.verdict)}</span></div>
      </div>
    </div>

    <!-- L0 决策与综合健康度看板 -->
    <div class="section">
      <div class="grid-cards">
        <div class="stat-card" style="grid-column: span 2;">
          <div class="stat-label">系统综合健康度打分</div>
          <div class="score-hero">
            <div class="score-circle" style="color: ${gradeColor}; border-color: ${gradeColor};">
              <span class="score-val">${healthScore}</span>
              <span class="score-max">/ 100</span>
            </div>
            <div>
              <div style="font-size:18px;font-weight:700;color:${gradeColor};">
                评级：${labelFor(healthGrade)} (${healthGrade})
              </div>
              <div class="stat-subtext" style="margin-top:6px;">
                覆盖 ${totalCount} 模块 · 正常 ${normalCount} · 警告 ${warningCount} · 异常 ${anomalousCount} · 跳过 ${skippedCount}
              </div>
            </div>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-label">真实执行耗时 (墙钟)</div>
          <div class="stat-value">${formatDuration(wallClockMs)}</div>
          <div class="stat-subtext">串行累计工时: ${formatDuration(childDurationMs)}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">并发调度节省率</div>
          <div class="stat-value" style="color:#0284c7;">
            ⚡ ${savedPercent}%
          </div>
          <div class="stat-subtext">有效缩短巡检等待时间</div>
        </div>
      </div>
    </div>

    ${renderAiInterpretationCard(document.aiInterpretation, timeZone)}

    <!-- L1 核心业务巡检对照总表 -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
          核心业务巡检对照总表
        </div>
        <div class="filter-pills no-print">
          <button class="pill active" onclick="filterItems('.grid-row', 'data-status', 'ALL', this)">全部 (${gridRows.length})</button>
          <button class="pill" onclick="filterItems('.grid-row', 'data-status', 'ANOMALOUS', this)">仅异常 (${anomalousCount})</button>
          <button class="pill" onclick="filterItems('.grid-row', 'data-status', 'WARNING', this)">仅警告 (${warningCount})</button>
          <button class="pill" onclick="filterItems('.grid-row', 'data-status', 'NORMAL', this)">仅正常 (${normalCount})</button>
        </div>
      </div>

      <div class="table-card">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width:45px;">序号</th>
                <th style="width:140px;">子系统 / 场景</th>
                <th style="width:160px;">检查项</th>
                <th style="width:90px;">状态</th>
                <th>核心业务数据 / 指标</th>
                <th>结论与耗时</th>
              </tr>
            </thead>
            <tbody>
              ${gridRows.map((row) => {
                const ord = Number(row.ordinal ?? 0) + 1
                const status = String(row.status ?? 'NORMAL')
                const metrics = record(row.metrics)
                const dataRow = record(row.dataRow)
                const mKeys = Object.keys(metrics)
                const dKeys = Object.keys(dataRow)
                const dur = row.durationMs != null ? formatDuration(Number(row.durationMs)) : '-'

                return `
                <tr class="grid-row" data-status="${status}">
                  <td class="table-num">${ord}</td>
                  <td><strong>${escapeHtml(row.scenarioName)}</strong></td>
                  <td>${escapeHtml(row.displayName)}</td>
                  <td><span class="badge ${badgeClass(status)}">${labelFor(status)}</span></td>
                  <td>
                    ${mKeys.map((k) => `<span class="kv-tag"><span class="kv-key">${escapeHtml(k)}:</span><span class="kv-val">${escapeHtml(metrics[k])}</span></span>`).join('')}
                    ${dKeys.map((k) => `<span class="kv-tag"><span class="kv-key">${escapeHtml(k)}:</span><span class="kv-val">${escapeHtml(typeof dataRow[k] === 'object' ? JSON.stringify(dataRow[k]) : String(dataRow[k]))}</span></span>`).join('')}
                    ${!mKeys.length && !dKeys.length ? '<span style="color:var(--text-muted);">-</span>' : ''}
                  </td>
                  <td>
                    <div>${escapeHtml(row.summary || '-')}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">耗时: ${dur}</div>
                  </td>
                </tr>`
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- L2 跨场景核心异常与排查建议 -->
    ${findings.length ? `
      <div class="section">
        <div class="section-header">
          <div class="section-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            跨场景聚合核心异常 (${findings.length})
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${findings.map((f) => {
            const sev = String(f.severity ?? 'HIGH')
            return `
            <div style="background:#ffffff;border:1px solid #fecdd3;border-left:4px solid #e11d48;border-radius:8px;padding:16px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div style="font-weight:700;font-size:14px;color:#9f1239;">
                  [${escapeHtml(f.displayName)}] ${escapeHtml(f.title)}
                </div>
                <span class="badge ${badgeClass(sev)}">${labelFor(sev)}</span>
              </div>
              ${f.detail ? `<div style="font-size:13px;color:var(--text-primary);margin-bottom:6px;">${escapeHtml(f.detail)}</div>` : ''}
              ${f.evidenceId ? `<div style="font-size:12px;color:var(--text-muted);">现场证据编号: <code>${escapeHtml(f.evidenceId)}</code></div>` : ''}
            </div>`
          }).join('')}
        </div>
      </div>
    ` : ''}

    <!-- L3 场景集成员执行追踪 -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          各场景成员执行追踪 (${items.length})
        </div>
      </div>
      <div class="table-card">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width:45px;">序号</th>
                <th>成员名称</th>
                <th style="width:110px;">准入状态</th>
                <th style="width:110px;">运行状态</th>
                <th style="width:110px;">业务结论</th>
                <th>子运行编号</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((item, idx) => `
                <tr>
                  <td class="table-num">${idx + 1}</td>
                  <td><strong>${escapeHtml(item.displayName)}</strong></td>
                  <td><span class="badge ${badgeClass(item.admission)}">${labelFor(item.admission)}</span></td>
                  <td><span class="badge ${badgeClass(item.runStatus)}">${labelFor(item.runStatus)}</span></td>
                  <td><span class="badge ${badgeClass(item.outcomeStatus)}">${labelFor(item.outcomeStatus)}</span></td>
                  <td><code style="font-size:11px;">${escapeHtml(item.childRunId ?? '-')}</code></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast" class="toast"></div>

  <script>${SHARED_SCRIPT}</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Unified HTML Renderer Entry Point
// ---------------------------------------------------------------------------
export function renderReportHtml(document: ReportDocument, images: ReportImage[] = []): string {
  if (document.source && document.source.kind === 'SUITE_RUN') {
    return renderSuiteInspectionHtml(document, images)
  }
  return renderSingleScenarioHtml(document, images)
}
