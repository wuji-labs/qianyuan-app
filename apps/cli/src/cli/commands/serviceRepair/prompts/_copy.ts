/**
 * Single source of truth for every user-visible string in `doctor repair`.
 *
 * - Every prompt/explanation lives here, not inline in the sections/orchestrator.
 * - Every string is authored for a user who doesn't know Happier internals.
 * - The terminology guard test (scripts/testing/terminology.test.mjs) enforces
 *   that forbidden words do not appear in repair/render code paths; this file
 *   is the only place where the user-visible vocabulary is defined.
 */

import chalk from 'chalk';

import type {
  AutomaticStartupDuplicateDefaultFollowing,
  AutomaticStartupDuplicatePinnedSameServer,
  AutomaticStartupEntry,
  AutomaticStartupForeignHome,
  AutomaticStartupLaneMismatch,
  AutomaticStartupLegacyChannelScoped,
  AutomaticStartupLegacyPinnedCurrentServer,
  AutomaticStartupMissing,
  AutomaticStartupStaleDefinition,
  AutomaticStartupVersionStale,
  CliSelfUpdateAvailable,
  LocalRelayLaneMissing,
  LocalRelayVersionStale,
  RepairFinding,
  RunningDaemonCliMismatch,
  RunningDaemonDuplicateProfile,
} from '@/diagnostics/doctorRepair';

export const CLEAN_STATE_HEADER = '✔  Your Happier installation looks good.';
export const MISMATCHED_STATE_HEADER = chalk.yellow.bold('Your Happier setup needs a small update:');

/**
 * Short, one-line headline per finding kind. Used in the summary block under
 * the mismatch header so the user can see at a glance what's flagged.
 */
export function findingHeadline(finding: RepairFinding): string {
  switch (finding.kind) {
    case 'cli_self_update_available':
      return 'A newer CLI is available for your release channel';
    case 'automatic_startup_foreign_home':
      return 'A background service from another Happier installation was detected';
    case 'automatic_startup_duplicate_default_following':
      return 'Multiple background services are configured to auto-start';
    case 'automatic_startup_duplicate_pinned_same_server':
      return 'Multiple pinned background services target the same server';
    case 'automatic_startup_lane_mismatch':
      return 'A background service is on a different release channel than this CLI';
    case 'automatic_startup_legacy_pinned_current_server':
      return 'A background service is pinned to the current server (legacy setup)';
    case 'automatic_startup_legacy_channel_scoped':
      return 'A background service uses an older service naming convention';
    case 'automatic_startup_stale_definition':
      return 'A background service\'s definition is out of date';
    case 'automatic_startup_missing':
      return 'No background service is configured to auto-start on boot';
    case 'automatic_startup_version_stale':
      return 'A background service is running an older CLI version';
    case 'running_daemon_cli_mismatch': {
      // Tailor wording based on whether the running process is managed by a
      // service (user will see "restart the service") or was started manually
      // (user will see "restart the daemon"). Using "background service" for
      // a manual process is misleading.
      const runningVersion = finding.daemon.startedWithCliVersion;
      const runningChannel = finding.daemon.startedWithReleaseChannel;
      const descriptor = runningChannel && runningVersion
        ? `${runningChannel} • ${runningVersion}`
        : 'an older CLI version';
      if (finding.daemon.startedBy === 'automatic-startup') {
        return `A running background service is older than this CLI (${descriptor})`;
      }
      return `A manually-started daemon is running an older CLI version (${descriptor})`;
    }
    case 'running_daemon_duplicate_profile':
      return 'Two daemons own the same relay profile';
    case 'local_relay_lane_missing':
      return 'No local relay matches this CLI\'s release channel';
    case 'local_relay_version_stale':
      return 'A local relay is older than this CLI';
  }
}

export const SECTION_CURRENT_CLI = 'Current CLI';
export const SECTION_BACKGROUND_SERVICES = 'Background services';
export const SECTION_LOCAL_RELAYS = 'Local relays';

// Kept as legacy aliases for a short deprecation period — do not use in new code.
export const SECTION_AUTOMATIC_STARTUP = SECTION_BACKGROUND_SERVICES;
export const SECTION_CURRENTLY_RUNNING = SECTION_BACKGROUND_SERVICES;

export const AUTOMATIC_STARTUP_NOT_ENABLED = 'not enabled';
export const RUNNING_WORD = 'running';
export const STOPPED_WORD = 'stopped';
export const MATCHES_THIS_CLI = 'matches this CLI';
export const CONFIGURED_NOT_RUNNING = 'configured (not currently running)';
export const HEALTHY_WORD = 'healthy';
export const UNHEALTHY_WORD = 'unhealthy';

// ─────── End-of-run recaps ───────

export function recapNothingToDo(): string {
  return 'All done. `happier doctor repair` is always safe to re-run.';
}

