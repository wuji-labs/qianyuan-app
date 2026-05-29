import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: {
                                OS: 'web',
                            },
                            AppState: {
                                addEventListener: appStateAddListener as any,
                            },
                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

const resumeSessionSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ type: 'success' as const })));
vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...actual,
        resumeSession: (...args: unknown[]) => resumeSessionSpy(...args),
    };
});

import { storage } from './domains/state/storage';
import type { Machine, Session } from './domains/state/storageTypes';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const initialStorageState = storage.getState();

function createPlainSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: false,
        activeAt: now,
        metadata: {
            machineId: 'm1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'codex-1',
        } as any,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode: 'plain',
    } as any;
}

function createMachine(params: {
    id: string;
    active?: boolean;
    replacedByMachineId?: string | null;
    replacedAt?: number | null;
}): Machine {
    const now = Date.now();
    return {
        id: params.id,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: params.active ?? true,
        activeAt: now,
        metadata: {
            host: params.id,
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/tmp/happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        replacedByMachineId: params.replacedByMachineId ?? null,
        replacedAt: params.replacedAt ?? null,
    };
}

function createRpcMethodNotAvailableError(): RpcError {
    return new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

describe('sync.sendMessage wake-after-send', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        resumeSessionSpy.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('wakes the daemon with the current session authoring snapshot after sending a message via the server commit path', async () => {
        const sessionId = 's_test';
        const connectedServices = {
            v: 1 as const,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected' as const,
                    selection: 'group' as const,
                    groupId: 'claude-group',
                    profileId: 'profile-2',
                },
            },
        };
        const session = createPlainSession({ sessionId });
        storage.getState().applySessions([{
            ...session,
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 200,
            modelMode: 'claude-sonnet-4-5',
            modelModeUpdatedAt: 150,
            metadata: {
                ...session.metadata,
                permissionMode: 'default',
                permissionModeUpdatedAt: 100,
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 250,
                    modeId: 'plan',
                },
                modelOverrideV1: {
                    v: 1,
                    updatedAt: 150,
                    modelId: 'claude-sonnet-4-5',
                },
                connectedServices,
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 37,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                machineId: 'm1',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 36,
                connectedServices,
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 200,
                agentModeId: 'plan',
                agentModeUpdatedAt: 250,
                modelId: 'claude-sonnet-4-5',
                modelUpdatedAt: 150,
            }),
        );
    });

    it('wakes the replacement machine when inactive session metadata points at a stale machine', async () => {
        const sessionId = 's_replaced_machine';
        storage.getState().applyMachines([
            createMachine({
                id: 'm-old',
                active: false,
                replacedByMachineId: 'm-new',
                replacedAt: Date.now(),
            }),
            createMachine({ id: 'm-new', active: true }),
        ], true);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            metadata: {
                machineId: 'm-old',
                path: '/tmp/project',
                flavor: 'codex',
                codexSessionId: 'codex-1',
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 37,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                machineId: 'm-new',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 36,
            }),
        );
    });

    it('wakes inactive sessions after submitMessage enqueues through the pending queue', async () => {
        const sessionId = 's_pending_submit_wake';
        storage.getState().applyMachines([createMachine({ id: 'm1', active: true })], true);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            seq: 12,
            active: false,
            pendingVersion: 0,
            pendingCount: 0,
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'codex',
                codexSessionId: 'codex-1',
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        vi.spyOn(apiSocket, 'request').mockImplementation(async () => {
            const current = storage.getState().sessions[sessionId];
            storage.getState().applySessions([{
                ...current,
                seq: 30,
            }]);
            return new Response(null, { status: 204 });
        });

        await sync.submitMessage(sessionId, 'hello pending');

        expect(apiSocket.request).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending`,
            expect.objectContaining({ method: 'POST' }),
        );
        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                machineId: 'm1',
                directory: '/tmp/project',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                initialTranscriptAfterSeq: 12,
            }),
        );
    });
});
