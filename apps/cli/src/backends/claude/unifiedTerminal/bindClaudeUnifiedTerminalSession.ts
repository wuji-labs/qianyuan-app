import type { ReadyNotificationTurnContext } from '@/agent/runtime/runPermissionModePromptLoop';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { logger } from '@/ui/logger';

import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import type { ClaudeUnifiedTerminalSessionOptions } from './runClaudeUnifiedTerminalSession';
import {
  createClaudeUnifiedPromptEchoSuppressor,
  type ClaudeUnifiedPromptEchoSuppressor,
} from './promptEchoSuppression';
import { seedClaudeUnifiedPersistedPromptEchoes } from './promptEchoSeed';
import { createClaudeOwnComposerTextLog, type ClaudeOwnComposerTextLog } from './ownComposerTextLog';

type ClaudeUnifiedSessionBindingClient = Pick<
  SessionClientPort,
  | 'beginTurnAssistantTextSnapshot'
  | 'fetchRecentTranscriptTextItemsForAcpImport'
  | 'getLastObservedMessageSeq'
  | 'recordClaudeJsonlMessageConsumed'
> & Readonly<{
  sessionTurnLifecycle?: Pick<
    NonNullable<SessionClientPort['sessionTurnLifecycle']>,
    'beginTurn' | 'cancelTurn' | 'completeTurn' | 'failTurn'
  > | undefined;
}>;

type ClaudeUnifiedTerminalSessionBindingOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  session: ClaudeUnifiedSessionBindingClient;
  logPrefix: string;
  acceptedPromptEchoWindowMs: number;
  nowMs?: (() => number) | undefined;
  onMessage: (message: RawJSONLines) => void;
  onReady: (context?: ReadyNotificationTurnContext) => void | Promise<void>;
  onTurnInterruptChanged?: ((handler: (() => Promise<void>) | null) => void) | undefined;
  onPromptTurnStarted?: (() => void | Promise<void>) | undefined;
  suppressor?: ClaudeUnifiedPromptEchoSuppressor | undefined;
}>;

export type ClaudeUnifiedTerminalSessionBinding<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  sessionOptions: Pick<
    ClaudeUnifiedTerminalSessionOptions<Mode>,
    | 'allowFirstInputBeforeSessionStart'
    | 'onMessage'
    | 'onProviderPromptStarted'
    | 'onReady'
    | 'onTerminalPromptInjected'
    | 'setTurnInterrupt'
  >;
  seedPersistedPromptEchoes(opts?: Readonly<{ nowMs?: number | undefined }>): Promise<void>;
  /**
   * C11 (incident cmq8y3nlx): binding-owned own-injected-text registry, seeded from the persisted
   * prompt store by `seedPersistedPromptEchoes` and handed to the unified terminal run so a
   * respawned runner recognizes (and may clear) its predecessor's leftover composer injection.
   */
  ownComposerTexts: ClaudeOwnComposerTextLog;
  noteNextInjectedPromptShouldSuppressEcho(): void;
  noteNextInjectedPromptShouldImportEcho(): void;
  shouldSuppressTranscriptMessage(message: RawJSONLines): boolean;
  beginReadyNotificationTurn(): void;
  recordPromptTurnStarted(): Promise<void>;
  recordPromptTurnCompleted(): Promise<void>;
  recordPromptTurnCancelled(): Promise<void>;
  recordPromptTurnFailed(): Promise<void>;
  notePromptTurnTerminal(): void;
}>;

