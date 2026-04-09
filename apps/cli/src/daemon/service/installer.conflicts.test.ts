import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';

const {
  planDaemonServiceInstallMock,
  planDaemonServiceUninstallMock,
  applyDaemonServiceInstallPlanMock,
  applyDaemonServiceUninstallPlanMock,
  resolveDaemonServiceInstallRuntimeTargetMock,
  discoverInstalledDaemonServiceEntriesMock,
} = vi.hoisted(() => ({
  planDaemonServiceInstallMock: vi.fn(() => ({ files: [], commands: [] })),
  planDaemonServiceUninstallMock: vi.fn(() => ({ filesToRemove: [], commands: [] })),
  applyDaemonServiceInstallPlanMock: vi.fn(async () => undefined),
  applyDaemonServiceUninstallPlanMock: vi.fn(async () => undefined),
  resolveDaemonServiceInstallRuntimeTargetMock: vi.fn(async () => ({
    nodePath: '/managed/node',
    entryPath: '/opt/happier/package-dist/index.mjs',
  })),
  discoverInstalledDaemonServiceEntriesMock: vi.fn<() => Promise<readonly InstalledDaemonServiceEntry[]>>(async () => []),
}));

vi.mock('./plan', async () => {
  const actual = await vi.importActual<typeof import('./plan')>('./plan');
  return {
    ...actual,
    planDaemonServiceInstall: planDaemonServiceInstallMock,
    planDaemonServiceUninstall: planDaemonServiceUninstallMock,
  };
});

vi.mock('./apply', async () => {
  const actual = await vi.importActual<typeof import('./apply')>('./apply');
  return {
    ...actual,
    applyDaemonServiceInstallPlan: applyDaemonServiceInstallPlanMock,
    applyDaemonServiceUninstallPlan: applyDaemonServiceUninstallPlanMock,
  };
});

vi.mock('./resolveDaemonServiceInstallRuntimeTarget', () => ({
  resolveDaemonServiceInstallRuntimeTarget: resolveDaemonServiceInstallRuntimeTargetMock,
}));

vi.mock('./discoverInstalledDaemonServiceEntries', () => ({
  discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
}));

describe('installDaemonService conflict handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects conflicting installed services by default', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await expect(installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      runCommands: false,
    })).rejects.toMatchObject({
      code: 'daemon_service_conflict',
    });

    expect(applyDaemonServiceInstallPlanMock).not.toHaveBeenCalled();
  });

  it('removes competing services and reapplies the exact target when replace-all is requested', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'publicdev',
        label: 'happier-daemon.dev.default',
        targetMode: 'default-following',
      },
      {
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.company.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.company',
        targetMode: 'pinned',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-all',
      runCommands: false,
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledTimes(1);
    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'stable',
      targetMode: 'pinned',
      instanceId: 'company',
    }));
    expect(applyDaemonServiceUninstallPlanMock).toHaveBeenCalledTimes(1);
    expect(planDaemonServiceInstallMock).toHaveBeenCalledTimes(1);
    expect(planDaemonServiceInstallMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'publicdev',
      targetMode: 'default-following',
      instanceId: 'default',
      nodePath: '/managed/node',
      entryPath: '/opt/happier/package-dist/index.mjs',
    }));
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it('treats replace-ring for default-following installs as same-release-channel replacement', async () => {
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValueOnce([
      {
        serverId: 'company',
        name: 'Company',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.company.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.company',
        targetMode: 'pinned',
      },
      {
        serverId: 'preview-company',
        name: 'Preview Company',
        installed: true,
        path: '/home/tester/.config/systemd/user/happier-daemon.preview.preview-company.service',
        platform: 'linux',
        releaseChannel: 'preview',
        label: 'happier-daemon.preview.preview-company',
        targetMode: 'pinned',
      },
    ]);

    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/tester',
      happierHomeDir: '/home/tester/.happier',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      strategy: 'replace-ring',
      runCommands: false,
    });

    expect(planDaemonServiceUninstallMock).toHaveBeenCalledTimes(1);
    expect(planDaemonServiceUninstallMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'stable',
      targetMode: 'pinned',
      instanceId: 'company',
    }));
    expect(planDaemonServiceUninstallMock).not.toHaveBeenCalledWith(expect.objectContaining({
      channel: 'preview',
      targetMode: 'pinned',
      instanceId: 'preview-company',
    }));
    expect(applyDaemonServiceInstallPlanMock).toHaveBeenCalledTimes(1);
  });
});
