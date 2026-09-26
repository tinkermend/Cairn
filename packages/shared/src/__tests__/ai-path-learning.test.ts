import { describe, expect, it } from 'vitest'
import {
  computeAiPathSignature,
  computeNamespaceDigest,
  computeStepDefinitionDigest,
  evaluateSolidifiableLevel,
  type AiTaskEvent,
} from '../ai-path-learning.js'
import type { Step } from '../step.js'

describe('ai-path-learning shared', () => {
  it('computes step definition digest regardless of step name', () => {
    const step1: Step = {
      id: 'step-1',
      name: 'Click Button A',
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: { instruction: '点击提交按钮' },
    }
    const step2: Step = {
      id: 'step-1',
      name: 'Click Button Renamed',
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: { instruction: '点击提交按钮' },
    }
    const digest1 = computeStepDefinitionDigest(step1)
    const digest2 = computeStepDefinitionDigest(step2)
    expect(digest1).toBe(digest2)
    expect(digest1.length).toBe(64)

    const stepDiff: Step = {
      ...step1,
      input: { instruction: '点击取消按钮' },
    }
    expect(computeStepDefinitionDigest(stepDiff)).not.toBe(digest1)
  })

  it('computes namespace digest deterministically', () => {
    const ns1 = computeNamespaceDigest({
      targetId: 't-1',
      targetAccountId: 'acc-1',
      scenarioId: 'sc-1',
      stepId: 'st-1',
      stepDefinitionDigest: 'a'.repeat(64),
      sdkVersion: '1.12.6',
      modelName: 'gpt-4o',
      modelFamily: 'openai',
    })
    const ns2 = computeNamespaceDigest({
      targetId: 't-1',
      targetAccountId: 'acc-1',
      scenarioId: 'sc-1',
      stepId: 'st-1',
      stepDefinitionDigest: 'a'.repeat(64),
      sdkVersion: '1.12.6',
      modelName: 'gpt-4o',
      modelFamily: 'openai',
    })
    expect(ns1).toBe(ns2)
    expect(ns1.length).toBe(64)
  })

  it('computes path signature ignoring Scroll/Sleep/CursorMove', () => {
    const baseEvent: Omit<AiTaskEvent, 'ordinal' | 'actionName' | 'binding'> = {
      attemptId: 'att-1',
      runId: 'run-1',
      stepRunId: 'srun-1',
      agentInstanceId: 'inst-1',
      phase: 'completed',
      source: 'action_edge',
      sdkVersion: '1.12.6',
      valueProvenance: { kind: 'none' },
      pageBefore: {
        url: 'https://example.com/app',
        urlPattern: 'https://example.com/app',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-24T00:00:00Z',
      },
      writeSignalCount: 0,
      writeSignalPaths: [],
      timestamp: '2026-09-24T00:00:00Z',
    }

    const eventsWithoutIgnored: AiTaskEvent[] = [
      {
        ...baseEvent,
        ordinal: 0,
        actionName: 'Tap',
        binding: {
          status: 'bound',
          redirected: false,
          candidates: [{ by: 'role', value: 'button', name: 'Submit' }],
          dataDependent: false,
        },
      },
    ]

    const eventsWithIgnored: AiTaskEvent[] = [
      {
        ...baseEvent,
        ordinal: 0,
        actionName: 'Scroll',
        binding: { status: 'not_applicable', redirected: false, candidates: [], dataDependent: false },
      },
      {
        ...baseEvent,
        ordinal: 1,
        actionName: 'Tap',
        binding: {
          status: 'bound',
          redirected: false,
          candidates: [{ by: 'role', value: 'button', name: 'Submit' }],
          dataDependent: false,
        },
      },
      {
        ...baseEvent,
        ordinal: 2,
        actionName: 'Sleep',
        binding: { status: 'not_applicable', redirected: false, candidates: [], dataDependent: false },
      },
    ]

    const sig1 = computeAiPathSignature(eventsWithoutIgnored)
    const sig2 = computeAiPathSignature(eventsWithIgnored)
    expect(sig1).not.toBeNull()
    expect(sig1).toBe(sig2)
  })

  it('returns null signature when an element-targeting action is unbound', () => {
    const events: AiTaskEvent[] = [
      {
        attemptId: 'att-1',
        runId: 'run-1',
        stepRunId: 'srun-1',
        agentInstanceId: 'inst-1',
        ordinal: 0,
        phase: 'completed',
        source: 'action_edge',
        actionName: 'Tap',
        sdkVersion: '1.12.6',
        binding: {
          status: 'unbound',
          reason: 'AI_NOT_FOUND',
          redirected: false,
          candidates: [],
          dataDependent: false,
        },
        valueProvenance: { kind: 'none' },
        pageBefore: {
          url: 'https://example.com',
          urlPattern: 'https://example.com',
          documentEpoch: 1,
          readyState: 'complete',
          timestamp: '2026-09-24T00:00:00Z',
        },
        writeSignalCount: 0,
        writeSignalPaths: [],
        timestamp: '2026-09-24T00:00:00Z',
      },
    ]
    expect(computeAiPathSignature(events)).toBeNull()
  })

  it('keeps valid signature when non-element actions (not_applicable) are present', () => {
    const events: AiTaskEvent[] = [
      {
        attemptId: 'att-1',
        runId: 'run-1',
        stepRunId: 'srun-1',
        agentInstanceId: 'inst-1',
        ordinal: 0,
        phase: 'completed',
        source: 'action_edge',
        actionName: 'Navigate',
        sdkVersion: '1.12.6',
        paramsSummary: { url: 'https://example.com/login' },
        binding: {
          status: 'not_applicable',
          redirected: false,
          candidates: [],
          dataDependent: false,
        },
        valueProvenance: { kind: 'none' },
        pageBefore: {
          url: 'about:blank',
          urlPattern: 'about:blank',
          documentEpoch: 0,
          readyState: 'complete',
          timestamp: '2026-09-24T00:00:00Z',
        },
        writeSignalCount: 0,
        writeSignalPaths: [],
        timestamp: '2026-09-24T00:00:00Z',
      },
      {
        attemptId: 'att-1',
        runId: 'run-1',
        stepRunId: 'srun-1',
        agentInstanceId: 'inst-1',
        ordinal: 1,
        phase: 'completed',
        source: 'action_edge',
        actionName: 'Tap',
        sdkVersion: '1.12.6',
        binding: {
          status: 'bound',
          redirected: false,
          candidates: [{ by: 'role', value: 'button', name: 'Login' }],
          dataDependent: false,
        },
        valueProvenance: { kind: 'none' },
        pageBefore: {
          url: 'https://example.com/login',
          urlPattern: 'https://example.com/login',
          documentEpoch: 1,
          readyState: 'complete',
          timestamp: '2026-09-24T00:00:01Z',
        },
        writeSignalCount: 0,
        writeSignalPaths: [],
        timestamp: '2026-09-24T00:00:01Z',
      },
    ]

    const sig = computeAiPathSignature(events)
    expect(sig).not.toBeNull()
    expect(sig?.length).toBe(64)
  })

  it('evaluates solidifiable levels properly', () => {
    const fullEvents: AiTaskEvent[] = [
      {
        attemptId: 'att-1',
        runId: 'run-1',
        stepRunId: 'srun-1',
        agentInstanceId: 'inst-1',
        ordinal: 0,
        phase: 'completed',
        source: 'action_edge',
        actionName: 'Tap',
        sdkVersion: '1.12.6',
        binding: {
          status: 'bound',
          redirected: false,
          candidates: [{ by: 'role', value: 'button', name: 'Save' }],
          dataDependent: false,
        },
        valueProvenance: { kind: 'none' },
        pageBefore: {
          url: 'https://example.com',
          urlPattern: 'https://example.com',
          documentEpoch: 1,
          readyState: 'complete',
          timestamp: '2026-09-24T00:00:00Z',
        },
        writeSignalCount: 0,
        writeSignalPaths: [],
        timestamp: '2026-09-24T00:00:00Z',
      },
    ]
    expect(evaluateSolidifiableLevel(fullEvents, 'SUCCEEDED', 'complete')).toEqual({
      level: 'full',
      reasons: [],
    })

    const partialEvents: AiTaskEvent[] = [
      {
        ...fullEvents[0]!,
        binding: {
          status: 'unbound',
          redirected: false,
          candidates: [],
          dataDependent: false,
        },
      },
    ]
    expect(evaluateSolidifiableLevel(partialEvents, 'SUCCEEDED', 'complete')).toEqual({
      level: 'partial',
      reasons: ['TAP_UNBOUND_STEP_0'],
    })

    const blockedEvents: AiTaskEvent[] = [
      {
        ...fullEvents[0]!,
        actionName: 'Hover',
      },
    ]
    expect(evaluateSolidifiableLevel(blockedEvents, 'SUCCEEDED', 'complete')).toEqual({
      level: 'blocked',
      reasons: ['UNSUPPORTED_ACTION_Hover_STEP_0'],
    })
  })
})
