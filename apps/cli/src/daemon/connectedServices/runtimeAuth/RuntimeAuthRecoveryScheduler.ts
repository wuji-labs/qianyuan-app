import type { DaemonServerWorkErrorClassification, DaemonServerWorkErrorKind } from '@/daemon/serverWork/types';
import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import {
  DurableBackoffRecoveryScheduler,
  type DurableRecoveryGateResult,
  type DurableRecoveryStore,
} from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES, type ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';
import { buildConnectedServiceUxDiagnostic } from '../diagnostics/connectedServiceUxDiagnostics';
import { sanitizeConnectedServiceDiagnosticString } from '../diagnostics/sanitizeConnectedServiceDiagnosticString';
import {
  isRecoveredProviderOutcomeProof,
  type ProviderOutcomeProofKind,
} from '../recovery/providerOutcomeProof';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { readConnectedServiceAuthGenerationApplyFailure } from './connectedServiceAuthGenerationApplyFailure';
import { isProvenRuntimeAuthRecoverySuccess } from './resolveRuntimeAuthRecoveryOutcome';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import {
  buildRuntimeAuthRecoveryScheduledUxDiagnostic,
  buildRuntimeAuthRecoveryTranscriptEvent,
  type ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1,
} from './projection/connectedServiceRuntimeAuthRecoveryProjection';

type RuntimeAuthRecoveryIntentStatus = 'waiting' | 'checking' | 'cancelled' | 'exhausted';
type RuntimeAuthRecoveryFailurePhase = 'handler' | 'apply';

export type RuntimeAuthRecoveryIntent = Readonly<{
  v: 1;
  sessionId: string;
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  status: RuntimeAuthRecoveryIntentStatus;
  armedAtMs: number;
  nextRetryAtMs: number | null;
  attemptCount: number;
  maxAttempts: number;
  // S2 degraded-retry track. Degraded lifecycle/endpoint-unavailable outcomes
  // (daemon shutting down, control endpoint unreachable) are a transient local
  // condition, not a provider failure. They must NOT advance `attemptCount` toward
  // dead-letter; instead they advance this separate, much larger budget so a long
  // local outage can be waited out without prematurely dead-lettering a recoverable
  // session. It is still bounded (cannot wait forever).
  degradedAttemptCount?: number;
  switchesThisTurn: number;
  classification: ConnectedServiceRuntimeFailureClassification;
  failurePhase: RuntimeAuthRecoveryFailurePhase;
  failureReason: string;
  lastError: string | null;
  lastErrorClassification: DaemonServerWorkErrorClassification | null;
  terminalAtMs?: number | null;
  terminalReason?: string | null;
}>;

export type RuntimeAuthRecoveryDiagnostic = Readonly<{
  event:
    | 'runtime_auth_recovery_enqueue'
    | 'runtime_auth_recovery_retry'
    | 'runtime_auth_recovery_success'
    | 'runtime_auth_recovery_dead_letter'
    | 'runtime_auth_recovery_terminal'
    | 'runtime_auth_recovery_delayed';
  sessionId: string;
  serviceId: string;
  groupId: string | null;
  profileId: string | null;
  failurePhase?: RuntimeAuthRecoveryFailurePhase;
  reason?: string;
  attemptCount?: number;
  nextRetryAtMs?: number | null;
  classification?: DaemonServerWorkErrorClassification | null;
  uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
  transcriptEvent?: ConnectedServiceRuntimeAuthRecoveryTranscriptEventV1;
}>;

type RuntimeAuthRecoverySchedulerDeps = Readonly<{
  nowMs: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: () => number;
  maxAttempts?: number;
  // S2: bounded degraded-retry budget for endpoint/lifecycle-unavailable outcomes (defaults apply).
  maxDegradedAttempts?: number;
  degradedBackoffMs?: number;
  store?: DurableRecoveryStore<RuntimeAuthRecoveryIntent>;
  recover: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    source: 'scheduler_retry';
  }>) => Promise<unknown>;
  gate?: (input: Readonly<{ sessionId: string; intent: RuntimeAuthRecoveryIntent }>) => DurableRecoveryGateResult;
  recordDiagnostic?: (event: RuntimeAuthRecoveryDiagnostic) => void;
}>;

type RetryDecision =
  | Readonly<{
      retryable: true;
      classification: DaemonServerWorkErrorClassification;
      failurePhase: RuntimeAuthRecoveryFailurePhase;
      failureReason: string;
      lastError: string | null;
    }>
  | Readonly<{
      retryable: false;
      classification: DaemonServerWorkErrorClassification | null;
      reason: string;
      failurePhase: RuntimeAuthRecoveryFailurePhase;
      lastError: string | null;
    }>;

const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS = 5;
const DEFAULT_RUNTIME_AUTH_RECOVERY_TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;
// S2: degraded retries (endpoint/lifecycle unavailable) get their own, much larger budget so a
// long local outage can be waited out without burning the normal attempt budget. Still bounded:
// once this many consecutive degraded retries occur the recovery becomes action-required rather
// than waiting forever. With a ~minute degraded backoff cap this is on the order of an hour.
const DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_DEGRADED_ATTEMPTS = 60;
const DEFAULT_RUNTIME_AUTH_RECOVERY_DEGRADED_BACKOFF_MS = 60_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function normalizeClassification(value: unknown): DaemonServerWorkErrorClassification | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (!kind) return null;
  const retryable = value.retryable;
  if (typeof retryable !== 'boolean') return null;
  return {
    kind,
    retryable,
    ...(typeof value.statusCode === 'number' ? { statusCode: Math.trunc(value.statusCode) } : {}),
    ...(typeof value.retryAfterMs === 'number' ? { retryAfterMs: Math.max(0, Math.trunc(value.retryAfterMs)) } : {}),
  } as DaemonServerWorkErrorClassification;
}

