import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Platform-specific health signals for an installed background service.
 *
 * Primary motivation: detect crash loops. A service configured with
 * KeepAlive=SuccessfulExit:false respawns indefinitely on non-zero exit,
 * which shows up to users as "stopped · auto-starts on boot" even though
 * launchd is actively firing it 10+ times a minute. Reading runs count +
 * last exit code from `launchctl print` turns this into actionable output.
 *
 * Log tailing: the last non-empty error line is almost always enough to
 * diagnose the crash; we pattern-match a few known causes (manual-daemon
 * conflict, port already in use) so the finding can recommend a targeted
 * fix instead of just showing raw text.
 */
export type ServiceHealthSignal = Readonly<{
  /** How many times launchd has tried to start the service. */
  runs: number | null;
  /** Most recent exit code. 0 = clean, non-zero = fault. */
  lastExitCode: number | null;
  /** True when we believe launchd is actively retrying. */
  isCrashLooping: boolean;
  /** Last non-empty line of stderr (truncated to ~200 chars). */
  lastErrorLine: string | null;
  /** Pattern-matched cause, if recognised. */
  suspectedCause: SuspectedCause;
  /**
   * For `suspectedCause === 'conflicting_manual_daemon'`, the pid we parsed
   * from the error line (if present). Used by the dispatcher to offer a
   * targeted "stop pid X" action.
   */
  conflictingManualDaemonPid: number | null;
}>;

export type SuspectedCause =
  | 'conflicting_manual_daemon'
  | 'port_in_use'
  | 'auth_missing'
  | 'unknown';

const CRASH_LOOP_RUNS_THRESHOLD = 5;
const ERROR_LINE_MAX_LEN = 200;

export function readBackgroundServiceHealth(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  errLogPath: string | null;
}>): ServiceHealthSignal {
  const launchctlOutput = params.platform === 'darwin' && params.uid != null
    ? tryReadLaunchctl(params.uid, params.label)
    : '';
  const { runs, lastExitCode } = parseLaunchctlFields(launchctlOutput);

  const lastErrorLine = params.errLogPath ? readLastNonEmptyErrorLine(params.errLogPath) : null;
  const { suspectedCause, conflictingManualDaemonPid } = classifyErrorLine(lastErrorLine);

  const isCrashLooping = (runs !== null && runs >= CRASH_LOOP_RUNS_THRESHOLD)
    && (lastExitCode !== null && lastExitCode !== 0);

  return {
    runs,
    lastExitCode,
    isCrashLooping,
    lastErrorLine,
    suspectedCause,
    conflictingManualDaemonPid,
  };
}

function tryReadLaunchctl(uid: number, label: string): string {
  try {
    const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], {
      encoding: 'utf-8',
      timeout: 2_000,
    });
    if (result.status !== 0) return '';
    return String(result.stdout ?? '');
  } catch {
    return '';
  }
}

function parseLaunchctlFields(output: string): { runs: number | null; lastExitCode: number | null } {
  if (!output) return { runs: null, lastExitCode: null };
  const runsMatch = output.match(/^\s*runs\s*=\s*(\d+)/m);
  const exitMatch = output.match(/^\s*last exit code\s*=\s*(-?\d+)/m);
  return {
    runs: runsMatch ? Number(runsMatch[1]) : null,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
  };
}

function readLastNonEmptyErrorLine(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    // Don't try to read huge logs entirely — seek to last 16KB.
    const readSize = Math.min(stats.size, 16 * 1024);
    const fd = require('node:fs').openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      require('node:fs').readSync(fd, buf, 0, readSize, Math.max(0, stats.size - readSize));
      const text = buf.toString('utf-8');
      const lines = text.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        // Skip standard Node DeprecationWarning footer noise so we land on
        // the actual error message above it.
        if (line.startsWith('(Use `node --trace-deprecation')) continue;
        if (line.includes('DeprecationWarning:')) continue;
        return line.length > ERROR_LINE_MAX_LEN
          ? line.slice(0, ERROR_LINE_MAX_LEN - 3) + '...'
          : line;
      }
      return null;
    } finally {
      require('node:fs').closeSync(fd);
    }
  } catch {
    // Fallback for tiny logs / missing files: try whole-file read.
    try {
      const text = readFileSync(filePath, 'utf-8');
      const lines = text.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (line) return line.length > ERROR_LINE_MAX_LEN ? line.slice(0, ERROR_LINE_MAX_LEN - 3) + '...' : line;
      }
    } catch {
      // ignore
    }
    return null;
  }
}

function classifyErrorLine(line: string | null): { suspectedCause: SuspectedCause; conflictingManualDaemonPid: number | null } {
  if (!line) return { suspectedCause: 'unknown', conflictingManualDaemonPid: null };
  if (/Another manually started daemon is already running/i.test(line)) {
    // Try to find an adjacent pid hint if present
    const pidMatch = line.match(/pid\s+(\d+)/i);
    return {
      suspectedCause: 'conflicting_manual_daemon',
      conflictingManualDaemonPid: pidMatch ? Number(pidMatch[1]) : null,
    };
  }
  if (/EADDRINUSE|already in use|address already in use/i.test(line)) {
    return { suspectedCause: 'port_in_use', conflictingManualDaemonPid: null };
  }
  if (/not authenticated|unauthorized|401|403/i.test(line)) {
    return { suspectedCause: 'auth_missing', conflictingManualDaemonPid: null };
  }
  return { suspectedCause: 'unknown', conflictingManualDaemonPid: null };
}
