import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import { bold, compactHomePath, muted, warning } from '@/ui/format/styles';
import type { CurrentCliInfo } from '@/diagnostics/doctorRepair';

import { SECTION_CURRENT_CLI } from '../prompts/_copy';

/** Render the `Current CLI` card. */
export function renderCurrentCli(cli: CurrentCliInfo): string[] {
  const lines: string[] = [bold(SECTION_CURRENT_CLI)];
  const summary = [
    formatReleaseChannel(cli.releaseChannel),
    cli.version ? `• ${cli.version}` : null,
  ].filter(Boolean).join(' ');
  const compactedPath = compactHomePath(cli.binaryPath);
  const shimHint = cli.shim && compactedPath
    ? `${cli.shim} → ${compactedPath}`
    : compactedPath ?? '';
  lines.push(`  ${summary}   ${muted(shimHint)}`);

  if (cli.pathWinnerResolvesToThisBinary === false && cli.pathWinnerShim) {
    lines.push(warning(`  ⚠ \`happier\` on your PATH resolves to a different install.`));
    lines.push(muted(`    Run this install with \`${cli.shim ?? 'hdev'}\` until you fix PATH.`));
  }
  return lines;
}