export function recapAppliedSome(applied: number, total: number): string {
  return `Applied ${applied} of ${total} actions. Re-run \`happier doctor repair\` to retry the rest.`;
}

export function recapAppliedAll(applied: number): string {
  return `Applied ${applied} action${applied === 1 ? '' : 's'}.`;
}

// ─────── Success confirmations ───────

export function confirmAutomaticStartupSwitched(target: string, version: string): string {
  return ` ✔ Automatic startup switched to ${target} • ${version}.`;
}
export function confirmBackgroundServiceRestarted(): string {
  return ' ✔ Background service restarted.';
}
export function confirmDaemonRestarted(pid: number | null): string {
  return pid ? ` ✔ Daemon restarted (pid ${pid}).` : ' ✔ Daemon restarted.';
}
export function confirmDaemonStopped(pid: number): string {
  return ` ✔ Stopped duplicate daemon (pid ${pid}).`;
}
export function confirmAutomaticStartupInstalled(target: string): string {
  return ` ✔ Automatic startup enabled for the ${target} channel.`;
}
export function confirmLocalRelayInstalled(channel: string, url: string): string {
  return ` ✔ ${channel[0].toUpperCase()}${channel.slice(1)} relay installed at ${url}.`;
}
export function confirmLocalRelayUpdated(channel: string, version: string): string {
  return ` ✔ ${channel[0].toUpperCase()}${channel.slice(1)} relay updated to ${version}.`;
}

// ─────── Per-finding prompt copy ───────
//
// Each builder returns `{ body, question, default }`. The orchestrator prints
// `body` (explanation lines) then calls `promptConfirmYesNo(question, { default })`.
// Findings with `autoApplyWithoutPrompt=true` skip the prompt in --yes mode but
// still render `body` so the user sees what's happening.

export type FindingPromptCopy = Readonly<{
  body: readonly string[];
  question: string;
  default: 'yes' | 'no';
}>;

function entryShortLabel(entry: AutomaticStartupEntry): string {
  const channel = entry.releaseChannel;
  const version = entry.configuredCliVersion ?? entry.runningCliVersion ?? '(unknown version)';
  return `${channel} • ${version}`;
}

export function copyLaneMismatch(
  finding: AutomaticStartupLaneMismatch,
  cli: Readonly<{ releaseChannel: string; version: string }>,
): FindingPromptCopy {
  const installed = finding.existing[0];
  const cliLine = `   CLI you just installed:      ${cli.releaseChannel} • ${cli.version}`;
  const startupLine = installed
    ? `   Auto-starting service is on: ${entryShortLabel(installed)}`
    : `   Auto-starting service is on: a different release channel`;
  return {
    body: [
      'The background service that auto-starts on boot is on a different release channel than the CLI you just installed.',
      '',
      cliLine,
      startupLine,
      '',
      `If you want this machine to use the ${cli.releaseChannel} CLI going forward (including on reboots),`,
      'you\'ll want to move the auto-starting service to the same channel too.',
      '',
      'Note: only one background service can auto-start per account on this machine,',
      'so moving it replaces the existing one.',
    ],
    question: `Move the auto-starting background service to the ${cli.releaseChannel} channel?`,
    default: 'yes',
  };
}

export function copyVersionStale(
  finding: AutomaticStartupVersionStale,
): FindingPromptCopy {
  const running = finding.entry.runningCliVersion ?? '(older)';
  return {
    body: [
      `The auto-starting background service on the ${finding.entry.releaseChannel} channel is running CLI ${running} — you just installed ${finding.currentCliVersion}.`,
    ],
    question: `Restart this auto-starting background service to pick up ${finding.currentCliVersion}?`,
    default: 'yes',
  };
}

export function copyStaleDefinition(
  _finding: AutomaticStartupStaleDefinition,
): FindingPromptCopy {
  return {
    body: [
      'Your auto-starting background service is on the right channel, but its installed definition is out of date',
      '(e.g. changed relay profile, missing env, or moved binary path).',
    ],
    question: 'Reinstall this auto-starting background service now?',
    default: 'yes',
  };
}

export function copyLegacyChannelScoped(
  _finding: AutomaticStartupLegacyChannelScoped,
): FindingPromptCopy {
  return {
    body: [
      'Your auto-starting background service uses an older per-channel service name that predates the current setup.',
      'It still works, but the latest CLI uses a single canonical name instead of per-channel names.',
    ],
    question: 'Update this auto-starting background service to the current naming?',
    default: 'yes',
  };
}

export function copyLegacyPinnedCurrentServer(
  _finding: AutomaticStartupLegacyPinnedCurrentServer,
): FindingPromptCopy {
  return {
    body: [
      'Your auto-starting background service has your current server\'s details baked into its config — that\'s how older installs worked.',
      'The current recommendation is a dynamic (default-following) auto-starting background service that follows',
      'whichever server you\'re using, so you don\'t have to reinstall it when you switch servers.',
    ],
    question: 'Switch this auto-starting background service to the default-following setup?',
    default: 'yes',
  };
}

