import chalk from 'chalk';

/**
 * Shared CLI text style palette. Used by the doctor-repair renderer and anything
 * else that wants a consistent premium look: muted gray for secondary facts,
 * bold for headers and entry names, yellow for attention, green for success.
 *
 * Do not introduce a second palette — any new chalk.gray/chalk.bold/chalk.yellow
 * callsite inside doctor-repair rendering paths should use these helpers so a
 * future theme swap is a single file edit.
 */

export function muted(text: string): string {
  return chalk.gray(text);
}

export function bold(text: string): string {
  return chalk.bold(text);
}

export function warning(text: string): string {
  return chalk.yellow(text);
}

export function success(text: string): string {
  return chalk.green(text);
}

/** Status glyph: green when running/healthy, yellow when drifted, gray when stopped. */
export function statusGlyph(kind: 'running' | 'drifted' | 'stopped'): string {
  if (kind === 'running') return chalk.green('●');
  if (kind === 'drifted') return chalk.yellow('●');
  return chalk.gray('●');
}

/** Indent-arrow used for the secondary muted sub-line under a card. */
export function subLineArrow(): string {
  return chalk.gray('↳');
}

/**
 * Compact a semver build suffix so wide preview/dev builds
 * like `0.2.1-preview.1775503793.4227` render as `0.2.1-preview.4227`.
 * Strips bare 10+ digit numeric segments — usually a timestamp — from
 * the prerelease metadata. Leaves short build numbers intact.
 */
export function compactVersion(version: string): string {
  const trimmed = String(version ?? '').trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(/\.(\d{10,})(?=\.|$|-)/g, '');
}

/**
 * Make an auto-generated serverId friendlier to read.
 *   127.0.0.1-53488 → local relay (port 53488)
 *   localhost-41872 → local relay (port 41872)
 * Otherwise returns the id as-is.
 */
export function friendlyServerId(serverId: string): string {
  const s = String(serverId ?? '').trim();
  const loopbackMatch = s.match(/^(?:127\.0\.0\.1|localhost)-(\d+)$/);
  if (loopbackMatch) {
    return `local relay (port ${loopbackMatch[1]})`;
  }
  return s;
}

/** Shorten an absolute path under the user's home dir to `~/...` for display. */
export function compactHomePath(absolutePath: string | null | undefined): string {
  const p = String(absolutePath ?? '').trim();
  if (!p) return p;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home + '/')) return `~${p.slice(home.length)}`;
  if (home && p === home) return '~';
  return p;
}
