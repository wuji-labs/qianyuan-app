import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../api/testkit/dbMocks";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionPendingMessage: ["findFirst"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const txSessionFindUniqueOrThrow = vi.fn();
const txSessionUpdate = vi.fn();
const txSessionUpdateMany = vi.fn();
const txSessionPendingMessageFindFirst = vi.fn();
const tx = {
    session: {
        findUniqueOrThrow: txSessionFindUniqueOrThrow,
        update: txSessionUpdate,
        updateMany: txSessionUpdateMany,
    },
    sessionPendingMessage: {
        findFirst: txSessionPendingMessageFindFirst,
    },
};

const inTx = vi.fn(async (run: (txArg: typeof tx) => Promise<unknown>) => {
    return await run(tx);
});
vi.mock("@/storage/inTx", () => ({
    inTx,
}));

let materializeNextPendingMessage: typeof import("./materializeNextPendingMessage").materializeNextPendingMessage;

describe("materializeNextPendingMessage (pendingCount fast path)", () => {
    beforeAll(async () => {
        ({ materializeNextPendingMessage } = await import("./materializeNextPendingMessage"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txSessionFindUniqueOrThrow.mockReset();
        txSessionUpdate.mockReset();
        txSessionUpdateMany.mockReset();
        txSessionPendingMessageFindFirst.mockReset();
        dbMocks.db.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0, pendingVersion: 5 });
        dbMocks.db.sessionPendingMessage.findFirst.mockResolvedValue(null);
    });

    it("returns didMaterialize=false without starting a transaction when pendingCount is 0", async () => {
        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(resolveSessionPendingOwnerAccess).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.session.findUnique).toHaveBeenCalledTimes(1);
        expect(dbMocks.db.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(1);
        expect(inTx).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 5 });
    });

    it("repairs stale positive pendingCount when no queued pending message exists", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 2,
            pendingVersion: 9,
        });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({
                pendingCount: 2,
                pendingVersion: 9,
            })
            .mockResolvedValueOnce({ pendingCount: 0, pendingVersion: 10 });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionUpdateMany.mockResolvedValue({ count: 1 });

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(inTx).toHaveBeenCalledTimes(1);
        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 2, pendingVersion: 9 },
            data: { pendingCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 10 });
    });

    it("does not hide a concurrent pending enqueue when stale positive repair loses the version race", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 2,
            pendingVersion: 9,
        });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({
                pendingCount: 2,
                pendingVersion: 9,
            })
            .mockResolvedValueOnce({ pendingCount: 3, pendingVersion: 10 });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);
        txSessionUpdateMany.mockResolvedValue({ count: 0 });

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(txSessionUpdateMany).toHaveBeenCalledWith({
            where: { id: "s1", pendingCount: 2, pendingVersion: 9 },
            data: { pendingCount: 0, pendingVersion: { increment: 1 } },
        });
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 3, pendingVersion: 10 });
    });

    it("retries a benign unique-message materialization race as an idempotent no-op", async () => {
        dbMocks.db.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 1,
            pendingVersion: 9,
        });
        inTx
            .mockRejectedValueOnce({ code: "P2002" })
            .mockImplementationOnce(async (run: (txArg: typeof tx) => Promise<unknown>) => await run(tx));
        txSessionFindUniqueOrThrow.mockResolvedValue({
            pendingCount: 0,
            pendingVersion: 10,
        });
        txSessionPendingMessageFindFirst.mockResolvedValue(null);

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(inTx).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 10 });
    });
});