function normalizeRuntimeClassification(value: unknown): ConnectedServiceRuntimeFailureClassification | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  const serviceId = readString(value.serviceId);
  if (!kind || !serviceId) return null;
  const source = readString(value.source);
  if (
    source !== 'structured_provider_error'
    && source !== 'stable_provider_message'
    && source !== 'provider_runtime_marker'
  ) return null;
  return {
    ...value,
    kind,
    serviceId,
    profileId: readString(value.profileId),
    groupId: readString(value.groupId),
    resetsAtMs: value.resetsAtMs === null ? null : readNumber(value.resetsAtMs),
    planType: value.planType === null ? null : readString(value.planType),
    rateLimits: value.rateLimits ?? null,
    source,
  } as ConnectedServiceRuntimeFailureClassification;
}

function normalizeIntent(value: unknown): RuntimeAuthRecoveryIntent | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  if (
    value.status !== 'waiting'
    && value.status !== 'checking'
    && value.status !== 'cancelled'
    && value.status !== 'exhausted'
  ) return null;
  const sessionId = readString(value.sessionId);
  const serviceId = readString(value.serviceId);
  const classification = normalizeRuntimeClassification(value.classification);
  const armedAtMs = readNonNegativeNumber(value.armedAtMs);
  const attemptCount = readNonNegativeNumber(value.attemptCount);
  const maxAttempts = readNonNegativeNumber(value.maxAttempts);
  const switchesThisTurn = readNonNegativeNumber(value.switchesThisTurn);
  const nextRetryAtMs = value.nextRetryAtMs === null ? null : readNonNegativeNumber(value.nextRetryAtMs);
  if (
    !sessionId
    || !serviceId
    || !classification
    || armedAtMs === null
    || attemptCount === null
    || maxAttempts === null
    || switchesThisTurn === null
    || nextRetryAtMs === undefined
  ) return null;
  const failurePhase = value.failurePhase === 'apply' ? 'apply' : 'handler';
  return {
    v: 1,
    sessionId,
    serviceId,
    profileId: readString(value.profileId),
    groupId: readString(value.groupId),
    status: value.status,
    armedAtMs,
    nextRetryAtMs,
    attemptCount,
    maxAttempts,
    ...(readNonNegativeNumber(value.degradedAttemptCount) === null
      ? {}
      : { degradedAttemptCount: readNonNegativeNumber(value.degradedAttemptCount) as number }),
    switchesThisTurn,
    classification,
    failurePhase,
    failureReason: readString(value.failureReason) ?? 'unknown',
      lastError: readString(value.lastError),
      lastErrorClassification: normalizeClassification(value.lastErrorClassification),
      terminalAtMs: value.terminalAtMs === undefined || value.terminalAtMs === null
        ? null
        : readNonNegativeNumber(value.terminalAtMs),
      terminalReason: value.terminalReason === undefined || value.terminalReason === null
        ? null
        : readString(value.terminalReason),
  };
}

function buildTerminalRuntimeAuthIntent(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  nowMs: number;
  terminalReason: string | null;
}>): RuntimeAuthRecoveryIntent {
  return {
    ...input.intent,
    status: 'cancelled',
    nextRetryAtMs: null,
    terminalAtMs: input.nowMs,
    terminalReason: input.terminalReason,
  };
}

function readSwitchAttemptResult(result: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(result)) return null;
  if (result.status === 'switch_attempted' && isRecord(result.result)) return result.result;
  return result;
}

// Non-terminal degraded lifecycle outcomes from a recovery handler. Neither is a
// success and neither is terminal: the recovery must stay WAITING and be re-driven
// when the daemon/endpoint is healthy again.
//   - daemon_lifecycle_unavailable: the daemon is shutting down / control server is
//     stopping. The handler early-returned WITHOUT running switch/restart/continuation.
//     Treated as a deferral (the gate already avoids counting it as an attempt).
//   - session_endpoint_unavailable: the session control endpoint was unreachable
//     (ECONNREFUSED / socket hang up) during a recovery fetch — a transient outage.
function isDegradedLifecycleRecoveryResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return result.status === 'daemon_lifecycle_unavailable'
    || result.status === 'session_endpoint_unavailable';
}

function resolveDegradedReason(result: unknown): string {
  return isRecord(result) && result.status === 'daemon_lifecycle_unavailable'
    ? 'recovery_deferred_shutdown'
    : 'session_endpoint_unavailable';
}

