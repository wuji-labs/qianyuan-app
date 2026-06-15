import React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useIsTablet } from '@/utils/platform/responsive';
import {
    SessionListViewItem,
    useLocalSettingMutable,
    useMachineDisplayById,
    useProfile,
    useSessionFolderAssignmentsBySessionKey,
    useSetting,
    useSettingMutable,
} from '@/sync/domains/state/storage';
import { applySessionFoldersToSessionListViewData } from '@/sync/domains/session/listing/sessionListViewData';
import {
    buildSessionListIndexFromViewData,
    type SessionListIndexItem,
} from '@/sync/domains/session/listing/sessionListIndex';
import {
    DEFAULT_SESSION_FOLDERS_V1,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';
import { normalizeSessionListFolderSortMode } from '@/sync/domains/session/listing/sessionListFolderSortMode';
import {
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListFolderSortMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    countCollapsedSessionListGroups,
    filterCollapsedSessionListItems,
} from '../sessionListCollapsedItems';
import {
    buildSessionListReachabilityModels,
    createSessionListReachabilityModelsCache,
} from '../sessionListReachabilityModels';
import {
    buildSessionListSelectedItems,
    type SessionListSelectedItem,
} from '../sessionListSelectedItems';
import {
    buildSessionFolderMoveTargets,
    filterSessionListItemsByFocusedFolder,
    type SessionFolderViewModeV1,
} from '../sessionFolderShellTypes';
import { getAllKnownTags } from '../sessionTagUtils';
import { useSessionListFocusedFolderState } from './useSessionListFocusedFolderState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import {
    filterSessionListItemsForHeaderControls,
    hasActiveSessionListHeaderFilters,
    type SessionListHeaderFilterInput,
} from '../sessionListFilters';
import { useSessionListSnapshotWhenInactive } from '../surface/useSessionListSnapshotWhenInactive';

const EMPTY_SESSION_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_SESSION_LIST_GROUP_ORDER: Readonly<Record<string, ReadonlyArray<string> | undefined>> = Object.freeze({});
const EMPTY_SESSION_WORKSPACE_ORDER: Readonly<Record<string, ReadonlyArray<string> | undefined>> = Object.freeze({});

const useSessionFolderViewModeMutable = useSettingMutable as unknown as (
    name: 'sessionFolderViewModeV1'
) => [SessionFolderViewModeV1 | null | undefined, (value: SessionFolderViewModeV1) => void];

const useSessionFoldersMutable = useSettingMutable as unknown as (
    name: 'sessionFoldersV1'
) => [SessionFoldersV1 | null | undefined, (value: SessionFoldersV1) => void];

function countSessionListItems(items: ReadonlyArray<SessionListViewItem> | null | undefined): number {
    if (!items) return 0;
    return items.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0);
}

function measureSessionListRenderDerivation<T>(
    name: string,
    items: ReadonlyArray<SessionListViewItem> | null | undefined,
    fields: () => Readonly<Record<string, number>>,
    compute: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) {
        return compute();
    }
    return syncPerformanceTelemetry.measure(
        name,
        {
            items: items?.length ?? 0,
            ...fields(),
        },
        compute,
    );
}

export type UseSessionListViewStateInput = Readonly<{
    data: SessionListViewItem[] | null;
    pathname: string;
    storageKind?: SessionListStorageFilter;
    headerFilters?: SessionListHeaderFilterInput;
    sessionListSurfaceDataActive?: boolean;
}>;

