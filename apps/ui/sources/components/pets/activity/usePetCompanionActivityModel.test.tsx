import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';

import { usePetCompanionActivityModel } from './usePetCompanionActivityModel';
import { PET_COMPANION_ACTIVITY_EXPIRY_MS } from './petCompanionActivityConstants';

function createSessionMessages(messages: readonly Message[]): SessionMessages {
    const messagesById: Record<string, Message> = {};
    const messageIdsOldestFirst: string[] = [];
    for (const message of messages) {
        messagesById[message.id] = message;
        messageIdsOldestFirst.push(message.id);
    }

    return {
        messageIdsOldestFirst,
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: messages.length,
        isLoaded: true,
    };
}

describe('usePetCompanionActivityModel', () => {
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(4_000);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('maps real transcript failure status to failed activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'failed-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const failedToolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-failed',
            localId: null,
            createdAt: 2_000,
            tool: {
                id: 'tool-1',
                name: 'Bash',
                state: 'error',
                input: { command: 'exit 1' },
                createdAt: 2_000,
                startedAt: 2_000,
                completedAt: 2_100,
                description: null,
                result: { error: 'Command failed' },
            },
            children: [],
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {
                    ...state.sessionMessages,
                    [session.id]: createSessionMessages([failedToolMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'failed',
                reason: 'failed',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'failed',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when unrelated storage state changes', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeUnrelatedUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    settings: state.settings,
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a hydrated session heartbeat leaves its renderable row unchanged', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-renderable-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [session.id]: {
                            ...session,
                            updatedAt: session.updatedAt + 1,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute fallback activity when a session heartbeat only changes volatile fields', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-fallback-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [session.id]: {
                            ...session,
                            seq: session.seq + 1,
                            updatedAt: session.updatedAt + 1,
                            thinkingAt: session.thinkingAt + 1,
                            metadata: {
                                ...session.metadata,
                                path: session.metadata?.path ?? '',
                                host: session.metadata?.host ?? '',
                                summaryText: 'streaming heartbeat',
                            },
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a renderable heartbeat only updates row recency', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-renderable-recency-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const renderable = buildSessionListRenderableFromSession(session);

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: renderable,
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            updatedAt: renderable.updatedAt + 1,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a live renderable heartbeat only advances session seq', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-renderable-seq-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const renderable = buildSessionListRenderableFromSession(session);

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: renderable,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            seq: renderable.seq + 1,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a live renderable heartbeat only advances activeAt', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-renderable-active-at-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const renderable = {
            ...buildSessionListRenderableFromSession(session),
            latestTurnStatus: 'in_progress' as const,
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: renderable,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            activeAt: renderable.activeAt + 1_000,
                            updatedAt: renderable.updatedAt + 1_000,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when renderable row recency changes reorder multiple live sessions', async () => {
        const previousState = storage.getState();
        const sessionA = createSessionFixture({
            id: 'stable-renderable-order-a',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const sessionB = createSessionFixture({
            id: 'stable-renderable-order-b',
            active: true,
            seq: 1,
            createdAt: 1_100,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 3_000,
        });
        const renderableA = buildSessionListRenderableFromSession(sessionA);
        const renderableB = buildSessionListRenderableFromSession(sessionB);

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [sessionA.id]: renderableA,
                    [sessionB.id]: renderableB,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [sessionA.id]: {
                            ...renderableA,
                            updatedAt: 4_000,
                            thinkingAt: 4_000,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a live renderable summary changes during streaming', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-renderable-summary-session',
            active: true,
            seq: 3,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
            metadata: {
                path: '/tmp/stable-renderable-summary',
                host: 'localhost',
                summary: {
                    text: 'Initial live summary',
                    updatedAt: 2_000,
                },
            },
        });
        const renderable = buildSessionListRenderableFromSession(session);

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: renderable,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeSummaryUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            updatedAt: renderable.updatedAt + 1_000,
                            metadata: renderable.metadata
                                ? {
                                    ...renderable.metadata,
                                    summaryText: 'Updated streaming summary',
                                }
                                : renderable.metadata,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeSummaryUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('ignores transcript updates outside the companion session scope', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'scoped-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const unrelatedMessage: Message = {
            kind: 'agent-text',
            id: 'unrelated-message',
            localId: null,
            createdAt: 3_000,
            text: 'Background session streamed a token',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeUnrelatedTranscriptUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        'unrelated-session': createSessionMessages([unrelatedMessage]),
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedTranscriptUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity for streamed text updates on the same latest message', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'streaming-text-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const message: Message = {
            kind: 'agent-text',
            id: 'streaming-message',
            localId: null,
            createdAt: 3_000,
            text: 'Streaming',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {
                    [session.id]: createSessionMessages([message]),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeStreamChunk = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [session.id]: createSessionMessages([{
                            ...message,
                            text: `${message.text} response chunk`,
                        }]),
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeStreamChunk);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity for new streamed text messages while live activity is already visible', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'streaming-new-text-session',
            active: true,
            seq: 3,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const firstMessage: Message = {
            kind: 'agent-text',
            id: 'streaming-message-1',
            localId: null,
            createdAt: 2_000,
            text: 'Starting',
        };
        const secondMessage: Message = {
            kind: 'agent-text',
            id: 'streaming-message-2',
            localId: null,
            createdAt: 3_000,
            text: 'Continuing',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {
                    [session.id]: createSessionMessages([firstMessage]),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeStreamingMessage = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [session.id]: createSessionMessages([firstMessage, secondMessage]),
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeStreamingMessage);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a live renderable thinking heartbeat advances', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'live-renderable-heartbeat-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const renderable = buildSessionListRenderableFromSession(session);

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: renderable,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            updatedAt: renderable.updatedAt + 2_000,
                            thinkingAt: renderable.thinkingAt + 2_000,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a live renderable only changes non-visual runtime fields', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'live-renderable-runtime-noise-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const renderable = {
            ...buildSessionListRenderableFromSession(session),
            latestTurnStatus: 'in_progress' as const,
            optimisticThinkingAt: 2_000,
            thinkingGraceUntil: 5_000,
            presence: 2_000,
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: renderable,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            updatedAt: 4_000,
                            thinkingAt: 4_000,
                            optimisticThinkingAt: 4_000,
                            thinkingGraceUntil: 7_000,
                            presence: 4_000,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a renderable read cursor changes without changing unread state', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'renderable-read-cursor-noise-session',
            active: true,
            seq: 5,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const renderable = {
            ...buildSessionListRenderableFromSession(session),
            hasUnreadMessages: true,
            metadata: {
                ...buildSessionListRenderableFromSession(session).metadata!,
                readStateV1: {
                    v: 1 as const,
                    sessionSeq: 1,
                    pendingActivityAt: 2_000,
                    updatedAt: 2_000,
                },
            },
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: renderable,
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeCursorUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [session.id]: {
                            ...renderable,
                            metadata: {
                                ...renderable.metadata!,
                                readStateV1: {
                                    v: 1,
                                    sessionSeq: 2,
                                    pendingActivityAt: 4_000,
                                    updatedAt: 4_000,
                                },
                            },
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeCursorUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a live transcript thinking heartbeat advances', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'live-transcript-heartbeat-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const message: Message = {
            kind: 'agent-text',
            id: 'thinking-message',
            localId: null,
            createdAt: 2_000,
            text: 'Working',
        };
        const transcript = {
            ...createSessionMessages([message]),
            latestThinkingMessageId: message.id,
            latestThinkingMessageActivityAtMs: 2_000,
        } satisfies SessionMessages;

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {
                    [session.id]: transcript,
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [session.id]: {
                            ...transcript,
                            latestThinkingMessageActivityAtMs: 4_000,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when an unused transcript ready event heartbeat advances', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'live-ready-event-heartbeat-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 2_000,
        });
        const message: Message = {
            kind: 'agent-text',
            id: 'ready-event-message',
            localId: null,
            createdAt: 2_000,
            text: 'Working',
        };
        const transcript = createSessionMessages([message]);

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {
                    [session.id]: transcript,
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeHeartbeat = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [session.id]: {
                            ...transcript,
                            latestReadyEventSeq: 42,
                            latestReadyEventAt: 4_000,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHeartbeat);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity for pending text updates on the same queued message', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'pending-text-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const pendingMessage = {
            id: 'pending-message',
            localId: null,
            createdAt: 3_000,
            updatedAt: 3_000,
            text: 'Queued',
            rawRecord: {},
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionPending: {
                    [session.id]: {
                        messages: [pendingMessage],
                        discarded: [],
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforePendingTextUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionPending: {
                        ...state.sessionPending,
                        [session.id]: {
                            messages: [{
                                ...pendingMessage,
                                updatedAt: pendingMessage.updatedAt + 1,
                                text: `${pendingMessage.text} edit`,
                            }],
                            discarded: [],
                            isLoaded: true,
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforePendingTextUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('aggregates failure signals across non-selected sessions', async () => {
        const previousState = storage.getState();
        const activeSession = createSessionFixture({
            id: 'active-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const failedSession = createSessionFixture({
            id: 'failed-session',
            active: false,
            seq: 2,
            createdAt: 1_500,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 2,
            thinking: false,
            thinkingAt: 0,
        });
        const failedToolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-failed',
            localId: null,
            createdAt: 3_000,
            tool: {
                id: 'tool-1',
                name: 'Bash',
                state: 'error',
                input: { command: 'exit 1' },
                createdAt: 3_000,
                startedAt: 3_000,
                completedAt: 3_100,
                description: null,
                result: { error: 'Command failed' },
            },
            children: [],
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [activeSession.id]: activeSession,
                    [failedSession.id]: failedSession,
                },
                sessionMessages: {
                    ...state.sessionMessages,
                    [activeSession.id]: createSessionMessages([]),
                    [failedSession.id]: createSessionMessages([failedToolMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'failed',
                reason: 'failed',
                sessionId: failedSession.id,
            });
            expect(hook.getCurrent().trayItems.map((item) => item.sessionId)).toContain(failedSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not treat a read online row with historical thinkingAt as running activity', async () => {
        vi.mocked(Date.now).mockReturnValue(12_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'historical-thinking-session',
            active: false,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 10_000,
            activeAt: 10_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 10_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('keeps old unread sessions visible as waiting activity until they are read', async () => {
        vi.mocked(Date.now).mockReturnValue(900_000_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'old-unread-session',
            active: false,
            seq: 5,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'waiting',
                reason: 'waiting',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'waiting',
                        expiresAtMs: null,
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('keeps the companion attached to unhydrated session-list rows before full data readiness', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'renderable-only-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('excludes metadata-unavailable session-list rows from companion activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'unavailable-renderable-session',
            active: false,
            seq: 5,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 1_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: false,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: {
                        ...buildSessionListRenderableFromSession(session),
                        metadata: null,
                        metadataUnavailable: true,
                        hasUnreadMessages: true,
                    },
                },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: null,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('excludes hidden system sessions from companion activity', async () => {
        const previousState = storage.getState();
        const voiceSession = createSessionFixture({
            id: 'voice-system-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 0,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/voice-system-session',
                host: 'test-host',
                summary: { text: 'Voice conversation (system)', updatedAt: 3_000 },
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        });
        const visibleSession = createSessionFixture({
            id: 'visible-session',
            active: true,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 2,
            pendingCount: 0,
            pendingUserActionRequestCount: 1,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/visible-session',
                host: 'test-host',
                summary: { text: 'Visible session', updatedAt: 2_000 },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [voiceSession.id]: voiceSession },
                sessionListRenderables: {
                    [voiceSession.id]: buildSessionListRenderableFromSession(voiceSession),
                    [visibleSession.id]: buildSessionListRenderableFromSession(visibleSession),
                },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'waiting',
                reason: 'waiting',
                sessionId: visibleSession.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: visibleSession.id,
                        title: 'Visible session',
                    }),
                ],
            });
            expect(hook.getCurrent().trayItems.map((item) => item.sessionId)).not.toContain(voiceSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses unhydrated session-list row thinking state as running activity', async () => {
        vi.mocked(Date.now).mockReturnValue(12_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'renderable-thinking-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 10_000,
            activeAt: 10_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 10_000,
            metadata: {
                path: '/tmp/renderable-thinking',
                host: 'localhost',
                summary: {
                    text: 'Renderable status should drive the pet',
                    updatedAt: 10_000,
                },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'running',
                reason: 'running',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'running',
                        title: 'Renderable status should drive the pet',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('keeps active unread thinking sessions in running state', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'thinking-unread-session',
            active: true,
            seq: 3,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingCount: 0,
            thinking: true,
            thinkingAt: 3_000,
        });
        const message: Message = {
            kind: 'agent-text',
            id: 'thinking-unread-message',
            localId: null,
            createdAt: 3_000,
            text: 'Still streaming',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {
                    [session.id]: createSessionMessages([message]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'running',
                reason: 'running',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'running',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses stable timestamps for live tray items', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-live-timestamp-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 3_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().trayItems[0]).toMatchObject({
                sessionId: session.id,
                status: 'running',
                activityAtMs: null,
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('omits streaming subtitles from live running tray items', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'live-running-subtitle-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 3_000,
        });
        const message: Message = {
            kind: 'agent-text',
            id: 'live-running-subtitle-message',
            localId: null,
            createdAt: 3_000,
            text: 'Streaming text should not churn the tray subtitle',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {
                    [session.id]: createSessionMessages([message]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().trayItems[0]).toMatchObject({
                sessionId: session.id,
                status: 'running',
                subtitle: null,
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('expires stale activity when no store update happens at the expiry boundary', async () => {
        vi.restoreAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(4_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'recent-thinking-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 1_000,
            activeAt: 1_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 1_000,
            optimisticThinkingAt: 1_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'running',
                reason: 'running',
                sessionId: session.id,
            });

            await act(async () => {
                vi.setSystemTime(1_000 + PET_COMPANION_ACTIVITY_EXPIRY_MS.running + 1);
                await vi.advanceTimersByTimeAsync(PET_COMPANION_ACTIVITY_EXPIRY_MS.running);
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            storage.setState(previousState, true);
        }
    });

    it('does not use queued pending input as waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stale-queued-session',
            active: true,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 2,
            pendingCount: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses unhydrated agent-state requests as waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'agent-state-request-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 2_000,
                    },
                },
            },
            agentStateVersion: 2,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'waiting',
                reason: 'waiting',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'waiting',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses the newest committed transcript text as the tray subtitle', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'message-preview-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 0,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });
        const olderMessage: Message = {
            kind: 'user-text',
            id: 'message-older',
            localId: null,
            createdAt: 2_000,
            text: 'Inspect the tray card',
        };
        const latestMessage: Message = {
            kind: 'agent-text',
            id: 'message-latest',
            localId: null,
            createdAt: 3_000,
            text: 'Compact white bubbles are ready',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {
                    ...state.sessionMessages,
                    [session.id]: createSessionMessages([olderMessage, latestMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().trayItems[0]).toMatchObject({
                sessionId: session.id,
                subtitle: 'Compact white bubbles are ready',
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('falls back to the session-list summary when a hydrated session has no committed transcript text yet', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'summary-preview-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 0,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                sessionMessages: {},
                sessionListRenderables: {
                    [session.id]: {
                        ...buildSessionListRenderableFromSession(session),
                        metadata: {
                            ...buildSessionListRenderableFromSession(session).metadata!,
                            summaryText: 'Last visible conversation preview',
                        },
                    },
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().trayItems[0]).toMatchObject({
                sessionId: session.id,
                subtitle: 'Last visible conversation preview',
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('orders tray bubbles by meaningful conversation activity instead of heartbeat-style session updatedAt churn', async () => {
        const previousState = storage.getState();
        const staleHeartbeatSession = createSessionFixture({
            id: 'stale-heartbeat-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 9_000,
            activeAt: 1_000,
            lastViewedSessionSeq: 0,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });
        const recentConversationSession = createSessionFixture({
            id: 'recent-conversation-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 5_000,
            activeAt: 1_000,
            lastViewedSessionSeq: 0,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });
        const staleMessage: Message = {
            kind: 'agent-text',
            id: 'message-stale',
            localId: null,
            createdAt: 2_000,
            text: 'Older transcript',
        };
        const recentMessage: Message = {
            kind: 'agent-text',
            id: 'message-recent',
            localId: null,
            createdAt: 4_000,
            text: 'Newer transcript',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [staleHeartbeatSession.id]: staleHeartbeatSession,
                    [recentConversationSession.id]: recentConversationSession,
                },
                sessionMessages: {
                    [staleHeartbeatSession.id]: createSessionMessages([staleMessage]),
                    [recentConversationSession.id]: createSessionMessages([recentMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().trayItems.map((item) => item.sessionId)).toEqual([
                recentConversationSession.id,
                staleHeartbeatSession.id,
            ]);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
