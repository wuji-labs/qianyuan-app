import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

vi.mock('axios');

let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;

async function useTempHappyHome(): Promise<void> {
    tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-outbox-unit-'));
    process.env.HAPPIER_HOME_DIR = tempHomeDir;
}

async function readPersistedOutboxMutations(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
        return Array.isArray(parsed.mutations) ? parsed.mutations : [];
    } catch {
        return [];
    }
}

async function readDeadLetterEntries(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
}

describe('createSessionMutationOutbox', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.mocked(axios.post).mockReset();
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '2';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        await useTempHappyHome();
    });

    afterEach(async () => {
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        if (originalMaxAttempts === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
        }
        if (originalBaseRetryMs === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
        }
        if (originalJitterMs === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
        }
        if (tempHomeDir) {
            await rm(tempHomeDir, { recursive: true, force: true });
            tempHomeDir = null;
        }
    });

    it.each([400, 422] as const)('dead-letters exhausted HTTP %s turn rejections and advances independent turns', async (status) => {
        const deliveredTurnIds: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const turnId = (body as { turnId?: unknown }).turnId;
            if (typeof turnId === 'string') deliveredTurnIds.push(turnId);
            if (turnId === 'turn-blocked') {
                throw { response: { status } };
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const blockedBegin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-blocked',
            provider: 'codex',
            mutationId: 'mutation-blocked-begin',
            observedAt: 1_000,
        });
        const blockedComplete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-blocked',
            provider: 'codex',
            mutationId: 'mutation-blocked-complete',
            observedAt: 1_100,
        });
        const independentBegin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-independent',
            provider: 'codex',
            mutationId: 'mutation-independent-begin',
            observedAt: 2_000,
        });
        await saveSessionMutationOutbox('s1', [
            {
                kind: 'session_turn',
                mutationId: blockedBegin.mutationId,
                payload: blockedBegin,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: blockedComplete.mutationId,
                payload: blockedComplete,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: independentBegin.mutationId,
                payload: independentBegin,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredTurnIds).toContain('turn-independent');
        expect(deliveredTurnIds).not.toContain('turn-blocked-complete');
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-blocked-begin',
                reason: 'retry_exhausted',
                attempts: 2,
                diagnostic: expect.objectContaining({
                    deliveryStatus: 'retryable',
                    httpStatus: status,
                }),
            }),
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-blocked-complete',
                reason: 'blocked_by_dead_lettered_dependency',
                dependencyMutationId: 'mutation-blocked-begin',
            }),
        ]);
        await outbox.close();
    });
});
