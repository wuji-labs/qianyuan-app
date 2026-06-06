import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol';

import {
  METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY,
  RUNTIME_USAGE_LIMIT_RECOVERY_FIELD,
  UsageLimitRecoveryScheduler,
} from './UsageLimitRecoveryScheduler';

describe('UsageLimitRecoveryScheduler', () => {
  it('stores one active intent per session and supersedes older intents', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'old',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
    });
    const intent = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'new',
      resetAtMs: 3_000,
      selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
    });

    expect(intent.issueFingerprint).toBe('new');
    expect(scheduler.read('session-1')?.resetAtMs).toBe(3_000);
    expect(RUNTIME_USAGE_LIMIT_RECOVERY_FIELD).toBe(SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID);
    expect(METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY).toBe(SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY);
    expect(SessionUsageLimitRecoveryV1Schema.safeParse(intent).success).toBe(true);
  });

  it('preserves attempt and terminal state when the same usage-limit fingerprint re-arms', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });
    // Simulate the scheduler having burned attempts and reached a terminal state.
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'exhausted',
        issueFingerprint: 'limit-A',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        selectedAuth: { kind: 'native' },
      },
    });

    // Same fingerprint resurfaces: do NOT reset attempts/terminal state.
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    const intent = scheduler.read('session-1');
    expect(intent?.issueFingerprint).toBe('limit-A');
    expect(intent?.attemptCount).toBe(3);
    expect(intent?.status).toBe('exhausted');
  });

  it('starts fresh when a genuinely new usage-limit fingerprint arms', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'exhausted',
        issueFingerprint: 'limit-A',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        selectedAuth: { kind: 'native' },
      },
    });

    // Different fingerprint (new reset bucket) => fresh recovery lifecycle.
    const fresh = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-B',
      resetAtMs: 5_000,
      selectedAuth: { kind: 'native' },
    });

    expect(fresh.issueFingerprint).toBe('limit-B');
    expect(fresh.attemptCount).toBe(0);
    expect(fresh.status).toBe('waiting');
    expect(scheduler.read('session-1')?.resetAtMs).toBe(5_000);
    expect(scheduler.read('session-1')?.attemptCount).toBe(0);
  });

  it('does not preserve a cancelled state when the same fingerprint re-arms after user cancel', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });
    await scheduler.cancel({ sessionId: 'session-1' });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    // A cancelled lifecycle must remain cancelled (user intent) on same-fingerprint re-arm.
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('cancels active intents', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'issue',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await scheduler.cancel({ sessionId: 'session-1' });

    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('re-runs group recovery on wake instead of retrying the old profile directly', async () => {
    const selectedProfiles: string[] = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async (intent) => {
        if (intent.selectedAuth.kind !== 'group') throw new Error('expected group intent');
        selectedProfiles.push(intent.selectedAuth.profileId);
        return {
          status: 'ready',
          selectedAuth: {
            ...intent.selectedAuth,
            profileId: 'fresh-member',
          },
        };
      },
      resume: async () => {},
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'old-member',
      },
    });

    const result = await scheduler.wake({ sessionId: 'session-1', reason: 'timer' });

    expect(result.status).toBe('resumed');
    expect(selectedProfiles).toEqual(['old-member']);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
    expect(scheduler.read('session-1')?.selectedAuth).toMatchObject({
      kind: 'group',
      profileId: 'fresh-member',
    });
    expect(SessionUsageLimitRecoveryV1Schema.safeParse(scheduler.read('session-1')).success).toBe(true);
  });

  it('records a daemon restart diagnostic before resuming usage-limit recovery', async () => {
    const records: unknown[] = [];
    const resume = vi.fn(async () => {});
    const deps = {
      nowMs: () => 2_000,
      recover: async () => ({ status: 'ready' as const }),
      resume,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
    } satisfies ConstructorParameters<typeof UsageLimitRecoveryScheduler>[0];
    const scheduler = new UsageLimitRecoveryScheduler(deps);
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'resumed',
    });

    expect(resume).toHaveBeenCalledOnce();
    expect(records).toEqual([{
      type: 'connected_service_daemon_restart',
      trigger: 'usage_limit_recovery',
      status: 'requested',
      sessionId: 'session-1',
      agentId: null,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      generation: null,
      reason: 'limit',
      pid: null,
      processGroupPid: null,
      delayMs: null,
      atMs: 2_000,
    }]);
  });

  it('can restore an active intent from a durable store', async () => {
    const stored = new Map<string, unknown>();
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      write: (sessionId: string, intent: unknown) => {
        stored.set(sessionId, intent);
      },
    };
    const first = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    await first.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    const second = new UsageLimitRecoveryScheduler({ nowMs: () => 1_500, store });

    expect(second.read('session-1')?.issueFingerprint).toBe('limit');
  });

  it('prunes stale terminal durable intents when scheduling new usage-limit recovery', async () => {
    const nowMs = 8 * 24 * 60 * 60_000;
    const stored = new Map<string, unknown>([
      ['old-cancelled', {
        v: 1,
        status: 'cancelled',
        issueFingerprint: 'old-limit',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 1,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      }],
      ['fresh-exhausted', {
        v: 1,
        status: 'exhausted',
        issueFingerprint: 'fresh-limit',
        armedAtMs: nowMs - 1_000,
        resetAtMs: nowMs - 500,
        nextCheckAtMs: nowMs - 500,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        selectedAuth: { kind: 'native' },
      }],
    ]);
    const pruned: string[] = [];
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      readAll: () => [...stored.entries()],
      write: (sessionId: string, intent: unknown) => {
        stored.set(sessionId, intent);
      },
      prune: (predicate: (entry: Readonly<{ recoveryKey: string; value: unknown }>) => boolean) => {
        const removed: string[] = [];
        for (const [recoveryKey, value] of stored.entries()) {
          if (!predicate({ recoveryKey, value })) continue;
          stored.delete(recoveryKey);
          removed.push(recoveryKey);
        }
        pruned.push(...removed);
        return removed;
      },
    };
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      store,
    });

    await scheduler.enable({
      sessionId: 'session-new',
      issueFingerprint: 'new-limit',
      resetAtMs: nowMs + 1_000,
      selectedAuth: { kind: 'native' },
    });

    expect(pruned).toEqual(['old-cancelled']);
    expect(stored.has('old-cancelled')).toBe(false);
    expect(stored.has('fresh-exhausted')).toBe(true);
    expect(stored.has('session-new')).toBe(true);
  });

  it('hydrates persisted inactive intents and re-arms their timers after daemon restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const persisted = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'persisted-limit',
      armedAtMs: 100,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native' as const },
    };
    const store = {
      read: (sessionId: string) => sessionId === 'session-1' ? persisted : null,
      readAll: () => [['session-1', persisted] as const],
      write: vi.fn(),
    };
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      store,
      recover,
      resume,
    });

    expect(scheduler.hydrate()).toEqual([persisted]);
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledWith(expect.objectContaining({
      issueFingerprint: 'persisted-limit',
    }), { sessionId: 'session-1' });
    expect(resume).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('schedules a previously persisted intent without rewriting its timing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recovered: Array<Readonly<{ issueFingerprint: string; sessionId?: string }>> = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover: async (intent, context) => {
        recovered.push({ issueFingerprint: intent.issueFingerprint, sessionId: context.sessionId });
        return { status: 'ready' as const };
      },
    });

    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'persisted-limit',
        armedAtMs: 123,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'persisted-limit',
      armedAtMs: 123,
      nextCheckAtMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recovered).toEqual([{ issueFingerprint: 'persisted-limit', sessionId: 'session-1' }]);
    vi.useRealTimers();
  });

  it('schedules a timer wake when an intent is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('schedules a timer wake from nextCheckAtMs when resetAtMs is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: null,
      nextCheckAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    expect(scheduler.read('session-1')).toMatchObject({
      resetAtMs: null,
      nextCheckAtMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
    vi.useRealTimers();
  });

  it('re-arms the next timer when a probe still needs to wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi
      .fn()
      .mockResolvedValueOnce({ status: 'wait' as const, nextCheckAtMs: 3_000 })
      .mockResolvedValueOnce({ status: 'ready' as const });
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({ status: 'waiting', nextCheckAtMs: 3_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not probe before reset time on timer wakes', async () => {
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_500,
      recover,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });

    expect(recover).not.toHaveBeenCalled();
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextCheckAtMs: 2_000,
    });
  });

  it('exhausts an intent after its max attempts instead of retrying forever', async () => {
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: 2_000 }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      maxAttempts: 1,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' })).resolves.toEqual({
      status: 'waiting',
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' })).resolves.toEqual({
      status: 'exhausted',
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'exhausted',
      attemptCount: 2,
    });
  });

  it('rate-limits rapid user check-now probes for the same session', async () => {
    let nowMs = 2_000;
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: 3_000 }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      checkNowThrottleMs: 5_000,
      recover,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'waiting',
    });
    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'rate_limited',
      errorCode: 'probe_rate_limited',
      retryAfterMs: 5_000,
    });

    nowMs += 5_000;
    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'waiting',
    });
    expect(recover).toHaveBeenCalledTimes(2);
  });
});
