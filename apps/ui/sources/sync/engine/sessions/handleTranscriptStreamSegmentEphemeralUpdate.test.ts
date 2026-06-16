import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecryptedMessage, Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { handleTranscriptStreamSegmentEphemeralUpdate } from './handleTranscriptStreamSegmentEphemeralUpdate';

function buildSession(sessionId: string, encryptionMode: Session['encryptionMode'] = 'plain'): Session {
    return {
        id: sessionId,
        seq: 1,
        encryptionMode,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('handleTranscriptStreamSegmentEphemeralUpdate', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records stream segment telemetry when applying a plain transcript segment', async () => {
        const applyMessages = vi.fn();
        const getSessionEncryption = vi.fn(() => null);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'local-1',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'streaming' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption,
            getSession: () => buildSession('s1'),
            applyMessages,
            isSessionActivelyViewed: (sessionId) => sessionId === 's1',
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(getSessionEncryption).not.toHaveBeenCalled();

        const events = syncPerformanceTelemetry.snapshot().events;
        const streamEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment');
        expect(streamEvent?.fields.plain).toBe(1);
        expect(streamEvent?.fields.encrypted).toBe(0);
        expect(streamEvent?.fields.activeViewingSession).toBe(1);
        expect(streamEvent?.fields.backgroundSession).toBe(0);
        const readEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment.readMessage');
        expect(readEvent?.fields.plain).toBe(1);
        expect(readEvent?.fields.activeViewingSession).toBe(1);
        const applyEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment.apply');
        expect(applyEvent?.fields.normalized).toBe(1);
        expect(applyEvent?.fields.activeViewingSession).toBe(1);
    });

    it('skips hidden transcript stream segments before decrypting content', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'stream-1',
            seq: 0,
            localId: 'stream-1',
            createdAt: 1_000,
            content: { role: 'agent', content: { type: 'text', text: 'background token' } },
        }));
        const applyMessages = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'stream-1',
                    content: { t: 'encrypted', c: 'ciphertext' },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption: () => ({ decryptMessage }),
            getSession: () => buildSession('s1', 'e2ee'),
            applyMessages,
            isSessionActivelyViewed: () => false,
            skipWhenHidden: true,
        });

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();

        const events = syncPerformanceTelemetry.snapshot().events;
        const streamEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment');
        expect(streamEvent?.fields.backgroundSession).toBe(1);
        expect(streamEvent?.fields.skippedHidden).toBe(1);
        expect(events.some((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment.readMessage')).toBe(false);
    });

    it('uses stream segment messageRole when normalizing plain live updates', async () => {
        const applyMessages = vi.fn();

        await handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'event-segment-1',
                    messageRole: 'event',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'assistant',
                                    message: {
                                        role: 'assistant',
                                        content: [{ type: 'text', text: 'transport status' }],
                                    },
                                },
                            },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption: () => null,
            getSession: () => buildSession('s1'),
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops in-flight stream segment work when the session is deleted before decrypt resolves', async () => {
        let session: Session | undefined = buildSession('s1', 'e2ee');
        let resolveDecrypt!: (message: DecryptedMessage) => void;
        const decryptedMessage = new Promise<DecryptedMessage>((resolve) => {
            resolveDecrypt = resolve;
        });
        const decryptStarted = vi.fn();
        const applyMessages = vi.fn();

        const pending = handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'stream-1',
                    content: { t: 'encrypted', c: 'ciphertext' },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption: () => ({
                decryptMessage: async () => {
                    decryptStarted();
                    return await decryptedMessage;
                },
            }),
            getSession: () => session,
            applyMessages,
        });
        expect(decryptStarted).toHaveBeenCalledTimes(1);

        session = undefined;
        resolveDecrypt({
            id: 'stream-1',
            seq: 0,
            localId: 'stream-1',
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'deleted while streaming' } },
        });
        await pending;

        expect(applyMessages).not.toHaveBeenCalled();
    });
});
