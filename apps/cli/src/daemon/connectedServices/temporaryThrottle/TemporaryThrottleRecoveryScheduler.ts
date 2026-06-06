type TemporaryThrottleStatus = 'waiting' | 'checking' | 'exhausted' | 'cancelled';

type TemporaryThrottleRecoveryIntent = Readonly<{
  v: 1;
  status: TemporaryThrottleStatus;
  issueFingerprint: string;
  armedAtMs: number;
  nextRetryAtMs: number | null;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
}>;

type TemporaryThrottleRetryResult = Readonly<{
  status: 'ready' | 'wait' | 'exhausted';
  retryAfterMs?: number | null;
  lastError?: string | null;
}>;

type TemporaryThrottleRecoverySchedulerDeps = Readonly<{
  nowMs: () => number;
  jitterMs?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  retry?: (
    intent: TemporaryThrottleRecoveryIntent,
    context: { sessionId: string },
  ) => Promise<TemporaryThrottleRetryResult>;
  resume?: (
    intent: TemporaryThrottleRecoveryIntent,
    context: { sessionId: string },
  ) => Promise<void> | void;
}>;

type EnableTemporaryThrottleRecoveryInput = Readonly<{
  sessionId: string;
  issueFingerprint: string;
  retryAfterMs?: number | null;
  resetAtMs?: number | null;
  maxAttempts?: number;
}>;

const defaultMaxAttempts = 3;
const defaultBaseBackoffMs = 1_000;
const defaultMaxBackoffMs = 60_000;
type TimerHandle = ReturnType<typeof setTimeout>;

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function normalizeIntent(value: unknown): TemporaryThrottleRecoveryIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (
    record.status !== 'waiting'
    && record.status !== 'checking'
    && record.status !== 'exhausted'
    && record.status !== 'cancelled'
  ) {
    return null;
  }
  const issueFingerprint = typeof record.issueFingerprint === 'string' ? record.issueFingerprint.trim() : '';
  const armedAtMs = normalizeNonNegativeInteger(record.armedAtMs);
  const nextRetryAtMs = record.nextRetryAtMs === null ? null : normalizeNonNegativeInteger(record.nextRetryAtMs);
  const retryAfterMs = record.retryAfterMs === null ? null : normalizeNonNegativeInteger(record.retryAfterMs);
  const resetAtMs = record.resetAtMs === null ? null : normalizeNonNegativeInteger(record.resetAtMs);
  const attemptCount = normalizeNonNegativeInteger(record.attemptCount);
  const maxAttempts = normalizeNonNegativeInteger(record.maxAttempts);
  const lastError = record.lastError === null
    ? null
    : typeof record.lastError === 'string' && record.lastError.trim().length > 0
    ? record.lastError.trim()
    : null;
  if (
    issueFingerprint.length === 0
    || armedAtMs === null
    || nextRetryAtMs === undefined
    || retryAfterMs === undefined
    || resetAtMs === undefined
    || attemptCount === null
    || maxAttempts === null
  ) {
    return null;
  }
  return {
    v: 1,
    status: record.status,
    issueFingerprint,
    armedAtMs,
    nextRetryAtMs,
    retryAfterMs,
    resetAtMs,
    attemptCount,
    maxAttempts,
    lastError,
  };
}

