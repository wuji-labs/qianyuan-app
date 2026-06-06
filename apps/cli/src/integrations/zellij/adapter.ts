import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostLiveness,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from '../terminalHost/_types';
import {
  defaultZellijActions,
  DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
  isZellijActionTimeoutError,
  type ZellijCommandResult,
  type ZellijActions,
  type ZellijDetachedCommandHandle,
  type ZellijPane,
} from './actions';
import { prepareZellijSocketDir, resolveZellijSocketDir } from './socketDir';

const DEFAULT_INPUT_STABILITY_DELAY_MS = 50;
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS = 50;

export type ZellijForegroundClientLaunchParams = Readonly<{
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  cwd?: string;
  defaultShell?: string;
  timeoutMs: number;
}>;

export type ZellijLaunchStrategy =
  | Readonly<{ type: 'background' }>
  | Readonly<{
    type: 'foregroundAttached';
    launchClient(params: ZellijForegroundClientLaunchParams): Promise<void>;
  }>;

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sessionEnv(baseEnv: Readonly<Record<string, string>>, sessionName: string): Readonly<Record<string, string>> {
  return {
    ...baseEnv,
    ZELLIJ_SESSION_NAME: sessionName,
  };
}

function resolvePaneId(pane: ZellijPane): string | null {
  const value = pane.pane_id ?? pane.id;
  if (value === undefined || value === null) return null;
  return String(value);
}

function resolvePaneIdFromRunOutput(stdout: string): string | null {
  const value = stdout.trim();
  return /^(?:terminal_)?\d+$/.test(value) ? value : null;
}

function resolveLaunchedTerminalPaneId(params: Readonly<{
  paneIdFromRun: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  panes: readonly ZellijPane[];
}>): string | null {
  const paneIdFromRun = params.paneIdFromRun;
  if (paneIdFromRun !== null) {
    const matchingPane = params.panes.find((pane) => terminalPaneMatches(pane, paneIdFromRun));
    const normalizedPaneId = normalizePaneActionId(paneIdFromRun);
    if (
      matchingPane
      && isTerminalPaneAlive(matchingPane)
      && !isBootstrapTerminalPane(matchingPane, normalizedPaneId, params.preExistingPaneIds)
    ) {
      return normalizedPaneId;
    }
  }

  const liveTerminalPanes = params.panes.filter((pane) => {
    const paneId = resolveTerminalPaneActionId(pane);
    return paneId !== null && isTerminalPaneAlive(pane) && !isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds);
  });
  if (liveTerminalPanes.length === 1) {
    const paneId = resolveTerminalPaneActionId(liveTerminalPanes[0]);
    if (paneId !== null) return paneId;
  }

  return null;
}

function normalizePaneActionId(paneId: string): string {
  return paneId.startsWith('terminal_') ? paneId : `terminal_${paneId}`;
}

function resolveTerminalPaneActionId(pane: ZellijPane): string | null {
  if (pane.is_plugin) return null;
  const paneId = resolvePaneId(pane);
  return paneId === null ? null : normalizePaneActionId(paneId);
}

function isBootstrapTerminalPane(pane: ZellijPane, paneId: string, preExistingPaneIds: ReadonlySet<string>): boolean {
  return preExistingPaneIds.has(paneId) || pane.terminal_command === null;
}

function paneMatches(pane: ZellijPane, paneId: string): boolean {
  const resolvedPaneId = resolvePaneId(pane);
  return resolvedPaneId === paneId || (resolvedPaneId !== null && `terminal_${resolvedPaneId}` === paneId);
}

function terminalPaneMatches(pane: ZellijPane, paneId: string): boolean {
  return !pane.is_plugin && paneMatches(pane, paneId);
}

function isTerminalPaneAlive(pane: ZellijPane): boolean {
  if (pane.exited === true) return false;
  if (pane.is_held === true) return false;
  return true;
}

