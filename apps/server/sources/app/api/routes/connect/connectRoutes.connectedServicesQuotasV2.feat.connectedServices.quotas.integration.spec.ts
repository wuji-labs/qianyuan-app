import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const V2_QUOTA_URL = "/v2/connect/openai-codex/profiles/work/quotas";

function v2QuotaPayload(params: {
    ciphertext: string;
    fetchedAt: number;
    fingerprint?: string;
    staleAfterMs?: number;
    status?: "ok" | "unavailable" | "estimated" | "error";
}) {
    return JSON.stringify({
        sealed: { format: "account_scoped_v1", ciphertext: params.ciphertext },
        metadata: {
            fetchedAt: params.fetchedAt,
            staleAfterMs: params.staleAfterMs ?? 300000,
            status: params.status ?? "ok",
            ...(params.fingerprint ? { materialFingerprint: params.fingerprint } : {}),
        },
    });
}

async function readV2QuotaRow(userId: string) {
    return (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
        where: { accountId_vendor_profileId: { accountId: userId, vendor: "openai-codex", profileId: "work" } },
        select: { id: true, snapshot: true, fetchedAt: true, metadata: true, status: true, updatedAt: true },
    });
}

function readRefreshRequestedAt(metadata: unknown): number {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("Expected quota metadata object with refreshRequestedAt");
    }
    const value = (metadata as { refreshRequestedAt?: unknown }).refreshRequestedAt;
    if (typeof value !== "number") {
        throw new Error("Expected quota metadata refreshRequestedAt");
    }
    return value;
}

function createTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return trackApp(typed);
}

