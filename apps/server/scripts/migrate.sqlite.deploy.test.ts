import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: (...args: unknown[]) => {
        spawnMock(...args);
        return {
            on(event: string, handler: (code: number) => void) {
                if (event === 'exit') {
                    queueMicrotask(() => handler(0));
                }
                return this;
            },
        };
    },
}));

describe('migrate.sqlite.deploy.ts', () => {
    let tmpDir = '';
    let lightDataDir = '';

    async function waitForSpawnCount(expected: number): Promise<void> {
        for (let i = 0; i < 40; i++) {
            if (spawnMock.mock.calls.length >= expected) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error(`Timed out waiting for ${expected} spawn calls; saw ${spawnMock.mock.calls.length}`);
    }

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-light-deploy-'));
        lightDataDir = join(tmpDir, 'happy server #light');
        await mkdir(lightDataDir, { recursive: true });
        spawnMock.mockClear();
        process.env.HAPPY_SERVER_LIGHT_DATA_DIR = lightDataDir;
        process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = lightDataDir;
        delete process.env.DATABASE_URL;
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        delete process.env.HAPPY_SERVER_LIGHT_DATA_DIR;
        delete process.env.HAPPIER_SERVER_LIGHT_DATA_DIR;
        delete process.env.DATABASE_URL;
        vi.resetModules();
    });

    it('uses a safe file URL for sqlite DATABASE_URL when deriving the deploy env', async () => {
        await import('./migrate.sqlite.deploy');
        await waitForSpawnCount(2);

        const prismaCall = spawnMock.mock.calls.find(([, args]) => {
            const argv = Array.isArray(args) ? args : [];
            return argv.includes('prisma') && argv.includes('migrate') && argv.includes('deploy');
        });

        expect(prismaCall).toBeDefined();
        const env = (prismaCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        const expected = `${pathToFileURL(join(lightDataDir, 'happier-server-light.sqlite')).href}?socket_timeout=30`;
        expect(env?.DATABASE_URL).toBe(expected);
        const encodedDirExists = await stat(join(tmpDir, 'happy%20server%20%23light'))
            .then(() => true)
            .catch(() => false);
        expect(encodedDirExists).toBe(false);
    });
});
