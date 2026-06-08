import {
  createLocalTurnLifecycleController,
  type LocalTurnLifecycleController,
  type LocalTurnLifecycleEvent,
  type LocalTurnTerminalReason,
} from '@/agent/localControl/turnLifecycle';
import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';

import { createClaudeLocalLifecycleTracker } from '../localControl/claudeLocalLifecycleTracker';
import { isClaudeRuntimeAuthFailureEvidence } from '../connectedServices/classifyClaudeConnectedServiceRuntimeAuthFailure';
import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeStopFailureHookToUsageDetails,
  type NormalizedProviderUsageLimitDetailsV1,
} from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import type { RawJSONLines } from '../types';
import type { SessionHookData } from '../utils/startHookServer';
import type { ClaudeUnifiedInputArbiter, ClaudeUnifiedStartableDisposable } from './_types';
import { logger } from '@/ui/logger';

export type ClaudeUnifiedSessionHookSubscription = (
  callback: (data: SessionHookData) => void,
) => (() => void) | null | undefined;

export type ClaudeUnifiedHookLifecycleBridge = ClaudeUnifiedStartableDisposable & Readonly<{
  observeTranscript(message: RawJSONLines): void;
}>;

export type ClaudeUnifiedPromptTurnTerminalEvent = Readonly<{
  reason: LocalTurnTerminalReason;
  source: string;
  detail?: string | undefined;
}>;

export type ClaudeUnifiedSessionEndEvent = Readonly<{
  reason: string | null;
  source: string;
}>;

function disposeSubscription(dispose: (() => void) | null): void {
  if (!dispose) return;
  dispose();
}

function readHookEventName(data: SessionHookData): string {
  const raw = data.hook_event_name ?? data.hookEventName;
  return typeof raw === 'string' ? raw : '';
}

