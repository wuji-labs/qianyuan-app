import * as React from 'react';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { SessionListViewItem, useSessionFolderAssignmentsBySessionKey, useSessionListViewData, useSessionListViewDataByServerId, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { computeVisibleSessionListViewData } from '@/sync/domains/session/listing/computeVisibleSessionListViewData';
import { applySessionFoldersToSessionListViewData } from '@/sync/domains/session/listing/sessionListViewData';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListViewDataByStorageKind } from '@/sync/domains/session/listing/filterSessionListViewDataByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { normalizeSessionFolders, type SessionFoldersV1 } from '@/sync/domains/session/folders';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplySessionFolderAssignments } from '@/sync/ops/sessionFolders';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

const EMPTY_PINNED_SESSION_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_SESSION_LIST_GROUP_ORDER: Readonly<Record<string, ReadonlyArray<string> | undefined>> = Object.freeze({});

type SessionListDataState = Readonly<{
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    selection: Readonly<{
        enabled: boolean;
        activeServerId: string;
        allowedServerIds: ReadonlyArray<string>;
        presentation: ReturnType<typeof useResolvedActiveServerSelection>['presentation'];
    }>;
    source: SessionListViewItem[] | null;
    normalizedGroupOrder: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    folderSource: SessionListViewItem[] | null;
    sessionFoldersEnabled: boolean;
}>;

function collectVisibleSessionIdsByServer(items: ReadonlyArray<SessionListViewItem> | null): Record<string, string[]> {
    const idsByServer: Record<string, string[]> = {};
    if (!items) return idsByServer;
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) continue;
        const bucket = idsByServer[serverId] ?? [];
        if (!bucket.includes(sessionId)) bucket.push(sessionId);
        idsByServer[serverId] = bucket;
    }
    return idsByServer;
}

function applySessionListStorageFilter(
    data: SessionListViewItem[] | null,
    storageFilter: SessionListStorageFilter,
): SessionListViewItem[] | null {
    if (!data || storageFilter === 'all') return data;
    return filterSessionListViewDataByStorageKind(data, storageFilter);
}

function buildVisibleSessionListViewData(
    state: SessionListDataState,
    storageFilter: SessionListStorageFilter,
    hideInactiveSessions: boolean,
): SessionListViewItem[] | null {
    if (!state.folderSource) return state.folderSource;

    const visible = computeVisibleSessionListViewData({
        source: state.folderSource,
        hideInactiveSessions,
        pinnedSessionKeysV1: state.pinnedSessionKeysV1,
        sessionListGroupOrderV1: state.normalizedGroupOrder,
        presentation: {
            enabled: state.selection.enabled,
            presentation: state.selection.presentation,
            selectedServerIds: state.selection.allowedServerIds,
        },
        storageFilterApplied: storageFilter !== 'all',
    });

    return applySessionListStorageFilter(visible, storageFilter);
}

function countRenderedSessions(data: SessionListViewItem[] | null): number {
    if (!data) return 0;
    return data.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0);
}

export function countVisibleSessionListSessions(data: SessionListViewItem[] | null): number {
    return countRenderedSessions(data);
}

