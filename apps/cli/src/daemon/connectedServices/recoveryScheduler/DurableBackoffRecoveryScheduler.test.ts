import { describe, expect, it, vi } from 'vitest';

import { DurableBackoffRecoveryScheduler } from './DurableBackoffRecoveryScheduler';

type TestIntent = Readonly<{
  status: 'waiting' | 'checking' | 'cancelled' | 'exhausted';
  nextRetryAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  terminalAtMs?: number | null;
}>;

function createIntent(): TestIntent {
  return {
    status: 'waiting',
    nextRetryAtMs: 1_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastError: null,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('DurableBackoffRecoveryScheduler', () => {
  it('stores and reads separate recovery intents with explicit recovery keys in one session', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          readAll: () => [...written.entries()],
          write: (key, intent) => {
            written.set(key, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsert({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: { ...createIntent(), lastError: 'codex' },
      });
      await scheduler.upsert({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:anthropic:backup:none',
        intent: { ...createIntent(), lastError: 'anthropic' },
      });

      expect(scheduler.readByKey('runtime-auth:v1:session-1:codex:primary:none')).toMatchObject({
        lastError: 'codex',
      });
      expect(scheduler.readByKey('runtime-auth:v1:session-1:anthropic:backup:none')).toMatchObject({
        lastError: 'anthropic',
      });
      expect(scheduler.readForSession('session-1').map((intent) => intent.lastError).sort()).toEqual([
        'anthropic',
        'codex',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges an explicit recovery-key upsert with the normalized previous intent', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          write: (key, intent) => {
            written.set(key, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsertByKey({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: {
          ...createIntent(),
          attemptCount: 2,
          nextRetryAtMs: 900,
          lastError: 'previous timeout',
        },
      });

      const merged = await scheduler.upsertMergedByKey({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: {
          ...createIntent(),
          attemptCount: 0,
          nextRetryAtMs: 1_500,
          lastError: 'latest timeout',
        },
        merge: (previous, next) => ({
          ...next,
          attemptCount: previous?.attemptCount ?? next.attemptCount,
          nextRetryAtMs: Math.min(previous?.nextRetryAtMs ?? next.nextRetryAtMs ?? Number.POSITIVE_INFINITY, next.nextRetryAtMs ?? Number.POSITIVE_INFINITY),
          lastError: next.lastError,
        }),
      });

      expect(merged).toMatchObject({
        attemptCount: 2,
        nextRetryAtMs: 900,
        lastError: 'latest timeout',
      });
      expect(scheduler.readByKey('runtime-auth:v1:session-1:codex:primary:none')).toEqual(merged);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an explicit recovery key from memory and durable storage without marking it cancelled', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const removed: string[] = [];
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (key) => written.get(key) ?? null,
          write: (key, intent) => {
            written.set(key, intent);
          },
          remove: (key) => {
            written.delete(key);
            removed.push(key);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsertByKey({
        sessionId: 'session-1',
        recoveryKey: 'runtime-auth:v1:session-1:codex:primary:none',
        intent: createIntent(),
      });

      await expect(scheduler.clearByKey('runtime-auth:v1:session-1:codex:primary:none'))
        .resolves.toMatchObject({ status: 'waiting' });

      expect(removed).toEqual(['runtime-auth:v1:session-1:codex:primary:none']);
      expect(scheduler.readByKey('runtime-auth:v1:session-1:codex:primary:none')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes stale terminal recovery intents before durable writes', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>([
        ['old-cancelled', { ...createIntent(), status: 'cancelled', nextRetryAtMs: null, terminalAtMs: 1_000 }],
        ['fresh-exhausted', { ...createIntent(), status: 'exhausted', nextRetryAtMs: null, terminalAtMs: 9_500 }],
        ['active-waiting', { ...createIntent(), nextRetryAtMs: 12_000 }],
      ]);
      const pruned: string[] = [];
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 10_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        terminalRecordRetentionMs: 5_000,
        getTerminalPruneReferenceMs: (intent) => intent.terminalAtMs ?? null,
        store: {
          read: (key) => written.get(key) ?? null,
          readAll: () => [...written.entries()],
          write: (key, intent) => {
            written.set(key, intent);
          },
          prune: (predicate) => {
            const removed: string[] = [];
            for (const [recoveryKey, value] of written.entries()) {
              if (!predicate({ recoveryKey, value })) continue;
              written.delete(recoveryKey);
              removed.push(recoveryKey);
            }
            pruned.push(...removed);
            return removed;
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => ({ status: 'success' }),
      });

      await scheduler.upsert({ sessionId: 'new-session', intent: createIntent() });

      expect(pruned).toEqual(['old-cancelled']);
      expect(written.has('old-cancelled')).toBe(false);
      expect(written.has('fresh-exhausted')).toBe(true);
      expect(written.has('active-waiting')).toBe(true);
      expect(written.has('new-session')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes thrown recovery errors before persisting retry state', async () => {
    vi.useFakeTimers();
    try {
      const rawAccessToken = 'scheduler-access-token-secret';
      const rawPath = '/Users/alice/.codex/auth.json';
      const written = new Map<string, TestIntent>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (sessionId) => written.get(sessionId) ?? null,
          write: (sessionId, intent) => {
            written.set(sessionId, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => {
          throw new Error(`probe failed accessToken=${rawAccessToken} path=${rawPath}`);
        },
      });

      await scheduler.upsert({ sessionId: 'session-1', intent: createIntent() });
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

      const intent = scheduler.read('session-1');
      expect(intent?.lastError).not.toContain(rawAccessToken);
      expect(intent?.lastError).not.toContain(rawPath);
      expect(intent?.lastError).toContain('[REDACTED]');
      expect(intent?.lastError).toContain('[REDACTED_LOCAL_PATH]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cancellation durable when recover resolves after cancel', async () => {
    vi.useFakeTimers();
    try {
      const written = new Map<string, TestIntent>();
      const recoverStarted = createDeferred<void>();
      const recoverOutcome = createDeferred<{
        status: 'wait';
        lastError: string;
      }>();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        store: {
          read: (sessionId) => written.get(sessionId) ?? null,
          write: (sessionId, intent) => {
            written.set(sessionId, intent);
          },
        },
        normalizeIntent: (value) => value as TestIntent,
        getStatus: (intent) => intent.status,
        getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
        getAttemptCount: (intent) => intent.attemptCount,
        getMaxAttempts: (intent) => intent.maxAttempts,
        markChecking: (intent, attemptCount) => ({
          ...intent,
          status: 'checking',
          attemptCount,
        }),
        markWaiting: (intent, input) => ({
          ...intent,
          status: 'waiting',
          nextRetryAtMs: input.nextRetryAtMs,
          lastError: input.lastError,
        }),
        markCancelled: (intent) => ({
          ...intent,
          status: 'cancelled',
          nextRetryAtMs: null,
          lastError: null,
        }),
        markExhausted: (intent, input) => ({
          ...intent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: input.lastError,
        }),
        recover: async () => {
          recoverStarted.resolve();
          return await recoverOutcome.promise;
        },
      });

      await scheduler.upsert({ sessionId: 'session-1', intent: createIntent() });

      const wakePromise = scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
      await recoverStarted.promise;

      await scheduler.cancel({ sessionId: 'session-1' });
      expect(scheduler.read('session-1')?.status).toBe('cancelled');

      recoverOutcome.resolve({ status: 'wait', lastError: 'still blocked' });

      await expect(wakePromise).resolves.toEqual({ status: 'inactive' });
      expect(scheduler.read('session-1')?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });
});
