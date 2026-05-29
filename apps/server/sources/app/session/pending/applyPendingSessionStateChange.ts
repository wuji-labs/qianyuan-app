import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import type { SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import type { Tx } from "@/storage/inTx";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";

export async function applyPendingSessionStateChange(params: {
    tx: Tx;
    sessionId: string;
    pendingCountDelta?: -1 | 0 | 1;
    meaningfulActivityAt?: Date;
}): Promise<{ pendingCount: number; pendingVersion: number; participantCursors: SessionParticipantCursor[]; badgeAttentionChanged: boolean }> {
    const { tx, sessionId, pendingCountDelta } = params;
    const before = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
            seq: true,
            pendingCount: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    const baseData: {
        pendingVersion: { increment: 1 };
        meaningfulActivityAt?: Date;
    } = {
        pendingVersion: { increment: 1 },
    };
    if (params.meaningfulActivityAt instanceof Date && Number.isFinite(params.meaningfulActivityAt.getTime())) {
        baseData.meaningfulActivityAt = params.meaningfulActivityAt;
    }

    const session = pendingCountDelta === -1
        ? await applyPendingCountDecrement({ tx, sessionId, data: baseData })
        : await tx.session.update({
            where: { id: sessionId },
            data: {
                ...baseData,
                ...(pendingCountDelta === 1 ? { pendingCount: { increment: 1 } as const } : {}),
            },
            select: { pendingCount: true, pendingVersion: true },
        });

    const participantCursors = await markPendingStateChangedParticipants({
        tx,
        sessionId,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
    });

    return {
        pendingCount: session.pendingCount,
        pendingVersion: session.pendingVersion,
        participantCursors,
        badgeAttentionChanged: didSessionActivityBadgeContributionChange(before, {
            ...before,
            pendingCount: session.pendingCount,
        }),
    };
}

async function applyPendingCountDecrement(params: {
    tx: Tx;
    sessionId: string;
    data: {
        pendingVersion: { increment: 1 };
        meaningfulActivityAt?: Date;
    };
}): Promise<{ pendingCount: number; pendingVersion: number }> {
    const { tx, sessionId, data } = params;
    const decremented = await tx.session.updateMany({
        where: { id: sessionId, pendingCount: { gt: 0 } },
        data: { ...data, pendingCount: { decrement: 1 } },
    });

    if (decremented.count === 0) {
        await tx.session.updateMany({
            where: { id: sessionId, pendingCount: { lte: 0 } },
            data: { ...data, pendingCount: 0 },
        });
    }

    return tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { pendingCount: true, pendingVersion: true },
    });
}
