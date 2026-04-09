import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
  installDaemonServiceMock,
  resolveDaemonServiceInstallRuntimeTargetMock,
} = vi.hoisted(() => ({
  installDaemonServiceMock: vi.fn(async () => undefined),
  resolveDaemonServiceInstallRuntimeTargetMock: vi.fn(async () => ({
    nodePath: '/managed/node',
    entryPath: '/opt/happier/package-dist/index.mjs',
  })),
}));

vi.mock('./installer', () => ({
  installDaemonService: installDaemonServiceMock,
  uninstallDaemonService: vi.fn(async () => undefined),
}));

vi.mock('./resolveDaemonServiceInstallRuntimeTarget', () => ({
  resolveDaemonServiceInstallRuntimeTarget: resolveDaemonServiceInstallRuntimeTargetMock,
}));

describe('runDaemonServiceCliCommand install conflict preflight', () => {
  const envKeys = [
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    'HAPPIER_DAEMON_SERVICE_CHANNEL',
    'HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('fails closed by default when another verified background service is already installed', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; error?: string; message?: string }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      installDaemonServiceMock.mockRejectedValueOnce(Object.assign(
        new Error('Competing background services detected: happier-daemon.default. Re-run with --yes or --replace-existing=ring|all.'),
        {
          code: 'daemon_service_conflict',
          conflicts: [{ label: 'happier-daemon.default' }],
        },
      ));

      await runDaemonServiceCliCommand({ argv: ['install', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: false,
        error: 'daemon_service_conflict',
        message: expect.stringContaining('--replace-existing=ring|all'),
      }));
      expect(resolveDaemonServiceInstallRuntimeTargetMock).toHaveBeenCalledWith(expect.objectContaining({
        targetMode: 'default-following',
      }));
      expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
        strategy: undefined,
      }));
    } finally {
      output.restore();
    }
  });

  it('allows explicit add semantics when --yes is provided', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
    });

    const output = captureStdoutJsonOutput<{ ok: boolean }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['install', '--yes', '--json'] });

      expect(output.json().ok).toBe(true);
      expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
        strategy: 'add',
      }));
    } finally {
      output.restore();
    }
  });

  it('passes replace-all to the installer when explicitly requested', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
    });

    const output = captureStdoutJsonOutput<{ ok: boolean }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['install', '--replace-existing=all', '--yes', '--json'] });

      expect(output.json().ok).toBe(true);
      expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
        strategy: 'replace-all',
      }));
    } finally {
      output.restore();
    }
  });
});
