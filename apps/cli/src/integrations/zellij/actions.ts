import { spawn } from 'child_process';
import type { StdioOptions } from 'child_process';

import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';

export type ZellijCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

export class ZellijActionTimeoutError extends Error {
  constructor(action: string) {
    super(`zellij ${action} timed out`);
    this.name = 'ZellijActionTimeoutError';
  }
}

export function isZellijActionTimeoutError(error: unknown): error is ZellijActionTimeoutError {
  return error instanceof ZellijActionTimeoutError;
}

export type ZellijPane = Readonly<{
  id?: number | string;
  pane_id?: number | string;
  is_plugin?: boolean;
  is_focused?: boolean;
  is_suppressed?: boolean;
  is_held?: boolean;
  terminal_command?: string | null;
  exited?: boolean;
  exit_status?: number | null;
}>;

export type ZellijActionParams = Readonly<{
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
}>;

export type ZellijPaneActionParams = ZellijActionParams & Readonly<{ paneId: string }>;
export type ZellijTimeoutParams = Readonly<{ timeoutMs?: number }>;
export type ZellijRunCommandParams = ZellijActionParams & Readonly<{
  sessionName: string;
  cwd?: string;
  command: readonly string[];
}>;
export type ZellijDetachedCommandHandle = Readonly<{
  pid?: number;
  dispose(): void;
}>;

export type ZellijActions = Readonly<{
  attachCreateBackground(params: ZellijActionParams & Readonly<{
    sessionName: string;
    cwd?: string;
    defaultShell?: string;
  }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  runCommand(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  startCommandDetached?(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijDetachedCommandHandle>;
  writeBytesChunked(params: ZellijPaneActionParams & Readonly<{ text: string; chunkSize?: number; timeoutMs?: number }>): Promise<void>;
  sendEnter(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void>;
  sendEscape(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void>;
  closePane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
  listSessions?(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  listPanes(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijPane[]>;
  dumpScreen(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<string>;
  killSession(params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
}>;

export type ZellijAttachActions = Readonly<{
  attachForeground(params: ZellijActionParams & Readonly<{ sessionName: string }>): Promise<ZellijCommandResult>;
  focusPane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
}>;

export const DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE = 4096;

const ZELLIJ_HOST_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'ComSpec',
]);
const ZELLIJ_TIMEOUT_KILL_GRACE_MS = 250;

function buildZellijProcessEnv(env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && isAllowedExactEnvKey(key, ZELLIJ_HOST_ENV_KEYS)) {
      base[key] = value;
    }
  }
  return { ...base, ...env };
}

function runZellij(
  params: ZellijActionParams,
  args: readonly string[],
  options?: Readonly<{ cwd?: string; timeoutMs?: number; action?: string; stdio?: StdioOptions; windowsHide?: boolean }>,
): Promise<ZellijCommandResult> {
  return new Promise((resolve, reject) => {
    const stdio = options?.stdio ?? ['ignore', 'pipe', 'pipe'];
    const child = spawn(params.zellijBinary, [...args], {
      cwd: options?.cwd,
      env: buildZellijProcessEnv(params.env),
      shell: false,
      stdio,
      windowsHide: options?.windowsHide ?? true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutKillGrace: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new ZellijActionTimeoutError(options?.action ?? args[0] ?? 'command');
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (timeoutKillGrace !== undefined) clearTimeout(timeoutKillGrace);
      callback();
    };
    timeout = options?.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
          timeoutKillGrace = setTimeout(() => {
            finish(() => reject(timeoutError()));
          }, ZELLIJ_TIMEOUT_KILL_GRACE_MS);
          timeoutKillGrace.unref?.();
        }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(timedOut ? timeoutError() : error)));
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          reject(timeoutError());
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  });
}

function runZellijForeground(
  params: ZellijActionParams,
  args: readonly string[],
): Promise<ZellijCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.zellijBinary, [...args], {
      env: buildZellijProcessEnv(params.env),
      shell: false,
      stdio: 'inherit',
      windowsHide: false,
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => resolve({ exitCode: code ?? 1, stdout: '', stderr: '' }));
    });
  });
}

function buildRunCommandArgs(params: ZellijRunCommandParams): string[] {
  const args = ['-s', params.sessionName, 'run'];
  if (params.cwd) {
    args.push('--cwd', params.cwd);
  }
  args.push('--', ...params.command);
  return args;
}

function splitByteChunks(text: string, chunkSize: number): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) return [];
  const normalizedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += normalizedChunkSize) {
    chunks.push(bytes.subarray(offset, offset + normalizedChunkSize));
  }
  return chunks;
}

async function requireSuccess(result: ZellijCommandResult, action: string): Promise<void> {
  if (result.exitCode !== 0) {
    throw new Error(`zellij ${action} failed: ${result.stderr || result.stdout}`);
  }
}

function createDeadline(timeoutMs: number | undefined): number | undefined {
  return timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
}

function remainingTimeoutMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
}

