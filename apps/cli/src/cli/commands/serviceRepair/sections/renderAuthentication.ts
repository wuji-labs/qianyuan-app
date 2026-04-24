import { bold, muted, statusGlyph, subLineArrow } from '@/ui/format/styles';
import type { AuthProfileSnapshot } from '@/diagnostics/doctorRepair';

const SECTION_HEADER = 'Authentication';

/**
 * Card-style `Authentication` section — mirrors `Background services` and
 * `Local relays` so the report feels coherent. One card per configured
 * server profile, with a secondary `↳` line when the profile needs action.
 *
 * Status taxonomy per profile:
 *   - `hasCredentials` + `machineRegistered` + not expired → signed in
 *   - `hasCredentials` + expired                           → session expired
 *   - `hasCredentials` + !machineRegistered                → machine not registered
 *   - !hasCredentials                                      → not signed in
 *
 * The active profile's name is bolded so the user can tell at a glance which
 * one the current CLI is talking to.
 */
export function renderAuthentication(profiles: readonly AuthProfileSnapshot[], hasAny: boolean): string[] {
  if (!hasAny) {
    return [
      bold(SECTION_HEADER),
      `  ${muted('No server profiles configured.')}`,
      `    ${subLineArrow()} ${muted('sign in:')} ${bold('happier auth')}`,
    ];
  }
  if (profiles.length === 0) return [];

  // Order: active first, then alphabetical by name.
  const sorted = [...profiles].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.serverName.localeCompare(b.serverName);
  });

  const lines: string[] = [bold(SECTION_HEADER)];
  for (const p of sorted) {
    const status = statusFor(p);
    const glyphKind = glyphKindFor(status, p.reachability);
    const nameDisplay = p.isActive ? bold(p.serverName) : p.serverName;
    const activeMarker = p.isActive ? ` ${muted('(active)')}` : '';
    const url = muted(`on ${p.serverUrl}`);
    const statusWord = statusWordFor(status, p.reachability);
    // "signed in" (definitively verified) stays full-color; anything else —
    // including signed-in-but-unreachable — is muted, signaling lower
    // confidence.
    const statusRendered = status === 'signed-in' && p.reachability !== 'unreachable'
      ? statusWord
      : muted(statusWord);
    lines.push(`  ${statusGlyph(glyphKind)} ${nameDisplay}${activeMarker}  ${muted('—')}  ${url}  ${muted('—')}  ${statusRendered}`);
    const subLine = subLineFor(p, status);
    if (subLine) lines.push(`    ${subLineArrow()} ${muted(subLine)}`);
  }
  return lines;
}

type ProfileStatus = 'signed-in' | 'expired' | 'not-registered' | 'not-signed-in';

function statusFor(p: AuthProfileSnapshot): ProfileStatus {
  if (!p.hasCredentials) return 'not-signed-in';
  if (p.isExpired) return 'expired';
  if (!p.machineRegistered) return 'not-registered';
  return 'signed-in';
}

function glyphKindFor(status: ProfileStatus, reachability: AuthProfileSnapshot['reachability']): 'running' | 'drifted' | 'stopped' {
  // Unreachable live-check for a profile that looks signed-in offline: show
  // the yellow "drifted" glyph so users know we couldn't confirm.
  if (status === 'signed-in' && reachability === 'unreachable') return 'drifted';
  if (status === 'signed-in') return 'running';
  if (status === 'expired') return 'drifted';
  return 'stopped';
}

function statusWordFor(status: ProfileStatus, reachability: AuthProfileSnapshot['reachability']): string {
  if (status === 'signed-in' && reachability === 'unreachable') {
    return 'signed in · server unreachable';
  }
  switch (status) {
    case 'signed-in': return 'signed in';
    case 'expired': return 'session expired';
    case 'not-registered': return 'machine not registered';
    case 'not-signed-in': return 'not signed in';
  }
}

function subLineFor(p: AuthProfileSnapshot, status: ProfileStatus): string | null {
  if (status === 'signed-in' && p.reachability === 'unreachable') {
    return 'the server didn\u2019t respond — credential state couldn\u2019t be verified';
  }
  switch (status) {
    case 'signed-in': return null;
    case 'expired': return `re-sign in: happier auth --server ${p.serverId}`;
    case 'not-registered': return 'start the daemon to register: happier daemon start';
    case 'not-signed-in': return `sign in: happier auth --server ${p.serverId}`;
  }
}
