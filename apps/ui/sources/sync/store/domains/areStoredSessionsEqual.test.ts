import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';

function session(overrides: Partial<Session> & {
    latestTurnStatus?: unknown;
    lastRuntimeIssue?: unknown;
} = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

describe('areStoredSessionsEqual', () => {
    it('detects primary turn status changes', () => {
        expect(areStoredSessionsEqual(
            session({ latestTurnStatus: 'in_progress' }),
            session({ latestTurnStatus: 'failed' }),
        )).toBe(false);
    });

    it('detects runtime issue projection changes', () => {
        expect(areStoredSessionsEqual(
            session({
                latestTurnStatus: 'failed',
                lastRuntimeIssue: {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'auth_error',
                    source: 'auth_error',
                    occurredAt: 1,
                },
            }),
            session({
                latestTurnStatus: 'failed',
                lastRuntimeIssue: null,
            }),
        )).toBe(false);
    });
});
