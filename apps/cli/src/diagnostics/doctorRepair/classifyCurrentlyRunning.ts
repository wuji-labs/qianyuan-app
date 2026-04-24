import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { readBackgroundServiceHealth } from './readBackgroundServiceHealth';
import type {
  AutomaticStartupEntry,
  BackgroundServiceCrashLooping,
  BackgroundServiceNotRunning,
  OrphanDaemonOnOtherChannel,
  RepairFinding,
  RunningDaemonCliMismatch,
  RunningDaemonDuplicateProfile,
  RunningDaemonEntry,
} from './types';

/**
 * Pick the recovery strategy for a running-daemon-mismatch finding.
 *
 * When an auto-starting background service owns the same relay profile as the
 * running daemon AND it targets the current CLI's channel, the correct fix is
 * `happier service restart` — the service install layer refuses
 * `daemon restart --takeover` against a profile it already manages.
 *
 * Only when there's no matching managing service do we fall back to a direct
 * daemon takeover.
 */
function resolveDriftKind(daemon: RunningDaemonEntry, currentCliReleaseChannel: PublicReleaseRingLabel): 'version-only' | 'cross-channel' {
  const daemonChannel = daemon.startedWithReleaseChannel;
  if (!daemonChannel) return 'version-only';
  return daemonChannel === currentCliReleaseChannel ? 'version-only' : 'cross-channel';
}

function resolveRecoveryStrategy(params: Readonly<{
  daemon: RunningDaemonEntry;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  driftKind: 'version-only' | 'cross-channel';
}>): Pick<RunningDaemonCliMismatch, 'recoveryStrategy' | 'serviceManagerName'> {
  // Cross-channel daemon: takeover preserves the daemon's own recorded
  // channel, so it can't "upgrade" the daemon to the current CLI's channel.
  // Stop is the honest action — the user then decides whether to start a
  // fresh daemon on the current channel.
  if (params.driftKind === 'cross-channel') {
    return { recoveryStrategy: 'daemon-stop', serviceManagerName: null };
  }
  const manager = params.automaticStartup.find((e) =>
    e.serverId === params.daemon.serverId
    && e.releaseChannel === params.currentCliReleaseChannel
    && !e.isForeignHome,
  );
  if (manager) {
    return { recoveryStrategy: 'service-restart', serviceManagerName: manager.name };
  }
  return { recoveryStrategy: 'daemon-takeover', serviceManagerName: null };
}

