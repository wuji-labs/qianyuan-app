import { createClaudeReadyHandler } from '../ready/createClaudeReadyHandler';
import type { EnhancedMode } from '../loop';
import type { Session } from '../session';
import type { LauncherResult } from '../claudeLocalLauncher';
import { createClaudeSessionTranscriptProjector } from '../localControl/createClaudeSessionTranscriptProjector';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import {
  surfaceClaudeConnectedServiceRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from '../connectedServices/surfaceClaudeRuntimeIssues';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import { bindClaudeUnifiedTerminalSession } from './bindClaudeUnifiedTerminalSession';
import { isClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';
import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import { runTmuxAttach } from '@/terminal/attachment/tmuxAttach';
import { runZellijAttach } from '@/terminal/attachment/zellijAttach';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';
import { extractClaudeTerminalInitialPrompt } from '../cli/terminalInitialPrompt';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { configuration } from '@/configuration';

function shouldForegroundAttachTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS = 5_000;

function startForegroundAttach(params: Readonly<{
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}>): void {
  if (!shouldForegroundAttachTerminal()) return;

  if (params.terminal.mode === 'tmux') {
    void runTmuxAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
    return;
  }

  if (params.terminal.mode === 'zellij') {
    void runZellijAttach({
      sessionId: params.sessionId,
      terminal: params.terminal,
    }).catch(() => undefined);
  }
}

function isClaudeUnifiedTerminalHostDeadError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'claude_unified_terminal_host_dead';
}

function sendUnifiedTerminalHostDeadMessage(session: Session): void {
  session.client.sendSessionEvent({
    type: 'message',
    message: 'Claude unified terminal host is not alive. The terminal process exited before Happier could send your prompt.',
  });
}

function isRecentClaudeUnifiedTerminalAuthFailure(params: Readonly<{
  authFailureAtMs: number | null;
  nowMs: number;
}>): boolean {
  return params.authFailureAtMs !== null
    && params.nowMs - params.authFailureAtMs >= 0
    && params.nowMs - params.authFailureAtMs <= CLAUDE_UNIFIED_TERMINAL_AUTH_FAILURE_HOST_DEATH_WINDOW_MS;
}

async function flushUnifiedStartupFailureSurface(session: Session, reason: string): Promise<void> {
  try {
    await session.client.flush();
  } catch (error) {
    logger.debug('[unified]: failed to flush Claude unified startup failure surface (non-fatal)', {
      reason,
      error,
    });
  }
}

export async function claudeUnifiedTerminalLauncher(
  session: Session,
  opts: Readonly<{
    initialMode?: EnhancedMode | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<LauncherResult> {
  const abortController = new AbortController();
  let removeExternalAbortListener: (() => void) | null = null;
  if (opts.signal) {
    const abortFromExternalSignal = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(opts.signal?.reason ?? 'claude-unified-external-abort');
      }
    };
    if (opts.signal.aborted) {
      abortFromExternalSignal();
    } else {
      opts.signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      removeExternalAbortListener = () => opts.signal?.removeEventListener('abort', abortFromExternalSignal);
    }
  }
  let turnInterrupt: (() => Promise<void>) | null = null;
  const initialPrompt = extractClaudeTerminalInitialPrompt(session.claudeArgs);
  let initialPromptPending = typeof initialPrompt.prompt === 'string';
  const transcriptProjector = createClaudeSessionTranscriptProjector({ session, logPrefix: '[unified]' });
  let lastSurfacedRuntimeAuthFailureAtMs: number | null = null;
  const readyHandler = createClaudeReadyHandler({
    session: session.client,
    pushSender: session.pushSender,
    waitingForCommandLabel: 'Claude',
    logPrefix: '[unified]',
    getPending: () => null,
    getQueueSize: () => session.queue.size(),
    accountSettings: session.accountSettings,
    settingsSecretsReadKeys: session.accountSettingsSecretsReadKeys,
    includeAssistantPreviewText:
      session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
    shouldSendPush: () => shouldSendReadyPushNotification(session.accountSettings ?? null),
  });
  const { mcpConfigJson } = await session.getOrCreateHappierMcpBridge();
  const binding = bindClaudeUnifiedTerminalSession({
    session: session.client,
    logPrefix: '[unified]',
    acceptedPromptEchoWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
    onMessage: (message) => {
      transcriptProjector.observe(message);
    },
    onReady: (context) => {
      readyHandler(context);
    },
    onTurnInterruptChanged: (handler) => {
      turnInterrupt = handler;
    },
    onPromptTurnStarted: () => {
      session.setThinkingWithoutTaskLifecycle(true);
    },
  });
  await binding.seedPersistedPromptEchoes();

  const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
    void surfaceClaudeRateLimitRuntimeIssue(session, details, '[unified]')
      .catch((error) => {
        logger.debug('[unified]: failed to surface Claude rate-limit runtime issue', error);
      })
      .finally(binding.notePromptTurnTerminal);
  }

  const surfacePromptTurnTerminal = async (event: Readonly<{
    reason: string;
    source: string;
    detail?: string | undefined;
  }>): Promise<void> => {
    try {
      if (event.reason === 'aborted') {
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        return;
      }
      if (event.reason === 'failed' && event.source === 'claude_transcript_api_error') {
        await surfacePrimarySessionRuntimeIssue({
          provider: 'claude',
          cause: 'status_error',
          error: {
            code: event.source,
            message: event.detail ?? event.source,
          },
          session: session.client,
        }).catch((error) => {
          logger.debug('[unified]: failed to surface Claude transcript API-error turn failure (non-fatal)', error);
          return null;
        });
      }
    } finally {
      binding.notePromptTurnTerminal();
    }
  };
  const surfaceTerminalInjectionFailure = async (error: unknown): Promise<void> => {
    session.onThinkingChange(false);
    await surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'session_error',
      error,
      session: session.client,
    }).catch((surfaceError) => {
      logger.debug('[unified]: failed to surface Claude unified terminal injection failure (non-fatal)', surfaceError);
      return null;
    });
    binding.notePromptTurnTerminal();
  };

  session.client.rpcHandlerManager.registerHandler('abort', async () => {
    session.noteUserAbortRequested();
    if (turnInterrupt) {
      try {
        await turnInterrupt();
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        return true;
      } catch (error) {
        logger.debug('[unified]: failed to interrupt Claude terminal turn; keeping unified host alive', error);
        await binding.recordPromptTurnCancelled();
        session.abortCurrentTaskTurn();
        return true;
      }
    }
    logger.debug('[unified]: UI abort requested before Claude terminal turn interrupt handler was ready');
    await binding.recordPromptTurnCancelled();
    session.abortCurrentTaskTurn();
    return true;
  });

  try {
    await runClaudeUnifiedTerminalSession({
      path: session.path,
      happySessionId: session.client.sessionId,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
      claudeArgs: initialPrompt.claudeArgs,
      hookSettingsPath: session.hookSettingsPath,
      hookPluginDir: session.hookPluginDir,
      happierMcpConfigJson: mcpConfigJson,
      systemPromptText: session.defaultSystemPromptText,
      initialMode: initialPromptPending ? undefined : opts.initialMode,
      ...binding.sessionOptions,
      signal: abortController.signal,
      nextMessage: async () => {
        if (initialPromptPending && initialPrompt.prompt) {
          initialPromptPending = false;
          binding.noteNextInjectedPromptShouldImportEcho();
          return {
            message: initialPrompt.prompt,
            mode: opts.initialMode ?? {
              permissionMode: session.lastPermissionMode ?? 'default',
              claudeUnifiedTerminalEnabled: true,
            },
          };
        }
        initialPromptPending = false;
        const batch = await session.queue.waitForMessagesAndGetAsString(abortController.signal);
        if (!batch) return null;
        binding.noteNextInjectedPromptShouldSuppressEcho();
        return {
          message: batch.message,
          mode: batch.mode,
        };
      },
      subscribeClaudeSessionHooks: (callback) => {
        session.addClaudeSessionHookCallback(callback);
        return () => {
          session.removeClaudeSessionHookCallback(callback);
        };
      },
      loadCommittedClaudeJsonlMessageKeys: () =>
        session.client.fetchCommittedClaudeJsonlMessageKeys?.() ?? new Set<string>(),
      onSessionFound: (sessionId, data) => {
        session.onSessionFound(sessionId, data);
      },
      onThinkingChange: (thinking) => {
        session.onThinkingChange(thinking);
      },
      onUsageLimitDetails: surfaceRateLimit,
      onRuntimeAuthFailureEvent: async (error) => {
        try {
          const surfaced = await surfaceClaudeConnectedServiceRuntimeAuthFailure(session, error, '[unified]');
          if (surfaced) {
            lastSurfacedRuntimeAuthFailureAtMs = Date.now();
          }
        } finally {
          binding.notePromptTurnTerminal();
        }
      },
      onPromptTurnTerminal: surfacePromptTurnTerminal,
      onTerminalInjectionFailure: surfaceTerminalInjectionFailure,
      onTerminalHostReady: ({ terminal }) => {
        startForegroundAttach({
          sessionId: session.client.sessionId,
          terminal,
        });
      },
    });
  } catch (error) {
    if (isClaudeUnifiedTerminalHostDeadError(error)) {
      session.onThinkingChange(false);
      if (isRecentClaudeUnifiedTerminalAuthFailure({
        authFailureAtMs: lastSurfacedRuntimeAuthFailureAtMs,
        nowMs: Date.now(),
      })) {
        logger.debug('[unified]: terminal host died after Claude auth failure; keeping auth diagnostic primary');
        await flushUnifiedStartupFailureSurface(session, 'host_dead_after_auth_failure');
        binding.notePromptTurnTerminal();
        throw error;
      }
      await surfacePrimarySessionRuntimeIssue({
        provider: 'claude',
        cause: 'process_exit',
        error,
        session: session.client,
      }).catch((surfaceError) => {
        logger.debug('[unified]: failed to surface Claude unified terminal host death (non-fatal)', surfaceError);
        return null;
      });
      sendUnifiedTerminalHostDeadMessage(session);
      await flushUnifiedStartupFailureSurface(session, 'host_dead');
      binding.notePromptTurnTerminal();
    }
    if (isClaudeUnifiedTerminalInjectionFailureError(error)) {
      await surfaceTerminalInjectionFailure(error);
    }
    throw error;
  } finally {
    removeExternalAbortListener?.();
  }

  return { type: 'exit', code: 0 };
}
