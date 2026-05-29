import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import type { ApplySessionTurnMutationResult } from "@/app/session/sessionWriteService";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

export async function publishSessionTurnUpdate(params: {
    sessionId: string;
    actorUserId: string;
    connection?: ClientConnection;
    result: Extract<ApplySessionTurnMutationResult, { ok: true }>;
}): Promise<void> {
    if (!params.result.didApply) return;
    await Promise.all(params.result.participantCursors.map(async ({ accountId, cursor }) => {
        const payload = buildUpdateSessionUpdate(
            params.sessionId,
            cursor,
            randomKeyNaked(12),
            undefined,
            undefined,
            {
                latestTurnId: params.result.latestTurnId,
                latestTurnStatus: params.result.latestTurnStatus,
                latestTurnStatusObservedAt: params.result.latestTurnStatusObservedAt,
                lastRuntimeIssue: params.result.lastRuntimeIssue,
            },
        );
        eventRouter.emitUpdate({
            userId: accountId,
            payload,
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            skipSenderConnection: accountId === params.actorUserId ? params.connection : undefined,
        });
    }));
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: params.result.badgeAttentionChanged,
        participantCursors: params.result.participantCursors,
    });
}
