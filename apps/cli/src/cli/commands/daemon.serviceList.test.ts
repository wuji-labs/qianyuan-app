import { join, dirname } from 'node:path';
import * as fs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import {
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureStdout } from '@/testkit/logger/captureOutput';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { handleServiceCliCommand } from './service';
import { handleDaemonCliCommand } from './daemon';

describe('happier daemon service list', () => {
  it('lists installed background services through the canonical service command', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir, {
          servers: {
            'company.prod': {
              id: 'company.prod',
              name: 'Company Prod',
              serverUrl: 'https://company-prod.example.test',
              webappUrl: 'https://company-prod.example.test',
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          },
        });

        const unitDir = join(homeDir, '.config', 'systemd', 'user');
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(join(unitDir, 'happier-daemon.company.prod.service'), '# fake', 'utf-8');

        const output = captureStdoutJsonOutput<{
          entries?: Array<{
            serverId?: string;
            installed?: boolean;
            path?: string;
            platform?: string;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serverId: 'company.prod',
              installed: true,
              path: join(homeDir, '.config', 'systemd', 'user', 'happier-daemon.company.prod.service'),
            }),
          ]));
        } finally {
          output.restore();
        }
      },
    );
  });

  it('reports a default background service with explicit target mode and pinned release channel', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-service-list-default-following-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const unitDir = join(homeDir, '.config', 'systemd', 'user');
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(
          join(unitDir, 'happier-daemon.default.service'),
          [
            '[Service]',
            'Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following',
            'Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=preview',
          ].join('\n'),
          'utf-8',
        );

        const output = captureStdoutJsonOutput<{
          services?: Array<{
            serviceType?: string;
            ring?: string;
            label?: string;
            targetMode?: string | null;
          }>;
        }>();
        try {
          await handleServiceCliCommand({ args: ['service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serviceType: 'daemon',
              ring: 'preview',
              targetMode: 'default-following',
              label: 'happier-daemon.default',
            }),
          ]));
        } finally {
          output.restore();
        }
      },
    );
  });

  it('lists per-server installed unit paths on linux', async () => {
    const output = captureStdout();

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-service-list-',
          env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
          },
        },
        async ({ homeDir }) => {
          process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
          process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
          await writeDaemonSettingsFixture(homeDir, {
            servers: {
              'company.prod': {
                id: 'company.prod',
                name: 'Company Prod',
                serverUrl: 'https://company-prod.example.test',
                webappUrl: 'https://company-prod.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
          });

          const unitDir = join(homeDir, '.config', 'systemd', 'user');
          fs.mkdirSync(unitDir, { recursive: true });
          fs.writeFileSync(join(unitDir, 'happier-daemon.company.prod.service'), '# fake', 'utf-8');

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list'], rawArgv: [], terminalRuntime: null });

          const out = output.text();
          expect(out).toContain('company.prod');
          expect(out).toContain('happier-daemon.company.prod.service');
          expect(out.toLowerCase()).toContain('installed');
        },
      );
    } finally {
      output.restore();
    }
  });

  it('prints per-server service entries as JSON on Windows with installed-path parity', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-daemon-service-list-json-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(homeDir, '.happier');
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const runtime = resolveDaemonServiceCliRuntimeFromEnv({
          processEnv: {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
            HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://company.example.test',
            HAPPIER_DAEMON_SERVICE_WEBAPP_URL: 'https://company.example.test',
          },
        });
        const wrapperPath = resolveDaemonServicePaths(runtime).wrapperPath;
        fs.mkdirSync(dirname(wrapperPath), { recursive: true });
        fs.writeFileSync(wrapperPath, '# fake', 'utf-8');
        expect(fs.existsSync(wrapperPath)).toBe(true);

        const output = captureStdoutJsonOutput<{
          entries?: Array<{
            serverId?: string;
            installed?: boolean;
            path?: string;
            platform?: string;
            releaseChannel?: string;
          }>;
          services?: Array<{
            serviceType?: string;
            ring?: string;
            label?: string;
            targetMode?: string | null;
          }>;
        }>();

        try {
          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serverId: 'company',
              installed: true,
              platform: 'win32',
              path: wrapperPath,
              releaseChannel: 'stable',
            }),
          ]));
          expect(output.json().services).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serviceType: 'daemon',
              ring: 'stable',
              targetMode: 'pinned',
            }),
          ]));
          expect(output.json().services?.[0]?.label).toContain('happier-daemon.company');
        } finally {
          output.restore();
        }
      },
    );
  });

  it('expands ~/ daemon service home overrides before listing installed entries', async () => {
    const output = captureStdoutJsonOutput<{
      entries?: Array<{
        serverId?: string;
        installed?: boolean;
        path?: string;
        platform?: string;
      }>;
    }>();

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-service-list-tilde-',
          env: {
            HOME: '/tmp/placeholder',
            USERPROFILE: '/tmp/placeholder',
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '~/service-home',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '~/service-happier',
          },
        },
        async ({ homeDir }) => {
          const scopedHome = join(homeDir, 'scoped-home');
          process.env.HOME = scopedHome;
          process.env.USERPROFILE = scopedHome;
          await writeDaemonSettingsFixture(homeDir);

          const unitPath = join(scopedHome, 'service-home', '.config', 'systemd', 'user', 'happier-daemon.company.service');
          fs.mkdirSync(dirname(unitPath), { recursive: true });
          fs.writeFileSync(unitPath, '# fake', 'utf-8');

          await handleDaemonCliCommand({ args: ['daemon', 'service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serverId: 'company',
              installed: true,
              platform: 'linux',
              path: unitPath,
            }),
          ]));
        },
      );
    } finally {
      output.restore();
    }
  });

  it('uses the real OS user home for service listing when HOME is stack-isolated and no explicit override is set', async () => {
    let mockedRealHomeDir = '';
    vi.resetModules();
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/isolated-stack-home'),
        userInfo: vi.fn(() => ({ homedir: mockedRealHomeDir })),
      };
    });

    const output = captureStdoutJsonOutput<{
      entries?: Array<{
        serverId?: string;
        installed?: boolean;
        path?: string;
        platform?: string;
      }>;
    }>();

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-service-list-real-home-',
          env: {
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '',
            HOME: '/isolated-stack-home',
            USERPROFILE: '/isolated-stack-home',
          },
        },
        async ({ homeDir }) => {
          mockedRealHomeDir = join(homeDir, 'real-user-home');
          await writeDaemonSettingsFixture(homeDir);

          const unitPath = join(mockedRealHomeDir, '.config', 'systemd', 'user', 'happier-daemon.company.service');
          fs.mkdirSync(dirname(unitPath), { recursive: true });
          fs.writeFileSync(unitPath, '# fake', 'utf-8');

          const { handleDaemonCliCommand: handleCommand } = await import('./daemon');
          await handleCommand({ args: ['daemon', 'service', 'list', '--json'], rawArgv: [], terminalRuntime: null });

          expect(output.json().entries).toEqual(expect.arrayContaining([
            expect.objectContaining({
              serverId: 'company',
              installed: true,
              platform: 'linux',
              path: unitPath,
            }),
          ]));
        },
      );
    } finally {
      output.restore();
      vi.doUnmock('node:os');
      vi.resetModules();
    }
  });
});
