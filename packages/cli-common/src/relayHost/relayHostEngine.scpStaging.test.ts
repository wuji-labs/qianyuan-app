import { describe, expect, it } from 'vitest';

import { createRelayHostEngine } from './relayHostEngine.js';

describe('RelayHostEngine (remote SSH)', () => {
  it('fails closed when another remote relay lane already occupies the same base URL', async () => {
    let installCalls = 0;

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('/self-host-state.json') && command.includes('/self-host-preview/')) {
          return { status: 1, stdout: '', stderr: 'missing\n' };
        }
        if (command.includes('/self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env') && command.includes('/self-host/config/')) {
          return { status: 0, stdout: 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return { status: 0, stdout: 'ActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => {
        installCalls += 1;
        return { binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' };
      },
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    })).rejects.toThrow(/stable/i);

    expect(installCalls).toBe(0);
  });

  it('restarts the systemd service on install so updated unit/env changes take effect', async () => {
    let serviceInstallCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('daemon-reload') && command.includes('enable')) {
          serviceInstallCommand = command;
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(serviceInstallCommand).toContain('systemctl --user daemon-reload');
    expect(serviceInstallCommand).toContain('systemctl --user enable');
    expect(serviceInstallCommand).toContain('systemctl --user restart');
    expect(serviceInstallCommand).toContain('XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"');
    expect(serviceInstallCommand).toContain('DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"');
    expect(serviceInstallCommand).not.toContain('enable --now');
  });

  it('uses server.env to report the configured baseUrl (instead of defaults)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=0.0.0.0\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'system',
    });

    expect(status.baseUrl).toBe('http://127.0.0.1:24851');
  });

  it('returns the configured relayUrl from installOrUpdate (including env overrides such as PORT)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    const result = await engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      env: {
        PORT: '24851',
      },
    });

    expect(result.relayUrl).toBe('http://127.0.0.1:24851');
  });

  it('preserves an existing remote PORT when installOrUpdate runs without an explicit override', async () => {
    let stagedEnvText = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          stagedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    const result = await engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(result.relayUrl).toBe('http://127.0.0.1:24851');
    expect(stagedEnvText).toContain('PORT=24851');
  });

  it('parses systemd service state from key=value output (order-independent)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=activating\nSubState=auto-restart\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(status.service).toEqual({ enabled: true, active: false });
  });

  it('reports the remote relay as unhealthy when the service is active but the health probe fails', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('/v1/version')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(status.service).toEqual({ enabled: true, active: true });
    expect(status.healthy).toBe(false);
  });

  it('uses an scp-safe remote stage path when staging under $HOME', async () => {
    const copiedRemotePaths: string[] = [];

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async () => ({ status: 0, stdout: 'no', stderr: '' }),
      copyLocalDirectoryToRemote: async ({ remotePath }) => {
        copiedRemotePaths.push(remotePath);
      },
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(copiedRemotePaths.some((path) => path.startsWith('$HOME'))).toBe(false);
    expect(copiedRemotePaths.some((path) => path.startsWith('.happier/bootstrap-staging/relay-runtime-123'))).toBe(true);
    expect(copiedRemotePaths.some((path) => path.startsWith('.happier/bootstrap-staging/relay-service-'))).toBe(true);
  });

  it('writes remote relay env with migrations rooted in the installed server payload', async () => {
    let renderedEnvText = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          renderedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(renderedEnvText).toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/home/remote-user/.happier/happier-server/current/prisma/sqlite/migrations');
  });

  it('does not pin PRISMA_QUERY_ENGINE_LIBRARY in remote relay env', async () => {
    let renderedEnvText = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          renderedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(renderedEnvText).not.toContain('PRISMA_QUERY_ENGINE_LIBRARY=');
  });

  it('installs a local server binary override onto the remote host before rendering relay env', async () => {
    let renderedEnvText = '';
    let capturedLocalBinaryPath: string | undefined;

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          renderedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId, localBinaryPath }) => {
        if (componentId === 'happier-server') {
          capturedLocalBinaryPath = localBinaryPath;
        }
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
      selfHostRelayBinaryOverride: '/tmp/local/happier-server',
    });

    expect(capturedLocalBinaryPath).toBe('/tmp/local/happier-server');
    expect(renderedEnvText).toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/home/remote-user/.happier/happier-server/current/prisma/sqlite/migrations');
    expect(renderedEnvText).not.toContain('/tmp/local/happier-server');
  });

  it('fails installOrUpdate when the remote relay health probe does not become ready', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        if (command.includes('/v1/version')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: 'PrismaClientInitializationError: missing query engine\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => ({
        binaryPath: componentId === 'happier-cli'
          ? '$HOME/.happier/happier-cli/current/happier'
          : '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    })).rejects.toThrow(/healthy/i);
  });

  it('rejects remote start when the service command succeeds but the relay never becomes healthy', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('systemctl') && command.includes(' start ')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/v1/version')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: 'startup failed\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      action: 'start',
    })).rejects.toThrow(/healthy/i);
  });

  it('runs the remote relay health probe after start', async () => {
    let healthProbeCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes(' start ')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/v1/version')) {
          healthProbeCommand = command;
          return { status: 0, stdout: 'HAPPIER_RELAY_HEALTH_OK\n', stderr: '' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      action: 'start',
    })).resolves.toBeUndefined();

    expect(healthProbeCommand).toContain('MAX=120');
    expect(healthProbeCommand).toContain('sleep 1');
    expect(healthProbeCommand).toContain('http://127.0.0.1:24851/v1/version');
  });

  it('rejects remote restart when the relay never becomes healthy again', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes(' restart ')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/v1/version')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: 'restart failed\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      action: 'restart',
    })).rejects.toThrow(/healthy/i);
  });

  it('reports a remote relay as healthy only when the health probe succeeds', async () => {
    let healthProbeCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('systemctl --user show')) {
          return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n', stderr: '' };
        }
        if (command.includes('/v1/version')) {
          healthProbeCommand = command;
          return { status: 0, stdout: 'HAPPIER_RELAY_HEALTH_OK\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    });

    expect(status.service.enabled).toBe(true);
    expect(status.service.active).toBe(true);
    expect(status.healthy).toBe(true);
    expect(healthProbeCommand).toContain('http://127.0.0.1:3005/v1/version');
  });

  it('reports a remote relay as unhealthy when the service is active but the health probe fails', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('systemctl --user show')) {
          return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n', stderr: '' };
        }
        if (command.includes('/v1/version')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    });

    expect(status.service.enabled).toBe(true);
    expect(status.service.active).toBe(true);
    expect(status.healthy).toBe(false);
  });
});
