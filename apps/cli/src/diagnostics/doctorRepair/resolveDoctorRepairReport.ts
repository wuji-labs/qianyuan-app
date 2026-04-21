import {
  getReleaseRingPublicLabel,
  type PublicReleaseRingId,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import type { DaemonServiceInventoryEntry } from '@/daemon/service/cli';
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServiceInventoryEntries } from '@/daemon/service/cli';
import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';

import { buildDoctorRepairReport } from './buildDoctorRepairReport';
import { readLatestRelayVersion } from './relayUpdateCheck';
import type {
  AutomaticStartupEntry,
  CurrentCliInfo,
  DoctorRepairReport,
  LocalRelayEntry,
  RunningDaemonEntry,
} from './types';

/**
 * Live-system adapter that gathers inventory from existing primitives and
 * produces a `DoctorRepairReport`. Pure `buildDoctorRepairReport` is tested
 * against fixtures; this adapter is exercised via the handler + e2e tests.
 */
export async function resolveDoctorRepairReport(params: Readonly<{
  preferredMode: DaemonServiceMode;
  systemUser: string;
  onMigration?: boolean;
}>): Promise<Readonly<{
  report: DoctorRepairReport;
  plan: BackgroundServiceRepairPlan;
  snapshot: DoctorSnapshot | null;
  runtime: ReturnType<typeof resolveDaemonServiceCliRuntimeFromEnv>;
  serviceInventory: readonly DaemonServiceInventoryEntry[];
}>> {
  const runtimePreview = resolveDaemonServiceCliRuntimeFromEnv({
    mode: params.preferredMode,
    systemUser: params.systemUser,
  });

  const { runtime, plan } = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
    preferredMode: params.preferredMode,
    includeAllModes: runtimePreview.platform === 'linux',
    systemUser: params.systemUser,
  });

  const snapshot = await buildDoctorSnapshot().catch(() => null);
  const serviceInventory = await resolveDaemonServiceInventoryEntries({
    runtime,
    includeAllModes: runtime.platform === 'linux',
    systemUser: params.systemUser,
  }).catch(() => []);

  const currentCli = buildCurrentCliInfo(runtime, snapshot);
  const automaticStartup = buildAutomaticStartupEntries({
    inventory: serviceInventory,
    currentHappierHomeDir: runtime.happierHomeDir,
    plan,
  });
  const currentlyRunning = buildCurrentlyRunningEntries({
    snapshot,
    currentCliReleaseChannel: currentCli.releaseChannel,
    currentCliVersion: currentCli.version,
  });
  const localRelays = buildLocalRelayEntries(snapshot);

  // Doctor repair is the explicit "check everything now" moment — force a
  // live refresh for both CLI and relay latest-version lookups rather than
  // relying on whatever the background auto-update notice cached.
  // The relay call is skipped entirely when no local relay is installed.
  const latestRelayVersionForCurrentChannel = localRelays.length > 0
    ? await readLatestRelayVersion(currentCli.releaseChannel, { forceRefresh: true })
    : null;

  const report = await buildDoctorRepairReport({
    currentCli,
    automaticStartup,
    currentlyRunning,
    localRelays,
    plan,
    currentServerId: runtime.instanceId,
    preferredMode: params.preferredMode,
    latestRelayVersionForCurrentChannel,
    forceRefreshLatestCli: true,
    onMigration: params.onMigration,
  });

  return { report, plan, snapshot, runtime, serviceInventory };
}

// ─────────────────────────────────────────────────────────────

function buildCurrentCliInfo(
  runtime: ReturnType<typeof resolveDaemonServiceCliRuntimeFromEnv>,
  snapshot: DoctorSnapshot | null,
): CurrentCliInfo {
  const ringId = (runtime.channel ?? configuration.publicReleaseRing ?? 'stable') as PublicReleaseRingId;
  const releaseChannel = getReleaseRingPublicLabel(ringId);
  const version = String(configuration.currentCliVersion ?? '').trim() || '(unknown)';
  // best-effort: pull binary path from snapshot if present
  const snapshotDaemon = snapshot?.daemonStatus?.daemon ?? null;
  const binaryPath = runtime.entryPath || (snapshotDaemon as { binaryPath?: string } | null)?.binaryPath || null;

  const shim: CurrentCliInfo['shim'] = releaseChannel === 'stable'
    ? 'happier'
    : releaseChannel === 'preview'
      ? 'hprev'
      : 'hdev';
  return {
    releaseChannel,
    ringId,
    version,
    binaryPath,
    shim,
    pathWinnerShim: null,
    pathWinnerResolvesToThisBinary: null,
  };
}