describe("connectRoutes (connected services quotas v2) sealed quota snapshot endpoints (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-quotas-v2-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await (db as any).serviceAccountQuotaSnapshot?.deleteMany?.().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("does not register quota snapshot routes when HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED=0", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "0" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-disabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(res.statusCode).toBe(404);
    });

    it("stores and returns sealed quota snapshots when enabled", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-enabled" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });
        expect(put.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(200);
        const body = get.json() as any;
        expect(body.sealed?.format).toBe("account_scoped_v1");
        expect(body.sealed?.ciphertext).toBe("ciphertext-quota-snapshot");
        expect(typeof body.metadata?.fetchedAt).toBe("number");
        expect(typeof body.metadata?.staleAfterMs).toBe("number");
        expect(body.metadata?.status).toBe("ok");
    });

    it("does not rewrite sealed quota snapshot bytes when material fingerprint is unchanged and not newer", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-fingerprint-duplicate" }, select: { id: true } });
        const fetchedAt = Date.now();

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const first = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-same" }),
        });
        expect(first.statusCode).toBe(200);
        const before = await readV2QuotaRow(user.id);

        const duplicate = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-randomized-retry", fetchedAt, fingerprint: "hmac:v2-same" }),
        });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json()).toEqual({ success: true });

        const after = await readV2QuotaRow(user.id);
        expect(Buffer.from(after!.snapshot).toString("utf8")).toBe("ciphertext-original");
        expect(after!.fetchedAt.getTime()).toBe(fetchedAt);
        expect(after!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-same" });
        expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    });

    it("writes sealed quota snapshot bytes when material fingerprint changes and fetchedAt is newer", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-fingerprint-changed" }, select: { id: true } });
        const fetchedAt = Date.now();

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-old" }),
        });

        const changed = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-newer", fetchedAt: fetchedAt + 1, fingerprint: "hmac:v2-new" }),
        });
        expect(changed.statusCode).toBe(200);

        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-newer");
        expect(row!.fetchedAt.getTime()).toBe(fetchedAt + 1);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-new" });
    });

    it("does not let older sealed quota snapshots overwrite newer stored material", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-stale-write" }, select: { id: true } });
        const fetchedAt = Date.now();

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-newer", fetchedAt, fingerprint: "hmac:v2-newer" }),
        });

        const stale = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-stale", fetchedAt: fetchedAt - 1, fingerprint: "hmac:v2-stale" }),
        });
        expect(stale.statusCode).toBe(200);
        expect(stale.json()).toEqual({ success: true });

        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-newer");
        expect(row!.fetchedAt.getTime()).toBe(fetchedAt);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-newer" });
    });

    it("keeps legacy sealed quota overwrite behavior when no material fingerprint is present", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-legacy" }, select: { id: true } });
        const fetchedAt = Date.now();

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt }),
        });
        const legacy = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-legacy-overwrite", fetchedAt }),
        });
        expect(legacy.statusCode).toBe(200);

        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-legacy-overwrite");
    });

    it("does not clear sealed quota refresh markers with a stale duplicate snapshot", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-refresh-clear" }, select: { id: true } });
        const fetchedAt = Date.now() - 10_000;

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-refresh" }),
        });
        await app.inject({
            method: "POST",
            url: `${V2_QUOTA_URL}/refresh`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        const refreshRow = await readV2QuotaRow(user.id);
        const refreshRequestedAt = readRefreshRequestedAt(refreshRow!.metadata);

        const duplicate = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-randomized-refresh-response", fetchedAt, fingerprint: "hmac:v2-refresh" }),
        });
        expect(duplicate.statusCode).toBe(200);

        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-original");
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-refresh" });
        expect(row!.metadata).toMatchObject({ refreshRequestedAt });
    });

    it("clears sealed quota refresh markers when a duplicate fingerprint is observed after the refresh request", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-refresh-clear-fresh" }, select: { id: true } });
        const fetchedAt = Date.now() - 10_000;

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-refresh-fresh" }),
        });
        await app.inject({
            method: "POST",
            url: `${V2_QUOTA_URL}/refresh`,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        const refreshRow = await readV2QuotaRow(user.id);
        const refreshedAt = readRefreshRequestedAt(refreshRow!.metadata) + 1;

        const duplicate = await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({
                ciphertext: "ciphertext-fresh-refresh-response",
                fetchedAt: refreshedAt,
                fingerprint: "hmac:v2-refresh-fresh",
                status: "estimated",
            }),
        });
        expect(duplicate.statusCode).toBe(200);

        const row = await readV2QuotaRow(user.id);
        expect(row!.fetchedAt.getTime()).toBe(refreshedAt);
        expect(row!.status).toBe("estimated");
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-refresh-fresh" });
        expect(row!.metadata).not.toHaveProperty("refreshRequestedAt");
    });

    it("handles concurrent sealed duplicate and stale quota writers without stale overwrite", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-race" }, select: { id: true } });
        const fetchedAt = Date.now();

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-current", fetchedAt, fingerprint: "hmac:v2-current" }),
        });

        const [duplicate, stale] = await Promise.all([
            app.inject({
                method: "POST",
                url: V2_QUOTA_URL,
                headers: { "x-test-user-id": user.id, "content-type": "application/json" },
                payload: v2QuotaPayload({ ciphertext: "ciphertext-duplicate-race", fetchedAt, fingerprint: "hmac:v2-current" }),
            }),
            app.inject({
                method: "POST",
                url: V2_QUOTA_URL,
                headers: { "x-test-user-id": user.id, "content-type": "application/json" },
                payload: v2QuotaPayload({ ciphertext: "ciphertext-stale-race", fetchedAt: fetchedAt - 1, fingerprint: "hmac:v2-stale-race" }),
            }),
        ]);
        expect(duplicate.statusCode).toBe(200);
        expect(stale.statusCode).toBe(200);

        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-current");
        expect(row!.fetchedAt.getTime()).toBe(fetchedAt);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-current" });
    });

    it("retries a changed-fingerprint sealed write when a newer writer wins the conditional update race", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-changed-race" }, select: { id: true } });
        const fetchedAt = Date.now();
        const competingFetchedAt = fetchedAt + 100;
        const newestFetchedAt = fetchedAt + 200;

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-original" }),
        });
        const originalRow = await readV2QuotaRow(user.id);
        expect(originalRow).toBeTruthy();

        const quotaSnapshotModel = db.serviceAccountQuotaSnapshot;
        const originalUpdateMany = quotaSnapshotModel.updateMany.bind(quotaSnapshotModel);
        type QuotaSnapshotUpdateManyArgs = Parameters<typeof quotaSnapshotModel.updateMany>[0];
        type QuotaSnapshotUpdateManyResult = ReturnType<typeof quotaSnapshotModel.updateMany>;
        let injectedCompetingWrite = false;
        async function updateManyWithCompetingWrite(args: QuotaSnapshotUpdateManyArgs) {
            if (!injectedCompetingWrite && args?.where?.id === originalRow!.id && args?.where?.updatedAt) {
                injectedCompetingWrite = true;
                await quotaSnapshotModel.update({
                    where: { id: originalRow!.id },
                    data: {
                        updatedAt: new Date(originalRow!.updatedAt.getTime() + 1),
                        snapshot: new TextEncoder().encode("ciphertext-competing"),
                        status: "estimated",
                        fetchedAt: new Date(competingFetchedAt),
                        staleAfterMs: 300000,
                        metadata: { v: 1, format: "account_scoped_v1", materialFingerprint: "hmac:v2-competing" },
                    },
                });
            }
            return await originalUpdateMany(args);
        }
        const updateManySpy = vi.spyOn(quotaSnapshotModel, "updateMany").mockImplementation((args: QuotaSnapshotUpdateManyArgs): QuotaSnapshotUpdateManyResult => {
            // Vitest async mocks return native Promises while Prisma brands delegate results as PrismaPromise.
            return updateManyWithCompetingWrite(args) as unknown as QuotaSnapshotUpdateManyResult;
        });

        try {
            const newest = await app.inject({
                method: "POST",
                url: V2_QUOTA_URL,
                headers: { "x-test-user-id": user.id, "content-type": "application/json" },
                payload: v2QuotaPayload({ ciphertext: "ciphertext-newest", fetchedAt: newestFetchedAt, fingerprint: "hmac:v2-newest" }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedCompetingWrite).toBe(true);
        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-newest");
        expect(row!.fetchedAt.getTime()).toBe(newestFetchedAt);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v2-newest" });
    });

    it("stores the newest sealed write after repeated refresh metadata races", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-v2-refresh-race" }, select: { id: true } });
        const fetchedAt = Date.now();
        const newestFetchedAt = fetchedAt + 200;
        const refreshRequestedAt = newestFetchedAt + 1000;

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V2_QUOTA_URL,
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: v2QuotaPayload({ ciphertext: "ciphertext-original", fetchedAt, fingerprint: "hmac:v2-original" }),
        });
        const originalRow = await readV2QuotaRow(user.id);
        expect(originalRow).toBeTruthy();

        const quotaSnapshotModel = db.serviceAccountQuotaSnapshot;
        const originalUpdateMany = quotaSnapshotModel.updateMany.bind(quotaSnapshotModel);
        type QuotaSnapshotUpdateManyArgs = Parameters<typeof quotaSnapshotModel.updateMany>[0];
        type QuotaSnapshotUpdateManyResult = ReturnType<typeof quotaSnapshotModel.updateMany>;
        let injectedRefreshWrites = 0;
        async function updateManyWithRepeatedRefreshRace(args: QuotaSnapshotUpdateManyArgs) {
            const guardedUpdatedAt = args?.where?.updatedAt;
            if (
                injectedRefreshWrites < 3
                && args?.where?.id === originalRow!.id
                && guardedUpdatedAt instanceof Date
            ) {
                injectedRefreshWrites += 1;
                await quotaSnapshotModel.update({
                    where: { id: originalRow!.id },
                    data: {
                        updatedAt: new Date(guardedUpdatedAt.getTime() + 1),
                        metadata: {
                            v: 1,
                            format: "account_scoped_v1",
                            materialFingerprint: "hmac:v2-original",
                            refreshRequestedAt,
                        },
                    },
                });
            }
            return await originalUpdateMany(args);
        }
        const updateManySpy = vi.spyOn(quotaSnapshotModel, "updateMany").mockImplementation((args: QuotaSnapshotUpdateManyArgs): QuotaSnapshotUpdateManyResult => {
            // Vitest async mocks return native Promises while Prisma brands delegate results as PrismaPromise.
            return updateManyWithRepeatedRefreshRace(args) as unknown as QuotaSnapshotUpdateManyResult;
        });

        try {
            const newest = await app.inject({
                method: "POST",
                url: V2_QUOTA_URL,
                headers: { "x-test-user-id": user.id, "content-type": "application/json" },
                payload: v2QuotaPayload({ ciphertext: "ciphertext-newest", fetchedAt: newestFetchedAt, fingerprint: "hmac:v2-newest" }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedRefreshWrites).toBe(3);
        const row = await readV2QuotaRow(user.id);
        expect(Buffer.from(row!.snapshot).toString("utf8")).toBe("ciphertext-newest");
        expect(row!.fetchedAt.getTime()).toBe(newestFetchedAt);
        expect(row!.metadata).toMatchObject({
            materialFingerprint: "hmac:v2-newest",
            refreshRequestedAt,
        });
    });

    it("rejects invalid quota profile ids using the canonical connected-service profile contract", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-invalid-profile" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work%2Fbad/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });

        expect(put.statusCode).toBe(400);
        expect(await (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work/bad" } },
            select: { id: true },
        })).toBeNull();
    });

    it("accepts a refresh request and exposes refreshRequestedAt in metadata", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt, staleAfterMs: 300000, status: "ok" },
            }),
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        expect(refresh.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        const body = get.json() as any;
        expect(typeof body.metadata?.refreshRequestedAt).toBe("number");
        expect(body.metadata.refreshRequestedAt).toBeGreaterThan(0);
    });

    it("accepts a refresh request even when no quota snapshot exists yet", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-missing" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({}),
        });
        expect(refresh.statusCode).toBe(200);

        const row = await (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { metadata: true },
        });
        expect(row?.metadata).toBeTruthy();

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(404);
    });

    it("includes refreshRequestedAt in metadata even when it is 0", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "1" });
        const user = await db.account.create({ data: { publicKey: "pk-quota-refresh-zero" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const fetchedAt = Date.now();
        await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: "ciphertext-quota-snapshot" },
                metadata: { fetchedAt, staleAfterMs: 300000, status: "ok" },
            }),
        });

        const existing = await (db as any).serviceAccountQuotaSnapshot?.findUnique?.({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true, metadata: true },
        });
        expect(existing?.id).toBeTruthy();

        await (db as any).serviceAccountQuotaSnapshot?.update?.({
            where: { id: existing.id },
            data: { metadata: { ...(existing.metadata ?? {}), refreshRequestedAt: 0 } },
        });

        const get = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(get.statusCode).toBe(200);
        const body = get.json() as any;
        expect(body.metadata).toHaveProperty("refreshRequestedAt");
        expect(body.metadata.refreshRequestedAt).toBe(0);
    });

    it("rejects oversized ciphertext payloads", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-quota-oversize" }, select: { id: true } });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const huge = "x".repeat(400_000);
        const put = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id, "content-type": "application/json" },
            payload: JSON.stringify({
                sealed: { format: "account_scoped_v1", ciphertext: huge },
                metadata: { fetchedAt: Date.now(), staleAfterMs: 300000, status: "ok" },
            }),
        });
        expect(put.statusCode).toBe(400);
    });
});
