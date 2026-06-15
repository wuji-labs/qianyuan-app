import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { VisibleSessionListViewDataOptions } from '@/hooks/session/useVisibleSessionListViewData';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
    storageKinds: [] as string[],
    paneOptions: [] as Array<VisibleSessionListViewDataOptions | undefined>,
    paneHookCalls: 0,
    contentRenderCalls: 0,
    paneVersion: 0,
    paneListeners: new Set<() => void>(),
}));
const routeState = vi.hoisted(() => ({
    pathname: '/',
}));
const emptyStateState = vi.hoisted(() => ({
    hasHiddenInactiveSessions: false,
}));
const featureDecisionState = vi.hoisted(() => ({
    enabled: false,
}));
const storageKindState = vi.hoisted(() => ({
    storageKind: 'persisted' as 'persisted' | 'direct',
    setStorageKind: vi.fn(),
}));
const focusState = vi.hoisted(() => ({
    isFocused: true,
    listeners: new Set<() => void>(),
}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                textSecondary: '#777',
                groupped: { background: '#fff' },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => routeState.pathname,
        }).module;
    },
});
vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: (storageKind?: string) => {
        sessionListState.storageKinds.push(storageKind ?? 'all');
        return sessionListState.data;
    },
    useVisibleSessionListPaneState: (
        storageKind?: string,
        options?: VisibleSessionListViewDataOptions,
    ) => {
        React.useSyncExternalStore(
            (listener) => {
                sessionListState.paneListeners.add(listener);
                return () => {
                    sessionListState.paneListeners.delete(listener);
                };
            },
            () => sessionListState.paneVersion,
            () => sessionListState.paneVersion,
        );
        sessionListState.paneHookCalls += 1;
        sessionListState.storageKinds.push(storageKind ?? 'all');
        sessionListState.paneOptions.push(options);
        return {
            sessionListViewData: sessionListState.data,
            visibleSessionCount: sessionListState.data?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0,
            hasHiddenInactiveSessions: emptyStateState.hasHiddenInactiveSessions,
        };
    },
    useHasHiddenInactiveSessions: () => emptyStateState.hasHiddenInactiveSessions,
    countVisibleSessionListSessions: (data: Array<{ type?: string }> | null) => (
        data?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0
    ),
}));
vi.mock('@/components/sessions/model/useSessionListStorageKind', () => ({
    useSessionListStorageKind: () => ({
        directSessionsEnabled: featureDecisionState.enabled,
        storageKind: featureDecisionState.enabled ? storageKindState.storageKind : 'persisted',
        setStorageKind: storageKindState.setStorageKind,
    }),
}));
vi.mock('@/components/sessions/shell/SessionsListStorageChrome', () => ({
    SessionsListStorageChrome: (props: any) => React.createElement('SessionsListStorageChrome', props),
}));
vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/HiddenInactiveSessionsEmptyState', () => ({
    HiddenInactiveSessionsEmptyState: 'HiddenInactiveSessionsEmptyState',
}));
vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: (props: any) => React.createElement('SessionsList', props),
    SessionsListContent: (props: any) => {
        sessionListState.contentRenderCalls += 1;
        return React.createElement('SessionsListContent', props);
    },
}));
vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => React.useSyncExternalStore(
        (listener) => {
            focusState.listeners.add(listener);
            return () => {
                focusState.listeners.delete(listener);
            };
        },
        () => focusState.isFocused,
        () => focusState.isFocused,
    ),
}));
async function renderSessionsListWrapper() {
    const { SessionsListWrapper } = await import('./SessionsListWrapper');
    return renderScreen(<SessionsListWrapper />);
}