function readHookString(data: SessionHookData, key: string): string {
  const raw = data[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function readSystemSubtype(message: RawJSONLines): string {
  if (message.type !== 'system') return '';
  const raw = (message as Record<string, unknown>).subtype;
  return typeof raw === 'string' ? raw : '';
}

export function createClaudeUnifiedHookLifecycleBridge(opts: Readonly<{
  subscribeClaudeSessionHooks: ClaudeUnifiedSessionHookSubscription;
  arbiter: Pick<ClaudeUnifiedInputArbiter, 'observeLifecycle' | 'confirmPromptAcceptedByProvider' | 'drainWhenSafe'>;
  completionQuiescenceMs: number;
  onThinkingChange?: ((thinking: boolean) => void) | undefined;
  onReady?: (() => void | Promise<void>) | undefined;
  onUsageLimitDetails?: ((details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>) | undefined;
  onRuntimeAuthFailureEvent?: ((error: unknown) => void | Promise<void>) | undefined;
  onProviderPromptStarted?: (() => void | Promise<void>) | undefined;
  onPromptTurnTerminal?: ((event: ClaudeUnifiedPromptTurnTerminalEvent) => void | Promise<void>) | undefined;
  onSessionEnd?: ((event: ClaudeUnifiedSessionEndEvent) => void | Promise<void>) | undefined;
}>): ClaudeUnifiedHookLifecycleBridge {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let lifecycle: LocalTurnLifecycleController | null = null;
  let tracker: ReturnType<typeof createClaudeLocalLifecycleTracker> | null = null;
  let quietDrainTimer: NodeJS.Timeout | null = null;
  let terminalSideEffects: Promise<void> = Promise.resolve();

  const clearQuietDrainTimer = (): void => {
    if (!quietDrainTimer) return;
    clearTimeout(quietDrainTimer);
    quietDrainTimer = null;
  };

  const drainWhenSafe = (): void => {
    void opts.arbiter.drainWhenSafe().catch(() => undefined);
  };

  const chainTerminalSideEffect = (
    label: string,
    effect: (() => void | Promise<void>) | undefined,
  ): void => {
    if (!effect) return;
    terminalSideEffects = terminalSideEffects
      .catch(() => undefined)
      .then(async () => {
        try {
          await effect();
        } catch (error) {
          logger.debug(`[unified]: failed to run Claude unified terminal ${label} side effect`, error);
        }
      });
  };

  const chainTerminalSideEffectResult = (
    label: string,
    result: void | Promise<void>,
  ): void => {
    terminalSideEffects = terminalSideEffects
      .catch(() => undefined)
      .then(async () => {
        try {
          await result;
        } catch (error) {
          logger.debug(`[unified]: failed to run Claude unified terminal ${label} side effect`, error);
        }
      });
  };

  const waitForTerminalSideEffects = async (): Promise<void> => {
    await terminalSideEffects.catch(() => undefined);
  };

  const observeStartupReady = (): void => {
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  const observeCompactionStarted = (): void => {
    clearQuietDrainTimer();
    opts.arbiter.observeLifecycle({ type: 'compaction', phase: 'started' });
  };

  const observeCompactionCompleted = (): void => {
    opts.arbiter.observeLifecycle({ type: 'compaction', phase: 'completed' });
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  const observePermissionBlocked = (): void => {
    opts.arbiter.observeLifecycle({ type: 'permission', blocked: true });
  };

  const observePermissionReleased = (optsOverride?: Readonly<{ redrain?: boolean }>): void => {
    opts.arbiter.observeLifecycle({ type: 'permission', blocked: false });
    if (optsOverride?.redrain === false) return;
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  const observeStopFailureRuntimeIssue = (data: SessionHookData): void => {
    const details = mapClaudeStopFailureHookToUsageDetails(data);
    if (!details) return;
    chainTerminalSideEffect('usage-limit', () => opts.onUsageLimitDetails?.(details));
  };

  const observeProviderPromptStarted = (): void => {
    if (!opts.onProviderPromptStarted) return;
    try {
      chainTerminalSideEffectResult('provider-prompt-start', opts.onProviderPromptStarted());
    } catch (error) {
      logger.debug('[unified]: failed to run Claude unified terminal provider-prompt-start side effect', error);
    }
  };

  const observeSessionEnd = (data: SessionHookData): void => {
    if (!opts.onSessionEnd) return;
    const reason = readHookString(data, 'reason');
    try {
      void Promise.resolve(opts.onSessionEnd({
        reason: reason || null,
        source: 'claude_hook',
      })).catch((error) => {
        logger.debug('[unified]: failed to run Claude unified terminal session-end side effect', error);
      });
    } catch (error) {
      logger.debug('[unified]: failed to run Claude unified terminal session-end side effect', error);
    }
  };

  const settleTerminalSnapshot = async (
    snapshot: Readonly<{
      terminal: boolean;
      lastTerminalReason: LocalTurnTerminalReason | null;
    }>,
    event: LocalTurnLifecycleEvent,
  ): Promise<void> => {
    if (disposed || !snapshot.terminal) return;
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'finalizing' });
    opts.onThinkingChange?.(false);
    if (snapshot.lastTerminalReason === 'completed') {
      chainTerminalSideEffect('ready', opts.onReady);
    } else {
      chainTerminalSideEffect('prompt-turn-terminal', () => opts.onPromptTurnTerminal?.({
        reason: snapshot.lastTerminalReason ?? 'unknown',
        source: event.source,
        ...(event.type === 'turn_terminal' && event.detail ? { detail: event.detail } : {}),
      }));
    }
    await waitForTerminalSideEffects();
    if (disposed) return;
    opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    opts.arbiter.observeLifecycle({ type: 'output' });
    drainWhenSafe();
    clearQuietDrainTimer();
    quietDrainTimer = setTimeout(drainWhenSafe, TERMINAL_INPUT_QUIET_PERIOD_MS);
    quietDrainTimer.unref?.();
  };

  return {
    start() {
      if (disposed || unsubscribe) return;
      lifecycle = createLocalTurnLifecycleController({
        completionQuiescenceMs: opts.completionQuiescenceMs,
        onStateChange: (snapshot, event) => {
          if (snapshot.active && !snapshot.terminal) {
            opts.arbiter.observeLifecycle({ type: 'turn_state', state: 'running' });
            opts.onThinkingChange?.(true);
            return;
          }
          if (!snapshot.terminal) return;
          void settleTerminalSnapshot(snapshot, event);
        },
      });
      tracker = createClaudeLocalLifecycleTracker({ lifecycle });
      unsubscribe = opts.subscribeClaudeSessionHooks((data) => {
        const hookEventName = readHookEventName(data);
        if (hookEventName === 'SessionStart') {
          observeStartupReady();
        } else if (hookEventName === 'PreCompact') {
          observeCompactionStarted();
        } else if (hookEventName === 'PostCompact') {
          observeCompactionCompleted();
        } else if (hookEventName === 'UserPromptSubmit') {
          observeProviderPromptStarted();
          void opts.arbiter.confirmPromptAcceptedByProvider().catch(() => undefined);
        } else if (hookEventName === 'PermissionRequest') {
          observePermissionBlocked();
        } else if (
          hookEventName === 'PostToolUse'
          || hookEventName === 'PermissionRequestCompleted'
        ) {
          observePermissionReleased();
        } else if (
          hookEventName === 'Stop'
          || hookEventName === 'StopFailure'
          || hookEventName === 'SessionEnd'
        ) {
          observePermissionReleased({ redrain: false });
        }
        if (hookEventName === 'SessionEnd') {
          observeSessionEnd(data);
        }
        if (hookEventName === 'StopFailure') {
          observeStopFailureRuntimeIssue(data);
        }
        tracker?.observeHook(data);
      }) ?? null;
    },
    observeTranscript(message) {
      if (readSystemSubtype(message) === 'compact_boundary') {
        observeCompactionCompleted();
      }
      if (isClaudeRuntimeAuthFailureEvidence(message)) {
        chainTerminalSideEffect('runtime-auth', () => opts.onRuntimeAuthFailureEvent?.(message));
      }
      const usageLimitDetails = mapClaudeRateLimitEventToUsageDetails(message);
      if (usageLimitDetails) {
        chainTerminalSideEffect('usage-limit', () => opts.onUsageLimitDetails?.(usageLimitDetails));
      }
      tracker?.observeTranscript(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearQuietDrainTimer();
      disposeSubscription(unsubscribe);
      unsubscribe = null;
      tracker = null;
      lifecycle?.dispose();
      lifecycle = null;
    },
  };
}