export async function attachCreateBackground(
  params: ZellijActionParams & Readonly<{ sessionName: string; cwd?: string; defaultShell?: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  const args = ['attach', '--create-background', params.sessionName];
  if (params.cwd || params.defaultShell) {
    args.push('options');
    if (params.cwd) {
      args.push('--default-cwd', params.cwd);
    }
    if (params.defaultShell) {
      args.push('--default-shell', params.defaultShell);
    }
  }
  return runZellij(
    params,
    args,
    params.timeoutMs !== undefined
      ? {
          cwd: params.cwd,
          timeoutMs: params.timeoutMs,
          action: 'attach',
          ...(process.platform === 'win32' ? { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true } : {}),
        }
      : {
          cwd: params.cwd,
          action: 'attach',
          ...(process.platform === 'win32' ? { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true } : {}),
        },
  );
}

export async function attachForeground(
  params: ZellijActionParams & Readonly<{ sessionName: string }>,
): Promise<ZellijCommandResult> {
  return runZellijForeground(params, ['attach', params.sessionName]);
}

export async function runCommand(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijCommandResult> {
  const args = buildRunCommandArgs(params);
  return runZellij(
    params,
    args,
    params.timeoutMs !== undefined
      ? { cwd: params.cwd, timeoutMs: params.timeoutMs, action: 'run' }
      : { cwd: params.cwd, action: 'run' },
  );
}

export async function startCommandDetached(params: ZellijRunCommandParams & ZellijTimeoutParams): Promise<ZellijDetachedCommandHandle> {
  const args = buildRunCommandArgs(params);
  return await new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    const child = spawn(params.zellijBinary, args, {
      cwd: params.cwd,
      env: buildZellijProcessEnv(params.env),
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.once('close', () => {
      closed = true;
    });
    child.once('error', (error) => {
      closed = true;
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    const handle: ZellijDetachedCommandHandle = {
      ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
      dispose: () => {
        if (!closed && !child.killed) {
          child.kill();
        }
      },
    };
    queueMicrotask(() => {
      if (!settled) {
        settled = true;
        resolve(handle);
      }
    });
  });
}

export async function writeBytesChunked(params: ZellijPaneActionParams & Readonly<{
  text: string;
  chunkSize?: number;
  timeoutMs?: number;
}>): Promise<void> {
  const chunkSize = params.chunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE;
  const deadline = createDeadline(params.timeoutMs);
  for (const chunk of splitByteChunks(params.text, chunkSize)) {
    const timeoutMs = remainingTimeoutMs(deadline);
    if (timeoutMs === 0) throw new ZellijActionTimeoutError('write');
    await requireSuccess(
      await runZellij(
        params,
        ['action', 'write', '--pane-id', params.paneId, ...[...chunk].map(String)],
        timeoutMs !== undefined ? { timeoutMs, action: 'write' } : { action: 'write' },
      ),
      'write',
    );
  }
}

export async function sendEnter(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void> {
  if (params.timeoutMs === 0) throw new ZellijActionTimeoutError('send-keys');
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'send-keys', '--pane-id', params.paneId, 'Enter'],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'send-keys' } : { action: 'send-keys' },
    ),
    'send-keys',
  );
}

export async function sendEscape(params: ZellijPaneActionParams & Readonly<{ timeoutMs?: number }>): Promise<void> {
  if (params.timeoutMs === 0) throw new ZellijActionTimeoutError('send-keys');
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'send-keys', '--pane-id', params.paneId, 'Esc'],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'send-keys' } : { action: 'send-keys' },
    ),
    'send-keys',
  );
}

export async function focusPane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'focus-pane-id', params.paneId],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'focus-pane-id' } : { action: 'focus-pane-id' },
    ),
    'focus-pane-id',
  );
}

export async function closePane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(
    await runZellij(
      params,
      ['action', 'close-pane', '--pane-id', params.paneId],
      params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'close-pane' } : { action: 'close-pane' },
    ),
    'close-pane',
  );
}

export async function listSessions(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijCommandResult> {
  return runZellij(
    params,
    ['list-sessions'],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'list-sessions' } : { action: 'list-sessions' },
  );
}

export async function listPanes(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijPane[]> {
  const result = await runZellij(
    params,
    ['action', 'list-panes', '--json'],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'list-panes' } : { action: 'list-panes' },
  );
  await requireSuccess(result, 'list-panes');
  const parsed: unknown = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed.filter((pane): pane is ZellijPane => typeof pane === 'object' && pane !== null) : [];
}

export async function dumpScreen(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<string> {
  const result = await runZellij(
    params,
    ['action', 'dump-screen', '--pane-id', params.paneId],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'dump-screen' } : { action: 'dump-screen' },
  );
  await requireSuccess(result, 'dump-screen');
  return result.stdout;
}

export async function killSession(
  params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  return runZellij(
    params,
    ['kill-session', params.sessionName],
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, action: 'kill-session' } : { action: 'kill-session' },
  );
}

export const defaultZellijActions: ZellijActions = {
  attachCreateBackground,
  runCommand,
  startCommandDetached,
  writeBytesChunked,
  sendEnter,
  sendEscape,
  closePane,
  listSessions,
  listPanes,
  dumpScreen,
  killSession,
};

export const defaultZellijAttachActions: ZellijAttachActions = {
  attachForeground,
  focusPane,
};
