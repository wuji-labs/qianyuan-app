import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { SessionTurnsProjectionV1 } from '@happier-dev/protocol';

import { resolveTranscriptRollbackActions } from './rollbackUiSupport';

function createActiveSession(params: Readonly<{
    metadata: Metadata;
    sessionTurns?: SessionTurnsProjectionV1 | null;
    rollbackEligibleTurnStarts?: readonly number[] | null;
}>): Session & { sessionTurns?: SessionTurnsProjectionV1 | null } {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: params.metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...(params.sessionTurns !== undefined ? { sessionTurns: params.sessionTurns } : {}),
        ...(params.rollbackEligibleTurnStarts !== undefined ? { rollbackEligibleTurnStarts: params.rollbackEligibleTurnStarts } : {}),
    };
}

function userTextMessage(id: string, seq: number, text: string): Message {
    return {
        kind: 'user-text',
        id,
        seq,
        localId: id,
        createdAt: seq,
        text,
    };
}

function agentTextMessage(id: string, seq: number, text: string): Message {
    return {
        kind: 'agent-text',
        id,
        seq,
        localId: id,
        createdAt: seq,
        text,
    };
}

describe('resolveTranscriptRollbackActions', () => {
    it('exposes rollback-to-point only on completed turn-start user messages', () => {
        const session = createActiveSession({
            metadata: {
                path: '/workspace',
                host: 'localhost',
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
            sessionTurns: {
                v: 1,
                sessionId: 's1',
                latestTurnId: 'turn-1',
                updatedAt: 10,
                turns: [
                    {
                        turnId: 'turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 10,
                        terminalAt: 10,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1, 3], startSeqInclusive: 1, endSeqInclusive: 4 },
                        rollback: { state: 'eligible', updatedAt: 10 },
                    },
                ],
            },
        });
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'initial prompt'),
            a1: agentTextMessage('a1', 2, 'partial reply'),
            u2: userTextMessage('u2', 3, 'steer prompt'),
            a2: agentTextMessage('a2', 4, 'final reply'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'a1', 'u2', 'a2'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'initial prompt',
            },
        });
    });

    it('ignores turns that are not completed rollback-eligible starts', () => {
        const messagesById: Record<string, Message> = {
            active: userTextMessage('active', 1, 'active prompt'),
            interrupted: userTextMessage('interrupted', 3, 'interrupted prompt'),
            rolledBack: userTextMessage('rolledBack', 5, 'rolled back prompt'),
            malformedEnd: userTextMessage('malformedEnd', 7, 'malformed prompt'),
            notEligible: userTextMessage('notEligible', 9, 'not eligible prompt'),
        };
        const session = createActiveSession({
            metadata: {
                path: '/workspace',
                host: 'localhost',
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
            sessionTurns: {
                v: 1,
                sessionId: 's1',
                latestTurnId: 'active-turn',
                updatedAt: 20,
                turns: [
                    {
                        turnId: 'active-turn',
                        status: 'in_progress',
                        startedAt: 20,
                        updatedAt: 20,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: null },
                    },
                    {
                        turnId: 'interrupted-turn',
                        status: 'cancelled',
                        startedAt: 20,
                        updatedAt: 20,
                        terminalAt: 20,
                        transcriptAnchors: { startUserMessageSeq: 3, userMessageSeqs: [3], startSeqInclusive: 3, endSeqInclusive: 4 },
                    },
                    {
                        turnId: 'rolled-back-turn',
                        status: 'failed',
                        startedAt: 20,
                        updatedAt: 20,
                        terminalAt: 20,
                        transcriptAnchors: { startUserMessageSeq: 5, userMessageSeqs: [5], startSeqInclusive: 5, endSeqInclusive: 6 },
                    },
                    {
                        turnId: 'malformed-end-turn',
                        status: 'completed',
                        startedAt: 20,
                        updatedAt: 20,
                        terminalAt: 20,
                        transcriptAnchors: { startUserMessageSeq: 7, userMessageSeqs: [7], startSeqInclusive: 7 },
                    },
                    {
                        turnId: 'not-eligible-turn',
                        status: 'completed',
                        startedAt: 20,
                        updatedAt: 20,
                        terminalAt: 20,
                        transcriptAnchors: { startUserMessageSeq: 9, userMessageSeqs: [9], startSeqInclusive: 9, endSeqInclusive: 10 },
                        rollback: { state: 'not_eligible', updatedAt: 20 },
                    },
                ],
            },
        });

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['active', 'interrupted', 'rolledBack', 'malformedEnd', 'notEligible'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({});
    });

    it('excludes rolled-back ranges from completed turn-start rollback actions', () => {
        const session = createActiveSession({
            metadata: {
                path: '/workspace',
                host: 'localhost',
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
            sessionTurns: {
                v: 1,
                sessionId: 's1',
                latestTurnId: 'turn-2',
                updatedAt: 10,
                turns: [
                    {
                        turnId: 'turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 10,
                        terminalAt: 10,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 2 },
                        rollback: { state: 'eligible', updatedAt: 10 },
                    },
                    {
                        turnId: 'turn-2',
                        status: 'completed',
                        startedAt: 3,
                        updatedAt: 10,
                        terminalAt: 10,
                        transcriptAnchors: { startUserMessageSeq: 3, userMessageSeqs: [3], startSeqInclusive: 3, endSeqInclusive: 4 },
                        rollback: { state: 'eligible', updatedAt: 10 },
                    },
                ],
            },
        });
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'first prompt'),
            a1: agentTextMessage('a1', 2, 'reply'),
            u2: userTextMessage('u2', 3, 'second prompt'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'a1', 'u2'],
            messagesById,
            rollbackRanges: [{ startSeqInclusive: 1, endSeqInclusive: 2 }],
        })).toEqual({
            u2: {
                target: { type: 'before_user_message', userMessageSeq: 3 },
                restoredDraftText: 'second prompt',
            },
        });
    });

    it('does not treat legacy turn-ledger metadata as rollback evidence', () => {
        const session = createActiveSession({
            metadata: {
                path: '/workspace',
                host: 'localhost',
                flavor: 'codex',
                codexBackendMode: 'appServer',
                sessionTurnLedgerV1: {
                    v: 1,
                    sessionId: 's1',
                    currentTurnId: 'turn-1',
                    updatedAt: 10,
                    entries: [
                        {
                            turnId: 'turn-1',
                            status: 'completed',
                            startedAt: 1,
                            updatedAt: 10,
                            terminalAt: 10,
                            transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 2 },
                            rollback: { state: 'eligible', updatedAt: 10 },
                        },
                    ],
                    recentMutationIds: ['m1'],
                },
            },
        });
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'first prompt'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({});
    });

    it('uses flattened rollback-eligible turn starts when full session turns are not hydrated', () => {
        const session = createActiveSession({
            metadata: {
                path: '/workspace',
                host: 'localhost',
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
            rollbackEligibleTurnStarts: [1],
        });
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'initial prompt'),
            u2: userTextMessage('u2', 3, 'steer prompt'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'u2'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'initial prompt',
            },
        });
    });
});
