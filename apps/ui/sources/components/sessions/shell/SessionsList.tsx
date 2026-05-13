import React from 'react';
import { View, FlatList, Pressable, Platform } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Text } from '@/components/ui/text/Text';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { usePathname, useRouter } from 'expo-router';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { SessionListViewItem, storage, useAllMachines, useLocalSettingMutable, useProfile, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/platform/responsive';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { layout } from '@/components/ui/layout/layout';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import {
    DEFAULT_SESSION_FOLDERS_V1,
    createSessionFolder,
    deleteSessionFolder,
    renameSessionFolder,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { moveSessionFolderAssignments, setSessionFolderAssignment } from '@/sync/ops/sessionFolders';
import { useSessionInlineDrag } from './useSessionInlineDrag';
import { getAllKnownTags, getTagsForSession } from './sessionTagUtils';
import { t } from '@/text';
import { SessionItem } from './SessionItem';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
} from './sessionListRowHeights';
import { countCollapsedSessionListGroups, filterCollapsedSessionListItems } from './sessionListCollapsedItems';
import { buildSessionListReachabilityModels } from './sessionListReachabilityModels';
import { buildSessionListSelectedItems, type SessionListSelectedItem } from './sessionListSelectedItems';
import { FolderGroupHeader } from './sessionFolderHeader';
import {
    buildSessionFolderBreadcrumbs,
    buildSessionFolderMoveTargets,
    filterSessionListItemsByFocusedFolder,
    asSessionFolderHeaderItem,
    readSessionFolderDepth,
    readSessionFolderId,
    type SessionFolderViewModeV1,
} from './sessionFolderShellTypes';
import {
    resolveSessionFolderDragDropIntent,
    measureSessionFolderDropTargetBounds,
    useSessionFolderDropTargetRegistry,
    type SessionFolderDragDropIntent,
    type SessionFolderDropTarget,
} from './sessionFolderDragDrop';
import { SessionFolderScopeBreadcrumb } from './sessionFolderScopeBreadcrumb';
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
    headerSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 14,
    },
    headerText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    groupHeaderSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    groupHeaderTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    groupHeaderPathTitleWeb: {
        writingDirection: 'rtl' as const,
        textAlign: 'left' as const,
    },
    groupHeaderPathTitleTextWeb: {
        writingDirection: 'ltr' as const,
        unicodeBidi: 'isolate' as const,
    },
    groupHeaderSubtitle: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        marginTop: 2,
        ...Typography.default(),
    },
    groupHeaderRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
    },
    groupHeaderTitleRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 6,
        flex: 1,
        minWidth: 0,
    },
    groupHeaderContent: {
        flex: 1,
        minWidth: 0,
    },
    groupHeaderInlineActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 2,
        flexShrink: 0,
    },
    groupHeaderTrailingActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        flexShrink: 0,
        marginLeft: 8,
    },
    groupHeaderActionButton: {
        width: 18,
        height: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 999,
        marginLeft: 4,
    },
    groupHeaderActionIcon: {
        color: theme.colors.text.secondary,
    },
    headerRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
    },
    headerLabelRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 4,
        flex: 1,
        minWidth: 0,
    },
    headerChevron: {
        width: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.text.secondary,
    },
    groupHeaderChevron: {
        width: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.text.secondary,
    },
    webHoverHiddenChevron: {
        opacity: 0,
    },
    webHoverVisibleChevron: {
        opacity: 1,
    },
    footerContainer: {
        marginTop: -4,
    },
    dropIndicator: {
        position: 'absolute' as const,
        left: 16,
        right: 16,
        height: 2,
        borderRadius: 1,
        backgroundColor: theme.colors.accent.blue,
        zIndex: 10,
    },
}));

type SessionListSessionItem = Extract<SessionListViewItem, { type: 'session' }> & { selected?: boolean };
type SessionFolderAssignableSessionItem = Readonly<{
    type: 'session';
    session: Extract<SessionListViewItem, { type: 'session' }>['session'];
    serverId?: string;
}>;

const ROW_HEIGHT_DEFAULT = SESSION_LIST_ROW_HEIGHT_DEFAULT;
const ROW_HEIGHT_COMPACT = SESSION_LIST_ROW_HEIGHT_COMPACT;
const ROW_HEIGHT_MINIMAL = SESSION_LIST_ROW_HEIGHT_MINIMAL;
const EMPTY_SESSION_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_COLLAPSED_GROUP_KEYS: Readonly<Record<string, boolean>> = Object.freeze({});
const EMPTY_SESSION_LIST_GROUP_ORDER: Readonly<Record<string, ReadonlyArray<string> | undefined>> = Object.freeze({});

const useSessionFolderViewModeMutable = useSettingMutable as unknown as (
    name: 'sessionFolderViewModeV1'
) => [SessionFolderViewModeV1 | null | undefined, (value: SessionFolderViewModeV1) => void];
const useSessionFoldersMutable = useSettingMutable as unknown as (
    name: 'sessionFoldersV1'
) => [SessionFoldersV1 | null | undefined, (value: SessionFoldersV1) => void];

function getSessionListItemType(item: SessionListViewItem): string {
    if (item.type === 'session') {
        return 'session';
    }
    const headerKind = typeof item.headerKind === 'string' && item.headerKind.length > 0
        ? item.headerKind
        : 'generic';
    return `header:${headerKind}`;
}