function useSessionListDataState(storageFilter: SessionListStorageFilter): SessionListDataState {
    const activeData = useSessionListViewData();
    const dataByServerId = useSessionListViewDataByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const pinnedSessionKeysV1 = useSetting('pinnedSessionKeysV1') ?? EMPTY_PINNED_SESSION_KEYS;
    const sessionFoldersEnabled = useFeatureEnabled('sessions.folders');
    const sessionFoldersV1 = useSetting('sessionFoldersV1') as SessionFoldersV1 | null | undefined;
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1');
    const sessionFolderAssignmentsBySessionKey = useSessionFolderAssignmentsBySessionKey();
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const groupOrder = sessionListGroupOrderV1 ?? EMPTY_SESSION_LIST_GROUP_ORDER;
    const selection = useResolvedActiveServerSelection();
    const selectedServerIdsKey = React.useMemo(() => selection.allowedServerIds.join('\u0000'), [selection.allowedServerIds]);

    const source = React.useMemo(() => {
        return resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.allowedServerIds,
        });
    }, [
        activeData,
        dataByServerId,
        selectedServerIdsKey,
        selection.activeServerId,
        selection.enabled,
    ]);

    const storageFilteredSource = React.useMemo(
        () => applySessionListStorageFilter(source, storageFilter),
        [source, storageFilter],
    );

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return groupOrder;
        return normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: groupOrder,
        });
    }, [groupOrder, pinnedSessionKeysV1, source]);

    const normalizedSessionFolders = React.useMemo(
        () => normalizeSessionFolders(sessionFoldersV1 ?? { v: 1, folders: [] }),
        [sessionFoldersV1],
    );
    const sessionFoldersAvailableForStorage = storageFilter !== 'direct';

    const folderSource = React.useMemo(() => {
        if (!storageFilteredSource) return storageFilteredSource;
        if (!sessionFoldersAvailableForStorage || !sessionFoldersEnabled || sessionFolderViewModeV1 !== 'tree') {
            return storageFilteredSource;
        }
        return applySessionFoldersToSessionListViewData(storageFilteredSource, {
            enabled: true,
            folders: normalizedSessionFolders,
            assignmentsBySessionKey: sessionFolderAssignmentsBySessionKey,
        });
    }, [
        normalizedSessionFolders,
        sessionFolderAssignmentsBySessionKey,
        sessionFolderViewModeV1,
        sessionFoldersAvailableForStorage,
        sessionFoldersEnabled,
        storageFilteredSource,
    ]);

    const assignmentFetchBatches = React.useMemo(
        () => sessionFoldersAvailableForStorage && sessionFoldersEnabled && sessionFolderViewModeV1 === 'tree'
            ? collectVisibleSessionIdsByServer(storageFilteredSource)
            : {},
        [sessionFolderViewModeV1, sessionFoldersAvailableForStorage, sessionFoldersEnabled, storageFilteredSource],
    );

    React.useEffect(() => {
        if (!sessionFoldersEnabled || sessionFolderViewModeV1 !== 'tree') return;
        let cancelled = false;
        for (const [serverId, sessionIds] of Object.entries(assignmentFetchBatches)) {
            if (sessionIds.length === 0) continue;
            const profile = getServerProfileById(serverId);
            if (!profile) continue;
            void (async () => {
                const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                if (!credentials || cancelled) return;
                await fetchAndApplySessionFolderAssignments({
                    credentials,
                    serverId: profile.id,
                    serverUrl: profile.serverUrl,
                    sessionIds,
                    shouldContinue: () => !cancelled,
                });
            })().catch(() => undefined);
        }
        return () => {
            cancelled = true;
        };
    }, [assignmentFetchBatches, sessionFolderViewModeV1, sessionFoldersEnabled]);

    React.useEffect(() => {
        if (!source) return;
        if (areSessionListGroupOrderMapsEqual(groupOrder, normalizedGroupOrder)) {
            return;
        }
        setSessionListGroupOrderV1(normalizedGroupOrder);
    }, [groupOrder, normalizedGroupOrder, setSessionListGroupOrderV1, source]);

    return React.useMemo(() => ({
        hideInactiveSessions,
        pinnedSessionKeysV1,
        selection: {
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            allowedServerIds: selection.allowedServerIds,
            presentation: selection.presentation,
        },
        source,
        folderSource,
        normalizedGroupOrder,
        sessionFoldersEnabled,
    }), [
        folderSource,
        hideInactiveSessions,
        normalizedGroupOrder,
        pinnedSessionKeysV1,
        sessionFoldersEnabled,
        selectedServerIdsKey,
        selection.activeServerId,
        selection.enabled,
        selection.presentation,
        source,
    ]);
}

export function useVisibleSessionListViewData(storageFilter: SessionListStorageFilter = 'all'): SessionListViewItem[] | null {
    const state = useSessionListDataState(storageFilter);

    return React.useMemo(() => {
        return buildVisibleSessionListViewData(state, storageFilter, state.hideInactiveSessions);
    }, [state, storageFilter]);
}

export function useHasHiddenInactiveSessions(storageFilter: SessionListStorageFilter = 'all'): boolean {
    const state = useSessionListDataState(storageFilter);

    return React.useMemo(() => {
        if (!state.source || state.hideInactiveSessions !== true) return false;

        const visible = buildVisibleSessionListViewData(state, storageFilter, true);
        const visibleSessionCount = countRenderedSessions(visible);
        if (visibleSessionCount > 0) return false;
        const unhidden = buildVisibleSessionListViewData(state, storageFilter, false);
        return countRenderedSessions(unhidden) > visibleSessionCount;
    }, [state, storageFilter]);
}

export function useVisibleSessionListPaneState(storageFilter: SessionListStorageFilter = 'all'): Readonly<{
    sessionListViewData: SessionListViewItem[] | null;
    visibleSessionCount: number;
    hasHiddenInactiveSessions: boolean;
}> {
    const state = useSessionListDataState(storageFilter);

    return React.useMemo(() => {
        const sessionListViewData = buildVisibleSessionListViewData(state, storageFilter, state.hideInactiveSessions);
        const visibleSessionCount = countRenderedSessions(sessionListViewData);
        if (!state.source || state.hideInactiveSessions !== true) {
            return {
                sessionListViewData,
                visibleSessionCount,
                hasHiddenInactiveSessions: false,
            };
        }

        if (visibleSessionCount > 0) {
            return {
                sessionListViewData,
                visibleSessionCount,
                hasHiddenInactiveSessions: false,
            };
        }

        const unhidden = buildVisibleSessionListViewData(state, storageFilter, false);
        return {
            sessionListViewData,
            visibleSessionCount,
            hasHiddenInactiveSessions: countRenderedSessions(unhidden) > visibleSessionCount,
        };
    }, [state, storageFilter]);
}
