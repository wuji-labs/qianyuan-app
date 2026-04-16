import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('evaluateCurrentDaemonOwner', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    ]);

    afterEach(() => {
        envScope.restore();
        vi.resetModules();
    });

    it('returns none when no daemon state exists', async () => {
        await withTempDir('happier-daemon-owner-none-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const { evaluateCurrentDaemonOwner } = await import('./evaluateCurrentDaemonOwner');
            await expect(evaluateCurrentDaemonOwner()).resolves.toEqual({ kind: 'none' });
        });
    });

    it('returns a compatible manual owner when the current version and release channel already match', async () => {
        await withTempDir('happier-daemon-owner-compatible-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });
            vi.resetModules();

            const [{ configuration }, { writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/configuration'),
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43110,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                startedWithPublicReleaseChannel: 'dev',
                runtimeId: 'runtime-compatible',
                startupSource: 'manual',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('compatible');
            if (evaluation.kind !== 'compatible') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(false);
            expect(evaluation.owner.state.runtimeId).toBe('runtime-compatible');
        });
    });

    it('returns a conflict for a service-managed owner on a different version or release channel', async () => {
        await withTempDir('happier-daemon-owner-conflict-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43111,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-conflict',
                startupSource: 'background-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('conflict');
            if (evaluation.kind !== 'conflict') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(true);
            expect(evaluation.owner.versionMatches).toBe(false);
            expect(evaluation.owner.releaseChannelMatches).toBe(false);
            expect(evaluation.owner.state.serviceLabel).toBe('com.happier.cli.daemon.default');
        });
    });

    it('treats legacy daemon state without startup metadata as a manual owner when no service label exists', async () => {
        await withTempDir('happier-daemon-owner-legacy-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43112,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-legacy',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('conflict');
            if (evaluation.kind !== 'conflict') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(false);
            expect(evaluation.owner.startupSource).toBe('unknown');
        });
    });

    it('treats legacy daemon state with a service label and missing startup metadata as service-managed', async () => {
        await withTempDir('happier-daemon-owner-legacy-service-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43114,
                startedAt: Date.now(),
                startedWithCliVersion: '0.0.0-other',
                startedWithPublicReleaseChannel: 'preview',
                runtimeId: 'runtime-legacy-service',
                serviceLabel: 'com.happier.cli.daemon.default',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('conflict');
            if (evaluation.kind !== 'conflict') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.serviceManaged).toBe(true);
            expect(evaluation.owner.startupSource).toBe('unknown');
        });
    });

    it('treats a legacy owner with a matching version and missing release-channel metadata as compatible', async () => {
        await withTempDir('happier-daemon-owner-missing-ring-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
            });
            vi.resetModules();

            const [{ configuration }, { writeDaemonState }, { evaluateCurrentDaemonOwner }] = await Promise.all([
                import('@/configuration'),
                import('@/persistence'),
                import('./evaluateCurrentDaemonOwner'),
            ]);

            writeDaemonState({
                pid: process.pid,
                httpPort: 43113,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                runtimeId: 'runtime-missing-ring',
                startupSource: 'manual',
            });

            const evaluation = await evaluateCurrentDaemonOwner();
            expect(evaluation.kind).toBe('compatible');
            if (evaluation.kind !== 'compatible') {
                throw new Error(`unexpected evaluation: ${evaluation.kind}`);
            }
            expect(evaluation.owner.versionMatches).toBe(true);
            expect(evaluation.owner.releaseChannelMatches).toBe(false);
        });
    });
});