describe('SessionsListWrapper (empty state)', () => {
    beforeEach(() => {
        sessionListState.data = [];
        sessionListState.storageKinds = [];
        sessionListState.paneOptions = [];
        sessionListState.paneHookCalls = 0;
        sessionListState.contentRenderCalls = 0;
        sessionListState.paneVersion = 0;
        sessionListState.paneListeners.clear();
        routeState.pathname = '/';
        emptyStateState.hasHiddenInactiveSessions = false;
        featureDecisionState.enabled = false;
        storageKindState.storageKind = 'persisted';
        storageKindState.setStorageKind.mockReset();
        focusState.isFocused = true;
        focusState.listeners.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('renders getting started guidance when there are no sessions', async () => {
        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).not.toThrow();

        await screen.unmount();
    });

    it('uses the persisted storage filter when direct sessions are disabled', async () => {
        const screen = await renderSessionsListWrapper();

        expect(sessionListState.storageKinds).toEqual(['persisted']);

        await screen.unmount();
    });

    it('shows storage tabs and uses the selected direct storage filter when direct sessions are enabled', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        expect(sessionListState.storageKinds).toEqual(['direct']);
        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListContent' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListContent' as any).props.data).toBe(sessionListState.data);

        await screen.unmount();
    });

    it('keeps the storage chrome visible in the direct empty state', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [];

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });

    it('renders the hidden inactive sessions notice when the filter hides every session', async () => {
        emptyStateState.hasHiddenInactiveSessions = true;

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('HiddenInactiveSessionsEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();

        await screen.unmount();
    });

    it('treats header-only list data as empty when hidden inactive sessions removed all actual session rows', async () => {
        emptyStateState.hasHiddenInactiveSessions = true;
        sessionListState.data = [{ type: 'header', title: 'Today' }];

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('HiddenInactiveSessionsEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the storage chrome visible when the direct tab already has sessions', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListContent' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });

    it('passes the precomputed visible list to the rendered sessions list path', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        expect(sessionListState.paneHookCalls).toBe(1);
        expect(sessionListState.storageKinds).toEqual(['direct']);
        expect(screen.findByType('SessionsListContent' as any).props.data).toBe(sessionListState.data);

        await screen.unmount();
    });

    it('marks the list inactive while retaining native list content on focus loss', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        act(() => {
            focusState.isFocused = false;
            for (const listener of Array.from(focusState.listeners)) {
                listener();
            }
        });

        expect(sessionListState.paneOptions).toEqual([{
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        }]);
        expect(screen.findByType('SessionsListContent' as any).props.surfaceOwnership).toMatchObject({
            visible: true,
            interactive: false,
            dataActive: false,
        });
        await screen.unmount();
    });

    it('passes active-session identity while marking foreground session routes inactive', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        routeState.pathname = '/session/session-2';

        const screen = await renderSessionsListWrapper();

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('uses an explicit pathname without treating it as the foreground surface route', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        routeState.pathname = '/session/session-2';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the inactive new-session sheet surface unsubscribed until the root list becomes active', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        focusState.isFocused = true;
        routeState.pathname = '/new';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/new" />);

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the inactive foreground session route surface unsubscribed until the root list becomes active', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        focusState.isFocused = true;
        routeState.pathname = '/session/session-2';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-2" />);

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('seeds retained pane data and foreground session identity when returning from a foreground session route', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const retainedData = [{ type: 'session', session: { id: 'session-2' } }];
        sessionListState.data = retainedData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions).toEqual([{
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        }]);

        routeState.pathname = '/session/session-2';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-2" />);
        expect(sessionListState.paneOptions).toHaveLength(1);

        routeState.pathname = '/';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions[0]).toEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });
        expect(sessionListState.paneOptions[1]).toEqual({
            activeSessionId: 'session-2',
            retainedSessionListViewData: retainedData,
            sessionListSurfaceDataActive: true,
        });

        await screen.unmount();
    });

    it('does not seed retained pane data after the storage kind changes while returning from a foreground session route', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const persistedData = [{ type: 'session', session: { id: 'persisted-session' } }];
        const directData = [{ type: 'session', session: { id: 'direct-session' } }];
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'persisted';
        sessionListState.data = persistedData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions).toEqual([{
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        }]);

        routeState.pathname = '/session/persisted-session';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/persisted-session" />);
        expect(sessionListState.paneOptions).toHaveLength(1);

        storageKindState.storageKind = 'direct';
        sessionListState.data = directData;
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/persisted-session?storage=direct" />);
        await flushHookEffects({ cycles: 1, turns: 4 });
        expect(sessionListState.paneOptions).toHaveLength(1);

        routeState.pathname = '/';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.storageKinds.at(-1)).toBe('direct');
        expect(sessionListState.paneOptions[1]).toEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });

        await screen.unmount();
    });

    it('does not re-render the list content when wrapper-only state changes keep the same visible data', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper />);
        expect(sessionListState.contentRenderCalls).toBe(1);

        await act(async () => {
            sessionListState.paneVersion += 1;
            for (const listener of sessionListState.paneListeners) {
                listener();
            }
        });

        expect(sessionListState.paneHookCalls).toBeGreaterThanOrEqual(2);
        expect(sessionListState.contentRenderCalls).toBe(1);

        await screen.unmount();
    });
});
