import * as React from 'react';
import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';

import { buildSessionRowMoreMenuItems } from './buildSessionRowActionMenuItems';

describe('buildSessionRowMoreMenuItems', () => {
    it('composes shared session actions with the row move-to-folder action', () => {
        const session: SessionListRenderableSession = {
            id: 'session_1',
            active: true,
            archivedAt: null,
            owner: 'user_1',
            accessLevel: undefined,
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        };
        const target = createSessionActionTarget({
            session,
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            isPinned: false,
        });

        const items = buildSessionRowMoreMenuItems({
            target,
            iconColor: '#999',
            canMoveToFolder: false,
            folderMoveMenuItems: [
                { id: 'move-to-folder:null', title: 'Workspace root', icon: React.createElement('Icon') },
            ],
        });

        expect(items.map((item) => item.id)).toEqual([
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
            SESSION_ACTION_MOVE_TO_FOLDER_ID,
        ]);
        expect(items.at(-1)?.submenu?.items).toHaveLength(1);
    });
});
