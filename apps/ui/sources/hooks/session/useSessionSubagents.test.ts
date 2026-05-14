import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { renderHookAndCollectValues } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { getStorage } from '@/sync/domains/state/storage';
import type { DirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { useSessionSubagents } from './useSessionSubagents';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();
const directSessionRuntimeState = {
    directSessionLink: null as DirectSessionLink | null,
    status: null as UseDirectSessionRuntimeResult['status'],
    refreshNow: vi.fn(async () => null),
};
const directSessionRuntimeParams: unknown[] = [];
const runningExecutionRunsState = vi.hoisted(() => ({ current: [] as readonly any[] }));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/useSessionRunningExecutionRuns', () => ({
    useSessionRunningExecutionRuns: () => runningExecutionRunsState.current,
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: (params: unknown) => {
        directSessionRuntimeParams.push(params);
        return directSessionRuntimeState;
    },
}));

beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    directSessionRuntimeState.directSessionLink = null;
    directSessionRuntimeState.status = null;
    directSessionRuntimeParams.length = 0;
    runningExecutionRunsState.current = [];
});

describe('useSessionSubagents', () => {
    it('returns an empty subagent model without crashing when execution runs are disabled', async () => {
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: null,
                messages: [],
            }),
        );

        expect(seen.at(-1)).toEqual({
            subagents: [],
            participantTargets: [],
            sidechainIds: [],
        });
    });

    it('downgrades execution-run send and stop capabilities for linked direct sessions that are not locally controlled', async () => {
        directSessionRuntimeState.directSessionLink = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-session-1',
            source: { kind: 'claudeConfig' },
        };
        directSessionRuntimeState.status = {
            ok: true,
            machineOnline: true,
            runnerActive: false,
            activity: 'unknown',
            canTakeOverDirect: false,
            canTakeOverPersist: false,
            canForceStop: false,
        };

        const now = Date.now();
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                        directSessionV1: directSessionRuntimeState.directSessionLink,
                    },
                } as any,
                messages: [{
                    kind: 'tool-call',
                    id: 'tool-call-1',
                    localId: null,
                    createdAt: now,
                    tool: {
                        id: 'toolu_run_1',
                        name: 'SubAgentRun',
                        state: 'running',
                        input: { runId: 'run_1' },
                        createdAt: now,
                        startedAt: now,
                        completedAt: null,
                        description: null,
                    },
                    children: [],
                }],
            }),
        );

        expect(seen.at(-1)).toEqual({
            subagents: [expect.objectContaining({
                id: 'execution_run:run_1',
                capabilities: expect.objectContaining({
                    canSend: false,
                    canStop: false,
                }),
            })],
            participantTargets: [],
            sidechainIds: ['toolu_run_1'],
        });
    });

    it('disables internal direct-session runtime polling when the caller supplies runtime state', async () => {
        const suppliedRuntime = {
            directSessionLink: null,
            status: null,
            refreshNow: vi.fn(async () => null),
        };

        await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages: [],
                directSessionRuntime: suppliedRuntime,
            }),
        );

        expect(directSessionRuntimeParams).toContainEqual(expect.objectContaining({
            sessionId: 'session-1',
            enabled: false,
        }));
    });

    it('keeps derived participant collections stable when only volatile session fields change', async () => {
        const messages: readonly any[] = [];
        const hook = await renderHook((sessionSeq: number) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    seq: sessionSeq,
                    updatedAt: sessionSeq,
                    thinkingAt: sessionSeq,
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: 1,
            });

        const first = hook.getCurrent();
        await hook.rerender(2);
        const second = hook.getCurrent();

        expect(second.subagents).toBe(first.subagents);
        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        await hook.unmount();
    });

    it('keeps derived participant collections stable when non-subagent text streams', async () => {
        const now = Date.now();
        const baseMessages: readonly any[] = [{
            kind: 'tool-call',
            id: 'tool-call-1',
            localId: null,
            createdAt: now,
            tool: {
                id: 'toolu_run_1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
                createdAt: now,
                startedAt: now,
                completedAt: null,
                description: null,
            },
            children: [],
        }, {
            kind: 'agent-text',
            id: 'agent-text-1',
            localId: null,
            createdAt: now + 1,
            text: 'partial',
            children: [],
        }];
        const hook = await renderHook((messages: readonly any[]) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: baseMessages,
            });

        const first = hook.getCurrent();
        await hook.rerender([
            baseMessages[0],
            {
                ...baseMessages[1],
                text: 'partial response is still streaming',
            },
        ]);
        const second = hook.getCurrent();

        expect(second.subagents).toBe(first.subagents);
        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        await hook.unmount();
    });

    it('keeps participant target collections stable when equivalent running execution-run polls arrive', async () => {
        const now = Date.now();
        const messages: readonly any[] = [{
            kind: 'tool-call',
            id: 'tool-call-1',
            localId: null,
            createdAt: now,
            tool: {
                id: 'toolu_run_1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
                createdAt: now,
                startedAt: now,
                completedAt: null,
                description: null,
            },
            children: [],
        }];
        runningExecutionRunsState.current = [{
            runId: 'run_1',
            status: 'running',
        }];

        const hook = await renderHook((tick: number) =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                    },
                } as any,
                messages,
                directSessionRuntime: directSessionRuntimeState,
            }), {
                initialProps: 1,
            });

        const first = hook.getCurrent();
        runningExecutionRunsState.current = [{
            runId: 'run_1',
            status: 'running',
        }];
        await hook.rerender(2);
        const second = hook.getCurrent();

        expect(second.participantTargets).toBe(first.participantTargets);
        expect(second.sidechainIds).toBe(first.sidechainIds);
        await hook.unmount();
    });
});
