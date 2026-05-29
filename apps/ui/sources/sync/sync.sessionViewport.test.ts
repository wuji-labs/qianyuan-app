import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { NormalizedMessage } from '@/sync/typesRaw';

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync session viewport', () => {
    type RuntimeViewportChangeSync = Readonly<{
        onSessionViewportChange: (
            sessionId: string,
            state: Readonly<{
                isPinned: boolean;
                offsetY: number;
                shouldRestoreViewport?: boolean;
                anchor?: unknown;
            }>
        ) => void;
    }>;

    const validViewportAnchor = {
        kind: 'message',
        messageId: 'message-1',
        itemId: 'item-1',
        itemOffsetPx: 84,
        capturedAtMs: 1234,
    } as const;

    type SyncWithHydrationPrioritySelector = Readonly<{
        getPrioritizedSessionHydrationIds: () => string[];
    }>;

    function buildSessionListItem(id: string): SessionListViewItem {
        return {
            type: 'session',
            session: buildSessionListRenderableFromSession(createSessionFixture({ id })),
        };
    }

    function buildMessage(id: string, seq: number): NormalizedMessage {
        return {
            id,
            localId: null,
            createdAt: seq,
            role: 'user',
            content: { type: 'text', text: id },
            seq,
            isSidechain: false,
        };
    }

    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
    });

    it('leaves eager session-list hydration rows out of prioritized hydration ids', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { sync } = await import('./sync');

        storage.setState((state) => ({
            ...state,
            sessionListViewData: [
                buildSessionListItem('s_eager_1'),
                buildSessionListItem('s_eager_2'),
                buildSessionListItem('s_eager_3'),
            ],
        }));

        const ids = (sync as unknown as SyncWithHydrationPrioritySelector).getPrioritizedSessionHydrationIds();

        expect(ids).toEqual([]);
    });

    it('keeps live-tail intent for transient unpinned viewport reports', async () => {
        const { sync } = await import('./sync');

        expect(sync.getSessionViewport('session-1')).toBeNull();

        sync.onSessionVisible('session-1');
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });

        sync.onSessionViewportChange('session-1', { isPinned: false, offsetY: 420, shouldRestoreViewport: false });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('preserves observed viewport intent after the user releases bottom follow', async () => {
        const { sync } = await import('./sync');

        sync.onSessionVisible('session-1');
        sync.onSessionViewportChange('session-1', { isPinned: false, offsetY: 420, shouldRestoreViewport: true });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });

        sync.onSessionVisible('session-1');
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });
    });

    it('stores a valid viewport anchor for observed restore intent', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('stores a valid viewport anchor when the anchored row starts above the viewport', async () => {
        const { sync } = await import('./sync');
        const partiallyVisibleAnchor = {
            ...validViewportAnchor,
            itemOffsetPx: -48,
        };

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: partiallyVisibleAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: partiallyVisibleAnchor,
        });
    });

    it('drops invalid viewport anchors while preserving distance fallback', async () => {
        const { sync } = await import('./sync');
        const runtimeSync = sync as unknown as RuntimeViewportChangeSync;
        const invalidAnchors = [
            { ...validViewportAnchor, itemId: '' },
            { ...validViewportAnchor, messageId: '' },
            { ...validViewportAnchor, kind: 'unknown' },
            { ...validViewportAnchor, itemOffsetPx: Number.NaN },
            { ...validViewportAnchor, capturedAtMs: Number.POSITIVE_INFINITY },
        ];

        invalidAnchors.forEach((anchor, index) => {
            const sessionId = `session-invalid-${index}`;

            runtimeSync.onSessionViewportChange(sessionId, {
                isPinned: false,
                offsetY: 420 + index,
                shouldRestoreViewport: true,
                anchor,
            });

            expect(sync.getSessionViewport(sessionId)).toMatchObject({
                isPinned: false,
                offsetY: 420 + index,
                source: 'observed',
                anchor: null,
            });
        });
    });

    it('clears stale anchors for viewport reports without restore intent', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({ anchor: validViewportAnchor });

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 320,
            shouldRestoreViewport: false,
            anchor: validViewportAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('treats pinned viewport reports as live-tail intent even when restore intent is requested', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            source: 'observed',
            anchor: validViewportAnchor,
        });

        sync.onSessionViewportChange('session-1', {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('marks outbound user messages as live-tail intent', async () => {
        const { sync } = await import('./sync');
        const liveTailSync = sync as unknown as {
            markSessionLiveTailIntent?: (sessionId: string) => void;
        };

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            source: 'observed',
            anchor: validViewportAnchor,
        });

        expect(typeof liveTailSync.markSessionLiveTailIntent).toBe('function');
        liveTailSync.markSessionLiveTailIntent?.('session-1');

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('keeps viewport state memory-only across runtime reloads', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({ anchor: validViewportAnchor });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-1')).toBeNull();

        reloadedSync.onSessionVisible('session-1');
        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('resets stale hidden transcript markers and clears the reveal marker after invalidation', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('@/sync/domains/state/storage');
        const invalidateCoalesced = vi.fn();
        const sessionId = 'session-stale-reveal';
        type StaleTranscriptHarness = {
            markSessionTranscriptStale: (
                sessionId: string,
                marker: { updateType: 'message-updated'; seq: number; messageId: string },
            ) => void;
            messagesSync: Map<string, { invalidateCoalesced: () => void }>;
            sessionMaterializedMaxSeqById: Record<string, number>;
        };
        const harness = sync as unknown as StaleTranscriptHarness;

        storage.getState().applyMessages(sessionId, [buildMessage('message-stale', 7)]);
        harness.messagesSync = new Map([[sessionId, { invalidateCoalesced }]]);
        harness.sessionMaterializedMaxSeqById = { [sessionId]: 7 };
        harness.markSessionTranscriptStale(sessionId, {
            updateType: 'message-updated',
            seq: 7,
            messageId: 'message-stale',
        });

        sync.onSessionVisible(sessionId);

        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toEqual([]);
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(false);
        expect(harness.sessionMaterializedMaxSeqById[sessionId]).toBe(0);
        expect(invalidateCoalesced).toHaveBeenCalledTimes(1);

        storage.getState().applyMessages(sessionId, [buildMessage('message-after-reset', 8)]);
        sync.onSessionVisible(sessionId);

        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toHaveLength(1);
        expect(invalidateCoalesced).toHaveBeenCalledTimes(2);
    });

    it('hydrates deferred hidden session state on reveal and clears the marker', async () => {
        const { sync } = await import('./sync');
        const invalidateCoalesced = vi.fn();
        const hydrateVisibleSession = vi.fn(async () => true);
        const sessionId = 'session-state-reveal';
        type DeferredStateHydrationHarness = {
            markSessionStateHydrationDeferred: (sessionId: string) => void;
            messagesSync: Map<string, { invalidateCoalesced: () => void }>;
            ensureSessionVisibleForMessageRoute: (
                sessionId: string,
                options?: Readonly<{ forceRefresh?: boolean }>,
            ) => Promise<boolean>;
        };
        const harness = sync as unknown as DeferredStateHydrationHarness;

        harness.messagesSync = new Map([[sessionId, { invalidateCoalesced }]]);
        harness.ensureSessionVisibleForMessageRoute = hydrateVisibleSession;
        harness.markSessionStateHydrationDeferred(sessionId);

        sync.onSessionVisible(sessionId);
        sync.onSessionVisible(sessionId);

        expect(hydrateVisibleSession).toHaveBeenCalledTimes(1);
        expect(hydrateVisibleSession).toHaveBeenCalledWith(sessionId, { forceRefresh: true });
        expect(invalidateCoalesced).toHaveBeenCalledTimes(2);
    });

    it('limits historical viewport sessions used for session-list hydration priority', async () => {
        const { sync } = await import('./sync');
        const dateNow = vi.spyOn(Date, 'now');
        const harness = sync as unknown as {
            syncTuning: { sessionViewportHydrationPriorityMaxRows: number };
            getPrioritizedSessionHydrationIds: () => string[];
        };
        harness.syncTuning = {
            ...harness.syncTuning,
            sessionViewportHydrationPriorityMaxRows: 3,
        };

        ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'].forEach((sessionId, index) => {
            dateNow.mockReturnValue(1_000 + index);
            sync.onSessionVisible(sessionId);
        });

        expect(harness.getPrioritizedSessionHydrationIds()).toEqual(['session-5', 'session-4', 'session-3']);

        dateNow.mockRestore();
    });

    it('includes the actively viewed session in hydration priority before viewport tracking exists', async () => {
        const { sync } = await import('./sync');
        const { clearActiveViewingSessionId, setActiveViewingSessionId } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        setActiveViewingSessionId('session-active', 1);
        try {
            const priorityIds = (
                sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
            ).getPrioritizedSessionHydrationIds();

            expect(priorityIds[0]).toBe('session-active');
        } finally {
            clearActiveViewingSessionId('session-active', 1);
        }
    });

    it('clears active viewing hydration priority when server-scoped runtime state resets', async () => {
        const { sync } = await import('./sync');
        const { getActiveViewingSessionId, setActiveViewingSessionId } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        setActiveViewingSessionId('session-active', 1);
        expect(getActiveViewingSessionId()).toBe('session-active');

        sync.disconnectServer();

        const priorityIds = (
            sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
        ).getPrioritizedSessionHydrationIds();

        expect(getActiveViewingSessionId()).toBeNull();
        expect(priorityIds).not.toContain('session-active');
    });
});
