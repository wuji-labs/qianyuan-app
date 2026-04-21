import type { DoctorRepairReport } from '@/diagnostics/doctorRepair';
import { muted } from '@/ui/format/styles';

import { findingHeadline, MISMATCHED_STATE_HEADER } from './prompts/_copy';
import { renderCleanStateSummary } from './renderCleanStateSummary';
import { renderBackgroundServices } from './sections/renderBackgroundServices';
import { renderCurrentCli } from './sections/renderCurrentCli';
import { renderLocalRelays } from './sections/renderLocalRelays';

/**
 * Canonical report renderer. Returns a `string[]` so tests can assert on
 * substrings without worrying about terminal wrapping.
 *
 * - If `report.findings.length === 0`, renders the compact "looks good" block.
 * - Otherwise renders the mismatched header + relevant sections (a section is
 *   only shown when it has content OR there is a finding that targets it).
 */
export function renderDoctorRepairReport(report: DoctorRepairReport): string[] {
  if (report.findings.length === 0) {
    return renderCleanStateSummary(report);
  }

  const out: string[] = [MISMATCHED_STATE_HEADER];

  // Dedupe + preserve canonical order (findings are already ordered by build).
  // Marker is muted so it recedes; headline itself reads at full weight — these
  // are the primary takeaway the user is supposed to scan.
  const seen = new Set<string>();
  for (const finding of report.findings) {
    const headline = findingHeadline(finding);
    if (seen.has(headline)) continue;
    seen.add(headline);
    out.push(`${muted('  •')} ${headline}`);
  }
  out.push('');

  const currentCliLines = renderCurrentCli(report.currentCli);
  out.push(...currentCliLines, '');

  const backgroundLines = renderBackgroundServices(
    report.automaticStartup,
    report.currentlyRunning,
    report.findings,
  );
  if (backgroundLines.length > 0) out.push(...backgroundLines, '');

  const relayLines = renderLocalRelays(report.localRelays, report.findings);
  if (relayLines.length > 0) out.push(...relayLines, '');

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
