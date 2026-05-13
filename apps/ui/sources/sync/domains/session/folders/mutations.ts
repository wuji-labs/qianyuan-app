import { randomUUID } from '@/platform/randomUUID';

import { makeSiblingUniqueSessionFolderName, normalizeSessionFolderName } from './names';
import { normalizeSessionFolders } from './normalize';
import type { SessionFolderV1, SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';
import { buildSessionFolderWorkspaceRefKey } from './workspaceRefs';

export type CreateSessionFolderResult = Readonly<{
    next: SessionFoldersV1;
    folder: SessionFolderV1;
}>;

export function createSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    workspace: SessionFolderWorkspaceRefV1;
    renderWorkspaceKey?: string;
    parentId: string | null;
    name: string;
    now: number;
    id?: string;
}>): CreateSessionFolderResult {
    const workspaceKey = buildSessionFolderWorkspaceRefKey(params.workspace);
    const siblingNames = new Set(
        params.current.folders
            .filter((folder) => (
                buildSessionFolderWorkspaceRefKey(folder.workspace) === workspaceKey
                && folder.parentId === params.parentId
            ))
            .map((folder) => folder.name.toLocaleLowerCase()),
    );
    const name = makeSiblingUniqueSessionFolderName(
        normalizeSessionFolderName(params.name) ?? 'Folder',
        siblingNames,
    );
    const folder: SessionFolderV1 = {
        id: params.id ?? randomUUID(),
        workspace: params.workspace,
        ...(params.renderWorkspaceKey ? { renderWorkspaceKey: params.renderWorkspaceKey } : {}),
        parentId: params.parentId,
        name,
        createdAt: params.now,
        updatedAt: params.now,
    };
    const next = normalizeSessionFolders({ v: 1, folders: [...params.current.folders, folder] });
    const normalizedFolder = next.folders.find((candidate) => candidate.id === folder.id) ?? folder;
    return { next, folder: normalizedFolder };
}

export function deleteSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    folderId: string;
}>): Readonly<{
    next: SessionFoldersV1;
    deletedFolderIds: readonly string[];
    replacementFolderId: string | null;
}> {
    const byId = new Map(params.current.folders.map((folder) => [folder.id, folder] as const));
    const target = byId.get(params.folderId);
    if (!target) {
        return { next: params.current, deletedFolderIds: [], replacementFolderId: null };
    }

    const deleted = new Set<string>();
    const collect = (folderId: string) => {
        deleted.add(folderId);
        for (const folder of params.current.folders) {
            if (folder.parentId === folderId && !deleted.has(folder.id)) collect(folder.id);
        }
    };
    collect(target.id);

    return {
        next: normalizeSessionFolders({
            v: 1,
            folders: params.current.folders.filter((folder) => !deleted.has(folder.id)),
        }),
        deletedFolderIds: Array.from(deleted),
        replacementFolderId: target.parentId,
    };
}

export function renameSessionFolder(params: Readonly<{
    current: SessionFoldersV1;
    folderId: string;
    name: string;
    now: number;
}>): Readonly<{
    next: SessionFoldersV1;
    folder: SessionFolderV1 | null;
}> {
    const target = params.current.folders.find((folder) => folder.id === params.folderId);
    if (!target) {
        return { next: params.current, folder: null };
    }

    const workspaceKey = buildSessionFolderWorkspaceRefKey(target.workspace);
    const siblingNames = new Set(
        params.current.folders
            .filter((folder) => (
                folder.id !== target.id
                && buildSessionFolderWorkspaceRefKey(folder.workspace) === workspaceKey
                && folder.parentId === target.parentId
            ))
            .map((folder) => folder.name.toLocaleLowerCase()),
    );
    const name = makeSiblingUniqueSessionFolderName(
        normalizeSessionFolderName(params.name) ?? target.name,
        siblingNames,
    );
    const next = normalizeSessionFolders({
        v: 1,
        folders: params.current.folders.map((folder) => folder.id === target.id
            ? { ...folder, name, updatedAt: params.now }
            : folder),
    });
    return {
        next,
        folder: next.folders.find((folder) => folder.id === target.id) ?? null,
    };
}
