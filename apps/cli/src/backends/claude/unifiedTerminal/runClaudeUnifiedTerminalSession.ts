import { rmdir, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { ClaudeUnifiedTerminalHost, TerminalInputInjectionV1 } from '@happier-dev/agents';

import {
  ClaudeUnifiedTerminalHostDeadError,
  createClaudeUnifiedController,
  type ClaudeUnifiedController,
} from './createClaudeUnifiedController';
import {
  createClaudeUnifiedHookLifecycleBridge,
  type ClaudeUnifiedPromptTurnTerminalEvent,
  type ClaudeUnifiedSessionEndEvent,
  type ClaudeUnifiedSessionHookSubscription,
} from './createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedTranscriptBridge } from './createClaudeUnifiedTranscriptBridge';
import { createClaudeUnifiedTerminalReadinessBridge } from './createClaudeUnifiedTerminalReadinessBridge';
import { createClaudeUnifiedHostLivenessBridge } from './createClaudeUnifiedHostLivenessBridge';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';
import { createClaudeUnifiedPromptInjector } from './createClaudeUnifiedPromptInjector';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';
import { ClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';
import type {
  ClaudeUnifiedInputConsumer,
  ClaudeUnifiedPromptAcceptance,
  ClaudeUnifiedStartableDisposable,
} from './_types';
import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import type { SessionHookData } from '../utils/startHookServer';
import { resolveClaudeConfigDirOverride } from '../utils/resolveClaudeConfigDirOverride';
import type { MessageBatch } from '@/agent/runtime/sessionInput/types';
import type { Metadata } from '@/api/types';
import { buildTerminalAttachmentMetadataFromHostHandle } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalHostAdapter, TerminalHostHandle, TerminalHostResolution } from '@/integrations/terminalHost/_types';
import { persistTerminalAttachmentInfoIfNeeded } from '@/agent/runtime/startupSideEffects';
import { removeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalHostRegistry } from '@/integrations/terminalHost/registry';
import { resolveTerminalHost } from '@/integrations/terminalHost/resolveTerminalHost';
import { createTmuxTerminalHostAdapter, isTmuxAvailable } from '@/integrations/tmux';
import { createZellijTerminalHostAdapter } from '@/integrations/zellij/adapter';
import { createWindowsTerminalZellijForegroundClientLauncher } from '@/integrations/zellij/windowsForegroundClient';
import { configuration } from '@/configuration';
import {
  buildClaudeUnifiedTerminalSpawn,
  type ClaudeUnifiedTerminalSpawn,
} from './buildClaudeUnifiedTerminalSpawn';
import { resolveZellijWindowsGuard } from '@/integrations/zellij/zellijWindowsGuards';
import { resolveZellijRuntimeBinary } from '@/integrations/zellij/runtimeBinary';
import {
  createClaudeUnifiedTelemetrySink,
  emitClaudeUnifiedHostDead,
  emitClaudeUnifiedWindowsGuardTriggered,
  maybeEmitClaudeUnifiedWindowsGuardTriggered,
  type ClaudeUnifiedTelemetrySink,
} from './telemetry';
import type { NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { logger } from '@/ui/logger';

type ClaudeUnifiedTerminalQueuedInput<Mode> = Readonly<{
  message: string;
  mode: Mode;
}>;

type ClaudeUnifiedTerminalAcceptedInput<Mode> =
  ClaudeUnifiedTerminalQueuedInput<Mode> & ClaudeUnifiedPromptAcceptance;

type ClaudeUnifiedTerminalHostPreference = ClaudeUnifiedTerminalHost;
type ClaudeUnifiedProcessSignal = 'SIGINT' | 'SIGTERM';
type ClaudeUnifiedProcessSignals = Readonly<{
  once(event: ClaudeUnifiedProcessSignal, listener: () => void): unknown;
  removeListener(event: ClaudeUnifiedProcessSignal, listener: () => void): unknown;
}>;

export class ClaudeUnifiedTerminalHostUnavailableError extends Error {
  readonly code = 'claude_unified_terminal_host_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeUnifiedTerminalHostUnavailableError';
  }
}

export type ClaudeUnifiedTerminalSessionOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  path: string;
  happySessionId?: string | null | undefined;
  sessionId?: string | null | undefined;
  transcriptPath?: string | null | undefined;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  systemPromptText?: string | null | undefined;
  signal?: AbortSignal | undefined;
  initialMode?: Mode | undefined;
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>;
  resolveHostAdapter?: ((preference: ClaudeUnifiedTerminalHostPreference) => Promise<TerminalHostResolution>) | undefined;
  buildSpawn?: ((params: Readonly<{
    first: ClaudeUnifiedTerminalQueuedInput<Mode>;
    path: string;
    claudeArgs?: readonly string[] | undefined;
    hookSettingsPath?: string | undefined;
    hookPluginDir?: string | null | undefined;
    happierMcpConfigJson?: string | undefined;
    systemPromptText?: string | null | undefined;
  }>) => Promise<ClaudeUnifiedTerminalSpawn>) | undefined;
  createSessionName?: (() => string) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  subscribeClaudeSessionHooks?: ClaudeUnifiedSessionHookSubscription | undefined;
  lifecycleCompletionQuiescenceMs?: number | undefined;
  onThinkingChange?: ((thinking: boolean) => void) | undefined;
  onReady?: (() => void | Promise<void>) | undefined;
  onUsageLimitDetails?: ((details: NormalizedProviderUsageLimitDetailsV1) => void | Promise<void>) | undefined;
  onRuntimeAuthFailureEvent?: ((error: unknown) => void | Promise<void>) | undefined;
  onProviderPromptStarted?: (() => void | Promise<void>) | undefined;
  onPromptTurnTerminal?: ((event: ClaudeUnifiedPromptTurnTerminalEvent) => void | Promise<void>) | undefined;
  onMessage?: ((message: RawJSONLines) => void) | undefined;
  onSessionFound?: ((sessionId: string, data?: SessionHookData) => void) | undefined;
  loadCommittedClaudeJsonlMessageKeys?: (() => Promise<ReadonlySet<string>> | ReadonlySet<string>) | undefined;
  allowFirstInputBeforeSessionStart?: boolean | undefined;
  initialHostLivenessTimeoutMs?: number | undefined;
  initialHostLivenessPollMs?: number | undefined;
  providerAcceptanceTimeoutMs?: number | undefined;
  setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null | undefined;
  onTerminalPromptInjected?: ((input: ClaudeUnifiedTerminalAcceptedInput<Mode>) => void | Promise<void>) | undefined;
  onTerminalInjectionFailure?: ((error: ClaudeUnifiedTerminalInjectionFailureError) => void | Promise<void>) | undefined;
  onTerminalHostReady?: ((params: Readonly<{
    handle: TerminalHostHandle;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  persistTerminalHostAttachmentInfo?: ((params: Readonly<{
    sessionId: string;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  removeTerminalHostAttachmentInfo?: ((params: Readonly<{
    sessionId: string;
    terminal: NonNullable<Metadata['terminal']>;
  }>) => void | Promise<void>) | undefined;
  processSignals?: ClaudeUnifiedProcessSignals | null | undefined;
  createController?: ((params: Readonly<{
    hostAdapter: TerminalHostAdapter;
    inputInjection: TerminalInputInjectionV1;
    inputConsumer: ClaudeUnifiedInputConsumer<Mode>;
  }>) => ClaudeUnifiedController | Promise<ClaudeUnifiedController>) | undefined;
}>;

function sanitizeSessionName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'session';
}

function createDefaultSessionName(): string {
  return `happier-claude-unified-${sanitizeSessionName(String(process.pid))}-${Date.now()}`;
}

async function resolveDefaultHostAdapter(
  preference: ClaudeUnifiedTerminalHostPreference,
  telemetry: ClaudeUnifiedTelemetrySink,
): Promise<TerminalHostResolution> {
  const tmuxAvailable = await isTmuxAvailable();
  const zellijBinary = await resolveZellijRuntimeBinary();
  const zellijWindowsGuard = resolveZellijWindowsGuard({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  });
  if (zellijWindowsGuard.status === 'disabled') {
    emitClaudeUnifiedWindowsGuardTriggered(telemetry, zellijWindowsGuard.reason);
    return {
      status: 'disabled',
      reason: zellijWindowsGuard.reason,
      message: zellijWindowsGuard.message,
    };
  }
  if (process.platform === 'win32' && zellijWindowsGuard.shell === 'cmd.exe') {
    emitClaudeUnifiedWindowsGuardTriggered(telemetry, 'windows_default_shell_cmd');
  }
  const adapters = createTerminalHostRegistry([
    ...(tmuxAvailable ? [createTmuxTerminalHostAdapter()] : []),
    ...(zellijBinary
      ? [
          createZellijTerminalHostAdapter({
            zellijBinary,
            happyHomeDir: configuration.happyHomeDir,
            defaultShell: zellijWindowsGuard.shell,
            ...(zellijWindowsGuard.launchStrategy === 'foreground_windows_terminal'
              ? {
                  launchStrategy: {
                    type: 'foregroundAttached',
                    launchClient: createWindowsTerminalZellijForegroundClientLauncher(),
                  } as const,
                }
              : {}),
            actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
          }),
        ]
      : []),
  ]);

  return resolveTerminalHost({
    preference,
    platform: { os: process.platform, arch: process.arch },
    adapters,
    tmuxAvailable,
    zellijAvailable: Boolean(zellijBinary),
  });
}

async function buildDefaultSpawn(params: Readonly<{
  first: ClaudeUnifiedTerminalQueuedInput<EnhancedMode>;
  path: string;
  claudeArgs?: readonly string[] | undefined;
  hookSettingsPath?: string | undefined;
  hookPluginDir?: string | null | undefined;
  happierMcpConfigJson?: string | undefined;
  systemPromptText?: string | null | undefined;
}>): Promise<ClaudeUnifiedTerminalSpawn> {
  return buildClaudeUnifiedTerminalSpawn(params);
}

async function removeUnreadLaunchSpec(spawn: ClaudeUnifiedTerminalSpawn): Promise<void> {
  if (!spawn.launchSpecPath) return;
  await unlink(spawn.launchSpecPath).catch(() => undefined);
  const specDir = dirname(spawn.launchSpecPath);
  if (basename(specDir).startsWith('happier-terminal-launch-')) {
    await rmdir(specDir).catch(() => undefined);
  }
}

function isClaudePromptInputExit(event: ClaudeUnifiedSessionEndEvent): boolean {
  return event.reason === 'prompt_input_exit';
}

function isCleanTerminalExit(liveness: Readonly<{ paneExitStatus?: number | undefined }>): boolean {
  return liveness.paneExitStatus === 0;
}

function waitForAnyAbort(signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanups: Array<() => void> = [];
    const onAbort = () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolve();
    };
    for (const signal of signals) {
      const listener = () => onAbort();
      cleanups.push(() => signal.removeEventListener('abort', listener));
      signal.addEventListener('abort', listener, { once: true });
    }
  });
}

function bindProcessSignalCleanup(params: Readonly<{
  processSignals: ClaudeUnifiedProcessSignals;
  abortController: AbortController;
  dispose: () => Promise<void>;
}>): () => void {
  let cleanupStarted = false;
  const onSignal = () => {
    if (!params.abortController.signal.aborted) {
      params.abortController.abort('claude-unified-process-signal');
    }
    if (cleanupStarted) return;
    cleanupStarted = true;
    void params.dispose().catch((error) => {
      logger.debug('[unified]: failed to dispose Claude unified terminal session during process signal cleanup', error);
    });
  };

  params.processSignals.once('SIGINT', onSignal);
  params.processSignals.once('SIGTERM', onSignal);

  return () => {
    params.processSignals.removeListener('SIGINT', onSignal);
    params.processSignals.removeListener('SIGTERM', onSignal);
  };
}

function createProvisionalTerminalHostHandle(params: Readonly<{
  kind: TerminalHostHandle['kind'];
  sessionName: string;
}>): TerminalHostHandle {
  return {
    kind: params.kind,
    sessionName: params.sessionName,
    ...(params.kind === 'tmux' ? { paneId: params.sessionName } : {}),
    attachMetadata: {
      attachStrategy: 'terminal_host',
      topology: 'shared',
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    },
  };
}

async function disposeHostForProcessSignal(dispose: () => Promise<void>): Promise<void> {
  try {
    await dispose();
  } catch (error) {
    logger.debug('[unified]: failed to dispose Claude unified terminal session during process signal cleanup', error);
  }
}

function normalizeMessageBatch<Mode>(input: ClaudeUnifiedTerminalQueuedInput<Mode>): MessageBatch<Mode, string> {
  return {
    message: input.message,
    mode: input.mode,
    isolate: false,
    hash: 'claude-unified-terminal',
  };
}

function isCompactBoundaryTranscriptMessage(message: RawJSONLines): boolean {
  return message.type === 'system' && (message as Record<string, unknown>).subtype === 'compact_boundary';
}

function isCompactSlashCommandPrompt(message: string): boolean {
  const trimmed = message.trim();
  return trimmed === '/compact' || trimmed.startsWith('/compact ');
}

function createCompositeBridge(
  bridges: ReadonlyArray<ClaudeUnifiedStartableDisposable | undefined>,
): ClaudeUnifiedStartableDisposable | undefined {
  const activeBridges = bridges.filter((bridge): bridge is ClaudeUnifiedStartableDisposable => Boolean(bridge));
  if (activeBridges.length === 0) return undefined;
  return {
    start(opts) {
      return Promise.all(activeBridges.map((bridge) => Promise.resolve(bridge.start(opts))))
        .then(() => undefined);
    },
    async dispose() {
      let firstError: unknown;
      for (const bridge of [...activeBridges].reverse()) {
        try {
          await Promise.resolve(bridge.dispose());
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) {
        throw firstError;
      }
    },
  };
}

function createReplayableHookSubscription(
  subscribe: ClaudeUnifiedSessionHookSubscription | undefined,
): Readonly<{
  subscribe: ClaudeUnifiedSessionHookSubscription | undefined;
  dispose: () => void;
}> {
  if (!subscribe) {
    return {
      subscribe: undefined,
      dispose: () => {},
    };
  }

  const bufferedEvents: SessionHookData[] = [];
  const subscribers = new Set<(data: SessionHookData) => void>();
  const unsubscribeUpstream = subscribe((data) => {
    bufferedEvents.push(data);
    for (const subscriber of [...subscribers]) {
      subscriber(data);
    }
  });

  return {
    subscribe: (callback) => {
      subscribers.add(callback);
      for (const event of bufferedEvents) {
        callback(event);
      }
      return () => {
        subscribers.delete(callback);
      };
    },
    dispose: () => {
      subscribers.clear();
      unsubscribeUpstream?.();
    },
  };
}

function createInputConsumer<Mode>(
  first: ClaudeUnifiedTerminalQueuedInput<Mode> | null,
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>,
): ClaudeUnifiedInputConsumer<Mode> {
  let firstPending = first !== null;
  return {
    async waitForNextInput() {
      if (firstPending && first) {
        firstPending = false;
        return normalizeMessageBatch(first);
      }
      const next = await nextMessage();
      return next ? normalizeMessageBatch(next) : null;
    },
  };
}

async function persistTerminalHostAttachmentInfoIfAvailable(params: Readonly<{
  sessionId: string | null | undefined;
  handle: TerminalHostHandle;
  persist: NonNullable<ClaudeUnifiedTerminalSessionOptions['persistTerminalHostAttachmentInfo']>;
}>): Promise<NonNullable<Metadata['terminal']> | null> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) return null;

  const terminal = buildTerminalAttachmentMetadataFromHostHandle(params.handle);
  if (!terminal) return null;

  await params.persist({ sessionId, terminal });
  return terminal;
}

async function removeTerminalHostAttachmentInfoIfAvailable(params: Readonly<{
  sessionId: string | null | undefined;
  terminal: NonNullable<Metadata['terminal']> | null;
  remove: NonNullable<ClaudeUnifiedTerminalSessionOptions['removeTerminalHostAttachmentInfo']>;
}>): Promise<void> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId || !params.terminal) return;

  await params.remove({ sessionId, terminal: params.terminal });
}

