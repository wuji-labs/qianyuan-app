import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockDaemonServiceListEntry = {
  serverId: string;
  name: string;
  installed: boolean;
  path: string;
  platform: string;
  releaseChannel: string;
  label: string;
  targetMode: string;
};

type MockRepairPlan = {
  currentReleaseChannel: string;
  existingServices: MockDaemonServiceListEntry[];
  actions: Array<{ kind: 'install-default-following-service'; releaseChannel: string }>;
  manualWarnings: [];
};

const {
  buildBackgroundServiceRepairPlanMock,
  handleServiceRepairCliCommandMock,
  resolveDaemonServiceCliRuntimeFromEnvMock,
  resolveDaemonServiceListEntriesMock,
} = vi.hoisted(() => ({
  buildBackgroundServiceRepairPlanMock: vi.fn<(_params: unknown) => MockRepairPlan>((_params: unknown) => ({
    currentReleaseChannel: 'preview',
    existingServices: [],
    actions: [{ kind: 'install-default-following-service', releaseChannel: 'preview' }],
    manualWarnings: [],
  })),
  handleServiceRepairCliCommandMock: vi.fn(async (_params: unknown) => undefined),
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn((_params?: unknown) => ({
    platform: 'linux',
    mode: 'user',
    systemUser: '',
    channel: 'preview',
    targetMode: 'default-following',
    instanceId: 'default',
    uid: 1000,
    userHomeDir: '/tmp/user',
    happierHomeDir: '/tmp/user/.happier',
    serverUrl: 'https://company.example.test',
    publicServerUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
  })),
  resolveDaemonServiceListEntriesMock: vi.fn<(_runtime: unknown, _options?: unknown) => Promise<MockDaemonServiceListEntry[]>>(async (_runtime: unknown, _options?: unknown) => []),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
  resolveDaemonServiceListEntries: (runtime: unknown, options?: unknown) => resolveDaemonServiceListEntriesMock(runtime, options),
}));

vi.mock('@/diagnostics/backgroundServiceRepair', () => ({
  buildBackgroundServiceRepairPlan: (params: unknown) => buildBackgroundServiceRepairPlanMock(params),
}));

vi.mock('../serviceRepair/handleServiceRepairCliCommand', () => ({
  handleServiceRepairCliCommand: (params: unknown) => handleServiceRepairCliCommandMock(params),
}));

describe('maybeRunVersionGatedRuntimeMigration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    buildBackgroundServiceRepairPlanMock.mockClear();
    handleServiceRepairCliCommandMock.mockClear();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockClear();
    resolveDaemonServiceListEntriesMock.mockClear();
  });

  it('delegates to service repair when an update crosses the 0.2.3 migration boundary and repair work exists', async () => {
    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      argv: ['repair'],
      commandPath: 'happier self migrate',
    })).resolves.toBe(true);

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).toHaveBeenCalled();
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenCalled();
    expect(buildBackgroundServiceRepairPlanMock).toHaveBeenCalledWith({
      currentReleaseChannel: 'preview',
      services: [],
    });
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--mode', 'user'],
      commandPath: 'happier self migrate',
    });
  });

  it('skips repair when the version change did not cross the migration boundary', async () => {
    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.3',
      toVersion: '0.2.4',
      argv: ['repair'],
      commandPath: 'happier self migrate',
    })).resolves.toBe(false);

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).not.toHaveBeenCalled();
    expect(buildBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });

  it('routes update-triggered migration through system-scoped repair when only system services need work', async () => {
    buildBackgroundServiceRepairPlanMock.mockImplementation((params: unknown) => {
      const { services } = params as { services: MockDaemonServiceListEntry[] };
      return {
        currentReleaseChannel: 'preview',
        existingServices: services,
        actions: services.length > 0
          ? [{ kind: 'install-default-following-service', releaseChannel: 'preview' }]
          : [],
        manualWarnings: [],
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.default.service',
          platform: 'linux',
          releaseChannel: 'preview',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      argv: ['repair'],
      commandPath: 'happier self migrate',
    })).resolves.toBe(false);

    expect(resolveDaemonServiceListEntriesMock).toHaveBeenCalledTimes(2);
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(1, expect.anything(), { mode: 'user' });
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(2, expect.anything(), { mode: 'system' });
    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });

  it('runs only the user-scoped repair pass when system repair also exists but root privileges are unavailable', async () => {
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.default.service',
          platform: 'linux',
          releaseChannel: 'preview',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }];
      }
      return [{
        serverId: 'cloud',
        name: 'Cloud',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    buildBackgroundServiceRepairPlanMock.mockImplementation((params: unknown) => {
      const { services } = params as { services: MockDaemonServiceListEntry[] };
      return {
      currentReleaseChannel: 'preview',
      existingServices: services,
      actions: services.length > 0
        ? [{ kind: 'install-default-following-service', releaseChannel: 'preview' }]
        : [],
      manualWarnings: [],
      };
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      argv: ['repair'],
      commandPath: 'happier self migrate',
    })).resolves.toBe(true);

    expect(handleServiceRepairCliCommandMock).toHaveBeenNthCalledWith(1, {
      argv: ['repair', '--mode', 'user'],
      commandPath: 'happier self migrate',
    });
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledTimes(1);
  });

  it('runs both user and system repair passes when root privileges are available', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'default',
        uid: 0,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.default.service',
          platform: 'linux',
          releaseChannel: 'preview',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }];
      }
      return [{
        serverId: 'cloud',
        name: 'Cloud',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    buildBackgroundServiceRepairPlanMock.mockImplementation((params: unknown) => {
      const { services } = params as { services: MockDaemonServiceListEntry[] };
      return {
        currentReleaseChannel: 'preview',
        existingServices: services,
        actions: services.length > 0
          ? [{ kind: 'install-default-following-service', releaseChannel: 'preview' }]
          : [],
        manualWarnings: [],
      };
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      argv: ['repair'],
      commandPath: 'happier self migrate',
    })).resolves.toBe(true);

    expect(handleServiceRepairCliCommandMock).toHaveBeenNthCalledWith(1, {
      argv: ['repair', '--mode', 'user'],
      commandPath: 'happier self migrate',
    });
    expect(handleServiceRepairCliCommandMock).toHaveBeenNthCalledWith(2, {
      argv: ['repair', '--mode', 'system'],
      commandPath: 'happier self migrate',
    });
  });

  it('skips unsupported system-scoped migration passes on non-linux platforms', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'darwin',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'default',
        uid: 501,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      return normalizedOptions?.mode === 'user'
        ? [{
            serverId: 'cloud',
            name: 'Cloud',
            installed: true,
            path: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
            platform: 'darwin',
            releaseChannel: 'preview',
            label: 'com.happier.cli.daemon.default',
            targetMode: 'default-following',
          }]
        : [];
    });
    buildBackgroundServiceRepairPlanMock.mockImplementation((params: unknown) => {
      const { services } = params as { services: MockDaemonServiceListEntry[] };
      return {
        currentReleaseChannel: 'preview',
        existingServices: services,
        actions: services.length > 0
          ? [{ kind: 'install-default-following-service', releaseChannel: 'preview' }]
          : [],
        manualWarnings: [],
      };
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      argv: ['repair'],
      commandPath: 'happier self migrate',
    })).resolves.toBe(true);

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledTimes(1);
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--mode', 'user'],
      commandPath: 'happier self migrate',
    });
  });
});
