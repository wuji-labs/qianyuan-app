import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStderr, captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const SCOPED_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_HOME_DIR',
  'PATH',
] as const;

async function loadCliModule(): Promise<typeof import('./cli.js')> {
  return import('./cli.js');
}

describe('runDaemonServiceCliCommand', () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(SCOPED_ENV_KEYS);
    vi.restoreAllMocks();
    vi.unmock('node:child_process');
    vi.unmock('node:os');
    vi.resetModules();
  });

  it('treats -h as help (not as a subcommand)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      await runDaemonServiceCliCommand({ argv: ['-h'] });

      expect(stdout.text()).toContain('Usage:');
      expect(stderr.text()).not.toContain('Unknown daemon service subcommand');
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  it('resolves the daemon service user home from the real OS user even when HOME is stack-isolated', async () => {
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        userInfo: vi.fn(() => ({ homedir: '/real-user-home' })),
        homedir: vi.fn(() => '/isolated-stack-home'),
      };
    });

    const { resolveDaemonServiceCliRuntimeFromEnv } = await loadCliModule();
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HOME: '/isolated-stack-home',
        USERPROFILE: '/isolated-stack-home',
      },
    });

    expect(runtime.userHomeDir).toBe('/real-user-home');
  });

  it('expands ~/ daemon service home overrides against the provided HOME', async () => {
    const { resolveDaemonServiceCliRuntimeFromEnv } = await loadCliModule();
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HOME: '/scoped/home',
        USERPROFILE: '/scoped/home',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '~/service-home',
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '~/service-happier',
      },
    });

    expect(runtime.userHomeDir).toBe('/scoped/home/service-home');
    expect(runtime.happierHomeDir).toBe('/scoped/home/service-happier');
  });

  it('prefers the configured API server URL when resolving pinned service targets from env', async () => {
    const { resolveDaemonServiceCliRuntimeFromEnv } = await loadCliModule();
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
        HAPPIER_PUBLIC_SERVER_URL: 'https://public.example.test',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:4010',
        HAPPIER_WEBAPP_URL: 'https://app.example.test',
      },
    });

    expect(runtime.serverUrl).toBe('http://127.0.0.1:4010');
    expect(runtime.publicServerUrl).toBe('https://public.example.test');
    expect(runtime.webappUrl).toBe('https://app.example.test');
  });

  it('supports help JSON output', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      commands: string[];
      flags: string[];
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['--help', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.commands).toContain('list');
      expect(payload.commands).toContain('install');
      expect(payload.flags).toContain('--json');
    } finally {
      output.restore();
    }
  });

  it('treats --mode system as a flag (not as a subcommand) and reports systemd system paths (linux)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      platform: string;
      paths: { unitPath?: string; unitName?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.platform).toBe('linux');
      expect(payload.paths.unitPath).toContain('/etc/systemd/system/');
      expect(payload.paths.unitName).toContain('happier-daemon.');
    } finally {
      output.restore();
    }
  });

  it('defaults service install dry-runs to the singleton default background service', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.plan.files[0]?.path).toBe('/tmp/.config/systemd/user/happier-daemon.default.service');
      expect(payload.plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following');
      expect(payload.plan.files[0]?.content).toContain('Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=preview');
      expect(payload.plan.files[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=');
      expect(payload.plan.files[0]?.content).not.toContain('Environment=HAPPIER_SERVER_URL=');
    } finally {
      output.restore();
    }
  });

  it('rejects invalid --mode values', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--mode', 'systm'] })).rejects.toThrow(
      'Invalid --mode value "systm" (expected user|system)',
    );
  });

  it('fails closed when --mode system is requested on unsupported platforms', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();

    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system'] })).rejects.toThrow(
      'System mode background services are only supported on Linux',
    );

    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system'] })).rejects.toThrow(
      'System mode background services are only supported on Linux',
    );
  });

  it('uses the target linux system user home for system install planning and log paths', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          pid: 1,
          output: ['', 'happier:x:1001:1001::/home/happier:/bin/bash\n', ''],
          stdout: 'happier:x:1001:1001::/home/happier:/bin/bash\n',
          stderr: '',
          status: 0,
          signal: null,
        })),
      };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/root'),
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const processWithGetuid = process as typeof process & { getuid: () => number };
    vi.spyOn(processWithGetuid, 'getuid').mockReturnValue(0);
    const installOutput = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.company.service');
      expect(installPayload.plan.files[0]?.content).toContain('User=happier');
      expect(installPayload.plan.files[0]?.content).toContain('WorkingDirectory=/home/happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_HOME_DIR=/home/happier/.happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=PATH=');
      expect(installPayload.plan.files[0]?.content).toContain('/home/happier/.local/bin');
      expect(installPayload.plan.files[0]?.content).toContain('/home/happier/bin');
      expect(installPayload.plan.files[0]?.content).not.toContain('/root/.local/bin');
      expect(installPayload.plan.files[0]?.content).not.toContain('/root/.happier');
    } finally {
      installOutput.restore();
    }

    const pathsOutput = captureStdoutJsonOutput<{
      ok: boolean;
      paths: { stdoutPath?: string; stderrPath?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const pathsPayload = pathsOutput.json();
      expect(pathsPayload.ok).toBe(true);
      expect(pathsPayload.paths.stdoutPath).toBe('/home/happier/.happier/logs/daemon-service.company.out.log');
      expect(pathsPayload.paths.stderrPath).toBe('/home/happier/.happier/logs/daemon-service.company.err.log');
    } finally {
      pathsOutput.restore();
    }
  });

  it('scopes systemd unit names by release channel so dev services can coexist with stable', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          pid: 1,
          output: ['', 'happier:x:1001:1001::/home/happier:/bin/bash\n', ''],
          stdout: 'happier:x:1001:1001::/home/happier:/bin/bash\n',
          stderr: '',
          status: 0,
          signal: null,
        })),
      };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/root'),
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'dev',
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const processWithGetuid = process as typeof process & { getuid: () => number };
    vi.spyOn(processWithGetuid, 'getuid').mockReturnValue(0);

    const installOutput = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.dev.company.service');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=dev');
    } finally {
      installOutput.restore();
    }
  });

  it('reports daemon service status as not installed when the service file is absent', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      installed: boolean;
      daemon?: { running: boolean };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.installed).toBe(false);
      expect(payload.daemon?.running).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('fails closed when starting a daemon service that is not installed', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      error: string;
      message: string;
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['start', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('not_installed');
      expect(payload.message).toContain('Background service is not installed');
    } finally {
      output.restore();
    }
  });

  it('uninstalls every discovered service when --all --yes is provided', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-daemon-service-uninstall-all-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(homeDir, '.happier');
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const stableUnitPath = join(homeDir, '.config', 'systemd', 'user', 'happier-daemon.company.prod.service');
        const previewUnitPath = join(homeDir, '.config', 'systemd', 'user', 'happier-daemon.preview.company.prod.service');
        await mkdir(join(homeDir, '.config', 'systemd', 'user'), { recursive: true });
        await writeFile(stableUnitPath, '# stable\n', 'utf8');
        await writeFile(previewUnitPath, '# preview\n', 'utf8');

        const output = captureStdoutJsonOutput<{
          ok: boolean;
          removed?: number;
        }>();
        try {
          await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--yes', '--json'] });

          expect(output.json()).toEqual(expect.objectContaining({ ok: true, removed: 2 }));
          expect(existsSync(stableUnitPath)).toBe(false);
          expect(existsSync(previewUnitPath)).toBe(false);
        } finally {
          output.restore();
        }
      },
    );
  });
});
