import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { ApiSessionClient } from './session/sessionClient';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { HttpStatusError } from './client/httpStatusError';
import {
    bindApiSessionSocketPairMock,
    createApiSessionSocketStub,
    flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

describe('ApiSessionClient pending queue materialization', () => {
    let mockSession: any;

    beforeEach(() => {
        mockSession = createMockSession();
        mockIo.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function expectSafeMaterializer(client: ApiSessionClient): (opts?: {
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    }) => Promise<unknown> {
        const candidate = client as unknown as {
            materializeNextPendingMessageSafely?: (opts?: {
                reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
            }) => Promise<unknown>;
        };
        const materializeNextPendingMessageSafely = candidate.materializeNextPendingMessageSafely;
        expect(typeof materializeNextPendingMessageSafely).toBe('function');
        if (!materializeNextPendingMessageSafely) {
            throw new Error('materializeNextPendingMessageSafely is unavailable');
        }
        return materializeNextPendingMessageSafely.bind(client);
    }

    it('peekPendingMessageQueueV2Count reconciles through the session snapshot when local pending state is known empty', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockResolvedValueOnce({
                pendingQueueState: {
                    known: true,
                    pendingCount: 0,
                    pendingVersion: 5,
                },
            });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 0,
            pendingVersion: 5,
        });

        await expect(client.peekPendingMessageQueueV2Count()).resolves.toBe(0);
        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            token: 'fake-token',
            sessionId: mockSession.id,
        }));
    });

    it('suppresses pending materialization attempts while the local pending state is unknown', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });

        expect((client as any).shouldAttemptPendingMaterialization?.()).toBe(false);
    });

    it('popPendingMessage skips materialize-next when local pending state is known empty', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post');

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 0,
            pendingVersion: 5,
        });

        await expect(client.popPendingMessage()).resolves.toBe(false);
        expect((client as any).shouldAttemptPendingMaterialization?.()).toBe(false);
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith('pending-materialize-next', expect.anything());
        expect(postSpy).not.toHaveBeenCalled();
    });

    it('materializeNextPendingMessageSafely returns no_pending after force-reconciling known-empty state', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockResolvedValueOnce({
                pendingQueueState: {
                    known: true,
                    pendingCount: 0,
                    pendingVersion: 6,
                },
            });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 0,
            pendingVersion: 5,
        });
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
            },
        });

        await expect(expectSafeMaterializer(client)()).resolves.toEqual({ type: 'no_pending' });
        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            token: 'fake-token',
            sessionId: mockSession.id,
        }));
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith('pending-materialize-next', expect.anything());
    });

    it('materializeNextPendingMessageSafely returns deferred when the supervisor is offline', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 1,
            pendingVersion: 1,
        });
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'offline',
                    reason: 'server_unreachable',
                    attempt: 1,
                    nextRetryAt: null,
                    lastConnectedAt: null,
                    lastDisconnectedAt: Date.now(),
                    lastErrorMessage: 'server is offline',
                }),
            },
        });

        await expect(expectSafeMaterializer(client)()).resolves.toEqual({
            type: 'deferred',
            reason: 'supervisor_offline',
        });
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith('pending-materialize-next', expect.anything());
    });

    it('materializeNextPendingMessageSafely returns deferred when the supervisor auth failed', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 1,
            pendingVersion: 1,
        });
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'auth_failed',
                    reason: 'auth_invalid',
                    attempt: 1,
                    nextRetryAt: null,
                    lastConnectedAt: null,
                    lastDisconnectedAt: Date.now(),
                    lastErrorMessage: 'expired token',
                }),
            },
        });

        await expect(expectSafeMaterializer(client)()).resolves.toEqual({
            type: 'deferred',
            reason: 'supervisor_auth_failed',
        });
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith('pending-materialize-next', expect.anything());
    });

    it('does not record committed user message seqs from fractional materialize ACK seqs', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 2,
                message: { id: 'msg-2', seq: 55.9, localId: 'local-p1', messageRole: 'user' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        await expect(client.popPendingMessage()).resolves.toBe(true);

        expect(client.getCommittedUserMessageSeq('local-p1')).toBeNull();
    });

    it('popPendingMessage uses pending-materialize-next and returns true when server materializes', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 2,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect((client as any).shouldAttemptPendingMaterialization?.()).toBe(false);
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: mockSession.id,
            pendingVersion: 1,
        });
    });

    it('materializeNextPendingMessageSafely returns the structured materialized message', async () => {
        const content = {
            t: 'encrypted' as const,
            c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                role: 'user',
                content: { type: 'text', text: 'hello from pending queue' },
                meta: { source: 'ui' },
            })),
        };
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 2,
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content,
                    createdAt: 1_000,
                    updatedAt: 1_100,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 1,
            pendingVersion: 1,
        });
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
            },
        });

        await expect(expectSafeMaterializer(client)()).resolves.toEqual({
            type: 'materialized',
            localId: 'local-p1',
            seq: 2,
            content,
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: mockSession.id,
            pendingVersion: 1,
        });
    });

    it('materializeNextPendingMessageSafely preserves legacy socket ACK identity without message content', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                id: 'msg-legacy-socket',
                seq: 9,
                localId: 'local-legacy-socket',
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 1,
            pendingVersion: 1,
        });
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
            },
        });

        await expect(expectSafeMaterializer(client)()).resolves.toEqual({
            type: 'materialized',
            localId: 'local-legacy-socket',
            seq: 9,
            content: null,
        });
        expect((client as any).hasPendingQueueMaterializedLocalId('local-legacy-socket')).toBe(true);
    });

    it('materializeNextPendingMessageSafely preserves legacy HTTP fallback ACK identity without message content', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new Error('socket materialize unavailable');
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        vi.spyOn(axios, 'post').mockResolvedValueOnce({
            data: {
                ok: true,
                didMaterialize: true,
                didWrite: true,
                id: 'msg-legacy-http',
                seq: 10,
                localId: 'local-legacy-http',
            },
        });

        const client = new ApiSessionClient('fake-token', {
            ...mockSession,
            metadata: {},
            pendingCount: 1,
            pendingVersion: 1,
        });
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
            },
        });

        await expect(expectSafeMaterializer(client)()).resolves.toEqual({
            type: 'materialized',
            localId: 'local-legacy-http',
            seq: 10,
            content: null,
        });
        expect((client as any).hasPendingQueueMaterializedLocalId('local-legacy-http')).toBe(true);
    });

    it('tracks materialized localIds for recovery even when the server reports an idempotent write', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: false,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect((client as any).hasPendingQueueMaterializedLocalId('local-p1')).toBe(true);
    });

    it('uses the session supervisor when recovering materialized localIds', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default;
        const getSpy = vi.spyOn(axios, 'get').mockRejectedValue({
            isAxiosError: true,
            response: { status: 404, data: { error: 'Message not found' } },
        });
        const offlineSupervisor: ManagedConnectionSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            getState: vi.fn(() => ({
                phase: 'offline' as const,
                reason: 'server_unreachable' as const,
                attempt: 1,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: 1,
                lastErrorMessage: null,
            })),
            reportProbeResult: vi.fn(),
        };
        type RecoveryHost = {
            recoverMaterializedLocalId(localId: string, opts?: { maxWaitMs?: number }): Promise<boolean>;
        };
        const recoveryHost = Object.assign(
            Object.create(ApiSessionClient.prototype) as unknown as RecoveryHost,
            {
                token: 'fake-token',
                sessionId: mockSession.id,
                sessionConnectionSupervisor: offlineSupervisor,
                transcriptRecoveryErrorStateByLocalId: new Map<string, { lastLoggedAt: number; suppressed: number }>(),
            },
        );

        try {
            await expect(recoveryHost.recoverMaterializedLocalId('local-p1', { maxWaitMs: 1 })).resolves.toBe(false);
            expect(getSpy).not.toHaveBeenCalled();
        } finally {
            getSpy.mockRestore();
        }
    });

    it('delivers a materialized pending message immediately and does not double-deliver socket echoes', async () => {
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui' },
        };
        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encrypted },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub({ connected: true });

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const popped = await client.popPendingMessage();
        expect(popped).toBe(true);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage.mock.calls[0]?.[0]).toMatchObject({
            content: { type: 'text', text: 'hello' },
            localId: 'local-p1',
        });

        const sessionUpdateHandler = sessionSocket.getHandler('update');
        const userUpdateHandler = userSocket.getHandler('update');
        expect(typeof sessionUpdateHandler).toBe('function');
        expect(typeof userUpdateHandler).toBe('function');

        const update = {
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: {
                t: 'new-message',
                sid: mockSession.id,
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    content: { t: 'encrypted', c: encrypted },
                },
            },
        } as any;

        userUpdateHandler?.(update);
        sessionUpdateHandler?.(update);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
    });

    it('popPendingMessage falls back to HTTP materialize when socket RPC fails', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new Error('timeout');
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        const popped = await client.popPendingMessage();

        expect(popped).toBe(false);
        expect(postSpy).toHaveBeenCalled();
        expect(String(postSpy.mock.calls[0]?.[0] ?? '')).toContain(`/v2/sessions/${mockSession.id}/pending/materialize-next`);
        expect(postSpy.mock.calls[0]?.[1]).toEqual({});
        expect(postSpy.mock.calls[0]?.[2]).toMatchObject({
            headers: expect.objectContaining({
                Authorization: 'Bearer fake-token',
                'Content-Type': 'application/json',
            }),
        });
    });

    it('popPendingMessage falls back to HTTP materialize when the socket ACK never settles', async () => {
        vi.useFakeTimers();
        vi.stubEnv('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', '5');
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => new Promise<never>(() => {}),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        const poppedPromise = client.popPendingMessage();

        try {
            await vi.advanceTimersByTimeAsync(60_000);

            await expect(poppedPromise).resolves.toBe(false);
            expect(postSpy).toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
            vi.useRealTimers();
        }
    });

    it('popPendingMessage falls back to HTTP materialize when the session socket is disconnected', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        const popped = await client.popPendingMessage();

        expect(popped).toBe(false);
        expect(postSpy).toHaveBeenCalled();
        expect(String(postSpy.mock.calls[0]?.[0] ?? '')).toContain(`/v2/sessions/${mockSession.id}/pending/materialize-next`);
        expect(postSpy.mock.calls[0]?.[1]).toEqual({});
        expect(postSpy.mock.calls[0]?.[2]).toMatchObject({
            headers: expect.objectContaining({
                Authorization: 'Bearer fake-token',
                'Content-Type': 'application/json',
            }),
        });
    });

    it('popPendingMessage rethrows terminal auth failures from the HTTP fallback instead of collapsing them to false', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new Error('timeout');
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        vi.spyOn(axios, 'post').mockRejectedValueOnce(new HttpStatusError(401, 'Authentication failed'));

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });

        await expect(client.popPendingMessage()).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });
    });

    it('reports terminal auth failures from pending materialization into the session supervisor state', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new HttpStatusError(401, 'Authentication failed');
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });

        await expect(client.popPendingMessage()).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('auth_failed');
        });
    });

    it('popPendingMessage fails fast when the session supervisor is already auth_failed', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post');

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {}, pendingCount: 1, pendingVersion: 1 });
        (client as any).sessionConnectionSupervisor.reportProbeResult?.({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: 'expired token',
        });

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('auth_failed');
        });

        await expect(client.popPendingMessage()).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });
        expect(postSpy).not.toHaveBeenCalled();
    });

    it('waitForMetadataUpdate resolves when pending-changed update arrives', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });
        const waitPromise = client.waitForMetadataUpdate();

        const updateHandler = userSocket.getHandler('update');
        expect(typeof updateHandler).toBe('function');

        updateHandler?.({
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: { t: 'pending-changed', sid: mockSession.id, pendingCount: 1, pendingVersion: 1 },
        } as any);

        await expect(waitPromise).resolves.toBe(true);
        expect((client as any).shouldAttemptPendingMaterialization?.()).toBe(true);
    });

    it('committed materialized payloads can still be decrypted for assertions', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: { filePath: '/etc/hosts' },
            id: 'msg-1',
        });

        await flushApiSessionClientMessageCommitQueue(client as any);

        const call = sessionSocket.emitWithAck.mock.calls.find((args: any[]) => args[0] === 'message');
        const encrypted = call?.[1]?.message;
        const decrypted = decrypt(mockSession.encryptionKey, mockSession.encryptionVariant, decodeBase64(encrypted));
        expect((decrypted as any).content?.type).toBe('acp');
    });
});
