/* 独立视觉与交互样本：全部数据均为演示 fixture，不连接识途 API。 */
const TARGETS = {
  customer: {
    name: '客户中心', projection: '演示投影 r18', computedAt: '2026-09-23 10:42',
    pages: [
      { id: 'orders', name: '订单页', route: '/orders', objects: [
        { id: 'order-number', name: '订单编号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 16:35', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-001', '创建客户订单']], potential: [] },
        { id: 'order-status', name: '订单状态', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 16:35', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-017', '订单状态同步'], ['S-032', '销售日报巡检']], potential: [] },
        { id: 'submit-order', name: '提交按钮', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-21 16:28', changes: 1, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-001', '创建客户订单'], ['S-008', '批量订单录入'], ['S-017', '订单状态同步']], potential: [['S-032', '销售日报巡检']] },
        { id: 'cancel-order', name: '取消按钮', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 16:35', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-008', '批量订单录入']], potential: [] },
      ] },
      { id: 'customers', name: '客户页', route: '/customers', objects: [
        { id: 'customer-id', name: '客户编号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-20 09:12', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-001', '创建客户订单']], potential: [] },
        { id: 'customer-name', name: '客户名称', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-20 09:12', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-001', '创建客户订单'], ['S-008', '批量订单录入']], potential: [] },
        { id: 'save-customer', name: '保存按钮', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'unavailable', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-051', '客户资料更新']] },
      ] },
      { id: 'reports', name: '报表页', route: '/reports', objects: [
        { id: 'report-type', name: '报表类型', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-19 14:06', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-032', '销售日报巡检']], potential: [] },
        { id: 'export-report', name: '导出按钮', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-19 14:06', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-032', '销售日报巡检']], potential: [] },
        { id: 'generated-at', name: '生成时间', kind: '字段', lifecycle: 'DISCOVERED', evidence: 'partial', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [] },
      ] },
    ],
  },
  supply: {
    name: '供应链系统', projection: '演示投影 r7', computedAt: '2026-09-23 09:18',
    pages: [
      { id: 'receiving', name: '入库页', route: '/receiving', objects: [
        { id: 'receipt-number', name: '入库单号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 13:04', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-104', '新建入库单']], potential: [] },
        { id: 'arrival-date', name: '到货日期', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 13:04', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-104', '新建入库单']], potential: [] },
        { id: 'confirm-receipt', name: '确认入库', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'available', verified: '2026-09-20 11:32', changes: 2, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-104', '新建入库单'], ['S-108', '到货核对']], potential: [['S-130', '库存日报']] },
      ] },
      { id: 'inventory', name: '库存页', route: '/inventory', objects: [
        { id: 'sku', name: '商品编码', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 10:20', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-108', '到货核对']], potential: [] },
        { id: 'stock-level', name: '可用库存', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 10:20', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-130', '库存日报']], potential: [] },
        { id: 'refresh-stock', name: '刷新库存', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'unavailable', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-130', '库存日报']] },
      ] },
      { id: 'vendors', name: '供应商页', route: '/vendors', objects: [
        { id: 'vendor-name', name: '供应商名称', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-18 15:44', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-104', '新建入库单']], potential: [] },
        { id: 'vendor-status', name: '合作状态', kind: '字段', lifecycle: 'DISCOVERED', evidence: 'partial', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-108', '到货核对']] },
      ] },
    ],
  },
};
TARGETS.enterprise = ENTERPRISE_DEMO;