export class TemporaryThrottleRecoveryScheduler {
  private readonly memoryStore = new Map<string, TemporaryThrottleRecoveryIntent>();
  private readonly timersBySessionId = new Map<string, TimerHandle>();
  private readonly wakePromisesBySessionId = new Map<string, Promise<{ status: string }>>();
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly deps: TemporaryThrottleRecoverySchedulerDeps) {
    this.baseBackoffMs = Math.max(1, Math.trunc(deps.baseBackoffMs ?? defaultBaseBackoffMs));
    this.maxBackoffMs = Math.max(this.baseBackoffMs, Math.trunc(deps.maxBackoffMs ?? defaultMaxBackoffMs));
  }

  async enable(input: EnableTemporaryThrottleRecoveryInput): Promise<{
    status: TemporaryThrottleStatus;
    nextRetryAtMs: number | null;
    attemptCount: number;
  }> {
    const retryAfterMs = normalizeNonNegativeInteger(input.retryAfterMs);
    const resetAtMs = normalizeNonNegativeInteger(input.resetAtMs);
    const nowMs = this.deps.nowMs();
    const nextIntent: TemporaryThrottleRecoveryIntent = {
      v: 1,
      status: 'waiting',
      issueFingerprint: input.issueFingerprint,
      armedAtMs: nowMs,
      retryAfterMs,
      resetAtMs,
      nextRetryAtMs: this.resolveInitialRetryAtMs({
        nowMs,
        retryAfterMs,
        resetAtMs,
      }),
      attemptCount: 0,
      maxAttempts: Math.max(1, Math.trunc(input.maxAttempts ?? defaultMaxAttempts)),
      lastError: null,
    };
    const intent = this.mergeSameTemporaryThrottleIntent(this.read(input.sessionId), nextIntent);
    await this.write(input.sessionId, intent);
    return {
      status: intent.status,
      nextRetryAtMs: intent.nextRetryAtMs,
      attemptCount: intent.attemptCount,
    };
  }

  private mergeSameTemporaryThrottleIntent(
    previous: TemporaryThrottleRecoveryIntent | null,
    next: TemporaryThrottleRecoveryIntent,
  ): TemporaryThrottleRecoveryIntent {
    if (!previous || previous.issueFingerprint !== next.issueFingerprint) return next;
    if (previous.status === 'exhausted') return previous;
    if (previous.status === 'checking') return previous;
    if (previous.status !== 'waiting') return next;
    const previousRetrySooner = previous.nextRetryAtMs !== null
      && (next.nextRetryAtMs === null || previous.nextRetryAtMs <= next.nextRetryAtMs);
    return {
      ...next,
      armedAtMs: previous.armedAtMs,
      attemptCount: previous.attemptCount,
      maxAttempts: Math.max(1, Math.min(previous.maxAttempts, next.maxAttempts)),
      retryAfterMs: previousRetrySooner ? previous.retryAfterMs : next.retryAfterMs,
      resetAtMs: previousRetrySooner ? previous.resetAtMs : next.resetAtMs,
      nextRetryAtMs: previousRetrySooner ? previous.nextRetryAtMs : next.nextRetryAtMs,
      lastError: previous.lastError,
    };
  }

  read(sessionId: string): TemporaryThrottleRecoveryIntent | null {
    const intent = normalizeIntent(this.memoryStore.get(sessionId) ?? null);
    if (intent) {
      this.memoryStore.set(sessionId, intent);
      this.schedule(sessionId, intent);
    }
    return intent;
  }

  async wake(input: { sessionId: string; reason: 'timer' | 'retry_now' }): Promise<{ status: string }> {
    const currentWake = this.wakePromisesBySessionId.get(input.sessionId);
    if (currentWake) return await currentWake;
    const wakePromise = this.performWake(input);
    this.wakePromisesBySessionId.set(input.sessionId, wakePromise);
    try {
      return await wakePromise;
    } finally {
      if (this.wakePromisesBySessionId.get(input.sessionId) === wakePromise) {
        this.wakePromisesBySessionId.delete(input.sessionId);
      }
    }
  }

  private async performWake(input: { sessionId: string; reason: 'timer' | 'retry_now' }): Promise<{ status: string }> {
    const intent = this.read(input.sessionId);
    if (!intent || intent.status === 'cancelled') return { status: 'inactive' };
    if (intent.status === 'exhausted') return { status: 'exhausted' };
    const nowMs = this.deps.nowMs();
    if (input.reason === 'timer' && intent.nextRetryAtMs !== null && nowMs < intent.nextRetryAtMs) {
      return { status: 'waiting' };
    }
    if (intent.attemptCount >= intent.maxAttempts) {
      await this.write(input.sessionId, {
        ...intent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: intent.lastError ?? 'max_attempts_exhausted',
      });
      return { status: 'exhausted' };
    }

    const checkingIntent: TemporaryThrottleRecoveryIntent = {
      ...intent,
      status: 'checking',
      attemptCount: intent.attemptCount + 1,
    };
    await this.write(input.sessionId, checkingIntent);

    let result: TemporaryThrottleRetryResult;
    try {
      result = await (this.deps.retry?.(checkingIntent, { sessionId: input.sessionId })
        ?? Promise.resolve({ status: 'ready' as const }));
    } catch {
      if (checkingIntent.attemptCount >= checkingIntent.maxAttempts) {
        await this.write(input.sessionId, {
          ...checkingIntent,
          status: 'exhausted',
          nextRetryAtMs: null,
          lastError: 'temporary_throttle_probe_failed',
        });
        return { status: 'exhausted' };
      }
      await this.write(input.sessionId, {
        ...checkingIntent,
        status: 'waiting',
        retryAfterMs: null,
        nextRetryAtMs: nowMs + this.computeBackoffMs(checkingIntent.attemptCount),
        lastError: 'temporary_throttle_probe_failed',
      });
      return { status: 'waiting' };
    }
    if (result.status === 'ready') {
      try {
        await this.deps.resume?.(checkingIntent, { sessionId: input.sessionId });
      } catch {
        if (checkingIntent.attemptCount >= checkingIntent.maxAttempts) {
          await this.write(input.sessionId, {
            ...checkingIntent,
            status: 'exhausted',
            nextRetryAtMs: null,
            lastError: 'temporary_throttle_resume_failed',
          });
          return { status: 'exhausted' };
        }
        await this.write(input.sessionId, {
          ...checkingIntent,
          status: 'waiting',
          retryAfterMs: null,
          nextRetryAtMs: nowMs + this.computeBackoffMs(checkingIntent.attemptCount),
          lastError: 'temporary_throttle_resume_failed',
        });
        return { status: 'waiting' };
      }
      await this.write(input.sessionId, {
        ...checkingIntent,
        status: 'cancelled',
        nextRetryAtMs: null,
        lastError: null,
      });
      return { status: 'resumed' };
    }
    if (result.status === 'exhausted' || checkingIntent.attemptCount >= checkingIntent.maxAttempts) {
      await this.write(input.sessionId, {
        ...checkingIntent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: result.lastError ?? 'max_attempts_exhausted',
      });
      return { status: 'exhausted' };
    }

    const retryAfterMs = normalizeNonNegativeInteger(result.retryAfterMs);
    await this.write(input.sessionId, {
      ...checkingIntent,
      status: 'waiting',
      retryAfterMs,
      nextRetryAtMs: nowMs + (retryAfterMs ?? this.computeBackoffMs(checkingIntent.attemptCount)),
      lastError: typeof result.lastError === 'string' && result.lastError.trim().length > 0
        ? result.lastError.trim()
        : null,
    });
    return { status: 'waiting' };
  }

  retryNow(input: { sessionId: string }): Promise<{ status: string }> {
    return this.wake({ sessionId: input.sessionId, reason: 'retry_now' });
  }

  async stopRetrying(input: { sessionId: string }): Promise<{ status: string } | null> {
    const intent = this.read(input.sessionId);
    if (!intent) return null;
    await this.write(input.sessionId, {
      ...intent,
      status: 'cancelled',
      nextRetryAtMs: null,
    });
    return { status: 'cancelled' };
  }

  private computeBackoffMs(attemptCount: number): number {
    const exponential = this.baseBackoffMs * (2 ** attemptCount);
    return Math.min(this.maxBackoffMs, exponential) + Math.max(0, Math.trunc(this.deps.jitterMs?.() ?? 0));
  }

  private resolveInitialRetryAtMs(input: Readonly<{
    nowMs: number;
    retryAfterMs: number | null;
    resetAtMs: number | null;
  }>): number {
    if (input.resetAtMs !== null && input.resetAtMs >= input.nowMs) return input.resetAtMs;
    return input.nowMs + (input.retryAfterMs ?? this.computeBackoffMs(0));
  }

  private async write(sessionId: string, intent: TemporaryThrottleRecoveryIntent): Promise<void> {
    this.memoryStore.set(sessionId, intent);
    this.schedule(sessionId, intent);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timersBySessionId.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.timersBySessionId.delete(sessionId);
  }

  private schedule(sessionId: string, intent: TemporaryThrottleRecoveryIntent): void {
    this.clearTimer(sessionId);
    if (intent.status !== 'waiting') return;
    if (typeof intent.nextRetryAtMs !== 'number' || !Number.isFinite(intent.nextRetryAtMs)) return;
    const delayMs = Math.max(0, intent.nextRetryAtMs - this.deps.nowMs());
    const timer = setTimeout(() => {
      this.timersBySessionId.delete(sessionId);
      void this.wake({ sessionId, reason: 'timer' }).catch(() => {});
    }, delayMs);
    timer.unref?.();
    this.timersBySessionId.set(sessionId, timer);
  }
}
