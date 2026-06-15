import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionListViewData, useSessionListViewDataByServerId, useSessionRecentPathEntries, useSessions, useSessionsReady } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    const equivalentIds = new Set(['profile-a', 'legacy-a', 'identity-a']);
    return {
        ...original,
        areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
            const left = String(leftRaw ?? '').trim();
            const right = String(rightRaw ?? '').trim();
            if (!left || !right) return false;
            if (left === right) return true;
            return equivalentIds.has(left) && equivalentIds.has(right);
        },
        resolveServerProfileScopeIdForIdentifier: (idRaw: string | null | undefined) => {
            const id = String(idRaw ?? '').trim();
            return equivalentIds.has(id) ? 'identity-a' : id;
        },
    };
});

afterEach(() => {
    standardCleanup();
});

describe('useSessions', () => {
    it('returns loaded sessions from the canonical sessions map when legacy sessionsData is absent', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 's-1': session },
                sessionsData: null,
            }));

            const hook = await renderHook(() => useSessions(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([session]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps recent path projection stable when streaming updates only touch volatile session fields', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 10,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: true,
                thinkingAt: 20,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 's-1': session },
                sessionsData: null,
            }));

            const hook = await renderHook(() => useSessionRecentPathEntries(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            storage.setState((state) => ({
                ...state,
                sessions: {
                    's-1': {
                        ...session,
                        seq: 2,
                        updatedAt: 30,
                        thinkingAt: 30,
                        metadata: {
                            ...session.metadata,
                            path: session.metadata?.path ?? '',
                            host: session.metadata?.host ?? '',
                            summaryText: 'streaming token chunk',
                        },
                    },
                },
            }));
            await hook.rerender();

            expect(hook.getCurrent()).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps session list shell data stable when streaming updates only touch row-subscribed fields', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
                {
                    type: 'session',
                    section: 'active',
                    groupKey: 'server:server-a:active',
                    groupKind: 'active',
                    serverId: 'server-a',
                    session: {
                        id: 's-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                        thinking: true,
                        thinkingAt: 20,
                        presence: 'online',
                    },
                },
            ];
            const firstSessionItem = firstData[1];
            if (firstSessionItem.type !== 'session') {
                throw new Error('expected session test fixture');
            }
            const firstMetadata = firstSessionItem.session.metadata;
            if (!firstMetadata) {
                throw new Error('expected metadata test fixture');
            }

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewData();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: [
                        firstData[0],
                        {
                            ...firstSessionItem,
                            session: {
                                ...firstSessionItem.session,
                                seq: 42,
                                updatedAt: 60,
                                metadataVersion: 4,
                                agentStateVersion: 5,
                                thinkingAt: 60,
                            },
                        },
                    ],
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates session list shell data when visible title or pending badge fields change', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Active',
                    headerKind: 'active',
                    groupKey: 'server:server-a:active',
                    serverId: 'server-a',
                },
                {
                    type: 'session',
                    section: 'active',
                    groupKey: 'server:server-a:active',
                    groupKind: 'active',
                    serverId: 'server-a',
                    session: {
                        id: 's-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        pendingCount: 0,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: {
                            path: '/repo',
                            host: 'localhost',
                            machineId: 'm-1',
                            summaryText: 'Initial summary',
                        },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];
            const firstSessionItem = firstData[1];
            if (firstSessionItem.type !== 'session') {
                throw new Error('expected session test fixture');
            }
            const firstMetadata = firstSessionItem.session.metadata;
            if (!firstMetadata) {
                throw new Error('expected metadata test fixture');
            }

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewData();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: [
                        firstData[0],
                        {
                            ...firstSessionItem,
                            session: {
                                ...firstSessionItem.session,
                                pendingCount: 3,
                                metadata: {
                                    ...firstMetadata,
                                    summaryText: 'Updated summary',
                                },
                            },
                        },
                    ],
                }));
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            const next = hook.getCurrent();
            expect(next).not.toBe(first);
            expect(renderCount).toBe(2);
            expect(next?.[1]).toMatchObject({
                type: 'session',
                session: {
                    pendingCount: 3,
                    metadata: {
                        summaryText: 'Updated summary',
                    },
                },
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates session list shell data when pending request freshness timing changes', async () => {
        const previousState = storage.getState();
        try {
            const firstData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'active',
                    groupKey: 'server:server-a:active',
                    groupKind: 'active',
                    serverId: 'server-a',
                    session: {
                        id: 's-1',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: true,
                        activeAt: 20,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                        hasPendingPermissionRequests: true,
                        pendingRequestObservedAt: 100,
                    },
                },
            ];
            const firstSessionItem = firstData[0];
            if (firstSessionItem.type !== 'session') {
                throw new Error('expected session test fixture');
            }

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewData: firstData,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewData();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewData: [{
                        ...firstSessionItem,
                        session: {
                            ...firstSessionItem.session,
                            pendingRequestObservedAt: 500,
                        },
                    }],
                }));
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            const next = hook.getCurrent();
            expect(next).not.toBe(first);
            expect(renderCount).toBe(2);
            expect(next?.[0]).toMatchObject({
                type: 'session',
                session: {
                    pendingRequestObservedAt: 500,
                },
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps selected server list shell data stable when unrelated server caches change', async () => {
        const previousState = storage.getState();
        try {
            const selectedData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'inactive',
                    groupKey: 'server:server-a:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'server-a',
                    session: {
                        id: 's-a',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: false,
                        activeAt: 0,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo-a', host: 'localhost', machineId: 'm-1' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];
            const unrelatedData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'inactive',
                    groupKey: 'server:server-b:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'server-b',
                    session: {
                        id: 's-b',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: false,
                        activeAt: 0,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo-b', host: 'localhost', machineId: 'm-2' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'server-a': selectedData,
                    'server-b': unrelatedData,
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListViewDataByServerId(['server-a']);
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListViewDataByServerId: {
                        ...state.sessionListViewDataByServerId,
                        'server-b': unrelatedData.map((item) => item.type === 'session'
                            ? {
                                ...item,
                                session: {
                                    ...item.session,
                                    seq: 2,
                                    updatedAt: 30,
                                    thinkingAt: 30,
                                },
                            }
                            : item),
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(Object.keys(hook.getCurrent())).toEqual(['server-a']);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('selects session list cache by equivalent server profile identifiers', async () => {
        const previousState = storage.getState();
        try {
            const selectedData: SessionListViewItem[] = [
                {
                    type: 'session',
                    section: 'inactive',
                    groupKey: 'server:identity-a:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'identity-a',
                    session: {
                        id: 's-a',
                        seq: 1,
                        createdAt: 10,
                        updatedAt: 20,
                        active: false,
                        activeAt: 0,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '/repo-a', host: 'localhost', machineId: 'm-1' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    },
                },
            ];

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListViewDataByServerId: {
                    'identity-a': selectedData,
                },
            }));

            const hook = await renderHook(() => useSessionListViewDataByServerId(['profile-a']), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(Object.keys(hook.getCurrent())).toEqual(['identity-a']);
            expect(hook.getCurrent()['identity-a']).toBe(selectedData);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps sessions readiness stable when unrelated session records change', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 10,
                updatedAt: 20,
                active: true,
                activeAt: 20,
                archivedAt: null,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: true,
                thinkingAt: 20,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 's-1': session },
                sessionsData: null,
            }));

            const seen: boolean[] = [];
            const hook = await renderHook(() => {
                const ready = useSessionsReady();
                seen.push(ready);
                return ready;
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(true);

            storage.setState((state) => ({
                ...state,
                sessions: {
                    's-1': {
                        ...session,
                        seq: 2,
                        updatedAt: 30,
                    },
                },
            }));
            await hook.rerender();

            expect(hook.getCurrent()).toBe(true);
            expect(seen).toEqual([true, true]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
