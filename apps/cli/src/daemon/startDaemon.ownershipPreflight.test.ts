import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';

const waitForInitialCredentialsMock = vi.fn(async () => ({ action: 'shutdown' as const }));
type DaemonStartupServiceConflictEvaluation =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'installed-background-service-conflict'; services: readonly DaemonServiceListEntry[] }>;
const {
    evaluateDaemonStartupServiceConflictMock,
    renderDaemonInstalledServiceConflictMock,
} = vi.hoisted(() => ({
    evaluateDaemonStartupServiceConflictMock: vi.fn(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({ kind: 'none' })),
    renderDaemonInstalledServiceConflictMock: vi.fn(() => ({
        title: 'A background service is already installed for the selected relay.',
        lines: [
            'Use `happier service start` to start the installed background service instead of starting another daemon.',
            'If you want to start a manual daemon, stop or replace the installed background service first.',
        ],
    })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
    waitForInitialCredentials: waitForInitialCredentialsMock,
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
    return {
        ...actual,
        evaluateDaemonStartupServiceConflict: evaluateDaemonStartupServiceConflictMock,
        renderDaemonInstalledServiceConflict: renderDaemonInstalledServiceConflictMock,
    };
});

describe('startDaemon ownership preflight', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_STARTUP_SOURCE',
        'HAPPIER_DAEMON_TAKEOVER',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
    ]);
    const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true }),
    } as Response));

    afterEach(() => {
        envScope.restore();
        waitForInitialCredentialsMock.mockReset();
        evaluateDaemonStartupServiceConflictMock.mockReset();
        evaluateDaemonStartupServiceConflictMock.mockImplementation(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({ kind: 'none' }));
        renderDaemonInstalledServiceConflictMock.mockReset();
        renderDaemonInstalledServiceConflictMock.mockImplementation(() => ({
            title: 'A background service is already installed for the selected relay.',
            lines: [
                'Use `happier service start` to start the installed background service instead of starting another daemon.',
                'If you want to start a manual daemon, stop or replace the installed background service first.',
            ],
        }));
        fetchMock.mockReset();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('fails closed before auth setup when a different daemon is already running for the selected relay', async () => {
        await withTempDir('happier-start-daemon-owner-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { startDaemon }, { logger }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(1)');
            } finally {
                exitSpy.mockRestore();
            }

            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Daemon ownership conflict prevented daemon startup');
            expect(logContent).toContain('already running for the selected relay');
            expect(logContent).not.toContain('[DAEMON RUN][FATAL] Failed somewhere unexpectedly');
        });
    });

    it('allows takeover to continue past a manual daemon runtime conflict', async () => {
        await withTempDir('happier-start-daemon-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43115,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows a self-restart to replace the current manual daemon runtime without an explicit takeover flag', async () => {
        await withTempDir('happier-start-daemon-self-restart-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43116,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows replacing a stale manual daemon runtime without an explicit takeover flag', async () => {
        await withTempDir('happier-start-daemon-stale-manual-replace-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43116,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'stable',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('allows takeover to continue past a legacy manual daemon runtime conflict when startup source is missing', async () => {
        await withTempDir('happier-start-daemon-legacy-manual-takeover-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_TAKEOVER: '1',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43117,
                startedAt: Date.now(),
                controlToken: 'control-token',
                startedWithCliVersion: '0.0.0-other',
                runtimeId: 'runtime-legacy-manual',
            });

            await expect(startDaemon()).resolves.toBeUndefined();
            const fetchCalls = fetchMock.mock.calls as Array<readonly unknown[]>;
            expect(fetchCalls.some((call) => String(call[0] ?? '').includes('/stop'))).toBe(true);
            expect(waitForInitialCredentialsMock).toHaveBeenCalledTimes(1);
        });
    });

    it('exits cleanly when automatic startup finds another running daemon for the selected relay', async () => {
        await withTempDir('happier-start-daemon-service-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { startDaemon }] = await Promise.all([
                import('@/persistence'),
                import('./startDaemon'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43120,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                startupSource: 'manual',
                runtimeId: 'runtime-manual',
            });

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(0)');
            } finally {
                exitSpy.mockRestore();
            }

            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
        });
    });

    it('fails closed before auth setup when a background service is installed for the active relay', async () => {
        await withTempDir('happier-start-daemon-installed-service-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();
            vi.stubGlobal('fetch', fetchMock);

            const [{ startDaemon }, { logger }] = await Promise.all([
                import('./startDaemon'),
                import('@/ui/logger'),
            ]);
            evaluateDaemonStartupServiceConflictMock.mockImplementationOnce(async (): Promise<DaemonStartupServiceConflictEvaluation> => ({
                kind: 'installed-background-service-conflict',
                services: [
                    {
                        serverId: 'default',
                        name: 'Default background service',
                        installed: true,
                        path: join(homeDir, 'service', 'happier-daemon.default.service'),
                        platform: 'linux',
                        releaseChannel: 'stable',
                        label: 'happier-daemon.default',
                        targetMode: 'default-following',
                    },
                ],
            }));

            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
                throw new Error(`process.exit(${code ?? ''})`);
            }) as typeof process.exit);

            try {
                await expect(startDaemon()).rejects.toThrow('process.exit(1)');
            } finally {
                exitSpy.mockRestore();
            }

            const logContent = await readFile(logger.logFilePath, 'utf8');
            expect(logContent).toContain('Installed background service prevented manual daemon startup');
            expect(logContent).toContain('happier service start');
            expect(waitForInitialCredentialsMock).not.toHaveBeenCalled();
        });
    });
});
