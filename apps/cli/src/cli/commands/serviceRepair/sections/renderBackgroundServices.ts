import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import {
  bold,
  compactVersion,
  friendlyServerId,
  muted,
  statusGlyph,
  subLineArrow,
} from '@/ui/format/styles';
import type {
  AutomaticStartupEntry,
  RepairFinding,
  RunningDaemonEntry,
} from '@/diagnostics/doctorRepair';

import { SECTION_BACKGROUND_SERVICES } from '../prompts/_copy';

type Row = Readonly<{
  sortKey: 0 | 1 | 2;              // auto+running → 0, auto+stopped → 1, manual → 2
  name: string;
  displayChannel: string | null;    // user-label e.g. 'dev' or null when unknown
  displayVersion: string | null;    // pre-compacted
  relayUrl: string | null;          // which relay this service points at
  running: boolean;
  startsAt: 'auto' | 'manual' | 'unknown';
  pid: number | null;
  kind: 'automatic' | 'manual';
  entry: AutomaticStartupEntry | RunningDaemonEntry;
}>;

function rowFromAutomaticStartup(entry: AutomaticStartupEntry): Row {
  const raw = entry.configuredCliVersion ?? entry.runningCliVersion ?? null;
  return {
    sortKey: entry.running === true ? 0 : 1,
    name: entry.name,
    displayChannel: entry.releaseChannel,
    displayVersion: raw ? compactVersion(raw) : null,
    relayUrl: entry.relayUrl ?? null,
    running: entry.running === true,
    startsAt: 'auto',
    pid: null,
    kind: 'automatic',
    entry,
  };
}

function rowFromRunningDaemon(entry: RunningDaemonEntry): Row {
  const channel = entry.startedWithReleaseChannel;
  return {
    sortKey: 2,
    name: friendlyServerId(entry.serverId),
    displayChannel: channel,
    displayVersion: entry.startedWithCliVersion ? compactVersion(entry.startedWithCliVersion) : null,
    relayUrl: null,
    running: true,
    startsAt: entry.startedBy === 'automatic-startup'
      ? 'auto'
      : entry.startedBy === 'manual'
        ? 'manual'
        : 'unknown',
    pid: entry.pid,
    kind: 'manual',
    entry,
  };
}

/** Merge automatic-startup entries with running daemons into one ordered list. */
function buildRows(
  automatic: readonly AutomaticStartupEntry[],
  running: readonly RunningDaemonEntry[],
): Row[] {
  const rows: Row[] = automatic.map(rowFromAutomaticStartup);
  const seenServerIds = new Set(automatic.map((e) => e.serverId));
  for (const r of running) {
    if (seenServerIds.has(r.serverId)) continue; // already represented by an auto entry
    rows.push(rowFromRunningDaemon(r));
  }
  rows.sort((a, b) => a.sortKey - b.sortKey);
  return rows;
}

// ────────── Finding → row targeting ──────────

function findingTargetsAutomaticEntry(
  finding: RepairFinding,
  entry: AutomaticStartupEntry,
): boolean {
  switch (finding.kind) {
    case 'automatic_startup_version_stale':
    case 'automatic_startup_stale_definition':
    case 'automatic_startup_legacy_channel_scoped':
    case 'automatic_startup_legacy_pinned_current_server':
      return finding.entry.path === entry.path;
    case 'automatic_startup_duplicate_default_following':
    case 'automatic_startup_duplicate_pinned_same_server':
      return [finding.keeper, ...finding.duplicates].some((e) => e.path === entry.path);
    case 'automatic_startup_lane_mismatch':
      return finding.existing.some((e) => e.path === entry.path);
    case 'automatic_startup_foreign_home':
      return finding.entries.some((e) => e.path === entry.path);
    default:
      return false;
  }
}

function findingTargetsDaemon(
  finding: RepairFinding,
  daemon: RunningDaemonEntry,
): boolean {
  if (finding.kind === 'running_daemon_cli_mismatch') {
    return finding.daemon.pid === daemon.pid;
  }
  if (finding.kind === 'running_daemon_duplicate_profile') {
    return finding.daemons.some((d) => d.pid === daemon.pid);
  }
  return false;
}

function findingsForRow(row: Row, findings: readonly RepairFinding[]): readonly RepairFinding[] {
  if (row.kind === 'automatic') {
    return findings.filter((f) => findingTargetsAutomaticEntry(f, row.entry as AutomaticStartupEntry));
  }
  return findings.filter((f) => findingTargetsDaemon(f, row.entry as RunningDaemonEntry));
}

// ────────── Rendering ──────────