export function classifyCurrentlyRunning(params: Readonly<{
  running: readonly RunningDaemonEntry[];
  automaticStartup: readonly AutomaticStartupEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliVersion: string;
  platform: NodeJS.Platform;
  uid: number | null;
}>): readonly RepairFinding[] {
  const findings: RepairFinding[] = [];

  // Duplicate-profile: more than one daemon on the same serverId
  const byServerId = new Map<string, RunningDaemonEntry[]>();
  for (const daemon of params.running) {
    const list = byServerId.get(daemon.serverId) ?? [];
    list.push(daemon);
    byServerId.set(daemon.serverId, list);
  }
  for (const [serverId, daemons] of byServerId) {
    if (daemons.length < 2) continue;
    const dup: RunningDaemonDuplicateProfile = {
      kind: 'running_daemon_duplicate_profile',
      severity: 'warning',
      autoApplyWithoutPrompt: false,
      serverId,
      daemons,
    };
    findings.push(dup);
  }

  // CLI mismatch / cross-channel / orphan: the branching depends on whether
  // the daemon and any current-channel service share a serverId.
  for (const daemon of params.running) {
    if (daemon.matchesCurrentCli !== false) continue;
    const driftKind = resolveDriftKind(daemon, params.currentCliReleaseChannel);

    // Cross-channel with NO current-CLI service on the same serverId →
    // don't recommend replace. The user has this daemon for a reason.
    // Emit an informational finding; the renderer lists it calmly.
    if (driftKind === 'cross-channel') {
      const sameProfileService = params.automaticStartup.find((e) =>
        e.serverId === daemon.serverId
        && e.releaseChannel === params.currentCliReleaseChannel
        && !e.isForeignHome,
      );
      if (!sameProfileService) {
        const orphan: OrphanDaemonOnOtherChannel = {
          kind: 'orphan_daemon_on_other_channel',
          severity: 'info',
          autoApplyWithoutPrompt: false,
          daemon,
          currentCliReleaseChannel: params.currentCliReleaseChannel,
        };
        findings.push(orphan);
        continue;
      }
      // Same serverId, different channel → genuine replace candidate. Falls
      // through to the standard mismatch finding with recoveryStrategy below.
    }

    const { recoveryStrategy, serviceManagerName } = resolveRecoveryStrategy({
      daemon,
      automaticStartup: params.automaticStartup,
      currentCliReleaseChannel: params.currentCliReleaseChannel,
      driftKind,
    });
    const mismatch: RunningDaemonCliMismatch = {
      kind: 'running_daemon_cli_mismatch',
      severity: 'warning',
      autoApplyWithoutPrompt:
        (daemon.startedBy === 'automatic-startup' && driftKind === 'version-only')
        || recoveryStrategy === 'service-restart',
      daemon,
      currentCliReleaseChannel: params.currentCliReleaseChannel,
      currentCliVersion: params.currentCliVersion,
      driftKind,
      recoveryStrategy,
      serviceManagerName,
    };
    findings.push(mismatch);
  }

  // Background service on the current CLI's channel is configured but not
  // running, and no daemon is running on its serverId either. Before
  // emitting a plain "not running" finding, check the platform health
  // signals (runs count + last exit code) to see if it's actually
  // crash-looping. Crash-loop is a much more useful finding because it
  // carries the actual error message from the service's stderr.
  for (const service of params.automaticStartup) {
    if (service.isForeignHome) continue;
    if (service.releaseChannel !== params.currentCliReleaseChannel) continue;
    if (service.running === true) continue;
    const hasDaemonOnSameProfile = params.running.some((d) => d.serverId === service.serverId);
    if (hasDaemonOnSameProfile) continue;

    const label = deriveServiceLabel(service);
    const errLogPath = deriveStderrLogPath(service);
    const health = readBackgroundServiceHealth({
      platform: params.platform,
      uid: params.uid,
      label,
      errLogPath,
    });

    if (health.isCrashLooping && health.runs !== null && health.lastExitCode !== null) {
      const conflictingPid = health.conflictingManualDaemonPid
        ?? findConflictingDaemonPid(service, params.running);
      const finding: BackgroundServiceCrashLooping = {
        kind: 'background_service_crash_looping',
        severity: 'warning',
        autoApplyWithoutPrompt: false,
        entry: service,
        runs: health.runs,
        lastExitCode: health.lastExitCode,
        lastErrorLine: health.lastErrorLine,
        suspectedCause: health.suspectedCause,
        conflictingDaemon: conflictingPid !== null
          ? { pid: conflictingPid, serverId: resolveConflictingServerId(service, params.running, conflictingPid) }
          : null,
      };
      findings.push(finding);
      continue;
    }

    const finding: BackgroundServiceNotRunning = {
      kind: 'background_service_not_running',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      entry: service,
    };
    findings.push(finding);
  }

  return findings;
}

function deriveServiceLabel(service: AutomaticStartupEntry): string {
  // On macOS, the plist filename is `<label>.plist`. Strip directory + extension.
  const path = service.path;
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.plist$/i, '');
}

function deriveStderrLogPath(service: AutomaticStartupEntry): string | null {
  // We store logs at `<happier_home>/logs/daemon-service.<serverId>.err.log`
  // (or daemon-service.default.err.log for the default-following entry).
  const home = service.happierHomeDir;
  if (!home) return null;
  const logBase = service.targetMode === 'default-following'
    ? 'daemon-service.default.err.log'
    : `daemon-service.${service.serverId}.err.log`;
  return `${home}/logs/${logBase}`;
}

function findConflictingDaemonPid(
  service: AutomaticStartupEntry,
  running: readonly RunningDaemonEntry[],
): number | null {
  // If a manual daemon owns the SAME serverId the service targets, that's
  // almost certainly the conflict. Preferred signal over log-line parsing.
  const match = running.find((d) => d.serverId === service.serverId && d.startedBy === 'manual');
  return match?.pid ?? null;
}

function resolveConflictingServerId(
  service: AutomaticStartupEntry,
  running: readonly RunningDaemonEntry[],
  pid: number,
): string {
  const match = running.find((d) => d.pid === pid);
  return match?.serverId ?? service.serverId;
}
