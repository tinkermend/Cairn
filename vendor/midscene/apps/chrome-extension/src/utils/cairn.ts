import type { ChromeRecordedEvent } from '@midscene/recorder-ui';

export interface CairnAccount {
  id: string;
  email: string | null;
  displayName: string;
  roles: Array<{ id: string; key: string; name: string; kind: string }>;
}

export interface CairnTarget {
  id: string;
  name: string;
  description?: string;
  baseUrl?: string;
  status: 'active' | 'disabled';
}

export interface CairnBinding {
  id: string;
  scenarioId: string;
  targetId: string;
  status: string;
  recordingDraftId?: string | null;
}

export interface CairnDemonstrationResult {
  recordingDraftId: string;
  source: any;
  suggestions?: any[];
}

export class CairnApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CairnApiError';
    this.status = status;
    this.code = code;
  }
}

const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|authorization|cookie|api[_-]?key|密码|口令|密钥|验证码/i;

/** 清洗 URL 中的凭据与敏感 Query 参数 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return rawUrl;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * 清洗并瘦身 MidScene 录制事件：
 * 1. 剔除庞大的 Base64 截图（screenshotBefore / screenshotAfter / screenshotWithBox），
 *    防止单次上传体积极度膨胀甚至超出 API 限制；
 * 2. 识别密码框或敏感字段，进行输入值脱敏。
 */
export function sanitizeEventsForCairn(
  events: ChromeRecordedEvent[],
): ChromeRecordedEvent[] {
  return events.map((event) => {
    // 拷贝事件对象并剔除 Base64 截图
    const sanitized: any = { ...event };
    delete sanitized.screenshotBefore;
    delete sanitized.screenshotAfter;
    delete sanitized.screenshotWithBox;

    // 清洗 URL
    if (sanitized.url) {
      sanitized.url = sanitizeUrl(sanitized.url);
    }

    // 针对 input 类型的敏感值脱敏
    if (sanitized.type === 'input') {
      const desc = (
        sanitized.elementDescription ||
        sanitized.semantic?.elementDescription ||
        ''
      ).toLowerCase();
      const rawPayload = (sanitized.rawPayload || {}) as Record<string, any>;
      const isPassword =
        rawPayload.inputType === 'password' || SENSITIVE_KEY_PATTERN.test(desc);

      if (isPassword) {
        sanitized.value = '******';
      }
    }

    return sanitized;
  });
}

/** 跨 MV3 扩展多上下文共享与 LocalStorage 降级双写适配器 */
export const cairnStorage = {
  async getItem(key: string): Promise<string | null> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const res = await chrome.storage.local.get(key);
        if (res && res[key] !== undefined && res[key] !== null) {
          return String(res[key]);
        }
      } catch {
        // ignore
      }
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
    return null;
  },

  async setItem(key: string, value: string): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await chrome.storage.local.set({ [key]: value });
      } catch {
        // ignore
      }
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  },

  async removeItem(key: string): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await chrome.storage.local.remove(key);
      } catch {
        // ignore
      }
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  },
};

/** 统一的 Cairn Fetch 封装（带 30s 超时控制） */
export async function cairnFetch<T>(
  apiOrigin: string,
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const origin = apiOrigin.replace(/\/+$/, '');
  const url = `${origin}${path.startsWith('/') ? path : `/${path}`}`;

  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal || controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new CairnApiError(0, 'TIMEOUT', '请求识途平台服务超时（30秒），请检查后端服务状态');
    }
    throw new CairnApiError(0, 'NETWORK_ERROR', err?.message || '无法连接到识途平台服务，请检查网络或 API 地址');
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const code = json?.code || `HTTP_${response.status}`;
    const message = json?.message || `请求识途服务失败 (HTTP ${response.status})`;
    const detailMsg = json?.details ? `${message}: ${JSON.stringify(json.details)}` : message;
    throw new CairnApiError(response.status, code, detailMsg);
  }

  return json as T;
}

/** 账号密码登录 */
export async function loginToCairn(
  apiOrigin: string,
  account: string,
  password: string,
): Promise<{ accessToken: string; account: CairnAccount }> {
  return cairnFetch<{ accessToken: string; account: CairnAccount }>(
    apiOrigin,
    '/api/auth/login',
    {
      method: 'POST',
      // 平台接口沿用 email 字段名，实际接受账号标识（包括 admin）。
      body: JSON.stringify({ email: account, password }),
    },
  );
}

