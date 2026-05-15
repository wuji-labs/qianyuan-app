import React from 'react';
import {
    View,
    FlatList,
    Platform,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { usePathname, useRouter } from 'expo-router';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { SessionListViewItem, storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { layout } from '@/components/ui/layout/layout';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import {
    createSessionFolder,
    deleteSessionFolder,
    renameSessionFolder,
    resolveDurableWorkspaceRefForSessionListHeader,
} from '@/sync/domains/session/folders';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { moveSessionFolderAssignments } from '@/sync/ops/sessionFolders';
import { getTagsForSession } from './sessionTagUtils';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { FolderGroupHeader } from './sessionFolderHeader';
import {
    asSessionFolderHeaderItem,
    readSessionFolderDepth,
} from './sessionFolderShellTypes';
import { SessionFolderScopeBreadcrumb } from './sessionFolderScopeBreadcrumb';
import { DraggableSessionFolderHeaderFrame } from './DraggableSessionFolderHeaderFrame';
import { ProjectGroupHeader } from './ProjectGroupHeader';
import { SessionListHeaderFrame } from './SessionListHeaderFrame';
import { SessionListRow } from './row/SessionListRow';
import { treeRowId } from './drop-resolution/treeRowId';
import { SessionListViewMenuButton } from './sessionListViewMenu';
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    buildVisibleSessionNavigationEntries,
    moveSessionMruEntryToFront,
    resolveSessionMruNavigation,
    resolveVisibleSessionEdgeNavigation,
    resolveVisibleSessionNavigation,
    type VisibleSessionNavigationEntry,
} from '@/keyboard/sessions';
import { useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import { useSessionListViewState } from './view-state/useSessionListViewState';
import { useSessionListRowInteractions } from './view-state/useSessionListRowInteractions';
import { readSessionIdFromPathname } from './readSessionIdFromPathname';
import { useSessionListMoveSheet } from './move-sheet/useSessionListMoveSheet';
import type { SessionListMoveSheetTarget } from './move-sheet/buildSessionListMoveSheetTargets';
import { useSessionListA11yAnnouncements } from './accessibility/useSessionListA11yAnnouncements';

export { ProjectGroupHeader } from './ProjectGroupHeader';
export { CollapsibleSectionHeader } from './CollapsibleSectionHeader';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.background.canvas,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    footerContainer: {
        marginTop: -4,
    },
}));

type SessionListSessionItem = Extract<SessionListViewItem, { type: 'session' }> & { selected?: boolean };
const SESSION_FOLDER_MOVE_MENU_BASE_LEFT_PADDING = 16;
const SESSION_FOLDER_MOVE_MENU_INDENT_STEP = 12;
const EMPTY_SESSION_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_COLLAPSED_GROUP_KEYS: Readonly<Record<string, boolean>> = Object.freeze({});

function getSessionListItemType(item: SessionListViewItem): string {
    if (item.type === 'session') {
        return 'session';
    }
    const headerKind = typeof item.headerKind === 'string' && item.headerKind.length > 0
        ? item.headerKind
        : 'generic';
    return `header:${headerKind}`;
}