async function removeDefaultTerminalHostAttachmentInfo(params: Readonly<{
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
}>): Promise<void> {
  await removeTerminalAttachmentInfo({
    happyHomeDir: configuration.happyHomeDir,
    sessionId: params.sessionId,
    expectedTerminal: params.terminal,
  });
}

export async function runClaudeUnifiedTerminalSession<Mode extends EnhancedMode = EnhancedMode>(
  opts: ClaudeUnifiedTerminalSessionOptions<Mode>,
): Promise<void> {
  const first = opts.initialMode ? null : await opts.nextMessage();
  if (!first && !opts.initialMode) return;
  const allowReadinessBeforeSessionStart = Boolean(first && opts.allowFirstInputBeforeSessionStart);
  const allowEmptyStartupInputBeforeSessionStart = first === null && Boolean(opts.initialMode);
  const acceptedPromptTranscriptDiscovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
    acceptedPromptWindowMs: configuration.claudeUnifiedTerminalAcceptedPromptEchoWindowMs,
  });

  const telemetry = opts.telemetry ?? createClaudeUnifiedTelemetrySink();
  const startupMode = first?.mode ?? opts.initialMode;
  if (!startupMode) return;
  const startupInput: ClaudeUnifiedTerminalQueuedInput<Mode> = first ?? {
    message: '',
    mode: startupMode,
  };
  const hostPreference = startupMode.claudeUnifiedTerminalHost ?? 'auto';
  const hostResolution = await (
    opts.resolveHostAdapter
      ? opts.resolveHostAdapter(hostPreference)
      : resolveDefaultHostAdapter(hostPreference, telemetry)
  );
  telemetry.emit({
    name: 'unified.session.host_resolved',
    properties: {
      kind: hostResolution.status === 'resolved' ? hostResolution.adapter.kind : 'disabled',
      platform: process.platform,
      preference: hostPreference,
      reason: hostResolution.reason,
    },
  });
  if (hostResolution.status !== 'resolved') {
    maybeEmitClaudeUnifiedWindowsGuardTriggered(telemetry, hostResolution.reason);
    throw new ClaudeUnifiedTerminalHostUnavailableError(hostResolution.message);
  }
  const spawn = await (opts.buildSpawn ?? buildDefaultSpawn)({
    first: startupInput,
    path: opts.path,
    claudeArgs: opts.claudeArgs,
    hookSettingsPath: opts.hookSettingsPath,
    hookPluginDir: opts.hookPluginDir,
    happierMcpConfigJson: opts.happierMcpConfigJson,
    systemPromptText: opts.systemPromptText,
  });
  const hookSubscription = createReplayableHookSubscription(opts.subscribeClaudeSessionHooks);
  const sessionName = opts.createSessionName?.() ?? createDefaultSessionName();
  let handle: TerminalHostHandle | null = null;
  let controller: ClaudeUnifiedController | null = null;
  let terminalAttachment: NonNullable<Metadata['terminal']> | null = null;
  let removeProcessSignalCleanup: (() => void) | null = null;
  let turnInterruptRegistered = false;
  const runtimeAbortController = new AbortController();
  const processSignalAbortController = new AbortController();
  let fatalRuntimeError: unknown = null;
  let startupHostLivenessGraceActive = true;
  let expectedPromptInputExit = false;
  let preHandleProcessSignalCleanupRan = false;
  let concreteHostDisposedByProcessSignal = false;
  const endStartupHostLivenessGrace = (): void => {
    startupHostLivenessGraceActive = false;
  };
  const provisionalHandle = createProvisionalTerminalHostHandle({
    kind: hostResolution.adapter.kind,
    sessionName,
  });
  removeProcessSignalCleanup = bindProcessSignalCleanup({
    processSignals: opts.processSignals ?? process,
    abortController: processSignalAbortController,
    dispose: async () => {
      if (handle) {
        if (controller) {
          await controller.dispose();
        } else {
          await hostResolution.adapter.dispose(handle);
          concreteHostDisposedByProcessSignal = true;
        }
        return;
      }
      preHandleProcessSignalCleanupRan = true;
      await hostResolution.adapter.dispose(provisionalHandle);
    },
  });
  try {
    handle = await hostResolution.adapter.createOrAttachHost({
      sessionName,
      workingDirectory: opts.path,
      spawnArgv: spawn.spawnArgv,
      spawnEnv: spawn.spawnEnv,
      isolatedEnv: true,
    });
  } catch (error) {
    removeProcessSignalCleanup?.();
    removeProcessSignalCleanup = null;
    hookSubscription.dispose();
    await removeUnreadLaunchSpec(spawn);
    throw error;
  }
  if (processSignalAbortController.signal.aborted) {
    if (preHandleProcessSignalCleanupRan || !concreteHostDisposedByProcessSignal) {
      await disposeHostForProcessSignal(async () => {
        await hostResolution.adapter.dispose(handle);
        concreteHostDisposedByProcessSignal = true;
      });
    }
    removeProcessSignalCleanup?.();
    hookSubscription.dispose();
    await removeUnreadLaunchSpec(spawn);
    return;
  }
  const activeHandle = handle;
  try {
    terminalAttachment = await persistTerminalHostAttachmentInfoIfAvailable({
      sessionId: opts.happySessionId,
      handle: activeHandle,
      persist: opts.persistTerminalHostAttachmentInfo ?? persistTerminalAttachmentInfoIfNeeded,
    });
    if (processSignalAbortController.signal.aborted) {
      return;
    }

    const inputInjection: TerminalInputInjectionV1 = {
      hostKind: hostResolution.adapter.kind,
      injectUserPrompt: async (input) => {
        const result = await hostResolution.adapter.injectUserPrompt(activeHandle, input);
        if (result.status === 'injected') {
          acceptedPromptTranscriptDiscovery.recordAcceptedPrompt({
            message: input.text,
            acceptedAtMs: result.at,
          });
        }
        return result;
      },
    };
    removeProcessSignalCleanup?.();
    removeProcessSignalCleanup = bindProcessSignalCleanup({
      processSignals: opts.processSignals ?? process,
      abortController: processSignalAbortController,
      dispose: () => controller?.dispose() ?? hostResolution.adapter.dispose(activeHandle),
    });
    opts.setTurnInterrupt?.(() => hostResolution.adapter.interruptTurn(activeHandle));
    turnInterruptRegistered = true;
    const inputConsumer = createInputConsumer(first, opts.nextMessage);
    controller = await (opts.createController?.({
      hostAdapter: hostResolution.adapter,
      inputInjection,
      inputConsumer,
    }) ?? (() => {
      const promptInjector = createClaudeUnifiedPromptInjector<Mode>({
        inputInjection,
        telemetry,
      });
      const arbiter = createClaudeUnifiedInputArbiter<Mode>({
        injectPrompt: promptInjector.injectPrompt,
        injectionRetryLimit: configuration.claudeUnifiedTerminalInjectionRetryLimit,
        injectionRetryBaseDelayMs: configuration.claudeUnifiedTerminalInjectionRetryBaseDelayMs,
        providerAcceptanceTimeoutMs:
          opts.providerAcceptanceTimeoutMs ??
          configuration.claudeUnifiedTerminalProviderAcceptanceTimeoutMs,
        onInjectionFailure: (failure) => {
          const error = new ClaudeUnifiedTerminalInjectionFailureError(failure);
          if (failure.failureState === 'failed_terminal') {
            fatalRuntimeError ??= error;
            runtimeAbortController.abort(error);
            return;
          }
          void Promise.resolve().then(() => opts.onTerminalInjectionFailure?.(error)).catch((notifyError) => {
            logger.debug('[unified]: failed to surface Claude unified terminal injection failure (non-fatal)', notifyError);
          });
        },
        onPromptInjected: (batch, acceptance) => {
          if (batch.mode === undefined) return undefined;
          endStartupHostLivenessGrace();
          return opts.onTerminalPromptInjected?.({
            message: batch.message,
            mode: batch.mode,
            acceptedAs: acceptance.acceptedAs,
            turnStateAtInjection: acceptance.turnStateAtInjection,
          });
        },
        onPromptAccepted: () => undefined,
      });
      const confirmPromptAcceptedFromTranscript = (messages: readonly RawJSONLines[]): boolean => {
        if (!acceptedPromptTranscriptDiscovery.consumeMatchingTranscript(messages)) return false;
        void arbiter.confirmPromptAcceptedByProvider().catch(() => undefined);
        return true;
      };
      const confirmCompactBoundaryPromptAcceptedFromTranscript = (message: RawJSONLines): boolean => {
        if (!isCompactBoundaryTranscriptMessage(message)) return false;
        void arbiter.confirmPromptAcceptedByProviderIf((batch) => isCompactSlashCommandPrompt(batch.message)).catch(() => undefined);
        return true;
      };
      const pendingQueuePump = createClaudeUnifiedPendingQueuePump<Mode>({
        inputConsumer,
        arbiter,
      });
      const lifecycleBridge = hookSubscription.subscribe
        ? createClaudeUnifiedHookLifecycleBridge({
            subscribeClaudeSessionHooks: hookSubscription.subscribe,
            arbiter,
            completionQuiescenceMs:
              opts.lifecycleCompletionQuiescenceMs ?? configuration.claudeLocalTurnCompletionQuiescenceMs,
            onThinkingChange: opts.onThinkingChange,
            onReady: opts.onReady,
            onUsageLimitDetails: opts.onUsageLimitDetails,
            onRuntimeAuthFailureEvent: opts.onRuntimeAuthFailureEvent,
            onProviderPromptStarted: opts.onProviderPromptStarted,
            onPromptTurnTerminal: opts.onPromptTurnTerminal,
            onSessionEnd: (event) => {
              if (isClaudePromptInputExit(event)) {
                expectedPromptInputExit = true;
              }
            },
          })
        : undefined;
      const transcriptBridge = opts.onMessage || opts.onSessionFound
        ? createClaudeUnifiedTranscriptBridge({
            sessionId: opts.sessionId ?? null,
            transcriptPath: opts.transcriptPath,
            workingDirectory: opts.path,
            claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
            onMessage: opts.onMessage,
            onTranscriptMessage: (message) => {
              if (!confirmPromptAcceptedFromTranscript([message])) {
                confirmCompactBoundaryPromptAcceptedFromTranscript(message);
              }
              lifecycleBridge?.observeTranscript(message);
            },
            onSessionFound: opts.onSessionFound,
            loadCommittedClaudeJsonlMessageKeys: opts.loadCommittedClaudeJsonlMessageKeys,
            transcriptMissingWarningMs: configuration.claudeTranscriptMissingWarningMs,
            subscribeClaudeSessionHooks: hookSubscription.subscribe,
            classifyDiscoveredSession: ({ messages }) => (
              confirmPromptAcceptedFromTranscript(messages) ? 'main' : null
            ),
          })
        : undefined;
      return createClaudeUnifiedController({
        host: {
          evaluateLiveness: () => hostResolution.adapter.evaluateLiveness(activeHandle),
          dispose: () => hostResolution.adapter.dispose(activeHandle),
        },
        pendingQueuePump,
        arbiter,
        onFatalError: (error) => {
          fatalRuntimeError ??= error;
          runtimeAbortController.abort(error);
        },
        initialLivenessTimeoutMs:
          opts.initialHostLivenessTimeoutMs ??
          Math.min(configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs, 1_000),
        initialLivenessPollMs:
          opts.initialHostLivenessPollMs ??
          Math.min(configuration.claudeUnifiedTerminalStartupReadinessPollMs, 50),
        transcriptBridge: createCompositeBridge([
          createClaudeUnifiedTerminalReadinessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            arbiter,
            pollIntervalMs: configuration.claudeUnifiedTerminalStartupReadinessPollMs,
            timeoutMs: configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs,
            onStartupReady: endStartupHostLivenessGrace,
            emitOutputReadiness:
              allowEmptyStartupInputBeforeSessionStart ||
              allowReadinessBeforeSessionStart ||
              !opts.subscribeClaudeSessionHooks ||
              Boolean(opts.sessionId || opts.transcriptPath),
          }),
          createClaudeUnifiedHostLivenessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            telemetry,
            pollIntervalMs: configuration.claudeUnifiedTerminalHostLivenessPollMs,
            startupGraceMs: configuration.claudeUnifiedTerminalStartupReadinessTimeoutMs,
            startupGraceActive: () => startupHostLivenessGraceActive,
            isExpectedHostExit: (liveness) => expectedPromptInputExit && isCleanTerminalExit(liveness),
            onHostExited: () => {
              if (!runtimeAbortController.signal.aborted) {
                runtimeAbortController.abort('claude-unified-terminal-graceful-exit');
              }
            },
            onHostDead: (error) => {
              fatalRuntimeError ??= error;
              runtimeAbortController.abort(error);
            },
          }),
          lifecycleBridge,
          transcriptBridge,
        ]),
      });
    })());

    try {
      await controller.run();
    } catch (error) {
      if (error instanceof ClaudeUnifiedTerminalHostDeadError) {
        emitClaudeUnifiedHostDead(telemetry, {
          hostKind: activeHandle.kind,
          sessionName: activeHandle.sessionName,
          paneId: activeHandle.paneId,
          liveness: error.liveness,
        });
      }
      throw error;
    }
    if (terminalAttachment) {
      await opts.onTerminalHostReady?.({ handle: activeHandle, terminal: terminalAttachment });
    }
    const waitSignals = [runtimeAbortController.signal, processSignalAbortController.signal];
    if (opts.signal) {
      waitSignals.push(opts.signal);
    }
    await waitForAnyAbort(waitSignals);
    if (fatalRuntimeError) {
      throw fatalRuntimeError;
    }
  } finally {
    if (turnInterruptRegistered) {
      opts.setTurnInterrupt?.(null);
    }
    removeProcessSignalCleanup?.();
    if (controller) {
      await controller.dispose();
    } else if (!concreteHostDisposedByProcessSignal) {
      await hostResolution.adapter.dispose(activeHandle);
    }
    await removeTerminalHostAttachmentInfoIfAvailable({
      sessionId: opts.happySessionId,
      terminal: terminalAttachment,
      remove: opts.removeTerminalHostAttachmentInfo ?? removeDefaultTerminalHostAttachmentInfo,
    }).catch((error) => {
      logger.debug('[unified]: failed to remove Claude unified terminal attachment info', error);
    });
    hookSubscription.dispose();
  }
}
