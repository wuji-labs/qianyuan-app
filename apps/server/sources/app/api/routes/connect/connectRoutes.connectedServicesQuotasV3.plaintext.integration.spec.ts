import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { ConnectedServiceQuotaSnapshotV1Schema } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { connectRoutes } from "./connectRoutes";
import { auth } from "@/app/auth/auth";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { encodeUtf8Bytes } from "./connectedServicesV3/bytesCodec";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const V3_QUOTA_URL = "/v3/connect/openai-codex/profiles/work/quotas";

function createPlainQuotaSnapshot(params: {
    fetchedAt: number;
    planLabel?: string | null;
    remaining?: number;
}) {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: "openai-codex",
        profileId: "work",
        fetchedAt: params.fetchedAt,
        staleAfterMs: 60_000,
        planLabel: params.planLabel ?? null,
        accountLabel: null,
        meters: [
            {
                meterId: "weekly",
                label: "Weekly",
                used: 100 - (params.remaining ?? 10),
                limit: 100,
                remaining: params.remaining ?? 10,
                unit: "count",
                utilizationPct: null,
                resetsAt: null,
                status: "ok",
                details: {},
            },
        ],
    });
}

function v3QuotaPayload(params: {
    fetchedAt: number;
    fingerprint?: string;
    snapshot?: unknown;
    staleAfterMs?: number;
    status?: "ok" | "unavailable" | "estimated" | "error";
}) {
    return {
        content: { t: "plain", v: params.snapshot ?? createPlainQuotaSnapshot({ fetchedAt: params.fetchedAt }) },
        metadata: {
            fetchedAt: params.fetchedAt,
            staleAfterMs: params.staleAfterMs ?? 60_000,
            status: params.status ?? "ok",
            ...(params.fingerprint ? { materialFingerprint: params.fingerprint } : {}),
        },
    };
}