// Build the recover-loop outcome for a DEGRADED lifecycle/endpoint-unavailable result.
//
// The durable scheduler already incremented `attemptCount` (via markChecking) for this tick. A
// degraded outcome must NOT consume the normal attempt budget, so we roll `attemptCount` back to
// its pre-tick value and instead advance a separate, much larger `degradedAttemptCount` budget.
// This lets a long local outage be waited out (re-driven on every wake) without dead-lettering a
// recoverable session, while staying bounded: once the degraded budget is exhausted we surface an
// action-required terminal rather than waiting forever.
function buildDegradedRecoveryOutcome(input: Readonly<{
  intent: RuntimeAuthRecoveryIntent;
  reason: string;
  nowMs: number;
  maxDegradedAttempts: number;
  degradedBackoffMs: number;
}>): { status: 'wait'; nextRetryAtMs: number; lastError: string; intent: RuntimeAuthRecoveryIntent }
  | { status: 'terminal'; lastError: string; intent: RuntimeAuthRecoveryIntent } {
  const preTickAttemptCount = Math.max(0, input.intent.attemptCount - 1);
  const degradedAttemptCount = (input.intent.degradedAttemptCount ?? 0) + 1;
  if (degradedAttemptCount >= input.maxDegradedAttempts) {
    return {
      status: 'terminal',
      lastError: 'degraded_recovery_attempts_exhausted',
      intent: {
        ...input.intent,
        attemptCount: preTickAttemptCount,
        degradedAttemptCount,
      },
    };
  }
  return {
    status: 'wait',
    nextRetryAtMs: input.nowMs + input.degradedBackoffMs,
    lastError: input.reason,
    intent: {
      ...input.intent,
      attemptCount: preTickAttemptCount,
      degradedAttemptCount,
    },
  };
}

function readApplyFailure(result: unknown): Readonly<{
  errorCode: string;
  diagnostics: Readonly<Record<string, unknown>> | null;
}> | null {
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult || switchResult.status !== 'generation_apply_failed') return null;
  const errorCode = readString(switchResult.errorCode);
  if (!errorCode) return null;
  return {
    errorCode,
    diagnostics: isRecord(switchResult.diagnostics) ? switchResult.diagnostics : null,
  };
}

function classifyApplyFailure(result: unknown): RetryDecision | null {
  const failure = readApplyFailure(result);
  if (!failure) return null;
  if (
    failure.errorCode === 'provider_account_adoption_mismatch'
    || failure.errorCode === 'post_switch_verification_failed'
  ) {
    const verification = isRecord(failure.diagnostics?.verification)
      ? failure.diagnostics.verification
      : null;
    const explicit = normalizeClassification(verification?.errorClassification)
      ?? normalizeClassification(failure.diagnostics?.errorClassification);
    const retryable = failure.diagnostics?.retryable === true || explicit?.retryable === true;
    if (retryable) {
      return {
        retryable: true,
        classification: explicit ?? { kind: 'protocol_error', retryable: true },
        failurePhase: 'apply',
        failureReason: failure.errorCode,
        lastError: readString(verification?.reason) ?? failure.errorCode,
      };
    }
    return {
      retryable: false,
      classification: explicit,
      reason: 'non_retryable_apply_failure',
      failurePhase: 'apply',
      lastError: readString(verification?.reason) ?? failure.errorCode,
    };
  }
  if (
    failure.errorCode === 'restart_failed'
    && failure.diagnostics?.failurePhase === 'restart'
    && failure.diagnostics.retryable === true
  ) {
    const explicit = normalizeClassification(failure.diagnostics?.errorClassification);
    return {
      retryable: true,
      classification: explicit ?? { kind: 'protocol_error', retryable: true },
      failurePhase: 'apply',
      failureReason: 'restart_failed',
      lastError: 'restart_failed',
    };
  }
  if (failure.errorCode !== 'hot_apply_failed') {
    return {
      retryable: false,
      classification: null,
      reason: 'non_retryable_apply_failure',
      failurePhase: 'apply',
      lastError: failure.errorCode,
    };
  }

  const explicit = normalizeClassification(failure.diagnostics?.underlyingErrorClassification);
  const underlyingError = readString(failure.diagnostics?.underlyingError);
  const sanitizedUnderlyingError = underlyingError
    ? sanitizeConnectedServiceDiagnosticString(underlyingError)
    : null;
  const classification = explicit ?? (underlyingError ? classifyDaemonServerWorkError(new Error(underlyingError)) : null);
  if (classification?.retryable) {
    return {
      retryable: true,
      classification,
      failurePhase: 'apply',
      failureReason: 'hot_apply_failed',
      lastError: sanitizedUnderlyingError ?? failure.errorCode,
    };
  }
  return {
    retryable: false,
    classification,
    reason: 'non_retryable_apply_failure',
    failurePhase: 'apply',
    lastError: sanitizedUnderlyingError ?? failure.errorCode,
  };
}

// Provider-outcome proof gate. A switch event, auth-store adoption, credential
// refresh, or restart request is a recovery PHASE, not proof the provider can
// authenticate. Recovery is only cleared as recovered when there is deterministic
// recovered proof (currently verified account adoption). A genuinely fresh
// candidate is still useful intermediate evidence, but it is not yet provider
// acceptance. Local-only completions (credential_refreshed, generic ok:true,
// unverified switch / observed_generation) are NOT success — see
// resolveRuntimeAuthRecoveryOutcome.
function isRuntimeAuthRecoverySuccess(result: unknown): boolean {
  return isProvenRuntimeAuthRecoverySuccess(result);
}

