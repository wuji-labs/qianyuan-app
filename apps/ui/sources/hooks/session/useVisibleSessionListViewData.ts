import * as React from 'react';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { SessionListViewItem, useArtifacts, useSessionFolderAssignmentsBySessionKey, useSessionListViewData, useSessionListViewDataByServerId, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { collectOpenApprovalSessionIds } from '@/sync/domains/artifacts/approvalArtifacts';
import { resolveSessionListSourceData } from '@/sync/domains/session/listing/sessionListPresentation';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { buildSessionListIndexFromViewData } from '@/sync/domains/session/listing/sessionListIndex';
import { buildSessionListViewDataFromIndex } from '@/sync/domains/session/listing/sessionListViewDataFromIndex';
import { applySessionFoldersToSessionListViewData } from '@/sync/domains/session/listing/sessionListViewData';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListViewDataByStorageKind } from '@/sync/domains/session/listing/filterSessionListViewDataByStorageKind';
import {
    normalizeSessionListAttentionPromotionMode,
    type SessionListAttentionPromotionMode,
    type SessionListAttentionPromotionOptions,
} from '@/sync/domains/session/listing/attentionPromotion/sessionListAttentionPromotion';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { normalizeSessionFolders, type SessionFoldersV1 } from '@/sync/domains/session/folders';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplySessionFolderAssignments } from '@/sync/ops/sessionFolders';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

const EMPTY_PINNED_SESSION_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_SESSION_LIST_GROUP_ORDER: Readonly<Record<string, ReadonlyArray<string> | undefined>> = Object.freeze({});
const DISABLED_ATTENTION_PROMOTION_OPTIONS: SessionListAttentionPromotionOptions = Object.freeze({
    mode: 'off',
});
const EMPTY_ATTENTION_RETAIN_KEYS: ReadonlyArray<string> = Object.freeze([]);

export type VisibleSessionListViewDataOptions = Readonly<{
    activeSessionId?: string | null;
}>;

type SessionListDataState = Readonly<{
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListAttentionPromotionMode: SessionListAttentionPromotionMode;
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

function applyOpenApprovalFlagsToSessionListSource(
    data: SessionListViewItem[] | null,
    sessionIdsWithOpenApprovals: ReadonlySet<string>,
): SessionListViewItem[] | null {
    if (!data || sessionIdsWithOpenApprovals.size === 0) return data;

    let next: SessionListViewItem[] | null = null;
    for (let index = 0; index < data.length; index += 1) {
        const item = data[index];
        if (item.type !== 'session' || !sessionIdsWithOpenApprovals.has(item.session.id)) {
            if (next) next.push(item);
            continue;
        }

        const nextItem = item.session.hasPendingPermissionRequests === true
            ? item
            : {
                ...item,
                session: {
                    ...item.session,
                    hasPendingPermissionRequests: true,
                },
            };
        if (!next) next = data.slice(0, index);
        next.push(nextItem);
    }

    return next ?? data;
}

function buildSessionRowResolver(source: ReadonlyArray<SessionListViewItem>) {
    const byKey = new Map<string, Extract<SessionListViewItem, { type: 'session' }>['session']>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) continue;
        byKey.set(`${serverId}:${sessionId}`, item.session);
    }
    return (serverIdRaw: string | null | undefined, sessionIdRaw: string) => {
        const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
        const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
        if (!serverId || !sessionId) return null;
        return byKey.get(`${serverId}:${sessionId}`) ?? null;
    };
}

function buildVisibleSessionListViewData(
    state: SessionListDataState,
    storageFilter: SessionListStorageFilter,
    hideInactiveSessions: boolean,
    options: Readonly<{
        retainAttentionSessionKeys?: ReadonlyArray<string>;
    }> = {},
): SessionListViewItem[] | null {
    if (!state.folderSource) return state.folderSource;

    const sourceIndex = buildSessionListIndexFromViewData(state.folderSource);
    const visibleIndex = computeVisibleSessionListIndex({
        source: sourceIndex,
        resolveSessionRow: buildSessionRowResolver(state.folderSource),
        hideInactiveSessions,
        pinnedSessionKeysV1: state.pinnedSessionKeysV1,
        sessionListGroupOrderV1: state.normalizedGroupOrder,
        presentation: {
            enabled: state.selection.enabled,
            presentation: state.selection.presentation,
            selectedServerIds: state.selection.allowedServerIds,
        },
        storageFilterApplied: storageFilter !== 'all',
        attentionPromotion: state.sessionListAttentionPromotionMode !== 'off'
            ? {
                mode: state.sessionListAttentionPromotionMode,
                retainSessionKeys: options.retainAttentionSessionKeys,
            }
            : DISABLED_ATTENTION_PROMOTION_OPTIONS,
    });

    return buildSessionListViewDataFromIndex({
        index: visibleIndex,
        source: state.folderSource,
        sourceIndex,
    });
}

