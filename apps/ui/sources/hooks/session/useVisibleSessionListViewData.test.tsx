import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

function makeRenderableSession(id: string, overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

const sourceData = vi.hoisted(() => ({
    activeData: [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey: 'server:server-a:day:2026-05-04',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderableSession('session-a'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
    ] as SessionListViewItem[],
    hideInactiveSessions: false,
    groupOrder: {} as Record<string, readonly string[] | undefined>,
    pinnedKeys: [] as string[],
    setGroupOrder: vi.fn(),
    sessionFoldersEnabled: false,
    sessionFolderViewModeV1: 'off' as 'off' | 'tree',
    sessionFoldersV1: { v: 1, folders: [] } as SessionFoldersV1,
    fetchAndApplySessionFolderAssignments: vi.fn(async () => undefined),
    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => sourceData.activeData,
            useSessionListViewDataByServerId: () => ({}),
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return sourceData.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return sourceData.pinnedKeys;
                if (key === 'sessionFolderViewModeV1') return sourceData.sessionFolderViewModeV1;
                if (key === 'sessionFoldersV1') return sourceData.sessionFoldersV1;
                return null;
            },
            useSettingMutable: (key: string) => {
                if (key === 'sessionListGroupOrderV1') {
                    return [sourceData.groupOrder, sourceData.setGroupOrder];
                }
                return [null, vi.fn()];
            },
        },
    });
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: false,
        activeServerId: 'server-a',
        allowedServerIds: ['server-a'],
        presentation: 'grouped',
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => sourceData.sessionFoldersEnabled,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: (serverId: string) => serverId === 'server-a'
        ? { id: 'server-a', serverUrl: 'https://server-a.test' }
        : null,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: sourceData.getCredentialsForServerUrl,
    },
}));

vi.mock('@/sync/ops/sessionFolders', () => ({
    fetchAndApplySessionFolderAssignments: sourceData.fetchAndApplySessionFolderAssignments,
}));

describe('useVisibleSessionListViewData', () => {
    afterEach(() => {
        sourceData.hideInactiveSessions = false;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        sourceData.sessionFoldersEnabled = false;
        sourceData.sessionFolderViewModeV1 = 'off';
        sourceData.sessionFoldersV1 = { v: 1, folders: [] };
        sourceData.fetchAndApplySessionFolderAssignments.mockClear();
        sourceData.getCredentialsForServerUrl.mockClear();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        standardCleanup();
    });

    it('keeps the visible list reference stable across unrelated rerenders', async () => {
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();

        const second = await hook.rerender();

        expect(second).toBe(first);
        await hook.unmount();
    });

    it('does not compute the unhidden list when hidden inactive filtering still leaves visible sessions', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-active', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-inactive'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListPaneState());
        const paneState = hook.getCurrent();

        expect(paneState.visibleSessionCount).toBe(1);
        expect(paneState.hasHiddenInactiveSessions).toBe(false);
        await hook.unmount();
    });

    it('does not compute hidden-session availability when the sidebar list is not empty', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-active', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-inactive'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { useHasHiddenInactiveSessions } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useHasHiddenInactiveSessions());

        expect(hook.getCurrent()).toBe(false);
        const visibleComputeEvent = syncPerformanceTelemetry.snapshot().events.find((event) =>
            event.name === 'sync.sessions.list.visible.compute',
        );
        expect(visibleComputeEvent?.count).toBe(1);
        await hook.unmount();
    });

    it('does not fetch synced folder assignments for the Direct storage filter', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Folder',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('persisted-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('direct-session', {
                    active: true,
                    metadata: {
                        path: '/repo',
                        host: 'machine-a',
                        directSessionV1: { v: 1, providerId: 'codex' },
                    },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('direct'));

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['direct-session']);
        expect(hook.getCurrent()?.some((item) => item.type === 'header' && item.headerKind === 'folder'))
            .toBe(false);
        expect(sourceData.fetchAndApplySessionFolderAssignments).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
