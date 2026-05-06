import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

export type ActivityBadgeState = Readonly<{
    count: number;
    showNonNumericDot: boolean;
}>;

type ActivityBadgeSessionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

type ActivityBadgeSession = Session | SessionListRenderableSession;

function canDerivePendingRequestsFromSession(session: ActivityBadgeSession): session is Session {
    return 'agentState' in session;
}

function readSessionFlag(
    session: ActivityBadgeSession,
    flag: 'hasPendingPermissionRequests' | 'hasPendingUserActionRequests' | 'hasUnreadMessages',
): boolean | null {
    const value = (session as Partial<Record<typeof flag, unknown>>)[flag];
    return typeof value === 'boolean' ? value : null;
}

function hasSessionBadgeAttention(session: ActivityBadgeSession, options?: ActivityBadgeSessionOptions): boolean {
    const isSessionActive = session.active === true;

    if (options?.showUnread !== false) {
        const renderedUnread = readSessionFlag(session, 'hasUnreadMessages');
        const hasUnread = renderedUnread !== null
            ? renderedUnread
            : computeHasUnreadActivity({
                sessionSeq: session.seq ?? 0,
                pendingActivityAt: 0,
                lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
                lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
            });
        if (hasUnread) return true;
    }

    if (isSessionActive && options?.showPendingPermissionRequests !== false) {
        const renderedPendingPermissionRequests = readSessionFlag(session, 'hasPendingPermissionRequests');
        const hasPendingPermissionRequests = renderedPendingPermissionRequests !== null
            ? renderedPendingPermissionRequests
            : canDerivePendingRequestsFromSession(session)
                ? derivePendingRequestFlagsFromSession(session).hasPendingPermissionRequests
                : false;
        if (hasPendingPermissionRequests) return true;
    }

    if (isSessionActive && options?.showPendingUserActionRequests !== false) {
        const renderedPendingUserActionRequests = readSessionFlag(session, 'hasPendingUserActionRequests');
        const hasPendingUserActionRequests = renderedPendingUserActionRequests !== null
            ? renderedPendingUserActionRequests
            : canDerivePendingRequestsFromSession(session)
                ? derivePendingRequestFlagsFromSession(session).hasPendingUserActionRequests
                : false;
        if (hasPendingUserActionRequests) return true;
    }

    if (options?.showQueuedUserInput !== false) {
        return (session.pendingCount ?? 0) > 0;
    }

    return false;
}

export function buildActivityBadgeState(params: Readonly<{
    sessions: ReadonlyArray<ActivityBadgeSession>;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityBadgeSessionOptions;
}>): ActivityBadgeState {
    let sessionAttentionCount = 0;
    for (const session of params.sessions) {
        if (hasSessionBadgeAttention(session, params.sessionOptions)) {
            sessionAttentionCount += 1;
        }
    }

    const count = Math.max(0, sessionAttentionCount + Math.max(0, Math.trunc(params.numericInboxCount)));
    return {
        count,
        showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
    };
}
