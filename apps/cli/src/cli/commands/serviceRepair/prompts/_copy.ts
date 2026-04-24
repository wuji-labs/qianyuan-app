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
  AuthExpiredForActiveProfile,
  AuthMissingForProfile,
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
  BackgroundServiceCrashLooping,
  BackgroundServiceNotRunning,
  ChannelSwitchRecommended,
  CliSelfUpdateAvailable,
  LocalRelayLaneMissing,
  LocalRelayOffChannelLeftovers,
  LocalRelayVersionStale,
  MachineNotRegisteredForProfile,
  MultiStackDetectedInformational,
  NoActiveStackYet,
  OrphanDaemonOnOtherChannel,
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
    case 'channel_switch_recommended':
      return `You\u2019re currently on ${finding.fromStack.releaseChannel}; you just installed the ${finding.toChannel} CLI`;
    case 'no_active_stack_yet':
      return 'No active Happier stack yet — start one to begin using Happier';
    case 'no_servers_configured':
      return 'No server profiles are configured';
    case 'auth_missing_for_profile':
      return `You\u2019re not signed in on the \u201C${finding.serverName}\u201D server profile`;
    case 'auth_expired_for_active_profile':
      return `Your session on \u201C${finding.serverName}\u201D has expired`;
    case 'machine_not_registered_for_profile':
      return `This machine isn\u2019t registered with \u201C${finding.serverName}\u201D yet`;
    case 'dev_on_hosted_cloud_informational':
      return 'Dev CLI + hosted cloud — dev features may not be available';
    case 'multi_stack_detected_informational':
      return 'Multiple Happier stacks running on this machine';
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
    case 'background_service_not_running':
      return `Your ${finding.entry.releaseChannel} background service is configured but not running`;
    case 'background_service_crash_looping':
      return `Your ${finding.entry.releaseChannel} background service is crash-looping (${finding.runs} failed starts)`;
    case 'orphan_daemon_on_other_channel': {
      const channel = finding.daemon.startedWithReleaseChannel ?? 'unknown';
      const version = finding.daemon.startedWithCliVersion ?? '';
      const descriptor = version ? `${channel} • ${version}` : channel;
      return `A ${channel} daemon is running (${descriptor}) — unrelated to this ${finding.currentCliReleaseChannel} CLI`;
    }
    case 'running_daemon_cli_mismatch': {
      const runningVersion = finding.daemon.startedWithCliVersion;
      const runningChannel = finding.daemon.startedWithReleaseChannel;
      const descriptor = runningChannel && runningVersion
        ? `${runningChannel} • ${runningVersion}`
        : 'an older CLI version';
      // Cross-channel orphan: the daemon is on a different release channel
      // than the current CLI. Restarting can't "upgrade" the channel, so the
      // wording avoids suggesting a version upgrade.
      if (finding.driftKind === 'cross-channel') {
        return `A daemon is running on a different release channel (${descriptor}) than this CLI`;
      }
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
    case 'local_relay_off_channel_leftovers':
      return `You have ${finding.leftovers.length} local relay${finding.leftovers.length === 1 ? '' : 's'} installed for other release channels`;
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

  // Cross-channel: the correct action is to replace — stop the old daemon
  // and start a fresh one using this CLI, which re-uses the active relay
  // profile but with the current channel.
  if (finding.driftKind === 'cross-channel') {
    return {
      body: [
        `A daemon on the ${runningChannel} channel is running, but this CLI is on ${currentCliReleaseChannel}.`,
        '',
        `   Currently running: ${runningChannel} • ${runningVersion}  (pid ${daemon.pid})`,
        `   This CLI is on:    ${currentCliReleaseChannel} • ${currentCliVersion}`,
        '',
        `Replacing stops the ${runningChannel} daemon and starts a ${currentCliReleaseChannel} daemon on the same relay profile.`,
        `Declining keeps the ${runningChannel} daemon running — use \`h${runningChannel}\` for ${runningChannel}-channel work.`,
      ],
      question: `Replace the ${runningChannel} daemon with a ${currentCliReleaseChannel} daemon?`,
      default: 'no',
    };
  }

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

/** Central dispatcher. Returns null for informational-only findings and
 *  findings with non-Y/n prompts that are handled separately (channel switch,
 *  auth). */
export function copyForFinding(finding: RepairFinding, cli: Readonly<{ releaseChannel: string; version: string }>): FindingPromptCopy | null {
  switch (finding.kind) {
    case 'channel_switch_recommended':
      return null;                 // multi-choice — handled by runGuidedRepair directly
    case 'no_active_stack_yet':
    case 'no_servers_configured':
    case 'auth_missing_for_profile':
    case 'auth_expired_for_active_profile':
    case 'machine_not_registered_for_profile':
    case 'dev_on_hosted_cloud_informational':
    case 'multi_stack_detected_informational':
      return null;                 // manual guidance — handled separately
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
    case 'background_service_not_running':
      return copyBackgroundServiceNotRunning(finding);
    case 'background_service_crash_looping':
      return copyBackgroundServiceCrashLooping(finding);
    case 'orphan_daemon_on_other_channel':
      return null; // informational-only — handled in guidanceLinesFor
    case 'local_relay_lane_missing':
      return copyLocalRelayLaneMissing(finding);
    case 'local_relay_version_stale':
      return copyLocalRelayVersionStale(finding);
    case 'local_relay_off_channel_leftovers':
      return null; // informational-only — handled in guidanceLinesFor
  }
}

// ─── Channel-switch prompt (multi-choice) ────────────────────────────────

export type ChannelSwitchChoice = 'switch' | 'keep' | 'replace' | 'parallel';

/**
 * The four-option channel-switch prompt shown when the user just installed a
 * CLI on a different channel than their currently-active stack. `Y` is the
 * typical "switch and keep the old stack dormant for later" path; `r` replaces
 * the old stack entirely; `p` runs both in parallel; `n` leaves everything
 * as-is.
 *
 * We show an account/session warning only when the active server will actually
 * change (e.g. going from a self-hosted preview server to hosted cloud).
 */
export function copyChannelSwitchRecommended(finding: ChannelSwitchRecommended): Readonly<{
  body: readonly string[];
  question: string;
}> {
  const { fromStack, toChannel, willActiveServerChange } = finding;
  const body: string[] = [
    `You just installed the ${toChannel} CLI.`,
    '',
    'Currently active on this machine:',
  ];
  if (fromStack.runningDaemon) {
    const daemonVer = fromStack.runningDaemon.startedWithCliVersion ?? '(unknown)';
    const url = fromStack.activeServerUrl ?? '(no URL)';
    body.push(`  • ${fromStack.releaseChannel} daemon (pid ${fromStack.runningDaemon.pid}) \u2192 ${url}`);
    if (fromStack.localRelay) {
      body.push(`  • local ${fromStack.releaseChannel} relay`);
    } else if (fromStack.isHostedCloudActive) {
      body.push(`  • no local relay (using hosted cloud)`);
    }
    body.push(`  • daemon CLI version: ${daemonVer}`);
  } else if (fromStack.automaticStartup) {
    body.push(`  • ${fromStack.releaseChannel} background service configured (not running)`);
  } else if (fromStack.localRelay) {
    body.push(`  • local ${fromStack.releaseChannel} relay (no daemon)`);
  }
  body.push('');
  body.push(`Make ${toChannel} your default channel?`);
  body.push('');
  body.push(`   [Y] Switch   \u2014 stops the ${fromStack.releaseChannel} daemon; starts a ${toChannel} daemon.`);
  body.push(`                  Keeps ${fromStack.releaseChannel} configured for later \u2014 switch back with \`h${fromStack.releaseChannel} doctor repair\`.`);
  if (willActiveServerChange) {
    body.push('                  Different channel usually means different server \u2192 different sessions.');
  }
  body.push(`   [n] Keep ${fromStack.releaseChannel}   \u2014 ${toChannel} CLI stays available via \`h${toChannel}\` for occasional use.`);
  body.push('                  Nothing else changes.');
  body.push('');
  body.push('   Advanced (single letter):');
  body.push(`     [r] Replace     \u2014 remove the ${fromStack.releaseChannel} stack entirely`);
  body.push(`                       (can\u2019t switch back without re-adding)`);
  body.push(`     [p] Parallel    \u2014 run ${fromStack.releaseChannel} AND ${toChannel} alongside each other`);
  body.push(`                       (requires a different server profile so they don\u2019t collide)`);
  return { body, question: 'Choice?' };
}

// ─── Manual-guidance copy for findings that print instructions instead of prompting ───

export function copyNoActiveStackYet(finding: NoActiveStackYet): readonly string[] {
  return [
    `No Happier daemon is running on this machine yet.`,
    `You just installed the ${finding.releaseChannel} CLI.`,
    '',
    'Start the daemon when you\u2019re ready with:',
    '  happier daemon start',
  ];
}

export function copyNoServersConfigured(): readonly string[] {
  return [
    'No server profiles are configured. You need at least one server to connect to.',
    '',
    'Sign in to Happier cloud with:',
    '  happier auth',
    '',
    'Or connect to a self-hosted server with:',
    '  happier server add <url>',
  ];
}

export function copyAuthMissingForProfile(finding: AuthMissingForProfile): readonly string[] {
  return [
    `You aren\u2019t signed in on the \u201C${finding.serverName}\u201D server profile (${finding.serverUrl}).`,
    '',
    'Sign in with:',
    `  happier auth --server ${finding.serverId}`,
  ];
}

export function copyAuthExpiredForActiveProfile(finding: AuthExpiredForActiveProfile): readonly string[] {
  return [
    `Your session on \u201C${finding.serverName}\u201D (${finding.serverUrl}) has expired.`,
    '',
    'Sign in again with:',
    '  happier auth',
  ];
}

export function copyMachineNotRegisteredForProfile(finding: MachineNotRegisteredForProfile): readonly string[] {
  return [
    `This machine isn\u2019t registered with \u201C${finding.serverName}\u201D yet.`,
    'Starting the daemon will register it:',
    '  happier daemon start',
  ];
}

export function copyDevOnHostedCloudInformational(): readonly string[] {
  return [
    'You\u2019re running the dev CLI against hosted Happier cloud (api.happier.dev).',
    'Dev-channel features work best with a local dev relay; hosted cloud runs stable only.',
    '',
    'Install a local dev relay with:',
    '  happier relay host install --channel dev --yes',
  ];
}

export function copyMultiStackDetectedInformational(finding: MultiStackDetectedInformational): readonly string[] {
  const lines: string[] = ['Multiple Happier stacks are running on this machine:', ''];
  for (const s of finding.stacks) {
    const pid = s.runningDaemon ? ` (pid ${s.runningDaemon.pid})` : '';
    lines.push(`  \u2022 ${s.releaseChannel} \u2014 ${s.archetype}${pid}`);
  }
  lines.push('');
  lines.push('This is intentional for side-by-side setups \u2014 no action required.');
  return lines;
}

export function copyBackgroundServiceNotRunning(finding: BackgroundServiceNotRunning): FindingPromptCopy {
  const { entry } = finding;
  const target = entry.relayUrl ? ` on ${entry.relayUrl}` : '';
  return {
    body: [
      `Your ${entry.releaseChannel} background service is configured to auto-start on boot, but it\u2019s currently stopped.`,
      '',
      `   ${entry.name}${target}`,
      `   ${entry.mode} scope \u2022 configured CLI ${entry.configuredCliVersion ?? '(unknown)'}`,
      '',
      'Starting it now spawns the daemon and registers this machine with its server.',
      'If it fails to start (e.g. port conflict, auth missing), run `happier doctor` for a deeper diagnosis.',
    ],
    question: `Start the ${entry.releaseChannel} background service now?`,
    default: 'yes',
  };
}

export function copyOrphanDaemonOnOtherChannel(finding: OrphanDaemonOnOtherChannel): readonly string[] {
  const channel = finding.daemon.startedWithReleaseChannel ?? 'unknown';
  const version = finding.daemon.startedWithCliVersion ?? '(unknown)';
  const descriptor = `${channel} \u2022 ${version}`;
  return [
    `A ${channel} daemon (${descriptor}) is running on a profile unrelated to this ${finding.currentCliReleaseChannel} CLI.`,
    `Nothing to do \u2014 use \`h${channel}\` for ${channel}-channel work, and \`h${finding.currentCliReleaseChannel}\` here for ${finding.currentCliReleaseChannel}.`,
  ];
}

export function copyLocalRelayOffChannelLeftovers(finding: LocalRelayOffChannelLeftovers): readonly string[] {
  const extras = finding.leftovers.map((e) => `   \u2022 ${e.releaseChannel} \u2022 ${e.version ?? '(unknown)'} on ${e.relayUrl ?? '(unknown)'}`);
  return [
    `You have local relays installed for release channels other than this CLI's (${finding.currentChannelEntry.releaseChannel}):`,
    ...extras,
    `Each runs as its own background service. To remove one, run:`,
    `   happier relay host uninstall --channel <stable|preview|dev>`,
  ];
}

export function copyBackgroundServiceCrashLooping(finding: BackgroundServiceCrashLooping): FindingPromptCopy {
  const { entry, runs, lastExitCode, lastErrorLine, suspectedCause, conflictingDaemon } = finding;
  const body: string[] = [
    `Your ${entry.releaseChannel} background service has failed to start ${runs} times (last exit code: ${lastExitCode}).`,
    `launchd keeps respawning it, so it shows up as "stopped" but is actively crash-looping.`,
  ];
  if (lastErrorLine) {
    body.push('');
    body.push('Last error from the service\u2019s stderr log:');
    body.push(`  ${lastErrorLine}`);
  }
  body.push('');
  if (suspectedCause === 'conflicting_manual_daemon' && conflictingDaemon) {
    body.push(`Likely cause: another daemon (pid ${conflictingDaemon.pid}) already owns the relay profile \u201C${conflictingDaemon.serverId}\u201D.`);
    body.push(`Stopping the conflict lets the service take over on its next launch.`);
    return {
      body,
      question: `Stop the conflicting daemon (pid ${conflictingDaemon.pid}) and let the service take over?`,
      default: 'yes',
    };
  }
  if (suspectedCause === 'conflicting_manual_daemon') {
    body.push('Likely cause: another daemon owns this relay profile. Stop any manually-started daemons and try again.');
  } else if (suspectedCause === 'port_in_use') {
    body.push('Likely cause: a port the daemon needs is in use by another process.');
  } else if (suspectedCause === 'auth_missing') {
    body.push('Likely cause: authentication is missing or expired for this profile.');
  } else {
    body.push('Run `happier doctor` for a deeper diagnosis.');
  }
  return {
    body,
    question: `Retry starting the ${entry.releaseChannel} background service?`,
    default: 'no',
  };
}
