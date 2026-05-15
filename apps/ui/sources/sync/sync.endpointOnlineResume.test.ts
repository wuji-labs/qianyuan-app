import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

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
const apiSocketMock = vi.hoisted(() => {
    let connectionStateListener: ((state: import('@happier-dev/connection-supervisor').ManagedConnectionState) => void) | null = null;
    return {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn((listener: (state: import('@happier-dev/connection-supervisor').ManagedConnectionState) => void) => {
            connectionStateListener = listener;
            return () => {
                if (connectionStateListener === listener) {
                    connectionStateListener = null;
                }
            };
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
        publishConnectionState(state: import('@happier-dev/connection-supervisor').ManagedConnectionState) {
            if (!connectionStateListener) {
                throw new Error('apiSocket.onConnectionStateChange was not subscribed');
            }
            connectionStateListener(state);
        },
    };
});
const reachabilityMock = vi.hoisted(() => ({
    invalidateAllServerReachabilitySupervisors: vi.fn(async () => {}),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            currentState: 'active',
                            addEventListener: appStateAddListener as any,
                        },
                    }
    );
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: apiSocketMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        invalidateAllServerReachabilitySupervisors: reachabilityMock.invalidateAllServerReachabilitySupervisors,
    };
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createStubEndpointSupervisor(initial: ManagedEndpointSupervisorState) {
    let state = initial;
    const listeners = new Set<(next: ManagedEndpointSupervisorState) => void>();

    const publish = (next: ManagedEndpointSupervisorState) => {
        state = next;
        for (const listener of Array.from(listeners)) {
            listener(next);
        }
    };

    const supervisor: ManagedEndpointSupervisor = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: vi.fn(async () => {}),
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(state);
            return () => listeners.delete(listener);
        },
    };

    return { supervisor, publish };
}

describe('sync endpoint online resume', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateAddListener.mockClear();
        apiSocketMock.onConnectionStateChange.mockClear();
        apiSocketMock.connect.mockClear();
        apiSocketMock.disconnect.mockClear();
        reachabilityMock.invalidateAllServerReachabilitySupervisors.mockClear();
    });

    it('triggers one consolidated resume pipeline when endpoint supervision returns online', async () => {
        const now = Date.now();
        const offlineState: ManagedEndpointSupervisorState = {
            phase: 'offline',
            reason: 'server_unreachable',
            attempt: 1,
            nextRetryAt: now + 1000,
            lastConnectedAt: null,
            lastDisconnectedAt: now,
            lastErrorMessage: 'Network request failed',
            lastProbe: { status: 'server_unreachable', errorMessage: 'Network request failed' },
        };
        const onlineState: ManagedEndpointSupervisorState = {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: now,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
            lastProbe: { status: 'ready' },
        };

        const { supervisor, publish } = createStubEndpointSupervisor(offlineState);
        const { sync } = await import('./sync');

        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy as any;

        sync.setActiveEndpointSupervisor(supervisor);
        publish(onlineState);

        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(resumeSpy).toHaveBeenCalledWith('endpoint-online');
    });

    it('stores api socket reachability and resumes sync when the server becomes reachable again', async () => {
        const now = Date.now();
        const offlineState: import('@happier-dev/connection-supervisor').ManagedConnectionState = {
            phase: 'offline',
            reason: 'server_unreachable',
            attempt: 2,
            nextRetryAt: now + 1000,
            lastConnectedAt: null,
            lastDisconnectedAt: now,
            lastErrorMessage: 'Network request failed',
        };
        const onlineState: import('@happier-dev/connection-supervisor').ManagedConnectionState = {
            phase: 'online',
            reason: null,
            attempt: 2,
            nextRetryAt: null,
            lastConnectedAt: now + 1000,
            lastDisconnectedAt: now,
            lastErrorMessage: null,
        };

        const { sync } = await import('./sync');
        const { storage } = await import('@/sync/domains/state/storage');
        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy;

        apiSocketMock.publishConnectionState(offlineState);
        expect(storage.getState().endpointStatus).toBe('offline');
        expect(storage.getState().endpointAttempt).toBe(2);
        expect(storage.getState().endpointLastErrorMessage).toBe('Network request failed');

        apiSocketMock.publishConnectionState(onlineState);
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(storage.getState().endpointStatus).toBe('online');
        expect(resumeSpy).toHaveBeenCalledWith('server-reachable');
    });

    it('manual retry forces reachability invalidation before resuming sync', async () => {
        const { sync } = await import('./sync');
        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy;

        sync.retryNow();

        expect(apiSocketMock.disconnect).toHaveBeenCalledTimes(1);
        expect(apiSocketMock.connect).toHaveBeenCalledTimes(1);
        expect(reachabilityMock.invalidateAllServerReachabilitySupervisors).toHaveBeenCalledTimes(1);
        expect(resumeSpy).toHaveBeenCalledWith('manual');
    });

    it('manual retry still invalidates reachability when socket reconnect throws', async () => {
        const { sync } = await import('./sync');
        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy;
        apiSocketMock.disconnect.mockImplementationOnce(() => {
            throw new Error('disconnect failed');
        });

        sync.retryNow();

        expect(reachabilityMock.invalidateAllServerReachabilitySupervisors).toHaveBeenCalledTimes(1);
        expect(resumeSpy).toHaveBeenCalledWith('manual');
    });
});
