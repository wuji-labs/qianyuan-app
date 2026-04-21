import type { PublicReleaseRingId, PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceMode, DaemonServiceTargetMode } from '@/daemon/service/plan';

/**
 * The canonical analysis output for `happier doctor repair`.
 *
 * It aggregates a read of the four user-facing surfaces plus a first-class list
 * of findings that the guided flow renders/prompts about.
 *
 * Build via `buildDoctorRepairReport()`. Consumers: the `doctor repair` command
 * family, the future verbose `doctor` command, the installer (over --json).
 */
export type DoctorRepairReport = Readonly<{
  currentCli: CurrentCliInfo;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  findings: readonly RepairFinding[];
  manualWarnings: readonly string[];
}>;

export type CurrentCliInfo = Readonly<{
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  version: string;
  binaryPath: string | null;
  shim: 'happier' | 'hprev' | 'hdev' | null;
  pathWinnerShim: 'happier' | 'hprev' | 'hdev' | null;
  pathWinnerResolvesToThisBinary: boolean | null;
}>;

export type AutomaticStartupEntry = Readonly<{
  serverId: string;
  /** Canonical name — never "Default background service". */
  name: string;
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  mode: DaemonServiceMode;
  targetMode: DaemonServiceTargetMode;
  relayUrl: string | null;
  running: boolean | null;
  configuredCliVersion: string | null;
  runningCliVersion: string | null;
  path: string;
  happierHomeDir: string | null;
  isForeignHome: boolean;
  installedDefinitionMatchesExpected: boolean | null;
  /** True when the label/filename matches the legacy per-channel-scoped convention. */
  isLegacyChannelScoped: boolean;
}>;

export type RunningDaemonEntry = Readonly<{
  serverId: string;
  pid: number;
  httpPort: number | null;
  startedBy: 'automatic-startup' | 'manual' | 'unknown';
  startedWithReleaseChannel: PublicReleaseRingLabel | null;
  startedWithCliVersion: string | null;
  matchesCurrentCli: boolean | null;
  staleStateFile: boolean;
}>;

export type LocalRelayEntry = Readonly<{
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  mode: DaemonServiceMode;
  version: string | null;
  serviceActive: boolean | null;
  serviceEnabled: boolean | null;
  healthy: boolean | null;
  relayUrl: string | null;
  port: number | null;
  installRoot: string | null;
}>;

// ────────────────────────────────────────────────────────────────────────────
// Findings
// ────────────────────────────────────────────────────────────────────────────

export type RepairFindingSeverity = 'info' | 'warning';

type RepairFindingBase = Readonly<{
  kind: string;
  severity: RepairFindingSeverity;
  /**
   * If true, `doctor repair --yes` and installer `--yes` mode will apply this
   * finding without prompting. False findings are surfaced but require an
   * explicit prompt-yes or interactive run to apply.
   */
  autoApplyWithoutPrompt: boolean;
}>;

export type AutomaticStartupLaneMismatch = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_lane_mismatch';
  existing: readonly AutomaticStartupEntry[];
  targetReleaseChannel: PublicReleaseRingLabel;
}>;

export type AutomaticStartupVersionStale = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_version_stale';
  entry: AutomaticStartupEntry;
  currentCliVersion: string;
}>;

export type AutomaticStartupStaleDefinition = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_stale_definition';
  entry: AutomaticStartupEntry;
}>;

export type AutomaticStartupLegacyChannelScoped = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_legacy_channel_scoped';
  entry: AutomaticStartupEntry;
}>;

export type AutomaticStartupLegacyPinnedCurrentServer = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_legacy_pinned_current_server';
  entry: AutomaticStartupEntry;
}>;

export type AutomaticStartupDuplicateDefaultFollowing = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_duplicate_default_following';
  keeper: AutomaticStartupEntry;
  duplicates: readonly AutomaticStartupEntry[];
}>;

export type AutomaticStartupDuplicatePinnedSameServer = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_duplicate_pinned_same_server';
  serverId: string;
  keeper: AutomaticStartupEntry;
  duplicates: readonly AutomaticStartupEntry[];
}>;

