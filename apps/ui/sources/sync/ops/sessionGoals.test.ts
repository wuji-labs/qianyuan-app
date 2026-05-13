import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

describe('session goal operations', () => {
    beforeEach(() => {
        sessionRpcWithServerScopeMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
    });

    it('sets the session goal through the session-scoped RPC lane', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        const { sessionGoalSet } = await import('./sessionGoals');

        const result = await sessionGoalSet('session-1', { objective: 'ship work-state' });

        expect(result).toEqual({ ok: true });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: 'session.goal.set',
            payload: { objective: 'ship work-state' },
        });
    });

    it('clears the session goal through the session-scoped RPC lane', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true });
        const { sessionGoalClear } = await import('./sessionGoals');

        const result = await sessionGoalClear('session-1');

        expect(result).toEqual({ ok: true });
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: 'session.goal.clear',
            payload: {},
        });
    });

    it('returns a stable unsupported response for malformed RPC replies', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: 'yes' });
        const { sessionGoalSet } = await import('./sessionGoals');

        await expect(sessionGoalSet('session-1', { status: 'paused' })).resolves.toEqual({
            ok: false,
            error: 'Unsupported response from session RPC',
        });
    });
});
