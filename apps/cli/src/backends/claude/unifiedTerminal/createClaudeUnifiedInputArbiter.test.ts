import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import type { ClaudeUnifiedInputArbiter } from './_types';

type ClaudeUnifiedCompactionLifecycleObservation = Readonly<{
  type: 'compaction';
  phase: 'started' | 'completed';
  observedAtMs?: number;
}>;

function observeCompaction(
  arbiter: ClaudeUnifiedInputArbiter,
  observation: ClaudeUnifiedCompactionLifecycleObservation,
): void {
  arbiter.observeLifecycle(observation as Parameters<ClaudeUnifiedInputArbiter['observeLifecycle']>[0]);
}

describe('createClaudeUnifiedInputArbiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects queued prompts in FIFO order when idle', async () => {
    let nowMs = 10_000;
    const injected: string[] = [];
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async (batch) => {
        injected.push(batch.message);
        return { status: 'injected', at: nowMs, bytesWritten: batch.message.length };
      },
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'first', origin: { kind: 'ui_pending' } });
    await arbiter.enqueueUiMessage({ message: 'second', origin: { kind: 'ui_pending' } });
    await arbiter.drainWhenSafe();
    expect(injected).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 2, lastDeferredReason: 'pane_initializing' });

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first']);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, headInputState: 'submitted' });

    nowMs += 1_000;
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injected).toEqual(['first', 'second']);
    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    expect(accepted).toEqual(['first', 'second']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, headInputState: 'submitted' });
  });

  it('defers pending-queue prompts while Claude is running and injects them after the turn becomes idle', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const accepted: Array<readonly [string, string]> = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt,
      onPromptAccepted: async (batch, acceptance) => {
        accepted.push([batch.message, acceptance.acceptedAs]);
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: 'terminal_busy',
      headInputState: 'waiting_for_readiness',
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual([['hello', 'new_turn']]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastDeferredReason: null });
  });

  it('injects explicit immediate prompts while Claude is running when the input surface is quiet', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const accepted: Array<readonly [string, string]> = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt,
      onPromptAccepted: async (batch, acceptance) => {
        accepted.push([batch.message, acceptance.acceptedAs]);
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_immediate' } });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual([['hello', 'in_flight_steer']]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastDeferredReason: null });
  });

  it('defers queued prompts while permission is blocked', async () => {
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const arbiter = createClaudeUnifiedInputArbiter({ injectPrompt });

    arbiter.observeLifecycle({ type: 'permission', blocked: true, observedAtMs: 0 });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'permission_blocked' });
  });

  it('defers queued prompts while the terminal user is typing', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockResolvedValue({ status: 'injected', at: 1, bytesWritten: 5 });
    const arbiter = createClaudeUnifiedInputArbiter({ nowMs: () => nowMs, injectPrompt });

    arbiter.observeUserTypingState({ userTyping: true, observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    nowMs += 1;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'user_typing' });
  });

  it('retries and injects after a stale user-typing startup observation expires', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockImplementation(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      maxWaitMs: 1_000,
      injectPrompt,
    });

    arbiter.observeUserTypingState({ userTyping: true, observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({ message: 'first prompt', origin: { kind: 'ui_pending' } });
    nowMs += 100;
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'user_typing' });

    nowMs += 900;
    await vi.advanceTimersByTimeAsync(900);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('redrains queued prompts after the quiet-window retry delay', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn().mockImplementation(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 100,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'pane_initializing' });

    nowMs += 100;
    await vi.advanceTimersByTimeAsync(100);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('redrains queued prompts after an adapter deferral retry delay', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi
      .fn()
      .mockResolvedValueOnce({ status: 'deferred' as const, reason: 'user_typing' as const, retryAfterMs: 75 })
      .mockImplementationOnce(async (batch) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastDeferredReason: 'user_typing' });

    nowMs += 75;
    await vi.advanceTimersByTimeAsync(75);

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastDeferredReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });


  it('fails closed when the terminal host reports a dead pane', async () => {
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'pane_dead',
        phase: 'liveness',
        duplicateRisk: 'none',
        recoverable: false,
      }),
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'hello', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'pane_dead',
      headInputState: 'failed_terminal',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_terminal',
      batch: expect.objectContaining({ message: 'hello' }),
      result: expect.objectContaining({ reason: 'pane_dead' }),
    }));
  });

  it('accepts the current queued prompt when Claude later confirms a recoverable terminal write', async () => {
    let nowMs = 10_000;
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'timeout',
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        recoverable: true,
      }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'large prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastFailureReason: 'timeout' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['large prompt']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastFailureReason: null });
  });

  it('retries safe recoverable injection failures instead of waiting for provider confirmation', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed' as const,
        reason: 'host_unreachable' as const,
        phase: 'before_write' as const,
        duplicateRisk: 'none' as const,
        recoverable: true,
      })
      .mockImplementationOnce(async (batch) => ({
        status: 'injected' as const,
        at: nowMs,
        bytesWritten: batch.message.length,
      }));
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectionRetryLimit: 1,
      injectionRetryBaseDelayMs: 25,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'large prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'host_unreachable',
      headInputState: 'failed_retryable',
    });
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(false);

    nowMs += 25;
    await vi.advanceTimersByTimeAsync(25);

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, lastFailureReason: null, headInputState: 'awaiting_provider_acceptance' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['large prompt']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, lastFailureReason: null, headInputState: 'submitted' });
  });

  it('marks ambiguous injection failures failed when provider confirmation never arrives', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt: async () => ({
        status: 'failed',
        reason: 'timeout',
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        recoverable: true,
      }),
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'ambiguous prompt', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'awaiting_provider_acceptance',
    });

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      batch: expect.objectContaining({ message: 'ambiguous prompt' }),
      result: expect.objectContaining({ reason: 'timeout' }),
    }));
    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(false);
  });

  it('marks host-level injected prompts ambiguous when provider confirmation never arrives', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({ status: 'injected' as const, at: nowMs, bytesWritten: batch.message.length }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt typed but not submitted', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
      batch: expect.objectContaining({ message: 'prompt typed but not submitted' }),
      result: expect.objectContaining({
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
      }),
    }));
    await arbiter.drainWhenSafe();
    expect(injectPrompt).toHaveBeenCalledTimes(1);
  });

  it('keeps a terminal-injected UI prompt retryable when compaction starts before provider acceptance', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt interrupted by compaction', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    observeCompaction(arbiter, { type: 'compaction', phase: 'started', observedAtMs: nowMs });
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);

    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
    });
    expect(arbiter.snapshot().headInputState).not.toBe('failed_ambiguous');

    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(injectPrompt.mock.calls.map(([batch]) => batch.message)).toEqual([
      'prompt interrupted by compaction',
      'prompt interrupted by compaction',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('accepts a terminal-injected UI prompt when a matching transcript echo appears after compaction', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const accepted: string[] = [];
    const onInjectionFailure = vi.fn();
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
      onInjectionFailure,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt echoed after compaction', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    observeCompaction(arbiter, { type: 'compaction', phase: 'started', observedAtMs: nowMs });
    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);
    await arbiter.drainWhenSafe();

    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual(['prompt echoed after compaction']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      lastFailureReason: null,
      headInputState: 'submitted',
    });
  });

  it('keeps an ambiguous timeout retryable when compaction completion is observed later', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      providerAcceptanceTimeoutMs: 40,
      injectPrompt,
    });

    await arbiter.enqueueUiMessage({ message: 'prompt compacted without precompact hook', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);

    nowMs += 40;
    await vi.advanceTimersByTimeAsync(40);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: 'timeout',
      headInputState: 'failed_ambiguous',
    });

    observeCompaction(arbiter, { type: 'compaction', phase: 'completed', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(injectPrompt.mock.calls.map(([batch]) => batch.message)).toEqual([
      'prompt compacted without precompact hook',
      'prompt compacted without precompact hook',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      lastFailureReason: null,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('does not accept the next queued prompt when Claude sends an extra confirmation', async () => {
    let nowMs = 10_000;
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      injectPrompt: async (batch) => ({ status: 'injected', at: nowMs, bytesWritten: batch.message.length }),
      onPromptAccepted: async (batch) => {
        accepted.push(batch.message);
      },
    });

    await arbiter.enqueueUiMessage({ message: 'first', origin: { kind: 'ui_pending' } });
    await arbiter.enqueueUiMessage({ message: 'second', origin: { kind: 'ui_pending' } });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    nowMs += 1_000;
    await arbiter.drainWhenSafe();

    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 2, headInputState: 'awaiting_provider_acceptance' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(true);

    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1, headInputState: 'submitted' });

    await expect(arbiter.confirmPromptAcceptedByProvider()).resolves.toBe(false);

    expect(accepted).toEqual(['first']);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1 });
  });
});
