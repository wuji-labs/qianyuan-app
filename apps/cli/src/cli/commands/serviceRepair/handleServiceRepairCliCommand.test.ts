import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  applyBackgroundServiceRepairPlanMock,
  buildBackgroundServiceRepairPlanMock,
  resolveDaemonServiceCliRuntimeFromEnvMock,
  resolveDaemonServiceListEntriesMock,
} = vi.hoisted(() => ({
  applyBackgroundServiceRepairPlanMock: vi.fn(async (_plan: unknown, _runtime: unknown) => ({ executedActions: [] })),
  buildBackgroundServiceRepairPlanMock: vi.fn((_params: unknown) => ({
    currentReleaseChannel: 'stable',
    existingServices: [],
    actions: [{ kind: 'install-default-following-service', releaseChannel: 'stable' }],
    manualWarnings: [],
  })),
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn((_params?: unknown) => ({
    platform: 'linux',
    channel: 'stable',
    targetMode: 'default-following',
    instanceId: 'default',
    uid: 1000,
    userHomeDir: '/tmp/user',
    happierHomeDir: '/tmp/user/.happier',
    serverUrl: 'https://example.test',
    publicServerUrl: 'https://example.test',
    webappUrl: 'https://app.example.test',
    nodePath: '/usr/bin/node',
    entryPath: '/opt/happier/index.mjs',
  })),
  resolveDaemonServiceListEntriesMock: vi.fn(async (_runtime: unknown, _options?: unknown) => []),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
  resolveDaemonServiceListEntries: (runtime: unknown, options?: unknown) => resolveDaemonServiceListEntriesMock(runtime, options),
}));

vi.mock('@/diagnostics/backgroundServiceRepair', () => ({
  buildBackgroundServiceRepairPlan: (params: unknown) => buildBackgroundServiceRepairPlanMock(params),
  applyBackgroundServiceRepairPlan: (plan: unknown, runtime: unknown) => applyBackgroundServiceRepairPlanMock(plan, runtime),
}));

describe('handleServiceRepairCliCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    applyBackgroundServiceRepairPlanMock.mockClear();
    buildBackgroundServiceRepairPlanMock.mockClear();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockClear();
    resolveDaemonServiceListEntriesMock.mockClear();
  });

  it('fails closed when executing system-scoped repair on linux without root privileges', async () => {
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode background-service repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('fails closed for system-scoped json repair on linux without root privileges', async () => {
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode background-service repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('rejects system-scoped repair on unsupported platforms', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockReturnValueOnce({
      platform: 'darwin',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      uid: 501,
      userHomeDir: '/tmp/user',
      happierHomeDir: '/tmp/user/.happier',
      serverUrl: 'https://example.test',
      publicServerUrl: 'https://example.test',
      webappUrl: 'https://app.example.test',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/happier/index.mjs',
    });
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('System mode background services are only supported on Linux');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });
});
