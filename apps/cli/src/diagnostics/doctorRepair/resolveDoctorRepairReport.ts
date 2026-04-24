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
import { readCredentials, readSettings } from '@/persistence';

import type { AuthSignalsForProfile } from './classifyAuth';
import { checkAuthLive } from './authLiveCheck';
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

  const { activeServerUrl, authSignals, hasAnyServerProfile } = await resolveAuthContext();

  const report = await buildDoctorRepairReport({
    currentCli,
    automaticStartup,
    currentlyRunning,
    localRelays,
    plan,
    currentServerId: runtime.instanceId,
    preferredMode: params.preferredMode,
    latestRelayVersionForCurrentChannel,
    activeServerUrl,
    authSignals,
    hasAnyServerProfile,
    platform: runtime.platform,
    uid: runtime.uid ?? null,
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

/**
 * Assemble auth signals for every configured server profile + the active
 * server URL, reading from persisted settings. A `machineId` present in
 * `machineIdByServerId` is treated as "machine registered" for that profile.
 *
 * Live-check policy: when a non-empty token exists we make a single
 * `GET /v1/account/profile` call for the *active* profile only, with a 3s
 * timeout. A 401/403 flips `isExpired` to true; anything else leaves it
 * false so the `auth_expired_for_active_profile` finding doesn't false-fire
 * offline. Non-active profiles don't get a live check — their `isExpired`
 * remains unknown (false) here; expiry on those is surfaced lazily when
 * the user actually switches to them.
 */
async function resolveAuthContext(): Promise<Readonly<{
  activeServerUrl: string | null;
  authSignals: readonly AuthSignalsForProfile[];
  hasAnyServerProfile: boolean;
}>> {
  const [settings, credentials] = await Promise.all([
    readSettings().catch(() => null),
    readCredentials().catch(() => null),
  ]);
  const servers = settings?.servers ?? {};
  const activeServerId = String(settings?.activeServerId ?? '').trim();
  const machineIdByServerId = settings?.machineIdByServerId ?? {};
  const lastTokenSubByServerId = settings?.lastTokenSubByServerId ?? {};
  const profiles = Object.values(servers).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const hasAnyServerProfile = profiles.length > 0;
  const activeProfile = profiles.find((p) => p.id === activeServerId) ?? null;
  const activeServerUrl = activeProfile?.serverUrl ?? configuration.serverUrl ?? null;

  // Live expiry check for the active profile only. The credentials file is
  // per-home, so `credentials.token` is the token we'd use against whichever
  // profile is active. Reachability tells the renderer whether we actually
  // confirmed the auth state — critical when the relay is down, so users
  // don't see a misleading "signed in" when we couldn't verify.
  const activeToken = String(credentials?.token ?? '').trim();
  let activeExpired = false;
  let activeReachability: 'verified' | 'unreachable' | 'not-probed' = 'not-probed';
  if (activeProfile && activeToken) {
    const result = await checkAuthLive({
      serverUrl: activeProfile.serverUrl,
      token: activeToken,
    });
    activeExpired = result === 'expired';
    // 'ok' and 'expired' are both definitive answers from the server.
    // 'unknown' means the server didn't respond — don't claim verified.
    activeReachability = result === 'unknown' ? 'unreachable' : 'verified';
  }

  const signals: AuthSignalsForProfile[] = profiles.map((profile) => {
    // Credentials are per-home, not per-profile, but we treat "has a known
    // account sub recorded for this profile" as the best offline signal that
    // the user has ever authenticated there. New profiles or replaced homes
    // get no sub until first login.
    const lastSub = String(lastTokenSubByServerId[profile.id] ?? '').trim();
    const hasCredentials = lastSub.length > 0;
    const machineId = String(machineIdByServerId[profile.id] ?? '').trim();
    const isActive = profile.id === activeServerId;
    return {
      serverId: profile.id,
      serverName: profile.name || profile.id,
      serverUrl: profile.serverUrl,
      hasCredentials,
      isExpired: isActive ? activeExpired : false,
      machineRegistered: machineId.length > 0,
      isActive,
      reachability: isActive ? activeReachability : 'not-probed',
    };
  });

  return { activeServerUrl, authSignals: signals, hasAnyServerProfile };
}
