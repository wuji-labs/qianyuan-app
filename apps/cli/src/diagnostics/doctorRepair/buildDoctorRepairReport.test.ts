import { describe, expect, it } from 'vitest';

import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';

import { buildDoctorRepairReport } from './buildDoctorRepairReport';
import type {
  AutomaticStartupEntry,
  CurrentCliInfo,
  LocalRelayEntry,
  RunningDaemonEntry,
} from './types';

// ────────── Fixture helpers ──────────

function makeCurrentCli(overrides: Partial<CurrentCliInfo> = {}): CurrentCliInfo {
  return {
    releaseChannel: 'dev',
    ringId: 'publicdev',
    version: '0.12.3',
    binaryPath: '/Users/me/.happier/cli-dev/current/bin/happier',
    shim: 'hdev',
    pathWinnerShim: 'happier',
    pathWinnerResolvesToThisBinary: true,
    ...overrides,
  };
}

function makeAutomaticStartupEntry(overrides: Partial<AutomaticStartupEntry> = {}): AutomaticStartupEntry {
  return {
    serverId: 'default',
    name: 'Default automatic startup',
    releaseChannel: 'dev',
    ringId: 'publicdev',
    mode: 'user',
    targetMode: 'default-following',
    relayUrl: 'https://api.happier.dev',
    running: true,
    configuredCliVersion: '0.12.3',
    runningCliVersion: '0.12.3',
    path: '/Users/me/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
    happierHomeDir: '/Users/me/.happier',
    isForeignHome: false,
    installedDefinitionMatchesExpected: true,
    isLegacyChannelScoped: false,
    ...overrides,
  };
}

function makePlan(overrides: Partial<BackgroundServiceRepairPlan> = {}): BackgroundServiceRepairPlan {
  return {
    currentReleaseChannel: 'publicdev',
    existingServices: [],
    actions: [],
    manualWarnings: [],
    ...overrides,
  };
}

function basic(plan: BackgroundServiceRepairPlan, entries: readonly AutomaticStartupEntry[]) {
  return buildDoctorRepairReport({
    currentCli: makeCurrentCli(),
    automaticStartup: entries,
    currentlyRunning: [],
    localRelays: [],
    plan,
    currentServerId: 'default',
    preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
  });
}

// ────────── Tests ──────────

describe('buildDoctorRepairReport — clean state', async () => {
  it('case #1 — dev CLI, dev startup matching, no findings', async () => {
    const entries = [makeAutomaticStartupEntry()];
    const report = await basic(makePlan({ existingServices: [] }), entries);
    expect(report.findings).toEqual([]);
  });
});

describe('buildDoctorRepairReport — foreign home', async () => {
  it('case #12 — foreign-home manual warning short-circuits all findings', async () => {
    const plan = makePlan({
      manualWarnings: ['Detected default-following background services from another Happier home (/opt/old).'],
    });
    const entries = [makeAutomaticStartupEntry({ isForeignHome: true, happierHomeDir: '/opt/old' })];
    const report = await basic(plan, entries);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('automatic_startup_foreign_home');
    expect(report.findings[0].autoApplyWithoutPrompt).toBe(false);
  });
});

describe('buildDoctorRepairReport — lane mismatch', async () => {
  it('case #5/#6 — startup on stable but CLI is dev', async () => {
    const existingOnStable = makeAutomaticStartupEntry({
      releaseChannel: 'stable',
      ringId: 'stable',
      running: false,
      runningCliVersion: null,
    });
    const plan = makePlan({
      actions: [{ kind: 'install-default-following-service', releaseChannel: 'publicdev', mode: 'user' }],
    });
    const report = await basic(plan, [existingOnStable]);
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain('automatic_startup_lane_mismatch');
    const f = report.findings.find((x) => x.kind === 'automatic_startup_lane_mismatch');
    expect(f?.autoApplyWithoutPrompt).toBe(false);
  });

  it('onMigration broadens lane mismatch to auto-apply', async () => {
    const existingOnStable = makeAutomaticStartupEntry({
      releaseChannel: 'stable',
      ringId: 'stable',
      running: false,
      runningCliVersion: null,
    });
    const plan = makePlan({
      actions: [{ kind: 'install-default-following-service', releaseChannel: 'publicdev', mode: 'user' }],
    });
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [existingOnStable],
      currentlyRunning: [],
      localRelays: [],
      plan,
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
      onMigration: true,
    });
    const f = report.findings.find((x) => x.kind === 'automatic_startup_lane_mismatch');
    expect(f?.autoApplyWithoutPrompt).toBe(true);
  });
});