export function copyDuplicateDefaultFollowing(
  finding: AutomaticStartupDuplicateDefaultFollowing,
): FindingPromptCopy {
  const keeperLabel = `${finding.keeper.name}   ${finding.keeper.mode} scope     ${entryShortLabel(finding.keeper)}`;
  const dupLabels = finding.duplicates.map(
    (d) => `   • ${d.name}   ${d.mode} scope   ${entryShortLabel(d)}`,
  );
  return {
    body: [
      'You have more than one auto-starting background service configured for boot:',
      '',
      `   • ${keeperLabel}`,
      ...dupLabels,
      '',
      'Only one should auto-start per account on this machine — the extras are left over from a previous setup.',
    ],
    question: `Keep the recommended one (${finding.keeper.mode} scope) as the only auto-starting service and remove the duplicates?`,
    default: 'yes',
  };
}

export function copyDuplicatePinnedSameServer(
  finding: AutomaticStartupDuplicatePinnedSameServer,
): FindingPromptCopy {
  const rows = [finding.keeper, ...finding.duplicates].map(
    (e) => `   • ${e.name}   targeting ${e.relayUrl ?? finding.serverId}   (${e.mode} scope)   ${entryShortLabel(e)}`,
  );
  return {
    body: [
      'You have more than one auto-starting background service with its server details baked in for the same server:',
      '',
      ...rows,
      '',
      'Only one should auto-start per server.',
    ],
    question: 'Remove the older duplicate auto-starting service?',
    default: 'yes',
  };
}

export function copyMissing(finding: AutomaticStartupMissing): FindingPromptCopy {
  return {
    body: [
      'No background service is configured to auto-start on boot. Without one, Happier won\'t start automatically.',
    ],
    question: `Enable an auto-starting background service for the ${finding.targetReleaseChannel} channel?`,
    default: finding.targetReleaseChannel === 'stable' ? 'yes' : 'no',
  };
}

export function copyForeignHome(finding: AutomaticStartupForeignHome): readonly string[] {
  // No prompt — informational only.
  const lines: string[] = [];
  for (const message of finding.messages) {
    lines.push(`⚠ ${message}`);
  }
  if (finding.entries.length > 0) {
    for (const entry of finding.entries) {
      const home = entry.happierHomeDir ?? '(unknown Happier home)';
      lines.push(`   ${entry.path}   (Happier home: ${home})`);
    }
  }
  lines.push('');
  lines.push('This belongs to a different Happier home — I can\'t touch it safely.');
  lines.push('Remove it from the owning installation, then re-run `happier doctor repair`.');
  return lines;
}

export function copyRunningDaemonCliMismatch(
  finding: RunningDaemonCliMismatch,
): FindingPromptCopy {
  const { daemon, currentCliReleaseChannel, currentCliVersion } = finding;
  const runningChannel = daemon.startedWithReleaseChannel ?? currentCliReleaseChannel;
  const runningVersion = daemon.startedWithCliVersion ?? '(unknown)';

  if (daemon.startedBy === 'automatic-startup') {
    return {
      body: [
        'A background service is running an older version of the CLI than the one you just installed.',
        '',
        `   Currently running: ${runningChannel} • ${runningVersion} (started by automatic startup)`,
        `   Automatic startup: ${currentCliReleaseChannel} • ${currentCliVersion}`,
        '',
        'Restarting the auto-starting service will pick up the installed version.',
      ],
      question: 'Restart the auto-starting background service now?',
      default: 'yes',
    };
  }

  // Manual daemon. Recovery path depends on whether an auto-starting service
  // already owns this relay profile on the current channel.
  if (finding.recoveryStrategy === 'service-restart') {
    const managerName = finding.serviceManagerName ?? 'an auto-starting background service';
    return {
      body: [
        'A background service is running an older CLI version than the one you just installed.',
        '',
        `   Currently running: ${runningChannel} • ${runningVersion} (started manually)`,
        `   You just installed: ${currentCliReleaseChannel} • ${currentCliVersion}`,
        '',
        `An auto-starting background service (${managerName}) already owns this relay profile,`,
        'so restarting the service is the safe way to take over with the new CLI.',
      ],
      question: 'Start the auto-starting background service now (it will take over)?',
      default: 'yes',
    };
  }

  return {
    body: [
      'A manually-started daemon is running an older CLI version than the one you just installed.',
      '',
      `   Currently running: ${runningChannel} • ${runningVersion} (started manually)`,
      `   You just installed: ${currentCliReleaseChannel} • ${currentCliVersion}`,
      '',
      'Restarting the daemon will take over with the installed CLI.',
    ],
    question: 'Restart the daemon with this installation?',
    default: 'yes',
  };
}