/** 获取当前用户信息（校验 Token） */
export async function fetchCairnMe(
  apiOrigin: string,
  token: string,
): Promise<{ account: CairnAccount }> {
  return cairnFetch<{ account: CairnAccount }>(
    apiOrigin,
    '/api/me',
    { method: 'GET' },
    token,
  );
}

/** 获取已激活的 Target 列表 */
export async function fetchCairnTargets(
  apiOrigin: string,
  token: string,
): Promise<CairnTarget[]> {
  const res = await cairnFetch<{ items: CairnTarget[] }>(
    apiOrigin,
    '/api/targets?status=active&limit=100',
    { method: 'GET' },
    token,
  );
  return res.items || [];
}

/** 检查控制台是否有等待中的协同录制绑定 */
export async function fetchCairnOpenBinding(
  apiOrigin: string,
  token: string,
): Promise<CairnBinding | null> {
  const res = await cairnFetch<{ binding: CairnBinding | null }>(
    apiOrigin,
    '/api/recording-bindings/open',
    { method: 'GET' },
    token,
  );
  return res.binding || null;
}

/** 提取更富有业务语义的操作元素选择器/描述 */
export function extractEventSelector(event: ChromeRecordedEvent): string {
  // Prefer the selector captured on the live page. AI descriptions are useful
  // to read, but they are not necessarily executable locators.
  const recordedSelector = event.rawPayload?.selector;
  if (typeof recordedSelector === 'string' && recordedSelector.trim()) {
    return recordedSelector.slice(0, 2048);
  }

  // 1. 优先使用已生成的 AI 语义描述
  const desc = event.elementDescription || (event.semantic as any)?.elementDescription;
  if (desc && desc !== 'failed to generate element description') {
    return desc;
  }

  // 2. 尝试从事件对象可能携带的 DOM/Label 元数据中提取
  const anyEvt = event as any;
  const tag = anyEvt.targetTagName?.toLowerCase() || '';
  const id = anyEvt.targetId || '';
  const labelText = (anyEvt.labelInfo?.textContent || anyEvt.labelInfo?.htmlFor || '').trim();
  const title = (event.title || '').trim();

  if (labelText) {
    return `${tag || 'element'} "${labelText.slice(0, 50)}"`;
  }
  if (title) {
    return `${tag || 'element'} "${title.slice(0, 50)}"`;
  }
  if (id) {
    return `${tag || 'element'}#${id}`;
  }

  // 3. 兜底提取相对坐标
  if (
    event.elementRect &&
    typeof event.elementRect.left === 'number' &&
    typeof event.elementRect.top === 'number'
  ) {
    return `point(${Math.round(event.elementRect.left)},${Math.round(event.elementRect.top)})`;
  }
  return 'target';
}

/**
 * 将 Midscene 录制事件映射为识途平台统一的 RecordingEvent
 */
export function convertMidsceneToRecordingEvents(
  events: ChromeRecordedEvent[],
): any[] {
  const sanitized = sanitizeEventsForCairn(events);
  const result: any[] = [];

  for (const event of sanitized) {
    // Scrolling is browser positioning, not a click. A following locator can
    // scroll into view during replay. Do not fabricate an executable action.
    if (event.type === 'scroll' || event.type === 'setViewport') continue;
    const selector = extractEventSelector(event);

    if (event.type === 'navigation') {
      if (event.url) {
        const previous = result[result.length - 1];
        if (previous?.name === 'navigate' && previous.url === event.url) continue;
        result.push({
          name: 'navigate',
          url: event.url,
        });
      }
    } else if (event.type === 'click') {
      result.push({
        name: 'click',
        selector: selector.slice(0, 2048),
        url: event.url,
        button: 'left',
        clickCount: 1,
        modifiers: 0,
      });
    } else if (event.type === 'input') {
      const isSensitive = event.value === '******';
      result.push({
        name: 'fill',
        selector: selector.slice(0, 2048),
        text: event.value || '',
        url: event.url,
        markedSensitive: isSensitive,
      });
    } else if (event.type === 'keydown') {
      result.push({
        name: 'press',
        key: event.value || 'Enter',
        selector: selector.slice(0, 2048),
        url: event.url,
      });
    } else {
      // scroll / drag 等事件保留为带意图描述的 click 占位
      result.push({
        name: 'click',
        selector: `${event.type}: ${selector}`.slice(0, 2048),
        url: event.url,
      });
    }
  }

  return result.length > 0
    ? result
    : [{ name: 'navigate', url: 'about:blank' }];
}