function resolvePaneExitStatus(pane: ZellijPane | undefined): number | undefined {
  const value = pane?.exit_status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scheduledDeferral(input: TerminalPromptInput): Extract<TerminalInputInjectionResult, { status: 'deferred' }> | null {
  const reason = input.scheduling.deferReason;
  if (!reason) return null;
  return {
    status: 'deferred',
    reason,
    ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
  };
}

function failedInjectionResult(params: Readonly<{
  reason: Extract<TerminalInputInjectionResult, { status: 'failed' }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  recoverable: boolean;
}>): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    recoverable: params.recoverable,
  };
}

function createDeadline(timeoutMs: number | undefined): number | undefined {
  return timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
}

function remainingTimeoutMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
}

function isZellijMissingSessionOutput(output: string, sessionName: string): boolean {
  const normalizedOutput = output.toLowerCase();
  const normalizedSessionName = sessionName.toLowerCase();
  return normalizedOutput.includes(`no session named "${normalizedSessionName}" found`);
}

async function killZellijSessionOrThrow(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  const result = await params.actions.killSession({
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    timeoutMs: params.actionTimeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`zellij kill-session failed: ${result.stderr || result.stdout}`);
  }
}

async function disposeZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  const result = await params.actions.killSession({
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    timeoutMs: params.actionTimeoutMs,
  });
  if (result.exitCode === 0) return;

  const output = `${result.stderr}\n${result.stdout}`;
  if (isZellijMissingSessionOutput(output, params.sessionName)) return;

  throw new Error(`zellij kill-session failed: ${result.stderr || result.stdout}`);
}

async function cleanupZellijSessionAndRethrowStartupError(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
  error: unknown;
}>): Promise<never> {
  try {
    await killZellijSessionOrThrow({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      sessionName: params.sessionName,
      actionTimeoutMs: params.actionTimeoutMs,
    });
  } catch (cleanupError) {
    const startupMessage = params.error instanceof Error ? params.error.message : String(params.error);
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`zellij startup failed: ${startupMessage}; cleanup failed: ${cleanupMessage}`);
  }
  throw params.error;
}

async function closePaneIfStillPresent(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  try {
    await params.actions.closePane({
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      timeoutMs: params.actionTimeoutMs,
    });
  } catch (error) {
    const panes = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: params.env,
      timeoutMs: params.actionTimeoutMs,
    }).catch(() => null);
    if (panes !== null && !panes.some((pane) => terminalPaneMatches(pane, params.paneId))) {
      return;
    }
    throw error;
  }
}

async function closeBootstrapTerminalPanes(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  panesAfterLaunch: readonly ZellijPane[];
  actionTimeoutMs: number;
}>): Promise<Set<string>> {
  const activePaneId = params.paneId ? normalizePaneActionId(params.paneId) : null;
  const paneIdsToClose = new Set<string>();
  for (const pane of params.panesAfterLaunch) {
    const paneId = resolveTerminalPaneActionId(pane);
    if (
      paneId === null
      || paneId === activePaneId
      || !isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds)
    ) {
      continue;
    }
    paneIdsToClose.add(paneId);
  }
  for (const paneId of paneIdsToClose) {
    await closePaneIfStillPresent({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId,
      actionTimeoutMs: params.actionTimeoutMs,
    });
  }
  return paneIdsToClose;
}

function resolveBootstrapTerminalPaneIds(params: Readonly<{
  paneId: string;
  preExistingPaneIds: ReadonlySet<string>;
  panes: readonly ZellijPane[];
}>): Set<string> {
  const activePaneId = normalizePaneActionId(params.paneId);
  const bootstrapPaneIds = new Set<string>();
  for (const pane of params.panes) {
    const paneId = resolveTerminalPaneActionId(pane);
    if (
      paneId !== null
      && paneId !== activePaneId
      && isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds)
    ) {
      bootstrapPaneIds.add(paneId);
    }
  }
  return bootstrapPaneIds;
}

