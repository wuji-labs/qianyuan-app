import { describe, expect, it, vi } from 'vitest';

import { createLocalTurnLifecycleController, type LocalTurnLifecycleSnapshot } from '@/agent/localControl/turnLifecycle';
import { STANDARD_CONTINUATION_RESUME_PROMPT } from '@/daemon/connectedServices/continuation/continuationResumePrompt';
import type { RawJSONLines } from '../types';
import { createClaudeLocalLifecycleTracker } from './claudeLocalLifecycleTracker';

describe('createClaudeLocalLifecycleTracker', () => {
  it('translates lifecycle hooks and transcript continuation into safe handoff timing', async () => {
    vi.useFakeTimers();
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 500 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const waiting = lifecycle.waitForSafeRemoteHandoff();

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', stop_hook_active: false });
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observeTranscript({
      type: 'user',
      uuid: 'feedback',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Stop hook feedback:\nContinue.' }] },
    } as any);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'Stop', stop_hook_active: true });
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toMatchObject({ lastTerminalReason: 'completed' });
    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('does not convert a meta continuation no-op transcript pair into a completed provider turn', () => {
    const observed: LocalTurnLifecycleSnapshot[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (snapshot) => {
        observed.push(snapshot);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'meta-continuation-prompt',
      isMeta: true,
      message: {
        role: 'user',
        content: STANDARD_CONTINUATION_RESUME_PROMPT,
      },
    } satisfies RawJSONLines);
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'synthetic-no-response',
      model: '<synthetic>',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    } satisfies RawJSONLines);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: false,
      waitingForQuiescence: false,
    });
    expect(observed).toEqual([]);
    lifecycle.dispose();
  });

  it('treats StopFailure, transcript interruption, SessionEnd, and process exit as terminal boundaries', async () => {
    const failure = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const failureTracker = createClaudeLocalLifecycleTracker({ lifecycle: failure });
    failureTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const failureWait = failure.waitForSafeRemoteHandoff();
    failureTracker.observeHook({ session_id: 'sid', hook_event_name: 'StopFailure' });
    await expect(failureWait).resolves.toMatchObject({ lastTerminalReason: 'failed' });
    failure.dispose();

    const interrupted = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const interruptedTracker = createClaudeLocalLifecycleTracker({ lifecycle: interrupted });
    interruptedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const interruptedWait = interrupted.waitForSafeRemoteHandoff();
    interruptedTracker.observeTranscript({
      type: 'user',
      uuid: 'interrupt',
      message: { content: '[Request interrupted by user]' },
    } as any);
    await expect(interruptedWait).resolves.toMatchObject({ lastTerminalReason: 'aborted' });
    interrupted.dispose();

    const ended = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const endedTracker = createClaudeLocalLifecycleTracker({ lifecycle: ended });
    endedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const endedWait = ended.waitForSafeRemoteHandoff();
    endedTracker.observeHook({ session_id: 'sid', hook_event_name: 'SessionEnd', reason: 'other' });
    await expect(endedWait).resolves.toMatchObject({ lastTerminalReason: 'session-ended' });
    ended.dispose();

    const exited = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const exitedTracker = createClaudeLocalLifecycleTracker({ lifecycle: exited });
    exitedTracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    const exitedWait = exited.waitForSafeRemoteHandoff();
    exitedTracker.observeProcessExit();
    await expect(exitedWait).resolves.toMatchObject({ lastTerminalReason: 'process-exited' });
    exited.dispose();
  });

  it('preserves official and legacy StopFailure error discriminators on terminal lifecycle events', async () => {
    const observedDetails: Array<string | undefined> = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (_snapshot, event) => {
        if (event.type === 'turn_terminal') observedDetails.push(event.detail);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_type: 'legacy_should_not_win',
    } as any);
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      error_type: 'rate_limit',
    } as any);

    expect(observedDetails).toEqual(['rate_limit', 'rate_limit']);
    lifecycle.dispose();
  });

  it('keeps Claude Unified turns active while async Agent background tasks are still running', async () => {
    const observedSnapshots: LocalTurnLifecycleSnapshot[] = [];
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
      onStateChange: (snapshot) => {
        observedSnapshots.push(snapshot);
      },
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-2',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_2' },
    } as any);

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'yielded-while-agents-run',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agents are running.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
      waitingForQuiescence: false,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-1-completed',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>' },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'agent-2-completed',
      origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>agent_2</task-id><status>completed</status></task-notification>' },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
    });

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'summary-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All agents complete.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    expect(observedSnapshots.some((snapshot) => snapshot.terminal && snapshot.lastTerminalReason === 'completed')).toBe(true);
    lifecycle.dispose();
  });

  it('keeps an active Claude turn running across provider auto compact boundaries', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'system',
      uuid: 'auto-compact-boundary',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto' },
      session_id: 'sid-after-compact',
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
      waitingForQuiescence: false,
    });

    tracker.observeTranscript({
      type: 'user',
      uuid: 'tool-result-after-auto-compact',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({
      active: true,
      terminal: false,
    });

    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'summary-complete',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done after compact.' }] },
    } as any);

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('ignores sidechain-attributed hooks for the primary turn lifecycle', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    // A subagent prompt does not start a primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'UserPromptSubmit',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: false, terminal: false });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // Live incident 2026-06-12 (session cmq8171…): subagent auth StopFailures must not
    // fail the primary turn while the main agent keeps working.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'StopFailure',
      agent_id: 'agent_sidechain_1',
      agent_type: 'general-purpose',
      error: 'authentication_failed',
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // A subagent Stop does not complete the primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      agent_id: 'agent_sidechain_1',
      background_tasks: [],
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // A subagent SessionEnd does not end the primary turn.
    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'SessionEnd',
      agent_id: 'agent_sidechain_1',
      reason: 'other',
    });
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    // Main-agent terminal evidence still terminalizes (control).
    tracker.observeHook({ session_id: 'sid', hook_event_name: 'StopFailure' });
    expect(lifecycle.snapshot()).toMatchObject({ terminal: true, lastTerminalReason: 'failed' });
    lifecycle.dispose();
  });

  it('does not let a sidechain Stop clear async provider-task tracking', () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      agent_id: 'agent_sidechain_1',
      background_tasks: [],
    });

    // The async-agent ledger must still suppress completion while agent_1 runs.
    tracker.observeTranscript({
      type: 'assistant',
      uuid: 'yielded-while-agents-run',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agent is running.' }] },
    } as any);
    expect(lifecycle.snapshot()).toMatchObject({ active: true, terminal: false });

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [],
    });
    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });

  it('treats Stop with no background tasks as completion after async Agent launches', async () => {
    const lifecycle = createLocalTurnLifecycleController({
      completionQuiescenceMs: 0,
    });
    const tracker = createClaudeLocalLifecycleTracker({ lifecycle });

    tracker.observeHook({ session_id: 'sid', hook_event_name: 'UserPromptSubmit' });
    tracker.observeTranscript({
      type: 'user',
      uuid: 'launch-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Async agent launched successfully.' }],
      },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_1' },
    } as any);

    tracker.observeHook({
      session_id: 'sid',
      hook_event_name: 'Stop',
      background_tasks: [],
    });

    expect(lifecycle.snapshot()).toMatchObject({
      active: false,
      terminal: true,
      lastTerminalReason: 'completed',
    });
    lifecycle.dispose();
  });
});
