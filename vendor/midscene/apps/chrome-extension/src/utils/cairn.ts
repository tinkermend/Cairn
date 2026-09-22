import type { ChromeRecordedEvent } from '@midscene/recorder-ui';

export interface CairnAccount {
  id: string;
  email: string;
  displayName: string;
  role: string;
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
  email: string,
  password: string,
): Promise<{ accessToken: string; account: CairnAccount }> {
  return cairnFetch<{ accessToken: string; account: CairnAccount }>(
    apiOrigin,
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
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
    const selector = extractEventSelector(event);

    if (event.type === 'navigation') {
      if (event.url) {
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
  const cleanEvents = sanitizeEventsForCairn(params.events);
  if (cleanEvents.length === 0) {
    throw new Error('当前录制会话没有有效操作事件');
  }

  const recordingEvents = convertMidsceneToRecordingEvents(cleanEvents);
  const recordingId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

  const body = {
    targetId: params.targetId,
    recordingId,
    sourceVersion: 'midscene@1.12.6',
    idempotencyKey,
    name: (params.name || `Midscene录制-${new Date().toLocaleTimeString()}`).slice(0, 64),
    bindingId: params.bindingId || undefined,
    events: recordingEvents,
  };

  const res = await cairnFetch<any>(
    apiOrigin,
    '/api/recordings',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    token,
  );

  const detail = res.detail || res;
  return {
    recordingDraftId: detail.id || recordingId,
    name: detail.name || body.name,
    source: detail.source || 'ai',
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