function buildAutomaticStartupEntries(params: Readonly<{
  inventory: readonly DaemonServiceInventoryEntry[];
  currentHappierHomeDir: string | null | undefined;
  plan: BackgroundServiceRepairPlan;
}>): readonly AutomaticStartupEntry[] {
  const normalizeHome = (value: string | null | undefined) => {
    const v = String(value ?? '').trim();
    return v || null;
  };
  const currentHome = normalizeHome(params.currentHappierHomeDir);

  // Build a lookup of "is legacy channel scoped" by path, by rerunning the
  // same detection used inside the plan builder (lean on a small signature).
  const legacyPaths = new Set(
    params.plan.existingServices
      .filter((s) => {
        const label = String(s.label ?? '').trim().toLowerCase();
        const filename = String(s.path ?? '').toLowerCase().split(/[\\/]+/).pop() ?? '';
        const canonicalLabels = new Set([
          'happier-daemon.default',
          'com.happier.cli.daemon.default',
          'happier\\happier-daemon.default',
        ]);
        const canonicalFiles = new Set([
          'happier-daemon.default.service',
          'com.happier.cli.daemon.default.plist',
          'com.happier.cli.daemon.default',
          'happier-daemon.default.ps1',
        ]);
        if (canonicalLabels.has(label) || canonicalFiles.has(filename)) return false;
        if (s.targetMode !== 'default-following') return false;
        if (label.endsWith('.default')) return true;
        if (filename.endsWith('.default.service') || filename.endsWith('.default.plist') || filename.endsWith('.default.ps1')) return true;
        return false;
      })
      .map((s) => s.path),
  );

  // `installedDefinitionMatchesExpected` lives on the plan's existingServices,
  // not on the inventory rows. Join on `path`.
  const matchesExpected = new Map<string, boolean | null>();
  for (const s of params.plan.existingServices) {
    matchesExpected.set(s.path, s.installedDefinitionMatchesExpected ?? null);
  }
  const happierHomeByPath = new Map<string, string | null>();
  for (const s of params.plan.existingServices) {
    happierHomeByPath.set(s.path, s.happierHomeDir ?? null);
  }

  return params.inventory.map((e): AutomaticStartupEntry => {
    const ringId = e.ring as PublicReleaseRingId;
    const releaseChannel = getReleaseRingPublicLabel(ringId);
    const home = normalizeHome(happierHomeByPath.get(e.path) ?? null);
    const isForeignHome = currentHome !== null && home !== null && currentHome !== home;
    return {
      serverId: e.serverId,
      name: e.name,
      releaseChannel,
      ringId,
      mode: (e.mode ?? 'user'),
      targetMode: e.targetMode,
      relayUrl: e.relayUrl ?? null,
      running: typeof e.running === 'boolean' ? e.running : null,
      configuredCliVersion: e.configuredCliVersion ?? null,
      runningCliVersion: e.runningCliVersion ?? null,
      path: e.path,
      happierHomeDir: home,
      isForeignHome,
      installedDefinitionMatchesExpected: matchesExpected.get(e.path) ?? null,
      isLegacyChannelScoped: legacyPaths.has(e.path),
    };
  });
}

/**
 * Infer the public release channel from a version string when the daemon
 * didn't record `startedWithPublicReleaseChannel` explicitly. Looks at the
 * semver prerelease tag:
 *   0.2.1-preview.4227 → 'preview'
 *   0.2.5-dev.14.1     → 'dev'
 *   0.2.5              → 'stable'
 *   (empty)            → null
 */
function inferReleaseChannelFromVersion(version: string | null | undefined): PublicReleaseRingLabel | null {
  const v = String(version ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/-(?:dev|publicdev|internaldev)(?:[.\-]|$)/.test(v)) return 'dev';
  if (/-(?:preview|internalpreview|canary)(?:[.\-]|$)/.test(v)) return 'preview';
  if (/^\d+\.\d+\.\d+(?:\+[\w.]+)?$/.test(v)) return 'stable';
  return null;
}

function buildCurrentlyRunningEntries(params: Readonly<{
  snapshot: DoctorSnapshot | null;
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliVersion: string;
}>): readonly RunningDaemonEntry[] {
  const daemon = params.snapshot?.daemonStatus?.daemon ?? null;
  if (!daemon || daemon.running !== true) return [];
  const startedWithChannel = daemon.startedWithPublicReleaseChannel as PublicReleaseRingLabel | null | undefined;
  const explicit: PublicReleaseRingLabel | null = startedWithChannel === 'stable' || startedWithChannel === 'preview' || startedWithChannel === 'dev'
    ? startedWithChannel
    : null;
  // If the daemon didn't record the channel, infer from its version string.
  const normalized = explicit ?? inferReleaseChannelFromVersion(daemon.startedWithCliVersion);
  const matches = normalized === params.currentCliReleaseChannel
    && daemon.startedWithCliVersion === params.currentCliVersion;
  const startedBy = daemon.serviceManaged === true
    ? 'automatic-startup'
    : daemon.serviceManaged === false
      ? 'manual'
      : 'unknown';
  const serverId = String((params.snapshot?.daemonStatus?.server as { activeServerId?: string })?.activeServerId ?? 'default').trim() || 'default';
  return [{
    serverId,
    pid: daemon.pid ?? 0,
    httpPort: (daemon as { httpPort?: number }).httpPort ?? null,
    startedBy,
    startedWithReleaseChannel: normalized,
    startedWithCliVersion: daemon.startedWithCliVersion ?? null,
    matchesCurrentCli: matches,
    staleStateFile: false,
  }];
}

function buildLocalRelayEntries(snapshot: DoctorSnapshot | null): readonly LocalRelayEntry[] {
  const relays = snapshot?.relays?.happier?.relays ?? [];
  const out: LocalRelayEntry[] = [];
  for (const r of relays) {
    if (r.installed !== true) continue;
    const channel = r.ring as PublicReleaseRingLabel;
    if (channel !== 'stable' && channel !== 'preview' && channel !== 'dev') continue;
    const ringId: PublicReleaseRingId = channel === 'stable' ? 'stable' : channel === 'preview' ? 'preview' : 'publicdev';
    out.push({
      releaseChannel: channel,
      ringId,
      mode: (r.scope === 'system' ? 'system' : 'user'),
      version: r.version ?? null,
      serviceActive: typeof r.serviceActive === 'boolean' ? r.serviceActive : null,
      serviceEnabled: typeof r.serviceEnabled === 'boolean' ? r.serviceEnabled : null,
      healthy: typeof r.healthy === 'boolean' ? r.healthy : null,
      relayUrl: r.relayUrl ?? null,
      port: null,
      installRoot: null,
    });
  }
  return out;
}
