import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { reloadConfiguration } from '@/configuration';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

const spawnDetachedDaemonStartSyncMock = vi.fn(async () => ({ unref() {} }));
vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
    spawnDetachedDaemonStartSync: spawnDetachedDaemonStartSyncMock,
}));

describe('ensureDaemonRunningForSessionCommand conflict handling', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
        'HAPPIER_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
    ]);

    afterEach(() => {
        envScope.restore();
        spawnDetachedDaemonStartSyncMock.mockClear();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('warns and skips autostart when a different background service is already running for the selected server', async () => {
        await withTempDir('happier-ensure-daemon-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { ensureDaemonRunningForSessionCommand }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/ensureDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43112,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-conflict',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const output = captureConsoleText();
            try {
                spawnDetachedDaemonStartSyncMock.mockClear();
                await ensureDaemonRunningForSessionCommand();
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('background service');
            expect(output.text()).toContain('selected server');
            expect(output.text()).toContain('happier doctor repair');
        });
    });

    it('warns and skips autostart when a different manually started daemon is already running for the selected server', async () => {
        await withTempDir('happier-ensure-daemon-manual-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { ensureDaemonRunningForSessionCommand }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/ensureDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-manual-conflict',
                startupSource: 'manual',
            });

            const output = captureConsoleText();
            try {
                spawnDetachedDaemonStartSyncMock.mockClear();
                await ensureDaemonRunningForSessionCommand();
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('manually started daemon');
            expect(output.text()).toContain('without starting another daemon');
            expect(output.text()).toContain('happier daemon restart');
        });
    });

    it('warns and skips autostart when a background service is installed but no daemon is active', async () => {
        await withTempDir('happier-ensure-daemon-installed-service-', async (homeDir) => {
            const happierHomeDir = `${homeDir}/.happier`;
            envScope.patch({
                HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: '',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                HAPPIER_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_PUBLIC_SERVER_URL: 'https://cloud.example.test',
                HAPPIER_WEBAPP_URL: 'https://cloud.example.test',
            });
            reloadConfiguration();
            vi.resetModules();

            const [{ ensureDaemonRunningForSessionCommand }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, controlClient] = await Promise.all([
                import('@/daemon/ensureDaemon'),
                import('@/daemon/service/cli'),
                import('@/daemon/controlClient'),
            ]);
            vi.spyOn(controlClient, 'isDaemonRunningCurrentlyInstalledHappyVersion').mockResolvedValueOnce(false);

            await writeDaemonSettingsFixture(happierHomeDir, {
                servers: {
                    cloud: {
                        id: 'cloud',
                        name: 'Cloud',
                        serverUrl: 'https://cloud.example.test',
                        webappUrl: 'https://cloud.example.test',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                    },
                },
            });

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const output = captureConsoleText();
            try {
                spawnDetachedDaemonStartSyncMock.mockClear();
                await ensureDaemonRunningForSessionCommand();
            } finally {
                output.restore();
            }

            expect(spawnDetachedDaemonStartSyncMock).not.toHaveBeenCalled();
            expect(output.text()).toContain('A background service is already installed');
            expect(output.text()).toContain('happier service start');
        });
    });
});
