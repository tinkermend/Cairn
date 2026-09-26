import { describe, expect, it } from '@rstest/core';
import { serializeRecorderEvent } from '../src/scripts/recorder-event-serialization';
import { buildMidsceneDemonstrationSource, midsceneUploadEvents } from '../src/utils/cairn';

describe('serializeRecorderEvent', () => {
  it('preserves semantic replay metadata', () => {
    const semantic = {
      source: 'recorderAI' as const,
      status: 'ready' as const,
      replayInstruction: 'Click the Submit button',
    };

    expect(
      serializeRecorderEvent({
        type: 'click',
        pageInfo: { width: 100, height: 100 },
        timestamp: 1,
        hashId: 'event-1',
        semantic,
      }),
    ).toMatchObject({ semantic });
  });

  it('uploads semantic AI actions and relative sidebar scrolling while removing duplicate navigation', () => {
    const pageInfo = { width: 100, height: 100 };
    const events = [
      { type: 'navigation' as const, url: 'https://modelapi.im/monitor', pageInfo, timestamp: 1, hashId: 'n1' },
      { type: 'navigation' as const, url: 'https://modelapi.im/monitor', pageInfo, timestamp: 2, hashId: 'n2' },
      { type: 'scroll' as const, value: '0,0', pageInfo, timestamp: 2.5, hashId: 'noop', rawPayload: { selector: 'nav' } },
      { type: 'scroll' as const, value: '0,100', pageInfo, timestamp: 2.75, hashId: 'partial', rawPayload: { selector: 'nav' } },
      { type: 'scroll' as const, value: '0,400', pageInfo, timestamp: 3, hashId: 's1', rawPayload: { selector: 'nav' } },
      {
        type: 'click' as const,
        pageInfo,
        timestamp: 4,
        hashId: 'c1',
        rawPayload: { selector: 'a[href="/available-channels"]', targetDescription: 'link "Available Channels"' },
        elementDescription: 'link "Available Channels"',
      },
    ];

    expect(serializeRecorderEvent(events[5]).rawPayload).toEqual(events[5].rawPayload);
    expect(midsceneUploadEvents(events)).toHaveLength(3);
    const source = buildMidsceneDemonstrationSource(events, 'target-id', undefined, 'capture-id');
    expect(source).toMatchObject({
      protocolVersion: 'demonstration@1',
      importProfile: 'midscene-recorder-json@1',
      channel: 'extension',
      facts: [
        { action: 'navigation', data: { url: 'https://modelapi.im/monitor' } },
        { action: 'aiScroll', data: { direction: 'down', distance: 400, scrollType: 'singleAction', targetDescription: 'left navigation sidebar' } },
        { action: 'click', data: { targetDescription: 'link "Available Channels"' } },
      ],
    });
    expect(JSON.stringify(source)).not.toContain('a[href=');
  });

  it('leaves an absolute scroll unresolved when its starting position is unknown', () => {
    const source = buildMidsceneDemonstrationSource([{
      type: 'scroll', value: '0,423', pageInfo: { width: 100, height: 100 },
      timestamp: 1, hashId: 's1', rawPayload: { selector: 'nav' },
    }], 'target-id', undefined, 'capture-id');
    expect(source.facts[0].diagnostics).toContain('滚动缺少可确认的起点，需在编排台修正');
  });

  it('keeps a click without semantic text unresolved instead of calling a CSS path an AI instruction', () => {
    const source = buildMidsceneDemonstrationSource([{
      type: 'click',
      pageInfo: { width: 100, height: 100 },
      timestamp: 1,
      hashId: 'c1',
      rawPayload: { selector: 'button > svg' },
      elementDescription: 'button > svg',
    }], 'target-id', undefined, 'capture-id');
    expect(source.facts[0].data).toEqual({});
    expect(source.facts[0].diagnostics).toContain('点击缺少可回放的元素语义，请在编排台修正');
  });
});