async function closeBootstrapTerminalPanesUntilStable(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  preExistingPaneIds: ReadonlySet<string>;
  initialPanes: readonly ZellijPane[];
  actionTimeoutMs: number;
}>): Promise<void> {
  const deadline = createDeadline(params.actionTimeoutMs);
  let panesAfterLaunch = params.initialPanes;
  while (true) {
    const remainingMs = remainingTimeoutMs(deadline);
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new Error('zellij bootstrap pane cleanup did not converge');
    }
    await closeBootstrapTerminalPanes({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      preExistingPaneIds: params.preExistingPaneIds,
      panesAfterLaunch,
      actionTimeoutMs: params.actionTimeoutMs,
    });
    const listTimeoutMs = remainingTimeoutMs(deadline);
    if (listTimeoutMs !== undefined && listTimeoutMs <= 0) {
      throw new Error('zellij bootstrap pane cleanup did not converge');
    }
    panesAfterLaunch = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: params.env,
      timeoutMs: listTimeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, listTimeoutMs),
    });
    const remainingBootstrapPaneIds = resolveBootstrapTerminalPaneIds({
      paneId: params.paneId,
      preExistingPaneIds: params.preExistingPaneIds,
      panes: panesAfterLaunch,
    });
    if (remainingBootstrapPaneIds.size === 0) return;
    const waitMs = remainingTimeoutMs(deadline);
    if (waitMs !== undefined && waitMs <= 0) {
      throw new Error('zellij bootstrap pane cleanup did not converge');
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, waitMs ?? DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS));
  }
}

async function waitForLaunchedTerminalPane(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  paneIdFromRun: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  actionTimeoutMs: number;
}>): Promise<{ paneId: string; panes: readonly ZellijPane[] }> {
  const deadline = createDeadline(params.actionTimeoutMs);
  while (true) {
    const timeoutMs = remainingTimeoutMs(deadline);
    const panes = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(params.env, params.sessionName),
      timeoutMs: timeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, timeoutMs),
    });
    const paneId = resolveLaunchedTerminalPaneId({
      paneIdFromRun: params.paneIdFromRun,
      panes,
      preExistingPaneIds: params.preExistingPaneIds,
    });
    if (paneId !== null) return { paneId, panes };

    const remainingMs = remainingTimeoutMs(deadline);
    if (remainingMs === undefined || remainingMs <= 0) {
      throw new Error('zellij launch produced no terminal target pane');
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, remainingMs));
  }
}

async function waitForAddressableZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<readonly ZellijPane[]> {
  const deadline = createDeadline(params.actionTimeoutMs);
  let lastError: unknown;
  while (true) {
    const timeoutMs = remainingTimeoutMs(deadline);
    try {
      return await params.actions.listPanes({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(params.env, params.sessionName),
        timeoutMs: timeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, timeoutMs),
      });
    } catch (error) {
      lastError = error;
    }

    const remainingMs = remainingTimeoutMs(deadline);
    if (remainingMs === undefined || remainingMs <= 0) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
      throw new Error(`zellij session did not become addressable: ${message}`);
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, remainingMs));
  }
}