export function useSessionListViewState({
    data,
    headerFilters,
    pathname,
    sessionListSurfaceDataActive = true,
    storageKind,
}: UseSessionListViewStateInput) {
    const isTablet = useIsTablet();
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionMruOrderV1, setSessionMruOrderV1] = useLocalSettingMutable('sessionMruOrderV1');
    const [sessionListFolderSortModeRaw, setSessionListFolderSortModeV1] = useLocalSettingMutable('sessionListFolderSortModeV1');
    const [sessionListOrderingModeRaw, setSessionListOrderingModeV1] = useSettingMutable('sessionListOrderingModeV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const [sessionWorkspaceOrderV1, setSessionWorkspaceOrderV1] = useSettingMutable('sessionWorkspaceOrderV1');
    const [sessionFolderViewModeRaw, setSessionFolderViewModeV1] = useSessionFolderViewModeMutable('sessionFolderViewModeV1');
    const [sessionFoldersV1Raw, setSessionFoldersV1] = useSessionFoldersMutable('sessionFoldersV1');
    const [sessionTagsV1, setSessionTagsV1] = useSettingMutable('sessionTagsV1');
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const [hideInactiveSessionsSetting, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const rememberLastProjectSessionSelections = useSetting('rememberLastProjectSessionSelections') !== false;
    const [workspaceLabelsV1, setWorkspaceLabelsV1] = useSettingMutable('workspaceLabelsV1');
    const workspaceFaviconsEnabled = useSetting('workspaceFaviconsEnabled') !== false;
    const workspaceMachineSubtitlesEnabled = useSetting('workspaceMachineSubtitlesEnabled') !== false;
    const [collapsedGroupKeysV1, setCollapsedGroupKeysV1] = useSettingMutable('collapsedGroupKeysV1');
    const sessionListDensity = useSetting('sessionListDensity');
    const profile = useProfile();
    const machineDisplayById = useMachineDisplayById();
    const renderMachineDisplayById = useSessionListSnapshotWhenInactive(
        machineDisplayById,
        sessionListSurfaceDataActive,
    );
    const selection = useResolvedActiveServerSelection();
    const sessionFoldersDecision = useFeatureDecision('sessions.folders');
    const sessionFolderAssignmentsBySessionKey = useSessionFolderAssignmentsBySessionKey();

    const hideInactiveSessions = hideInactiveSessionsSetting === true;
    const compactSessionView = sessionListDensity === 'cozy' || sessionListDensity === 'narrow';
    const compactSessionViewMinimal = sessionListDensity === 'narrow';
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const selectedServerCount = selection.allowedServerIds?.length ?? 0;
    const showServerBadge = selection.enabled && selection.presentation === 'flat-with-badge' && selectedServerCount > 1;
    const showPinnedServerBadge = selection.enabled && selectedServerCount > 1;
    const selectable = isTablet;
    const folderActionsEnabled = storageKind !== 'direct' && sessionFoldersDecision?.state === 'enabled';
    const sessionFolderViewMode: SessionFolderViewModeV1 = sessionFolderViewModeRaw === 'tree' ? 'tree' : 'off';
    const sessionListSavedFolderSortMode = normalizeSessionListFolderSortMode(sessionListFolderSortModeRaw);
    const sessionListOrderingMode = normalizeSessionListOrderingModeV1(sessionListOrderingModeRaw);
    const sessionListFolderSortMode = resolveEffectiveSessionListFolderSortMode({
        orderingMode: sessionListOrderingMode,
        folderSortMode: sessionListSavedFolderSortMode,
    });
    const folderViewEnabled = folderActionsEnabled && sessionFolderViewMode === 'tree';
    const sessionFoldersV1 = sessionFoldersV1Raw ?? DEFAULT_SESSION_FOLDERS_V1;
    const pinnedKeyList = Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : EMPTY_SESSION_KEYS;
    const currentGroupOrderMap = sessionListGroupOrderV1 ?? EMPTY_SESSION_LIST_GROUP_ORDER;
    const currentWorkspaceOrderMap = sessionWorkspaceOrderV1 ?? EMPTY_SESSION_WORKSPACE_ORDER;

    const pinnedKeySet = React.useMemo(() => {
        return new Set(Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : []);
    }, [pinnedSessionKeysV1]);

    const allKnownTags = React.useMemo(() => getAllKnownTags(sessionTagsV1), [sessionTagsV1]);

    const folderPresentedData = React.useMemo(() => {
        if (!data || !folderViewEnabled) return data;
        return applySessionFoldersToSessionListViewData(data, {
            enabled: true,
            folders: sessionFoldersV1,
            assignmentsBySessionKey: sessionFolderAssignmentsBySessionKey,
        });
    }, [data, folderViewEnabled, sessionFolderAssignmentsBySessionKey, sessionFoldersV1]);

    const headerFiltersActive = hasActiveSessionListHeaderFilters(headerFilters);

    const collapsedListItems = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.collapsedFiltering',
            folderPresentedData,
            () => ({ collapsedGroups: countCollapsedSessionListGroups(collapsedGroupKeysV1) }),
            () => {
                if (!folderPresentedData || headerFiltersActive) return folderPresentedData;
                return filterCollapsedSessionListItems(folderPresentedData, collapsedGroupKeysV1);
            },
        );
    }, [folderPresentedData, headerFiltersActive, collapsedGroupKeysV1]);

    const focusedFolderState = useSessionListFocusedFolderState({
        canInvalidateFocusedFolder: sessionListSurfaceDataActive,
        folderViewEnabled,
        folderPresentedData,
    });

    const focusedListItems = React.useMemo(() => {
        if (!folderViewEnabled || !focusedFolderState.focusedFolderId || !collapsedListItems) return collapsedListItems;
        return filterSessionListItemsByFocusedFolder(collapsedListItems, focusedFolderState.focusedFolderId);
    }, [collapsedListItems, focusedFolderState.focusedFolderId, folderViewEnabled]);

    const selectionScopeBaseListItems = React.useMemo(() => {
        if (!folderViewEnabled || !focusedFolderState.focusedFolderId || !folderPresentedData) return folderPresentedData;
        return filterSessionListItemsByFocusedFolder(folderPresentedData, focusedFolderState.focusedFolderId);
    }, [folderPresentedData, focusedFolderState.focusedFolderId, folderViewEnabled]);

    const selectionScopeListItems = React.useMemo(() => {
        if (!selectionScopeBaseListItems || !headerFilters) return selectionScopeBaseListItems;
        return filterSessionListItemsForHeaderControls(selectionScopeBaseListItems, {
            ...headerFilters,
            sessionTags: sessionTagsV1 ?? {},
        });
    }, [selectionScopeBaseListItems, headerFilters, sessionTagsV1]);

    const filteredListItems = React.useMemo(() => {
        if (!focusedListItems || !headerFilters) return focusedListItems;
        return filterSessionListItemsForHeaderControls(focusedListItems, {
            ...headerFilters,
            sessionTags: sessionTagsV1 ?? {},
        });
    }, [focusedListItems, headerFilters, sessionTagsV1]);

    const folderBreadcrumbRootTitle = React.useMemo(() => {
        if (focusedFolderState.folderBreadcrumbs.length === 0 || !filteredListItems) return null;
        const projectHeader = filteredListItems.find((item): item is Extract<SessionListViewItem, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project'
        );
        return projectHeader?.title ?? null;
    }, [filteredListItems, focusedFolderState.folderBreadcrumbs.length]);

    const reachabilityModelsCacheRef = React.useRef(createSessionListReachabilityModelsCache());
    const reachabilityModels = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.reachabilityDisplayMap',
            filteredListItems,
            () => ({
                sessions: countSessionListItems(filteredListItems),
                displayRows: countSessionListItems(filteredListItems),
                machines: Object.keys(renderMachineDisplayById).length,
            }),
            () => buildSessionListReachabilityModels({
                cache: reachabilityModelsCacheRef.current,
                items: filteredListItems,
                machinesById: renderMachineDisplayById,
                workspaceLabelsV1,
            }),
        );
    }, [filteredListItems, renderMachineDisplayById, workspaceLabelsV1]);

    const selectedItemsRef = React.useRef<ReadonlyArray<SessionListSelectedItem> | null>(null);
    const visibleListItems = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.selectedMapping',
            filteredListItems,
            () => ({ selectable: selectable ? 1 : 0 }),
            () => buildSessionListSelectedItems({
                items: filteredListItems,
                pathname,
                selectable,
                previousItems: selectedItemsRef.current,
            }),
        );
    }, [filteredListItems, pathname, selectable]);
    selectedItemsRef.current = visibleListItems ?? null;

    const sessionListIndexRef = React.useRef<ReadonlyArray<SessionListIndexItem>>([]);
    const sessionListIndex = React.useMemo(() => {
        return buildSessionListIndexFromViewData(
            (visibleListItems ?? []) as ReadonlyArray<SessionListViewItem>,
            sessionListIndexRef.current,
        ) ?? [];
    }, [visibleListItems]);
    sessionListIndexRef.current = sessionListIndex;

    const folderMoveTargets = React.useMemo(
        () => folderViewEnabled ? buildSessionFolderMoveTargets(folderPresentedData ?? []) : [],
        [folderPresentedData, folderViewEnabled],
    );

    return {
        pinnedKeyList,
        pinnedKeySet,
        setPinnedSessionKeysV1,
        sessionMruOrderV1,
        setSessionMruOrderV1,
        sessionListGroupOrderV1,
        setSessionListGroupOrderV1,
        currentGroupOrderMap,
        sessionWorkspaceOrderV1,
        setSessionWorkspaceOrderV1,
        currentWorkspaceOrderMap,
        sessionFolderViewMode,
        setSessionFolderViewModeV1,
        sessionListOrderingMode,
        setSessionListOrderingModeV1,
        sessionListSavedFolderSortMode,
        sessionListFolderSortMode,
        setSessionListFolderSortModeV1,
        sessionFoldersV1,
        setSessionFoldersV1,
        sessionTagsV1,
        setSessionTagsV1,
        sessionTagsEnabled,
        hideInactiveSessions,
        setHideInactiveSessions,
        rememberLastProjectSessionSelections,
        workspaceLabelsV1,
        setWorkspaceLabelsV1,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
        collapsedGroupKeysV1,
        setCollapsedGroupKeysV1,
        compactSessionView,
        compactSessionViewMinimal,
        currentUserId,
        selection,
        showServerBadge,
        showPinnedServerBadge,
        selectable,
        folderActionsEnabled,
        folderViewEnabled,
        allKnownTags,
        folderPresentedData,
        collapsedListItems,
        selectionScopeListItems,
        focusedListItems: filteredListItems,
        visibleListItems,
        listItems: (visibleListItems ?? []) as Array<SessionListViewItem | (Extract<SessionListViewItem, { type: 'session' }> & { selected?: boolean })>,
        sessionListIndex,
        sessionListIndexRef,
        reachabilityModels,
        hasMultipleMachines: reachabilityModels.hasMultipleMachines,
        reachableSessionDisplayByKey: reachabilityModels.reachableSessionDisplayByKey,
        folderMoveTargets,
        folderBreadcrumbRootTitle,
        ...focusedFolderState,
    };
}
