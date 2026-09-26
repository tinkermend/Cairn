import type { ChromeRecordedEvent } from '@midscene/recorder-ui';

const MAX_DRAFT_NAME_LENGTH = 64;
const DEFAULT_SESSION_NAME = /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{2}:\d{2}(?:-\d{3})?$/;
const LEGACY_SESSION_NAME = /^Session \d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}:\d{2} (?:AM|PM)$/i;

function shortText(value: string, maxLength: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, maxLength).join('');
}

function isAutomaticSessionName(name: string): boolean {
  return DEFAULT_SESSION_NAME.test(name) || LEGACY_SESSION_NAME.test(name) || /^识途录制[-_]/.test(name);
}

function pageTitle(events: ChromeRecordedEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'navigation' || !event.title) continue;
    const title = event.title.split(/\s+(?:-|—|\||｜)\s+/)[0]?.trim();
    if (!title || /https?:\/\/|@|[A-Za-z0-9_-]{32,}/.test(title)) continue;
    return shortText(title, 20);
  }
  return undefined;
}

function pagePath(events: ChromeRecordedEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'navigation' || !event.url) continue;
    try {
      const pathname = new URL(event.url).pathname;
      const segment = pathname.split('/').filter(Boolean).reverse().find((part) =>
        /^[a-z][a-z0-9_-]{2,23}$/i.test(part) && !/^(admin|index|home)$/i.test(part),
      );
      if (segment) return shortText(segment.replace(/[-_]+/g, ' '), 20);
    } catch {
      // A malformed or private URL should not become part of the draft name.
    }
  }
  return undefined;
}

function recordingDate(events: ChromeRecordedEvent[], now: Date): string {
  const firstTimestamp = events.find((event) =>
    Number.isFinite(event.timestamp) && event.timestamp >= Date.UTC(2000, 0, 1),
  )?.timestamp;
  const date = firstTimestamp === undefined ? now : new Date(firstTimestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Name a platform draft from recording context without a client-side model call. */
export function generateCairnDraftName(options: {
  targetName: string;
  sessionName?: string;
  events: ChromeRecordedEvent[];
  now?: Date;
}): string {
  const customName = options.sessionName?.trim();
  if (customName && !isAutomaticSessionName(customName)) {
    return shortText(customName, MAX_DRAFT_NAME_LENGTH);
  }

  const target = shortText(options.targetName || '目标系统', 22) || '目标系统';
  const page = pageTitle(options.events) || pagePath(options.events) || '页面操作';
  const date = recordingDate(options.events, options.now ?? new Date());
  return `${target} · ${page} · ${date}`;
}
