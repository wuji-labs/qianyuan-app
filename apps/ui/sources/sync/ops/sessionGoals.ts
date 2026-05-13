import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export type SessionGoalMutationRequest = Readonly<{
    objective?: string;
    status?: 'active' | 'paused' | 'complete';
}>;

export type SessionGoalOperationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

const SESSION_GOAL_SET_METHOD = 'session.goal.set';
const SESSION_GOAL_CLEAR_METHOD = 'session.goal.clear';

function readGoalOperationResult(response: unknown): SessionGoalOperationResult {
    if (!response || typeof response !== 'object') {
        return { ok: false, error: 'Unsupported response from session RPC' };
    }
    const raw = response as Record<string, unknown>;
    if (raw.ok === true) return { ok: true };
    if (raw.ok === false && typeof raw.error === 'string') {
        return {
            ok: false,
            error: raw.error,
            ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
        };
    }
    return { ok: false, error: 'Unsupported response from session RPC' };
}

async function runSessionGoalRpc(
    sessionId: string,
    method: string,
    payload: Record<string, unknown>,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    try {
        const response = await sessionRpcWithServerScope<SessionGoalOperationResult, Record<string, unknown>>({
            sessionId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload,
        });
        return readGoalOperationResult(response);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export function sessionGoalSet(
    sessionId: string,
    request: SessionGoalMutationRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    return runSessionGoalRpc(sessionId, SESSION_GOAL_SET_METHOD, { ...request }, opts);
}

export function sessionGoalClear(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    return runSessionGoalRpc(sessionId, SESSION_GOAL_CLEAR_METHOD, {}, opts);
}
