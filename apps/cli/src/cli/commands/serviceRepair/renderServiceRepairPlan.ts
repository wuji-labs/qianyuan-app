import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import type { DaemonServiceInventoryEntry } from '@/daemon/service/cli';

import { renderServiceRepairRuntimeSummary } from './renderServiceRepairRuntimeSummary';

function formatPublicReleaseChannelLabel(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'publicdev') return 'dev';
  return value;
}

export function renderServiceRepairPlan(params: Readonly<{
  plan: BackgroundServiceRepairPlan;
  commandPath: string;
  snapshot?: DoctorSnapshot | null;
  serviceInventory?: readonly DaemonServiceInventoryEntry[];
  daemonCurrentInvocationMatches?: boolean | null;
  currentCliReleaseChannel?: string | null;
  currentCliVersion?: string | null;
}>): string {
  const summaryLines = renderServiceRepairRuntimeSummary({
    plan: params.plan,
    snapshot: params.snapshot ?? null,
    serviceInventory: params.serviceInventory,
    daemonCurrentInvocationMatches: params.daemonCurrentInvocationMatches,
    currentCliReleaseChannel: params.currentCliReleaseChannel,
    currentCliVersion: params.currentCliVersion,
  });
  const warningLines = params.plan.manualWarnings.length > 0
    ? [
        '',
        'Manual cleanup required:',
        ...params.plan.manualWarnings.map((warning) => `- ${warning}`),
      ]
    : [];

  if (params.plan.actions.length === 0) {
    return [
      ...summaryLines,
      '',
      params.plan.manualWarnings.length > 0
        ? 'No automatic startup repair actions are available.'
        : 'No automatic startup repair actions are needed.',
      ...warningLines,
    ].join('\n');
  }

  return [
    ...summaryLines,
    '',
    `Automatic startup repair (${params.plan.actions.length})`,
    '',
    ...params.plan.actions.map((action, index) => {
      if (action.kind === 'remove-service') {
        return `${index + 1}. Remove ${action.service.label} (${action.service.mode}, ${formatPublicReleaseChannelLabel(action.service.releaseChannel)}, ${action.service.targetMode})`;
      }
      return `${index + 1}. Enable automatic startup on ${formatPublicReleaseChannelLabel(action.releaseChannel)} (${action.mode})`;
    }),
    '',
    `Run ${params.commandPath} repair --yes to apply these actions non-interactively.`,
    ...warningLines,
  ].join('\n');
}
