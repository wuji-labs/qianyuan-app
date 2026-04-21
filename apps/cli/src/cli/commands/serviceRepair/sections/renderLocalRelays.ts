import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import { bold, compactVersion, muted, statusGlyph, subLineArrow } from '@/ui/format/styles';
import type {
  LocalRelayEntry,
  RepairFinding,
} from '@/diagnostics/doctorRepair';

import {
  HEALTHY_WORD,
  SECTION_LOCAL_RELAYS,
  UNHEALTHY_WORD,
} from '../prompts/_copy';

function findingTargetsRelay(finding: RepairFinding, entry: LocalRelayEntry): boolean {
  if (finding.kind === 'local_relay_version_stale') {
    return finding.entry.releaseChannel === entry.releaseChannel
      && finding.entry.mode === entry.mode;
  }
  if (finding.kind === 'local_relay_lane_missing') {
    return finding.installed.some((e) => e.releaseChannel === entry.releaseChannel && e.mode === entry.mode);
  }
  return false;
}

function cardFor(entry: LocalRelayEntry, findings: readonly RepairFinding[]): string[] {
  const hit = findings.filter((f) => findingTargetsRelay(f, entry));
  const running = entry.serviceActive === true;
  const unhealthy = entry.healthy === false;
  // Glyph: running+not-explicitly-unhealthy → running (green), drifted finding → yellow, else gray.
  const glyphKind = hit.length > 0
    ? 'drifted'
    : running && !unhealthy
      ? 'running'
      : 'stopped';

  const channel = formatReleaseChannel(entry.releaseChannel);
  const version = compactVersion(entry.version ?? '(unknown)');
  const url = entry.relayUrl ?? '(no URL)';
  const scope = `${entry.mode} scope`;
  const statusWord = running && !unhealthy
    ? HEALTHY_WORD
    : running && unhealthy
      ? UNHEALTHY_WORD
      : 'stopped';

  const head = `  ${statusGlyph(glyphKind)} ${channel}   ${version} on ${url}   ${muted(scope)}   ${glyphKind === 'running' ? statusWord : muted(statusWord)}`;
  const card: string[] = [head];

  const stale = hit.find((f) => f.kind === 'local_relay_version_stale');
  if (stale && stale.kind === 'local_relay_version_stale') {
    card.push(`    ${subLineArrow()} ${muted(`version ${version} behind latest ${compactVersion(stale.latestVersion)}`)}`);
  }
  const missing = hit.find((f) => f.kind === 'local_relay_lane_missing');
  if (missing && missing.kind === 'local_relay_lane_missing') {
    card.push(`    ${subLineArrow()} ${muted(`you just installed the ${missing.targetReleaseChannel} CLI — this local relay is on a different release channel`)}`);
  }
  return card;
}

export function renderLocalRelays(
  entries: readonly LocalRelayEntry[],
  findings: readonly RepairFinding[],
): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [bold(SECTION_LOCAL_RELAYS)];
  for (const entry of entries) {
    lines.push(...cardFor(entry, findings));
  }
  return lines;
}