function startsAtLabel(row: Row): string {
  if (row.startsAt === 'auto') return 'auto-starts on boot';
  if (row.startsAt === 'manual') return 'started manually';
  return 'startup source unknown';
}

function rightMeta(row: Row): string {
  const statusWord = row.running ? 'running' : 'stopped';
  const statusToken = row.running ? statusWord : muted(statusWord);
  const parts = [statusToken, muted(startsAtLabel(row))];
  if (row.pid != null) parts.push(muted(`pid ${row.pid}`));
  return parts.join(muted(' · '));
}

function subLine(row: Row, findings: readonly RepairFinding[]): string | null {
  const primary = findings[0];

  // Automatic-startup-side findings use tailored copy
  if (row.kind === 'automatic' && primary) {
    const entry = row.entry as AutomaticStartupEntry;
    switch (primary.kind) {
      case 'automatic_startup_version_stale': {
        const current = compactVersion(primary.currentCliVersion);
        const configured = entry.configuredCliVersion ? compactVersion(entry.configuredCliVersion) : '(unknown)';
        return `${entry.mode} scope • configured CLI ${configured} (newer CLI ${current} installed — restart to pick it up)`;
      }
      case 'automatic_startup_stale_definition':
        return `${entry.mode} scope • service definition drifted — reinstalling brings it back in sync`;
      case 'automatic_startup_legacy_channel_scoped':
        return `${entry.mode} scope • older per-channel service name — updating to the canonical name`;
      case 'automatic_startup_legacy_pinned_current_server': {
        const where = entry.relayUrl
          ? `details for ${entry.relayUrl} baked into its config`
          : 'your current server\'s details baked into its config';
        return `${where} (legacy setup — can be replaced with the dynamic default-following setup)`;
      }
      case 'automatic_startup_lane_mismatch':
        return `${entry.mode} scope • different release channel from the CLI you just installed`;
      case 'automatic_startup_duplicate_default_following':
      case 'automatic_startup_duplicate_pinned_same_server':
        return `${entry.mode} scope • duplicate (only one should run)`;
      case 'automatic_startup_foreign_home':
        return `from another Happier home — manual cleanup required`;
    }
  }

  // Running-daemon-side findings
  if (row.kind === 'manual' && primary) {
    const daemon = row.entry as RunningDaemonEntry;
    if (primary.kind === 'running_daemon_cli_mismatch') {
      return `older than this CLI — restart to pick up ${compactVersion(primary.currentCliVersion)}`;
    }
    if (primary.kind === 'running_daemon_duplicate_profile') {
      return `duplicate — two daemons own the same relay profile (pid ${daemon.pid})`;
    }
  }

  // No finding on this row — show the canonical secondary facts.
  if (row.kind === 'automatic') {
    const entry = row.entry as AutomaticStartupEntry;
    const parts: string[] = [`${entry.mode} scope`];
    if (entry.configuredCliVersion) {
      parts.push(`configured CLI ${compactVersion(entry.configuredCliVersion)}`);
    }
    if (entry.targetMode === 'pinned') {
      parts.push(entry.relayUrl
        ? `pinned to ${entry.relayUrl}`
        : 'pinned to a specific server');
    }
    return parts.join(' • ');
  }

  return null;
}

function renderRow(row: Row, findings: readonly RepairFinding[]): string[] {
  const hit = findingsForRow(row, findings);
  const glyphKind = hit.length > 0
    ? 'drifted'
    : row.running
      ? 'running'
      : 'stopped';

  const channel = row.displayChannel
    ? formatReleaseChannel(row.displayChannel)
    : muted('unknown');
  const versionPart = row.displayVersion ? ` • ${row.displayVersion}` : '';
  const urlPart = row.relayUrl ? ` ${muted(`on ${row.relayUrl}`)}` : '';
  const head = `  ${statusGlyph(glyphKind)} ${bold(row.name)}  ${muted('—')}  ${channel}${versionPart}${urlPart}   ${rightMeta(row)}`;

  const lines: string[] = [head];
  const sub = subLine(row, hit);
  if (sub) lines.push(`    ${subLineArrow()} ${muted(sub)}`);
  return lines;
}

export function renderBackgroundServices(
  automaticStartup: readonly AutomaticStartupEntry[],
  currentlyRunning: readonly RunningDaemonEntry[],
  findings: readonly RepairFinding[],
): string[] {
  const rows = buildRows(automaticStartup, currentlyRunning);
  if (rows.length === 0) {
    return [`${bold(SECTION_BACKGROUND_SERVICES)}  ${muted('—')}  ${muted('none running or configured')}`];
  }
  const out: string[] = [bold(SECTION_BACKGROUND_SERVICES)];
  for (const row of rows) {
    out.push(...renderRow(row, findings));
  }
  return out;
}
