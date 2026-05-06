import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildInboxSessionState } from './buildInboxSessionState';

function makeUnreadRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 1,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        hasUnreadMessages: true,
        ...overrides,
    };
}

describe('buildInboxSessionState', () => {
    it('deduplicates unread session rows by canonical session id', () => {
        const firstSession = makeUnreadRenderable({ id: 'session-1', updatedAt: 20 });
        const duplicateSession = makeUnreadRenderable({ id: 'session-1', updatedAt: 10 });

        const state = buildInboxSessionState({
            sessions: [],
            sessionRows: [firstSession, duplicateSession],
        });

        expect(state.unreadSessions).toEqual([firstSession]);
    });
});