function buildSessionListSessionKey(item: Extract<SessionListViewItem, { type: 'session' }>): string | null {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

function collectRetainedAttentionSessionKeys(params: Readonly<{
    previousVisible: ReadonlyArray<SessionListViewItem> | null | undefined;
    activeSessionId: string | null | undefined;
    mode: SessionListAttentionPromotionMode;
}>): ReadonlyArray<string> {
    if (params.mode === 'off') return EMPTY_ATTENTION_RETAIN_KEYS;
    const activeSessionId = typeof params.activeSessionId === 'string' ? params.activeSessionId.trim() : '';
    if (!activeSessionId || !params.previousVisible) return EMPTY_ATTENTION_RETAIN_KEYS;
    for (const item of params.previousVisible) {
        if (item.type !== 'session') continue;
        if (item.groupKind !== 'attention' && !item.attentionPromotionReason) continue;
        if (item.session.id !== activeSessionId) continue;
        const key = buildSessionListSessionKey(item);
        return key ? [key] : EMPTY_ATTENTION_RETAIN_KEYS;
    }
    return EMPTY_ATTENTION_RETAIN_KEYS;
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
    const artifacts = useArtifacts();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const sessionListAttentionPromotionMode = normalizeSessionListAttentionPromotionMode(useSetting('sessionListAttentionPromotionModeV1'));
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

    const openApprovalSessionIds = React.useMemo(
        () => collectOpenApprovalSessionIds(artifacts),
        [artifacts],
    );
    const attentionSource = React.useMemo(
        () => applyOpenApprovalFlagsToSessionListSource(folderSource, openApprovalSessionIds),
        [folderSource, openApprovalSessionIds],
    );

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
                    fetchPolicy: 'missing',
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
        sessionListAttentionPromotionMode,
        selection: {
            enabled: selection.enabled,
            activeServerId: selection.activeServerId,
            allowedServerIds: selection.allowedServerIds,
            presentation: selection.presentation,
        },
        source,
        folderSource: attentionSource,
        normalizedGroupOrder,
        sessionFoldersEnabled,
    }), [
        attentionSource,
        folderSource,
        hideInactiveSessions,
        normalizedGroupOrder,
        pinnedSessionKeysV1,
        sessionListAttentionPromotionMode,
        sessionFoldersEnabled,
        selectedServerIdsKey,
        selection.activeServerId,
        selection.enabled,
        selection.presentation,
        source,
    ]);
}

export function useVisibleSessionListViewData(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewDataOptions = {},
): SessionListViewItem[] | null {
    const state = useSessionListDataState(storageFilter);
    const previousVisibleRef = React.useRef<SessionListViewItem[] | null>(null);

    const visible = React.useMemo(() => {
        return buildVisibleSessionListViewData(state, storageFilter, state.hideInactiveSessions, {
            retainAttentionSessionKeys: collectRetainedAttentionSessionKeys({
                previousVisible: previousVisibleRef.current,
                activeSessionId: options.activeSessionId,
                mode: state.sessionListAttentionPromotionMode,
            }),
        });
    }, [options.activeSessionId, state, storageFilter]);

    React.useEffect(() => {
        previousVisibleRef.current = visible;
    }, [visible]);

    return visible;
}

export function useHasHiddenInactiveSessions(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewDataOptions = {},
): boolean {
    const state = useSessionListDataState(storageFilter);
    const previousVisibleRef = React.useRef<SessionListViewItem[] | null>(null);

    const result = React.useMemo(() => {
        if (!state.source || state.hideInactiveSessions !== true) return false;

        const retainAttentionSessionKeys = collectRetainedAttentionSessionKeys({
            previousVisible: previousVisibleRef.current,
            activeSessionId: options.activeSessionId,
            mode: state.sessionListAttentionPromotionMode,
        });
        const visible = buildVisibleSessionListViewData(state, storageFilter, true, { retainAttentionSessionKeys });
        const visibleSessionCount = countRenderedSessions(visible);
        if (visibleSessionCount > 0) return false;
        const unhidden = buildVisibleSessionListViewData(state, storageFilter, false, { retainAttentionSessionKeys });
        return countRenderedSessions(unhidden) > visibleSessionCount;
    }, [options.activeSessionId, state, storageFilter]);

    return result;
}

export function useVisibleSessionListPaneState(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListViewDataOptions = {},
): Readonly<{
    sessionListViewData: SessionListViewItem[] | null;
    visibleSessionCount: number;
    hasHiddenInactiveSessions: boolean;
}> {
    const state = useSessionListDataState(storageFilter);
    const previousVisibleRef = React.useRef<SessionListViewItem[] | null>(null);

    const paneState = React.useMemo(() => {
        const retainAttentionSessionKeys = collectRetainedAttentionSessionKeys({
            previousVisible: previousVisibleRef.current,
            activeSessionId: options.activeSessionId,
            mode: state.sessionListAttentionPromotionMode,
        });
        const sessionListViewData = buildVisibleSessionListViewData(state, storageFilter, state.hideInactiveSessions, { retainAttentionSessionKeys });
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

        const unhidden = buildVisibleSessionListViewData(state, storageFilter, false, { retainAttentionSessionKeys });
        return {
            sessionListViewData,
            visibleSessionCount,
            hasHiddenInactiveSessions: countRenderedSessions(unhidden) > visibleSessionCount,
        };
    }, [options.activeSessionId, state, storageFilter]);

    React.useEffect(() => {
        previousVisibleRef.current = paneState.sessionListViewData;
    }, [paneState.sessionListViewData]);

    return paneState;
}