async function readV3QuotaRow(userId: string) {
    return db.serviceAccountQuotaSnapshot.findUnique({
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

describe("connectRoutes (connected services quotas v3) plaintext quota endpoints (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-connected-services-quotas-v3-",
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
        vi.unstubAllGlobals();
        await db.serviceAccountQuotaSnapshot.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("stores and returns a plaintext quota envelope for plaintext accounts (server sealed at rest)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            providerId: "codex",
            activeAccountId: "acct-work",
            fetchedAt: now,
            fetchedAtMs: now,
            staleAfterMs: 60_000,
            staleAtMs: now + 60_000,
            planLabel: "plan-secret-12345",
            accountLabel: null,
            source: "in_band_provider_snapshot",
            confidence: "exact",
            evidence: {
                providerLimitId: "weekly",
                observedAtMs: now - 100,
            },
            meters: [
                {
                    meterId: "weekly",
                    label: "Weekly",
                    used: 82,
                    limit: 100,
                    usedPct: 82,
                    remaining: 18,
                    remainingPct: 18,
                    resetAtMs: now + 60_000,
                    resetSource: "provider",
                    providerLimitId: "weekly",
                    modelId: "gpt-5",
                    isExhausted: false,
                    isSoftLimited: true,
                    isCapacityLimited: false,
                    unit: "count",
                    utilizationPct: null,
                    resetsAt: null,
                    status: "ok",
                    source: "in_band_provider_snapshot",
                    scope: "weekly",
                    limitScope: "account",
                    confidence: "exact",
                    details: {
                        code: "near_limit",
                        rawScope: "account:weekly",
                    },
                },
            ],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);
        expect(register.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json()).toEqual({
            content: { t: "plain", v: expect.any(Object) },
            metadata: {
                fetchedAt: snapshot.fetchedAt,
                staleAfterMs: snapshot.staleAfterMs,
                status: "ok",
            },
        });
        expect(getOne.json().content.v).toEqual(expect.objectContaining({
            providerId: "codex",
            activeAccountId: "acct-work",
            fetchedAtMs: now,
            staleAtMs: now + 60_000,
            source: "in_band_provider_snapshot",
            confidence: "exact",
            evidence: {
                providerLimitId: "weekly",
                observedAtMs: now - 100,
            },
            meters: [
                expect.objectContaining({
                    remaining: 18,
                    remainingPct: 18,
                    usedPct: 82,
                    resetAtMs: now + 60_000,
                    resetSource: "provider",
                    providerLimitId: "weekly",
                    modelId: "gpt-5",
                    isExhausted: false,
                    isSoftLimited: true,
                    isCapacityLimited: false,
                    source: "in_band_provider_snapshot",
                    scope: "weekly",
                    limitScope: "account",
                    confidence: "exact",
                    details: expect.objectContaining({
                        code: "near_limit",
                        rawScope: "account:weekly",
                    }),
                }),
            ],
        }));

        const row = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { snapshot: true },
        });
        expect(row).not.toBeNull();
        const snapshotUtf8 = Buffer.from(row!.snapshot).toString("utf8");
        expect(snapshotUtf8.includes("plan-secret-12345")).toBe(false);
    });

    it("does not rewrite plaintext quota snapshot bytes when material fingerprint is unchanged and not newer", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const firstSnapshot = createPlainQuotaSnapshot({ fetchedAt, planLabel: "original-plan", remaining: 10 });
        const first = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({ fetchedAt, fingerprint: "hmac:v3-same", snapshot: firstSnapshot }),
        });
        expect(first.statusCode).toBe(200);
        const before = await readV3QuotaRow(user.id);

        const duplicateSnapshot = createPlainQuotaSnapshot({ fetchedAt, planLabel: "randomized-duplicate", remaining: 99 });
        const duplicate = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({ fetchedAt, fingerprint: "hmac:v3-same", snapshot: duplicateSnapshot }),
        });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json()).toEqual({ success: true });

        const after = await readV3QuotaRow(user.id);
        expect(Buffer.from(after!.snapshot).toString("utf8")).toBe(Buffer.from(before!.snapshot).toString("utf8"));
        expect(after!.fetchedAt!.getTime()).toBe(fetchedAt);
        expect(after!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-same" });
        expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("original-plan");
    });

    it("refreshes plaintext quota snapshot bytes when material fingerprint is unchanged but fetchedAt is newer", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const first = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-freshness",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "same-plan", remaining: 10 }),
            }),
        });
        expect(first.statusCode).toBe(200);

        const refreshedAt = fetchedAt + 1;
        const refreshed = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt: refreshedAt,
                fingerprint: "hmac:v3-freshness",
                snapshot: createPlainQuotaSnapshot({ fetchedAt: refreshedAt, planLabel: "same-plan", remaining: 10 }),
            }),
        });
        expect(refreshed.statusCode).toBe(200);

        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(refreshedAt);

        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json().metadata.fetchedAt).toBe(refreshedAt);
        expect(getOne.json().content.v.fetchedAt).toBe(refreshedAt);
    });

    it("writes plaintext quota snapshot bytes when material fingerprint changes and fetchedAt is newer", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-old",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "old-plan", remaining: 10 }),
            }),
        });

        const changed = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt: fetchedAt + 1,
                fingerprint: "hmac:v3-new",
                snapshot: createPlainQuotaSnapshot({ fetchedAt: fetchedAt + 1, planLabel: "new-plan", remaining: 5 }),
            }),
        });
        expect(changed.statusCode).toBe(200);

        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(fetchedAt + 1);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-new" });
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("new-plan");
    });

    it("does not let older plaintext quota snapshots overwrite newer stored material", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-newer",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "newer-plan", remaining: 10 }),
            }),
        });

        const stale = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt: fetchedAt - 1,
                fingerprint: "hmac:v3-stale",
                snapshot: createPlainQuotaSnapshot({ fetchedAt: fetchedAt - 1, planLabel: "stale-plan", remaining: 0 }),
            }),
        });
        expect(stale.statusCode).toBe(200);
        expect(stale.json()).toEqual({ success: true });

        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(fetchedAt);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-newer" });
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("newer-plan");
    });

    it("keeps legacy plaintext quota overwrite behavior when no material fingerprint is present", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "legacy-original", remaining: 10 }),
            }),
        });
        const legacy = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "legacy-overwrite", remaining: 1 }),
            }),
        });
        expect(legacy.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("legacy-overwrite");
    });

    it("does not clear plaintext quota refresh markers with a stale duplicate snapshot", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now() - 10_000;
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-refresh",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "refresh-original", remaining: 10 }),
            }),
        });
        await app.inject({
            method: "POST",
            url: `${V3_QUOTA_URL}/refresh`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        const refreshRow = await readV3QuotaRow(user.id);
        const refreshRequestedAt = readRefreshRequestedAt(refreshRow!.metadata);

        const duplicate = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-refresh",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "refresh-duplicate", remaining: 5 }),
            }),
        });
        expect(duplicate.statusCode).toBe(200);

        const row = await readV3QuotaRow(user.id);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-refresh" });
        expect(row!.metadata).toMatchObject({ refreshRequestedAt });
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("refresh-original");
    });

    it("clears plaintext quota refresh markers when a duplicate fingerprint is observed after the refresh request", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now() - 10_000;
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-refresh-fresh",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "refresh-original", remaining: 10 }),
            }),
        });
        await app.inject({
            method: "POST",
            url: `${V3_QUOTA_URL}/refresh`,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        const refreshRow = await readV3QuotaRow(user.id);
        const refreshedAt = readRefreshRequestedAt(refreshRow!.metadata) + 1;

        const duplicate = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt: refreshedAt,
                fingerprint: "hmac:v3-refresh-fresh",
                status: "estimated",
                snapshot: createPlainQuotaSnapshot({ fetchedAt: refreshedAt, planLabel: "refresh-fresh", remaining: 5 }),
            }),
        });
        expect(duplicate.statusCode).toBe(200);

        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(refreshedAt);
        expect(row!.status).toBe("estimated");
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-refresh-fresh" });
        expect(row!.metadata).not.toHaveProperty("refreshRequestedAt");
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("refresh-fresh");
    });

    it("handles concurrent plaintext duplicate and stale quota writers without stale overwrite", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-current",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "current-plan", remaining: 10 }),
            }),
        });

        const [duplicate, stale] = await Promise.all([
            app.inject({
                method: "POST",
                url: V3_QUOTA_URL,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: v3QuotaPayload({
                    fetchedAt,
                    fingerprint: "hmac:v3-current",
                    snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "duplicate-race", remaining: 9 }),
                }),
            }),
            app.inject({
                method: "POST",
                url: V3_QUOTA_URL,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: v3QuotaPayload({
                    fetchedAt: fetchedAt - 1,
                    fingerprint: "hmac:v3-stale-race",
                    snapshot: createPlainQuotaSnapshot({ fetchedAt: fetchedAt - 1, planLabel: "stale-race", remaining: 0 }),
                }),
            }),
        ]);
        expect(duplicate.statusCode).toBe(200);
        expect(stale.statusCode).toBe(200);

        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(fetchedAt);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-current" });
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("current-plan");
    });

    it("retries a changed-fingerprint plaintext write when a newer writer wins the conditional update race", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const competingFetchedAt = fetchedAt + 100;
        const newestFetchedAt = fetchedAt + 200;
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-original",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "original-plan", remaining: 10 }),
            }),
        });
        const originalRow = await readV3QuotaRow(user.id);
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
                        snapshot: encodeUtf8Bytes(JSON.stringify(createPlainQuotaSnapshot({
                            fetchedAt: competingFetchedAt,
                            planLabel: "competing-plan",
                            remaining: 5,
                        }))),
                        status: "estimated",
                        fetchedAt: new Date(competingFetchedAt),
                        staleAfterMs: 60_000,
                        metadata: { v: 3, storage: "plain_json_v1", materialFingerprint: "hmac:v3-competing" },
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
                url: V3_QUOTA_URL,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: v3QuotaPayload({
                    fetchedAt: newestFetchedAt,
                    fingerprint: "hmac:v3-newest",
                    snapshot: createPlainQuotaSnapshot({ fetchedAt: newestFetchedAt, planLabel: "newest-plan", remaining: 3 }),
                }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedCompetingWrite).toBe(true);
        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(newestFetchedAt);
        expect(row!.metadata).toMatchObject({ materialFingerprint: "hmac:v3-newest" });
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("newest-plan");
    });

    it("stores the newest plaintext write after repeated refresh metadata races", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const newestFetchedAt = fetchedAt + 200;
        const refreshRequestedAt = newestFetchedAt + 1000;
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({
                fetchedAt,
                fingerprint: "hmac:v3-original",
                snapshot: createPlainQuotaSnapshot({ fetchedAt, planLabel: "original-plan", remaining: 10 }),
            }),
        });
        const originalRow = await readV3QuotaRow(user.id);
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
                            v: 3,
                            storage: "plain_json_v1",
                            materialFingerprint: "hmac:v3-original",
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
                url: V3_QUOTA_URL,
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: v3QuotaPayload({
                    fetchedAt: newestFetchedAt,
                    fingerprint: "hmac:v3-newest",
                    snapshot: createPlainQuotaSnapshot({ fetchedAt: newestFetchedAt, planLabel: "newest-plan", remaining: 3 }),
                }),
            });
            expect(newest.statusCode).toBe(200);
        } finally {
            updateManySpy.mockRestore();
            quotaSnapshotModel.updateMany = originalUpdateMany;
        }

        expect(injectedRefreshWrites).toBe(3);
        const row = await readV3QuotaRow(user.id);
        expect(row!.fetchedAt!.getTime()).toBe(newestFetchedAt);
        expect(row!.metadata).toMatchObject({
            materialFingerprint: "hmac:v3-newest",
            refreshRequestedAt,
        });
        const getOne = await app.inject({
            method: "GET",
            url: V3_QUOTA_URL,
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.json().content.v.planLabel).toBe("newest-plan");
    });

    it("rejects top-level material fingerprints while accepting nested quota metadata fingerprints", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const fetchedAt = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const nested = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: v3QuotaPayload({ fetchedAt, fingerprint: "hmac:v3-nested" }),
        });
        expect(nested.statusCode).toBe(200);

        const topLevel = await app.inject({
            method: "POST",
            url: V3_QUOTA_URL,
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                ...v3QuotaPayload({ fetchedAt: fetchedAt + 1, fingerprint: "hmac:v3-next" }),
                materialFingerprint: "hmac:v3-top-level",
            },
        });
        expect(topLevel.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("rejects quota snapshots that include unsafe raw provider evidence", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        serviceId: "openai-codex",
                        profileId: "work",
                        fetchedAt: now,
                        staleAfterMs: 60_000,
                        planLabel: null,
                        accountLabel: null,
                        evidence: {
                            providerLimitId: "weekly",
                            observedAtMs: now,
                            rawBody: "{\"access_token\":\"secret\"}",
                            headers: { authorization: "Bearer secret" },
                        },
                        meters: [],
                    },
                },
                metadata: { fetchedAt: now, staleAfterMs: 60_000, status: "ok" },
            },
        });

        expect(register.statusCode).toBe(400);
        expect(register.json()).toEqual({ error: "invalid-params" });
        expect(await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work" } },
            select: { id: true },
        })).toBeNull();
    });

    it("rejects invalid quota profile ids using the canonical connected-service profile contract", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work%2Fbad/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });

        expect(refresh.statusCode).toBe(400);
        expect(await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: user.id, vendor: "openai-codex", profileId: "work/bad" } },
            select: { id: true },
        })).toBeNull();
    });

    it("adds refreshRequestedAt in metadata when requesting a refresh", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);
        expect(refresh.json()).toEqual({ success: true });

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.metadata.refreshRequestedAt).toEqual(expect.any(Number));
        expect(body.metadata.refreshRequestedAt).toBeGreaterThanOrEqual(snapshot.fetchedAt);
    });

    it("preserves existing quota snapshot storage metadata when recording refresh requests after at-rest policy changes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: "plan-secret-12345",
            accountLabel: null,
            meters: [],
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {
                content: { t: "plain", v: snapshot },
                metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: "ok" },
            },
        });
        expect(register.statusCode).toBe(200);

        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(200);
        const body = getOne.json() as any;
        expect(body.content.v.planLabel).toBe("plan-secret-12345");
        expect(body.metadata.refreshRequestedAt).toEqual(expect.any(Number));
    });

    it("returns not found for a server-sealed refresh placeholder before the first quota snapshot exists", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: {},
        });
        expect(refresh.statusCode).toBe(200);

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_quotas_not_found" });
    });

    it("handles concurrent first refresh requests for the same quota placeholder", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
        });

        const user = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const [first, second] = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: {},
            }),
            app.inject({
                method: "POST",
                url: "/v3/connect/openai-codex/profiles/work/quotas/refresh",
                headers: { "content-type": "application/json", "x-test-user-id": user.id },
                payload: {},
            }),
        ]);
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);

        const rows = await db.serviceAccountQuotaSnapshot.findMany({
            where: { accountId: user.id, vendor: "openai-codex", profileId: "work" },
            select: { metadata: true, snapshot: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.snapshot.byteLength).toBe(0);
        expect(rows[0]?.metadata).toMatchObject({ v: 3, storage: "server_sealed_json_v1" });
    });

    it("rejects plaintext quota content for e2ee accounts", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
        });

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "content-type": "application/json", "x-test-user-id": user.id },
            payload: { content: { t: "plain", v: {} }, metadata: { fetchedAt: 1, staleAfterMs: 60_000, status: "ok" } },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params" });
    });

    it("does not return v3 plaintext quota snapshots for e2ee accounts (defense-in-depth)", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: "true",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee",
        });

        const user = await db.account.create({
            data: { publicKey: "pk-v3-e2ee", encryptionMode: "e2ee" },
            select: { id: true },
        });

        const now = Date.now();
        const snapshot = {
            v: 1,
            serviceId: "openai-codex",
            profileId: "work",
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
        };

        await db.serviceAccountQuotaSnapshot.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                profileId: "work",
                snapshot: Buffer.from(JSON.stringify(snapshot), "utf8"),
                status: "ok",
                fetchedAt: new Date(now),
                staleAfterMs: 60_000,
                metadata: { v: 3, storage: "plain_json_v1" },
            },
        });

        const app = createTestApp();
        connectRoutes(app as any);
        await app.ready();

        const getOne = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/work/quotas",
            headers: { "x-test-user-id": user.id },
        });
        expect(getOne.statusCode).toBe(404);
        expect(getOne.json()).toEqual({ error: "connect_quotas_not_found" });
    });
});
