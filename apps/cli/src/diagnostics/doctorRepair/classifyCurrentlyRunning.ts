import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import type {
  AutomaticStartupEntry,
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
function resolveRecoveryStrategy(params: Readonly<{
  daemon: RunningDaemonEntry;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
}>): Pick<RunningDaemonCliMismatch, 'recoveryStrategy' | 'serviceManagerName'> {
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

  // CLI mismatch: running daemon started with a different channel/version
  for (const daemon of params.running) {
    if (daemon.matchesCurrentCli !== false) continue;
    const { recoveryStrategy, serviceManagerName } = resolveRecoveryStrategy({
      daemon,
      automaticStartup: params.automaticStartup,
      currentCliReleaseChannel: params.currentCliReleaseChannel,
    });
    const mismatch: RunningDaemonCliMismatch = {
      kind: 'running_daemon_cli_mismatch',
      severity: 'warning',
      // Auto-apply only when we can cleanly dispatch to service-restart (the
      // safer of the two paths — the service handles the handoff). A manual
      // takeover can surprise users if the service install path refuses, so
      // keep it prompted.
      autoApplyWithoutPrompt:
        daemon.startedBy === 'automatic-startup'
        || recoveryStrategy === 'service-restart',
      daemon,
      currentCliReleaseChannel: params.currentCliReleaseChannel,
      currentCliVersion: params.currentCliVersion,
      recoveryStrategy,
      serviceManagerName,
    };
    findings.push(mismatch);
  }

  return findings;
}