function resolveSessionFolderMoveMenuRowPaddingLeft(depth: number): number | undefined {
    const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 0;
    if (normalizedDepth <= 0) return undefined;
    return SESSION_FOLDER_MOVE_MENU_BASE_LEFT_PADDING + normalizedDepth * SESSION_FOLDER_MOVE_MENU_INDENT_STEP;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function findVisibleSessionNavigationEntryByScope(
    entries: readonly VisibleSessionNavigationEntry[],
    sessionId: string,
    serverId: string | null | undefined,
): VisibleSessionNavigationEntry | null {
    const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0
        ? serverId.trim()
        : null;
    if (normalizedServerId) {
        const scoped = entries.find((entry) =>
            entry.sessionId === sessionId && entry.serverId === normalizedServerId
        );
        if (scoped) return scoped;
    }
    return entries.find((entry) => entry.sessionId === sessionId) ?? null;
}

function resolveSessionTreeRowId(sessionKey: string | null): string | null {
    if (!sessionKey) return null;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return null;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return serverId && sessionId ? treeRowId.session(serverId, sessionId) : null;
}

const SessionsListHeader = React.memo(function SessionsListHeader(props: Readonly<{
    children?: React.ReactNode;
}>) {
    return (
        <View>
            <RecoveryKeyReminderBanner />
            <UpdateBanner />
            {props.children}
        </View>
    );
});

export function SessionsList(props: Readonly<{ storageKind?: SessionListStorageFilter }>) {
    const pathname = usePathname();
    const activeSessionId = React.useMemo(() => readSessionIdFromPathname(pathname), [pathname]);
    const data = useVisibleSessionListViewData(props.storageKind ?? 'all', { activeSessionId });
    return <SessionsListContent storageKind={props.storageKind} data={data} />;
}

export function SessionsListContent(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    data: SessionListViewItem[] | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const data = props.data;
    const pathname = usePathname();
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const focusReturnFallbackRef = useFocusReturnFallbackRef<React.ElementRef<typeof View> | null>();
    const { openMoveSheet } = useSessionListMoveSheet();
    const sessionListA11y = useSessionListA11yAnnouncements();

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
        // Stopping propagation here keeps the event within the sessions list subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const {
        focusedFolderId,
        folderBreadcrumbs,
        focusFolder: handleFocusSessionFolder,
        clearFolderFocus: handleClearSessionFolderFocus,
        focusBreadcrumbFolder: handleSelectSessionFolderBreadcrumb,
        folderBreadcrumbRootTitle,
        folderMoveTargets,
        listItems,
        sessionListIndexRef,
        pinnedKeyList,
        pinnedKeySet,
        setPinnedSessionKeysV1,
        sessionMruOrderV1,
        setSessionMruOrderV1,
        currentGroupOrderMap,
        setSessionListGroupOrderV1,
        sessionFolderViewMode,
        setSessionFolderViewModeV1,
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
        folderActionsEnabled,
        folderViewEnabled,
        allKnownTags,
        hasMultipleMachines,
        reachableSessionDisplayById,
    } = useSessionListViewState({
        data,
        pathname,
        storageKind: props.storageKind,
    });

    const {
        activeDropTargetId,
        activeDropVisual,
        applyKeyboardMove,
        applyMoveSheetTarget,
        draggingSessionKey,
        dropVisual,
        handleDragStart,
        handleFolderHeaderTreeDropResult,
        handleDragUpdate,
        handleTreeDropResult,
        handleTreeScroll,
        nativeContextMenuSessionKey,
        registerTreeRowBounds,
        resolveMoveSheetTargets,
        resolveTreeDropResult,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
    } = useSessionListRowInteractions({
        folderActionsEnabled,
        sessionFoldersV1,
        sessionListGroupOrderV1: currentGroupOrderMap,
        sessionListIndexRef,
        setSessionFoldersV1,
        setSessionListGroupOrderV1,
    });

    const handleRenameWorkspace = React.useCallback(async (workspaceKey: string, currentLabel: string) => {
        const newName = await Modal.prompt(
            t('sessionsList.renameWorkspacePromptTitle'),
            undefined,
            {
                defaultValue: currentLabel,
                placeholder: t('sessionsList.renameWorkspacePromptPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (newName !== null && newName.trim()) {
            setWorkspaceLabelsV1({ ...workspaceLabelsV1, [workspaceKey]: newName.trim() });
        }
    }, [workspaceLabelsV1, setWorkspaceLabelsV1]);

    const handleResetWorkspaceName = React.useCallback((workspaceKey: string) => {
        const next = { ...workspaceLabelsV1 };
        delete next[workspaceKey];
        setWorkspaceLabelsV1(next);
    }, [workspaceLabelsV1, setWorkspaceLabelsV1]);

    const handleCreateSessionFromProject = React.useCallback((item: Extract<SessionListViewItem, { type: 'header' }>) => {
        const workspaceScopeHint = item.workspaceScopeHint ?? null;
        if (!workspaceScopeHint) {
            return;
        }
        const seedSessionId = typeof item.seedSessionId === 'string' ? item.seedSessionId.trim() : '';
        const seedSession = seedSessionId
            ? ((storage.getState() as any)?.sessions?.[seedSessionId] as Session | undefined)
            : undefined;
        if (rememberLastProjectSessionSelections && seedSession) {
            const dataId = storeTempData(buildNewSessionTempDataFromSessionConfiguration({
                session: seedSession,
                machineId: workspaceScopeHint.machineId,
                directoryOverride: workspaceScopeHint.rootPath,
            }));
            router.push({
                pathname: '/new',
                params: {
                    dataId,
                    machineId: workspaceScopeHint.machineId,
                    directory: workspaceScopeHint.rootPath,
                    ...(workspaceScopeHint.serverId ? { spawnServerId: workspaceScopeHint.serverId } : {}),
                },
            } as any);
            return;
        }
        router.push({
            pathname: '/new',
            params: {
                machineId: workspaceScopeHint.machineId,
                directory: workspaceScopeHint.rootPath,
                ...(workspaceScopeHint.serverId ? { spawnServerId: workspaceScopeHint.serverId } : {}),
            },
        } as any);
    }, [rememberLastProjectSessionSelections, router]);

    const handleCreateSessionFromFolder = React.useCallback((folder: { workspace?: unknown }) => {
        const workspace = folder.workspace;
        if (!workspace || typeof workspace !== 'object' || (workspace as { t?: unknown }).t !== 'workspaceScope') {
            return;
        }
        const scope = workspace as { serverId?: string | null; machineId: string; rootPath: string };
        router.push({
            pathname: '/new',
            params: {
                machineId: scope.machineId,
                directory: scope.rootPath,
                ...(scope.serverId ? { spawnServerId: scope.serverId } : {}),
            },
        } as any);
    }, [router]);

    const handleAddFolderToProject = React.useCallback(async (item: Extract<SessionListViewItem, { type: 'header' }>) => {
        if (!folderActionsEnabled) return;
        const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
        if (!workspace) return;
        const name = await Modal.prompt(
            t('sessionsList.addFolderPromptTitle'),
            undefined,
            {
                placeholder: t('sessionsList.folderNamePlaceholder'),
                confirmText: t('common.add'),
                cancelText: t('common.cancel'),
            },
        );
        if (name === null) return;
        const created = createSessionFolder({
            current: sessionFoldersV1,
            workspace,
            renderWorkspaceKey: typeof item.workspaceKey === 'string' ? item.workspaceKey : undefined,
            parentId: null,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(created.next);
    }, [folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

    const handleAddSessionSubfolder = React.useCallback(async (folder: ReturnType<typeof asSessionFolderHeaderItem>) => {
        if (!folderActionsEnabled || !folder?.workspace) return;
        const name = await Modal.prompt(
            t('sessionsList.addSubfolderPromptTitle'),
            undefined,
            {
                placeholder: t('sessionsList.folderNamePlaceholder'),
                confirmText: t('common.add'),
                cancelText: t('common.cancel'),
            },
        );
        if (name === null) return;
        const created = createSessionFolder({
            current: sessionFoldersV1,
            workspace: folder.workspace,
            renderWorkspaceKey: folder.renderWorkspaceKey,
            parentId: folder.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(created.next);
    }, [folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

    const handleRenameSessionFolder = React.useCallback(async (folder: ReturnType<typeof asSessionFolderHeaderItem>) => {
        if (!folderActionsEnabled || !folder) return;
        const name = await Modal.prompt(
            t('sessionsList.renameFolderPromptTitle'),
            undefined,
            {
                defaultValue: folder.title,
                placeholder: t('sessionsList.folderNamePlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (name === null) return;
        const renamed = renameSessionFolder({
            current: sessionFoldersV1,
            folderId: folder.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(renamed.next);
    }, [folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

    const handleDeleteSessionFolder = React.useCallback(async (folder: ReturnType<typeof asSessionFolderHeaderItem>) => {
        if (!folderActionsEnabled || !folder) return;
        const confirmed = await Modal.confirm(
            t('sessionsList.deleteFolderPromptTitle'),
            t('sessionsList.deleteFolderPromptDescription'),
            {
                confirmText: t('common.delete'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        const deleted = deleteSessionFolder({
            current: sessionFoldersV1,
            folderId: folder.folderId,
        });
        if (deleted.deletedFolderIds.length === 0) return;
        const serverId = typeof folder.serverId === 'string' ? folder.serverId.trim() : '';
        const serverProfile = serverId ? getServerProfileById(serverId) : null;
        if (!serverProfile) return;
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) return;
        await moveSessionFolderAssignments({
            credentials,
            serverId: serverProfile.id,
            serverUrl: serverProfile.serverUrl,
            fromFolderIds: deleted.deletedFolderIds,
            toFolderId: deleted.replacementFolderId,
        });
        setSessionFoldersV1(deleted.next);
        if (focusedFolderId && deleted.deletedFolderIds.includes(focusedFolderId)) {
            handleClearSessionFolderFocus();
        }
    }, [focusedFolderId, folderActionsEnabled, handleClearSessionFolderFocus, sessionFoldersV1, setSessionFoldersV1]);

    const handleToggleCollapse = React.useCallback((collapseKey: string) => {
        const current = collapsedGroupKeysV1 ?? {};
        if (current[collapseKey]) {
            const next = { ...current };
            delete next[collapseKey];
            setCollapsedGroupKeysV1(next);
        } else {
            setCollapsedGroupKeysV1({ ...current, [collapseKey]: true });
        }
    }, [collapsedGroupKeysV1, setCollapsedGroupKeysV1]);

    const folderMoveMenuItems = React.useMemo((): DropdownMenuItem[] => {
        return folderMoveTargets.map((target) => {
            const paddingLeft = target.folderId == null
                ? undefined
                : resolveSessionFolderMoveMenuRowPaddingLeft(target.depth);
            return {
                id: `move-to-folder:${target.folderId ?? 'null'}`,
                title: target.folderId == null ? t('sessionsList.moveToWorkspaceRoot') : target.title,
                icon: <Ionicons name={target.folderId == null ? 'return-up-back-outline' : 'folder-outline'} size={16} color={theme.colors.text.secondary} />,
                rowContainerStyle: paddingLeft == null ? undefined : { paddingLeft },
                disabled: !folderActionsEnabled,
            };
        });
    }, [folderActionsEnabled, folderMoveTargets, theme.colors.text.secondary]);

    const rowLabelByTreeRowId = React.useMemo(() => {
        const labels = new Map<string, string>();
        for (const item of listItems) {
            if (item.type === 'session') {
                const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
                if (!serverId) continue;
                labels.set(treeRowId.session(serverId, item.session.id), item.session.id);
                continue;
            }
            if (item.headerKind === 'folder' && item.folderId) {
                labels.set(treeRowId.folder(item.folderId), item.title);
            } else if (item.headerKind === 'project' && item.groupKey) {
                labels.set(treeRowId.workspaceRoot(item.groupKey), item.title);
            }
        }
        return labels;
    }, [listItems]);

    const resolveDropDestinationLabel = React.useCallback((target: SessionListMoveSheetTarget) => {
        if (target.kind === 'root') return t('sessionsList.moveToWorkspaceRoot');
        return target.label;
    }, []);

    const applyMoveTargetWithAnnouncement = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        target: SessionListMoveSheetTarget,
    ) => {
        applyMoveSheetTarget(sourceRowId, target);
        sessionListA11y.announceDropResult({
            label: sourceLabel,
            destinationLabel: resolveDropDestinationLabel(target),
            result: target.result,
        });
    }, [applyMoveSheetTarget, resolveDropDestinationLabel, sessionListA11y]);

    const openMoveSheetForTreeRow = React.useCallback(async (sourceRowId: string, sourceLabel: string) => {
        const targets = resolveMoveSheetTargets(sourceRowId);
        if (targets.length === 0) return;
        const selectedTarget = await openMoveSheet({
            sourceLabel,
            targets,
        });
        if (!selectedTarget) return;
        applyMoveTargetWithAnnouncement(sourceRowId, sourceLabel, selectedTarget);
    }, [applyMoveTargetWithAnnouncement, openMoveSheet, resolveMoveSheetTargets]);

    const moveTreeRowToWorkspaceRoot = React.useCallback((sourceRowId: string, sourceLabel: string) => {
        const rootTarget = resolveMoveSheetTargets(sourceRowId).find((target) =>
            target.kind === 'root' && !target.disabled
        );
        if (!rootTarget) return;
        applyMoveTargetWithAnnouncement(sourceRowId, sourceLabel, rootTarget);
    }, [applyMoveTargetWithAnnouncement, resolveMoveSheetTargets]);

    const resolveDragLabel = React.useCallback((dragKey: string) => {
        const rowId = dragKey.startsWith('folder:')
            ? dragKey
            : resolveSessionTreeRowId(dragKey);
        return rowId ? rowLabelByTreeRowId.get(rowId) ?? dragKey : dragKey;
    }, [rowLabelByTreeRowId]);

    const resolveDropResultDestinationLabel = React.useCallback((
        result: Parameters<typeof sessionListA11y.announceDropResult>[0]['result'],
    ) => {
        const instruction = result.instruction;
        if (instruction.kind === 'move-to-root') return t('sessionsList.moveToWorkspaceRoot');
        if (instruction.kind === 'nest-into') return rowLabelByTreeRowId.get(instruction.targetId) ?? null;
        if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
            return rowLabelByTreeRowId.get(instruction.targetId) ?? null;
        }
        return null;
    }, [rowLabelByTreeRowId]);

    const moveTreeRowByKeyboard = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        direction: 'up' | 'down',
    ) => {
        const result = applyKeyboardMove(sourceRowId, direction);
        if (!result) return;
        sessionListA11y.announceDropResult({
            label: sourceLabel,
            destinationLabel: resolveDropResultDestinationLabel(result),
            result,
        });
    }, [applyKeyboardMove, resolveDropResultDestinationLabel, sessionListA11y]);

    const handleA11yDragStart = React.useCallback((dragKey: string) => {
        handleDragStart(dragKey);
        sessionListA11y.announcePickedUp({ label: resolveDragLabel(dragKey) });
    }, [handleDragStart, resolveDragLabel, sessionListA11y]);

    const handleA11yTreeDropResult = React.useCallback((event: Parameters<typeof handleTreeDropResult>[0]) => {
        handleTreeDropResult(event);
        sessionListA11y.announceDropResult({
            label: resolveDragLabel(event.sessionKey),
            destinationLabel: resolveDropResultDestinationLabel(event.result),
            result: event.result,
        });
    }, [handleTreeDropResult, resolveDragLabel, resolveDropResultDestinationLabel, sessionListA11y]);

    const handleA11yFolderHeaderTreeDropResult = React.useCallback((event: Parameters<typeof handleFolderHeaderTreeDropResult>[0]) => {
        handleFolderHeaderTreeDropResult(event);
        sessionListA11y.announceDropResult({
            label: resolveDragLabel(event.sessionKey),
            destinationLabel: resolveDropResultDestinationLabel(event.result),
            result: event.result,
        });
    }, [handleFolderHeaderTreeDropResult, resolveDragLabel, resolveDropResultDestinationLabel, sessionListA11y]);

    const handleSessionFolderMoveMenuItem = React.useCallback((
        item: Extract<SessionListViewItem, { type: 'session' }>,
        itemId: string,
    ) => {
        const prefix = 'move-to-folder:';
        if (!itemId.startsWith(prefix)) return;
        const folderId = itemId.slice(prefix.length);
        scheduleSessionFolderAssignment(item, folderId === 'null' ? null : folderId);
    }, [scheduleSessionFolderAssignment]);
    const visibleSessionNavigationEntries = React.useMemo(
        () => buildVisibleSessionNavigationEntries(listItems),
        [listItems],
    );
    const knownSessionKeys = React.useMemo(
        () => visibleSessionNavigationEntries.map((entry) => entry.sessionKey),
        [visibleSessionNavigationEntries],
    );
    const cursorSessionKeyRef = React.useRef<string | null>(null);
    const mruCursorSessionKeyRef = React.useRef<string | null>(null);
    const sessionListKeyboardFocusedRef = React.useRef(false);
    const activeSessionKey = React.useMemo(() => {
        const selectedEntries = listItems.filter((item): item is SessionListSessionItem =>
            item.type === 'session' && (item as SessionListSessionItem).selected === true
        );
        const selectedEntry = selectedEntries.find((item) => item.serverId === selection.activeServerId)
            ?? selectedEntries[0];
        if (selectedEntry?.type === 'session') {
            return findVisibleSessionNavigationEntryByScope(
                visibleSessionNavigationEntries,
                selectedEntry.session.id,
                selectedEntry.serverId,
            )?.sessionKey ?? null;
        }

        const activeSessionId = readSessionIdFromPathname(pathname);
        if (!activeSessionId) return null;
        return findVisibleSessionNavigationEntryByScope(
            visibleSessionNavigationEntries,
            activeSessionId,
            selection.activeServerId,
        )?.sessionKey ?? null;
    }, [listItems, pathname, selection.activeServerId, visibleSessionNavigationEntries]);
    React.useEffect(() => {
        if (!activeSessionKey) return;
        mruCursorSessionKeyRef.current = null;
        const currentOrder = Array.isArray(sessionMruOrderV1) ? sessionMruOrderV1 : EMPTY_SESSION_KEYS;
        const nextOrder = moveSessionMruEntryToFront({
            order: currentOrder,
            activeSessionKey,
            knownSessionKeys,
        });
        if (stringArraysEqual(currentOrder, nextOrder)) return;
        setSessionMruOrderV1(nextOrder);
    }, [activeSessionKey, knownSessionKeys, sessionMruOrderV1, setSessionMruOrderV1]);
    const navigateToSessionTarget = React.useCallback((target: VisibleSessionNavigationEntry | null) => {
        if (!target) return;
        void navigateToSession(target.sessionId, target.serverId ? { serverId: target.serverId } : undefined);
    }, [navigateToSession]);
    const handleVisibleSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const target = resolveVisibleSessionNavigation({
            visibleEntries: visibleSessionNavigationEntries,
            activeSessionKey,
            cursorSessionKey: cursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        cursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, navigateToSessionTarget, visibleSessionNavigationEntries]);
    const handleMruSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const currentOrder = Array.isArray(sessionMruOrderV1) ? sessionMruOrderV1 : EMPTY_SESSION_KEYS;
        const order = moveSessionMruEntryToFront({
            order: currentOrder,
            activeSessionKey,
            knownSessionKeys,
        });
        const target = resolveSessionMruNavigation({
            order,
            activeSessionKey,
            cursorSessionKey: mruCursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        mruCursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, knownSessionKeys, navigateToSessionTarget, sessionMruOrderV1]);
    useKeyboardShortcutHandlers(React.useMemo(() => ({
        'session.visible.previous': () => handleVisibleSessionShortcut('previous'),
        'session.visible.next': () => handleVisibleSessionShortcut('next'),
        'session.mru.previous': () => handleMruSessionShortcut('next'),
        'session.mru.next': () => handleMruSessionShortcut('previous'),
        'sessions.row.moveToFolder': () => {
            const rowId = resolveSessionTreeRowId(activeSessionKey);
            if (!rowId) return;
            void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
        },
        'sessions.row.moveToWorkspaceRoot': () => {
            const rowId = resolveSessionTreeRowId(activeSessionKey);
            if (!rowId) return;
            moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
        },
        'sessions.row.moveUp': () => {
            const rowId = resolveSessionTreeRowId(activeSessionKey);
            if (!rowId) return;
            moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'up');
        },
        'sessions.row.moveDown': () => {
            const rowId = resolveSessionTreeRowId(activeSessionKey);
            if (!rowId) return;
            moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'down');
        },
    }), [
        activeSessionKey,
        handleMruSessionShortcut,
        handleVisibleSessionShortcut,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        rowLabelByTreeRowId,
    ]));
    const handleSessionListKeyDown = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        if (!sessionListKeyboardFocusedRef.current) return;
        if (event?.altKey !== true) return;

        const key = String(event?.key ?? '');
        const target = key === 'ArrowDown'
            ? resolveVisibleSessionNavigation({
                visibleEntries: visibleSessionNavigationEntries,
                activeSessionKey,
                cursorSessionKey: cursorSessionKeyRef.current,
                direction: 'next',
            })
            : key === 'ArrowUp'
                ? resolveVisibleSessionNavigation({
                    visibleEntries: visibleSessionNavigationEntries,
                    activeSessionKey,
                    cursorSessionKey: cursorSessionKeyRef.current,
                    direction: 'previous',
                })
                : key === 'Home'
                    ? resolveVisibleSessionEdgeNavigation({
                        visibleEntries: visibleSessionNavigationEntries,
                        edge: 'first',
                    })
                    : key === 'End'
                        ? resolveVisibleSessionEdgeNavigation({
                            visibleEntries: visibleSessionNavigationEntries,
                            edge: 'last',
                        })
                        : null;
        if (!target) return;

        event?.preventDefault?.();
        event?.stopPropagation?.();
        cursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [
        activeSessionKey,
        navigateToSessionTarget,
        visibleSessionNavigationEntries,
    ]);

    const listItemKeyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        if (item.type === 'header') {
            const gk = String(item.groupKey ?? '').trim();
            const kind = String(item.headerKind ?? '').trim();
            const sid = String(item.serverId ?? '').trim();
            if (gk) return `header:${gk}`;
            if (kind === 'server' && (sid || item.title)) return `server:${sid || item.title}`;
            return `header:${kind}:${sid}:${item.title}:${index}`;
        }
        const sid = String(item.serverId ?? '').trim();
        const id = String(item.session?.id ?? '').trim();
        if (sid && id) return `session:${sid}:${id}`;
        return `session:${index}`;
    }, []);

    const collapsedKeys = collapsedGroupKeysV1 ?? EMPTY_COLLAPSED_GROUP_KEYS;
    const viewMenu = React.useMemo(() => (
        <SessionListViewMenuButton
            folderViewMode={sessionFolderViewMode}
            onFolderViewModeChange={setSessionFolderViewModeV1}
            hideInactiveSessions={hideInactiveSessions}
            onHideInactiveSessionsChange={setHideInactiveSessions}
            disabled={!folderActionsEnabled}
        />
    ), [
        folderActionsEnabled,
        hideInactiveSessions,
        sessionFolderViewMode,
        setHideInactiveSessions,
        setSessionFolderViewModeV1,
    ]);
    const renderHeaderItem = React.useCallback((item: Extract<SessionListViewItem, { type: 'header' }>, index: number) => {
        const headerTestId = item.headerKind === 'project'
            ? `session-list-project-header:${item.groupKey ?? item.title}`
            : `session-list-header:${item.groupKey ?? item.title}`;
        const folderHeader = folderViewEnabled ? asSessionFolderHeaderItem(item) : null;
        if (folderHeader) {
            const collapseKey = folderHeader.groupKey ?? `folder:${folderHeader.folderId}`;
            const treeRow = treeRowId.folder(folderHeader.folderId);
            const folderLabel = rowLabelByTreeRowId.get(treeRow) ?? folderHeader.title;
            return (
                <DraggableSessionFolderHeaderFrame
                    folderId={folderHeader.folderId}
                    groupKey={folderHeader.groupKey ?? collapseKey}
                    treeRowId={treeRow}
                    dataIndex={index}
                    dropVisual={dropVisual}
                    activeDropVisual={activeDropVisual}
                    onDragStart={handleA11yDragStart}
                    onDropResult={handleA11yFolderHeaderTreeDropResult}
                    onDragUpdate={handleDragUpdate}
                    resolveDropResult={resolveTreeDropResult}
                    onRegisterTreeRowBounds={registerTreeRowBounds}
                    onUnregisterTreeRowBounds={unregisterTreeRowBounds}
                >
                    <FolderGroupHeader
                        item={folderHeader}
                        collapsed={Boolean(collapsedKeys[collapseKey])}
                        onToggleCollapse={() => handleToggleCollapse(collapseKey)}
                        onFocus={() => handleFocusSessionFolder(folderHeader)}
                        onNewSession={() => handleCreateSessionFromFolder(folderHeader)}
                        onAddSubfolder={() => handleAddSessionSubfolder(folderHeader)}
                        onRename={() => handleRenameSessionFolder(folderHeader)}
                        onDelete={() => handleDeleteSessionFolder(folderHeader)}
                        onMove={() => {
                            void openMoveSheetForTreeRow(treeRow, folderLabel);
                        }}
                        onMoveToWorkspaceRoot={() => moveTreeRowToWorkspaceRoot(treeRow, folderLabel)}
                        onMoveUp={() => moveTreeRowByKeyboard(treeRow, folderLabel, 'up')}
                        onMoveDown={() => moveTreeRowByKeyboard(treeRow, folderLabel, 'down')}
                        activeDropTargetId={activeDropTargetId}
                        disabled={!folderActionsEnabled}
                    />
                </DraggableSessionFolderHeaderFrame>
            );
        }
        if (item.title && item.headerKind === 'project') {
            const collapseKey = item.groupKey ?? '';
            const treeRow = treeRowId.workspaceRoot(item.groupKey ?? item.title);
            return (
                <SessionListHeaderFrame
                    treeRowId={treeRow}
                    activeDropVisual={activeDropVisual}
                    onRegisterTreeRowBounds={registerTreeRowBounds}
                    onUnregisterTreeRowBounds={unregisterTreeRowBounds}
                >
                    <ProjectGroupHeader
                        item={item}
                        hasMultipleMachines={hasMultipleMachines}
                        workspaceLabelsV1={workspaceLabelsV1}
                        workspaceFaviconsEnabled={workspaceFaviconsEnabled}
                        workspaceMachineSubtitlesEnabled={workspaceMachineSubtitlesEnabled}
                        onRenameWorkspace={handleRenameWorkspace}
                        onResetWorkspaceName={handleResetWorkspaceName}
                        onCreateSession={() => handleCreateSessionFromProject(item)}
                        onAddFolder={() => handleAddFolderToProject(item)}
                        collapsed={Boolean(collapsedKeys[collapseKey])}
                        onToggleCollapse={() => handleToggleCollapse(collapseKey)}
                        headerTestId={headerTestId}
                    />
                </SessionListHeaderFrame>
            );
        }

        if (!item.title) return null;

        const collapseKey = item.groupKey || `${item.headerKind ?? ''}:${item.serverId ?? 'local'}`;
        const isCollapsed = Boolean(collapsedKeys[collapseKey]);
        const title =
            item.headerKind === 'server'
                ? t('sessionsList.serverHeader', { server: item.title })
                : item.title;

        return (
            <SessionListHeaderFrame
                treeRowId={`header:${collapseKey}`}
                activeDropVisual={activeDropVisual}
                onRegisterTreeRowBounds={registerTreeRowBounds}
                onUnregisterTreeRowBounds={unregisterTreeRowBounds}
            >
                <CollapsibleSectionHeader
                    title={title}
                    headerKind={item.headerKind}
                    collapsed={isCollapsed}
                    onPress={() => handleToggleCollapse(collapseKey)}
                    headerTestId={headerTestId}
                    rightElement={item.headerKind === 'active' || item.headerKind === 'inactive' ? viewMenu : null}
                />
            </SessionListHeaderFrame>
        );
    }, [
        collapsedKeys,
        activeDropVisual,
        folderActionsEnabled,
        folderViewEnabled,
        dropVisual,
        handleAddFolderToProject,
        handleAddSessionSubfolder,
        handleCreateSessionFromProject,
        handleCreateSessionFromFolder,
        handleDeleteSessionFolder,
        handleA11yDragStart,
        handleA11yFolderHeaderTreeDropResult,
        handleDragUpdate,
        handleFocusSessionFolder,
        handleRenameWorkspace,
        handleRenameSessionFolder,
        handleResetWorkspaceName,
        handleToggleCollapse,
        hasMultipleMachines,
        registerTreeRowBounds,
        resolveTreeDropResult,
        unregisterTreeRowBounds,
        viewMenu,
        workspaceLabelsV1,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
    ]);

    const renderSessionItem = React.useCallback((item: Extract<SessionListViewItem, { type: 'session' }>, index: number) => {
        const groupKeyForAdjacency = String(item.groupKey ?? '').trim();
        const prev = index > 0 ? listItems[index - 1] : null;
        const next = index < listItems.length - 1 ? listItems[index + 1] : null;
        const prevGroupKey = prev && prev.type === 'session' ? String(prev.groupKey ?? '').trim() : '';
        const nextGroupKey = next && next.type === 'session' ? String(next.groupKey ?? '').trim() : '';
        const isFirst = !groupKeyForAdjacency || prevGroupKey !== groupKeyForAdjacency;
        const isLast = !groupKeyForAdjacency || nextGroupKey !== groupKeyForAdjacency;
        const isSingle = isFirst && isLast;

        const sessionKey = typeof item.serverId === 'string' ? `${item.serverId}:${item.session.id}` : null;
        const sessionTreeRowId = typeof item.serverId === 'string' && item.serverId.trim()
            ? treeRowId.session(item.serverId, item.session.id)
            : `session:${item.session.id}`;
        const sessionMoveLabel = rowLabelByTreeRowId.get(sessionTreeRowId) ?? item.session.id;
        const pinned = item.pinned === true || (sessionKey ? pinnedKeySet.has(sessionKey) : false);
        const reachableDisplay = reachableSessionDisplayById.get(item.session.id);
        const workspaceSubtitle = reachableDisplay?.workspaceSubtitle ?? '';
        const machineLabel = reachableDisplay?.machineLabel ?? '';
        const computedSubtitle = hasMultipleMachines
            ? (machineLabel && workspaceSubtitle ? `${machineLabel} · ${workspaceSubtitle}` : machineLabel || workspaceSubtitle)
            : workspaceSubtitle;
        const isGroupedByPath = item.groupKind === 'project' && item.variant === 'no-path';
        const subtitle = isGroupedByPath ? null : computedSubtitle;
        const subtitleEllipsizeMode = reachableDisplay?.workspaceSubtitleEllipsizeMode ?? 'head';

        const rowTags = sessionKey ? getTagsForSession(sessionTagsV1, sessionKey) : [];
        const supportsPin = Boolean(sessionKey);
        const onTogglePinned = supportsPin
            ? () => {
                if (!sessionKey) return;
                if (pinnedKeySet.has(sessionKey)) {
                    setPinnedSessionKeysV1(pinnedKeyList.filter((k) => k !== sessionKey));
                } else {
                    setPinnedSessionKeysV1([...pinnedKeyList, sessionKey]);
                }
            }
            : null;
        const onSetTags = sessionKey
            ? (newTags: string[]) => {
                const nextTags = { ...sessionTagsV1 };
                if (newTags.length === 0) {
                    delete nextTags[sessionKey];
                } else {
                    nextTags[sessionKey] = newTags;
                }
                setSessionTagsV1(nextTags);
            }
            : null;

        const groupKey = String(item.groupKey ?? '').trim();
        const folderDepth = folderViewEnabled ? readSessionFolderDepth(item) : 0;
        const secondaryLineGroupKind = item.groupKind === 'folder' ? 'project' : item.groupKind;
        const isIos = Platform.OS === 'ios';
        const nativeContextMenuOpen = isIos && sessionKey != null && nativeContextMenuSessionKey === sessionKey;
        const handleNativeContextMenuOpenChange = (next: boolean) => {
            if (!isIos || !sessionKey) return;
            setNativeContextMenuSessionKey((prev) => {
                if (next) return sessionKey;
                return prev === sessionKey ? null : prev;
            });
        };

        return (
            <SessionListRow
                sessionKey={sessionKey}
                treeRowId={sessionTreeRowId}
                groupKey={groupKey}
                onDragStart={handleA11yDragStart}
                onDropResult={handleA11yTreeDropResult}
                onDragUpdate={handleDragUpdate}
                resolveDropResult={resolveTreeDropResult}
                onRegisterTreeRowBounds={registerTreeRowBounds}
                onUnregisterTreeRowBounds={unregisterTreeRowBounds}
                isDragActive={draggingSessionKey != null}
                isBeingDragged={sessionKey != null && sessionKey === draggingSessionKey}
                dataIndex={index}
                dropVisual={dropVisual}
                activeDropVisual={activeDropVisual}
                session={item.session}
                subtitleOverride={subtitle ?? null}
                subtitleEllipsizeMode={subtitleEllipsizeMode}
                serverId={item.serverId}
                serverName={item.serverName}
                currentUserId={currentUserId}
                showServerBadge={pinned ? showPinnedServerBadge : showServerBadge}
                pinned={pinned}
                onTogglePinned={onTogglePinned}
                tags={rowTags}
                allKnownTags={allKnownTags}
                onSetTags={onSetTags}
                tagsEnabled={sessionTagsEnabled === true}
                selected={(item as SessionListSessionItem).selected}
                isFirst={isFirst}
                isLast={isLast}
                isSingle={isSingle}
                variant={item.variant}
                folderDepth={folderDepth}
                folderMoveMenuItems={folderViewEnabled ? folderMoveMenuItems : []}
                onMoveToFolder={folderViewEnabled
                    ? () => { void openMoveSheetForTreeRow(sessionTreeRowId, sessionMoveLabel); }
                    : undefined}
                onMoveToWorkspaceRoot={folderViewEnabled
                    ? () => moveTreeRowToWorkspaceRoot(sessionTreeRowId, sessionMoveLabel)
                    : undefined}
                onMoveUp={folderViewEnabled
                    ? () => moveTreeRowByKeyboard(sessionTreeRowId, sessionMoveLabel, 'up')
                    : undefined}
                onMoveDown={folderViewEnabled
                    ? () => moveTreeRowByKeyboard(sessionTreeRowId, sessionMoveLabel, 'down')
                    : undefined}
                onSelectFolderMoveMenuItem={(itemId) => handleSessionFolderMoveMenuItem(item, itemId)}
                secondaryLineMode={resolveSessionListSecondaryLineMode({ groupKind: secondaryLineGroupKind })}
                compact={Boolean(compactSessionView)}
                compactMinimal={Boolean(compactSessionView && compactSessionViewMinimal)}
                {...(Platform.OS !== 'web' && sessionKey != null
                    ? {
                        nativeInlineDragEnabled: true,
                    }
                    : null)}
                {...(isIos && sessionKey != null
                    ? {
                        nativeContextMenuOpen,
                        onNativeContextMenuOpenChange: handleNativeContextMenuOpenChange,
                    }
                    : null)}
            />
        );
    }, [
        allKnownTags,
        compactSessionView,
        compactSessionViewMinimal,
        currentUserId,
        draggingSessionKey,
        nativeContextMenuSessionKey,
        activeDropVisual,
        dropVisual,
        folderMoveMenuItems,
        folderViewEnabled,
        handleA11yDragStart,
        handleA11yTreeDropResult,
        handleDragUpdate,
        handleTreeScroll,
        handleSessionFolderMoveMenuItem,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        hasMultipleMachines,
        listItems,
        pinnedKeyList,
        pinnedKeySet,
        reachableSessionDisplayById,
        sessionTagsEnabled,
        sessionTagsV1,
        setPinnedSessionKeysV1,
        setSessionTagsV1,
        setNativeContextMenuSessionKey,
        resolveTreeDropResult,
        registerTreeRowBounds,
        rowLabelByTreeRowId,
        showPinnedServerBadge,
        showServerBadge,
        unregisterTreeRowBounds,
    ]);

    const renderHeaderItemRef = React.useRef(renderHeaderItem);
    renderHeaderItemRef.current = renderHeaderItem;
    const renderSessionItemRef = React.useRef(renderSessionItem);
    renderSessionItemRef.current = renderSessionItem;
    // FlashList keeps rendered cells when data/renderItem stay stable. Use the
    // row renderer identity as the marker for state that changes row props.
    const virtualizedRowExtraData = renderSessionItem;

    const renderVirtualizedItem = React.useCallback(({ item, index }: { item: SessionListViewItem; index: number }) => {
        if (item.type === 'header') return renderHeaderItemRef.current(item, index);
        return renderSessionItemRef.current(item, index);
    }, []);

    const renderVirtualizedHeader = React.useCallback(() => (
        <SessionsListHeader>
            <SessionFolderScopeBreadcrumb
                breadcrumbs={folderBreadcrumbs}
                onClear={handleClearSessionFolderFocus}
                onSelectFolder={handleSelectSessionFolderBreadcrumb}
                rootTitle={folderBreadcrumbRootTitle}
            />
        </SessionsListHeader>
    ), [folderBreadcrumbRootTitle, folderBreadcrumbs, handleClearSessionFolderFocus, handleSelectSessionFolderBreadcrumb]);

    const renderVirtualizedFooter = React.useCallback(() => {
        return (
            <ItemGroup style={styles.footerContainer}>
                <Item
                    title={hideInactiveSessions
                        ? t('sessionInfo.inactiveAndArchivedSessions')
                        : t('sessionInfo.archivedSessions')}
                    icon={<Ionicons name="archive-outline" size={22} color={theme.colors.text.secondary} />}
                    onPress={() => router.push('/session/archived')}
                />
            </ItemGroup>
        );
    }, [hideInactiveSessions, router, styles.footerContainer, theme.colors.text.secondary]);

    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: safeArea.bottom + 128,
        maxWidth: layout.maxWidth,
    }), [safeArea.bottom]);

    const virtualizedListContent = Platform.OS === 'web' ? (
        <FlatList
            {...(Platform.OS === 'web'
                ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                : {})}
            data={listItems as any}
            renderItem={renderVirtualizedItem as any}
            extraData={virtualizedRowExtraData}
            keyExtractor={listItemKeyExtractor as any}
            contentContainerStyle={contentContainerStyle}
            onScroll={handleTreeScroll as (event: NativeSyntheticEvent<NativeScrollEvent>) => void}
            scrollEventThrottle={16}
            ListHeaderComponent={renderVirtualizedHeader as any}
            ListFooterComponent={renderVirtualizedFooter as any}
        />
    ) : (
        <FlashList
            data={listItems as any}
            renderItem={renderVirtualizedItem as any}
            extraData={virtualizedRowExtraData}
            keyExtractor={listItemKeyExtractor as any}
            getItemType={getSessionListItemType}
            contentContainerStyle={contentContainerStyle}
            onScroll={handleTreeScroll}
            scrollEventThrottle={16}
            ListHeaderComponent={renderVirtualizedHeader as any}
            ListFooterComponent={renderVirtualizedFooter as any}
        />
    );

    const keyboardZoneProps = Platform.OS === 'web'
        ? {
            testID: 'sessions-list-keyboard-zone',
            tabIndex: 0,
            onFocus: () => {
                sessionListKeyboardFocusedRef.current = true;
            },
            onBlur: () => {
                sessionListKeyboardFocusedRef.current = false;
                cursorSessionKeyRef.current = null;
            },
            onKeyDown: handleSessionListKeyDown,
        } as const
        : {};

    // Preserve the original empty loading surface without skipping hooks above.
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    return (
        <View ref={focusReturnFallbackRef} style={styles.container} {...keyboardZoneProps}>
            <View style={styles.contentContainer}>
                {virtualizedListContent}
            </View>
        </View>
    );
}
