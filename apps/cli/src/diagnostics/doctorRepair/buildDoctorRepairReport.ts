import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { DaemonServiceMode } from '@/daemon/service/plan';

import { classifyAutomaticStartup } from './classifyAutomaticStartup';
import { classifyCurrentCli } from './classifyCurrentCli';
import { classifyCurrentlyRunning } from './classifyCurrentlyRunning';
import { classifyLocalRelays } from './classifyLocalRelays';
import {
  compareFindingByOrder,
  type AutomaticStartupEntry,
  type CurrentCliInfo,
  type DoctorRepairReport,
  type LocalRelayEntry,
  type RepairFinding,
  type RunningDaemonEntry,
} from './types';

/**
 * Pure, deterministic report builder.
 *
 * Given pre-resolved inventory (current CLI info, automatic-startup entries,
 * currently-running daemons, local relays) plus the existing
 * `BackgroundServiceRepairPlan`, project everything into a `DoctorRepairReport`
 * with ordered findings.
 *
 * The live-system adapter lives in `resolveDoctorRepairReport.ts`; keeping this
 * function pure makes it trivial to unit-test against fixtures.
 */
export async function buildDoctorRepairReport(params: Readonly<{
  currentCli: CurrentCliInfo;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  plan: BackgroundServiceRepairPlan;
  currentServerId: string;
  preferredMode: DaemonServiceMode;
  latestRelayVersionForCurrentChannel: string | null;
  onMigration?: boolean;
  /**
   * When true (the `doctor repair` path), the CLI classifier performs a live
   * npm dist-tag lookup with a short timeout so the user always sees the
   * current state rather than a possibly-stale cached hint.
   */
  forceRefreshLatestCli?: boolean;
}>): Promise<DoctorRepairReport> {
  const cliSelfUpdateFindings = await classifyCurrentCli({
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    currentCliVersion: params.currentCli.version,
    onMigration: params.onMigration,
    forceRefresh: params.forceRefreshLatestCli,
  });
  const cliIsLatest = cliSelfUpdateFindings.length === 0;

  const automaticStartupFindings = classifyAutomaticStartup({
    plan: params.plan,
    entries: params.automaticStartup,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    currentCliRingId: params.currentCli.ringId,
    currentCliVersion: params.currentCli.version,
    currentServerId: params.currentServerId,
    preferredMode: params.preferredMode,
    onMigration: params.onMigration,
  });

  const currentlyRunningFindings = classifyCurrentlyRunning({
    running: params.currentlyRunning,
    automaticStartup: params.automaticStartup,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    currentCliVersion: params.currentCli.version,
  });

  const localRelayFindings = classifyLocalRelays({
    relays: params.localRelays,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    cliIsLatest,
    latestRelayVersionForCurrentChannel: params.latestRelayVersionForCurrentChannel,
  });

  const findings: RepairFinding[] = [
    ...cliSelfUpdateFindings,
    ...automaticStartupFindings,
    ...currentlyRunningFindings,
    ...localRelayFindings,
  ].sort(compareFindingByOrder);

  return {
    currentCli: params.currentCli,
    automaticStartup: params.automaticStartup,
    currentlyRunning: params.currentlyRunning,
    localRelays: params.localRelays,
    findings,
    manualWarnings: params.plan.manualWarnings,
  };
}
