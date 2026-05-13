import * as React from 'react';

import type { SessionFolderWorkspaceRefV1 } from './sessionFolderShellTypes';

export type SessionFolderDropTarget = Readonly<{
    id: string;
    kind: 'folder' | 'workspaceRoot';
    folderId: string | null;
    workspace?: SessionFolderWorkspaceRefV1;
    bounds: Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}>;

export type SessionFolderDropTargetBounds = SessionFolderDropTarget['bounds'];

export type SessionFolderDropTargetMeasurableRef = Readonly<{
    measureInWindow?: (
        callback: (x: number, y: number, width: number, height: number) => void,
    ) => void;
}> | null;

export type SessionFolderDragDropIntent =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'reorder'; groupKey: string; positionDelta: number }>
    | Readonly<{ kind: 'moveToFolder'; folderId: string; workspace?: SessionFolderWorkspaceRefV1 }>
    | Readonly<{ kind: 'moveToWorkspaceRoot'; workspace?: SessionFolderWorkspaceRefV1 }>;

export type ResolveSessionFolderDragDropIntentParams = Readonly<{
    groupKey: string;
    positionDelta: number;
    pointer: Readonly<{ x: number; y: number }> | null;
    dropTargets: ReadonlyArray<SessionFolderDropTarget>;
}>;

export async function measureSessionFolderDropTargetBounds(params: Readonly<{
    ref: SessionFolderDropTargetMeasurableRef;
    fallback: SessionFolderDropTargetBounds;
}>): Promise<SessionFolderDropTargetBounds> {
    if (typeof params.ref?.measureInWindow !== 'function') {
        return params.fallback;
    }

    return new Promise((resolve) => {
        params.ref?.measureInWindow?.((x, y, width, height) => {
            resolve({ x, y, width, height });
        });
    });
}

function findDropTargetAtPoint(
    targets: ReadonlyArray<SessionFolderDropTarget>,
    pointer: Readonly<{ x: number; y: number }> | null,
): SessionFolderDropTarget | null {
    if (!pointer) return null;
    return targets.find((target) =>
        pointer.x >= target.bounds.x
        && pointer.x <= target.bounds.x + target.bounds.width
        && pointer.y >= target.bounds.y
        && pointer.y <= target.bounds.y + target.bounds.height
    ) ?? null;
}

export function resolveSessionFolderDragDropIntent(
    params: ResolveSessionFolderDragDropIntentParams,
): SessionFolderDragDropIntent {
    const target = findDropTargetAtPoint(params.dropTargets, params.pointer);
    if (!target) {
        return {
            kind: 'reorder',
            groupKey: params.groupKey,
            positionDelta: params.positionDelta,
        };
    }
    if (target.kind === 'workspaceRoot') {
        return { kind: 'moveToWorkspaceRoot', workspace: target.workspace };
    }
    if (target.folderId) {
        return { kind: 'moveToFolder', folderId: target.folderId, workspace: target.workspace };
    }
    return { kind: 'none' };
}

export function useSessionFolderDropTargetRegistry() {
    const targetsRef = React.useRef<SessionFolderDropTarget[]>([]);

    const registerTarget = React.useCallback((target: SessionFolderDropTarget) => {
        targetsRef.current = [
            ...targetsRef.current.filter((existing) => existing.id !== target.id),
            target,
        ];
    }, []);

    const unregisterTarget = React.useCallback((id: string) => {
        targetsRef.current = targetsRef.current.filter((target) => target.id !== id);
    }, []);

    const resolveIntent = React.useCallback((
        params: Omit<ResolveSessionFolderDragDropIntentParams, 'dropTargets'>,
    ) => resolveSessionFolderDragDropIntent({
        ...params,
        dropTargets: targetsRef.current,
    }), []);

    return React.useMemo(() => ({
        registerTarget,
        unregisterTarget,
        resolveIntent,
    }), [registerTarget, resolveIntent, unregisterTarget]);
}