/** Keep user actions that can become platform steps, including viewport positioning. */
export function midsceneUploadEvents(events: ChromeRecordedEvent[]): ChromeRecordedEvent[] {
  const result: ChromeRecordedEvent[] = [];
  const scrollPositions = new Map<string, { x: number; y: number }>();
  let navigationObserved = false;
  for (const event of sanitizeEventsForCairn(events)) {
    if (event.type === 'setViewport') continue;
    const previous = result[result.length - 1];
    if (event.type === 'navigation' && previous?.type === 'navigation' && previous.url === event.url) continue;
    if (event.type === 'navigation') {
      scrollPositions.clear();
      navigationObserved = true;
    }
    if (event.type === 'scroll') {
      const position = scrollPosition(event);
      const selector = (event.rawPayload as Record<string, unknown> | undefined)?.selector;
      const key = typeof selector === 'string' && selector ? selector : 'document';
      const prior = scrollPositions.get(key) ?? (navigationObserved ? { x: 0, y: 0 } : undefined);
      if (position) scrollPositions.set(key, position);
      if (position && prior && position.x === prior.x && position.y === prior.y) continue;
      const previousScroll = result[result.length - 1];
      const previousSelector = (previousScroll?.rawPayload as Record<string, unknown> | undefined)?.selector;
      if (previousScroll?.type === 'scroll' && previousSelector === selector) {
        result[result.length - 1] = event;
        continue;
      }
    }
    result.push(event);
  }
  return result;
}

function scrollPosition(event: ChromeRecordedEvent): { x: number; y: number } | undefined {
  const parts = event.value?.split(',').map(Number);
  if (!parts || parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) return undefined;
  return { x: parts[0], y: parts[1] };
}

function scrollTarget(event: ChromeRecordedEvent): string | undefined {
  const payload = event.rawPayload as Record<string, unknown> | undefined;
  const selector = payload?.selector;
  if (selector === 'nav' || selector === 'aside') return 'left navigation sidebar';
  if (selector === 'body' || selector === 'html') return undefined;
  const description = semanticTarget(event);
  return description && description.length <= 100 ? description : undefined;
}

function semanticTarget(event: ChromeRecordedEvent): string | undefined {
  const payload = event.rawPayload as Record<string, unknown> | undefined;
  const selector = payload?.selector;
  const candidates = [
    payload?.targetDescription,
    (event.semantic as { elementDescription?: unknown } | undefined)?.elementDescription,
    event.elementDescription,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.replace(/\s+/g, ' ').trim().slice(0, 4096);
    if (
      !value ||
      value === selector ||
      value === 'failed to generate element description' ||
      /password|passwd|secret|token|api[_-]?key|密码|口令|密钥|验证码/i.test(value)
    ) continue;
    return value;
  }
  return undefined;
}

