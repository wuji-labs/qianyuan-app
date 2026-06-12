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
import { clearOwnLeftoverComposerDraft } from './ownComposerDraftGuard';
import {
  createClaudeUnifiedInFlightSteerEvaluator,
  type ClaudeUnifiedInFlightSteerWiring,
} from './createClaudeUnifiedInFlightSteerEvaluator';
import { createClaudeOwnComposerTextLog, type ClaudeOwnComposerTextLog } from './ownComposerTextLog';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';
import { ClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';
import {
  createBlockedApplyStarvationTracker,
  createClaudeUnifiedRuntimeControlBridge,
  resolveBlockedApplyRetryMs,
  type BlockedApplyStarvationInfo,
  type ClaudeUnifiedRuntimeConfigOutcomeEvent,
  type ClaudeUnifiedRuntimeControlBridge,
} from './runtimeControlIntegration';
import {
  createClaudeSettingsGuard,
  createClaudeUnifiedTuiControlController,
  resolveClaudeConfigRootFromEnv,
  type ClaudeStatuslineRuntimeMetadata,
} from './tuiControls';
import {
  createClaudeUnifiedControlCommandEchoSuppressor,
  type ClaudeUnifiedControlCommandEchoSuppressor,
} from './controlCommandEcho';
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
  /** Hook-server coordinates for the statusline forwarder wrapper (see buildClaudeUnifiedTerminalSpawn). */
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
  signal?: AbortSignal | undefined;
  initialMode?: Mode | undefined;
  nextMessage: () => Promise<ClaudeUnifiedTerminalQueuedInput<Mode> | null>;
  /**
   * Hands back a queued message that was already consumed by the input pump but
   * can no longer be delivered (host-death/dispose unwind), so the owner can
   * requeue it instead of the message being silently dropped into a dead session.
   */
  returnUnconsumedMessage?: ((input: ClaudeUnifiedTerminalQueuedInput<Mode>) => void) | undefined;
  resolveHostAdapter?: ((preference: ClaudeUnifiedTerminalHostPreference) => Promise<TerminalHostResolution>) | undefined;
  buildSpawn?: ((params: Readonly<{
    first: ClaudeUnifiedTerminalQueuedInput<Mode>;
    path: string;
    claudeArgs?: readonly string[] | undefined;
    hookSettingsPath?: string | undefined;
    hookPluginDir?: string | null | undefined;
    happierMcpConfigJson?: string | undefined;
    systemPromptText?: string | null | undefined;
    statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
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
  /**
   * Invoked for every transcript row the runner suppresses from `onMessage` (controller-typed
   * slash-command echoes, L3). Launchers must persist a consumed marker
   * (`recordClaudeJsonlMessageConsumed`) so the row joins the committed baseline and cannot
   * replay as a "new" message after a same-session relaunch (resume-replay leak, 2026-06-11).
   */
  onTranscriptMessageSuppressed?: ((message: RawJSONLines) => void) | undefined;
  onSessionFound?: ((sessionId: string, data?: SessionHookData) => void) | undefined;
  loadCommittedClaudeJsonlMessageBaseline?: (() =>
    | Promise<import('../utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline>
    | import('../utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline) | undefined;
  allowFirstInputBeforeSessionStart?: boolean | undefined;
  /** Canonical session-turn lifecycle probe for the arbiter's stale-turn recovery (Lane N2). */
  isCanonicalTurnActive?: (() => boolean) | undefined;
  /**
   * Lane P (O-design Seam A): de-duplicated session-level steer availability tee from the steer
   * evaluator. Launchers publish it to agentState via the capability publisher.
   */
  onInFlightSteerAvailabilitySnapshot?: ((snapshot: Readonly<{ available: boolean; reason: 'unsafe_window' | 'user_terminal_draft' | null }>) => void) | undefined;
  /**
   * Lane X (incident cmq8y3nlx): one-shot per starvation episode — a steered pending prompt has
   * been blocked by a terminal composer draft past the bounded veto threshold. Launchers surface
   * a single user-visible session notice (never a silent retry loop).
   */
  onInFlightSteerUserDraftStarvation?: ((info: Readonly<{
    consecutiveVetoes: number;
    ownLeftover: boolean;
    draftLength: number;
  }>) => void) | undefined;
  /**
   * C11 (incident cmq8y3nlx): caller-owned own-injected-text registry. Launchers pass the binding's
   * registry, which is seeded from the persisted prompt store BEFORE the run, so a respawned runner
   * still recognizes (and may clear) its predecessor's leftover composer injection instead of
   * starving behind an honest-but-unresolvable `user_draft` veto. Defaults to a fresh in-memory log.
   */
  ownComposerTexts?: ClaudeOwnComposerTextLog | undefined;
  initialHostLivenessTimeoutMs?: number | undefined;
  initialHostLivenessPollMs?: number | undefined;
  /**
   * How long an uninterrupted streak of FAILED liveness probes (thrown, e.g. zellij CLI timeouts —
   * inconclusive, unlike conclusive dead observations) must last before the host is declared dead.
   * Incident cmq8y3nlx 2026-06-12: two timed-out probes ~1s apart must not kill a healthy session.
   */
  hostLivenessProbeFailureConfirmDeadMs?: number | undefined;
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
  tuiRuntimeControl?: ClaudeUnifiedTuiRuntimeControlOptions<Mode> | undefined;
}>;

/**
 * Lane E runtime-control integration options. When `featureEnabled` is true and the resolved host exposes
 * a runtime-control port, the runner instantiates the Claude Unified TUI control controller + bridge and
 * applies verified model/effort/permission-mode controls before each dependent prompt injection. When the
 * gate is off (or no control port is available), the runner does not gate injection and the existing
 * restart-notice path is preserved (no regression).
 */
export type ClaudeUnifiedTuiRuntimeControlOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  featureEnabled: boolean;
  sessionModeEmissionEnabled?: boolean | undefined;
  emitRuntimeConfigOutcome: (event: ClaudeUnifiedRuntimeConfigOutcomeEvent) => void;
  /** Delay before a control-gated prompt injection is retried after a blocked apply. */
  blockedInjectionRetryMs?: number | undefined;
  /**
   * F2 starvation honesty (qa/QA-B.md): fired ONCE per episode when consecutive blocked
   * before-prompt applies cross the bounded threshold — the queued prompt is honestly stuck behind
   * an unsafe TUI window (draft/dialog/overlay) instead of silently re-deferring forever.
   */
  onBlockedApplyStarvation?: ((info: BlockedApplyStarvationInfo) => void) | undefined;
  /** Test seam: blocked-apply starvation threshold override. */
  blockedApplyStarvationThreshold?: number | undefined;
  /** Test seam: inject a prebuilt bridge instead of constructing one from the host control port. */
  createBridge?: (() => ClaudeUnifiedRuntimeControlBridge | null) | undefined;
  /**
   * Lane Y: register the live statusline → lastVerified reconciler with the session-level
   * statusline feed (the statusline applier forwards effective model/effort through it into the
   * controller). Returns an unregister function; the runner unregisters on teardown so a stale
   * bridge never consumes payloads meant for a relaunched host.
   */
  registerStatuslineRuntimeReconciler?: ((
    reconcile: (metadata: ClaudeStatuslineRuntimeMetadata) => void,
  ) => () => void) | undefined;
}>;

const DEFAULT_RUNTIME_CONTROL_BLOCKED_INJECTION_RETRY_MS = 250;

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
  statuslineForwarder?: Readonly<{ port: number; secret: string }> | undefined;
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
    statuslineForwarder: opts.statuslineForwarder,
  });
  const hookSubscription = createReplayableHookSubscription(opts.subscribeClaudeSessionHooks);
  const sessionName = opts.createSessionName?.() ?? createDefaultSessionName();
  let handle: TerminalHostHandle | null = null;
  let controller: ClaudeUnifiedController | null = null;
  let runtimeControlBridge: ClaudeUnifiedRuntimeControlBridge | null = null;
  let unregisterStatuslineRuntimeReconciler: (() => void) | null = null;
  let inFlightSteerWiring: ClaudeUnifiedInFlightSteerWiring<Mode> | null = null;
  let terminalAttachment: NonNullable<Metadata['terminal']> | null = null;
  let removeProcessSignalCleanup: (() => void) | null = null;
  let turnInterruptRegistered = false;
  const runtimeAbortController = new AbortController();
  const processSignalAbortController = new AbortController();
  let fatalRuntimeError: unknown = null;
  let startupHostLivenessGraceActive = true;
  let providerSessionStartedObserved = false;
  let trustedProviderProgressObserved = false;
  let expectedPromptInputExit = false;
  let preHandleProcessSignalCleanupRan = false;
  let concreteHostDisposedByProcessSignal = false;
  const endStartupHostLivenessGrace = (): void => {
    startupHostLivenessGraceActive = false;
  };
  // Startup-readiness gate (Lane N3, incident cmq8y3nlx): no controls or prompt bytes may be
  // typed into the TUI until the SINGLE startup-readiness owner (the readiness bridge's
  // composer-evidence check) reports ready, or the provider provably accepted a prompt. The
  // arbiter's quietness heuristic alone can pass while the TUI is still initializing.
  let startupReadinessObservedForInjection = false;
  const observeStartupReadyForInjection = (): void => {
    startupReadinessObservedForInjection = true;
  };
  const observeTrustedProviderProgress = (): void => {
    trustedProviderProgressObserved = true;
    observeStartupReadyForInjection();
  };
  const observeProviderSessionStarted = (): void => {
    providerSessionStartedObserved = true;
    endStartupHostLivenessGrace();
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

    // Runtime-control integration (Lane E): when the feature gate is on and the host exposes a control
    // port, run verified TUI controls (model/effort/permission/plan mode) before each dependent prompt
    // injection. Gated-off / no-control-port → bridge stays null and injection is never gated (the
    // existing restart-notice path remains the behavior).
    const runtimeControlOptions = opts.tuiRuntimeControl;
    let currentInjectionMode: Mode = startupInput.mode;
    // Lane X (incident cmq8y3nlx): bounded log of texts this runtime wrote into the TUI; the steer
    // evaluator uses it to classify a `user_draft` veto as our own leftover vs a genuine user draft.
    // C11: launchers pass a registry pre-seeded from the persisted prompt store so a RESPAWNED
    // runner also recognizes its predecessor's leftovers.
    // RESUME2 (runner pid 86645, 2026-06-12): controller-TYPED slash commands feed it too — a
    // typed-but-never-submitted `/effort medium` leftover otherwise classifies as a foreign draft
    // and deadlocks idle injection forever.
    const ownComposerTextLog = opts.ownComposerTexts ?? createClaudeOwnComposerTextLog();
    // Controller-typed slash commands produce JSONL `<command-name>…`/`<local-command-stdout>…`
    // user rows; registration-based suppression (L3) keeps them out of the UI transcript while
    // genuine user-typed TUI commands still surface.
    let controlCommandEchoSuppressor: ClaudeUnifiedControlCommandEchoSuppressor | null = null;
    if (runtimeControlOptions?.featureEnabled === true) {
      runtimeControlBridge = runtimeControlOptions.createBridge?.() ?? null;
      if (!runtimeControlBridge) {
        const controlPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
        if (controlPort) {
          const configDir = resolveClaudeConfigRootFromEnv({ ...spawn.spawnEnv }, process.platform);
          const commandEchoSuppressor = createClaudeUnifiedControlCommandEchoSuppressor({
            onSuppressed: opts.onTranscriptMessageSuppressed,
          });
          controlCommandEchoSuppressor = commandEchoSuppressor;
          const tuiController = createClaudeUnifiedTuiControlController({
            port: controlPort,
            featureEnabled: true,
            settingsGuard: createClaudeSettingsGuard({ configDir }),
            onControlCommandTyped: (commandText) => commandEchoSuppressor.recordTypedControlCommand(commandText),
            onControlCommandTextEntered: (commandText) => ownComposerTextLog.record(commandText),
          });
          runtimeControlBridge = createClaudeUnifiedRuntimeControlBridge({
            controller: tuiController,
            emitRuntimeConfigOutcome: runtimeControlOptions.emitRuntimeConfigOutcome,
            ...(runtimeControlOptions.sessionModeEmissionEnabled !== undefined
              ? { sessionModeEmissionEnabled: runtimeControlOptions.sessionModeEmissionEnabled }
              : {}),
            startupMode: startupInput.mode,
          });
        }
      }
      if (runtimeControlBridge && runtimeControlOptions.registerStatuslineRuntimeReconciler) {
        // Lane Y: statusline → lastVerified effective-truth feed. The applier dedups re-emits;
        // here we only hand the live bridge to the session-level statusline feed.
        const bridgeForStatusline = runtimeControlBridge;
        unregisterStatuslineRuntimeReconciler = runtimeControlOptions.registerStatuslineRuntimeReconciler(
          (metadata: ClaudeStatuslineRuntimeMetadata) => bridgeForStatusline.reconcileFromStatusline(metadata),
        );
      }
    }
    const blockedInjectionRetryMs = runtimeControlOptions?.blockedInjectionRetryMs
      ?? DEFAULT_RUNTIME_CONTROL_BLOCKED_INJECTION_RETRY_MS;

    // F2 starvation honesty: one bounded escalation per blocked-apply episode (never a loop).
    const blockedApplyStarvationTracker = createBlockedApplyStarvationTracker({
      threshold: runtimeControlOptions?.blockedApplyStarvationThreshold,
      onStarvation: (info: BlockedApplyStarvationInfo) => runtimeControlOptions?.onBlockedApplyStarvation?.(info),
    });
    // The gate is armed only for the default controller wiring (which constructs the readiness
    // bridge below); a custom `createController` seam owns its own readiness.
    const startupReadinessGateArmed = !opts.createController;
    const inputInjection: TerminalInputInjectionV1 = {
      hostKind: hostResolution.adapter.kind,
      injectUserPrompt: async (input) => {
        if (startupReadinessGateArmed && !startupReadinessObservedForInjection) {
          return {
            status: 'deferred',
            reason: 'pane_initializing',
            retryAfterMs: 250,
          };
        }
        if (runtimeControlBridge) {
          // Apply verified runtime controls before the prompt is written. A blocked apply must NOT inject
          // under the wrong config; returning a `deferred` result hands the message back to the arbiter's
          // existing retry/terminalize machinery (the desired config is re-attempted on the next try).
          // Re-attempts back off exponentially (L5(a)): a fixed short retry hot-looped the apply path
          // when the safe window stayed blocked (incident cmq8y3nlx).
          const apply = await runtimeControlBridge.applyBeforePrompt(currentInjectionMode);
          if (!apply.promptMayProceed) {
            const consecutiveBlockedApplies = blockedApplyStarvationTracker.recordBlocked();
            return {
              status: 'deferred',
              reason: 'terminal_busy',
              retryAfterMs: resolveBlockedApplyRetryMs(consecutiveBlockedApplies, blockedInjectionRetryMs),
            };
          }
          blockedApplyStarvationTracker.reset();
        }
        // Lane X: every text we attempt to write is recorded so a later leftover composer draft
        // can be exact-match classified as OUR OWN residue (vs an untouchable genuine user draft).
        ownComposerTextLog.record(input.text);
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
    const baseInputConsumer = createInputConsumer(first, opts.nextMessage);
    // Track the mode of the most recently pulled batch so the injection gate applies the runtime config
    // desired by the prompt that is about to be injected.
    const inputConsumer: ClaudeUnifiedInputConsumer<Mode> = runtimeControlBridge
      ? {
          async waitForNextInput(consumerOpts) {
            const batch = await baseInputConsumer.waitForNextInput(consumerOpts);
            if (batch) currentInjectionMode = batch.mode;
            return batch;
          },
        }
      : baseInputConsumer;
    controller = await (opts.createController?.({
      hostAdapter: hostResolution.adapter,
      inputInjection,
      inputConsumer,
    }) ?? (() => {
      // Lane X: a dedicated control port for the bounded own-leftover composer clear (Escape on a
      // NON-generating screen only). Separate from the runtime-control controller's port — the
      // evaluator never routes through controller state. Shared with the pre-injection guard below.
      const steerDraftClearPort = hostResolution.adapter.createControlPort?.(activeHandle) ?? null;
      const captureInputStateForGuard = hostResolution.adapter.captureInputState;
      const promptInjector = createClaudeUnifiedPromptInjector<Mode>({
        inputInjection,
        telemetry,
        // C11 (live-proven, runner pid 83791): never type an idle injection next to a leftover
        // composer draft. Own leftovers (respawn-seeded registry) are cleared; anything else
        // defers the injection untouched.
        ...(captureInputStateForGuard && steerDraftClearPort
          ? {
              composerDraftGuard: async () => {
                const result = await clearOwnLeftoverComposerDraft({
                  captureInputState: () => captureInputStateForGuard(activeHandle),
                  sendClearKey: async () => {
                    await steerDraftClearPort.sendSpecialKey('Escape');
                  },
                  ownComposerTexts: ownComposerTextLog,
                });
                const draftLength =
                  'screen' in result ? (result.screen.composerContent?.length ?? 0) : undefined;
                return {
                  status: result.status,
                  ...(result.status === 'cleared' ? { attempts: result.attempts } : {}),
                  ...(draftLength !== undefined ? { draftLength } : {}),
                };
              },
            }
          : {}),
      });
      // In-flight steering (D19, incident cmq8171vw): a `ui_pending` prompt delivered mid-turn is
      // steered into the live TUI when the shared screen-state parser proves the screen is safe
      // (actively generating, no dialog/picker/draft); otherwise it keeps the bounded deferred path.
      // Lane Q: when the runtime-control bridge exists, a mode-carrying pending prompt may have
      // its permission/plan mode applied to the RUNNING turn (verified ShiftTab, probe Q-A) so the
      // text steers instead of deferring to turn end. No bridge -> unchanged refusal/defer behavior.
      const bridgeForInFlightModeApply = runtimeControlBridge;
      const steerWiring = createClaudeUnifiedInFlightSteerEvaluator<Mode>({
        hostAdapter: hostResolution.adapter,
        handle: activeHandle,
        telemetry,
        initialPermissionMode: startupInput.mode.permissionMode,
        onAvailabilitySnapshot: opts.onInFlightSteerAvailabilitySnapshot,
        ownComposerTexts: ownComposerTextLog,
        ...(steerDraftClearPort
          ? {
              clearOwnLeftoverDraft: async () => {
                await steerDraftClearPort.sendSpecialKey('Escape');
              },
            }
          : {}),
        onUserDraftStarvation: opts.onInFlightSteerUserDraftStarvation,
        ...(bridgeForInFlightModeApply
          ? {
              applyPermissionModeDeltaInFlight: (mode: Mode) =>
                bridgeForInFlightModeApply.applyPermissionModeForInFlightSteer(mode),
            }
          : {}),
      });
      inFlightSteerWiring = steerWiring;
      const arbiter = createClaudeUnifiedInputArbiter<Mode>({
        injectPrompt: promptInjector.injectPrompt,
        injectionRetryLimit: configuration.claudeUnifiedTerminalInjectionRetryLimit,
        injectionRetryBaseDelayMs: configuration.claudeUnifiedTerminalInjectionRetryBaseDelayMs,
        providerAcceptanceTimeoutMs:
          opts.providerAcceptanceTimeoutMs ??
          configuration.claudeUnifiedTerminalProviderAcceptanceTimeoutMs,
        evaluateInFlightSteer: steerWiring.evaluateInFlightSteer,
        onSteerAcceptanceArmed: steerWiring.onSteerAcceptanceArmed,
        isCanonicalTurnActive: opts.isCanonicalTurnActive,
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
          steerWiring.observeInjectedPrompt(batch, acceptance);
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
        observeTrustedProviderProgress();
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
        // A batch pulled during the death/dispose unwind must be returned to the
        // owner's queue, never silently dropped into a dead session.
        onUndeliverableBatch: (batch) => {
          opts.returnUnconsumedMessage?.({ message: batch.message, mode: batch.mode });
        },
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
            onProviderPromptSubmitMetadata: runtimeControlBridge
              ? (metadata) => runtimeControlBridge?.reconcileFromPromptSubmitMetadata(metadata)
              : undefined,
            onProviderSessionStarted: observeProviderSessionStarted,
            onTrustedProviderProgress: observeTrustedProviderProgress,
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
            onMessage: opts.onMessage
              ? (message) => {
                  if (controlCommandEchoSuppressor?.shouldSuppressTranscriptMessage(message)) return;
                  opts.onMessage?.(message);
                }
              : undefined,
            onTranscriptMessage: (message) => {
              if (!confirmPromptAcceptedFromTranscript([message])) {
                confirmCompactBoundaryPromptAcceptedFromTranscript(message);
              }
              lifecycleBridge?.observeTranscript(message);
            },
            onSessionFound: opts.onSessionFound,
            loadCommittedClaudeJsonlMessageBaseline: opts.loadCommittedClaudeJsonlMessageBaseline,
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
            extendedTimeoutMs: configuration.claudeUnifiedTerminalStartupReadinessExtendedTimeoutMs,
            progressGraceMs: configuration.claudeUnifiedTerminalStartupReadinessProgressGraceMs,
            onStartupReady: () => {
              observeStartupReadyForInjection();
              endStartupHostLivenessGrace();
            },
            hasTrustedProviderProgress: () => trustedProviderProgressObserved,
            // SessionStart proves the host process is ALIVE (D17). It does not prove the interactive
            // composer is ready, so it extends the startup window instead of standing it down — a
            // slow-but-alive fresh session must not be killed before injection.
            hasHostAliveEvidence: () => providerSessionStartedObserved,
            canReportStartupReady: () => (
              allowEmptyStartupInputBeforeSessionStart
              || allowReadinessBeforeSessionStart
              || !opts.subscribeClaudeSessionHooks
              || Boolean(opts.sessionId || opts.transcriptPath)
              || providerSessionStartedObserved
            ),
            emitOutputReadiness: true,
          }),
          createClaudeUnifiedHostLivenessBridge({
            hostAdapter: hostResolution.adapter,
            handle: activeHandle,
            telemetry,
            pollIntervalMs: configuration.claudeUnifiedTerminalHostLivenessPollMs,
            probeFailureConfirmDeadMs: opts.hostLivenessProbeFailureConfirmDeadMs,
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
    unregisterStatuslineRuntimeReconciler?.();
    if (runtimeControlBridge) {
      await runtimeControlBridge.dispose().catch((error) => {
        logger.debug('[unified]: failed to dispose Claude unified runtime-control bridge (non-fatal)', error);
      });
    }
    inFlightSteerWiring?.dispose();
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
