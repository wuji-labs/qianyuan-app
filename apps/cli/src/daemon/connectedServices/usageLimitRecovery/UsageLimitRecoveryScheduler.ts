import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryAuthSelectionV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import {
  UsageLimitCheckNowRateLimiter,
  USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
} from '@/session/usageLimitRecoveryControls/usageLimitCheckNowRateLimiter';
import {
  recordConnectedServiceDaemonRestartDiagnostic,
  type ConnectedServiceDaemonRestartDiagnosticRecorder,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { DurableBackoffRecoveryScheduler } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';

export const RUNTIME_USAGE_LIMIT_RECOVERY_FIELD = SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID;
export const METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;

export type UsageLimitRecoveryIntent = SessionUsageLimitRecoveryV1;

type RecoveryResult =
  | Readonly<{ status: 'ready'; selectedAuth?: SessionUsageLimitRecoveryAuthSelectionV1 }>
  | Readonly<{ status: 'wait'; nextCheckAtMs: number; lastProbeError?: string | null }>
  | Readonly<{ status: 'exhausted'; lastProbeError?: string | null }>;

export type UsageLimitRecoveryIntentStore = Readonly<{
  read(sessionId: string): UsageLimitRecoveryIntent | unknown | null;
  readAll?: () => ReadonlyArray<readonly [sessionId: string, value: unknown]>;
  write(sessionId: string, intent: UsageLimitRecoveryIntent): Promise<void> | void;
}>;

function isUsageLimitRecoveryIntent(value: unknown): value is UsageLimitRecoveryIntent {
  return SessionUsageLimitRecoveryV1Schema.safeParse(value).success;
}

function readUsageLimitRecoveryServiceId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'native' ? null : selectedAuth.serviceId;
}

function readUsageLimitRecoveryProfileId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'native' ? null : selectedAuth.profileId;
}

function readUsageLimitRecoveryGroupId(
  selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1,
): string | null {
  return selectedAuth.kind === 'group' ? selectedAuth.groupId : null;
}

const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Merge a freshly-armed usage-limit intent against any prior intent.
 *
 * Same fingerprint => the issue resurfaced; preserve the existing lifecycle (attemptCount,
 * terminal/exhausted, cancelled, and next-retry timing) so backoff/dead-letter convergence
 * is not defeated by repeatedly re-arming at attemptCount 0. We still adopt the latest
 * selected auth so a candidate that changed out-of-band is honored.
 *
 * Different fingerprint (or no prior) => a genuinely new issue; start fresh from `next`.
 */
function mergeUsageLimitRecoveryRearm(
  previous: UsageLimitRecoveryIntent | null,
  next: UsageLimitRecoveryIntent,
): UsageLimitRecoveryIntent {
  if (!previous || previous.issueFingerprint !== next.issueFingerprint) return next;
  return {
    ...previous,
    selectedAuth: next.selectedAuth,
  };
}

function resolveUsageLimitRecoveryPruneReferenceMs(intent: UsageLimitRecoveryIntent): number {
  return Math.max(
    intent.armedAtMs,
    intent.resetAtMs ?? 0,
    intent.nextCheckAtMs ?? 0,
  );
}

export class UsageLimitRecoveryScheduler {
  private readonly scheduler: DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>;
  private readonly checkNowRateLimiter: UsageLimitCheckNowRateLimiter;