const SHAPES = {
  orders: 'M31 82 C19 69 27 50 54 40 C77 31 94 39 113 29 C135 18 158 24 182 31 C209 38 227 23 252 32 C278 41 304 49 307 69 C310 88 290 99 291 119 C291 140 263 150 237 149 C215 148 201 163 176 165 C146 168 132 152 109 153 C80 155 56 141 47 124 C40 111 35 98 31 82 Z',
  customers: 'M28 84 C19 66 33 48 60 44 C82 41 92 27 119 30 C141 33 160 17 184 26 C204 34 224 28 248 39 C278 52 309 60 308 82 C308 105 289 113 281 130 C272 147 242 154 221 148 C193 140 178 162 150 161 C128 160 104 153 82 151 C59 149 48 136 40 117 C34 104 30 93 28 84 Z',
  reports: 'M35 78 C31 58 57 41 80 42 C106 44 114 27 140 25 C163 22 178 35 202 33 C225 30 243 36 266 47 C290 58 306 71 303 89 C301 109 283 111 280 129 C276 148 251 152 227 151 C199 149 185 166 159 162 C130 159 116 148 92 153 C70 158 49 142 42 124 C36 109 33 91 35 78 Z',
};
// The enterprise fixture needs more coastlines than the three small-system islands.
// Each outline stays inside the same SVG viewBox, so labels and hit targets remain stable.
const FALLBACK_SHAPES = [
  'M29 80 C20 64 39 47 61 47 C80 48 88 29 113 32 C133 34 144 18 164 25 C181 31 188 45 210 40 C231 35 244 41 256 54 C273 67 300 65 308 85 C315 105 287 117 281 137 C272 158 245 155 225 147 C203 137 185 160 163 165 C140 171 118 152 96 153 C68 154 46 138 39 116 C35 103 37 91 29 80 Z',
  'M24 92 C20 72 42 65 56 51 C71 35 94 38 112 42 C130 47 140 29 162 25 C183 21 201 42 221 38 C248 33 262 49 272 63 C282 77 310 80 306 102 C303 119 278 125 265 141 C248 163 225 153 210 148 C191 141 174 164 152 163 C130 163 116 147 92 155 C69 161 45 146 41 125 C38 108 27 105 24 92 Z',
  'M35 73 C42 52 57 52 77 42 C99 30 108 43 128 32 C151 20 169 24 185 35 C197 42 211 29 233 33 C250 36 260 52 278 55 C298 59 307 81 298 98 C290 113 296 131 274 145 C250 160 228 146 207 153 C188 160 176 173 153 160 C133 149 118 162 95 153 C70 144 62 133 47 117 C34 103 29 90 35 73 Z',
  'M28 85 C31 69 45 58 66 55 C82 53 87 39 105 35 C128 29 140 45 155 39 C172 31 177 22 194 27 C213 33 220 46 239 44 C262 42 279 58 285 72 C290 85 310 90 308 107 C305 127 281 127 265 140 C251 153 230 146 212 151 C190 157 177 165 155 155 C137 148 122 158 101 157 C77 157 60 144 49 129 C36 113 24 100 28 85 Z',
  'M24 82 C23 60 46 49 67 46 C90 43 96 27 118 30 C141 33 150 45 168 34 C185 24 206 27 219 42 C231 56 255 46 270 58 C287 72 311 76 311 96 C310 118 294 127 275 133 C259 138 245 153 225 151 C207 149 190 162 169 165 C149 168 135 155 118 151 C100 147 80 159 60 143 C43 129 24 106 24 82 Z',
  'M32 91 C25 79 36 59 55 52 C73 45 89 53 102 41 C117 27 135 30 149 37 C166 46 180 22 197 26 C212 29 222 47 243 46 C266 46 276 62 291 72 C307 83 311 104 301 118 C287 138 268 135 253 149 C235 165 218 148 200 149 C179 150 169 166 148 162 C128 158 113 148 94 153 C72 158 51 140 43 120 C39 110 39 102 32 91 Z',
  'M29 89 C20 69 38 50 61 45 C84 40 102 38 119 29 C139 18 153 39 173 35 C194 30 202 37 220 40 C237 42 247 34 268 46 C291 59 303 72 307 90 C311 109 291 124 275 130 C257 137 260 155 238 157 C216 159 202 148 183 159 C162 172 146 154 127 155 C103 157 89 147 68 145 C45 143 40 120 36 106 C34 99 32 95 29 89 Z',
  'M32 78 C30 62 50 48 73 47 C92 46 100 27 118 30 C139 34 150 26 167 29 C185 32 192 49 211 44 C233 38 257 44 275 57 C294 72 313 86 305 104 C299 117 274 116 265 132 C256 151 236 157 216 148 C193 138 185 161 160 164 C133 167 121 151 99 154 C77 157 61 141 51 127 C42 113 30 97 32 78 Z',
  'M30 88 C25 67 46 48 71 47 C89 47 99 34 117 31 C135 27 150 42 169 32 C190 21 204 31 220 41 C237 51 252 43 272 51 C293 59 310 79 309 97 C309 119 289 128 267 135 C250 140 248 156 226 158 C202 159 185 145 167 161 C147 177 125 151 108 151 C82 152 58 142 47 125 C40 114 34 103 30 88 Z',
];
const MARKER_POSITIONS = [[19, 42], [58, 37], [31, 66], [61, 64], [43, 47], [69, 52]];
const OVERVIEW_POSTS = [[72, 99], [130, 57], [225, 67], [259, 110], [105, 131], [192, 139]];
const DIMENSION_NAMES = ['身份', '定位', '动作', '业务结果'];
const DIMENSION_LABELS = { confirmed: '确认', rejected: '否定', unknown: '未知', not_observed: '未观察' };
const EVIDENCE_NAMES = { available: '可用', partial: '部分可用', unavailable: '不可用' };
const LIFECYCLE_NAMES = { TRUSTED: '已确认', DEGRADED: '已降级', DISCOVERED: '已发现' };
const STATUS_NAMES = { review: '待复核', trusted: '已确认', discovered: '已发现' };
const state = { target: 'enterprise', level: 'atlas', districtId: null, pageId: null, objectId: null, filter: 'all', view: 'map', query: '', pageQuery: '', featureGroupId: null, focusedScenario: null, atlasScrollY: 0, pinnedSeaIndex: null };
const $ = (selector) => document.querySelector(selector);
const mapView = $('#map-view');
const detailPane = $('#detail-pane');
const mapCanvas = $('#map-canvas');

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function target() { return TARGETS[state.target]; }
function allObjects() { return target().pages.flatMap((page) => page.objects.map((object) => ({ ...object, page }))); }
function pageById(id = state.pageId) { return target().pages.find((page) => page.id === id) || null; }
function objectById(id = state.objectId) { return allObjects().find((object) => object.id === id) || null; }
function usesDistricts() { return target().pages.length > 6; }
function districts() {
  if (!usesDistricts()) return [];
  const configured = target().districts;
  if (configured?.length) {
    const groups = configured.map((district) => ({ ...district, pages: target().pages.filter((page) => page.districtId === district.id) }));
    const assigned = new Set(groups.flatMap((district) => district.pages.map((page) => page.id)));
    const remaining = target().pages.filter((page) => !assigned.has(page.id));
    if (remaining.length) groups.push({ id: 'unassigned', name: '未分组页面', description: '暂未关联演示分区', pages: remaining });
    return groups;
  }
  const groups = [];
  for (let index = 0; index < target().pages.length; index += 5) groups.push({ id: `part-${Math.floor(index / 5) + 1}`, name: `浏览分区 ${String(Math.floor(index / 5) + 1).padStart(2, '0')}`, description: '按已加载页面顺序分段', pages: target().pages.slice(index, index + 5) });
  return groups;
}
function districtById(id = state.districtId) { return districts().find((district) => district.id === id) || null; }
function districtForPage(page) { return districts().find((district) => district.pages.some((item) => item.id === page?.id)) || null; }
function visiblePageCount(district) { return district.pages.filter((page) => visibleObjects(page).length > 0).length; }
function visibleObjectCount(district) { return district.pages.reduce((sum, page) => sum + visibleObjects(page).length, 0); }
function statusOf(object) { return object.lifecycle === 'DEGRADED' ? 'review' : object.lifecycle === 'TRUSTED' ? 'trusted' : 'discovered'; }
function visibleObjects(page) { return page.objects.filter((object) => state.filter === 'all' || statusOf(object) === state.filter); }
function isButtonObject(object) { return object.kind === '按钮' || object.kind === '开关'; }
function buttonCount(page, objects = page.objects) { return objects.filter(isButtonObject).length; }
function hasDenseButtons(page) { return buttonCount(page) > MARKER_POSITIONS.length; }
function configuredFeatureGroups(page) {
  const configured = page.featureGroups || [];
  const known = new Set(configured.map((group) => group.id));
  const hasUnassigned = page.objects.some((object) => isButtonObject(object) && !known.has(object.featureGroup));
  return hasUnassigned ? [...configured, { id: 'unassigned', name: '未配置分组', description: '按钮尚无经确认的业务分组' }] : configured;
}
function featureGroups(page, objects = visibleObjects(page)) {
  const known = new Set((page.featureGroups || []).map((group) => group.id));
  return configuredFeatureGroups(page).map((group) => ({ ...group, objects: objects.filter((object) => isButtonObject(object) && (group.id === 'unassigned' ? !known.has(object.featureGroup) : object.featureGroup === group.id)) }));
}
function featureGroupName(object) { if (!isButtonObject(object)) return ''; return configuredFeatureGroups(object.page).find((group) => group.id === object.featureGroup)?.name || '未配置分组'; }
function pageStatus(page) { return page.objects.some((object) => statusOf(object) === 'review') ? 'review' : page.objects.some((object) => statusOf(object) === 'discovered') ? 'discovered' : 'trusted'; }
function relations(object) { return [...object.confirmed.map(([id, name]) => ({ id, name, grade: 'confirmed' })), ...object.potential.map(([id, name]) => ({ id, name, grade: 'potential' }))]; }
function announce(message) { $('#live-status').textContent = message; }
function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}
function seededRandom(seed) {
  let value = seed;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
function shapeFor(page) { return SHAPES[page.id] || FALLBACK_SHAPES[stableHash(`${page.id}:coastline`) % FALLBACK_SHAPES.length]; }
function islandArt(page, size = 'small') {
  const artId = `${page.id}-${size}`;
  const shape = shapeFor(page);
  const shown = visibleObjects(page);
  const posts = size === 'small' && !hasDenseButtons(page) ? OVERVIEW_POSTS.slice(0, Math.min(shown.length, 6)).map(([x, y], index) => `<g opacity="${index < 4 ? '.92' : '.7'}"><ellipse cx="${x}" cy="${y + 1}" rx="7" ry="3" fill="#408f83" opacity=".3"/><path d="M${x} ${y} V${y - 10}" stroke="#3d8c82" stroke-width="2.5" stroke-linecap="round"/><circle cx="${x}" cy="${y - 11}" r="4" fill="${statusOf(shown[index]) === 'review' ? '#f5ad4d' : statusOf(shown[index]) === 'discovered' ? '#8aacb5' : '#f7fff0'}" stroke="#4a988a" stroke-width="1.5"/></g>`).join('') : '';
  return `<svg viewBox="0 0 340 225" aria-hidden="true" focusable="false"><defs><linearGradient id="land-${artId}" x1="0" y1="0" x2=".86" y2="1"><stop offset="0" stop-color="#f5f9ec"/><stop offset=".53" stop-color="#d4ece0"/><stop offset="1" stop-color="#99d4c2"/></linearGradient><clipPath id="clip-${artId}"><path d="${shape}"/></clipPath></defs><path d="${shape}" transform="translate(0 19)" fill="#176c70" stroke="#174e58" stroke-width="3"/><path d="${shape}" transform="translate(0 10)" fill="#5baea5" stroke="#b1dfc9" stroke-width="2"/><path d="${shape}" fill="url(#land-${artId})" stroke="#ecfff0" stroke-width="2.5"/><g clip-path="url(#clip-${artId})" fill="none" stroke="#62aaa1" stroke-width="1.25" opacity=".45"><path d="M10 89 C80 55 126 66 181 51 S280 64 326 83"/><path d="M7 111 C70 79 118 83 174 72 S272 83 332 106"/><path d="M5 133 C71 109 122 110 173 99 S276 112 337 133"/><path d="M12 153 C91 127 129 138 183 124 S273 140 333 155"/></g>${posts}</svg>`;
}

function renderIntro() {
  const objects = allObjects();
  const review = objects.filter((object) => statusOf(object) === 'review').length;
  $('#intro-summary').innerHTML = `<div class="summary-item"><strong>${target().pages.length.toString().padStart(2, '0')}</strong><span>已加载页面</span></div><i class="summary-rule" aria-hidden="true"></i><div class="summary-item"><strong>${objects.length.toString().padStart(2, '0')}</strong><span>已加载对象</span></div><i class="summary-rule" aria-hidden="true"></i><div class="summary-item review"><strong>${review.toString().padStart(2, '0')}</strong><span>待复核对象</span></div>`;
  $('#map-title').textContent = `${target().name}海域`;
  $('#map-subtitle').textContent = `已加载 ${target().pages.length} 座页面岛屿${usesDistricts() ? ` · ${districts().length} 个演示分区` : ''} · ${objects.length} 个对象地标 · ${target().projection}`;
  $('#target-select').value = state.target;
  document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
  document.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
}
function renderCrumbs() {
  const page = pageById(); const object = objectById(); const district = districtById();
  const root = '全部岛屿';
  const parts = [];
  if (district || page) parts.push(`<button type="button" data-action="atlas">${root}</button>`);
  else parts.push(`<strong>${root}</strong>`);
  if (district) parts.push(page ? `<button type="button" data-action="district" data-district-id="${district.id}">${escapeHtml(district.name)}</button>` : `<strong>${escapeHtml(district.name)}</strong>`);
  if (page) parts.push(object ? `<button type="button" data-action="page" data-page-id="${page.id}">${escapeHtml(page.name)}</button>` : `<strong>${escapeHtml(page.name)}</strong>`);
  if (object) parts.push(`<strong>${escapeHtml(object.name)}</strong>`);
  $('#map-crumbs').innerHTML = parts.join('<span class="crumb-divider">/</span>');
}
// Desktop sea chart: seeded best-candidate sampling with a conservative box for
// the entire button (land illustration + metadata). Positions are percentages
// of a 250px-high sea region. The seed is derived only from stable page IDs, so
// filtering, returning from a page and re-rendering never reshuffle the map.
function seaBoxesOverlap(a, b) {
  const horizontalGap = 1.5;
  const verticalGap = 2;
  return a.x < b.x + b.width + horizontalGap && a.x + a.width + horizontalGap > b.x
    && a.y < b.y + b.height + verticalGap && a.y + a.height + verticalGap > b.y;
}
function layoutSeaRegion(district, regionIndex, previousCenters = []) {
  const boxHeight = 58; // 145px at a 250px region: includes SVG stage and meta.
  const count = district.pages.length;
  if (!count) return [];
  const maximumWidth = Math.max(12, (96 - Math.max(0, count - 1) * 1.5) / Math.max(1, count));
  const entries = district.pages.map((page) => {
    const widthNoise = stableHash(`${page.id}:width`) / 4294967295;
    const rotationNoise = stableHash(`${page.id}:angle`) / 4294967295;
    const scaleNoise = stableHash(`${page.id}:scale`) / 4294967295;
    // Loaded object volume changes island size modestly; it does not imply
    // menu priority or a physical distance between pages.
    const volumeBoost = Math.min(3, Math.max(0, Math.log2(page.objects.length + 1) - Math.log2(3)) * 1.2);
    return {
      page,
      width: Math.min(maximumWidth, 16.1 + widthNoise * 1.9 + volumeBoost),
      height: boxHeight,
      angle: -2.7 + rotationNoise * 5.4,
      artScale: .96 + scaleNoise * .06,
    };
  });
  const random = seededRandom(stableHash(`${target().name}:${district.id}:${regionIndex}:${district.pages.map((page) => page.id).join('|')}:archipelago-v1`));
  let best = null;
  let bestScore = -Infinity;
  for (let layoutAttempt = 0; layoutAttempt < 48; layoutAttempt++) {
    const placed = [];
    for (const entry of entries) {
      let position = null;
      for (let sample = 0; sample < 180; sample++) {
        const candidate = {
          ...entry,
          x: 2 + random() * (96 - entry.width),
          y: 2 + random() * (96 - entry.height),
        };
        if (placed.every((other) => !seaBoxesOverlap(candidate, other))) { position = candidate; break; }
      }
      if (!position) break;
      placed.push(position);
    }
    if (placed.length !== count) continue;
    const byX = [...placed].sort((a, b) => a.x - b.x);
    const left = byX[0].x;
    const last = byX[byX.length - 1];
    const right = last.x + last.width;
    const yValues = placed.map((item) => item.y);
    const ySpread = Math.max(...yValues) - Math.min(...yValues);
    const gaps = byX.slice(1).map((item, index) => item.x - byX[index].x - byX[index].width);
    const gapSpread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
    const alignedWithPrevious = placed.reduce((sum, item) => {
      const center = item.x + item.width / 2;
      return sum + (previousCenters.some((prior) => Math.abs(prior - center) < 5) ? 1 : 0);
    }, 0);
    const score = ySpread * .65 + gapSpread * .36 - Math.abs((right - left) - 88) * .42
      - Math.abs(left - (100 - right)) * .25 - alignedWithPrevious * 2 + random() * 1.5;
    if (score > bestScore) { best = byX; bestScore = score; }
  }
  if (!best) {
    // Bounded deterministic fallback for an unusually crowded demo region.
    const totalWidth = entries.reduce((sum, entry) => sum + entry.width, 0);
    const gap = (100 - totalWidth) / (count + 1);
    let x = gap;
    best = entries.map((entry) => {
      const position = { ...entry, x, y: 3 + (stableHash(`${entry.page.id}:fallback-y`) % 39) };
      x += entry.width + gap;
      return position;
    });
  }
  return best;
}
function seaIsland(page, index, placement) {
  const shown = visibleObjects(page);
  const review = shown.filter((object) => statusOf(object) === 'review').length;
  const discovered = shown.filter((object) => statusOf(object) === 'discovered').length;
  const isDense = hasDenseButtons(page);
  const count = isDense
    ? `${buttonCount(page, shown)} 按钮 · ${shown.length - buttonCount(page, shown)} 字段`
    : `${shown.length} ${state.filter === 'all' ? '对象' : '匹配对象'}`;
  const status = review ? `<span class="sea-island-alert is-review">${review} 待复核</span>` : discovered ? `<span class="sea-island-alert is-discovered">${discovered} 已发现</span>` : '';
  const positionStyle = `--island-x:${placement.x.toFixed(2)}%;--island-y:${placement.y.toFixed(2)}%;--island-width:${placement.width.toFixed(2)}%;--island-angle:${placement.angle.toFixed(2)}deg;--island-art-scale:${placement.artScale.toFixed(3)}`;
  return `<button class="sea-island ${shown.length ? '' : 'is-dim'} ${review ? 'is-review' : ''}" type="button" data-action="page" data-page-id="${escapeHtml(page.id)}" style="${positionStyle}" ${shown.length ? '' : 'disabled'} aria-label="进入${escapeHtml(page.name)}，${count}${review ? `，${review}个待复核` : discovered ? `，${discovered}个已发现` : ''}"><span class="sea-island-stage"><span class="sea-island-art">${islandArt(page, 'small')}</span><span class="sea-island-index">ISLAND ${String(index + 1).padStart(2, '0')}</span><span class="sea-island-copy"><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.route)}</small></span></span><span class="sea-island-meta"><span>${count}</span>${status}</span></button>`;
}
function renderDistrictOverview() {
  const groups = districts();
  let pageIndex = 0;
  let previousCenters = [];
  const regions = groups.map((district, index) => {
    const number = index + 1;
    const placement = layoutSeaRegion(district, index, previousCenters);
    previousCenters = placement.map((item) => item.x + item.width / 2);
    const islands = placement.map((item, visualIndex) => seaIsland(item.page, pageIndex + visualIndex, item)).join('');
    pageIndex += district.pages.length;
    return `<section class="sea-region" id="sea-region-${number}" aria-label="${escapeHtml(district.name)}，${district.pages.length}座页面岛屿" tabindex="-1"><div class="sea-islands" data-layout="archipelago">${islands}</div></section>`;
  }).join('');
  return `<div class="island-atlas">${regions}</div>`;
}
function renderDistrictWorld() {
  const district = districtById(); if (!district) return renderDistrictOverview();
  return `<div class="district-world"><div class="district-world-head"><div><span>SEA AREA / ${escapeHtml(district.id.toUpperCase())}</span><h3>${escapeHtml(district.name)}</h3></div><p>已加载 ${district.pages.length} 个页面 · 当前 ${visiblePageCount(district)} 个页面匹配筛选</p></div><div class="district-pages">${district.pages.map((page, index) => {
    const shown = visibleObjects(page); const review = shown.filter((object) => statusOf(object) === 'review').length;
    const countLabel = hasDenseButtons(page) ? `${buttonCount(page, shown)} 个按钮入口 · ${configuredFeatureGroups(page).length} 组` : `${shown.length} 个${state.filter === 'all' ? '对象' : '匹配对象'}`;
    return `<button class="district-page ${shown.length ? '' : 'is-dim'}" type="button" data-action="page" data-page-id="${escapeHtml(page.id)}" ${shown.length ? '' : 'disabled'} aria-label="进入${escapeHtml(page.name)}，${countLabel}${review ? `，${review}个待复核` : ''}"><span class="district-page-art">${islandArt(page, 'small')}</span><span class="district-page-copy"><small>PAGE ${String(index + 1).padStart(2, '0')}</small><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.route)}</small></span><span class="district-page-count">${countLabel}${review ? ` · ${review} 待复核` : ''}</span></button>`;
  }).join('')}</div>${visiblePageCount(district) ? '' : '<div class="map-empty"><strong>当前分区没有匹配的页面</strong><p>分区还在，换一个状态即可继续探索。</p><button type="button" data-action="clear-filter">显示全部对象</button></div>'}</div>`;
}
function renderOverview() {
  if (usesDistricts()) return renderDistrictOverview();
  const hasMatching = target().pages.some((page) => visibleObjects(page).length > 0);
  if (!hasMatching) return `<div class="map-empty"><strong>当前状态没有匹配的地标</strong><p>岛屿还在，换一个状态即可继续探索。</p><button type="button" data-action="clear-filter">显示全部对象</button></div>`;
  return `<div class="atlas-overview"><div class="overview-note"><strong>CHART 01 · 页面分布</strong><small>选择岛屿，进入页面的对象视野</small></div>${target().pages.map((page) => {
    const visible = visibleObjects(page);
    const dim = !visible.length;
    const badge = visible.filter((object) => statusOf(object) === 'review').length;
    const discovered = visible.filter((object) => statusOf(object) === 'discovered').length;
    return `<button class="island-button ${page.id}${dim ? ' is-dim' : ''}" type="button" data-action="page" data-page-id="${page.id}" ${dim ? 'disabled' : ''} aria-label="进入${escapeHtml(page.name)}，当前显示${visible.length}个对象${badge ? `，${badge}个待复核` : ''}">${islandArt(page)}<span class="island-label"><span class="island-overline">PAGE ISLAND / ${escapeHtml(page.id.toUpperCase())}</span><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.route)}</small></span><span class="island-count">${state.filter === 'all' ? page.objects.length : visible.length} 个${state.filter === 'all' ? '对象' : '匹配对象'}</span>${badge ? `<span class="island-beacon" title="${badge} 个待复核对象">${badge}</span>` : discovered ? `<span class="island-beacon discovered" title="${discovered} 个已发现对象">${discovered}</span>` : ''}</button>`;
  }).join('')}<div class="overview-serial">ATLAS / ${escapeHtml(target().projection.toUpperCase())}</div></div>`;
}
function markerMarkup(object, index) {
  const [x, y] = MARKER_POSITIONS[index % MARKER_POSITIONS.length];
  const status = statusOf(object);
  return `<button class="object-marker ${state.objectId === object.id ? 'is-selected' : ''}" type="button" data-action="object" data-object-id="${object.id}" data-status="${status}" style="left:${x}%;top:${y}%" aria-pressed="${state.objectId === object.id}" aria-label="${escapeHtml(object.name)}，${STATUS_NAMES[status]}"><span class="marker-pole" aria-hidden="true"></span><span class="marker-copy"><strong>${escapeHtml(object.name)}</strong><small>${escapeHtml(object.kind)} · ${STATUS_NAMES[status]}</small></span></button>`;
}
function renderScenePort(object, dense = false) {
  if (!object) return `<div class="scene-port is-empty"><h3>场景引用港</h3><p>先选中一个对象地标，再查看它与场景的关联。岛屿之间没有导航航线。</p></div>`;
  const entries = relations(object);
  return `<div class="scene-port"><span class="port-count">${entries.length} 条可展示</span><h3>场景引用港</h3><p>当前对象 · ${escapeHtml(object.name)}</p>${entries.length ? `<div class="scene-list">${entries.map((entry) => `<button class="scene-row ${entry.grade === 'potential' ? 'potential' : ''} ${state.focusedScenario === entry.id ? 'is-focused' : ''}" type="button" data-action="scenario" data-scenario-id="${entry.id}" aria-pressed="${state.focusedScenario === entry.id}"><span><strong>${escapeHtml(entry.name)}</strong><small>${entry.grade === 'confirmed' ? '明确引用' : '可能匹配'}</small></span><b aria-hidden="true">⌖</b></button>`).join('')}</div>` : '<p>目前没有可展示的关联场景。</p>'}<div class="unknown-note">${dense ? '高密度页面的岛图只显示功能分组；对象与场景的关系在此查看，不在海图上绘制连线。' : '目标级扫描覆盖未知时，无法判断它与此对象的关系，因此不绘制连线。'}</div></div>`;
}
function renderDensePageWorld(page, objects, object) {
  const groups = featureGroups(page, objects);
  const review = objects.filter((item) => statusOf(item) === 'review').length;
  const fields = page.objects.length - buttonCount(page);
  const zonePositions = groups.length === 1 ? [[50, 54]] : [[24, 45], [59, 39], [31, 70], [67, 67]];
  const groupNote = page.featureGroups?.length ? '演示分组' : '中性目录';
  return `<div class="page-world is-dense"><div class="page-kicker"><b>PAGE ISLAND / ${escapeHtml(page.id.toUpperCase())}</b><span>${buttonCount(page)} 个按钮入口 · ${fields} 个字段（已加载）</span></div><div class="page-island dense-page-island">${islandArt(page, 'large')}<div class="page-name-plaque"><small>LAND / ${escapeHtml(page.route)}</small><strong>${escapeHtml(page.name)}</strong><span>${page.featureGroups?.length ? '按演示功能分组浏览' : '按钮目录浏览'}</span></div><div class="dense-island-summary"><strong>${buttonCount(page)}</strong><span>按钮入口</span><i aria-hidden="true"></i><strong>${groups.length}</strong><span>${groupNote}</span>${review ? `<em>${review} 待复核</em>` : ''}</div><div class="feature-zone-layer"><div class="feature-zone">${groups.map((group, index) => {
    const [x, y] = zonePositions[index % zonePositions.length];
    const groupReview = group.objects.filter((item) => statusOf(item) === 'review').length;
    return `<button type="button" class="feature-zone-item ${group.objects.length ? '' : 'is-dim'} ${state.featureGroupId === group.id ? 'is-active' : ''}" data-action="feature-group" data-feature-group-id="${escapeHtml(group.id)}" style="--zone-x:${x}%;--zone-y:${y}%" ${group.objects.length ? '' : 'disabled'} aria-label="查看${escapeHtml(group.name)}，当前${group.objects.length}个按钮入口${groupReview ? `，${groupReview}个待复核` : ''}"><small>ZONE ${String(index + 1).padStart(2, '0')}</small><strong>${escapeHtml(group.name)}</strong><span>${group.objects.length} 个入口${groupReview ? ` · ${groupReview} 待复核` : ''}</span></button>`;
  }).join('')}</div></div></div>${object ? renderScenePort(object, true) : `<div class="scene-port dense-port"><span class="port-count">${groups.length} 组</span><h3>功能目录</h3><p>岛上只标出分组和数量。点击分组，或在右侧目录搜索、展开后选择具体按钮对象。</p><div class="unknown-note">${page.featureGroups?.length ? '分组是演示配置，不代表已从目标系统自动识别业务功能。' : '缺少经确认的分组时使用中性目录，不根据页面坐标臆测业务功能。'}</div></div>`}${objects.length ? '' : '<div class="map-empty"><strong>当前筛选下没有对象</strong><p>切换状态后，分组入口会重新出现。</p><button type="button" data-action="clear-filter">显示全部对象</button></div>'}</div>`;
}
function renderPageWorld() {
  const page = pageById(); if (!page) return renderOverview();
  const objects = visibleObjects(page);
  const object = objectById();
  if (hasDenseButtons(page)) return renderDensePageWorld(page, objects, object);
  return `<div class="page-world"><div class="page-kicker"><b>PAGE ISLAND / ${escapeHtml(page.id.toUpperCase())}</b><span>已加载 ${page.objects.length} 个对象 · 当前显示 ${objects.length} 个</span></div><div class="page-island">${islandArt(page, 'large')}<div class="page-name-plaque"><small>LAND / ${escapeHtml(page.route)}</small><strong>${escapeHtml(page.name)}</strong><span>对象地标按信息布局展示</span></div><div class="marker-layer">${objects.map(markerMarkup).join('')}</div></div>${renderScenePort(object)}<svg class="relation-lines" id="relation-lines" aria-hidden="true"></svg>${objects.length ? '' : '<div class="map-empty"><strong>当前筛选下没有对象</strong><p>切换状态后，地标会重新出现。</p><button type="button" data-action="clear-filter">显示全部对象</button></div>'}</div>`;
}
function renderEnterpriseListPage(page) {
  const shown = visibleObjects(page);
  return `<div class="list-page-entry"><button class="list-object" type="button" data-action="page" data-page-id="${escapeHtml(page.id)}"><i class="legend-dot ${state.filter === 'all' ? pageStatus(page) : state.filter}" aria-hidden="true"></i><span><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.route)} · ${hasDenseButtons(page) ? `${buttonCount(page, shown)} 个按钮入口` : `${shown.length} 对象`}</small></span></button>${hasDenseButtons(page) ? `<div class="list-feature-grid">${shown.map((object) => `<button class="list-object" type="button" data-action="object" data-object-id="${escapeHtml(object.id)}"><i class="legend-dot ${statusOf(object)}" aria-hidden="true"></i><span><strong>${escapeHtml(object.name)}</strong><small>${escapeHtml(featureGroupName({ ...object, page }) || object.kind)} · ${STATUS_NAMES[statusOf(object)]}</small></span></button>`).join('')}</div>` : ''}</div>`;
}
function renderList() {
  const pages = target().pages.filter((page) => visibleObjects(page).length > 0);
  if (!pages.length) return `<div class="map-empty"><strong>当前状态没有匹配的对象</strong><p>切换状态后，列表会重新显示。</p><button type="button" data-action="clear-filter">显示全部对象</button></div>`;
  if (usesDistricts()) return `<div class="list-world"><div class="list-heading"><div><h3>完整页面目录</h3><p>按演示分区排列，点击页面进入对象视野</p></div><small>当前显示 · ${pages.length} / ${target().pages.length} 页</small></div>${districts().filter((district) => visiblePageCount(district)).map((district) => `<section class="list-page"><button class="list-page-head" type="button" data-action="district" data-district-id="${escapeHtml(district.id)}"><span><strong>${escapeHtml(district.name)}</strong><small>${escapeHtml(district.description)}</small></span><b>${visiblePageCount(district)} 页 →</b></button><div class="list-object-grid">${district.pages.filter((page) => visibleObjects(page).length).map(renderEnterpriseListPage).join('')}</div></section>`).join('')}</div>`;
  return `<div class="list-world"><div class="list-heading"><div><h3>全部页面与对象</h3><p>按页面归属排列，快速查找与进入海图</p></div><small>当前已加载 · ${target().pages.length} 页</small></div>${pages.map((page) => `<section class="list-page"><button class="list-page-head" type="button" data-action="page" data-page-id="${page.id}"><span><strong>${escapeHtml(page.name)}</strong><small>${escapeHtml(page.route)}</small></span><b>${visibleObjects(page).length} 个对象 →</b></button><div class="list-object-grid">${visibleObjects(page).map((object) => `<button class="list-object ${state.objectId === object.id ? 'is-selected' : ''}" type="button" data-action="object" data-object-id="${object.id}"><i class="legend-dot ${statusOf(object)}" aria-hidden="true"></i><span><strong>${escapeHtml(object.name)}</strong><small>${escapeHtml(object.kind)} · ${STATUS_NAMES[statusOf(object)]}</small></span></button>`).join('')}</div></section>`).join('')}</div>`;
}
function renderMap() {
  const isLargeAtlas = usesDistricts() && state.level === 'atlas' && state.view === 'map';
  document.querySelector('.workspace').classList.toggle('is-atlas', isLargeAtlas);
  const seaNav = $('#sea-nav');
  if (isLargeAtlas) {
    mapCanvas.setAttribute('role', 'region');
    mapCanvas.setAttribute('aria-label', `页面群岛，共${target().pages.length}座页面岛屿`);
    const selected = state.pinnedSeaIndex || 1;
    seaNav.innerHTML = districts().map((district, index) => `<button type="button" class="sea-jump ${index + 1 === selected ? 'is-active' : ''}" data-action="jump-district" data-sea-index="${index + 1}" ${index + 1 === selected ? 'aria-current="location"' : ''} aria-label="定位到${escapeHtml(district.name)}海域，${district.pages.length}座页面岛"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(district.name)}</button>`).join('');
    seaNav.hidden = false;
  } else {
    mapCanvas.removeAttribute('role');
    mapCanvas.removeAttribute('aria-label');
    seaNav.hidden = true;
    seaNav.innerHTML = '';
  }
  $('#map-help').textContent = isLargeAtlas ? '向下滚动浏览更多岛屿 · 空间位置不代表网页坐标' : '空间位置仅用于分组 · 不是网页坐标';
  mapView.innerHTML = state.view === 'list' ? renderList() : state.level === 'atlas' ? renderOverview() : state.level === 'district' ? renderDistrictWorld() : renderPageWorld();
  requestAnimationFrame(() => { drawRelations(); updateSeaJump(); });
}
function updateSeaJump() {
  if (!(usesDistricts() && state.level === 'atlas' && state.view === 'map')) return;
  const sections = [...mapView.querySelectorAll('.sea-region')];
  if (!sections.length) return;
  // Clicked navigation is intentional: several regions can share the same
  // maximum scroll position. Natural scrolling resumes viewport tracking.
  const threshold = window.innerHeight * .55;
  let current = 1;
  sections.forEach((section, index) => { if (section.getBoundingClientRect().top <= threshold) current = index + 1; });
  const last = sections[sections.length - 1].getBoundingClientRect();
  if (last.top < window.innerHeight * .82 && last.bottom <= window.innerHeight + 2) current = sections.length;
  if (window.scrollY <= 4) current = 1;
  if (state.pinnedSeaIndex) current = state.pinnedSeaIndex;
  document.querySelectorAll('#sea-nav .sea-jump').forEach((button) => {
    const active = Number(button.dataset.seaIndex) === current;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  });
}
function jumpToSea(index) {
  const section = document.getElementById(`sea-region-${index}`);
  if (!section) return;
  state.pinnedSeaIndex = index;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  section.scrollIntoView({ behavior, block: 'start' });
  section.focus({ preventScroll: true });
  const district = districts()[index - 1];
  announce(`已定位${district?.name || '目标'}海域，${district?.pages.length || 0}座页面岛屿`);
  updateSeaJump();
}
function clearSeaPin() {
  if (!(usesDistricts() && state.level === 'atlas' && state.view === 'map' && state.pinnedSeaIndex)) return;
  state.pinnedSeaIndex = null;
  requestAnimationFrame(updateSeaJump);
}
function metric(value, label) { return `<div class="detail-metric"><strong>${value}</strong><span>${label}</span></div>`; }
function sectionHeader(title, meta = '') { return `<div class="detail-section-head"><h3>${title}</h3><span>${meta}</span></div>`; }
function renderLargeDetailOverview(objects, review) {
  const groups = districts();
  return `<div class="detail-kicker">SEA AREA / 知识全景</div><h2 class="detail-title">${escapeHtml(target().name)}</h2><p class="detail-subtitle">${escapeHtml(target().projection)} · 计算于 ${escapeHtml(target().computedAt)}</p><p class="detail-description">${target().pages.length} 座页面岛按海域连续排布；下滚浏览全图，点击岛屿直接查看页面对象。</p><div class="detail-metrics">${metric(groups.length, '演示海域')}${metric(target().pages.length, '已加载页面')}${metric(review, '待复核对象')}</div><section class="detail-section">${sectionHeader('完整页面目录', `${target().pages.length} 个已加载页面`)}<div class="district-index">${groups.map((district) => `<div class="district-index-group"><button class="district-index-row" type="button" data-action="district" data-district-id="${district.id}"><strong>${escapeHtml(district.name)}</strong><small>定位海域 →</small></button>${district.pages.map((page) => `<button class="district-index-row is-page" type="button" data-action="page" data-page-id="${page.id}" ${visibleObjects(page).length ? '' : 'disabled'}><strong>${escapeHtml(page.name)}</strong><small>${visibleObjects(page).length} ${state.filter === 'all' ? '对象' : '匹配'} · ${escapeHtml(page.route)}</small></button>`).join('')}</div>`).join('')}</div></section><p class="detail-note">海域分组与菜单名是演示配置；现有 Map 数据只有目标、页面、对象层级，正式接入需提供菜单元数据或人工配置。</p><p class="detail-footer">演示数据 · 无后端操作</p>`;
}
function renderDetailOverview() {
  const objects = allObjects();
  const review = objects.filter((object) => statusOf(object) === 'review').length;
  const discovered = objects.filter((object) => statusOf(object) === 'discovered').length;
  if (usesDistricts()) return renderLargeDetailOverview(objects, review);
  const matchingPages = target().pages.filter((page) => visibleObjects(page).length > 0);
  return `<div class="detail-kicker">SEA AREA / 当前目标</div><h2 class="detail-title">${escapeHtml(target().name)}</h2><p class="detail-subtitle">${escapeHtml(target().projection)} · 计算于 ${escapeHtml(target().computedAt)}</p><p class="detail-description">这里展示当前已加载的页面与对象。选一座岛，逐层走近平台已经认识的知识。</p><div class="detail-metrics">${metric(target().pages.length, '已加载页面')}${metric(objects.length, '已加载对象')}${metric(review, '待复核对象')}</div><section class="detail-section">${sectionHeader('岛屿索引', state.filter === 'all' ? '选择进入' : '当前筛选')}<div class="mini-object-list">${matchingPages.length ? matchingPages.map((page) => `<button type="button" data-action="page" data-page-id="${page.id}"><span>${escapeHtml(page.name)}</span><small>${visibleObjects(page).length} ${state.filter === 'all' ? '对象' : '匹配对象'} · ${escapeHtml(page.route)}</small></button>`).join('') : '<p class="detail-note">当前状态没有匹配的岛屿。</p>'}</div></section><section class="detail-section">${sectionHeader('读图方式')}<p class="detail-note">岛屿是页面分组，地标是对象。琥珀信标代表待复核，灰蓝信标代表仅已发现。${discovered} 个对象仍处于已发现状态。岛屿距离和位置不代表页面导航或真实网页坐标。</p></section>${matchingPages.length ? `<button class="detail-action" type="button" data-action="page" data-page-id="${matchingPages[0].id}">进入第一座岛屿</button>` : ''}<p class="detail-footer">演示数据 · 无后端操作</p>`;
}
function renderDetailDistrict(district) {
  const shown = district.pages.flatMap((page) => visibleObjects(page));
  const review = shown.filter((object) => statusOf(object) === 'review').length;
  return `<div class="detail-kicker">SEA AREA / 演示分区</div><h2 class="detail-title">${escapeHtml(district.name)}</h2><p class="detail-subtitle">${escapeHtml(district.description)} · ${district.pages.length} 个页面</p><p class="detail-description">这个分区把多座页面岛收在同一片海域。点击页面进入对象视野，也可用搜索直接找到它。</p><div class="detail-metrics">${metric(district.pages.length, '已加载页面')}${metric(shown.length, '当前对象')}${metric(review, '待复核')}</div><section class="detail-section">${sectionHeader('页面目录', '选择进入')}<div class="district-index">${district.pages.map((page) => `<button class="district-index-row" type="button" data-action="page" data-page-id="${page.id}" ${visibleObjects(page).length ? '' : 'disabled'}><strong>${escapeHtml(page.name)}</strong><small>${visibleObjects(page).length} ${state.filter === 'all' ? '对象' : '匹配'} · ${escapeHtml(page.route)}</small></button>`).join('')}</div></section><button class="detail-action" type="button" data-action="atlas">返回全部分区</button><p class="detail-footer">演示菜单分区 · 不代表真实导航树</p>`;
}
function renderFeatureGroup(id, name, description, objects, open) {
  const review = objects.filter((object) => statusOf(object) === 'review').length;
  return `<details class="feature-group" data-feature-group-id="${escapeHtml(id)}" ${open ? 'open' : ''}><summary><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(description)}</small></span><b>${objects.length} 项${review ? ` · ${review} 待复核` : ''}</b></summary><div class="feature-list">${objects.map((object) => `<button type="button" class="feature-row" data-action="object" data-object-id="${escapeHtml(object.id)}"><i class="legend-dot ${statusOf(object)}" aria-hidden="true"></i><span><strong>${escapeHtml(object.name)}</strong><small>${escapeHtml(object.kind)} · ${STATUS_NAMES[statusOf(object)]}</small></span><b aria-hidden="true">↗</b></button>`).join('')}</div></details>`;
}
function renderDenseDirectory(page, shown) {
  const groups = featureGroups(page, shown).filter((group) => group.objects.length > 0);
  const fields = shown.filter((object) => !isButtonObject(object));
  const total = shown.length;
  return `<section class="detail-section dense-directory" aria-label="本页对象目录">${sectionHeader('按钮与字段目录', `${total} 个当前对象`)}<label class="dense-directory-search"><span>查找本页按钮或字段</span><input type="search" data-dense-search value="${escapeHtml(state.pageQuery)}" placeholder="例如：提交、导出、编号" autocomplete="off" /></label><p class="dense-result-count" aria-live="polite">${total} 项可查看</p>${groups.map((group, index) => renderFeatureGroup(group.id, group.name, group.description, group.objects, state.featureGroupId === group.id || (!state.featureGroupId && index === 0))).join('')}${fields.length ? renderFeatureGroup('fields', '关键字段', '与本页按钮并列的已加载字段对象', fields, state.featureGroupId === 'fields') : ''}<p class="feature-empty" hidden>没有匹配的按钮或字段，请换个词。</p><p class="detail-note">功能分组为演示配置；对象详情展示知识状态，不在此执行目标系统按钮。</p></section>`;
}
function renderDetailPage(page) {
  const shown = visibleObjects(page);
  const review = shown.filter((object) => statusOf(object) === 'review').length;
  const discovered = shown.filter((object) => statusOf(object) === 'discovered').length;
  if (hasDenseButtons(page)) return `<div class="detail-kicker">PAGE ISLAND / 页面视野</div><h2 class="detail-title">${escapeHtml(page.name)}</h2><p class="detail-subtitle">${escapeHtml(page.route)} · 已加载 ${buttonCount(page)} 个按钮入口、${page.objects.length - buttonCount(page)} 个字段</p><p class="detail-description">岛面只保留分组和异常概览。使用下方目录查找、展开并查看具体按钮对象。</p><div class="detail-metrics">${metric(buttonCount(page, shown), '当前按钮')}${metric(configuredFeatureGroups(page).length, page.featureGroups?.length ? '演示分组' : '中性目录')}${metric(review, '待复核')}</div>${renderDenseDirectory(page, shown)}<section class="detail-section">${sectionHeader('页面归属')}<p class="detail-note">按钮对象按已加载页面归属汇总；${page.featureGroups?.length ? '功能分组来自人工演示配置，正式接入须由菜单元数据或人员确认。' : '当前没有经确认的功能分组，因此只使用中性目录。'}</p></section><button class="detail-action" type="button" data-action="district" data-district-id="${escapeHtml(state.districtId || '')}">返回${escapeHtml(districtById()?.name || '群岛')}海域</button><p class="detail-footer">${escapeHtml(target().projection)} · 演示数据</p>`;
  return `<div class="detail-kicker">PAGE ISLAND / 页面视野</div><h2 class="detail-title">${escapeHtml(page.name)}</h2><p class="detail-subtitle">${escapeHtml(page.route)} · 当前已加载 ${page.objects.length} 个对象</p><p class="detail-description">这一座岛收纳页面里的对象。选择地标，查看验证、变化、证据和关联场景。</p><div class="detail-metrics">${metric(shown.length, '当前显示')}${metric(review, '待复核')}${metric(discovered, '已发现')}</div><section class="detail-section">${sectionHeader('对象地标', state.filter === 'all' ? '点击查看' : '当前筛选')}<div class="mini-object-list">${shown.length ? shown.map((object) => `<button type="button" data-action="object" data-object-id="${object.id}"><span>${escapeHtml(object.name)}</span><small>${STATUS_NAMES[statusOf(object)]}</small></button>`).join('') : '<p class="detail-note">当前状态没有匹配的对象。</p>'}</div></section><section class="detail-section">${sectionHeader('页面归属')}<p class="detail-note">对象按页面归属聚合；地标排布仅为阅读而设，不对应 DOM 坐标或页面中的实际位置。</p></section><button class="detail-action" type="button" data-action="atlas">返回全部岛屿</button><p class="detail-footer">${escapeHtml(target().projection)} · 演示数据</p>`;
}
function renderDetailObject(object) {
  const status = statusOf(object); const entries = relations(object);
  const intro = status === 'review' ? '检测到对象变化，关联场景需要核对；这不表示场景执行失败。' : status === 'trusted' ? '这个对象已有确认记录，可以继续查看它的引用与证据。' : '目前只发现了这个对象，部分属性仍待验证。';
  const backToDirectory = hasDenseButtons(object.page) ? `<button class="detail-action is-secondary" type="button" data-action="page" data-page-id="${escapeHtml(object.page.id)}">← 返回${escapeHtml(object.page.name)}按钮目录</button>` : '';
  return `<div class="detail-kicker">OBJECT LANDMARK / 对象详情</div><h2 class="detail-title">${escapeHtml(object.name)}</h2><p class="detail-subtitle">${escapeHtml(object.page.name)} · ${escapeHtml(object.kind)} · ${escapeHtml(object.page.route)}</p><span class="detail-state ${status}"><i class="legend-dot ${status}"></i>${STATUS_NAMES[status]}</span><p class="detail-description">${intro}</p>${backToDirectory}<div class="detail-metrics">${metric(object.confirmed.length, '明确引用')}${metric(object.potential.length, '可能匹配')}${metric(object.changes, '变化记录')}</div><section class="detail-section">${sectionHeader('知识状态', '当前投影')}<div class="detail-facts"><div class="detail-fact"><small>生命周期</small><strong>${LIFECYCLE_NAMES[object.lifecycle]}</strong></div><div class="detail-fact"><small>最近验证</small><strong>${object.verified || '暂无'}</strong></div><div class="detail-fact"><small>证据可用性</small><strong>${EVIDENCE_NAMES[object.evidence]}</strong></div><div class="detail-fact"><small>变化记录</small><strong>${object.changes} 条</strong></div></div></section><section class="detail-section">${sectionHeader('验证维度', '逐项判断')}<div class="dimension-list">${object.dimensions.map((value, index) => `<div class="dimension-item"><span>${DIMENSION_NAMES[index]}</span><strong class="${['未知', '未观察', '否定'].includes(DIMENSION_LABELS[value]) ? 'warning' : ''}">${DIMENSION_LABELS[value] || '未知'}</strong></div>`).join('')}</div></section><section class="detail-section">${sectionHeader('场景引用', '点击聚焦')}<div class="detail-rows">${entries.length ? entries.map((entry) => `<button class="detail-row ${entry.grade === 'potential' ? 'potential' : ''} ${state.focusedScenario === entry.id ? 'is-active' : ''}" type="button" data-action="scenario" data-scenario-id="${entry.id}" aria-pressed="${state.focusedScenario === entry.id}"><span><strong>${escapeHtml(entry.name)}</strong><small>${entry.grade === 'confirmed' ? '明确引用' : '可能匹配'}</small></span><small>${escapeHtml(entry.id)}</small></button>`).join('') : '<p class="detail-note">当前没有可展示的关联场景。</p>'}</div><p class="detail-note">目标级扫描覆盖未知时，不能归属到当前对象；可能匹配尚待验证。</p></section><button class="detail-action" type="button" data-action="focus-first" ${entries.length ? '' : 'disabled'}>${entries.length ? (state.focusedScenario ? '取消场景聚焦' : '聚焦第一条引用') : '暂无可聚焦引用'}</button><p class="detail-footer">演示交互 · 不修改知识资产</p>`;
}
function applyDenseDirectorySearch() {
  const directory = detailPane.querySelector('.dense-directory'); if (!directory) return;
  const query = state.pageQuery.trim().toLocaleLowerCase();
  let matches = 0;
  directory.querySelectorAll('.feature-group').forEach((group) => {
    const groupName = group.querySelector('summary strong')?.textContent.toLocaleLowerCase() || '';
    let groupMatches = 0;
    group.querySelectorAll('.feature-row').forEach((row) => {
      const matched = !query || groupName.includes(query) || row.textContent.toLocaleLowerCase().includes(query);
      row.hidden = !matched;
      if (matched) groupMatches++;
    });
    group.hidden = groupMatches === 0;
    if (query && groupMatches) group.open = true;
    matches += groupMatches;
  });
  directory.querySelector('.dense-result-count').textContent = query ? `找到 ${matches} 项` : `${matches} 项可查看`;
  directory.querySelector('.feature-empty').hidden = matches > 0;
}
function renderDetail() { const object = objectById(); const page = pageById(); const district = districtById(); detailPane.innerHTML = object ? renderDetailObject(object) : page ? renderDetailPage(page) : district ? renderDetailDistrict(district) : renderDetailOverview(); applyDenseDirectorySearch(); }
function renderSearch() {
  const query = state.query.trim().toLocaleLowerCase();
  const element = $('#search-results');
  if (!query) { element.hidden = true; element.innerHTML = ''; return; }
  const pageResults = target().pages.filter((page) => visibleObjects(page).length > 0 && (page.name.toLocaleLowerCase().includes(query) || page.route.toLocaleLowerCase().includes(query)));
  const objectResults = allObjects().filter((object) => (state.filter === 'all' || statusOf(object) === state.filter) && `${object.name} ${featureGroupName(object)}`.toLocaleLowerCase().includes(query));
  const total = pageResults.length + objectResults.length;
  const results = [...pageResults.map((page) => ({ kind: 'page', label: page.name, sub: `${districtForPage(page) ? `${districtForPage(page).name} › ` : ''}${page.route}`, id: page.id })), ...objectResults.map((object) => ({ kind: 'object', label: object.name, sub: `${districtForPage(object.page) ? `${districtForPage(object.page).name} › ` : ''}${object.page.name}${featureGroupName(object) ? ` › ${featureGroupName(object)}` : ''} · ${object.kind} · ${STATUS_NAMES[statusOf(object)]}`, id: object.id }))].slice(0, 40);
  element.hidden = false;
  element.innerHTML = `<h3>搜索结果 / ${total}</h3>${results.length ? results.map((item) => `<button type="button" class="search-result" data-action="${item.kind}" data-${item.kind === 'page' ? 'page' : 'object'}-id="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.sub)}</small></span><b>${item.kind === 'page' ? '页面' : '对象'} ↗</b></button>`).join('') : '<p class="search-no-result">没有匹配的页面或对象，试试其他关键词。</p>'}${total > results.length ? `<p class="search-no-result">另有 ${total - results.length} 条结果，请继续输入以缩小范围。</p>` : ''}`;
}
function render() {
  const object = objectById();
  if (object && state.filter !== 'all' && statusOf(object) !== state.filter) { state.objectId = null; state.focusedScenario = null; }
  renderIntro(); renderCrumbs(); renderMap(); renderDetail(); renderSearch();
}
function drawRelations() {
  const svg = $('#relation-lines'); if (!svg || window.matchMedia('(max-width: 720px)').matches) return;
  const source = $('.object-marker.is-selected'); const object = objectById();
  if (!source || !object) return;
  const world = $('.page-world'); const worldRect = world.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${worldRect.width} ${worldRect.height}`);
  svg.replaceChildren();
  $('.scene-port').querySelectorAll('[data-scenario-id]').forEach((row) => {
    const start = source.getBoundingClientRect(); const end = row.getBoundingClientRect();
    const ax = start.right - worldRect.left; const ay = start.top + start.height / 2 - worldRect.top;
    const bx = end.left - worldRect.left; const by = end.top + end.height / 2 - worldRect.top;
    const bend = Math.max(35, (bx - ax) * .44);
    const pathData = `M ${ax} ${ay} C ${ax + bend} ${ay}, ${bx - bend} ${by}, ${bx} ${by}`;
    const potential = row.classList.contains('potential'); const muted = Boolean(state.focusedScenario && state.focusedScenario !== row.dataset.scenarioId);
    for (const role of ['halo', potential ? 'potential' : 'confirmed']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData); path.setAttribute('class', `${role}${muted ? ' muted' : ''}${state.focusedScenario === row.dataset.scenarioId && role !== 'halo' ? ' focused' : ''}`);
      svg.appendChild(path);
    }
  });
}
function focusDetail() {
  const heading = detailPane.querySelector('.detail-title');
  if (!heading) return;
  const mapRect = document.querySelector('.map-panel')?.getBoundingClientRect();
  const detailRect = detailPane.getBoundingClientRect();
  const detailBelowMap = Boolean(mapRect && detailRect.top >= mapRect.bottom - 2);
  const detailOffscreen = detailRect.top >= window.innerHeight - 60 || detailRect.bottom <= 80;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: !detailBelowMap && !detailOffscreen });
  if (detailBelowMap || detailOffscreen) detailPane.scrollIntoView({ block: 'start' });
}
function openDistrict(id) {
  const district = districtById(id); if (!district) return;
  const index = districts().findIndex((item) => item.id === id) + 1;
  if (state.level !== 'atlas' || state.view !== 'map') goAtlas();
  requestAnimationFrame(() => jumpToSea(index));
}
function openPage(id) {
  const page = pageById(id); if (!page || !visibleObjects(page).length) return;
  if (state.level === 'atlas' && state.view === 'map') state.atlasScrollY = window.scrollY;
  if (state.pageId !== id) { state.pageQuery = ''; state.featureGroupId = null; }
  state.districtId = districtForPage(page)?.id || null; state.pageId = id; state.objectId = null;
  if (usesDistricts()) state.pinnedSeaIndex = districts().findIndex((district) => district.id === state.districtId) + 1 || null;
  state.level = 'page'; state.view = 'map'; state.focusedScenario = null; state.query = ''; $('#atlas-search').value = '';
  render(); $('.map-panel')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  announce(hasDenseButtons(page) ? `已进入${page.name}，已加载${buttonCount(page)}个按钮入口和${page.objects.length - buttonCount(page)}个字段` : `已进入${page.name}，当前显示${visibleObjects(page).length}个对象`);
}
function openObject(id, source = 'map') {
  const object = objectById(id); if (!object || (state.filter !== 'all' && statusOf(object) !== state.filter)) return;
  if (state.level === 'atlas' && state.view === 'map') state.atlasScrollY = window.scrollY;
  if (state.pageId !== object.page.id) state.pageQuery = '';
  state.districtId = districtForPage(object.page)?.id || null; state.pageId = object.page.id; state.objectId = id;
  if (usesDistricts()) state.pinnedSeaIndex = districts().findIndex((district) => district.id === state.districtId) + 1 || null;
  state.featureGroupId = object.featureGroup || null; state.level = 'page'; if (source === 'map') state.view = 'map';
  state.focusedScenario = null; state.query = ''; $('#atlas-search').value = ''; render();
  const marker = source === 'map' ? $(`[data-object-id="${id}"].object-marker`) : null;
  const mapRect = document.querySelector('.map-panel')?.getBoundingClientRect(); const detailRect = detailPane.getBoundingClientRect();
  if (marker && mapRect && detailRect.top < mapRect.bottom - 2) marker.focus(); else focusDetail();
  announce(`已选择${object.page.name}的${object.name}`);
}
function goAtlas() {
  state.level = 'atlas'; state.districtId = null; state.pageId = null; state.objectId = null;
  state.pageQuery = ''; state.featureGroupId = null; state.focusedScenario = null; state.view = 'map';
  render();
  if (usesDistricts()) requestAnimationFrame(() => { window.scrollTo({ top: state.atlasScrollY, behavior: 'auto' }); updateSeaJump(); });
  announce('已返回全部岛屿');
}
function focusFeatureGroup(id) { const page = pageById(); const group = page ? configuredFeatureGroups(page).find((item) => item.id === id) : null; if (!group) return; state.featureGroupId = id; state.pageQuery = ''; const input = detailPane.querySelector('[data-dense-search]'); if (input) input.value = ''; applyDenseDirectorySearch(); document.querySelectorAll('.feature-zone-item').forEach((button) => button.classList.toggle('is-active', button.dataset.featureGroupId === id)); const section = [...detailPane.querySelectorAll('.feature-group')].find((item) => item.dataset.featureGroupId === id); if (!section) return; section.open = true; const mapRect = document.querySelector('.map-panel')?.getBoundingClientRect(); const detailRect = detailPane.getBoundingClientRect(); if (mapRect && detailRect.top >= mapRect.bottom - 2) detailPane.scrollIntoView({ block: 'start' }); section.scrollIntoView({ block: 'nearest' }); section.querySelector('summary')?.focus({ preventScroll: true }); announce(`已定位${group.name}分组，${section.querySelectorAll('.feature-row').length}个按钮入口`); }
function focusScenario(id, source = 'port') { state.focusedScenario = state.focusedScenario === id ? null : id; render(); const row = document.querySelector(`${source === 'detail' ? '.detail-pane .detail-row' : '.scene-port .scene-row'}[data-scenario-id="${id}"]`); row?.focus(); announce(state.focusedScenario ? `已聚焦场景${row?.querySelector('strong')?.textContent || id}` : '已显示全部引用关系'); }

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]'); if (!control) return;
  const action = control.dataset.action;
  if (action === 'atlas') goAtlas();
  else if (action === 'jump-district') jumpToSea(Number(control.dataset.seaIndex));
  else if (action === 'district') openDistrict(control.dataset.districtId);
  else if (action === 'page') openPage(control.dataset.pageId);
  else if (action === 'feature-group') focusFeatureGroup(control.dataset.featureGroupId);
  else if (action === 'object') openObject(control.dataset.objectId, control.classList.contains('object-marker') ? 'map' : 'detail');
  else if (action === 'scenario') focusScenario(control.dataset.scenarioId, control.closest('.detail-pane') ? 'detail' : 'port');
  else if (action === 'clear-filter') { state.filter = 'all'; render(); document.querySelector('[data-filter="all"]')?.focus(); announce('已显示全部对象'); }
  else if (action === 'focus-first') { const object = objectById(); if (!object) return; if (state.focusedScenario) { state.focusedScenario = null; render(); detailPane.querySelector('[data-action="focus-first"]')?.focus(); announce('已显示全部引用关系'); } else { const first = relations(object)[0]; if (first) focusScenario(first.id, 'detail'); } }
});
$('#target-select').addEventListener('change', (event) => { state.target = event.target.value; state.level = 'atlas'; state.districtId = null; state.pageId = null; state.objectId = null; state.filter = 'all'; state.query = ''; state.pageQuery = ''; state.featureGroupId = null; state.focusedScenario = null; state.atlasScrollY = 0; state.pinnedSeaIndex = null; $('#atlas-search').value = ''; render(); window.scrollTo({ top: 0, behavior: 'auto' }); announce(`已切换到${target().name}`); });
$('#atlas-search').addEventListener('input', (event) => { state.query = event.target.value; renderSearch(); });
detailPane.addEventListener('input', (event) => { if (!event.target.matches('[data-dense-search]')) return; state.pageQuery = event.target.value; applyDenseDirectorySearch(); });
document.querySelector('.filter-set').addEventListener('click', (event) => { const button = event.target.closest('[data-filter]'); if (!button) return; state.filter = button.dataset.filter; state.focusedScenario = null; render(); announce(`已筛选${button.textContent.trim()}对象`); });
document.querySelector('.view-switch').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (!button) return; state.view = button.dataset.view; state.query = ''; $('#atlas-search').value = ''; render(); announce(`已切换为${button.textContent.trim()}视图`); });
document.addEventListener('keydown', (event) => {
  const inputActive = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (!inputActive && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) clearSeaPin();
  if (event.key === '/' && !inputActive) { event.preventDefault(); $('#atlas-search').focus(); return; }
  if (event.key !== 'Escape') return;
  if (state.query) { state.query = ''; $('#atlas-search').value = ''; renderSearch(); announce('已清除搜索'); }
  else if (state.pageQuery && document.activeElement?.matches('[data-dense-search]')) { state.pageQuery = ''; document.activeElement.value = ''; applyDenseDirectorySearch(); announce('已清除本页搜索'); }
  else if (state.focusedScenario) { state.focusedScenario = null; render(); announce('已显示全部引用关系'); }
  else if (state.objectId) { state.objectId = null; render(); announce('已返回页面视野'); }
  else if (state.level === 'page') goAtlas();
  else if (state.level === 'district') goAtlas();
});
window.addEventListener('resize', () => requestAnimationFrame(drawRelations));
window.addEventListener('scroll', () => requestAnimationFrame(updateSeaJump), { passive: true });
window.addEventListener('wheel', clearSeaPin, { passive: true });
window.addEventListener('touchstart', clearSeaPin, { passive: true });
window.addEventListener('pointerdown', (event) => { if (event.clientX >= document.documentElement.clientWidth - 14) clearSeaPin(); }, { passive: true });
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => requestAnimationFrame(drawRelations)).observe(mapCanvas);
render();
