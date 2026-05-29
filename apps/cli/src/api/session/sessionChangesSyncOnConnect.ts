import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import { fetchChanges } from '../changes';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { readLastChangesCursor, writeLastChangesCursor } from '@/persistence';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';

export function isV2ChangesSyncEnabled(flagValue: string | undefined): boolean {
    if (!flagValue) return true;
    return ['true', '1', 'yes'].includes(flagValue.toLowerCase());
}

function reportReconnectCatchUpFailure(params: { onDebug: (message: string, data?: unknown) => void }, error: unknown): void {
    params.onDebug('[API] Failed to catch up session messages after reconnect', {
        error: serializeAxiosErrorForLog(error),
    });
}

export async function runSessionChangesSyncOnConnect(params: {
    reason: 'connect' | 'reconnect';
    token: string;
    sessionId: string;
    lastObservedMessageSeq: number;
    getAccountId: () => Promise<string | null>;
    catchUpSessionMessages: (afterSeq: number) => Promise<void>;
    syncSessionSnapshotFromServer: (opts: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
    applyPendingQueueState?: (state: KnownPendingQueueState) => void;
    connectionSupervisor?: ManagedConnectionSupervisor | null;
    onDebug: (message: string, data?: unknown) => void;
}): Promise<void> {
    const accountId = await params.getAccountId();
    if (!accountId) return;

    const CHANGES_PAGE_LIMIT = 200;
    const after = await readLastChangesCursor(accountId);
    const result = await fetchChanges({ token: params.token, after, limit: CHANGES_PAGE_LIMIT });
    if (result.status === 'cursor-gone') {
        await writeLastChangesCursor(accountId, result.currentCursor);
        // If the server indicates the cursor is invalid (future cursor or pruned floor),
        // force a snapshot rebuild so we don't miss deletion signals.
        if (params.reason === 'reconnect') {
            try {
                await params.catchUpSessionMessages(params.lastObservedMessageSeq);
            } catch (error) {
                reportReconnectCatchUpFailure(params, error);
            }
        }
        void params.syncSessionSnapshotFromServer({ reason: 'connect' });
        return;
    }
    if (result.status !== 'ok') {
        if (handleRequestAuthenticationFailure({
            supervisor: params.connectionSupervisor,
            error: result.error,
            hadAuth: true,
        })) {
            return;
        }

        // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
        // On reconnect, fall back to the snapshot-based convergence path.
        if (params.reason === 'reconnect') {
            try {
                await params.catchUpSessionMessages(params.lastObservedMessageSeq);
            } catch (error) {
                reportReconnectCatchUpFailure(params, error);
            }
            void params.syncSessionSnapshotFromServer({ reason: 'connect' });
        }
        return;
    }

    const changes = result.response.changes;
    const nextCursor = result.response.nextCursor;

    let hasRelevantSessionChange = false;
    for (const change of changes) {
        const isRelevant = (change.kind === 'session' || change.kind === 'share') && change.entityId === params.sessionId;
        if (!isRelevant) continue;
        hasRelevantSessionChange = true;
        if (change.kind === 'session') {
            const pendingQueueState = readKnownPendingQueueState(change.hint);
            if (pendingQueueState) {
                params.applyPendingQueueState?.(pendingQueueState);
            }
        }
    }
    if (changes.length >= CHANGES_PAGE_LIMIT) {
        // Slow-path: too many coalesced changes. Snapshot sync gets us back to a known-good state;
        // session transcript catch-up is only needed after reconnect.
        if (params.reason === 'reconnect') {
            try {
                await params.catchUpSessionMessages(params.lastObservedMessageSeq);
            } catch (error) {
                reportReconnectCatchUpFailure(params, error);
            }
        }
        void params.syncSessionSnapshotFromServer({ reason: 'connect' });
        await writeLastChangesCursor(accountId, nextCursor);
        return;
    }

    if (hasRelevantSessionChange && params.reason === 'reconnect') {
        try {
            await params.catchUpSessionMessages(params.lastObservedMessageSeq);
        } catch (error) {
            reportReconnectCatchUpFailure(params, error);
        }
        void params.syncSessionSnapshotFromServer({ reason: 'connect' });
    }

    await writeLastChangesCursor(accountId, nextCursor);
}
