import { describe, expect, it } from 'vitest';

import {
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionTarget,
} from './sessionBulkActionTypes';
import { listSessionBulkActionDescriptors } from './sessionBulkActionPresentation';

describe('listSessionBulkActionDescriptors', () => {
    it('centralizes bulk action-bar presentation availability for mixed selected sessions', () => {
        const targets: SessionBulkActionTarget[] = [
            {
                key: 'session-a',
                sessionId: 'session-a',
                active: true,
                archived: false,
                hasAdminAccess: true,
                canStop: true,
                canArchive: true,
                pinned: false,
                tags: [],
                readState: 'unread',
            },
            {
                key: 'session-b',
                sessionId: 'session-b',
                active: false,
                archived: true,
                hasAdminAccess: true,
                canStop: false,
                canArchive: false,
                pinned: true,
                tags: ['urgent'],
                readState: 'read',
            },
        ];

        const descriptors = listSessionBulkActionDescriptors({
            targets,
            tagsEnabled: true,
            moveEnabled: true,
        });

        expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
            SESSION_BULK_ACTION_IDS.stop,
            SESSION_BULK_ACTION_IDS.archive,
            SESSION_BULK_ACTION_IDS.unarchive,
            SESSION_BULK_ACTION_IDS.markRead,
            SESSION_BULK_ACTION_IDS.markUnread,
            SESSION_BULK_ACTION_IDS.pin,
            SESSION_BULK_ACTION_IDS.unpin,
            SESSION_BULK_ACTION_IDS.tagsAdd,
            SESSION_BULK_ACTION_IDS.tagsRemove,
            SESSION_BULK_ACTION_IDS.tagsSet,
            SESSION_BULK_ACTION_IDS.moveToFolder,
        ]);
        expect(descriptors.find((descriptor) => descriptor.id === SESSION_BULK_ACTION_IDS.stop)).toMatchObject({
            requiresConfirmation: true,
            destructive: true,
        });
        expect(descriptors.find((descriptor) => descriptor.id === SESSION_BULK_ACTION_IDS.archive)).toMatchObject({
            requiresConfirmation: true,
            destructive: true,
        });
    });

    it('hides lifecycle actions when selected targets are not eligible for them', () => {
        const descriptors = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'active-shared',
                    sessionId: 'active-shared',
                    active: true,
                    archived: false,
                    hasAdminAccess: false,
                    canStop: false,
                    canArchive: false,
                },
                {
                    key: 'archived-shared',
                    sessionId: 'archived-shared',
                    active: false,
                    archived: true,
                    hasAdminAccess: false,
                    canStop: false,
                    canArchive: false,
                },
            ],
            tagsEnabled: false,
            moveEnabled: false,
        });

        const actionIds = descriptors.map((descriptor) => descriptor.id);
        expect(actionIds).not.toContain(SESSION_BULK_ACTION_IDS.stop);
        expect(actionIds).not.toContain(SESSION_BULK_ACTION_IDS.archive);
        expect(actionIds).not.toContain(SESSION_BULK_ACTION_IDS.unarchive);
    });

    it('does not expose read-state actions when selected targets have no available read state', () => {
        const descriptors = listSessionBulkActionDescriptors({
            targets: [
                {
                    key: 'session-archived',
                    sessionId: 'session-archived',
                    archived: true,
                    readState: undefined,
                },
            ],
            tagsEnabled: false,
            moveEnabled: false,
        });

        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.markRead);
        expect(descriptors.map((descriptor) => descriptor.id)).not.toContain(SESSION_BULK_ACTION_IDS.markUnread);
    });
});
