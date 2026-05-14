import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { resolveSessionFolderHeaderDropPlacement } from './sessionFolderHeaderDropPosition';

function project(groupKey = 'server:s:active:project:p'): Extract<SessionListViewItem, { type: 'header' }> {
    return {
        type: 'header',
        title: 'Project',
        headerKind: 'project',
        groupKey,
    };
}

function folder(id: string, parentFolderId: string | null, depth: number): Extract<SessionListViewItem, { type: 'header' }> {
    return {
        type: 'header',
        title: id,
        headerKind: 'folder',
        groupKey: `server:s:active:project:p:folder:${id}`,
        folderId: id,
        parentFolderId,
        depth,
        sessionCount: 0,
    } as Extract<SessionListViewItem, { type: 'header' }>;
}

function session(id: string, folderId: string | null, folderDepth: number): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        session: { id, name: id } as unknown as Extract<SessionListViewItem, { type: 'session' }>['session'],
        groupKey: folderId ? `server:s:active:project:p:folder:${folderId}` : 'server:s:active:project:p',
        groupKind: folderId ? 'folder' : 'project',
        folderId,
        folderDepth,
        section: 'active',
    };
}

describe('resolveSessionFolderHeaderDropPlacement', () => {
    it('moves a nested folder above a root folder when the drop line is above that root folder', () => {
        const items: SessionListViewItem[] = [
            project(),
            folder('fefg', null, 0),
            folder('test', null, 0),
            folder('browser-audit', 'test', 1),
            folder('test-3', 'test', 1),
        ];

        expect(resolveSessionFolderHeaderDropPlacement({
            items,
            folderId: 'browser-audit',
            positionDelta: -2,
        })).toEqual({
            parentId: null,
            beforeFolderId: 'fefg',
        });
    });

    it('keeps a folder move unresolved when the drop line lands inside its own subtree', () => {
        const items: SessionListViewItem[] = [
            project(),
            folder('parent', null, 0),
            folder('child', 'parent', 1),
            session('inside', 'child', 2),
            folder('sibling', null, 0),
        ];

        expect(resolveSessionFolderHeaderDropPlacement({
            items,
            folderId: 'parent',
            positionDelta: 1,
        })).toBeNull();
    });
});