export function copyRunningDaemonDuplicateProfile(
  finding: RunningDaemonDuplicateProfile,
): FindingPromptCopy {
  const sorted = [...finding.daemons].sort((a, b) => {
    // Keep the newest (or service-managed) one, mark the other(s) as older
    if (a.startedBy === 'automatic-startup' && b.startedBy !== 'automatic-startup') return -1;
    if (b.startedBy === 'automatic-startup' && a.startedBy !== 'automatic-startup') return 1;
    return 0;
  });
  const rows = sorted.map((d) => {
    const channel = d.startedWithReleaseChannel ?? 'unknown';
    const version = d.startedWithCliVersion ?? 'unknown';
    const by = d.startedBy === 'automatic-startup' ? 'automatic startup' : 'manually';
    return `   • ${finding.serverId} — ${channel} • ${version} — started ${by}  (pid ${d.pid})`;
  });
  const older = sorted[sorted.length - 1];
  return {
    body: [
      `⚠ Two daemons are pointed at the same relay profile (${finding.serverId}). Only one can own it at a time.`,
      '',
      ...rows,
    ],
    question: `Stop the older one (pid ${older.pid})?`,
    default: 'yes',
  };
}

export function copyLocalRelayLaneMissing(
  finding: LocalRelayLaneMissing,
): FindingPromptCopy {
  const rows = finding.installed.map((r) => {
    const status = r.serviceActive === true ? 'running' : 'stopped';
    const version = r.version ?? '(unknown version)';
    const url = r.relayUrl ?? '(no URL)';
    return `  ● ${r.releaseChannel}   ${version} on ${url}   ${status}`;
  });
  return {
    body: [
      'Local relays on this machine:',
      ...rows,
      '',
      `You just installed the ${finding.targetReleaseChannel} CLI, but none of your local relays are on the ${finding.targetReleaseChannel} release channel.`,
      'If you point this CLI at your local relay, the release channels won\'t match.',
    ],
    question: `Install the ${finding.targetReleaseChannel} relay now?`,
    default: 'no',
  };
}

export function copyLocalRelayVersionStale(
  finding: LocalRelayVersionStale,
): FindingPromptCopy {
  const version = finding.entry.version ?? '(unknown)';
  return {
    body: [
      `Your local relay on the ${finding.entry.releaseChannel} release channel is running ${version}, but the latest published version is ${finding.latestVersion}.`,
    ],
    question: `Update the ${finding.entry.releaseChannel} relay to ${finding.latestVersion} now?`,
    default: 'no',
  };
}

export function copyCliSelfUpdateAvailable(
  finding: CliSelfUpdateAvailable,
): FindingPromptCopy {
  return {
    body: [
      `A newer CLI is published on the ${finding.releaseChannel} release channel.`,
      '',
      `   Installed: ${finding.currentVersion}`,
      `   Latest:    ${finding.latestVersion}`,
      '',
      'Updating the CLI first is recommended — other fixes (relay updates, automatic-startup',
      'restarts) depend on the CLI version you\'re running.',
    ],
    question: `Update the CLI to ${finding.latestVersion} now?`,
    default: 'yes',
  };
}

/** Central dispatcher. Returns null for informational-only findings (foreign_home). */
export function copyForFinding(finding: RepairFinding, cli: Readonly<{ releaseChannel: string; version: string }>): FindingPromptCopy | null {
  switch (finding.kind) {
    case 'cli_self_update_available':
      return copyCliSelfUpdateAvailable(finding);
    case 'automatic_startup_foreign_home':
      return null;
    case 'automatic_startup_lane_mismatch':
      return copyLaneMismatch(finding, cli);
    case 'automatic_startup_version_stale':
      return copyVersionStale(finding);
    case 'automatic_startup_stale_definition':
      return copyStaleDefinition(finding);
    case 'automatic_startup_legacy_channel_scoped':
      return copyLegacyChannelScoped(finding);
    case 'automatic_startup_legacy_pinned_current_server':
      return copyLegacyPinnedCurrentServer(finding);
    case 'automatic_startup_duplicate_default_following':
      return copyDuplicateDefaultFollowing(finding);
    case 'automatic_startup_duplicate_pinned_same_server':
      return copyDuplicatePinnedSameServer(finding);
    case 'automatic_startup_missing':
      return copyMissing(finding);
    case 'running_daemon_cli_mismatch':
      return copyRunningDaemonCliMismatch(finding);
    case 'running_daemon_duplicate_profile':
      return copyRunningDaemonDuplicateProfile(finding);
    case 'local_relay_lane_missing':
      return copyLocalRelayLaneMissing(finding);
    case 'local_relay_version_stale':
      return copyLocalRelayVersionStale(finding);
  }
}