describe('buildDoctorRepairReport — missing', async () => {
  it('case #13/#14 — no startup + install action yields missing finding', async () => {
    const plan = makePlan({
      actions: [{ kind: 'install-default-following-service', releaseChannel: 'publicdev', mode: 'user' }],
    });
    const report = await basic(plan, []);
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain('automatic_startup_missing');
    const f = report.findings.find((x) => x.kind === 'automatic_startup_missing');
    // preview/dev default is not auto-apply
    expect(f?.autoApplyWithoutPrompt).toBe(false);
  });

  it('stable missing auto-applies', async () => {
    const plan = makePlan({
      actions: [{ kind: 'install-default-following-service', releaseChannel: 'stable', mode: 'user' }],
    });
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli({ releaseChannel: 'stable', ringId: 'stable' }),
      automaticStartup: [],
      currentlyRunning: [],
      localRelays: [],
      plan,
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
    });
    const f = report.findings.find((x) => x.kind === 'automatic_startup_missing');
    expect(f?.autoApplyWithoutPrompt).toBe(true);
  });
});

describe('buildDoctorRepairReport — running daemon mismatch', async () => {
  it('manual older daemon with NO managing service → daemon-takeover strategy + requires prompt', async () => {
    const running: RunningDaemonEntry = {
      serverId: 'orphan-profile', // no matching automaticStartup entry
      pid: 1234,
      httpPort: 41800,
      startedBy: 'manual',
      startedWithReleaseChannel: 'dev',
      startedWithCliVersion: '0.11.9',
      matchesCurrentCli: false,
      staleStateFile: false,
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [makeAutomaticStartupEntry()], // serverId: 'default' — doesn't match
      currentlyRunning: [running],
      localRelays: [],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
      latestRelayVersionForCurrentChannel: null,
    });
    const f = report.findings.find((x) => x.kind === 'running_daemon_cli_mismatch');
    expect(f).toBeDefined();
    // No managing service exists → classifier picks daemon-takeover; manual
    // daemon-takeover is surprise-prone, so we require an explicit prompt.
    expect(f?.autoApplyWithoutPrompt).toBe(false);
    expect(f?.kind === 'running_daemon_cli_mismatch' && f.recoveryStrategy)
      .toBe('daemon-takeover');
  });

  it('manual older daemon WITH a managing service on the same profile → service-restart strategy + auto-applies', async () => {
    // The scenario from the screenshot: user has an installed auto-starting
    // service owning serverId `default` on the current channel; a separate
    // manual daemon is also running on `default` at an older version. The
    // correct recovery is to restart the service (takes over the profile),
    // not a daemon --takeover which the service install guard would refuse.
    const running: RunningDaemonEntry = {
      serverId: 'default',
      pid: 1234,
      httpPort: 41800,
      startedBy: 'manual',
      startedWithReleaseChannel: 'dev',
      startedWithCliVersion: '0.11.9',
      matchesCurrentCli: false,
      staleStateFile: false,
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [makeAutomaticStartupEntry()],
      currentlyRunning: [running],
      localRelays: [],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
      latestRelayVersionForCurrentChannel: null,
    });
    const f = report.findings.find((x) => x.kind === 'running_daemon_cli_mismatch');
    expect(f).toBeDefined();
    expect(f?.autoApplyWithoutPrompt).toBe(true);
    expect(f?.kind === 'running_daemon_cli_mismatch' && f.recoveryStrategy)
      .toBe('service-restart');
  });

  it('service-managed mismatch auto-applies', async () => {
    const running: RunningDaemonEntry = {
      serverId: 'default',
      pid: 1234,
      httpPort: 41800,
      startedBy: 'automatic-startup',
      startedWithReleaseChannel: 'dev',
      startedWithCliVersion: '0.11.9',
      matchesCurrentCli: false,
      staleStateFile: false,
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [makeAutomaticStartupEntry()],
      currentlyRunning: [running],
      localRelays: [],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
    });
    const f = report.findings.find((x) => x.kind === 'running_daemon_cli_mismatch');
    expect(f?.autoApplyWithoutPrompt).toBe(true);
  });
});

