import { describe, expect, it } from '@rstest/core';
import type { ChromeRecordedEvent } from '@midscene/recorder-ui';
import { generateCairnDraftName } from '../src/utils/cairn-draft-name';

const pageInfo = { width: 1280, height: 720 };
const recordedAt = new Date(2026, 8, 25, 1, 37).getTime();

function navigation(title?: string, url = 'https://modelapi.im/admin/user-stats'): ChromeRecordedEvent {
  return { type: 'navigation', title, url, pageInfo, timestamp: recordedAt, hashId: 'navigation-1' };
}

describe('generateCairnDraftName', () => {
  it('replaces a timestamp session name with target, page and recording time', () => {
    expect(generateCairnDraftName({
      targetName: 'modelapi中转站',
      sessionName: '2026-09-25 01:37:10-279',
      events: [navigation('User Stats - API中转服务')],
    })).toBe('modelapi中转站 · User Stats · 2026-09-25 01:37');
  });

  it('preserves a user-written session name', () => {
    expect(generateCairnDraftName({
      targetName: 'modelapi中转站',
      sessionName: '查看用户用量并核对余额',
      events: [navigation('User Stats - API中转服务')],
    })).toBe('查看用户用量并核对余额');
  });

  it('uses a safe route label when the page title could contain private data', () => {
    const name = generateCairnDraftName({
      targetName: 'modelapi中转站',
      sessionName: 'Session 9/24/2026, 11:52:22 PM',
      events: [navigation('alice@example.com - User Stats', 'https://modelapi.im/monitor?token=private')],
    });
    expect(name).toBe('modelapi中转站 · monitor · 2026-09-25 01:37');
    expect(name).not.toContain('alice@example.com');
    expect(name).not.toContain('token=');
  });

  it('always produces a bounded name with no recorded input value', () => {
    const name = generateCairnDraftName({
      targetName: '很长的目标系统名称'.repeat(8),
      events: [
        navigation(undefined, 'https://modelapi.im/'),
        { type: 'input', value: 'a sensitive form value', pageInfo, timestamp: recordedAt + 1, hashId: 'input-1' },
      ],
    });
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toContain('页面操作');
    expect(name).not.toContain('sensitive');
  });
});
