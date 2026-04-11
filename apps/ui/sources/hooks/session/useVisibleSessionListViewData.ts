import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSessionListViewDataByServerId, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { computeVisibleSessionListViewData } from '@/sync/domains/session/listing/computeVisibleSessionListViewData';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListViewDataByStorageKind } from '@/sync/domains/session/listing/filterSessionListViewDataByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

type SessionListDataState = Readonly<{
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    selection: ReturnType<typeof useResolvedActiveServerSelection>;
    source: SessionListViewItem[] | null;
    normalizedGroupOrder: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>;

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
    if (!state.source) return state.source;

    const visible = computeVisibleSessionListViewData({
        source: state.source,
        hideInactiveSessions,
        pinnedSessionKeysV1: state.pinnedSessionKeysV1,
        sessionListGroupOrderV1: state.normalizedGroupOrder,
        presentation: {
            enabled: state.selection.enabled,
            presentation: state.selection.presentation,
            selectedServerIds: state.selection.allowedServerIds,
        },
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

function useSessionListDataState(): SessionListDataState {
    const activeData = useSessionListViewData();
    const dataByServerId = useSessionListViewDataByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const pinnedSessionKeysV1 = useSetting('pinnedSessionKeysV1') ?? [];
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const selection = useResolvedActiveServerSelection();

    const source = React.useMemo(() => {
        return resolveSessionListSourceData({
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            activeData,
            byServerId: dataByServerId,
            selectedServerIds: selection.allowedServerIds,
        });
    }, [activeData, dataByServerId, selection]);

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        return normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [pinnedSessionKeysV1, sessionListGroupOrderV1, source]);

    React.useEffect(() => {
        if (!source) return;
        if (areSessionListGroupOrderMapsEqual(sessionListGroupOrderV1, normalizedGroupOrder)) {
            return;
        }
        setSessionListGroupOrderV1(normalizedGroupOrder);
    }, [normalizedGroupOrder, sessionListGroupOrderV1, setSessionListGroupOrderV1, source]);

    return {
        hideInactiveSessions,
        pinnedSessionKeysV1,
        selection,
        source,
        normalizedGroupOrder,
    };
}

export function useVisibleSessionListViewData(storageFilter: SessionListStorageFilter = 'all'): SessionListViewItem[] | null {
    const state = useSessionListDataState();

    return React.useMemo(() => {
        return buildVisibleSessionListViewData(state, storageFilter, state.hideInactiveSessions);
    }, [state, storageFilter]);
}

export function useHasHiddenInactiveSessions(storageFilter: SessionListStorageFilter = 'all'): boolean {
    const state = useSessionListDataState();

    return React.useMemo(() => {
        if (!state.source || state.hideInactiveSessions !== true) return false;

        const visible = buildVisibleSessionListViewData(state, storageFilter, true);
        const unhidden = buildVisibleSessionListViewData(state, storageFilter, false);
        return countRenderedSessions(unhidden) > countRenderedSessions(visible);
    }, [state, storageFilter]);
}