export type AutomaticStartupMissing = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_missing';
  targetReleaseChannel: PublicReleaseRingLabel;
  preferredMode: DaemonServiceMode;
}>;

export type AutomaticStartupForeignHome = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_foreign_home';
  entries: readonly AutomaticStartupEntry[];
  messages: readonly string[];
}>;

export type RunningDaemonCliMismatch = RepairFindingBase & Readonly<{
  kind: 'running_daemon_cli_mismatch';
  daemon: RunningDaemonEntry;
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliVersion: string;
  /**
   * How this daemon should be restarted to pick up the current CLI:
   *  - `service-restart`: an auto-starting background service owns the same
   *    relay profile on the current CLI's channel. We should restart the
   *    service (which will take over the profile) — not call
   *    `daemon restart --takeover`, which would fail because the service
   *    install path is guarded against taking over the service's relay.
   *  - `daemon-takeover`: no matching service exists; a direct
   *    `daemon restart --takeover` is the right call.
   */
  recoveryStrategy: 'service-restart' | 'daemon-takeover';
  /**
   * When `recoveryStrategy === 'service-restart'`, which auto-starting service
   * will handle the restart (for prompt copy context).
   */
  serviceManagerName: string | null;
}>;

export type RunningDaemonDuplicateProfile = RepairFindingBase & Readonly<{
  kind: 'running_daemon_duplicate_profile';
  serverId: string;
  daemons: readonly RunningDaemonEntry[];
}>;

export type LocalRelayLaneMissing = RepairFindingBase & Readonly<{
  kind: 'local_relay_lane_missing';
  targetReleaseChannel: PublicReleaseRingLabel;
  installed: readonly LocalRelayEntry[];
}>;

export type LocalRelayVersionStale = RepairFindingBase & Readonly<{
  kind: 'local_relay_version_stale';
  entry: LocalRelayEntry;
  /** The latest version known for the relay's channel (from cache/GitHub). */
  latestVersion: string;
}>;

export type CliSelfUpdateAvailable = RepairFindingBase & Readonly<{
  kind: 'cli_self_update_available';
  releaseChannel: PublicReleaseRingLabel;
  currentVersion: string;
  latestVersion: string;
}>;

export type RepairFinding =
  | CliSelfUpdateAvailable
  | AutomaticStartupLaneMismatch
  | AutomaticStartupVersionStale
  | AutomaticStartupStaleDefinition
  | AutomaticStartupLegacyChannelScoped
  | AutomaticStartupLegacyPinnedCurrentServer
  | AutomaticStartupDuplicateDefaultFollowing
  | AutomaticStartupDuplicatePinnedSameServer
  | AutomaticStartupMissing
  | AutomaticStartupForeignHome
  | RunningDaemonCliMismatch
  | RunningDaemonDuplicateProfile
  | LocalRelayLaneMissing
  | LocalRelayVersionStale;

export type RepairFindingKind = RepairFinding['kind'];

/** Canonical ordering used by the guided walk and any deterministic rendering. */
export const REPAIR_FINDING_ORDER: readonly RepairFindingKind[] = [
  'cli_self_update_available',
  'automatic_startup_foreign_home',
  'automatic_startup_duplicate_default_following',
  'automatic_startup_duplicate_pinned_same_server',
  'automatic_startup_lane_mismatch',
  'automatic_startup_legacy_pinned_current_server',
  'automatic_startup_legacy_channel_scoped',
  'automatic_startup_stale_definition',
  'automatic_startup_missing',
  'automatic_startup_version_stale',
  'running_daemon_duplicate_profile',
  'running_daemon_cli_mismatch',
  'local_relay_lane_missing',
  'local_relay_version_stale',
];

export function compareFindingByOrder(a: RepairFinding, b: RepairFinding): number {
  return REPAIR_FINDING_ORDER.indexOf(a.kind) - REPAIR_FINDING_ORDER.indexOf(b.kind);
}
