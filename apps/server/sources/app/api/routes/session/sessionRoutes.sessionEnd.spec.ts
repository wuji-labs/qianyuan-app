import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitEphemeral,
    emitUpdate,
    applySessionTurnMutationInTx,
    getSessionParticipantUserIds,
    markAccountChanged,
    markSessionInactive,
    resetSessionRouteMocks,
    txSessionFindUnique,
    txSessionTurnFindFirst,
    txSessionTurnMutationReceiptCreate,
    txSessionTurnUpdate,
    txSessionUpdate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes session end", () => {
    let dateNowMock: ReturnType<typeof vi.spyOn> | null = null;

    function mockServerNow(now: number): void {
        dateNowMock?.mockRestore();
        dateNowMock = vi.spyOn(Date, "now").mockReturnValue(now);
    }

    beforeEach(() => {
        resetSessionRouteMocks();
    });

    afterEach(() => {
        dateNowMock?.mockRestore();
        dateNowMock = null;
    });

    it("marks an owned session inactive through the HTTP fallback route", async () => {
        mockServerNow(1_000);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        getSessionParticipantUserIds.mockResolvedValueOnce(["u1", "u2"]);
        markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);
        txSessionUpdate.mockResolvedValue({});

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(markSessionInactive).toHaveBeenCalledWith("s1", "u1", 1_000);
        expect(txSessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000),
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 101, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 102, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(buildSessionActivityEphemeral).toHaveBeenCalledWith("s1", false, 1_000, false);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            recipientFilter: { type: "user-scoped-only" },
        }));
        expect(res).toEqual({ success: true, applied: true });
    });

    it("terminalizes the active turn through the shared session-turn mutation path when a session ends", async () => {
        mockServerNow(1_000);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            latestTurnId: "turn-1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(500),
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        txSessionTurnFindFirst.mockResolvedValue({
            turnId: "turn-1",
            status: "in_progress",
        });
        txSessionUpdate.mockResolvedValue({});
        txSessionTurnUpdate.mockResolvedValue({});
        getSessionParticipantUserIds.mockResolvedValueOnce(["u1", "u2"]);
        markAccountChanged.mockResolvedValueOnce(201).mockResolvedValueOnce(202);
        applySessionTurnMutationInTx.mockResolvedValue({
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "session-end:s1:1000",
                turnId: "turn-1",
                action: "end_session",
                decision: "applied",
                observedAt: 1_000,
                appliedAt: 1_000,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
            participantCursors: [],
            badgeAttentionChanged: true,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(applySessionTurnMutationInTx).toHaveBeenCalledWith({
            tx: expect.anything(),
            sessionId: "s1",
            mutation: expect.objectContaining({
                v: 1,
                sessionId: "s1",
                mutationId: "session-end:s1:1000",
                action: "end_session",
                observedAt: 1_000,
            }),
            session: expect.objectContaining({
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
            }),
            markParticipants: false,
        });
        expect(txSessionTurnFindFirst).not.toHaveBeenCalled();
        expect(txSessionTurnUpdate).not.toHaveBeenCalled();
        expect(txSessionTurnMutationReceiptCreate).not.toHaveBeenCalled();
        expect(txSessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000),
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(res).toEqual({ success: true, applied: true });
    });

    it("clamps future session-end timestamps to the server clock", async () => {
        mockServerNow(1_000);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        txSessionUpdate.mockResolvedValue({});

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 2_000 },
        });

        expect(markSessionInactive).toHaveBeenCalledWith("s1", "u1", 1_000);
        expect(txSessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000),
            },
        });
        expect(res).toEqual({ success: true, applied: true });
    });

    it("marks active sessions inactive for stale persisted session-end timestamps", async () => {
        mockServerNow(1_000 * 60 * 20);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        txSessionUpdate.mockResolvedValue({});

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(txSessionFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", accountId: "u1" },
        }));
        expect(markSessionInactive).toHaveBeenCalledWith("s1", "u1", 1_000 * 60 * 20);
        expect(txSessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000 * 60 * 20),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000 * 60 * 20),
            },
        });
        expect(res).toEqual({ success: true, applied: true });
    });

    it("ignores stale session-end timestamps when newer session activity already exists", async () => {
        mockServerNow(1_000 * 60 * 20);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-new",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(5_000),
            meaningfulActivityAt: new Date(5_000),
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(applySessionTurnMutationInTx).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, applied: false });
    });

    it("acknowledges already inactive session-end retries as unapplied without duplicate writes", async () => {
        mockServerNow(1_000 * 60 * 20);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: false,
            archivedAt: null,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, applied: false });
    });

    it("terminalizes an in-progress turn even when the session is already inactive", async () => {
        mockServerNow(1_000);
        txSessionFindUnique.mockResolvedValue({
            id: "s1",
            latestTurnId: "turn-1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(500),
            lastRuntimeIssue: null,
            active: false,
            archivedAt: null,
        });
        getSessionParticipantUserIds.mockResolvedValueOnce(["u1", "u2"]);
        markAccountChanged.mockResolvedValueOnce(301).mockResolvedValueOnce(302);
        applySessionTurnMutationInTx.mockResolvedValue({
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s1",
                mutationId: "session-end:s1:1000",
                turnId: "turn-1",
                action: "end_session",
                decision: "applied",
                observedAt: 1_000,
                appliedAt: 1_000,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
            participantCursors: [],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(applySessionTurnMutationInTx).toHaveBeenCalledWith({
            tx: expect.anything(),
            sessionId: "s1",
            mutation: expect.objectContaining({
                v: 1,
                sessionId: "s1",
                mutationId: "session-end:s1:1000",
                action: "end_session",
                observedAt: 1_000,
            }),
            session: expect.objectContaining({
                active: false,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
            }),
            markParticipants: false,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 301, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 302, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(res).toEqual({ success: true, applied: true });
    });

    it("returns not found when the session is not owned by the actor", async () => {
        txSessionFindUnique.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 123 },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
        expect(txSessionUpdate).not.toHaveBeenCalled();
    });
});
