import { compareVersions } from '@happier-dev/cli-common/update';

import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServiceListEntries } from '@/daemon/service/cli';
import { isDaemonServiceModeSupported } from '@/daemon/service/assertDaemonServiceModeSupported';
import { buildBackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';

import { handleServiceRepairCliCommand } from '../serviceRepair/handleServiceRepairCliCommand';

function normalizeVersionId(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().replace(/^v/i, '');
  return normalized || null;
}

export function hasCrossedBackgroundServiceMigrationBoundary(params: Readonly<{
  fromVersion: string | null | undefined;
  toVersion: string | null | undefined;
}>): boolean {
  const fromVersion = normalizeVersionId(params.fromVersion);
  const toVersion = normalizeVersionId(params.toVersion);
  if (!fromVersion || !toVersion) {
    return false;
  }
  return compareVersions(fromVersion, '0.2.3') < 0 && compareVersions(toVersion, '0.2.3') >= 0;
}

export async function maybeRunVersionGatedRuntimeMigration(params: Readonly<{
  fromVersion: string | null | undefined;
  toVersion: string | null | undefined;
  argv: readonly string[];
  commandPath: string;
}>): Promise<boolean> {
  if (!hasCrossedBackgroundServiceMigrationBoundary(params)) {
    return false;
  }

  const repairInvocations: Array<readonly string[]> = [];

  for (const mode of ['user', 'system'] as const) {
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode });
    if (!isDaemonServiceModeSupported(runtime.platform, mode)) {
      continue;
    }
    const services = await resolveDaemonServiceListEntries(runtime, { mode });
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: runtime.channel,
      services,
    });
    if (plan.actions.length === 0 && plan.manualWarnings.length === 0) {
      continue;
    }
    if (mode === 'system' && runtime.platform === 'linux' && runtime.uid !== 0) {
      console.warn('Skipping automatic system background-service migration without root privileges. Re-run manually with: sudo happier self migrate --yes --mode system');
      continue;
    }
    repairInvocations.push([...params.argv, '--mode', mode]);
  }

  if (repairInvocations.length === 0) {
    return false;
  }

  for (const argv of repairInvocations) {
    await handleServiceRepairCliCommand({
      argv,
      commandPath: params.commandPath,
    });
  }
  return true;
}
