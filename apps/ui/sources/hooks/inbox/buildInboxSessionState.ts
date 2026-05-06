import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionReadState } from '@/sync/domains/session/readState/sessionReadState';
import { listPendingPermissionRequests, listPendingUserActionRequests, type PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

export type InboxSessionAttentionEntry = Readonly<{
    session: Session;
    pendingPermissions: readonly PendingPermissionRequest[];
    pendingUserActions: readonly PendingPermissionRequest[];
}>;

export type InboxUnreadSession = Session | SessionListRenderableSession;

export type InboxSessionState = Readonly<{
    unreadSessions: InboxUnreadSession[];
    sessionsNeedingAttention: InboxSessionAttentionEntry[];
}>;

type BuildInboxSessionStateInput =
    | readonly Session[]
    | Readonly<{
        sessions: readonly Session[];
        sessionRows?: readonly InboxUnreadSession[];
    }>;

function normalizeBuildInboxSessionStateInput(input: BuildInboxSessionStateInput): Readonly<{
    sessions: readonly Session[];
    sessionRows: readonly InboxUnreadSession[];
}> {
    if ('sessions' in input) {
        return {
            sessions: input.sessions,
            sessionRows: input.sessionRows && input.sessionRows.length > 0 ? input.sessionRows : input.sessions,
        };
    }
    return { sessions: input, sessionRows: input };
}

function hasUnreadSessionAttention(session: InboxUnreadSession): boolean {
    if ('hasUnreadMessages' in session && typeof session.hasUnreadMessages === 'boolean') {
        return session.hasUnreadMessages;
    }
    return deriveSessionReadState(session) === 'unread';
}

export function buildInboxSessionState(input: BuildInboxSessionStateInput): InboxSessionState {
    const { sessions, sessionRows } = normalizeBuildInboxSessionStateInput(input);
    const sessionsNeedingAttention: InboxSessionAttentionEntry[] = [];
    const attentionSessionIds = new Set<string>();

    for (const session of sessions) {
        const pendingPermissions = listPendingPermissionRequests(session);
        const pendingUserActions = listPendingUserActionRequests(session);
        if (pendingPermissions.length === 0 && pendingUserActions.length === 0) continue;

        attentionSessionIds.add(session.id);
        sessionsNeedingAttention.push({
            session,
            pendingPermissions,
            pendingUserActions,
        });
    }

    const unreadSessions: InboxUnreadSession[] = [];
    const unreadSessionIds = new Set<string>();
    for (const session of sessionRows) {
        if (attentionSessionIds.has(session.id)) continue;
        if (unreadSessionIds.has(session.id)) continue;
        if (!hasUnreadSessionAttention(session)) continue;
        unreadSessionIds.add(session.id);
        unreadSessions.push(session);
    }

    return {
        unreadSessions,
        sessionsNeedingAttention,
    };
}
