import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { createSessionActionTarget } from './sessionActionContext';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
} from './sessionActionIds';
import { listVisibleSessionActionIds } from './sessionActionAvailability';

describe('session action availability', () => {
    it('keeps session-info shared actions as a superset of row lifecycle actions', () => {
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

        const rowLifecycleActionIds = listVisibleSessionActionIds({
            target,
            surface: 'rowMenu',
        }).filter((id) => id !== SESSION_ACTION_MOVE_TO_FOLDER_ID);
        const infoActionIds = listVisibleSessionActionIds({
            target,
            surface: 'sessionInfo',
        });

        expect(rowLifecycleActionIds).toEqual([
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
        ]);
        expect(infoActionIds).toEqual(expect.arrayContaining(rowLifecycleActionIds));
    });

    it('shows session-info delete only for inactive sessions owned by the current user', () => {
        const sharedSession: SessionListRenderableSession = {
            id: 'shared_session',
            active: false,
            archivedAt: null,
            owner: 'owner_user',
            accessLevel: 'view',
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        };
        const ownedSession: SessionListRenderableSession = {
            ...sharedSession,
            id: 'owned_session',
            owner: 'current_user',
            accessLevel: undefined,
        };

        const sharedTarget = createSessionActionTarget({
            session: sharedSession,
            currentUserId: null,
            isConnected: false,
            isPinned: false,
        });
        const ownedTarget = createSessionActionTarget({
            session: ownedSession,
            currentUserId: 'current_user',
            isConnected: false,
            isPinned: false,
        });

        expect(listVisibleSessionActionIds({ target: sharedTarget, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: ownedTarget, surface: 'sessionInfo' })).toContain(SESSION_ACTION_DELETE_ID);
    });
});