/** Midscene interactions enter the platform's AI demonstration import path. */
export function buildMidsceneDemonstrationSource(
  events: ChromeRecordedEvent[],
  targetId: string,
  bindingId?: string,
  captureId = crypto.randomUUID(),
) {
  const priorScrollPositions = new Map<string, { x: number; y: number }>();
  let navigationObserved = false;
  const facts = midsceneUploadEvents(events).map((event, sequence) => {
    const data: Record<string, unknown> = {};
    const diagnostics: string[] = [];
    const description = event.type === 'scroll' ? scrollTarget(event) : semanticTarget(event);
    if (description) data.targetDescription = description;
    if (event.type === 'navigation') {
      if (event.url) data.url = sanitizeUrl(event.url);
      else diagnostics.push('导航缺少页面地址');
      priorScrollPositions.clear();
      navigationObserved = true;
    } else if (event.type === 'scroll') {
      const position = scrollPosition(event);
      const selector = (event.rawPayload as Record<string, unknown> | undefined)?.selector;
      const key = typeof selector === 'string' && selector ? selector : 'document';
      const prior = priorScrollPositions.get(key) ?? (navigationObserved ? { x: 0, y: 0 } : undefined);
      if (position) priorScrollPositions.set(key, position);
      if (!position || !prior) {
        diagnostics.push('滚动缺少可确认的起点，需在编排台修正');
      } else {
        const dx = position.x - prior.x;
        const dy = position.y - prior.y;
        const vertical = Math.abs(dy) >= Math.abs(dx);
        const delta = vertical ? dy : dx;
        const distance = Math.round(Math.abs(delta));
        if (distance < 1 || distance > 10_000) {
          diagnostics.push('滚动距离无效，需在编排台修正');
        } else if (key !== 'document' && !description) {
          diagnostics.push('滚动容器缺少可回放的语义，请在编排台修正');
        } else {
          data.direction = vertical ? (delta > 0 ? 'down' : 'up') : (delta > 0 ? 'right' : 'left');
          data.distance = distance;
          data.scrollType = 'singleAction';
        }
      }
    } else if (event.type === 'click') {
      if (!description) diagnostics.push('点击缺少可回放的元素语义，请在编排台修正');
    } else if (event.type === 'input') {
      const value = event.value ?? '';
      if (value === '******') {
        data.value = { state: 'redacted', reason: '敏感输入已移除' };
        diagnostics.push('敏感输入需在编排台重新编写');
      } else if (value === '') {
        data.mode = 'clear';
      } else {
        data.mode = 'replace';
        data.value = { state: 'literal', text: value };
      }
      if (!description) diagnostics.push('输入缺少可回放的元素语义，请在编排台修正');
    } else if (event.type === 'keydown') {
      if (event.value) data.key = event.value;
      else diagnostics.push('按键缺少键值');
    } else {
      diagnostics.push(`暂不支持 ${event.type} 操作，请在编排台修正`);
    }
    const id = `event-${sequence + 1}`;
    const observation = { status: 'missing', reason: '扩展未上传页面截图' };
    return {
      id,
      sourceIds: [id],
      sequence,
      kind: 'action',
      action: event.type === 'scroll' ? 'aiScroll' : event.type,
      pageId: null,
      documentEpoch: null,
      framePath: null,
      timestampPrecision: 'unknown',
      semanticSource: description ? 'heuristic' : 'unknown',
      data,
      before: observation,
      after: observation,
      diagnostics,
    };
  });
  return {
    protocolVersion: 'demonstration@1',
    captureId,
    targetId,
    ...(bindingId ? { bindingId } : {}),
    sourceKind: 'interaction_trace',
    channel: 'extension',
    producerKind: 'chrome_recorder',
    actorKind: 'human',
    authorship: 'human',
    importProfile: 'midscene-recorder-json@1',
    producerVersion: '1.12.6',
    detectedShape: 'midscene-event-array',
    adapterVersion: 'demonstration-adapters@1',
    redactionVersion: 'demonstration-redaction@1',
    facts,
    omittedConfig: [],
    assetManifest: [],
  };
}

/**
 * 组装并上传录制草稿数据至识途平台 (POST /api/recordings)
 * 版本带有 midscene@ 前缀，平台自动将其打标为 AI 录制来源。
 */
export async function uploadCairnRecording(
  apiOrigin: string,
  token: string,
  params: {
    events: ChromeRecordedEvent[];
    targetId: string;
    bindingId?: string;
    name?: string;
  },
): Promise<{ recordingDraftId: string; name: string; source: string }> {
  const source = buildMidsceneDemonstrationSource(params.events, params.targetId, params.bindingId);
  if (source.facts.length === 0) {
    throw new Error('当前录制会话没有有效操作事件');
  }
  const idempotencyKey = crypto.randomUUID();

  const body = {
    idempotencyKey,
    name: (params.name || `识途录制-${new Date().toLocaleTimeString('zh-CN')}`).slice(0, 64),
    source,
    acknowledgedOmittedConfig: true,
  };

  const res = await cairnFetch<any>(
    apiOrigin,
    '/api/recordings/demonstrations',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    token,
  );

  return {
    recordingDraftId: res.recordingDraftId,
    name: body.name,
    source: 'ai',
  };
}

/**
 * 兼容旧名称的示教上传入口
 */
export async function uploadCairnDemonstration(
  apiOrigin: string,
  token: string,
  params: {
    events: ChromeRecordedEvent[];
    targetId: string;
    bindingId?: string;
    name?: string;
  },
): Promise<CairnDemonstrationResult> {
  const res = await uploadCairnRecording(apiOrigin, token, params);
  return {
    recordingDraftId: res.recordingDraftId,
    source: { source: res.source, name: res.name },
  };
}

/** 生成控制台录制草稿详情的跳转 URL */
export function getCairnStudioUrl(
  apiOrigin: string,
  recordingDraftId: string,
  scenarioId?: string,
): string {
  // 本地开发环境端口映射：API 3030 -> Web 5173
  const webOrigin = apiOrigin.includes(':3030')
    ? apiOrigin.replace(':3030', ':5173')
    : apiOrigin.replace(/\/+$/, '');

  if (scenarioId) {
    return `${webOrigin}/scenarios/${scenarioId}/recordings/${recordingDraftId}`;
  }
  return `${webOrigin}/recordings/${recordingDraftId}`;
}
