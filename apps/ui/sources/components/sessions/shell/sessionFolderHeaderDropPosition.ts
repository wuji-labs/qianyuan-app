import type { SessionListViewItem } from '@/sync/domains/state/storage';
import {
    asSessionFolderHeaderItem,
    readSessionFolderId,
    readSessionFolderDepth,
} from './sessionFolderShellTypes';

export type SessionFolderHeaderDropPlacement = Readonly<{
    parentId: string | null;
    beforeFolderId?: string | null;
    afterFolderId?: string | null;
}>;

function resolveProjectGroupKey(groupKey: string | null | undefined): string {
    const value = String(groupKey ?? '').trim();
    const folderIndex = value.indexOf(':folder:');
    return folderIndex >= 0 ? value.slice(0, folderIndex) : value;
}

function isInSourceFolderSubtree(item: SessionListViewItem, sourceDepth: number): boolean {
    if (item.type === 'session') return readSessionFolderDepth(item) > sourceDepth;
    const folder = asSessionFolderHeaderItem(item);
    return Boolean(folder && folder.depth > sourceDepth);
}

function findSourceSubtreeEnd(items: ReadonlyArray<SessionListViewItem>, sourceIndex: number, sourceDepth: number): number {
    let cursor = sourceIndex + 1;
    while (cursor < items.length && isInSourceFolderSubtree(items[cursor]!, sourceDepth)) {
        cursor += 1;
    }
    return cursor;
}

function resolveItemProjectGroupKey(item: SessionListViewItem): string {
    return resolveProjectGroupKey(item.groupKey);
}

function resolvePlacementBeforeItem(
    item: SessionListViewItem | undefined,
    sourceProjectGroupKey: string,
): SessionFolderHeaderDropPlacement | null {
    if (!item || resolveItemProjectGroupKey(item) !== sourceProjectGroupKey) return null;
    if (item.type === 'session') return { parentId: readSessionFolderId(item) };
    const folder = asSessionFolderHeaderItem(item);
    if (folder) return { parentId: folder.parentFolderId ?? null, beforeFolderId: folder.folderId };
    return item.headerKind === 'project' ? { parentId: null } : null;
}

function resolvePlacementAfterItem(
    item: SessionListViewItem | undefined,
    sourceProjectGroupKey: string,
): SessionFolderHeaderDropPlacement | null {
    if (!item || resolveItemProjectGroupKey(item) !== sourceProjectGroupKey) return null;
    if (item.type === 'session') return { parentId: readSessionFolderId(item) };
    const folder = asSessionFolderHeaderItem(item);
    if (folder) return { parentId: folder.parentFolderId ?? null, afterFolderId: folder.folderId };
    return item.headerKind === 'project' ? { parentId: null } : null;
}

export function resolveSessionFolderHeaderDropPlacement(params: Readonly<{
    items: ReadonlyArray<SessionListViewItem>;
    folderId: string;
    positionDelta: number;
}>): SessionFolderHeaderDropPlacement | null {
    const sourceIndex = params.items.findIndex((item) => {
        if (item.type !== 'header') return false;
        return asSessionFolderHeaderItem(item)?.folderId === params.folderId;
    });
    const source = sourceIndex >= 0 ? asSessionFolderHeaderItem(params.items[sourceIndex] as Extract<SessionListViewItem, { type: 'header' }>) : null;
    if (!source || params.positionDelta === 0) return null;

    const sourceProjectGroupKey = resolveProjectGroupKey(source.groupKey);
    if (!sourceProjectGroupKey) return null;

    const subtreeEnd = findSourceSubtreeEnd(params.items, sourceIndex, source.depth);
    const rawLineIndex = params.positionDelta > 0
        ? sourceIndex + params.positionDelta + 1
        : sourceIndex + params.positionDelta;
    const lineIndex = Math.max(0, Math.min(params.items.length, rawLineIndex));
    if (lineIndex > sourceIndex && lineIndex <= subtreeEnd) return null;

    const removedCountBeforeLine = lineIndex > subtreeEnd ? subtreeEnd - sourceIndex : 0;
    const compactedItems = params.items.filter((_, index) => index < sourceIndex || index >= subtreeEnd);
    const insertionIndex = Math.max(0, Math.min(compactedItems.length, lineIndex - removedCountBeforeLine));

    const beforePlacement = resolvePlacementBeforeItem(compactedItems[insertionIndex], sourceProjectGroupKey);
    if (beforePlacement) return beforePlacement;
    return resolvePlacementAfterItem(compactedItems[insertionIndex - 1], sourceProjectGroupKey);
}
