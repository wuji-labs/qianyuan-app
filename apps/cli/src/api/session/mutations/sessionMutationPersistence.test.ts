import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

async function useTempHappyHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-session-mutation-persistence-'));
    tempHomeDir = dir;
    process.env.HAPPIER_HOME_DIR = dir;
    return dir;
}

async function resolveOutboxFilePath(sessionId: string): Promise<string> {
    const { configuration } = await import('@/configuration');
    return join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
}

async function readDeadLetterEntries(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
}

describe('session mutation persistence', () => {
    beforeEach(async () => {
        vi.resetModules();
        await useTempHappyHome();
    });

    afterEach(async () => {
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        if (tempHomeDir) {
            await rm(tempHomeDir, { recursive: true, force: true });
            tempHomeDir = null;
        }
    });

    it('quarantines schema-invalid session turn rows while loading valid rows', async () => {
        const { loadSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const { createSessionEndMutation } = await import('./sessionMutationTypes');
        const outboxPath = await resolveOutboxFilePath('s1');
        const validEnd = createSessionEndMutation({ sessionId: 's1', observedAt: 2_000 });
        await mkdir(join(outboxPath, '..'), { recursive: true });
        await writeFile(outboxPath, JSON.stringify({
            v: 1,
            mutations: [
                {
                    kind: 'session_turn',
                    mutationId: 'bad-fail',
                    payload: {
                        v: 1,
                        sessionId: 's1',
                        mutationId: 'bad-fail',
                        action: 'fail',
                        turnId: 'turn-1',
                        observedAt: 1_000,
                    },
                    createdAt: 1_000,
                    attempts: 2,
                    nextAttemptAt: 0,
                },
                {
                    kind: 'session_end',
                    mutationId: validEnd.mutationId,
                    payload: validEnd,
                    createdAt: 2_000,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
            ],
        }), 'utf8');

        await expect(loadSessionMutationOutbox('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_end',
                mutationId: validEnd.mutationId,
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'bad-fail',
                reason: 'invalid_session_turn_payload',
                attempts: 2,
                payloadSummary: expect.objectContaining({
                    action: 'fail',
                    sessionId: 's1',
                }),
            }),
        ]);
    });

    it('quarantines unreadable outbox JSON instead of silently dropping it', async () => {
        const { loadSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const outboxPath = await resolveOutboxFilePath('s1');
        await mkdir(join(outboxPath, '..'), { recursive: true });
        await writeFile(outboxPath, '{not-json', 'utf8');

        await expect(loadSessionMutationOutbox('s1')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'outbox_file',
                sessionId: 's1',
                reason: 'invalid_outbox_json',
            }),
        ]);
    });

    it('quarantines transcript append rows whose mutation id is not the canonical session/localId key', async () => {
        const { loadSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const outboxPath = await resolveOutboxFilePath('s1');
        await mkdir(join(outboxPath, '..'), { recursive: true });
        await writeFile(outboxPath, JSON.stringify({
            v: 1,
            mutations: [
                {
                    kind: 'transcript_message_append',
                    mutationId: 'transcript:s1:segment-1',
                    payload: {
                        v: 1,
                        source: 'transcript_message_append',
                        sessionId: 's1',
                        mutationId: 'transcript:s1:segment-1',
                        localId: 'segment-1',
                        sidechainId: 'sc-1',
                        messageRole: 'agent',
                        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'canonical' } } },
                        createdAt: 1_000,
                        updatedAt: 1_100,
                    },
                    createdAt: 1_000,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
                {
                    kind: 'transcript_message_append',
                    mutationId: 'transcript:segment-1',
                    payload: {
                        v: 1,
                        source: 'transcript_message_append',
                        sessionId: 's1',
                        mutationId: 'transcript:segment-1',
                        localId: 'segment-1',
                        sidechainId: 'sc-2',
                        messageRole: 'agent',
                        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'bypass' } } },
                        createdAt: 1_000,
                        updatedAt: 1_200,
                    },
                    createdAt: 1_000,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
            ],
        }), 'utf8');

        await expect(loadSessionMutationOutbox('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
                payload: expect.objectContaining({
                    localId: 'segment-1',
                    sidechainId: 'sc-1',
                }),
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:segment-1',
                reason: 'invalid_transcript_message_append_payload',
                payloadSummary: expect.objectContaining({
                    localId: 'segment-1',
                    mutationId: 'transcript:segment-1',
                }),
            }),
        ]);
    });
});