describe('buildDoctorRepairReport — duplicate profile', async () => {
  it('case #10 — two live daemons same serverId → finding', async () => {
    const running: RunningDaemonEntry[] = [
      {
        serverId: 'default',
        pid: 1001,
        httpPort: 41800,
        startedBy: 'automatic-startup',
        startedWithReleaseChannel: 'dev',
        startedWithCliVersion: '0.12.3',
        matchesCurrentCli: true,
        staleStateFile: false,
      },
      {
        serverId: 'default',
        pid: 1002,
        httpPort: 41801,
        startedBy: 'manual',
        startedWithReleaseChannel: 'dev',
        startedWithCliVersion: '0.11.9',
        matchesCurrentCli: false,
        staleStateFile: false,
      },
    ];
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [],
      currentlyRunning: running,
      localRelays: [],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
    });
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain('running_daemon_duplicate_profile');
  });

  it('case #11 — two daemons on different profiles is NOT a finding', async () => {
    const running: RunningDaemonEntry[] = [
      {
        serverId: 'default',
        pid: 1001,
        httpPort: 41800,
        startedBy: 'automatic-startup',
        startedWithReleaseChannel: 'dev',
        startedWithCliVersion: '0.12.3',
        matchesCurrentCli: true,
        staleStateFile: false,
      },
      {
        serverId: 'company',
        pid: 1002,
        httpPort: 41801,
        startedBy: 'manual',
        startedWithReleaseChannel: 'dev',
        startedWithCliVersion: '0.12.3',
        matchesCurrentCli: true,
        staleStateFile: false,
      },
    ];
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [],
      currentlyRunning: running,
      localRelays: [],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
    });
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).not.toContain('running_daemon_duplicate_profile');
  });
});

describe('buildDoctorRepairReport — local relay', async () => {
  it('case #8 — stable relay + dev CLI → lane_missing', async () => {
    const relay: LocalRelayEntry = {
      releaseChannel: 'stable',
      ringId: 'stable',
      mode: 'user',
      version: '0.11.4',
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      relayUrl: 'http://localhost:41870',
      port: 41870,
      installRoot: '/Users/me/.happier/relay-host-stable',
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [makeAutomaticStartupEntry()],
      currentlyRunning: [],
      localRelays: [relay],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
    });
    const f = report.findings.find((x) => x.kind === 'local_relay_lane_missing');
    expect(f).toBeDefined();
    expect(f?.autoApplyWithoutPrompt).toBe(false);
  });

  it('case #9 — dev relay on older version, CLI at latest, latest-known relay newer → version_stale', async () => {
    const relay: LocalRelayEntry = {
      releaseChannel: 'dev',
      ringId: 'publicdev',
      mode: 'user',
      version: '0.12.1',
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      relayUrl: 'http://localhost:41872',
      port: 41872,
      installRoot: '/Users/me/.happier/relay-host-dev',
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli({ version: '0.12.3' }),
      automaticStartup: [makeAutomaticStartupEntry()],
      currentlyRunning: [],
      localRelays: [relay],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
      latestRelayVersionForCurrentChannel: '0.12.3',
    });
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain('local_relay_version_stale');
  });

  it('does NOT flag version_stale when latest-known relay equals installed', async () => {
    const relay: LocalRelayEntry = {
      releaseChannel: 'dev',
      ringId: 'publicdev',
      mode: 'user',
      version: '0.12.3',
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      relayUrl: 'http://localhost:41872',
      port: 41872,
      installRoot: '/Users/me/.happier/relay-host-dev',
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli({ version: '0.12.3' }),
      automaticStartup: [makeAutomaticStartupEntry()],
      currentlyRunning: [],
      localRelays: [relay],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
      latestRelayVersionForCurrentChannel: '0.12.3',
    });
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).not.toContain('local_relay_version_stale');
  });
});

describe('buildDoctorRepairReport — ordering', async () => {
  it('findings are sorted by canonical order (foreign_home first)', async () => {
    const running: RunningDaemonEntry = {
      serverId: 'default',
      pid: 1,
      httpPort: null,
      startedBy: 'manual',
      startedWithReleaseChannel: 'stable',
      startedWithCliVersion: '0.11.0',
      matchesCurrentCli: false,
      staleStateFile: false,
    };
    const relay: LocalRelayEntry = {
      releaseChannel: 'stable',
      ringId: 'stable',
      mode: 'user',
      version: '0.11.0',
      serviceActive: true,
      serviceEnabled: true,
      healthy: true,
      relayUrl: 'http://localhost:41870',
      port: 41870,
      installRoot: '/x',
    };
    const report = await buildDoctorRepairReport({
      currentCli: makeCurrentCli(),
      automaticStartup: [makeAutomaticStartupEntry()],
      currentlyRunning: [running],
      localRelays: [relay],
      plan: makePlan(),
      currentServerId: 'default',
      preferredMode: 'user',
    latestRelayVersionForCurrentChannel: null,
    });
    // running daemon mismatch should come before local_relay
    const runIdx = report.findings.findIndex((f) => f.kind === 'running_daemon_cli_mismatch');
    const relayIdx = report.findings.findIndex((f) => f.kind === 'local_relay_lane_missing');
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(relayIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeLessThan(relayIdx);
  });
});
