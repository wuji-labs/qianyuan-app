import type { ConnectedServiceTurnLifecycleEvent } from '../sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import {
  clearRuntimeAuthFailureReportOutboxForSupersession,
  type RuntimeAuthFailureReportOutboxSupersessionEvent,
} from '../runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxSupersession';
import { createSessionContinuationRecoveryController } from './sessionContinuationRecovery';

/**
 * Session-metadata persistence boundary for the continuation recovery state
 * (matches the controller's store contract in sessionContinuationRecovery).
 */
type ContinuationRecoveryStore = Readonly<{
  read: (sessionId: string) => Promise<unknown | null> | unknown | null;
  write: (sessionId: string, state: unknown) => Promise<void> | void;
}>;

/**
 * A turn reached a terminal user-visible state: the session moved past any
 * interruption, whether the user cancelled the turn or the assistant finished
 * it normally. Both outcomes mean a still-pending continuation attempt is
 * stale — without this, attempts persisted during a mid-turn switch/restart
 * survive normal completion and fire an involuntary "continue" prompt on the
 * next spawn/reattach.
 *
 * REV-1: `assistant_message_end` is ALSO emitted by failTurn / ACP turn_failed
 * markers. A FAILED turn (e.g. a usage-limit interruption) is exactly the state
 * continuation recovery exists to resume, so it must not supersede pending
 * attempts; only a genuinely completed turn does. A missing terminal status
 * (legacy producers) keeps the completed-turn behavior.
 */
export function isTerminalUserVisibleTurnLifecycleEvent(
  event: ConnectedServiceTurnLifecycleEvent,
  terminalStatus?: 'completed' | 'failed',
): boolean {
  if (event === 'turn_cancelled') return true;
  return event === 'assistant_message_end' && terminalStatus !== 'failed';
}

export function shouldSuppressContinuationRecoveryForSupersession(
  event: RuntimeAuthFailureReportOutboxSupersessionEvent,
): boolean {
  if (event.kind === 'manual_session_supersession') return true;
  return isTerminalUserVisibleTurnLifecycleEvent(event.event, event.terminalStatus);
}

export function createConnectedServiceRecoverySupersessionCleaner(params: Readonly<{
  providerActivityTimeoutMs: number;
  store: ContinuationRecoveryStore;
  removeReportOutboxItemsForSession: (sessionId: string) => Promise<void> | void;
  nowMs?: () => number;
  logDebug?: (message: string, error: unknown) => void;
}>) {
  const controller = createSessionContinuationRecoveryController({
    nowMs: params.nowMs ?? (() => Date.now()),
    providerActivityTimeoutMs: params.providerActivityTimeoutMs,
    store: params.store,
  });
  return async (input: Readonly<{
    sessionId: string;
    event: RuntimeAuthFailureReportOutboxSupersessionEvent;
  }>): Promise<void> => {
    await clearRuntimeAuthFailureReportOutboxForSupersession({
      sessionId: input.sessionId,
      event: input.event,
      removeForSession: async (sessionId) => {
        await params.removeReportOutboxItemsForSession(sessionId);
      },
    }).catch((error) => {
      params.logDebug?.('[DAEMON RUN] Failed to clear connected-service runtime-auth report outbox after supersession (non-fatal)', error);
    });
    if (!shouldSuppressContinuationRecoveryForSupersession(input.event)) return;
    await controller.suppressPendingAttempts({ sessionId: input.sessionId }).catch((error) => {
      params.logDebug?.('[DAEMON RUN] Failed to suppress connected-service continuation recovery after supersession (non-fatal)', error);
    });
  };
}
