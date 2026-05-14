import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function jsonErrorResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('fetchAndApplySessionFolderAssignments', () => {
    beforeEach(async () => {
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionFolderAssignmentsForServer('server-a');
    });

    it('applies fetched assignments to the session folder store', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            assignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
        });

        expect(getStorage().getState().sessionFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
        expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(false);
    });

    it('skips already known assignments when fetching missing assignments only', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        getStorage().getState().applySessionFolderAssignments('server-a', [
            { sessionId: 's1', folderId: 'folder-a' },
        ]);
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            assignments: [{ sessionId: 's2', folderId: 'folder-b' }],
        }));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2'],
            fetchPolicy: 'missing',
        });

        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v2/session-folder-assignments?sessionIds=s2',
            expect.anything(),
            expect.anything(),
        );
        expect(getStorage().getState().sessionFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
        expect(getStorage().getState().sessionFolderAssignmentsBySessionKey['server-a:s2']).toBe('folder-b');
    });

    it('does not call the server when missing-only assignment fetches are already cached', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        getStorage().getState().applySessionFolderAssignments('server-a', [
            { sessionId: 's1', folderId: null },
        ]);

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(false);
    });

    it('does not apply stale assignments after scope changes', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            assignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            shouldContinue: () => false,
        });

        expect(getStorage().getState().sessionFolderAssignmentsBySessionKey['server-a:s1']).toBeUndefined();
    });

    it('treats a missing folder assignment route as an empty optional result', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonErrorResponse({
            error: 'Not found',
        }, 404));

        await expect(fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
        })).resolves.toBeUndefined();

        expect(getStorage().getState().sessionFolderAssignmentsBySessionKey['server-a:s1']).toBeUndefined();
        expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(false);
    });
});
