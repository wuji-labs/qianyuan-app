import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchSessionFolderAssignmentsForSessions } from '@/sync/api/session/sessionFolderAssignmentsApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function fetchAndApplySessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionIds: readonly string[];
    shouldContinue?: () => boolean;
}>): Promise<void> {
    const store = getStorage().getState();
    store.setSessionFolderAssignmentsLoading(params.serverId, true);
    try {
        const response = await fetchSessionFolderAssignmentsForSessions({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            sessionIds: params.sessionIds,
        });
        if (params.shouldContinue && !params.shouldContinue()) return;
        getStorage().getState().applySessionFolderAssignments(params.serverId, response.assignments);
    } finally {
        if (!params.shouldContinue || params.shouldContinue()) {
            getStorage().getState().setSessionFolderAssignmentsLoading(params.serverId, false);
        }
    }
}