  constructor(private readonly deps: Readonly<{
    nowMs: () => number;
    store?: UsageLimitRecoveryIntentStore;
    recover?: (
      intent: UsageLimitRecoveryIntent,
      context: Readonly<{ sessionId: string }>,
    ) => Promise<RecoveryResult>;
    resume?: (intent: UsageLimitRecoveryIntent) => Promise<void>;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    checkNowThrottleMs?: number;
  }>) {
    this.checkNowRateLimiter = new UsageLimitCheckNowRateLimiter({
      nowMs: deps.nowMs,
      throttleMs: deps.checkNowThrottleMs,
    });
    this.scheduler = new DurableBackoffRecoveryScheduler<UsageLimitRecoveryIntent>({
      nowMs: deps.nowMs,
      store: deps.store,
      normalizeIntent: (value) => isUsageLimitRecoveryIntent(value) ? value : null,
      getStatus: (intent) => intent.status === 'armed'
        ? 'waiting'
        : intent.status === 'paused'
        ? 'cancelled'
        : intent.status,
      getNextRetryAtMs: (intent) => intent.nextCheckAtMs ?? intent.resetAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_USAGE_LIMIT_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: resolveUsageLimitRecoveryPruneReferenceMs,
      exhaustOnMaxAttemptOutcome: false,
      markChecking: (intent, attemptCount) => ({
        ...intent,
        status: 'checking',
        attemptCount,
      }),
      markWaiting: (intent, input) => ({
        ...intent,
        status: 'waiting',
        nextCheckAtMs: input.nextRetryAtMs,
        lastProbeError: input.lastError,
      }),
      markCancelled: (intent) => ({
        ...intent,
        status: 'cancelled',
      }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        lastProbeError: input.lastError,
      }),
      recover: async (intent, context) => {
        const recovery = deps.recover
          ? await deps.recover(intent, { sessionId: context.sessionId })
          : { status: 'wait' as const, nextCheckAtMs: intent.nextCheckAtMs ?? intent.resetAtMs ?? deps.nowMs() };
        if (recovery.status === 'ready') {
          return {
            status: 'success',
            intent: {
              ...intent,
              status: 'cancelled' as const,
              selectedAuth: recovery.selectedAuth ?? intent.selectedAuth,
            },
          };
        }
        if (recovery.status === 'exhausted') {
          return {
            status: 'exhausted',
            lastError: recovery.lastProbeError ?? null,
          };
        }
        return {
          status: 'wait',
          nextRetryAtMs: recovery.nextCheckAtMs,
          lastError: recovery.lastProbeError ?? null,
          intent: {
            ...intent,
            status: 'waiting' as const,
            nextCheckAtMs: recovery.nextCheckAtMs,
            lastProbeError: recovery.lastProbeError ?? null,
          },
        };
      },
      onSuccess: async ({ sessionId, intent }) => {
        recordConnectedServiceDaemonRestartDiagnostic({
          diagnostic: {
            trigger: 'usage_limit_recovery',
            sessionId,
            serviceId: readUsageLimitRecoveryServiceId(intent.selectedAuth),
            profileId: readUsageLimitRecoveryProfileId(intent.selectedAuth),
            groupId: readUsageLimitRecoveryGroupId(intent.selectedAuth),
            reason: intent.issueFingerprint,
          },
          status: 'requested',
          nowMs: this.deps.nowMs,
          recordRestartDiagnostic: this.deps.recordRestartDiagnostic,
        });
        await this.deps.resume?.(intent);
      },
    });
  }

  read(sessionId: string): UsageLimitRecoveryIntent | null {
    return this.scheduler.read(sessionId);
  }

  hydrate(): ReadonlyArray<UsageLimitRecoveryIntent> {
    return this.scheduler.hydrate();
  }

  async enable(input: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    resetAtMs: number | null;
    nextCheckAtMs?: number | null;
    maxAttempts?: number;
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1;
  }>): Promise<UsageLimitRecoveryIntent> {
    const nowMs = this.deps.nowMs();
    const maxAttempts = typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts)
      ? Math.max(0, Math.trunc(input.maxAttempts))
      : DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS;
    const intent: UsageLimitRecoveryIntent = {
      v: 1,
      issueFingerprint: input.issueFingerprint,
      status: 'waiting',
      armedAtMs: nowMs,
      resetAtMs: input.resetAtMs,
      nextCheckAtMs: input.nextCheckAtMs ?? input.resetAtMs,
      attemptCount: 0,
      maxAttempts,
      lastProbeError: null,
      selectedAuth: input.selectedAuth,
    };
    // Merge against any existing intent so a same-fingerprint resurfacing converges with the
    // existing backoff/dead-letter lifecycle instead of resetting attemptCount to 0 every time.
    // A genuinely new issue (different reset bucket/fingerprint) starts fresh.
    const merged = await this.scheduler.upsertMerged({
      sessionId: input.sessionId,
      intent,
      merge: mergeUsageLimitRecoveryRearm,
    });
    return merged;
  }

  async upsert(input: Readonly<{
    sessionId: string;
    intent: UsageLimitRecoveryIntent;
  }>): Promise<UsageLimitRecoveryIntent> {
    await this.scheduler.upsert({ sessionId: input.sessionId, intent: input.intent });
    return input.intent;
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<UsageLimitRecoveryIntent | null> {
    return await this.scheduler.cancel(input);
  }

  async checkNow(input: Readonly<{ sessionId: string }>): Promise<Readonly<{
    status: string;
    errorCode?: string;
    retryAfterMs?: number;
  }>> {
    const rateLimit = this.checkNowRateLimiter.check(input.sessionId);
    if (!rateLimit.allowed) {
      return {
        status: 'rate_limited',
        errorCode: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }
    return await this.wake({ sessionId: input.sessionId, reason: 'check_now' });
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'check_now' }>): Promise<Readonly<{ status: string }>> {
    const result = await this.scheduler.wake(input);
    return result.status === 'succeeded' ? { status: 'resumed' } : result;
  }
}