// A local recovery step completed (a switch was applied / a credential was
// refreshed / a generation was observed / a generic ok was returned) but carries
// no deterministic provider-outcome proof. This is NOT terminal: the recovery must
// stay pending under the scheduler backoff/exhaustion lifecycle rather than being
// fabricated into "recovered" (the live Codex/Pi/Claude loop bug). WAVE-2 SEAM:
// bounded provider-activity proof will be the deterministic terminator here; until
// then unproven completions wait and eventually exhaust rather than wait forever.
function isLocallyCompleteWithoutProof(result: unknown): boolean {
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult) return false;
  return switchResult.status === 'switched'
    || switchResult.status === 'observed_generation'
    || switchResult.status === 'credential_refreshed'
    || switchResult.ok === true;
}

function isRuntimeAuthRecoveryTerminal(result: unknown): boolean {
  const switchResult = readSwitchAttemptResult(result);
  if (!switchResult) return true;
  return switchResult.status !== 'generation_apply_failed';
}

function classifyHandlerError(error: unknown): RetryDecision {
  const applyFailure = readConnectedServiceAuthGenerationApplyFailure(error);
  if (applyFailure) {
    return classifyApplyFailure({
      status: 'generation_apply_failed',
      errorCode: applyFailure.errorCode,
      ...(applyFailure.diagnostics === undefined ? {} : { diagnostics: applyFailure.diagnostics }),
    }) ?? {
      retryable: false,
      classification: null,
      reason: 'non_retryable_apply_failure',
      failurePhase: 'apply',
      lastError: applyFailure.errorCode,
    };
  }
  const classification = classifyDaemonServerWorkError(error);
  const message = sanitizeConnectedServiceDiagnosticString(error instanceof Error ? error.message : String(error));
  if (classification.retryable) {
    // A transient local-endpoint outage (ECONNREFUSED / socket hang up / reset / timeout)
    // during a recovery fetch is the `session_endpoint_unavailable` edge: the session control
    // endpoint was unreachable. Surface a stable reason for diagnostics; it stays retryable/waiting.
    const failureReason = (classification.kind === 'network' || classification.kind === 'timeout')
      ? 'session_endpoint_unavailable'
      : 'handler_transient_failure';
    return {
      retryable: true,
      classification,
      failurePhase: 'handler',
      failureReason,
      lastError: message,
    };
  }
  return {
    retryable: false,
    classification,
    reason: 'non_retryable_handler_failure',
    failurePhase: 'handler',
    lastError: message,
  };
}

function resolveClassifiedFailureRetryAfterMs(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  nowMs: number;
}>): number | undefined {
  const retryAfterMs = input.classification.retryAfterMs;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) {
    return Math.max(0, Math.trunc(retryAfterMs));
  }
  const resetsAtMs = input.classification.resetsAtMs;
  if (typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs) && resetsAtMs > input.nowMs) {
    return Math.max(0, Math.trunc(resetsAtMs - input.nowMs));
  }
  return undefined;
}