function countSessionListItems(items: ReadonlyArray<SessionListViewItem> | null | undefined): number {
    if (!items) return 0;
    return items.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0);
}

function resolveProjectGroupKeyForFolderAwareGroup(groupKey: string | null | undefined): string {
    const value = String(groupKey ?? '').trim();
    const folderMarker = ':folder:';
    const folderIndex = value.indexOf(folderMarker);
    return folderIndex >= 0 ? value.slice(0, folderIndex) : value;
}

function resolveFolderAssignmentIntentFromDropPosition(params: Readonly<{
    items: ReadonlyArray<SessionListViewItem>;
    sourceIndex: number;
    sourceGroupKey: string;
    positionDelta: number;
}>): Extract<SessionFolderDragDropIntent, { kind: 'moveToFolder' | 'moveToWorkspaceRoot' }> | null {
    const source = params.items[params.sourceIndex];
    if (!source || source.type !== 'session') return null;
    const sourceFolderId = readSessionFolderId(source);
    const sourceProjectGroupKey = resolveProjectGroupKeyForFolderAwareGroup(params.sourceGroupKey);
    if (!sourceProjectGroupKey) return null;

    const targetIndex = params.positionDelta > 0
        ? params.sourceIndex + params.positionDelta + 1
        : params.sourceIndex + params.positionDelta;
    const clampedTargetIndex = Math.max(0, Math.min(params.items.length - 1, targetIndex));
    const target = params.items[clampedTargetIndex];
    if (!target) return null;

    if (target.type === 'header') {
        if (target.headerKind === 'project' && target.groupKey === sourceProjectGroupKey && sourceFolderId !== null) {
            return { kind: 'moveToWorkspaceRoot' };
        }
        const targetFolder = asSessionFolderHeaderItem(target);
        if (targetFolder && targetFolder.folderId !== sourceFolderId) {
            return { kind: 'moveToFolder', folderId: targetFolder.folderId, workspace: targetFolder.workspace };
        }
        return null;
    }

    const targetProjectGroupKey = resolveProjectGroupKeyForFolderAwareGroup(target.groupKey);
    if (targetProjectGroupKey !== sourceProjectGroupKey) return null;

    const targetFolderId = readSessionFolderId(target);
    if (targetFolderId === sourceFolderId) return null;
    if (targetFolderId === null) return { kind: 'moveToWorkspaceRoot' };
    return { kind: 'moveToFolder', folderId: targetFolderId };
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function readSessionIdFromPathname(pathname: string): string | null {
    const match = pathname.match(/\/session\/([^/?#]+)/);
    const sessionIdCandidate = match?.[1]?.trim() ?? '';
    if (!sessionIdCandidate) return null;
    try {
        const decoded = decodeURIComponent(sessionIdCandidate).trim();
        return decoded || null;
    } catch {
        return sessionIdCandidate || null;
    }
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

type SessionListRowProps = Readonly<
    React.ComponentProps<typeof SessionItem> & {
        sessionKey: string | null;
        groupKey: string;
        rowHeight: number;
        onDragStart: (sessionKey: string) => void;
        onDragEnd: (sessionKey: string, groupKey: string, positionDelta: number) => void;
        onDragUpdate?: (event: Readonly<{ sessionKey: string; absoluteX: number; absoluteY: number }>) => void;
        resolveDropIntent?: (event: Readonly<{
            sessionKey: string;
            groupKey: string;
            positionDelta: number;
            dataIndex: number;
            absoluteX: number | null;
            absoluteY: number | null;
        }>) => SessionFolderDragDropIntent | null;
        onDropIntent?: (event: Readonly<{
            sessionKey: string;
            groupKey: string;
            positionDelta: number;
            intent: unknown;
        }>) => void;
        isDragActive: boolean;
        isBeingDragged: boolean;
        dataIndex: number;
        totalItemCount: number;
        dropIndicatorIdx: SharedValue<number>;
        dropIndicatorEdge: SharedValue<number>;
    }
>;

const SessionListRow = React.memo(function SessionListRow(props: SessionListRowProps) {
    const { sessionKey, groupKey, rowHeight, onDragStart, onDragEnd, onDragUpdate, resolveDropIntent, onDropIntent, isDragActive, isBeingDragged, dataIndex, totalItemCount, dropIndicatorIdx, dropIndicatorEdge, ...itemProps } = props;

    const styles = stylesheet;
    const wrapperRef = React.useRef<View>(null);
    const contextMenuPendingRef = React.useRef(false);

    // On web, FlatList wraps each item in a CellRenderer div with
    // `position: relative; z-index: 0`. This creates a stacking context that
    // traps any z-index we set on our inner Animated.View. We need to elevate
    // the *cell wrapper itself* so the dragged row paints on top of siblings.
    // We also set overflow: visible on the cell wrapper so the row isn't clipped
    // while translating outside its cell bounds.
    const getCellWrapper = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        const el = wrapperRef.current as any;
        if (!el || typeof el !== 'object' || !('parentElement' in el)) return null;
        return el.parentElement as HTMLElement | null;
    }, []);

    const handleDragStart = React.useCallback((sk: string) => {
        contextMenuPendingRef.current = false;
        if (typeof itemProps.onNativeContextMenuOpenChange === 'function') {
            itemProps.onNativeContextMenuOpenChange(false);
        }
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        }
        onDragStart(sk);
    }, [getCellWrapper, itemProps.onNativeContextMenuOpenChange, onDragStart]);

    const handleDragEnd = React.useCallback((sk: string, gk: string, delta: number) => {
        contextMenuPendingRef.current = false;
        const cellWrapper = getCellWrapper();
        if (cellWrapper) {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
        onDragEnd(sk, gk, delta);
    }, [getCellWrapper, onDragEnd]);

    const isWeb = Platform.OS === 'web';
    const isAndroid = Platform.OS === 'android';
    const onNativeContextMenuOpenChange = itemProps.onNativeContextMenuOpenChange;
    const handleLongPressActivated = React.useCallback(() => {
        if (isWeb || typeof onNativeContextMenuOpenChange !== 'function' || isDragActive) return;

        // Defer one frame so a immediately-started drag can cancel this before the menu renders.
        contextMenuPendingRef.current = true;
        const openIfStillPending = () => {
            if (!contextMenuPendingRef.current) return;
            onNativeContextMenuOpenChange(true);
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(openIfStillPending);
        } else {
            setTimeout(openIfStillPending, 0);
        }
    }, [isDragActive, isWeb, onNativeContextMenuOpenChange]);

    const { gesture, animatedStyle } = useSessionInlineDrag({
        enabled: !isAndroid,
        sessionKey, groupKey, rowHeight,
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        onDragUpdate,
        resolveDropIntent,
        onDropIntent,
        dataIndex,
        totalItemCount,
        dropIndicatorIdx,
        dropIndicatorEdge,
        activateAfterLongPressMs: isWeb ? undefined : 350,
        onLongPressActivated: !isWeb && !isAndroid && typeof onNativeContextMenuOpenChange === 'function'
            ? () => handleLongPressActivated()
            : undefined,
    });

    // Fallback: also sync cell wrapper styles via useEffect in case the JS
    // callback timing misses a frame, or onDragEnd doesn't fire (gesture cancel).
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const cellWrapper = getCellWrapper();
        if (!cellWrapper) return;
        if (isBeingDragged) {
            cellWrapper.style.zIndex = '9999';
            cellWrapper.style.overflow = 'visible';
        } else {
            cellWrapper.style.zIndex = '';
            cellWrapper.style.overflow = '';
        }
    }, [isBeingDragged, getCellWrapper]);

    // Disable pointer-events on non-dragging rows during a drag so the pointer
    // can't accidentally hit them (safety net alongside z-index elevation).
    const rowPointerEvents = Platform.OS === 'web' && isDragActive && !isBeingDragged
        ? 'none' as const
        : 'auto' as const;

    // Drop indicator: a 2px accent-blue line at the top or bottom edge of this
    // row when it's the current drop target. Always mounted (no layout change);
    // invisible when inactive.
    const indicatorAnimatedStyle = useAnimatedStyle(() => {
        const isTarget = dropIndicatorIdx.value === dataIndex;
        const atBottom = dropIndicatorEdge.value === 1;
        return {
            opacity: isTarget ? 1 : 0,
            top: atBottom ? undefined : 0,
            bottom: atBottom ? 0 : undefined,
        };
    });

    const sessionItem = (
        <SessionItem
            {...itemProps}
            reorderHandleGesture={Platform.OS === 'ios' ? undefined : gesture}
            isBeingDragged={isBeingDragged}
        />
    );

    return (
        <Animated.View ref={wrapperRef} style={animatedStyle} pointerEvents={rowPointerEvents}>
            <Animated.View style={[styles.dropIndicator, indicatorAnimatedStyle]} pointerEvents="none" />
            {Platform.OS === 'ios' && gesture ? (
                <GestureDetector gesture={gesture}>
                    {sessionItem}
                </GestureDetector>
            ) : sessionItem}
        </Animated.View>
    );
});

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    workspaceLabelsV1: Record<string, string>;
    onRenameWorkspace: (workspaceKey: string, currentLabel: string) => void;
    onResetWorkspaceName: (workspaceKey: string) => void;
    onCreateSession: () => void;
    onAddFolder: () => void | Promise<void>;
    collapsed: boolean;
    onToggleCollapse: () => void;
    headerTestId: string;
    onRegisterWorkspaceRootDropTarget?: (target: SessionFolderDropTarget) => void;
    onUnregisterWorkspaceRootDropTarget?: (id: string) => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const {
        item,
        hasMultipleMachines,
        workspaceLabelsV1,
        onRenameWorkspace,
        onResetWorkspaceName,
        onCreateSession,
        onAddFolder,
        collapsed,
        onToggleCollapse,
        headerTestId,
        onRegisterWorkspaceRootDropTarget,
        onUnregisterWorkspaceRootDropTarget,
    } = props;
    const [isRowHovered, setIsRowHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showHoverActions = !isWeb || isRowHovered || isActionsHovered || menuOpen;
    const showChevron = !isWeb || collapsed || showHoverActions;
    const workspaceKey = item.workspaceKey ?? '';
    const customLabel = workspaceKey ? workspaceLabelsV1[workspaceKey] : undefined;
    const displayTitle = customLabel || item.title;
    const hasCustomLabel = Boolean(customLabel);
    const shouldUseStartEllipsis = !hasCustomLabel && isWeb;
    const nativeEllipsizeMode = !isWeb && !hasCustomLabel ? 'head' : 'tail';
    const actionIconColor = theme.colors.text.secondary;
    const canCreateSession = typeof onCreateSession === 'function' && Boolean(item.workspaceScopeHint);
    const rowRef = React.useRef<View | null>(null);
    const dropTargetId = `workspace-root:${item.groupKey ?? item.workspaceKey ?? item.title}`;

    React.useEffect(() => {
        return () => {
            onUnregisterWorkspaceRootDropTarget?.(dropTargetId);
        };
    }, [dropTargetId, onUnregisterWorkspaceRootDropTarget]);

    const menuItems = React.useMemo((): DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [
            {
                id: 'add-folder',
                title: t('sessionsList.addFolder'),
                icon: <Ionicons name="folder-open-outline" size={16} color={actionIconColor} />,
                disabled: !canCreateSession,
            },
            {
                id: 'rename',
                title: t('sessionsList.renameWorkspace'),
                icon: <Ionicons name="pencil-outline" size={16} color={actionIconColor} />,
            },
        ];
        if (hasCustomLabel) {
            items.push({
                id: 'reset',
                title: t('sessionsList.resetWorkspaceName'),
                icon: <Ionicons name="refresh-outline" size={16} color={actionIconColor} />,
            });
        }
        return items;
    }, [hasCustomLabel, actionIconColor]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'add-folder') {
            await onAddFolder();
        } else if (itemId === 'rename') {
            onRenameWorkspace(workspaceKey, displayTitle);
        } else if (itemId === 'reset') {
            onResetWorkspaceName(workspaceKey);
        }
    }, [workspaceKey, displayTitle, onAddFolder, onRenameWorkspace, onResetWorkspaceName]);

    const chevronColor = theme.colors.text.secondary;
    return (
        <View style={styles.groupHeaderSection}>
            <Pressable
                ref={rowRef as React.Ref<View>}
                style={styles.groupHeaderRow}
                onPress={onToggleCollapse}
                testID={headerTestId}
                onLayout={(event) => {
                    const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
                    if (!workspace) return;
                    const layout = event.nativeEvent.layout;
                    void measureSessionFolderDropTargetBounds({
                        ref: rowRef.current,
                        fallback: {
                            x: layout.x,
                            y: layout.y,
                            width: layout.width,
                            height: layout.height,
                        },
                    }).then((bounds) => onRegisterWorkspaceRootDropTarget?.({
                        id: dropTargetId,
                        kind: 'workspaceRoot',
                        folderId: null,
                        workspace,
                        bounds,
                    }));
                }}
                onHoverIn={isWeb ? () => setIsRowHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsRowHovered(false) : undefined}
            >
                <View style={styles.groupHeaderContent}>
                    <View style={styles.groupHeaderTitleRow}>
                        <Text
                            style={shouldUseStartEllipsis
                                ? [styles.groupHeaderTitle, styles.groupHeaderPathTitleWeb]
                                : styles.groupHeaderTitle}
                            numberOfLines={1}
                            ellipsizeMode={shouldUseStartEllipsis ? undefined : nativeEllipsizeMode}
                        >
                            {shouldUseStartEllipsis ? (
                                <Text style={styles.groupHeaderPathTitleTextWeb}>
                                    {displayTitle}
                                </Text>
                            ) : displayTitle}
                        </Text>
                        <View
                            style={styles.groupHeaderInlineActions}
                            onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                            onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                        >
                            <View
                                style={[
                                    styles.groupHeaderChevron,
                                    isWeb && !showChevron ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                                ]}
                            >
                                <Ionicons
                                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                                    size={12}
                                    color={chevronColor}
                                />
                            </View>
                            {showHoverActions && workspaceKey ? (
                                <DropdownMenu
                                    open={menuOpen}
                                    onOpenChange={setMenuOpen}
                                    items={menuItems}
                                    onSelect={handleMenuSelect}
                                    placement="left"
                                    variant="slim"
                                    matchTriggerWidth={false}
                                    maxWidthCap={220}
                                    showCategoryTitles={false}
                                    popoverPortalWebTarget="body"
                                    trigger={({ toggle }) => (
                                        <Pressable
                                            style={styles.groupHeaderActionButton}
                                            onPress={(event) => {
                                                (event as any)?.stopPropagation?.();
                                                toggle();
                                            }}
                                            onHoverIn={isWeb ? () => setIsActionsHovered(true) : undefined}
                                            onHoverOut={isWeb ? () => setIsActionsHovered(false) : undefined}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('common.moreActions')}
                                            hitSlop={8}
                                        >
                                            <Octicons name="kebab-horizontal" size={12} color={actionIconColor} />
                                        </Pressable>
                                    )}
                                />
                            ) : null}
                        </View>
                    </View>
                    {hasMultipleMachines && item.subtitle ? (
                        <Text style={styles.groupHeaderSubtitle}>{item.subtitle}</Text>
                    ) : null}
                </View>
                <View style={styles.groupHeaderTrailingActions}>
                    {canCreateSession ? (
                        <Pressable
                            style={styles.groupHeaderActionButton}
                            onPress={(event) => {
                                (event as any)?.stopPropagation?.();
                                onCreateSession();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('machine.launchNewSessionInDirectory')}
                            hitSlop={8}
                        >
                            <Ionicons name="add" size={14} color={actionIconColor} />
                        </Pressable>
                    ) : null}
                </View>
            </Pressable>
        </View>
    );
});

