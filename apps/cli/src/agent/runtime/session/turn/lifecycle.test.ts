import { describe, expect, it } from 'vitest';

import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from './lifecycle';

describe('SessionTurnLifecycle', () => {
    it('attaches a late provider turn id without replacing the session turn id', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'turn-1',
            now: () => 123,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        const handle = await lifecycle.beginTurn({ provider: 'codex' });
        await lifecycle.attachProviderTurnId({
            provider: 'codex',
            providerTurnId: 'provider-turn-1',
        });
        await lifecycle.completeTurn({ provider: 'codex' });

        expect(mutations).toEqual([
            expect.objectContaining({
                action: 'begin',
                turnId: handle.turnId,
                provider: 'codex',
            }),
            expect.objectContaining({
                action: 'attach_provider_turn_id',
                turnId: handle.turnId,
                provider: 'codex',
                providerTurnId: 'provider-turn-1',
            }),
            expect.objectContaining({
                action: 'complete',
                turnId: handle.turnId,
                provider: 'codex',
                providerTurnId: 'provider-turn-1',
            }),
        ]);
        expect('providerTurnId' in mutations[0]!).toBe(false);
        expect(handle.turnId).toBe('session-turn:turn-1');
    });

    it('records rollback eligibility and rolled-back state as session turn mutations', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            now: () => 456,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        await lifecycle.markRollbackEligible({
            turnId: 'session-turn-1',
            provider: 'codex',
            transcriptAnchors: { startUserMessageSeq: 10, endSeqInclusive: 20 },
        });
        await lifecycle.markRolledBack({
            turnId: 'session-turn-1',
            provider: 'codex',
        });

        expect(mutations).toEqual([
            expect.objectContaining({
                action: 'mark_rollback_eligible',
                turnId: 'session-turn-1',
                provider: 'codex',
                transcriptAnchors: { startUserMessageSeq: 10, endSeqInclusive: 20 },
            }),
            expect.objectContaining({
                action: 'mark_rolled_back',
                turnId: 'session-turn-1',
                provider: 'codex',
            }),
        ]);
        expect('rollback' in mutations[0]!).toBe(false);
        expect('rollback' in mutations[1]!).toBe(false);
    });

    it('does not create an active turn when appending anchors without a trusted turn reference', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'orphan-turn',
            now: () => 789,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        await lifecycle.appendTranscriptAnchors({
            provider: 'codex',
            transcriptAnchors: { userMessageSeqs: [12] },
        });
        await lifecycle.appendTranscriptAnchors({
            provider: 'codex',
            transcriptAnchors: { userMessageSeqs: [13] },
        });

        expect(mutations).toEqual([]);
    });

    it('does not create an active turn when attaching a provider id without a trusted turn reference', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'orphan-turn',
            now: () => 790,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        await lifecycle.attachProviderTurnId({
            provider: 'codex',
            providerTurnId: 'provider-turn-1',
        });
        await lifecycle.appendTranscriptAnchors({
            provider: 'codex',
            transcriptAnchors: { userMessageSeqs: [13] },
        });

        expect(mutations).toEqual([]);
    });

    it('does not allocate a terminal turn when no lifecycle turn is active', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'orphan-turn',
            now: () => 791,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        await lifecycle.completeTurn({ provider: 'codex', providerTurnId: 'random-complete' });
        await lifecycle.failTurn({ provider: 'codex', providerTurnId: 'random-fail' });
        await lifecycle.cancelTurn({ provider: 'codex', providerTurnId: 'random-cancel' });

        expect(mutations).toEqual([]);
    });

    it('appends anchors to an explicit trusted turn reference without making it active', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'orphan-turn',
            now: () => 891,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        await lifecycle.appendTranscriptAnchors({
            turnId: 'trusted-turn-1',
            provider: 'codex',
            transcriptAnchors: { userMessageSeqs: [12] },
        });
        await lifecycle.appendTranscriptAnchors({
            provider: 'codex',
            transcriptAnchors: { userMessageSeqs: [13] },
        });

        expect(mutations).toEqual([
            expect.objectContaining({
                action: 'append_transcript_anchors',
                turnId: 'trusted-turn-1',
                provider: 'codex',
                transcriptAnchors: { userMessageSeqs: [12] },
            }),
        ]);
    });

    it('emits turn lifecycle callbacks for start, boundary completion, failure, and cancellation', async () => {
        const events: Array<readonly [string, string | undefined]> = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'turn-callback',
            enqueueSessionTurn: async () => {},
            onTurnLifecycleEvent: (event, terminalStatus) => {
                events.push([event, terminalStatus]);
            },
        });

        await lifecycle.beginTurn({ provider: 'codex' });
        await lifecycle.completeTurn({ provider: 'codex' });
        await lifecycle.beginTurn({ provider: 'codex' });
        await lifecycle.failTurn({ provider: 'codex' });
        await lifecycle.beginTurn({ provider: 'codex' });
        await lifecycle.cancelTurn({ provider: 'codex' });

        expect(events).toEqual([
            ['prompt_or_steer', undefined],
            // REV-1: completed vs failed turns share the boundary event but must be
            // distinguishable downstream (failed turns are not supersession/activity proof).
            ['assistant_message_end', 'completed'],
            ['prompt_or_steer', undefined],
            ['assistant_message_end', 'failed'],
            ['prompt_or_steer', undefined],
            ['turn_cancelled', undefined],
        ]);
    });

    it('emits turn lifecycle callbacks for ACP task markers from resumed provider work', async () => {
        const events: Array<readonly [string, string | undefined]> = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'provider-marker',
            enqueueSessionTurn: async () => {},
            onTurnLifecycleEvent: (event, terminalStatus) => {
                events.push([event, terminalStatus]);
            },
        });

        lifecycle.observeAcpLifecycleMarker({
            provider: 'pi',
            body: { type: 'task_started', id: 'provider-turn-1' },
        });
        lifecycle.observeAcpLifecycleMarker({
            provider: 'pi',
            body: { type: 'turn_failed', id: 'provider-turn-1' },
        });

        expect(events).toEqual([
            ['task_started', undefined],
            ['assistant_message_end', 'failed'],
        ]);
    });

    it('allocates and fails a session-owned turn for an idle session-scoped failure when opted in (silent host-death fix, incident cmq8y3nlx)', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const events: Array<readonly [string, string | undefined]> = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'idle-host-death',
            now: () => 991,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
            onTurnLifecycleEvent: (event, terminalStatus) => {
                events.push([event, terminalStatus]);
            },
        });

        const issue = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'provider_process_exit',
            source: 'provider_process_exit',
            occurredAt: 991,
            sanitizedPreview: 'Provider process exited',
        } as const;

        await lifecycle.failTurn({ provider: 'claude', issue, allocateWhenIdle: true });

        expect(mutations).toEqual([
            expect.objectContaining({
                action: 'begin',
                turnId: 'session-turn:idle-host-death',
                provider: 'claude',
            }),
            expect.objectContaining({
                action: 'fail',
                turnId: 'session-turn:idle-host-death',
                provider: 'claude',
                issue,
            }),
        ]);
        // No misleading turn-start signal for daemon observers; only the failed boundary.
        expect(events).toEqual([
            ['assistant_message_end', 'failed'],
        ]);
        expect(lifecycle.hasActiveTurn()).toBe(false);
    });

    it('fails the active turn normally when allocation is requested while a turn is open', async () => {
        const mutations: SessionTurnMutationV1[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'active-turn',
            now: () => 992,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        const handle = await lifecycle.beginTurn({ provider: 'claude' });
        await lifecycle.failTurn({ provider: 'claude', allocateWhenIdle: true });

        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'fail']);
        expect(mutations[1]).toMatchObject({ turnId: handle.turnId });
    });

    it('does not emit boundary callbacks when there is no active lifecycle turn', async () => {
        const events: string[] = [];
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 's1',
            createId: () => 'turn-callback-none',
            enqueueSessionTurn: async () => {},
            onTurnLifecycleEvent: (event) => {
                events.push(event);
            },
        });

        await lifecycle.completeTurn({ provider: 'codex' });
        await lifecycle.failTurn({ provider: 'codex' });
        await lifecycle.cancelTurn({ provider: 'codex' });

        expect(events).toEqual([]);
    });
});
