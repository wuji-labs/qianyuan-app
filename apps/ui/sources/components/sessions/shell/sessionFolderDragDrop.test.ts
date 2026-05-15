import { describe, expect, it } from 'vitest';

import { measureSessionFolderDropTargetBounds, resolveSessionFolderDropTargetAtPoint } from './sessionFolderDragDrop';

describe('session folder drag/drop target measurement', () => {
    it('uses absolute window bounds when the row ref can be measured', async () => {
        const measured = await measureSessionFolderDropTargetBounds({
            ref: {
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                    callback(40, 120, 260, 32);
                },
            },
            fallback: { x: 4, y: 8, width: 200, height: 24 },
        });

        expect(measured).toEqual({ x: 40, y: 120, width: 260, height: 32 });
    });

    it('falls back to local layout when native measurement is unavailable', async () => {
        const measured = await measureSessionFolderDropTargetBounds({
            ref: null,
            fallback: { x: 4, y: 8, width: 200, height: 24 },
        });

        expect(measured).toEqual({ x: 4, y: 8, width: 200, height: 24 });
    });

    it('resolves the innermost drop target under the pointer for visual feedback', () => {
        const target = resolveSessionFolderDropTargetAtPoint([
            {
                id: 'workspace',
                kind: 'workspaceRoot',
                folderId: null,
                bounds: { x: 0, y: 0, width: 320, height: 120 },
            },
            {
                id: 'folder-a',
                kind: 'folder',
                folderId: 'folder-a',
                bounds: { x: 24, y: 48, width: 272, height: 32 },
            },
        ], { x: 40, y: 60 });

        expect(target?.id).toBe('folder-a');
    });

    it('does not resolve row edge pointers as folder targets because row edges belong to reorder lines', () => {
        const target = resolveSessionFolderDropTargetAtPoint([
            {
                id: 'folder-a',
                kind: 'folder',
                folderId: 'folder-a',
                bounds: { x: 24, y: 48, width: 272, height: 32 },
            },
        ], { x: 40, y: 50 });

        expect(target).toBeNull();
    });

    it('resolves a centered folder target as a folder move even when the dragged row has moved between rows', async () => {
        const { resolveSessionFolderDragDropIntent } = await import('./sessionFolderDragDrop');

        const intent = resolveSessionFolderDragDropIntent({
            groupKey: 'project-a',
            positionDelta: 2,
            pointer: { x: 40, y: 60 },
            dropTargets: [{
                id: 'folder-a',
                kind: 'folder',
                folderId: 'folder-a',
                bounds: { x: 24, y: 48, width: 272, height: 32 },
            }],
        });

        expect(intent).toEqual({
            kind: 'moveToFolder',
            folderId: 'folder-a',
            targetId: 'folder-a',
        });
    });

    it('carries the concrete workspace target id for workspace-root visual feedback', async () => {
        const { resolveSessionFolderDragDropIntent } = await import('./sessionFolderDragDrop');

        const intent = resolveSessionFolderDragDropIntent({
            groupKey: 'project-a',
            positionDelta: 0,
            pointer: { x: 40, y: 20 },
            dropTargets: [{
                id: 'workspace-root:project-a',
                kind: 'workspaceRoot',
                folderId: null,
                bounds: { x: 16, y: 8, width: 280, height: 28 },
            }],
        });

        expect(intent).toEqual({
            kind: 'moveToWorkspaceRoot',
            targetId: 'workspace-root:project-a',
        });
    });

    it('derives visual target ids from the resolved operation', async () => {
        const { resolveSessionFolderActiveDropTargetId } = await import('./sessionFolderDragDrop');

        expect(resolveSessionFolderActiveDropTargetId({
            kind: 'moveToWorkspaceRoot',
            targetId: 'workspace-root:project-a',
        })).toBe('workspace-root:project-a');
        expect(resolveSessionFolderActiveDropTargetId({
            kind: 'moveToFolder',
            folderId: 'folder-a',
            targetId: 'folder:folder-a',
        })).toBe('folder:folder-a');
        expect(resolveSessionFolderActiveDropTargetId({
            kind: 'reorder',
            groupKey: 'project-a',
            positionDelta: 1,
        })).toBeNull();
    });
});
