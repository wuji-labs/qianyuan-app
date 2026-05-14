import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useUserMessageHistory } from './useUserMessageHistory';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchUserMessageHistoryPageMock = vi.hoisted(() => vi.fn());
const roleQuerySupportedState = vi.hoisted(() => ({ supported: true }));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchUserMessageHistoryPage: (...args: unknown[]) => fetchUserMessageHistoryPageMock(...args),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: {
            capabilities: {
                session: {
                    messages: {
                        role: roleQuerySupportedState.supported,
                    },
                },
            },
        },
    }),
}));

describe('useUserMessageHistory server role query', () => {
    afterEach(() => {
        vi.clearAllMocks();
        roleQuerySupportedState.supported = true;
        storage.setState((state) => ({
            ...state,
            sessionMessages: {},
        }));
    });

    it('loads server user messages on warmup when no local per-session history is loaded', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValueOnce({
            status: 'loaded',
            entries: [{ seq: 3, createdAt: 30, text: 'from server' }],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('s1', {
            limit: 25,
        });
        expect(hook.getCurrent().moveUp('draft')).toBe('from server');
        await hook.unmount();
    });

    it('does not query old servers without session message role capability', async () => {
        roleQuerySupportedState.supported = false;
        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('prefetches before reaching the oldest loaded user message and stops after exhaustion', async () => {
        fetchUserMessageHistoryPageMock
            .mockResolvedValueOnce({
                status: 'loaded',
                entries: [
                    { seq: 10, createdAt: 100, text: 'ten' },
                    { seq: 9, createdAt: 90, text: 'nine' },
                    { seq: 8, createdAt: 80, text: 'eight' },
                    { seq: 7, createdAt: 70, text: 'seven' },
                ],
                hasMore: true,
                nextBeforeSeq: 7,
            })
            .mockResolvedValueOnce({
                status: 'loaded',
                entries: [],
                hasMore: false,
                nextBeforeSeq: null,
            });

        const hook = await renderHook(() =>
            useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
        );

        await act(async () => {
            hook.getCurrent().warmup();
            await flushHookEffects();
        });

        expect(hook.getCurrent().moveUp('draft')).toBe('ten');

        await act(async () => {
            expect(hook.getCurrent().moveUp('draft')).toBe('nine');
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenLastCalledWith('s1', {
            limit: 25,
            beforeSeq: 7,
        });

        await act(async () => {
            expect(hook.getCurrent().moveUp('draft')).toBe('eight');
            expect(hook.getCurrent().moveUp('draft')).toBe('seven');
            await flushHookEffects();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });
});
