import React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import { setSessionFolderAssignment } from '@/sync/ops/sessionFolders';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import {
    measureWindowBounds,
    type TreeDropResult,
    type TreeInstructionVisual,
    type WindowBounds,
} from '@/components/ui/treeDragDrop';

import {
    SESSION_INLINE_DRAG_VISUAL_KIND_NONE,
    type SessionInlineDragVisualKind,
    type SessionInlineDragVisualSharedValues,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolveDropResultEvent,
} from '../useSessionInlineDrag';
import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from '../SessionListHeaderFrame';
import { applySessionListTreeDropOperation } from '../commit/applySessionListTreeDropOperation';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { resolveSessionListInstruction } from '../drop-resolution/resolveSessionListInstruction';
import { treeRowId } from '../drop-resolution/treeRowId';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import {
    buildSessionListMoveSheetTargets,
    type SessionListMoveSheetTarget,
} from '../move-sheet/buildSessionListMoveSheetTargets';
import {
    buildSessionListKeyboardMoveResult,
    type SessionListKeyboardMoveDirection,
} from '../move-sheet/buildSessionListKeyboardMoveResult';

type SessionFolderAssignableSessionItem = Readonly<{
    type: 'session';
    session: { id?: string | null };
    serverId?: string;
}>;

const IDLE_TREE_DROP_RESULT: TreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' }),
    visual: Object.freeze({ kind: 'none' }),
});

function rebaseWindowBounds(bounds: WindowBounds, deltaY: number): WindowBounds {
    return {
        ...bounds,
        y: bounds.y - deltaY,
    };
}

function resolveSessionListSourceRowIdFromDragKey(sessionKey: string): string {
    if (sessionKey.startsWith('folder:')) return sessionKey;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return `session:${sessionKey}`;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return treeRowId.session(serverId, sessionId);
}

export type UseSessionListRowInteractionsInput = Readonly<{
    folderActionsEnabled: boolean;
    sessionFoldersV1: SessionFoldersV1;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    sessionListIndexRef: React.MutableRefObject<ReadonlyArray<SessionListIndexItem>>;
    setSessionFoldersV1: (value: SessionFoldersV1) => void;
    setSessionListGroupOrderV1: (value: Record<string, string[]>) => void;
}>;

