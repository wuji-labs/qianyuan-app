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

export type SessionFolderDropOrderPlacement = Readonly<{
    groupKey: string;
    beforeKey?: string | null;
    afterKey?: string | null;
}>;

export type SessionFolderDragDropIntent =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'reorder'; groupKey: string; positionDelta: number }>
    | Readonly<{ kind: 'moveToFolder'; folderId: string; targetId?: string; workspace?: SessionFolderWorkspaceRefV1; order?: SessionFolderDropOrderPlacement }>
    | Readonly<{ kind: 'moveToWorkspaceRoot'; targetId?: string; workspace?: SessionFolderWorkspaceRefV1; order?: SessionFolderDropOrderPlacement }>;

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

export function resolveSessionFolderDropTargetAtPoint(
    targets: ReadonlyArray<SessionFolderDropTarget>,
    pointer: Readonly<{ x: number; y: number }> | null,
): SessionFolderDropTarget | null {
    if (!pointer) return null;
    const matches = targets.filter((target) =>
        pointer.x >= target.bounds.x
        && pointer.x <= target.bounds.x + target.bounds.width
        && pointer.y >= target.bounds.y + Math.min(8, target.bounds.height * 0.25)
        && pointer.y <= target.bounds.y + target.bounds.height - Math.min(8, target.bounds.height * 0.25)
    );
    matches.sort((a, b) => (a.bounds.width * a.bounds.height) - (b.bounds.width * b.bounds.height));
    return matches[0] ?? null;
}

export function resolveSessionFolderDragDropIntent(
    params: ResolveSessionFolderDragDropIntentParams,
): SessionFolderDragDropIntent {
    const target = resolveSessionFolderDropTargetAtPoint(params.dropTargets, params.pointer);
    if (target?.kind === 'workspaceRoot') {
        return target.workspace
            ? { kind: 'moveToWorkspaceRoot', targetId: target.id, workspace: target.workspace }
            : { kind: 'moveToWorkspaceRoot', targetId: target.id };
    }
    if (target?.folderId) {
        return target.workspace
            ? { kind: 'moveToFolder', folderId: target.folderId, targetId: target.id, workspace: target.workspace }
            : { kind: 'moveToFolder', folderId: target.folderId, targetId: target.id };
    }
    if (params.positionDelta !== 0) {
        return {
            kind: 'reorder',
            groupKey: params.groupKey,
            positionDelta: params.positionDelta,
        };
    }
    return {
        kind: 'reorder',
        groupKey: params.groupKey,
        positionDelta: params.positionDelta,
    };
}

export function resolveSessionFolderActiveDropTargetId(
    intent: SessionFolderDragDropIntent | null | undefined,
): string | null {
    if (!intent) return null;
    if (intent.kind === 'moveToFolder') return intent.targetId ?? `folder:${intent.folderId}`;
    if (intent.kind === 'moveToWorkspaceRoot') return intent.targetId ?? null;
    return null;
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
    const resolveTarget = React.useCallback((
        pointer: Readonly<{ x: number; y: number }> | null,
    ) => resolveSessionFolderDropTargetAtPoint(targetsRef.current, pointer), []);

    return React.useMemo(() => ({
        registerTarget,
        unregisterTarget,
        resolveIntent,
        resolveTarget,
    }), [registerTarget, resolveIntent, resolveTarget, unregisterTarget]);
}
