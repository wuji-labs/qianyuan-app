import { resolveTerminalInjectionReadiness } from '@/agent/runtime/terminal/injection/arbiter';
import type { TerminalInputInjectionResult, TerminalLifecycleObservation, TerminalTurnState } from '@/agent/runtime/terminal/_types';

import type {
  ClaudeUnifiedInputArbiter,
  ClaudeUnifiedInputArbiterSnapshot,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedPromptAcceptedHandler,
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedPromptInjectedHandler,
  ClaudeUnifiedPromptInjectionFailure,
  ClaudeUnifiedPromptInjectionFailureHandler,
  ClaudeUnifiedPromptInjector,
} from './_types';
import { classifyClaudeUnifiedInjectionFailure } from './injectionFailurePolicy';

type HeadInputState = ClaudeUnifiedInputArbiterSnapshot['headInputState'];

const DEFAULT_INJECTION_RETRY_LIMIT = 3;
const DEFAULT_INJECTION_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 5_000;

export function createClaudeUnifiedInputArbiter<Mode = unknown>(opts: Readonly<{
  injectPrompt: ClaudeUnifiedPromptInjector<Mode>['injectPrompt'];
  onPromptInjected?: ClaudeUnifiedPromptInjectedHandler<Mode> | undefined;
  onPromptAccepted?: ClaudeUnifiedPromptAcceptedHandler<Mode> | undefined;
  nowMs?: (() => number) | undefined;
  quietPeriodMs?: number | undefined;
  maxWaitMs?: number | undefined;
  injectionRetryLimit?: number | undefined;
  injectionRetryBaseDelayMs?: number | undefined;
  providerAcceptanceTimeoutMs?: number | undefined;
  onInjectionFailure?: ClaudeUnifiedPromptInjectionFailureHandler<Mode> | undefined;
}>): ClaudeUnifiedInputArbiter<Mode> {
  const queue: Array<ClaudeUnifiedPromptBatch<Mode>> = [];
  const nowMs = opts.nowMs ?? Date.now;
  const injectionRetryLimit = Math.max(0, Math.trunc(opts.injectionRetryLimit ?? DEFAULT_INJECTION_RETRY_LIMIT));
  const injectionRetryBaseDelayMs = Math.max(0, Math.trunc(opts.injectionRetryBaseDelayMs ?? DEFAULT_INJECTION_RETRY_BASE_DELAY_MS));
  const providerAcceptanceTimeoutMs = Math.max(0, Math.trunc(opts.providerAcceptanceTimeoutMs ?? DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS));

  let disposed = false;
  let turnState: TerminalTurnState = 'idle';
  let permissionBlocked = false;
  let userTyping = false;
  let userTypingObservedAtMs: number | null = null;
  let firstObservedAtMs = nowMs();
  let outputObserved = false;
  let lastOutputAtMs: number | null = null;
  let compactionActive = false;
  let lastDeferredReason: string | null = null;
  let lastFailureReason: string | null = null;
  let headInputState: HeadInputState = null;
  let draining: Promise<void> | null = null;
  let retryDrainTimer: ReturnType<typeof setTimeout> | null = null;
  let providerAcceptanceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let pendingProviderAcceptance: Readonly<{
    batch: ClaudeUnifiedPromptBatch<Mode>;
    acceptance: ClaudeUnifiedPromptAcceptance;
  }> | null = null;
  let pendingAcceptanceCompletedCompaction = false;
  let ambiguousProviderAcceptanceFailure: Readonly<{
    batch: ClaudeUnifiedPromptBatch<Mode>;
    acceptance: ClaudeUnifiedPromptAcceptance;
  }> | null = null;

  const snapshot = (): ClaudeUnifiedInputArbiterSnapshot => ({
    queuedCount: queue.length,
    disposed,
    turnState,
    permissionBlocked,
    userTyping,
    lastDeferredReason,
    lastFailureReason,
    headInputState,
  });

  const observeLifecycle = (observation: TerminalLifecycleObservation): void => {
    const observedAtMs = observation.observedAtMs ?? nowMs();
    if (observation.type === 'turn_state') {
      turnState = observation.state;
      if (observation.state === 'running') {
        outputObserved = true;
        lastOutputAtMs = observedAtMs;
      }
      if (observation.state === 'blocked_on_permission') {
        permissionBlocked = true;
      } else if (observation.state === 'idle') {
        permissionBlocked = false;
      }
      return;
    }
    if (observation.type === 'permission') {
      permissionBlocked = observation.blocked;
      return;
    }
    if (observation.type === 'compaction') {
      compactionActive = observation.phase === 'started';
      if (pendingProviderAcceptance) {
        clearProviderAcceptanceTimer();
        pendingAcceptanceCompletedCompaction = observation.phase === 'completed';
      } else if (
        observation.phase === 'completed'
        && ambiguousProviderAcceptanceFailure
        && queue[0] === ambiguousProviderAcceptanceFailure.batch
      ) {
        pendingProviderAcceptance = ambiguousProviderAcceptanceFailure;
        pendingAcceptanceCompletedCompaction = true;
        ambiguousProviderAcceptanceFailure = null;
        lastFailureReason = null;
        headInputState = 'awaiting_provider_acceptance';
      }
      if (observation.phase === 'started') {
        lastDeferredReason = 'compaction';
      }
      return;
    }
    outputObserved = true;
    lastOutputAtMs = observedAtMs;
  };

  const observeUserTypingState = (state: Readonly<{ userTyping: boolean; observedAtMs?: number | undefined }>): void => {
    userTyping = state.userTyping;
    userTypingObservedAtMs = state.userTyping ? state.observedAtMs ?? nowMs() : null;
  };

  function clearRetryDrainTimer(): void {
    if (!retryDrainTimer) return;
    clearTimeout(retryDrainTimer);
    retryDrainTimer = null;
  }

  function clearProviderAcceptanceTimer(): void {
    if (!providerAcceptanceTimer) return;
    clearTimeout(providerAcceptanceTimer);
    providerAcceptanceTimer = null;
  }

  function scheduleRetryDrain(retryAfterMs: number | undefined): void {
    if (retryAfterMs === undefined || retryAfterMs < 0) return;
    clearRetryDrainTimer();
    retryDrainTimer = setTimeout(() => {
      retryDrainTimer = null;
      void drainWhenSafe().catch(() => undefined);
    }, retryAfterMs);
    retryDrainTimer.unref?.();
  }

  function notifyInjectionFailure(failure: ClaudeUnifiedPromptInjectionFailure<Mode>): void {
    opts.onInjectionFailure?.(failure);
  }

  function buildProviderAcceptanceTimeoutResult(): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
    return {
      status: 'failed',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
    };
  }

  function scheduleProviderAcceptanceTimeout(
    timeoutMs: number,
    result: Extract<TerminalInputInjectionResult, { status: 'failed' }>,
  ): void {
    clearProviderAcceptanceTimer();
    providerAcceptanceTimer = setTimeout(() => {
      providerAcceptanceTimer = null;
      if (pendingProviderAcceptance && compactionActive) {
        return;
      }
      if (pendingProviderAcceptance) {
        const timedOutAcceptance = pendingProviderAcceptance;
        pendingProviderAcceptance = null;
        ambiguousProviderAcceptanceFailure = timedOutAcceptance;
        pendingAcceptanceCompletedCompaction = false;
        lastFailureReason = result.reason;
        headInputState = 'failed_ambiguous';
        notifyInjectionFailure({
          batch: timedOutAcceptance.batch,
          result,
          failureState: 'failed_ambiguous',
        });
      }
    }, timeoutMs);
    providerAcceptanceTimer.unref?.();
  }

  function resolvePromptAcceptance(state: TerminalTurnState): ClaudeUnifiedPromptAcceptance {
    return {
      acceptedAs: state === 'running' ? 'in_flight_steer' : 'new_turn',
      turnStateAtInjection: state,
    };
  }

  async function acceptBatch(
    batch: ClaudeUnifiedPromptBatch<Mode>,
    acceptance: ClaudeUnifiedPromptAcceptance,
  ): Promise<void> {
    lastDeferredReason = null;
    lastFailureReason = null;
    headInputState = 'submitted';
    retryAttempt = 0;
    firstObservedAtMs = nowMs();
    outputObserved = false;
    lastOutputAtMs = null;
    turnState = 'unknown';
    pendingProviderAcceptance = null;
    pendingAcceptanceCompletedCompaction = false;
    ambiguousProviderAcceptanceFailure = null;
    clearProviderAcceptanceTimer();
    await opts.onPromptAccepted?.(batch, acceptance);
  }

  async function confirmPromptAcceptedByProviderMatching(
    matcher: (batch: ClaudeUnifiedPromptBatch<Mode>) => boolean,
    optsOverride?: Readonly<{ includeAmbiguousTimeout?: boolean }> | undefined,
  ): Promise<boolean> {
    const pendingAcceptance = pendingProviderAcceptance
      ?? (optsOverride?.includeAmbiguousTimeout ? ambiguousProviderAcceptanceFailure : null);
    if (!pendingAcceptance) return false;
    const next = queue[0];
    if (next !== pendingAcceptance.batch) return false;
    if (!matcher(next)) return false;
    queue.shift();
    await acceptBatch(next, pendingAcceptance.acceptance);
    return true;
  }

  async function confirmPromptAcceptedByProvider(): Promise<boolean> {
    return confirmPromptAcceptedByProviderMatching(() => true);
  }

  const runDrain = async (): Promise<void> => {
    clearRetryDrainTimer();
    while (!disposed && queue.length > 0) {
      if (pendingProviderAcceptance) {
        if (compactionActive || !pendingAcceptanceCompletedCompaction) {
          headInputState = 'awaiting_provider_acceptance';
          return;
        }
        pendingProviderAcceptance = null;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
      }
      if (compactionActive) {
        lastDeferredReason = 'compaction';
        headInputState = 'waiting_for_readiness';
        return;
      }
      if (headInputState === 'failed_ambiguous' || headInputState === 'failed_terminal') {
        return;
      }
      const readiness = resolveTerminalInjectionReadiness({
        nowMs: nowMs(),
        firstObservedAtMs,
        outputObserved,
        lastOutputAtMs,
        permissionBlocked,
        turnState,
        userTyping,
        userTypingObservedAtMs,
      }, {
        quietPeriodMs: opts.quietPeriodMs,
        maxWaitMs: opts.maxWaitMs,
      });
      if (!readiness.ready) {
        lastDeferredReason = readiness.reason;
        headInputState = 'waiting_for_readiness';
        scheduleRetryDrain(readiness.retryAfterMs);
        return;
      }

      const next = queue[0];
      if (next.origin.kind === 'ui_pending' && turnState === 'running') {
        lastDeferredReason = 'terminal_busy';
        headInputState = 'waiting_for_readiness';
        return;
      }
      const acceptance = resolvePromptAcceptance(turnState);
      headInputState = 'injecting';
      const result: TerminalInputInjectionResult = await opts.injectPrompt(next);
      if (result.status === 'injected') {
        lastDeferredReason = null;
        lastFailureReason = null;
        pendingProviderAcceptance = { batch: next, acceptance };
        pendingAcceptanceCompletedCompaction = false;
        headInputState = 'awaiting_provider_acceptance';
        await opts.onPromptInjected?.(next, acceptance, result);
        scheduleProviderAcceptanceTimeout(providerAcceptanceTimeoutMs, buildProviderAcceptanceTimeoutResult());
        return;
      }
      if (result.status === 'deferred') {
        lastDeferredReason = result.reason;
        pendingProviderAcceptance = null;
        ambiguousProviderAcceptanceFailure = null;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
        headInputState = 'waiting_for_readiness';
        scheduleRetryDrain(result.retryAfterMs);
        return;
      }
      lastFailureReason = result.reason;
      const failureAction = classifyClaudeUnifiedInjectionFailure(result, {
        retryAttempt,
        retryLimit: injectionRetryLimit,
        retryBaseDelayMs: injectionRetryBaseDelayMs,
        providerAcceptanceTimeoutMs,
      });
      if (failureAction.kind === 'retry') {
        pendingProviderAcceptance = null;
        ambiguousProviderAcceptanceFailure = null;
        pendingAcceptanceCompletedCompaction = false;
        clearProviderAcceptanceTimer();
        retryAttempt += 1;
        headInputState = 'failed_retryable';
        scheduleRetryDrain(failureAction.retryAfterMs);
        return;
      }
      if (failureAction.kind === 'await_provider_confirmation') {
        pendingProviderAcceptance = { batch: next, acceptance };
        pendingAcceptanceCompletedCompaction = false;
        headInputState = 'awaiting_provider_acceptance';
        scheduleProviderAcceptanceTimeout(failureAction.timeoutMs, result);
        return;
      }
      pendingProviderAcceptance = null;
      ambiguousProviderAcceptanceFailure = null;
      pendingAcceptanceCompletedCompaction = false;
      clearProviderAcceptanceTimer();
      headInputState = 'failed_terminal';
      notifyInjectionFailure({
        batch: next,
        result,
        failureState: 'failed_terminal',
      });
      return;
    }
  };

  async function drainWhenSafe(): Promise<void> {
    if (!draining) {
      draining = runDrain().finally(() => {
        draining = null;
      });
    }
    await draining;
  }

  return {
    async enqueueUiMessage(batch) {
      if (disposed) return;
      queue.push(batch);
    },
    observeLifecycle,
    observeUserTypingState,
    confirmPromptAcceptedByProvider,
    confirmPromptAcceptedByProviderIf(matcher) {
      return confirmPromptAcceptedByProviderMatching(matcher, { includeAmbiguousTimeout: true });
    },
    drainWhenSafe,
    snapshot,
    dispose() {
      disposed = true;
      clearRetryDrainTimer();
      clearProviderAcceptanceTimer();
      queue.length = 0;
      pendingProviderAcceptance = null;
      pendingAcceptanceCompletedCompaction = false;
      ambiguousProviderAcceptanceFailure = null;
      headInputState = null;
    },
  };
}