function buildClassifiedFailureIntakeDecision(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  nowMs: number;
}>): RetryDecision {
  const retryAfterMs = resolveClassifiedFailureRetryAfterMs(input);
  return {
    retryable: true,
    classification: {
      kind: mapRuntimeFailureKindToDaemonWorkErrorKind(input.classification.kind),
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
    failurePhase: 'handler',
    failureReason: 'classified_failure_reported',
    lastError: input.classification.kind,
  };
}

function mapRuntimeFailureKindToDaemonWorkErrorKind(
  kind: ConnectedServiceRuntimeFailureClassification['kind'],
): DaemonServerWorkErrorKind {
  switch (kind) {
    case 'auth_expired':
    case 'refresh_failed':
    case 'account_changed':
    case 'permission_denied':
    case 'account_disabled':
      return 'auth_failed';
    case 'usage_limit':
    case 'rate_limit':
    case 'temporary_throttle':
      return 'rate_limited';
    case 'dependency_failure':
      return 'dependency_unavailable';
    case 'capacity':
      return 'server_error';
    case 'validation':
      return 'client_error';
    case 'plan':
    case 'unknown':
      return 'protocol_error';
  }
}

function normalizeMaxAttempts(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS;
  return Math.max(1, Math.trunc(value));
}

function buildRecoveryKeyForIntent(
  intent: Pick<RuntimeAuthRecoveryIntent, 'sessionId' | 'serviceId' | 'profileId' | 'groupId'>,
): string {
  return buildRuntimeAuthRecoveryKey({
    sessionId: intent.sessionId,
    serviceId: intent.serviceId,
    profileId: intent.profileId,
    groupId: intent.groupId,
  });
}

function isTerminalRuntimeAuthRecoveryStatus(status: RuntimeAuthRecoveryIntentStatus): boolean {
  return status === 'cancelled' || status === 'exhausted';
}

function mergeRuntimeAuthNextRetryAtMs(
  previous: RuntimeAuthRecoveryIntent,
  next: RuntimeAuthRecoveryIntent,
): number | null {
  if (isTerminalRuntimeAuthRecoveryStatus(previous.status)) return previous.nextRetryAtMs;
  if (previous.nextRetryAtMs === null) return next.nextRetryAtMs;
  if (next.nextRetryAtMs === null) return previous.nextRetryAtMs;
  return Math.min(previous.nextRetryAtMs, next.nextRetryAtMs);
}

function mergeRuntimeAuthRecoveryIntent(
  previous: RuntimeAuthRecoveryIntent | null,
  next: RuntimeAuthRecoveryIntent,
): RuntimeAuthRecoveryIntent {
  if (!previous) return next;
  return {
    ...next,
    status: previous.status,
    nextRetryAtMs: mergeRuntimeAuthNextRetryAtMs(previous, next),
    attemptCount: previous.attemptCount,
    maxAttempts: Math.min(previous.maxAttempts, next.maxAttempts),
    terminalAtMs: isTerminalRuntimeAuthRecoveryStatus(previous.status)
      ? previous.terminalAtMs ?? null
      : next.terminalAtMs ?? null,
    terminalReason: isTerminalRuntimeAuthRecoveryStatus(previous.status)
      ? previous.terminalReason ?? null
      : next.terminalReason ?? null,
  };
}

function isSameServerWorkErrorClassification(
  left: DaemonServerWorkErrorClassification | null,
  right: DaemonServerWorkErrorClassification | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.retryable === right.retryable
    && left.statusCode === right.statusCode
    && left.retryAfterMs === right.retryAfterMs;
}

function isSameRuntimeFailureClassification(
  left: ConnectedServiceRuntimeFailureClassification,
  right: ConnectedServiceRuntimeFailureClassification,
): boolean {
  return left.kind === right.kind
    && left.serviceId === right.serviceId
    && left.profileId === right.profileId
    && left.groupId === right.groupId
    && left.resetsAtMs === right.resetsAtMs
    && left.planType === right.planType
    && left.source === right.source;
}

function hasSameRuntimeAuthFailureFields(
  left: RuntimeAuthRecoveryIntent,
  right: RuntimeAuthRecoveryIntent,
): boolean {
  return left.switchesThisTurn === right.switchesThisTurn
    && left.failurePhase === right.failurePhase
    && left.failureReason === right.failureReason
    && left.lastError === right.lastError
    && isSameServerWorkErrorClassification(left.lastErrorClassification, right.lastErrorClassification)
    && isSameRuntimeFailureClassification(left.classification, right.classification);
}

function mergeRuntimeAuthWakeNextRetryAtMs(
  current: RuntimeAuthRecoveryIntent,
  next: RuntimeAuthRecoveryIntent,
): number | null {
  if (next.status !== 'waiting') return next.nextRetryAtMs;
  if (current.nextRetryAtMs === null) return next.nextRetryAtMs;
  if (next.nextRetryAtMs === null) return current.nextRetryAtMs;
  return Math.min(current.nextRetryAtMs, next.nextRetryAtMs);
}

function mergeRuntimeAuthRecoveryWakeWrite(input: Readonly<{
  current: RuntimeAuthRecoveryIntent | null;
  base: RuntimeAuthRecoveryIntent;
  next: RuntimeAuthRecoveryIntent;
  reason: string;
}>): RuntimeAuthRecoveryIntent {
  if (!input.current) return input.next;
  if (isTerminalRuntimeAuthRecoveryStatus(input.current.status)) return input.current;
  if (input.reason === 'success') return input.next;
  if (hasSameRuntimeAuthFailureFields(input.current, input.base)) return input.next;
  const keepLatestFailureMessage = input.reason === 'waiting' || input.reason === 'delayed';
  return {
    ...input.next,
    switchesThisTurn: input.current.switchesThisTurn,
    classification: input.current.classification,
    failurePhase: input.current.failurePhase,
    failureReason: input.current.failureReason,
    lastError: keepLatestFailureMessage ? input.current.lastError : input.next.lastError,
    lastErrorClassification: input.current.lastErrorClassification,
    attemptCount: Math.max(input.current.attemptCount, input.next.attemptCount),
    maxAttempts: Math.min(input.current.maxAttempts, input.next.maxAttempts),
    nextRetryAtMs: mergeRuntimeAuthWakeNextRetryAtMs(input.current, input.next),
  };
}

export class RuntimeAuthRecoveryScheduler {
  private readonly maxAttempts: number;
  private readonly maxDegradedAttempts: number;
  private readonly degradedBackoffMs: number;
  private readonly scheduler: DurableBackoffRecoveryScheduler<RuntimeAuthRecoveryIntent>;

  constructor(private readonly deps: RuntimeAuthRecoverySchedulerDeps) {
    this.maxAttempts = normalizeMaxAttempts(deps.maxAttempts);
    this.maxDegradedAttempts = typeof deps.maxDegradedAttempts === 'number'
      && Number.isFinite(deps.maxDegradedAttempts)
      && deps.maxDegradedAttempts > 0
      ? Math.trunc(deps.maxDegradedAttempts)
      : DEFAULT_RUNTIME_AUTH_RECOVERY_MAX_DEGRADED_ATTEMPTS;
    this.degradedBackoffMs = typeof deps.degradedBackoffMs === 'number'
      && Number.isFinite(deps.degradedBackoffMs)
      && deps.degradedBackoffMs > 0
      ? Math.trunc(deps.degradedBackoffMs)
      : DEFAULT_RUNTIME_AUTH_RECOVERY_DEGRADED_BACKOFF_MS;
    this.scheduler = new DurableBackoffRecoveryScheduler<RuntimeAuthRecoveryIntent>({
      nowMs: deps.nowMs,
      baseBackoffMs: deps.baseBackoffMs,
      maxBackoffMs: deps.maxBackoffMs,
      jitterMs: deps.jitterMs,
      store: deps.store,
      normalizeIntent,
      getStatus: (intent) => intent.status,
      getNextRetryAtMs: (intent) => intent.nextRetryAtMs,
      getAttemptCount: (intent) => intent.attemptCount,
      getMaxAttempts: (intent) => intent.maxAttempts,
      terminalRecordRetentionMs: DEFAULT_RUNTIME_AUTH_RECOVERY_TERMINAL_RECORD_RETENTION_MS,
      getTerminalPruneReferenceMs: (intent) => intent.terminalAtMs ?? intent.armedAtMs,
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
        terminalAtMs: deps.nowMs(),
        terminalReason: null,
      }),
      markExhausted: (intent, input) => ({
        ...intent,
        status: 'exhausted',
        nextRetryAtMs: null,
        lastError: input.lastError,
        terminalAtMs: deps.nowMs(),
        terminalReason: input.lastError,
      }),
      clearOnSuccess: true,
      getSessionId: (intent) => intent.sessionId,
      gate: deps.gate,
      mergeBeforeWakeWrite: ({ current, base, next, reason }) => mergeRuntimeAuthRecoveryWakeWrite({
        current,
        base,
        next,
        reason,
      }),
      recover: async (intent) => {
        try {
          const result = await deps.recover({
            sessionId: intent.sessionId,
            switchesThisTurn: intent.switchesThisTurn,
            classification: intent.classification,
            source: 'scheduler_retry',
          });
          if (isRuntimeAuthRecoverySuccess(result)) return { status: 'success' };
          const applyDecision = classifyApplyFailure(result);
          if (applyDecision?.retryable) {
            return {
              status: 'wait',
              lastError: applyDecision.lastError,
              intent: {
                ...intent,
                lastErrorClassification: applyDecision.classification,
                lastError: applyDecision.lastError,
              },
            };
          }
          if (applyDecision && !applyDecision.retryable) {
            return {
              status: 'terminal',
              lastError: applyDecision.lastError,
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: applyDecision.lastError,
                  lastErrorClassification: applyDecision.classification,
                },
                nowMs: deps.nowMs(),
                terminalReason: applyDecision.lastError,
              }),
            };
          }
          // A local recovery step completed but produced no deterministic
          // provider-outcome proof. Keep the recovery pending instead of clearing
          // it (success) or terminating it: the provider may still be broken, and
          // the scheduler's backoff/exhaustion lifecycle is the safe owner.
          if (isLocallyCompleteWithoutProof(result)) {
            return { status: 'wait', lastError: 'recovery_unproven_awaiting_provider_outcome' };
          }
          // Degraded daemon-lifecycle / endpoint-unavailable outcomes are non-terminal: keep the
          // recovery waiting so a healthy daemon/endpoint re-drives it. Never terminalize a transient
          // shutdown/outage as a non-retryable recovery result. S2: these go on the bounded
          // degraded-retry track so a long local outage does not burn the normal attempt budget.
          if (isDegradedLifecycleRecoveryResult(result)) {
            return buildDegradedRecoveryOutcome({
              intent,
              reason: resolveDegradedReason(result),
              nowMs: deps.nowMs(),
              maxDegradedAttempts: this.maxDegradedAttempts,
              degradedBackoffMs: this.degradedBackoffMs,
            });
          }
          if (isRuntimeAuthRecoveryTerminal(result)) {
            return {
              status: 'terminal',
              lastError: 'terminal_recovery_result',
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: 'terminal_recovery_result',
                },
                nowMs: deps.nowMs(),
                terminalReason: 'terminal_recovery_result',
              }),
            };
          }
          return { status: 'wait', lastError: 'retryable_recovery_result' };
        } catch (error) {
          const decision = classifyHandlerError(error);
          if (!decision.retryable) {
            return {
              status: 'terminal',
              lastError: decision.lastError,
              intent: buildTerminalRuntimeAuthIntent({
                intent: {
                  ...intent,
                  lastError: decision.lastError,
                  lastErrorClassification: decision.classification,
                },
                nowMs: deps.nowMs(),
                terminalReason: decision.lastError,
              }),
            };
          }
          // S2: a connection-level endpoint outage thrown during the recovery fetch
          // (ECONNREFUSED / socket hang up / reset = `network`) is a degraded local condition, not a
          // provider failure. Route it onto the bounded degraded-retry track so a long local outage
          // cannot dead-letter the session before the normal attempt budget. A `timeout` is left on
          // the normal track: a slow-but-reachable endpoint can be a genuine recoverable failure.
          if (decision.retryable && decision.classification.kind === 'network') {
            return buildDegradedRecoveryOutcome({
              intent: {
                ...intent,
                lastError: decision.lastError,
                lastErrorClassification: decision.classification,
              },
              reason: 'session_endpoint_unavailable',
              nowMs: deps.nowMs(),
              maxDegradedAttempts: this.maxDegradedAttempts,
              degradedBackoffMs: this.degradedBackoffMs,
            });
          }
          return {
            status: 'wait',
            lastError: decision.lastError,
            intent: {
              ...intent,
              lastError: decision.lastError,
              lastErrorClassification: decision.classification,
            },
          };
        }
      },
      onRetry: ({ intent }) => {
        this.record({
          event: 'runtime_auth_recovery_retry',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          attemptCount: intent.attemptCount,
          classification: intent.lastErrorClassification,
        });
      },
      onSuccess: ({ intent }) => {
        this.record({
          event: 'runtime_auth_recovery_success',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
        });
      },
      onTerminal: ({ intent, lastError }) => {
        this.record({
          event: 'runtime_auth_recovery_terminal',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason: lastError ?? 'terminal_recovery_result',
        });
      },
      onExhausted: ({ intent, lastError }) => {
        const uxDiagnostic = buildConnectedServiceUxDiagnostic({
          code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered,
          failurePhase: 'runtime_auth_recovery',
          source: 'runtime_auth_recovery',
          serviceId: intent.serviceId,
          profileId: intent.profileId,
          groupId: intent.groupId,
          retryable: true,
          diagnostics: {
            reason: lastError ?? 'max_attempts_exhausted',
            attemptCount: intent.attemptCount,
          },
        });
        const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
          status: 'dead_lettered',
          classification: intent.classification,
          uxDiagnostic,
          attempt: intent.attemptCount,
          terminal: true,
          reason: lastError ?? 'max_attempts_exhausted',
        });
        this.record({
          event: 'runtime_auth_recovery_dead_letter',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason: lastError ?? 'max_attempts_exhausted',
          attemptCount: intent.attemptCount,
          uxDiagnostic,
          ...(transcriptEvent ? { transcriptEvent } : {}),
        });
      },
      onDelayed: ({ intent, retryAtMs, reason }) => {
        this.record({
          event: 'runtime_auth_recovery_delayed',
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          groupId: intent.groupId,
          profileId: intent.profileId,
          failurePhase: intent.failurePhase,
          reason,
          nextRetryAtMs: retryAtMs,
          classification: intent.lastErrorClassification,
        });
      },
    });
  }

  read(sessionId: string): RuntimeAuthRecoveryIntent | null {
    const intents = this.readForSession(sessionId);
    return intents.find((intent) => intent.status === 'waiting' || intent.status === 'checking')
      ?? intents[0]
      ?? null;
  }

  readByKey(recoveryKey: string): RuntimeAuthRecoveryIntent | null {
    return this.scheduler.readByKey(recoveryKey);
  }

  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    return this.scheduler.readForSession(sessionId);
  }

  hydrate(): ReadonlyArray<RuntimeAuthRecoveryIntent> {
    return this.scheduler.hydrate();
  }

  /**
   * Daemon-shutdown lifecycle: stop firing recovery timers. Persisted `waiting`
   * intents stay on disk so a healthy future daemon re-hydrates and re-drives them.
   */
  dispose(): void {
    this.scheduler.dispose();
  }

  async wake(input: Readonly<{ sessionId: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    const intents = this.readForSession(input.sessionId).filter((intent) => (
      intent.status === 'waiting' || intent.status === 'checking'
    ));
    if (intents.length === 0) return { status: 'inactive' };
    if (intents.length === 1) {
      return await this.wakeByKey({
        recoveryKey: buildRecoveryKeyForIntent(intents[0]!),
        reason: input.reason,
      });
    }
    const results = [];
    for (const intent of intents) {
      results.push(await this.wakeByKey({
        recoveryKey: buildRecoveryKeyForIntent(intent),
        reason: input.reason,
      }));
    }
    if (results.some((result) => result.status === 'succeeded')) return { status: 'succeeded' };
    if (results.some((result) => result.status === 'waiting')) return { status: 'waiting' };
    if (results.some((result) => result.status === 'exhausted')) return { status: 'exhausted' };
    if (results.some((result) => result.status === 'terminal')) return { status: 'terminal' };
    return { status: 'inactive' };
  }

  async wakeByKey(input: Readonly<{ recoveryKey: string; reason: 'timer' | 'manual' }>): Promise<Readonly<{ status: string }>> {
    return await this.scheduler.wakeByKey({
      recoveryKey: input.recoveryKey,
      reason: input.reason,
    });
  }

  async cancel(input: Readonly<{ sessionId: string }>): Promise<RuntimeAuthRecoveryIntent | null> {
    const cancelled = await this.scheduler.cancelForSession(input.sessionId);
    return cancelled[0] ?? null;
  }

  async cancelByKey(recoveryKey: string): Promise<RuntimeAuthRecoveryIntent | null> {
    return await this.scheduler.cancelByKey(recoveryKey);
  }

  async markTerminalByKey(input: Readonly<{
    recoveryKey: string;
    terminalReason: string;
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    const intent = this.readByKey(input.recoveryKey);
    if (!intent) return null;
    if (intent.status === 'exhausted') return intent;
    if (intent.status === 'cancelled' && intent.terminalReason) return intent;
    const terminal = buildTerminalRuntimeAuthIntent({
      intent: {
        ...intent,
        lastError: input.terminalReason,
      },
      nowMs: this.deps.nowMs(),
      terminalReason: input.terminalReason,
    });
    await this.scheduler.upsertByKey({
      sessionId: terminal.sessionId,
      recoveryKey: input.recoveryKey,
      intent: terminal,
    });
    this.record({
      event: 'runtime_auth_recovery_terminal',
      sessionId: terminal.sessionId,
      serviceId: terminal.serviceId,
      groupId: terminal.groupId,
      profileId: terminal.profileId,
      failurePhase: terminal.failurePhase,
      reason: input.terminalReason,
      classification: terminal.lastErrorClassification,
    });
    return terminal;
  }

  async markSucceededByKey(recoveryKey: string): Promise<RuntimeAuthRecoveryIntent | null> {
    const intent = this.readByKey(recoveryKey);
    if (!intent || intent.status === 'cancelled' || intent.status === 'exhausted') return intent;
    const cleared = await this.scheduler.clearByKey(recoveryKey);
    if (!cleared) return null;
    this.record({
      event: 'runtime_auth_recovery_success',
      sessionId: cleared.sessionId,
      serviceId: cleared.serviceId,
      groupId: cleared.groupId,
      profileId: cleared.profileId,
      failurePhase: cleared.failurePhase,
    });
    return cleared;
  }

  async markProviderOutcomeProofByKey(input: Readonly<{
    recoveryKey: string;
    proofKind: ProviderOutcomeProofKind;
  }>): Promise<RuntimeAuthRecoveryIntent | null> {
    if (!isRecoveredProviderOutcomeProof(input.proofKind)) {
      return this.readByKey(input.recoveryKey);
    }
    return await this.markSucceededByKey(input.recoveryKey);
  }

  async beginClassifiedFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>): Promise<Readonly<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>> {
    return await this.enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      decision: buildClassifiedFailureIntakeDecision({
        classification: input.classification,
        nowMs: this.deps.nowMs(),
      }),
    });
  }

  async enqueueHandlerFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
  }>): Promise<Readonly<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>> {
    return await this.enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      decision: classifyHandlerError(input.error),
    });
  }

  async enqueueApplyFailure(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
  }>): Promise<Readonly<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>> {
    const decision = classifyApplyFailure(input.result);
    if (!decision) return { status: 'ignored', retryable: false };
    return await this.enqueue({
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      decision,
    });
  }

  private async enqueue(input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    decision: RetryDecision;
  }>): Promise<Readonly<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>> {
    if (!input.decision.retryable) {
      this.record({
        event: 'runtime_auth_recovery_terminal',
        sessionId: input.sessionId,
        serviceId: input.classification.serviceId,
        groupId: input.classification.groupId,
        profileId: input.classification.profileId,
        failurePhase: input.decision.failurePhase,
        reason: input.decision.reason,
        classification: input.decision.classification,
      });
      return { status: 'terminal_non_retry', retryable: false };
    }

    const nowMs = this.deps.nowMs();
    const retryAfterMs = input.decision.classification.retryAfterMs;
    const nextRetryAtMs = nowMs + (
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? Math.max(0, Math.trunc(retryAfterMs))
        : Math.max(1, Math.trunc(this.deps.baseBackoffMs ?? 1_000))
    );
    const intent: RuntimeAuthRecoveryIntent = {
      v: 1,
      sessionId: input.sessionId,
      serviceId: input.classification.serviceId,
      profileId: input.classification.profileId,
      groupId: input.classification.groupId,
      status: 'waiting',
      armedAtMs: nowMs,
      nextRetryAtMs,
      attemptCount: 0,
      maxAttempts: this.maxAttempts,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      failurePhase: input.decision.failurePhase,
      failureReason: input.decision.failureReason,
      lastError: input.decision.lastError,
      lastErrorClassification: input.decision.classification,
      terminalAtMs: null,
      terminalReason: null,
    };
    const recoveryKey = buildRecoveryKeyForIntent(intent);
    const persistedIntent = await this.scheduler.upsertMergedByKey({
      sessionId: input.sessionId,
      recoveryKey,
      intent,
      merge: mergeRuntimeAuthRecoveryIntent,
    });
    if (persistedIntent.status === 'exhausted') {
      return {
        status: 'exhausted',
        retryable: false,
      };
    }
    if (persistedIntent.status === 'cancelled') {
      return {
        status: 'cancelled',
        retryable: false,
      };
    }
    const uxDiagnostic = buildRuntimeAuthRecoveryScheduledUxDiagnostic({
      classification: persistedIntent.classification,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      reason: persistedIntent.failureReason,
    });
    const transcriptEvent = buildRuntimeAuthRecoveryTranscriptEvent({
      status: 'retry_scheduled',
      classification: persistedIntent.classification,
      uxDiagnostic,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      terminal: false,
      reason: persistedIntent.failureReason,
    });
    this.record({
      event: 'runtime_auth_recovery_enqueue',
      sessionId: persistedIntent.sessionId,
      serviceId: persistedIntent.serviceId,
      groupId: persistedIntent.groupId,
      profileId: persistedIntent.profileId,
      failurePhase: persistedIntent.failurePhase,
      reason: persistedIntent.failureReason,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
      classification: persistedIntent.lastErrorClassification,
      uxDiagnostic,
      ...(transcriptEvent ? { transcriptEvent } : {}),
    });
    return {
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: persistedIntent.nextRetryAtMs,
    };
  }

  private record(event: RuntimeAuthRecoveryDiagnostic): void {
    this.deps.recordDiagnostic?.(event);
  }
}