export function createZellijTerminalHostAdapter(params: Readonly<{
  zellijBinary: string;
  happyHomeDir: string;
  defaultShell?: string | undefined;
  actions?: ZellijActions;
  launchStrategy?: ZellijLaunchStrategy;
  chunkSize?: number;
  inputStabilityDelayMs?: number;
  actionTimeoutMs?: number;
  prepareSocketDir?: ((socketDir: string) => Promise<void>) | undefined;
}>): TerminalHostAdapter {
  const actions = params.actions ?? defaultZellijActions;
  const prepareSocketDir = params.prepareSocketDir ?? prepareZellijSocketDir;
  const actionTimeoutMs = Math.max(1, Math.trunc(params.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS));
  const env: Readonly<Record<string, string>> = {
    ZELLIJ_SOCKET_DIR: resolveZellijSocketDir(params.happyHomeDir),
  };

  async function evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLiveness> {
    const observedAt = Date.now();
    if (!handle.paneId) return { paneAlive: false, paneDead: true, observedAt };
    const panes = await actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      timeoutMs: actionTimeoutMs,
    });
    const pane = panes.find((candidate) => terminalPaneMatches(candidate, handle.paneId ?? ''));
    const paneAlive = Boolean(pane && isTerminalPaneAlive(pane));
    const paneExitStatus = resolvePaneExitStatus(pane);
    return {
      paneAlive,
      paneDead: !paneAlive,
      ...(pane?.terminal_command ? { paneCurrentCommand: pane.terminal_command } : {}),
      ...(paneExitStatus !== undefined ? { paneExitStatus } : {}),
      observedAt,
    };
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    if (!handle.paneId) return { stable: false, currentInput: '', observedAt: Date.now() };
    const firstInput = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      paneId: handle.paneId,
      timeoutMs: actionTimeoutMs,
    });
    await wait(Math.max(0, Math.trunc(params.inputStabilityDelayMs ?? DEFAULT_INPUT_STABILITY_DELAY_MS)));
    const currentInput = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      paneId: handle.paneId,
      timeoutMs: actionTimeoutMs,
    });
    return { stable: firstInput === currentInput, currentInput, observedAt: Date.now() };
  }

  return {
    kind: 'zellij',
    async createOrAttachHost(opts) {
      await prepareSocketDir(env.ZELLIJ_SOCKET_DIR);
      const launchStrategy = params.launchStrategy ?? { type: 'background' };
      try {
        if (launchStrategy.type === 'background') {
          const result = await actions.attachCreateBackground({
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            cwd: opts.workingDirectory,
            ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
            timeoutMs: actionTimeoutMs,
          });
          if (result.exitCode !== 0) {
            return cleanupZellijSessionAndRethrowStartupError({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: opts.sessionName,
              actionTimeoutMs,
              error: new Error(`zellij attach failed: ${result.stderr || result.stdout}`),
            });
          }
        } else {
          await launchStrategy.launchClient({
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            cwd: opts.workingDirectory,
            ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
            timeoutMs: actionTimeoutMs,
          });
        }
      } catch (error) {
        return cleanupZellijSessionAndRethrowStartupError({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: opts.sessionName,
          actionTimeoutMs,
          error,
        });
      }
      let preExistingPaneIds: ReadonlySet<string>;
      try {
        preExistingPaneIds = new Set(
          (await waitForAddressableZellijSession({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            actionTimeoutMs,
          })).flatMap((pane) => {
            const paneId = resolveTerminalPaneActionId(pane);
            return paneId === null ? [] : [paneId];
          }),
        );
      } catch (error) {
        return cleanupZellijSessionAndRethrowStartupError({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: opts.sessionName,
          actionTimeoutMs,
          error,
        });
      }
      let paneId: string | null;
      try {
        let paneIdFromRun: string | null = null;
        let detachedCommandHandle: ZellijDetachedCommandHandle | null = null;
        if (launchStrategy.type === 'background') {
          let runResult: ZellijCommandResult;
          try {
            runResult = await actions.runCommand({
              zellijBinary: params.zellijBinary,
              env: {
                ...env,
                ...opts.spawnEnv,
              },
              sessionName: opts.sessionName,
              cwd: opts.workingDirectory,
              command: opts.spawnArgv,
              timeoutMs: actionTimeoutMs,
            });
          } catch (error) {
            return cleanupZellijSessionAndRethrowStartupError({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: opts.sessionName,
              actionTimeoutMs,
              error,
            });
          }
          if (runResult.exitCode !== 0) {
            return cleanupZellijSessionAndRethrowStartupError({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: opts.sessionName,
              actionTimeoutMs,
              error: new Error(`zellij run failed: ${runResult.stderr || runResult.stdout}`),
            });
          }
          paneIdFromRun = resolvePaneIdFromRunOutput(runResult.stdout);
        } else {
          if (!actions.startCommandDetached) {
            throw new Error('zellij detached command launcher is unavailable');
          }
          detachedCommandHandle = await actions.startCommandDetached({
            zellijBinary: params.zellijBinary,
            env: {
              ...env,
              ...opts.spawnEnv,
            },
            sessionName: opts.sessionName,
            cwd: opts.workingDirectory,
            command: opts.spawnArgv,
            timeoutMs: actionTimeoutMs,
          });
        }
        let launchedPane: { paneId: string; panes: readonly ZellijPane[] };
        try {
          launchedPane = await waitForLaunchedTerminalPane({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: opts.sessionName,
            paneIdFromRun,
            preExistingPaneIds,
            actionTimeoutMs,
          });
        } finally {
          detachedCommandHandle?.dispose();
        }
        paneId = launchedPane.paneId;
        await closeBootstrapTerminalPanesUntilStable({
          actions,
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, opts.sessionName),
          paneId,
          preExistingPaneIds,
          initialPanes: launchedPane.panes,
          actionTimeoutMs,
        });
      } catch (error) {
        return cleanupZellijSessionAndRethrowStartupError({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: opts.sessionName,
          actionTimeoutMs,
          error,
        });
      }
      return {
        kind: 'zellij',
        sessionName: opts.sessionName,
        ...(paneId ? { paneId } : {}),
        socketDir: env.ZELLIJ_SOCKET_DIR,
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      };
    },
    async injectUserPrompt(handle: TerminalHostHandle, input: TerminalPromptInput): Promise<TerminalInputInjectionResult> {
      const deferral = scheduledDeferral(input);
      if (deferral) return deferral;

      if (!handle.paneId) {
        return failedInjectionResult({
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
        });
      }
      const paneId = handle.paneId;

      let liveness: TerminalHostLiveness;
      try {
        liveness = await evaluateLiveness(handle);
      } catch {
        return failedInjectionResult({
          reason: 'host_unreachable',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
        });
      }
      if (!liveness.paneAlive) {
        return failedInjectionResult({
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: false,
        });
      }

      if (input.scheduling.deferredUntilQuietMs !== undefined && input.scheduling.deferredUntilQuietMs > 0) {
        let inputState: TerminalInputState;
        try {
          inputState = await captureInputState(handle);
        } catch {
          return failedInjectionResult({
            reason: 'host_unreachable',
            phase: 'readiness',
            duplicateRisk: 'none',
            recoverable: true,
          });
        }
        if (!inputState.stable) {
          return {
            status: 'deferred',
            reason: 'user_typing',
            retryAfterMs: input.scheduling.deferredUntilQuietMs,
          };
        }
      }

      const injectionTimeoutMs = input.scheduling.timeoutMs ?? actionTimeoutMs;
      const deadline = createDeadline(injectionTimeoutMs);
      let failurePhase: TerminalInjectionFailurePhase = 'during_write';
      let duplicateRisk: TerminalInjectionDuplicateRisk = 'possible';
      try {
        await actions.writeBytesChunked({
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, handle.sessionName),
          paneId,
          text: input.text,
          chunkSize: params.chunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
          timeoutMs: injectionTimeoutMs,
        });
        failurePhase = 'after_write_before_enter';
        const submitTimeoutMs = remainingTimeoutMs(deadline);
        if (submitTimeoutMs === 0) {
          return failedInjectionResult({
            reason: 'timeout',
            phase: failurePhase,
            duplicateRisk,
            recoverable: true,
          });
        }
        failurePhase = 'after_enter_unknown';
        duplicateRisk = 'likely';
        await actions.sendEnter({
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, handle.sessionName),
          paneId,
          ...(submitTimeoutMs !== undefined ? { timeoutMs: submitTimeoutMs } : {}),
        });
        return { status: 'injected', at: Date.now(), bytesWritten: Buffer.byteLength(input.text) };
      } catch (error) {
        return failedInjectionResult({
          reason: isZellijActionTimeoutError(error) ? 'timeout' : 'host_unreachable',
          phase: failurePhase,
          duplicateRisk,
          recoverable: true,
        });
      }
    },
    async interruptTurn(handle: TerminalHostHandle): Promise<void> {
      if (!handle.paneId) {
        throw new Error('Cannot interrupt zellij terminal host without a pane id');
      }
      await actions.sendEscape({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(env, handle.sessionName),
        paneId: handle.paneId,
        timeoutMs: actionTimeoutMs,
      });
    },
    evaluateLiveness,
    captureInputState,
    async dispose(handle: TerminalHostHandle): Promise<void> {
      await disposeZellijSession({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: handle.sessionName,
        actionTimeoutMs,
      });
    },
  };
}
