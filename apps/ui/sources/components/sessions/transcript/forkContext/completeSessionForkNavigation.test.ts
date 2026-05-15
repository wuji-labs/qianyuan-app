import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const updateSessionDraftMock = vi.hoisted(() => vi.fn());
const storageRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (...args: unknown[]) =>
            ensureSessionVisibleForMessageRouteMock(...args),
        patchSessionMetadataWithRetry: (...args: unknown[]) => patchSessionMetadataWithRetryMock(...args),
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return {
        storage: {
            getState: () => storageRef.current.getState(),
        },
        createForkCompletionTestStore: (state: object) => createStorageStoreMock(state as never),
    };
});

describe('completeSessionForkNavigation', () => {
    beforeEach(async () => {
        ensureSessionVisibleForMessageRouteMock.mockReset();
        patchSessionMetadataWithRetryMock.mockReset();
        updateSessionDraftMock.mockReset();

        const storageModule = await import('@/sync/domains/state/storage');
        storageRef.current = (storageModule as any).createForkCompletionTestStore({
            sessions: {
                child: {
                    id: 'child',
                    metadata: {},
                },
            },
            updateSessionDraft: (...args: unknown[]) => updateSessionDraftMock(...args),
        });
    });

    it('hydrates fork metadata before navigation and preserves restored draft metadata', async () => {
        const events: string[] = [];
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async (sessionId: string) => {
            events.push(`hydrate:${sessionId}`);
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'parent' },
            };
            return true;
        });
        patchSessionMetadataWithRetryMock.mockImplementation(async (sessionId: string) => {
            events.push(`patch:${sessionId}`);
        });
        updateSessionDraftMock.mockImplementation((sessionId: string) => {
            events.push(`draft:${sessionId}`);
        });
        const navigate = vi.fn(async (sessionId: string) => {
            events.push(`navigate:${sessionId}`);
        });

        const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

        await completeSessionForkNavigation({
            childSessionId: 'child',
            parentSessionId: 'parent',
            navigate,
            restoredDraftText: 'retry this',
            sourceMessageId: 'm1',
            writeForkInitialPrompt: true,
        });

        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('child', { forceRefresh: true });
        expect(updateSessionDraftMock).toHaveBeenCalledWith('child', 'retry this');
        expect(navigate).toHaveBeenCalledWith('child');
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledWith('child', expect.any(Function));
        expect(events).toEqual(['draft:child', 'hydrate:child', 'navigate:child', 'patch:child']);
    });

    it('continues waiting when route hydration succeeds before fork metadata lands', async () => {
        ensureSessionVisibleForMessageRouteMock.mockResolvedValue(true);

        setTimeout(() => {
            storageRef.current.getState().sessions.child.metadata = {
                forkV1: { v: 1, parentSessionId: 'parent' },
            };
        }, 5);

        const { waitForForkChildHydration } = await import('./waitForForkChildHydration');

        const result = await waitForForkChildHydration({
            childSessionId: 'child',
            timeoutMs: 100,
            pollIntervalMs: 1,
        });

        expect(result).toEqual({ hydrated: true, timedOut: false });
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('child', { forceRefresh: true });
    });
});