export const CollapsibleSectionHeader = React.memo(function CollapsibleSectionHeader(props: Readonly<{
    title: string;
    headerKind?: Extract<SessionListViewItem, { type: 'header' }>['headerKind'];
    collapsed: boolean;
    onPress: () => void;
    headerTestId: string;
    rightElement?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const headerChevronColor = theme.colors.text.secondary;
    const isPrimaryHeader = props.headerKind === 'active' || props.headerKind === 'inactive';
    const showChevron = !isWeb || props.collapsed || isHovered;
    return (
        <Pressable
            style={isPrimaryHeader ? styles.headerSection : styles.groupHeaderSection}
            onPress={props.onPress}
            testID={props.headerTestId}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
        >
            <View style={styles.headerRow}>
                <View style={styles.headerLabelRow}>
                    <Eyebrow style={isPrimaryHeader ? styles.headerText : styles.groupHeaderTitle}>{props.title}</Eyebrow>
                    <View
                        style={[
                            styles.headerChevron,
                            isWeb && !showChevron ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                        ]}
                    >
                        <Ionicons
                            name={props.collapsed ? 'chevron-forward' : 'chevron-down'}
                            size={12}
                            color={headerChevronColor}
                        />
                    </View>
                </View>
                {props.rightElement ? (
                    <View style={styles.groupHeaderTrailingActions}>
                        {props.rightElement}
                    </View>
                ) : null}
            </View>
        </Pressable>
    );
});

export function SessionsList(props: Readonly<{ storageKind?: SessionListStorageFilter }>) {
    const data = useVisibleSessionListViewData(props.storageKind ?? 'all');
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
    const isTablet = useIsTablet();
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionMruOrderV1, setSessionMruOrderV1] = useLocalSettingMutable('sessionMruOrderV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const [sessionFolderViewModeRaw, setSessionFolderViewModeV1] = useSessionFolderViewModeMutable('sessionFolderViewModeV1');
    const [sessionFoldersV1Raw, setSessionFoldersV1] = useSessionFoldersMutable('sessionFoldersV1');
    const [sessionTagsV1, setSessionTagsV1] = useSettingMutable('sessionTagsV1');
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const [hideInactiveSessionsSetting, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const hideInactiveSessions = hideInactiveSessionsSetting === true;
    const rememberLastProjectSessionSelections = useSetting('rememberLastProjectSessionSelections') !== false;
    const [workspaceLabelsV1, setWorkspaceLabelsV1] = useSettingMutable('workspaceLabelsV1');
    const [collapsedGroupKeysV1, setCollapsedGroupKeysV1] = useSettingMutable('collapsedGroupKeysV1');
    const sessionListDensity = useSetting('sessionListDensity');
    const profile = useProfile();
    const compactSessionView = sessionListDensity === 'cozy' || sessionListDensity === 'narrow';
    const compactSessionViewMinimal = sessionListDensity === 'narrow';
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const selection = useResolvedActiveServerSelection();
    const selectedServerCount = selection.allowedServerIds?.length ?? 0;
    const showServerBadge = selection.enabled && selection.presentation === 'flat-with-badge' && selectedServerCount > 1;
    const showPinnedServerBadge = selection.enabled && selectedServerCount > 1;
    const selectable = isTablet;
    const sessionFoldersDecision = useFeatureDecision('sessions.folders');
    const folderActionsEnabled = props.storageKind !== 'direct' && sessionFoldersDecision?.state === 'enabled';
    const sessionFolderViewMode: SessionFolderViewModeV1 = sessionFolderViewModeRaw === 'tree' ? 'tree' : 'off';
    const folderViewEnabled = folderActionsEnabled && sessionFolderViewMode === 'tree';
    const [focusedFolderId, setFocusedFolderId] = React.useState<string | null>(null);
    const dropTargetRegistry = useSessionFolderDropTargetRegistry();
    const sessionFoldersV1 = sessionFoldersV1Raw ?? DEFAULT_SESSION_FOLDERS_V1;

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
        // Stopping propagation here keeps the event within the sessions list subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const pinnedKeySet = React.useMemo(() => {
        return new Set(Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : []);
    }, [pinnedSessionKeysV1]);
    const allMachines = useAllMachines();
    const machinesById = React.useMemo(() => {
        const next: Record<string, (typeof allMachines)[number]> = {};
        for (const machine of allMachines) {
            next[machine.id] = machine;
        }
        return next;
    }, [allMachines]);

    const pinnedKeyList = Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : EMPTY_SESSION_KEYS;
    const currentGroupOrderMap = sessionListGroupOrderV1 ?? EMPTY_SESSION_LIST_GROUP_ORDER;

    const allKnownTags = React.useMemo(() => getAllKnownTags(sessionTagsV1), [sessionTagsV1]);

    const collapsedListItems = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.collapsedFiltering',
            data,
            () => ({ collapsedGroups: countCollapsedSessionListGroups(collapsedGroupKeysV1) }),
            () => data ? filterCollapsedSessionListItems(data, collapsedGroupKeysV1) : data,
        );
    }, [data, collapsedGroupKeysV1]);

    const focusedListItems = React.useMemo(() => {
        if (!folderViewEnabled || !focusedFolderId || !collapsedListItems) return collapsedListItems;
        return filterSessionListItemsByFocusedFolder(collapsedListItems, focusedFolderId);
    }, [collapsedListItems, focusedFolderId, folderViewEnabled]);

    const folderBreadcrumbs = React.useMemo(() => {
        if (!folderViewEnabled || !focusedFolderId || !data) return [];
        return buildSessionFolderBreadcrumbs(data, focusedFolderId);
    }, [data, focusedFolderId, folderViewEnabled]);

    React.useEffect(() => {
        if (!focusedFolderId) return;
        if (!folderViewEnabled || folderBreadcrumbs.length === 0) {
            setFocusedFolderId(null);
        }
    }, [focusedFolderId, folderBreadcrumbs.length, folderViewEnabled]);

    const reachabilityModels = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.reachabilityDisplayMap',
            focusedListItems,
            () => ({
                sessions: countSessionListItems(focusedListItems),
                displayRows: countSessionListItems(focusedListItems),
                machines: allMachines.length,
            }),
            () => buildSessionListReachabilityModels({
                items: focusedListItems,
                machinesById,
                workspaceLabelsV1,
            }),
        );
    }, [allMachines.length, focusedListItems, machinesById, workspaceLabelsV1]);

    const selectedItemsRef = React.useRef<ReadonlyArray<SessionListSelectedItem> | null>(null);
    const visibleListItems = React.useMemo(() => {
        return measureSessionListRenderDerivation(
            'ui.sessionsList.render.selectedMapping',
            focusedListItems,
            () => ({ selectable: selectable ? 1 : 0 }),
            () => buildSessionListSelectedItems({
                items: focusedListItems,
                pathname,
                selectable,
                previousItems: selectedItemsRef.current,
            }),
        );
    }, [focusedListItems, pathname, selectable]);
    selectedItemsRef.current = visibleListItems ?? null;
    const reachableSessionDisplayById = reachabilityModels.reachableSessionDisplayById;
    const hasMultipleMachines = reachabilityModels.hasMultipleMachines;

    const rowHeight = compactSessionViewMinimal
        ? ROW_HEIGHT_MINIMAL
        : compactSessionView
            ? ROW_HEIGHT_COMPACT
            : ROW_HEIGHT_DEFAULT;

    // Use refs so handleDragEnd is stable and never causes gesture recreation
    // when the store updates during a drag.
    const dataRef = React.useRef(visibleListItems);
    dataRef.current = visibleListItems;
    const groupOrderRef = React.useRef(currentGroupOrderMap);
    groupOrderRef.current = currentGroupOrderMap;

    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);

    // Drop indicator shared values — written by the dragging row's onUpdate
    // worklet, read by every row's useAnimatedStyle on the UI thread.
    const rawDropIndicatorIdx = useSharedValue(-1);
    const rawDropIndicatorEdge = useSharedValue(0);
    const dropIndicatorIdxRef = React.useRef(rawDropIndicatorIdx);
    const dropIndicatorEdgeRef = React.useRef(rawDropIndicatorEdge);
    const dropIndicatorIdx = dropIndicatorIdxRef.current;
    const dropIndicatorEdge = dropIndicatorEdgeRef.current;
    const setSessionListGroupOrderV1Ref = React.useRef(setSessionListGroupOrderV1);
    setSessionListGroupOrderV1Ref.current = setSessionListGroupOrderV1;

    // Called once when the gesture ends. Commits the reorder AND resets drag
    // state in one shot. No data mutation happens mid-gesture — this is
    // critical because React's keyed reconciliation would unmount/remount the
    // dragged item's DOM node, releasing pointer capture and killing the
    // Pan gesture.
    const handleDragEnd = React.useCallback((sessionKey: string, groupKey: string, positionDelta: number) => {
        if (positionDelta !== 0) {
            const items = (dataRef.current ?? []) as Array<SessionListViewItem>;
            const groupSessions = items.filter(
                (item): item is Extract<SessionListViewItem, { type: 'session' }> =>
                    item.type === 'session' && String(item.groupKey ?? '').trim() === groupKey,
            );
            const currentMap = groupOrderRef.current;
            const existingOrder = currentMap[groupKey];
            const orderedKeys = existingOrder
                ? existingOrder
                : groupSessions.map((s) => (typeof s.serverId === 'string' ? `${s.serverId}:${s.session.id}` : s.session.id));
            const idx = orderedKeys.indexOf(sessionKey);
            if (idx >= 0) {
                const targetIdx = Math.max(0, Math.min(orderedKeys.length - 1, idx + positionDelta));
                if (targetIdx !== idx) {
                    const newOrder = [...orderedKeys];
                    // Remove from old position and insert at target
                    newOrder.splice(idx, 1);
                    newOrder.splice(targetIdx, 0, sessionKey);
                    const capped = newOrder.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);
                    setSessionListGroupOrderV1Ref.current({ ...currentMap, [groupKey]: capped });
                }
            }
        }
        setDraggingSessionKey(null);
    }, []);

    const persistSessionFolderAssignment = React.useCallback(async (
        item: SessionFolderAssignableSessionItem,
        folderId: string | null,
    ) => {
        if (!folderActionsEnabled) return;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) return;
        const serverProfile = getServerProfileById(serverId);
        if (!serverProfile) return;
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) return;
        await setSessionFolderAssignment({
            credentials,
            serverId: serverProfile.id,
            serverUrl: serverProfile.serverUrl,
            sessionId,
            folderId,
        });
    }, [folderActionsEnabled]);

    const persistSessionFolderAssignmentFromKey = React.useCallback((
        sessionKey: string,
        folderId: string | null,
    ) => {
        const item = (dataRef.current ?? []).find((candidate): candidate is Extract<SessionListSelectedItem, { type: 'session' }> => {
            if (candidate.type !== 'session') return false;
            const candidateServerId = typeof candidate.serverId === 'string' ? candidate.serverId.trim() : '';
            return Boolean(candidateServerId) && `${candidateServerId}:${candidate.session.id}` === sessionKey;
        });
        if (!item) return;
        void persistSessionFolderAssignment(item, folderId).catch(() => undefined);
    }, [persistSessionFolderAssignment]);

    const resolveDropIntent = React.useCallback((event: Readonly<{
        sessionKey: string;
        groupKey: string;
        positionDelta: number;
        dataIndex: number;
        absoluteX: number | null;
        absoluteY: number | null;
    }>): SessionFolderDragDropIntent | null => {
        const intent = dropTargetRegistry.resolveIntent({
            groupKey: event.groupKey,
            positionDelta: event.positionDelta,
            pointer: event.absoluteX == null || event.absoluteY == null
                ? null
                : { x: event.absoluteX, y: event.absoluteY },
        });
        if (intent.kind !== 'reorder') return intent;
        return resolveFolderAssignmentIntentFromDropPosition({
            items: visibleListItems ?? [],
            sourceIndex: event.dataIndex,
            sourceGroupKey: event.groupKey,
            positionDelta: event.positionDelta,
        });
    }, [dropTargetRegistry, visibleListItems]);

    const handleDropIntent = React.useCallback((event: Readonly<{
        sessionKey: string;
        groupKey: string;
        positionDelta: number;
        intent: SessionFolderDragDropIntent;
    }>) => {
        if (event.intent.kind === 'reorder') {
            handleDragEnd(event.sessionKey, event.intent.groupKey, event.intent.positionDelta);
            return;
        }
        if (event.intent.kind === 'moveToFolder') {
            persistSessionFolderAssignmentFromKey(event.sessionKey, event.intent.folderId);
        } else if (event.intent.kind === 'moveToWorkspaceRoot') {
            persistSessionFolderAssignmentFromKey(event.sessionKey, null);
        }
        setDraggingSessionKey(null);
    }, [handleDragEnd, persistSessionFolderAssignmentFromKey]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
    }, []);

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
            setFocusedFolderId(deleted.replacementFolderId);
        }
    }, [focusedFolderId, folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

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

    const listItems = (visibleListItems ?? []) as Array<SessionListViewItem | (SessionListSessionItem & { selected?: boolean })>;
    const folderMoveTargets = React.useMemo(
        () => folderViewEnabled ? buildSessionFolderMoveTargets(listItems) : [],
        [folderViewEnabled, listItems],
    );
    const folderMoveMenuItems = React.useMemo((): DropdownMenuItem[] => {
        return folderMoveTargets.map((target) => ({
            id: `move-to-folder:${target.folderId ?? 'null'}`,
            title: target.folderId == null ? t('sessionsList.moveToWorkspaceRoot') : target.title,
            icon: <Ionicons name={target.folderId == null ? 'return-up-back-outline' : 'folder-outline'} size={16} color={theme.colors.text.secondary} />,
            disabled: !folderActionsEnabled,
        }));
    }, [folderActionsEnabled, folderMoveTargets, theme.colors.text.secondary]);
    const handleSessionFolderMoveMenuItem = React.useCallback((
        item: SessionFolderAssignableSessionItem,
        itemId: string,
    ) => {
        const prefix = 'move-to-folder:';
        if (!itemId.startsWith(prefix)) return;
        const folderId = itemId.slice(prefix.length);
        void persistSessionFolderAssignment(item, folderId === 'null' ? null : folderId).catch(() => undefined);
    }, [persistSessionFolderAssignment]);
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
    }), [handleMruSessionShortcut, handleVisibleSessionShortcut]));
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
    const renderHeaderItem = React.useCallback((item: Extract<SessionListViewItem, { type: 'header' }>) => {
        const headerTestId = item.headerKind === 'project'
            ? `session-list-project-header:${item.groupKey ?? item.title}`
            : `session-list-header:${item.groupKey ?? item.title}`;
        const folderHeader = folderViewEnabled ? asSessionFolderHeaderItem(item) : null;
        if (folderHeader) {
            const collapseKey = folderHeader.groupKey ?? `folder:${folderHeader.folderId}`;
            return (
                <FolderGroupHeader
                    item={folderHeader}
                    collapsed={Boolean(collapsedKeys[collapseKey])}
                    onToggleCollapse={() => handleToggleCollapse(collapseKey)}
                    onFocus={() => setFocusedFolderId(folderHeader.folderId)}
                    onNewSession={() => handleCreateSessionFromFolder(folderHeader)}
                    onAddSubfolder={() => handleAddSessionSubfolder(folderHeader)}
                    onRename={() => handleRenameSessionFolder(folderHeader)}
                    onDelete={() => handleDeleteSessionFolder(folderHeader)}
                    onRegisterDropTarget={dropTargetRegistry.registerTarget}
                    onUnregisterDropTarget={dropTargetRegistry.unregisterTarget}
                    disabled={!folderActionsEnabled}
                />
            );
        }
        if (item.title && item.headerKind === 'project') {
            const collapseKey = item.groupKey ?? '';
            return (
                <ProjectGroupHeader
                    item={item}
                    hasMultipleMachines={hasMultipleMachines}
                    workspaceLabelsV1={workspaceLabelsV1}
                    onRenameWorkspace={handleRenameWorkspace}
                    onResetWorkspaceName={handleResetWorkspaceName}
                    onCreateSession={() => handleCreateSessionFromProject(item)}
                    onAddFolder={() => handleAddFolderToProject(item)}
                    collapsed={Boolean(collapsedKeys[collapseKey])}
                    onToggleCollapse={() => handleToggleCollapse(collapseKey)}
                    headerTestId={headerTestId}
                    onRegisterWorkspaceRootDropTarget={dropTargetRegistry.registerTarget}
                    onUnregisterWorkspaceRootDropTarget={dropTargetRegistry.unregisterTarget}
                />
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
            <CollapsibleSectionHeader
                title={title}
                headerKind={item.headerKind}
                collapsed={isCollapsed}
                onPress={() => handleToggleCollapse(collapseKey)}
                headerTestId={headerTestId}
                rightElement={item.headerKind === 'active' || item.headerKind === 'inactive' ? viewMenu : null}
            />
        );
    }, [
        collapsedKeys,
        folderActionsEnabled,
        folderViewEnabled,
        dropTargetRegistry.registerTarget,
        dropTargetRegistry.unregisterTarget,
        handleAddFolderToProject,
        handleAddSessionSubfolder,
        handleCreateSessionFromProject,
        handleCreateSessionFromFolder,
        handleDeleteSessionFolder,
        handleRenameWorkspace,
        handleRenameSessionFolder,
        handleResetWorkspaceName,
        handleToggleCollapse,
        hasMultipleMachines,
        viewMenu,
        workspaceLabelsV1,
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
        const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
        const nativeContextMenuOpen = isNative && sessionKey != null && nativeContextMenuSessionKey === sessionKey;
        const handleNativeContextMenuOpenChange = (next: boolean) => {
            if (!isNative || !sessionKey) return;
            setNativeContextMenuSessionKey((prev) => {
                if (next) return sessionKey;
                return prev === sessionKey ? null : prev;
            });
        };

        return (
            <SessionListRow
                sessionKey={sessionKey}
                groupKey={groupKey}
                rowHeight={rowHeight}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                resolveDropIntent={resolveDropIntent}
                onDropIntent={(event) => handleDropIntent({
                    ...event,
                    intent: event.intent as SessionFolderDragDropIntent,
                })}
                isDragActive={draggingSessionKey != null}
                isBeingDragged={sessionKey != null && sessionKey === draggingSessionKey}
                dataIndex={index}
                totalItemCount={listItems.length}
                dropIndicatorIdx={dropIndicatorIdx}
                dropIndicatorEdge={dropIndicatorEdge}
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
                onSelectFolderMoveMenuItem={(itemId) => handleSessionFolderMoveMenuItem(item, itemId)}
                secondaryLineMode={resolveSessionListSecondaryLineMode({ groupKind: secondaryLineGroupKind })}
                compact={Boolean(compactSessionView)}
                compactMinimal={Boolean(compactSessionView && compactSessionViewMinimal)}
                {...(isNative && sessionKey != null
                    ? {
                        nativeInlineDragEnabled: Platform.OS === 'ios',
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
        dropIndicatorEdge,
        dropIndicatorIdx,
        folderMoveMenuItems,
        folderViewEnabled,
        handleDragEnd,
        handleDragStart,
        handleDropIntent,
        handleSessionFolderMoveMenuItem,
        hasMultipleMachines,
        listItems,
        pinnedKeyList,
        pinnedKeySet,
        rowHeight,
        reachableSessionDisplayById,
        sessionTagsEnabled,
        sessionTagsV1,
        setPinnedSessionKeysV1,
        setSessionTagsV1,
        setNativeContextMenuSessionKey,
        resolveDropIntent,
        showPinnedServerBadge,
        showServerBadge,
    ]);

    const renderHeaderItemRef = React.useRef(renderHeaderItem);
    renderHeaderItemRef.current = renderHeaderItem;
    const renderSessionItemRef = React.useRef(renderSessionItem);
    renderSessionItemRef.current = renderSessionItem;

    const renderVirtualizedItem = React.useCallback(({ item, index }: { item: SessionListViewItem; index: number }) => {
        if (item.type === 'header') return renderHeaderItemRef.current(item);
        return renderSessionItemRef.current(item, index);
    }, []);

    const renderVirtualizedHeader = React.useCallback(() => (
        <SessionsListHeader>
            <SessionFolderScopeBreadcrumb
                breadcrumbs={folderBreadcrumbs}
                onClear={() => setFocusedFolderId(null)}
            />
        </SessionsListHeader>
    ), [folderBreadcrumbs]);

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
            keyExtractor={listItemKeyExtractor as any}
            contentContainerStyle={contentContainerStyle}
            ListHeaderComponent={renderVirtualizedHeader as any}
            ListFooterComponent={renderVirtualizedFooter as any}
        />
    ) : (
        <FlashList
            data={listItems as any}
            renderItem={renderVirtualizedItem as any}
            keyExtractor={listItemKeyExtractor as any}
            getItemType={getSessionListItemType}
            contentContainerStyle={contentContainerStyle}
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