export function bindClaudeUnifiedTerminalSession<Mode extends EnhancedMode = EnhancedMode>(
  opts: ClaudeUnifiedTerminalSessionBindingOptions<Mode>,
): ClaudeUnifiedTerminalSessionBinding<Mode> {
  const promptEchoSuppressor = opts.suppressor ?? createClaudeUnifiedPromptEchoSuppressor({
    acceptedPromptEchoWindowMs: opts.acceptedPromptEchoWindowMs,
    nowMs: opts.nowMs,
  });
  const nowMs = opts.nowMs ?? Date.now;
  const ownComposerTexts = createClaudeOwnComposerTextLog();
  const acceptedPromptEchoSuppressionDecisions: boolean[] = [];
  // A steered prompt's JSONL user echo only appears when Claude submits the queued prompt at TURN
  // END, which for long autonomous turns is far beyond the fixed accepted-prompt echo window. Track
  // steered echoes separately: unexpired until the steered turn completes (onReady), then bounded by
  // one echo window so a stale entry can never suppress a later identical terminal-typed prompt.
  const pendingSteerEchoes: Array<{ text: string; expiresAtMs: number | null }> = [];
  let readyTurnContext: ReadyNotificationTurnContext | undefined;
  let canonicalTurnOpen = false;
  let canonicalTurnStartPromise: Promise<void> | null = null;

  function armPendingSteerEchoExpiry(): void {
    const expiresAtMs = nowMs() + opts.acceptedPromptEchoWindowMs;
    for (const echo of pendingSteerEchoes) {
      if (echo.expiresAtMs === null) {
        echo.expiresAtMs = expiresAtMs;
      }
    }
  }

  function consumePendingSteerEcho(message: RawJSONLines): boolean {
    if (pendingSteerEchoes.length === 0 || message.type !== 'user') return false;
    const content = message.message?.content;
    if (typeof content !== 'string') return false;
    const referenceMs = nowMs();
    while (pendingSteerEchoes.length > 0) {
      const head = pendingSteerEchoes[0];
      if (!head || head.expiresAtMs === null || head.expiresAtMs >= referenceMs) break;
      pendingSteerEchoes.shift();
    }
    const head = pendingSteerEchoes[0];
    if (!head || head.text !== content) return false;
    pendingSteerEchoes.shift();
    return true;
  }

  function beginReadyNotificationTurn(): void {
    if (typeof opts.session.beginTurnAssistantTextSnapshot !== 'function') return;
    const startSeqExclusive = typeof opts.session.getLastObservedMessageSeq === 'function'
      ? opts.session.getLastObservedMessageSeq()
      : null;
    const turnToken = opts.session.beginTurnAssistantTextSnapshot({ startSeqExclusive });
    readyTurnContext = { turnToken, startSeqExclusive };
  }

  async function recordPromptTurnStarted(): Promise<void> {
    if (canonicalTurnOpen) {
      await canonicalTurnStartPromise;
      return;
    }
    canonicalTurnOpen = true;
    const lifecycle = opts.session.sessionTurnLifecycle;
    if (!lifecycle?.beginTurn) return;
    const startPromise = Promise.resolve(lifecycle.beginTurn({ provider: 'claude' }))
      .then(() => undefined)
      .catch((error) => {
        canonicalTurnOpen = false;
        logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn start (non-fatal)`, error);
      })
      .finally(() => {
        if (canonicalTurnStartPromise === startPromise) {
          canonicalTurnStartPromise = null;
        }
      });
    canonicalTurnStartPromise = startPromise;
    await startPromise;
  }

  async function recordPromptTurnCompleted(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.completeTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn completion (non-fatal)`, error);
    } finally {
      canonicalTurnOpen = false;
    }
  }

  // A failed prompt turn (e.g. hook StopFailure: API error, content filter) MUST terminalize the
  // canonical turn. Leaving it open orphans the server turn 'in_progress' forever, which keeps the
  // daemon pending-queue materialization gate blocked and strands queued messages (QA A-F3/C-F2).
  async function recordPromptTurnFailed(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.failTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn failure (non-fatal)`, error);
    } finally {
      canonicalTurnOpen = false;
    }
  }

  async function recordPromptTurnCancelled(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.cancelTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn cancellation (non-fatal)`, error);
    } finally {
      canonicalTurnOpen = false;
    }
  }

  function notePromptTurnTerminal(): void {
    canonicalTurnOpen = false;
  }

  function noteNextInjectedPromptShouldSuppressEcho(): void {
    acceptedPromptEchoSuppressionDecisions.push(true);
  }

  function noteNextInjectedPromptShouldImportEcho(): void {
    acceptedPromptEchoSuppressionDecisions.push(false);
  }

  function shouldSuppressAcceptedPromptEcho(): boolean {
    return acceptedPromptEchoSuppressionDecisions.shift() ?? true;
  }

  function shouldSuppressTranscriptMessage(message: RawJSONLines): boolean {
    if (consumePendingSteerEcho(message)) {
      opts.session.recordClaudeJsonlMessageConsumed?.(message);
      return true;
    }
    if (!promptEchoSuppressor.shouldSuppressTranscriptMessage(message)) return false;
    opts.session.recordClaudeJsonlMessageConsumed?.(message);
    return true;
  }

  async function seedPersistedPromptEchoes(seedOpts: Readonly<{ nowMs?: number | undefined }> = {}): Promise<void> {
    await seedClaudeUnifiedPersistedPromptEchoes({
      session: opts.session,
      suppressor: promptEchoSuppressor,
      ownComposerTexts,
      logPrefix: opts.logPrefix,
      nowMs: seedOpts.nowMs,
    });
  }

  return {
    sessionOptions: {
      allowFirstInputBeforeSessionStart: true,
      onMessage: (message) => {
        if (shouldSuppressTranscriptMessage(message)) return;
        opts.onMessage(message);
      },
      onReady: async () => {
        // The steered turn is over: its queued prompt is being submitted now, so the matching JSONL
        // echo must arrive within one echo window from here (bounding stale-entry suppression risk).
        armPendingSteerEchoExpiry();
        await recordPromptTurnCompleted();
        await opts.onReady(readyTurnContext);
      },
      onProviderPromptStarted: async () => {
        beginReadyNotificationTurn();
        await recordPromptTurnStarted();
      },
      setTurnInterrupt: (handler) => {
        opts.onTurnInterruptChanged?.(handler);
      },
      onTerminalPromptInjected: async (acceptedPrompt) => {
        const suppressEcho = shouldSuppressAcceptedPromptEcho();
        if (acceptedPrompt.acceptedAs === 'in_flight_steer') {
          if (suppressEcho) {
            pendingSteerEchoes.push({ text: acceptedPrompt.message, expiresAtMs: null });
          }
          return;
        }
        if (suppressEcho) {
          promptEchoSuppressor.recordAcceptedPrompt(acceptedPrompt);
        }
        beginReadyNotificationTurn();
        await recordPromptTurnStarted();
        await opts.onPromptTurnStarted?.();
      },
    },
    seedPersistedPromptEchoes,
    ownComposerTexts,
    noteNextInjectedPromptShouldSuppressEcho,
    noteNextInjectedPromptShouldImportEcho,
    shouldSuppressTranscriptMessage,
    beginReadyNotificationTurn,
    recordPromptTurnStarted,
    recordPromptTurnCompleted,
    recordPromptTurnCancelled,
    recordPromptTurnFailed,
    notePromptTurnTerminal,
  };
}
