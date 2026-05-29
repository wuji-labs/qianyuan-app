import React from 'react';
import { afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { useMessagesByIds } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useMessagesByIds', () => {
    it('returns a referentially stable array when store state is unchanged', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2'],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const ids = ['m-1', 'm-2'] as const;
            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent();
            const second = await hook.rerender();
            expect(second).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the selected array stable when an unrelated message changes', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': {
                    id: 'm-1',
                    kind: 'tool-call',
                    localId: null,
                    createdAt: 1,
                    tool: {
                        id: 'tool-1',
                        name: 'read',
                        state: 'completed',
                        input: null,
                        createdAt: 1,
                        startedAt: 1,
                        completedAt: 1,
                        description: null,
                    },
                    children: [],
                },
                'm-2': {
                    id: 'm-2',
                    kind: 'tool-call',
                    localId: null,
                    createdAt: 2,
                    tool: {
                        id: 'tool-2',
                        name: 'write',
                        state: 'completed',
                        input: null,
                        createdAt: 2,
                        startedAt: 2,
                        completedAt: 2,
                        description: null,
                    },
                    children: [],
                },
                'm-3': { id: 'm-3', kind: 'agent-text', localId: null, createdAt: 3, text: 'before', isThinking: true },
            } satisfies Record<string, Message>;

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2', 'm-3'],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: 'm-3',
                        latestThinkingMessageActivityAtMs: 1,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const ids = ['m-1', 'm-2'] as const;
            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useMessagesByIds('s-1', ids);
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent();
            const initialRenderCount = renderCount;

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1']!;
                    const unrelatedMessage = session.messagesById['m-3'];
                    if (!unrelatedMessage || unrelatedMessage.kind !== 'agent-text') {
                        throw new Error('Expected m-3 to be an agent text message');
                    }
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-3': {
                            ...unrelatedMessage,
                            text: 'after',
                        } satisfies Message,
                    };
                    return {
                        ...state,
                        sessionMessages: {
                            ...state.sessionMessages,
                            's-1': {
                                ...session,
                                messagesById: nextMessagesById,
                                messagesMap: nextMessagesById,
                                messagesVersion: session.messagesVersion + 1,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(first);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not trigger React 18 external-store snapshot warnings (getSnapshot should be cached)', async () => {
        const previousState = storage.getState();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2'],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const ids = ['m-1', 'm-2'] as const;
            function StrictModeWrapper({ children }: React.PropsWithChildren) {
                return <React.StrictMode>{children}</React.StrictMode>;
            }

            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                wrapper: StrictModeWrapper,
                flushOptions: { cycles: 1, turns: 4 },
            });

            const allMessages = spy.mock.calls.map((c) => String(c[0] ?? ''));
            expect(allMessages.some((m) => m.includes('getSnapshot') && m.includes('cached'))).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
            spy.mockRestore();
        }
    });
});
