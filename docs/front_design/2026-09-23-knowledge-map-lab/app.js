/* 独立视觉样本：所有数据均为受控演示数据，不连接识途 API。 */
const DEMO = {
  customer: {
    name: '客户中心', version: '知识投影 r18', computedAt: '2026-09-23 10:42',
    pages: [
      { id: 'orders', name: '订单页', route: '/orders', glyph: '单', x: 25, y: 25, w: 360, h: 275,
        objects: [
          { id: 'order-number', name: '订单编号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-22 16:35', changeCount: 0, dimensions: ['已确认','已确认','已观察','未覆盖'], confirmed: [['S-001','创建客户订单']], potential: [], unknown: 1 },
          { id: 'order-status', name: '订单状态', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-22 16:35', changeCount: 0, dimensions: ['已确认','已确认','已观察','已验证'], confirmed: [['S-017','订单状态同步'],['S-032','销售日报巡检']], potential: [], unknown: 1 },
          { id: 'submit-order', name: '提交按钮', kind: '按钮', lifecycle: 'DEGRADED', needsReview: true, evidence: 'partial', lastVerified: '2026-09-21 16:28', changeCount: 1, dimensions: ['已确认','待复核','已观察','未覆盖'], confirmed: [['S-001','创建客户订单'],['S-008','批量订单录入'],['S-017','订单状态同步']], potential: [['S-032','销售日报巡检']], unknown: 2 },
          { id: 'cancel-order', name: '取消按钮', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-22 16:35', changeCount: 0, dimensions: ['已确认','已确认','已观察','未覆盖'], confirmed: [['S-008','批量订单录入']], potential: [], unknown: 0 },
        ] },
      { id: 'customers', name: '客户页', route: '/customers', glyph: '客', x: 415, y: 25, w: 360, h: 275,
        objects: [
          { id: 'customer-id', name: '客户编号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-20 09:12', changeCount: 0, dimensions: ['已确认','已确认','已观察','未覆盖'], confirmed: [['S-001','创建客户订单']], potential: [], unknown: 0 },
          { id: 'customer-name', name: '客户名称', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-20 09:12', changeCount: 0, dimensions: ['已确认','已确认','已观察','未覆盖'], confirmed: [['S-001','创建客户订单'],['S-008','批量订单录入']], potential: [], unknown: 0 },
          { id: 'save-customer', name: '保存按钮', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'unavailable', lastVerified: null, changeCount: 0, dimensions: ['已发现','未验证','未验证','未覆盖'], confirmed: [], potential: [['S-051','客户资料更新']], unknown: 2 },
        ] },
      { id: 'reports', name: '报表页', route: '/reports', glyph: '表', x: 25, y: 335, w: 360, h: 275,
        objects: [
          { id: 'report-type', name: '报表类型', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-19 14:06', changeCount: 0, dimensions: ['已确认','已确认','已观察','已验证'], confirmed: [['S-032','销售日报巡检']], potential: [], unknown: 1 },
          { id: 'export-report', name: '导出按钮', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-19 14:06', changeCount: 0, dimensions: ['已确认','已确认','已观察','已验证'], confirmed: [['S-032','销售日报巡检']], potential: [], unknown: 0 },
          { id: 'generated-at', name: '生成时间', kind: '字段', lifecycle: 'DISCOVERED', evidence: 'partial', lastVerified: null, changeCount: 0, dimensions: ['已发现','未验证','未验证','未覆盖'], confirmed: [], potential: [], unknown: 2 },
        ] },
    ],
  },
  supply: {
    name: '供应链系统', version: '知识投影 r7', computedAt: '2026-09-23 09:18',
    pages: [
      { id: 'receiving', name: '入库页', route: '/receiving', glyph: '入', x: 25, y: 25, w: 360, h: 275,
        objects: [
          { id: 'receipt-number', name: '入库单号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-22 13:04', changeCount: 0, dimensions: ['已确认','已确认','已观察','已验证'], confirmed: [['S-104','新建入库单']], potential: [], unknown: 0 },
          { id: 'arrival-date', name: '到货日期', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-22 13:04', changeCount: 0, dimensions: ['已确认','已确认','已观察','未覆盖'], confirmed: [['S-104','新建入库单']], potential: [], unknown: 0 },
          { id: 'confirm-receipt', name: '确认入库', kind: '按钮', lifecycle: 'DEGRADED', needsReview: true, evidence: 'available', lastVerified: '2026-09-20 11:32', changeCount: 2, dimensions: ['已确认','待复核','已观察','未覆盖'], confirmed: [['S-104','新建入库单'],['S-108','到货核对']], potential: [['S-130','库存日报']], unknown: 1 },
        ] },
      { id: 'inventory', name: '库存页', route: '/inventory', glyph: '库', x: 415, y: 25, w: 360, h: 275,
        objects: [
          { id: 'sku', name: '商品编码', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-21 10:20', changeCount: 0, dimensions: ['已确认','已确认','已观察','已验证'], confirmed: [['S-108','到货核对']], potential: [], unknown: 1 },
          { id: 'stock-level', name: '可用库存', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-21 10:20', changeCount: 0, dimensions: ['已确认','已确认','已观察','已验证'], confirmed: [['S-130','库存日报']], potential: [], unknown: 1 },
          { id: 'refresh-stock', name: '刷新库存', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'unavailable', lastVerified: null, changeCount: 0, dimensions: ['已发现','未验证','未验证','未覆盖'], confirmed: [], potential: [['S-130','库存日报']], unknown: 1 },
        ] },
      { id: 'vendors', name: '供应商页', route: '/vendors', glyph: '供', x: 25, y: 335, w: 360, h: 275,
        objects: [
          { id: 'vendor-name', name: '供应商名称', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', lastVerified: '2026-09-18 15:44', changeCount: 0, dimensions: ['已确认','已确认','已观察','未覆盖'], confirmed: [['S-104','新建入库单']], potential: [], unknown: 0 },
          { id: 'vendor-status', name: '合作状态', kind: '字段', lifecycle: 'DISCOVERED', evidence: 'partial', lastVerified: null, changeCount: 0, dimensions: ['已发现','未验证','未验证','未覆盖'], confirmed: [], potential: [['S-108','到货核对']], unknown: 2 },
        ] },
    ],
  },
};

const state = { target: 'customer', query: '', filter: 'all', selectedId: 'submit-order', focusedScenario: null, zoom: 1, scale: 1 };
const $ = (selector) => document.querySelector(selector);
const pageZones = $('#page-zones');
const impactHub = $('#impact-hub');
const mapStage = $('#map-stage');
const mapViewport = $('#map-viewport');
const mapLinks = $('#map-links');
const inspector = $('#inspector');
const liveStatus = $('#live-status');
const statusNames = { review: '待复核', trusted: '已确认', discovered: '已发现' };
const lifecycleNames = { DEGRADED: '已降级', TRUSTED: '已确认', DISCOVERED: '已发现' };
const evidenceNames = { available: '可用', partial: '部分可用', unavailable: '不可用' };
const dimensionNames = ['身份', '定位', '动作', '业务结果'];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function currentData() { return DEMO[state.target]; }
function allObjects() { return currentData().pages.flatMap((page) => page.objects.map((object) => ({ ...object, page }))); }
function selectedObject() { return allObjects().find((object) => object.id === state.selectedId) || null; }
function visualStatus(object) {
  if (object.needsReview || object.lifecycle === 'DEGRADED' || object.lifecycle === 'STALE') return 'review';
  if (object.lifecycle === 'TRUSTED' || object.lifecycle === 'VERIFIED') return 'trusted';
  return 'discovered';
}
function visiblePages() {
  const query = state.query.trim().toLocaleLowerCase();
  return currentData().pages.map((page) => {
    const pageMatch = page.name.toLocaleLowerCase().includes(query) || page.route.toLocaleLowerCase().includes(query);
    const objects = page.objects.filter((object) =>
      (state.filter === 'all' || visualStatus(object) === state.filter) &&
      (!query || pageMatch || object.name.toLocaleLowerCase().includes(query)),
    );
    return { ...page, objects };
  }).filter((page) => page.objects.length > 0);
}
function announce(message) { liveStatus.textContent = message; }

function renderPageZone(page) {
  const nodeMarkup = page.objects.map((object) => {
    const visual = visualStatus(object);
    const selected = object.id === state.selectedId;
    return `<button class="object-node ${selected ? 'is-selected' : ''}" type="button" data-node-id="${escapeHtml(object.id)}" data-visual="${visual}" aria-pressed="${selected}" title="${escapeHtml(object.name)}，${statusNames[visual]}">
      <span class="node-kind">${escapeHtml(object.kind)}</span><span><span class="node-label">${escapeHtml(object.name)}</span><span class="node-status">${statusNames[visual]}</span></span>
    </button>`;
  }).join('');
  return `<section class="page-zone" aria-label="${escapeHtml(page.name)}的对象" style="left:${page.x}px;top:${page.y}px;width:${page.w}px;height:${page.h}px">
    <div class="zone-head"><div class="zone-name"><span class="zone-icon" aria-hidden="true">${escapeHtml(page.glyph)}</span><h3>${escapeHtml(page.name)}</h3></div><span class="zone-route">${escapeHtml(page.route)}</span></div>
    <div class="zone-nodes">${nodeMarkup}</div>
    <div class="zone-foot"><span><i class="tiny-dot"></i>当前视野 ${page.objects.length} 个对象</span><span>页面归属</span></div>
  </section>`;
}
function impactEntries(object) {
  return [
    ...object.confirmed.map(([id, name]) => ({ id, name, grade: 'confirmed' })),
    ...object.potential.map(([id, name]) => ({ id, name, grade: 'potential' })),
  ];
}
function renderHub(object) {
  if (!object) { impactHub.innerHTML = ''; return; }
  const entries = impactEntries(object);
  impactHub.innerHTML = `<div class="hub-header"><strong>关联场景</strong><small>选中对象 · ${escapeHtml(object.name)}</small></div>
    ${entries.length ? `<div class="hub-rows">${entries.map((entry) => `<button type="button" class="impact-row ${entry.grade === 'potential' ? 'potential' : ''} ${state.focusedScenario === entry.id ? 'is-focused' : ''}" data-scenario-id="${escapeHtml(entry.id)}" aria-pressed="${state.focusedScenario === entry.id}" title="聚焦${escapeHtml(entry.name)}的引用关系"><span><strong>${escapeHtml(entry.name)}</strong><small>${entry.grade === 'confirmed' ? '明确引用' : '可能匹配'}</small></span><b aria-hidden="true">⌖</b></button>`).join('')}</div>` : '<p class="hub-empty">当前没有可展示的关联场景</p>'}
    <div class="hub-unknown">${object.unknown ? `另有 ${object.unknown} 条覆盖未知；没有证据确认其引用关系，因此不绘制连线。` : '当前没有覆盖未知项。'}</div>`;
}
function renderInspector(object) {
  if (!object) { inspector.innerHTML = '<p class="inspector-empty">选择页面中的对象查看知识与引用。</p>'; return; }
  const visual = visualStatus(object);
  const entries = impactEntries(object);
  const intro = visual === 'review' ? '检测到对象变化，关联场景需要核对；这不表示场景执行失败。' :
    visual === 'trusted' ? '这个对象有已确认的知识记录，可以查看它的引用与证据。' : '目前只发现了这个对象，部分属性仍待验证。';
  inspector.innerHTML = `<div class="inspector-top">
      <div class="inspector-kicker">ASSET INSIGHT · 对象详情</div>
      <div class="inspector-titleline"><span class="detail-icon" aria-hidden="true">${escapeHtml(object.kind)}</span><div class="detail-title"><h2>${escapeHtml(object.name)}</h2><p>${escapeHtml(object.page.name)} · ${escapeHtml(object.kind)}</p></div></div>
      <span class="detail-state ${visual}"><span class="tiny-dot"></span>${statusNames[visual]}</span>
      <p class="detail-summary">${intro}</p>
    </div>
    <div class="inspector-scroll">
      <section class="detail-section"><div class="detail-section-title"><h3>知识状态</h3><span>当前投影</span></div><div class="fact-grid">
        <div class="fact"><small>生命周期</small><strong>${lifecycleNames[object.lifecycle] || object.lifecycle}</strong></div>
        <div class="fact"><small>最近验证</small><strong>${object.lastVerified || '暂无'}</strong></div>
        <div class="fact"><small>证据可用性</small><strong>${evidenceNames[object.evidence]}</strong></div>
        <div class="fact"><small>变化记录</small><strong>${object.changeCount} 条</strong></div>
      </div></section>
      <section class="detail-section"><div class="detail-section-title"><h3>验证维度</h3><span>逐项判断</span></div><div class="dimension-list">${object.dimensions.map((value, index) => `<div class="dimension-item"><span>${dimensionNames[index]}</span><strong class="${value === '待复核' || value === '未验证' ? 'warning' : ''}">${escapeHtml(value)}</strong></div>`).join('')}</div></section>
      <section class="detail-section"><div class="detail-section-title"><h3>引用与影响</h3><span>变化后需核对</span></div>
        <div class="impact-counts"><div class="impact-count"><strong>${object.confirmed.length}</strong><span>明确引用</span></div><div class="impact-count potential"><strong>${object.potential.length}</strong><span>可能匹配</span></div><div class="impact-count unknown"><strong>${object.unknown}</strong><span>覆盖未知</span></div></div>
        ${entries.length ? `<div class="impact-list">${entries.map((entry) => `<button type="button" data-scenario-id="${escapeHtml(entry.id)}" class="${entry.grade === 'potential' ? 'potential' : ''} ${state.focusedScenario === entry.id ? 'is-focused' : ''}" aria-pressed="${state.focusedScenario === entry.id}"><span class="impact-name">${escapeHtml(entry.name)} · ${entry.grade === 'confirmed' ? '明确引用' : '可能匹配'}</span><span class="impact-id">${escapeHtml(entry.id)}</span></button>`).join('')}</div>` : '<p class="impact-note">当前没有可展示的关联场景。</p>'}
        <p class="impact-note">覆盖未知表示扫描范围还不能判断关联；可能匹配尚未确认。影响提示用于安排检查。</p>
      </section>
    </div>
    <div class="detail-actions"><button class="primary-action" id="focus-relations" type="button" ${entries.length ? '' : 'disabled'}>${entries.length ? (state.focusedScenario ? '取消场景聚焦' : '聚焦引用关系') : '暂无可聚焦的引用'}</button><p>演示交互 · 不会修改知识资产</p></div>`;
}
function updateSummary(pages) {
  const count = pages.reduce((total, page) => total + page.objects.length, 0);
  $('#map-scope').textContent = `当前视野：${pages.length} 个页面 · ${count} 个对象`;
  $('#view-version').textContent = currentData().version;
  $('#computed-at').textContent = `计算于 ${currentData().computedAt}`;
}
function render() {
  const pages = visiblePages();
  const visibleIds = pages.flatMap((page) => page.objects.map((object) => object.id));
  if (!visibleIds.includes(state.selectedId)) { state.selectedId = visibleIds[0] || null; state.focusedScenario = null; }
  const object = selectedObject();
  updateSummary(pages);
  pageZones.innerHTML = pages.map(renderPageZone).join('');
  $('#map-empty').hidden = pages.length > 0;
  impactHub.hidden = pages.length === 0;
  renderHub(object);
  renderInspector(object);
  document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
  requestAnimationFrame(() => { fitStage(); drawLinks(); });
}

function isCompact() { return window.matchMedia('(max-width: 800px)').matches; }
function fitStage() {
  $('#zoom-reset').textContent = `${Math.round(state.zoom * 100)}%`;
  if (isCompact()) { state.scale = 1; mapStage.style.transform = ''; return; }
  const fit = Math.min((mapViewport.clientWidth - 22) / 800, (mapViewport.clientHeight - 20) / 640, 1);
  state.scale = Math.max(.1, fit * state.zoom);
  mapStage.style.transform = `translate(-50%, -50%) scale(${state.scale})`;
}
function localPoint(element, mode = 'right') {
  const rect = element.getBoundingClientRect();
  const stageRect = mapStage.getBoundingClientRect();
  const x = mode === 'left' ? rect.left : mode === 'top' || mode === 'bottom' ? rect.left + rect.width / 2 : rect.right;
  const y = mode === 'bottom' ? rect.bottom : mode === 'top' ? rect.top : rect.top + rect.height / 2;
  return { x: (x - stageRect.left) / state.scale, y: (y - stageRect.top) / state.scale };
}
function drawLinks() {
  mapLinks.replaceChildren();
  if (isCompact() || !state.selectedId) return;
  const source = pageZones.querySelector(`[data-node-id="${state.selectedId}"]`);
  if (!source) return;
  impactHub.querySelectorAll('[data-scenario-id]').forEach((target) => {
    const potential = target.classList.contains('potential');
    const focused = state.focusedScenario === target.dataset.scenarioId;
    const muted = Boolean(state.focusedScenario && !focused);
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const forward = sourceRect.right < targetRect.left - 24;
    const a = localPoint(source, forward ? 'right' : 'bottom');
    const b = localPoint(target, forward ? 'left' : 'top');
    let d;
    if (forward) {
      const bend = Math.max(55, Math.min(160, (b.x - a.x) * .48));
      d = `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
    } else {
      const bend = Math.max(45, (b.y - a.y) * .5);
      d = `M ${a.x} ${a.y} C ${a.x} ${a.y + bend}, ${b.x} ${b.y - bend}, ${b.x} ${b.y}`;
    }
    for (const className of ['link-halo', potential ? 'link-potential' : 'link-confirmed']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `${className}${muted ? ' link-muted' : ''}${focused && className !== 'link-halo' ? ' link-active' : ''}`);
      mapLinks.appendChild(path);
    }
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(b.x)); dot.setAttribute('cy', String(b.y)); dot.setAttribute('r', focused ? '4' : '3');
    dot.setAttribute('class', `link-end${potential ? ' potential' : ''}${muted ? ' link-muted' : ''}`);
    mapLinks.appendChild(dot);
  });
}
function selectNode(id) {
  if (id === state.selectedId) return;
  state.selectedId = id;
  state.focusedScenario = null;
  render();
  const object = selectedObject();
  if (object) announce(`已选择${object.page.name}的${object.name}`);
}
function toggleScenario(id) {
  state.focusedScenario = state.focusedScenario === id ? null : id;
  render();
  const entry = selectedObject() && impactEntries(selectedObject()).find((item) => item.id === id);
  announce(state.focusedScenario && entry ? `已聚焦${entry.grade === 'confirmed' ? '明确引用' : '可能匹配'}：${entry.name}` : '已显示全部关联');
}

pageZones.addEventListener('click', (event) => {
  const node = event.target.closest('[data-node-id]');
  if (node) selectNode(node.dataset.nodeId);
});
for (const root of [impactHub, inspector]) {
  root.addEventListener('click', (event) => {
    const scenario = event.target.closest('[data-scenario-id]');
    if (scenario) { toggleScenario(scenario.dataset.scenarioId); return; }
    if (event.target.closest('#focus-relations')) {
      const object = selectedObject();
      if (!object) return;
      if (state.focusedScenario) { state.focusedScenario = null; render(); announce('已显示全部关联'); return; }
      const first = impactEntries(object)[0];
      if (first) { state.focusedScenario = first.id; render(); impactHub.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); announce(`已聚焦${first.name}`); }
      else announce('当前没有可聚焦的关联场景');
    }
  });
}
$('#target-select').addEventListener('change', (event) => {
  state.target = event.target.value;
  state.selectedId = currentData().pages[0].objects[0].id;
  state.query = ''; state.filter = 'all'; state.focusedScenario = null; state.zoom = 1;
  $('#map-search').value = '';
  render();
  announce(`已切换到${currentData().name}`);
});
$('#map-search').addEventListener('input', (event) => { state.query = event.target.value; render(); });
document.querySelector('.status-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter; state.focusedScenario = null; render();
  announce(`已筛选${button.textContent.trim()}对象`);
});
$('#clear-filters').addEventListener('click', () => { state.query = ''; state.filter = 'all'; $('#map-search').value = ''; render(); announce('已清除筛选'); });
$('#zoom-in').addEventListener('click', () => { state.zoom = Math.min(1.55, Math.round((state.zoom + .15) * 100) / 100); fitStage(); requestAnimationFrame(drawLinks); });
$('#zoom-out').addEventListener('click', () => { state.zoom = Math.max(.7, Math.round((state.zoom - .15) * 100) / 100); fitStage(); requestAnimationFrame(drawLinks); });
$('#zoom-reset').addEventListener('click', () => { state.zoom = 1; fitStage(); requestAnimationFrame(drawLinks); });
document.addEventListener('keydown', (event) => {
  const inputActive = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (event.key === '/' && !inputActive) { event.preventDefault(); $('#map-search').focus(); }
  if (event.key === 'Escape' && state.focusedScenario) { state.focusedScenario = null; render(); announce('已显示全部关联'); }
});
window.addEventListener('resize', () => { fitStage(); requestAnimationFrame(drawLinks); });
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { fitStage(); requestAnimationFrame(drawLinks); }).observe(mapViewport);

render();