export function useSessionListRowInteractions({
    folderActionsEnabled,
    sessionFoldersV1,
    sessionListGroupOrderV1,
    sessionListIndexRef,
    setSessionFoldersV1,
    setSessionListGroupOrderV1,
}: UseSessionListRowInteractionsInput) {
    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [activeDropTargetId, setActiveDropTargetId] = React.useState<string | null>(null);
    const activeDropTargetIdRef = React.useRef<string | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);
    const treeRowBoundsRef = React.useRef(new Map<string, WindowBounds>());
    const scrollOffsetYRef = React.useRef(0);

    const rawDropVisualKind = useSharedValue<SessionInlineDragVisualKind>(SESSION_INLINE_DRAG_VISUAL_KIND_NONE);
    const rawDropVisualTargetId = useSharedValue<string | null>(null);
    const rawDropVisualEdge = useSharedValue<'top' | 'bottom' | null>(null);
    const rawDropVisualDepth = useSharedValue(0);
    const dropVisual = React.useMemo<SessionInlineDragVisualSharedValues>(() => ({
        visualKind: rawDropVisualKind,
        visualTargetId: rawDropVisualTargetId,
        visualEdge: rawDropVisualEdge,
        visualDepth: rawDropVisualDepth,
    }), [
        rawDropVisualDepth,
        rawDropVisualEdge,
        rawDropVisualKind,
        rawDropVisualTargetId,
    ]);
    const [activeDropVisual, setActiveDropVisual] = React.useState<TreeInstructionVisual>(IDLE_TREE_DROP_RESULT.visual);

    const groupOrderRef = React.useRef(sessionListGroupOrderV1);
    groupOrderRef.current = sessionListGroupOrderV1;
    const sessionFoldersV1Ref = React.useRef(sessionFoldersV1);
    sessionFoldersV1Ref.current = sessionFoldersV1;
    const setSessionListGroupOrderV1Ref = React.useRef(setSessionListGroupOrderV1);
    setSessionListGroupOrderV1Ref.current = setSessionListGroupOrderV1;
    const setSessionFoldersV1Ref = React.useRef(setSessionFoldersV1);
    setSessionFoldersV1Ref.current = setSessionFoldersV1;

    const clearDragState = React.useCallback(() => {
        activeDropTargetIdRef.current = null;
        setActiveDropTargetId(null);
        setDraggingSessionKey(null);
        setActiveDropVisual(IDLE_TREE_DROP_RESULT.visual);
    }, []);

    const registerTreeRowBounds = React.useCallback<RegisterSessionListTreeRowBounds>((rowId, ref) => {
        void measureWindowBounds(ref).then((bounds) => {
            if (!bounds) return;
            treeRowBoundsRef.current.set(rowId, bounds);
        });
    }, []);

    const unregisterTreeRowBounds = React.useCallback<UnregisterSessionListTreeRowBounds>((rowId) => {
        treeRowBoundsRef.current.delete(rowId);
    }, []);

    const handleTreeScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nextOffsetY = event.nativeEvent.contentOffset?.y;
        if (typeof nextOffsetY !== 'number' || !Number.isFinite(nextOffsetY)) return;
        const deltaY = nextOffsetY - scrollOffsetYRef.current;
        scrollOffsetYRef.current = nextOffsetY;
        if (deltaY === 0) return;
        treeRowBoundsRef.current = new Map(Array.from(
            treeRowBoundsRef.current,
            ([rowId, bounds]) => [rowId, rebaseWindowBounds(bounds, deltaY)],
        ));
    }, []);

    const buildCurrentSessionListTree = React.useCallback(() => buildSessionListTreeRows({
        items: sessionListIndexRef.current,
        rowBoundsById: treeRowBoundsRef.current,
    }), [sessionListIndexRef]);

    const persistSessionFolderAssignmentByIds = React.useCallback(async (assignment: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => {
        if (!folderActionsEnabled) return;
        const serverProfile = getServerProfileById(assignment.serverId);
        if (!serverProfile) throw new Error('Missing server profile for session folder assignment');
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) throw new Error('Missing server credentials for session folder assignment');
        await setSessionFolderAssignment({
            credentials,
            serverId: serverProfile.id,
            serverUrl: serverProfile.serverUrl,
            sessionId: assignment.sessionId,
            folderId: assignment.folderId,
        });
    }, [folderActionsEnabled]);

    const persistSessionFolderAssignment = React.useCallback(async (
        item: SessionFolderAssignableSessionItem,
        folderId: string | null,
    ) => {
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
        if (!serverId || !sessionId) return;
        await persistSessionFolderAssignmentByIds({
            serverId,
            sessionId,
            folderId,
        });
    }, [persistSessionFolderAssignmentByIds]);

    const pendingFolderAssignmentRef = React.useRef<Readonly<{
        item: SessionFolderAssignableSessionItem;
        folderId: string | null;
    }> | null>(null);
    const [, runPendingFolderAssignment] = useHappyAction(async () => {
        const pending = pendingFolderAssignmentRef.current;
        pendingFolderAssignmentRef.current = null;
        if (!pending) return;
        await persistSessionFolderAssignment(pending.item, pending.folderId);
    }, { mode: 'drop' });

    const scheduleSessionFolderAssignment = React.useCallback((
        item: SessionFolderAssignableSessionItem,
        folderId: string | null,
    ) => {
        pendingFolderAssignmentRef.current = { item, folderId };
        runPendingFolderAssignment();
    }, [runPendingFolderAssignment]);

    const resolveTreeDropResult = React.useCallback((event: UseSessionInlineDragResolveDropResultEvent): TreeDropResult => {
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({
                tree,
                sourceRowId: resolveSessionListSourceRowIdFromDragKey(event.sessionKey),
            });
            return resolveSessionListInstruction({
                tree,
                source,
                pointer: event.pointer,
                foldersFeatureEnabled: folderActionsEnabled,
            });
        } catch {
            return IDLE_TREE_DROP_RESULT;
        }
    }, [buildCurrentSessionListTree, folderActionsEnabled]);

    const pendingTreeDropRef = React.useRef<Readonly<{
        tree: ReturnType<typeof buildSessionListTreeRows>;
        source: ReturnType<typeof buildSessionListDragSource>;
        result: TreeDropResult;
    }> | null>(null);
    const [, runPendingTreeDrop] = useHappyAction(async () => {
        const pending = pendingTreeDropRef.current;
        pendingTreeDropRef.current = null;
        if (!pending) return;
        await applySessionListTreeDropOperation({
            tree: pending.tree,
            source: pending.source,
            result: pending.result,
            context: {
                sessionFoldersV1: sessionFoldersV1Ref.current,
                sessionListGroupOrderV1: groupOrderRef.current,
                now: () => Date.now(),
                setSessionFoldersV1: setSessionFoldersV1Ref.current,
                setSessionListGroupOrderV1: setSessionListGroupOrderV1Ref.current,
                setSessionFolderAssignment: persistSessionFolderAssignmentByIds,
            },
        });
    }, { mode: 'drop' });

    const commitTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({
                tree,
                sourceRowId: resolveSessionListSourceRowIdFromDragKey(event.sessionKey),
            });
            pendingTreeDropRef.current = {
                tree,
                source,
                result: event.result,
            };
            runPendingTreeDrop();
        } finally {
            clearDragState();
        }
    }, [buildCurrentSessionListTree, clearDragState, runPendingTreeDrop]);

    const resolveMoveSheetTargets = React.useCallback((sourceRowId: string): readonly SessionListMoveSheetTarget[] => {
        if (!folderActionsEnabled) return [];
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            return buildSessionListMoveSheetTargets({ tree, source });
        } catch {
            return [];
        }
    }, [buildCurrentSessionListTree, folderActionsEnabled]);

    const applyMoveSheetTarget = React.useCallback((sourceRowId: string, target: SessionListMoveSheetTarget) => {
        if (target.disabled) return;
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            pendingTreeDropRef.current = {
                tree,
                source,
                result: target.result,
            };
            runPendingTreeDrop();
        } finally {
            clearDragState();
        }
    }, [buildCurrentSessionListTree, clearDragState, runPendingTreeDrop]);

    const applyKeyboardMove = React.useCallback((
        sourceRowId: string,
        direction: SessionListKeyboardMoveDirection,
    ): TreeDropResult | null => {
        if (!folderActionsEnabled) return null;
        try {
            const tree = buildCurrentSessionListTree();
            const source = buildSessionListDragSource({ tree, sourceRowId });
            const result = buildSessionListKeyboardMoveResult({ tree, source, direction });
            pendingTreeDropRef.current = {
                tree,
                source,
                result,
            };
            runPendingTreeDrop();
            return result;
        } catch {
            return null;
        } finally {
            clearDragState();
        }
    }, [buildCurrentSessionListTree, clearDragState, folderActionsEnabled, runPendingTreeDrop]);

    const handleTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        commitTreeDropResult(event);
    }, [commitTreeDropResult]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
        activeDropTargetIdRef.current = null;
        setActiveDropTargetId(null);
        setActiveDropVisual(IDLE_TREE_DROP_RESULT.visual);
    }, []);

    const handleDragUpdate = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        setActiveDropVisual(event.result.visual);
        const nextId = event.result.visual.kind === 'outline' ? event.result.visual.targetId : null;
        if (activeDropTargetIdRef.current === nextId) return;
        activeDropTargetIdRef.current = nextId;
        setActiveDropTargetId(nextId);
    }, []);

    const handleFolderHeaderTreeDropResult = React.useCallback((event: UseSessionInlineDragDropResultEvent) => {
        commitTreeDropResult(event);
    }, [commitTreeDropResult]);

    return {
        activeDropTargetId,
        activeDropVisual,
        applyKeyboardMove,
        applyMoveSheetTarget,
        draggingSessionKey,
        dropVisual,
        handleDragStart,
        handleDragUpdate,
        handleFolderHeaderTreeDropResult,
        handleTreeDropResult,
        handleTreeScroll,
        nativeContextMenuSessionKey,
        registerTreeRowBounds,
        resolveMoveSheetTargets,
        resolveTreeDropResult,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
    };
}
