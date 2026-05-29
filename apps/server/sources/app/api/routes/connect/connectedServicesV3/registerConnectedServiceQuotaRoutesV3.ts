import { z } from "zod";
import type { Prisma } from "@prisma/client";

import type { Fastify } from "../../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";
import {
    ConnectedServiceIdSchema,
    ConnectedServiceQuotaSnapshotV1Schema,
    StoredJsonContentEnvelopeSchema,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { decryptString, encryptString } from "@/modules/encrypt";
import { decodeUtf8String, encodeUtf8Bytes } from "./bytesCodec";
import { isConnectedServiceQuotaMetadataV3, type ConnectedServiceQuotaMetadataV3 } from "./quotaMetadataV3";
import { persistQuotaSnapshotWithIdempotency } from "./quotaSnapshotIdempotency";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { ConnectedServiceProfileIdSchema } from "../connectedServicesV2/profileIdSchema";

const MAX_QUOTA_SNAPSHOT_JSON_CHARS = 200_000;

function resolveAtRestStoragePolicy(env: NodeJS.ProcessEnv): "none" | "server_sealed" {
    const encryption = readEncryptionFeatureEnv(env);
    return encryption.plainAccountCredentialsAtRest === "none" ? "none" : "server_sealed";
}

function buildAtRestKeyPath(params: { accountId: string; serviceId: string; profileId: string }): string[] {
    return ["storage", "connect_quota_snapshot", params.accountId, params.serviceId, params.profileId, "v1"];
}

function normalizeStatus(raw: unknown): "ok" | "unavailable" | "estimated" | "error" {
    return raw === "ok" || raw === "unavailable" || raw === "estimated" || raw === "error" ? raw : "ok";
}

function resolveQuotaMetadataStorage(params: {
    metadata: unknown;
    atRest: "none" | "server_sealed";
}): ConnectedServiceQuotaMetadataV3["storage"] {
    if (isConnectedServiceQuotaMetadataV3(params.metadata)) {
        return params.metadata.storage;
    }
    return params.atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1";
}

export function registerConnectedServiceQuotaRoutesV3(app: Fastify): void {
    app.post("/v3/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            body: z.object({
                content: StoredJsonContentEnvelopeSchema,
                metadata: z.object({
                    fetchedAt: z.number().int().nonnegative(),
                    staleAfterMs: z.number().int().min(1),
                    status: z.enum(["ok", "unavailable", "estimated", "error"]),
                    materialFingerprint: z.string().min(1).max(256).optional(),
                }),
            }).strict(),
            response: {
                200: z.object({ success: z.literal(true) }),
                400: z.object({ error: z.literal("invalid-params") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(400).send({ error: "invalid-params" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(400).send({ error: "invalid-params" });

        const content = request.body.content;
        if (content.t !== "plain") return reply.code(400).send({ error: "invalid-params" });

        const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(content.v);
        if (!parsed.success) return reply.code(400).send({ error: "invalid-params" });
        const snapshot = parsed.data;
        if (snapshot.serviceId !== serviceId) return reply.code(400).send({ error: "invalid-params" });
        if (snapshot.profileId !== profileId) return reply.code(400).send({ error: "invalid-params" });

        const json = JSON.stringify(snapshot);
        if (json.length > MAX_QUOTA_SNAPSHOT_JSON_CHARS) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        const atRest = resolveAtRestStoragePolicy(process.env);
        const keyPath = buildAtRestKeyPath({ accountId: userId, serviceId, profileId });
        const bytes = atRest === "server_sealed"
            ? (encryptString(keyPath, json) as Uint8Array<ArrayBuffer>)
            : encodeUtf8Bytes(json);

        const metadata: Prisma.InputJsonValue = {
            v: 3,
            storage: atRest === "server_sealed" ? "server_sealed_json_v1" : "plain_json_v1",
            ...(request.body.metadata.materialFingerprint ? { materialFingerprint: request.body.metadata.materialFingerprint } : {}),
        } satisfies ConnectedServiceQuotaMetadataV3;

        const meta = request.body.metadata;
        await persistQuotaSnapshotWithIdempotency({
            route: "v3",
            accountId: userId,
            vendor: serviceId,
            profileId,
            snapshot: bytes,
            status: meta.status,
            fetchedAtMs: meta.fetchedAt,
            staleAfterMs: meta.staleAfterMs,
            metadata,
        });

        return reply.send({ success: true });
    });

    app.get("/v3/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.read") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({
                    content: StoredJsonContentEnvelopeSchema,
                    metadata: z.object({
                        fetchedAt: z.number().int().nonnegative(),
                        staleAfterMs: z.number().int().nonnegative(),
                        status: z.enum(["ok", "unavailable", "estimated", "error"]),
                        refreshRequestedAt: z.number().int().nonnegative().optional(),
                    }),
                }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(404).send({ error: "connect_quotas_not_found" });

        const row = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { snapshot: true, fetchedAt: true, staleAfterMs: true, status: true, metadata: true },
        });
        if (!row) return reply.code(404).send({ error: "connect_quotas_not_found" });

        if (!isConnectedServiceQuotaMetadataV3(row.metadata)) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        if ((row.snapshot as Uint8Array).byteLength === 0) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        const keyPath = buildAtRestKeyPath({ accountId: userId, serviceId, profileId });
        const json = row.metadata.storage === "server_sealed_json_v1"
            ? decryptString(keyPath, row.snapshot as any)
            : decodeUtf8String(row.snapshot);
        if (!json.trim()) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(json);
        } catch {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.safeParse(parsedJson);
        if (!snapshot.success) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }
        if (snapshot.data.serviceId !== serviceId || snapshot.data.profileId !== profileId) {
            return reply.code(404).send({ error: "connect_quotas_not_found" });
        }

        const refreshRequestedAt =
            typeof row.metadata.refreshRequestedAt === "number"
                ? Math.max(0, Math.trunc(row.metadata.refreshRequestedAt))
                : undefined;

        return reply.send({
            content: { t: "plain", v: snapshot.data },
            metadata: {
                fetchedAt: row.fetchedAt ? row.fetchedAt.getTime() : Date.now(),
                staleAfterMs: typeof row.staleAfterMs === "number" ? row.staleAfterMs : 0,
                status: normalizeStatus(row.status),
                ...(refreshRequestedAt !== undefined ? { refreshRequestedAt } : {}),
            },
        });
    });

    app.post("/v3/connect/:serviceId/profiles/:profileId/quotas/refresh", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.refresh") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(404).send({ error: "connect_quotas_not_found" });

        const atRest = resolveAtRestStoragePolicy(process.env);
        const where = { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } };
        const existing = await db.serviceAccountQuotaSnapshot.findUnique({
            where,
            select: { id: true, metadata: true },
        });
        const storage = resolveQuotaMetadataStorage({ metadata: existing?.metadata, atRest });
        const nextMetadata: ConnectedServiceQuotaMetadataV3 = {
            v: 3,
            storage,
            ...(isConnectedServiceQuotaMetadataV3(existing?.metadata) && existing.metadata.materialFingerprint
                ? { materialFingerprint: existing.metadata.materialFingerprint }
                : {}),
            refreshRequestedAt: Date.now(),
        };

        if (existing) {
            await db.serviceAccountQuotaSnapshot.update({
                where: { id: existing.id },
                data: {
                    updatedAt: new Date(),
                    metadata: nextMetadata as any,
                },
            });
        } else {
            try {
                await db.serviceAccountQuotaSnapshot.create({
                    data: {
                        accountId: userId,
                        vendor: serviceId,
                        profileId,
                        snapshot: encodeUtf8Bytes(""),
                        status: null,
                        fetchedAt: null,
                        staleAfterMs: 0,
                        metadata: nextMetadata as any,
                    },
                });
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) throw error;
                const racedExisting = await db.serviceAccountQuotaSnapshot.findUnique({
                    where,
                    select: { id: true, metadata: true },
                });
                if (!racedExisting) throw error;
                await db.serviceAccountQuotaSnapshot.update({
                    where: { id: racedExisting.id },
                    data: {
                        updatedAt: new Date(),
                        metadata: {
                            ...nextMetadata,
                            storage: resolveQuotaMetadataStorage({ metadata: racedExisting.metadata, atRest }),
                            ...(isConnectedServiceQuotaMetadataV3(racedExisting.metadata) && racedExisting.metadata.materialFingerprint
                                ? { materialFingerprint: racedExisting.metadata.materialFingerprint }
                                : {}),
                        } as any,
                    },
                });
            }
        }

        return reply.send({ success: true });
    });

    app.delete("/v3/connect/:serviceId/profiles/:profileId/quotas", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "connectedServices.quotas.write") },
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                serviceId: ConnectedServiceIdSchema,
                profileId: ConnectedServiceProfileIdSchema,
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_quotas_not_found") })]),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const serviceId = request.params.serviceId satisfies ConnectedServiceId;
        const profileId = request.params.profileId;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { publicKey: true, encryptionMode: true },
        });
        if (!account) return reply.code(404).send({ error: "connect_quotas_not_found" });

        const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
        if (mode !== "plain") return reply.code(404).send({ error: "connect_quotas_not_found" });

        const existing = await db.serviceAccountQuotaSnapshot.findUnique({
            where: { accountId_vendor_profileId: { accountId: userId, vendor: serviceId, profileId } },
            select: { id: true },
        });
        if (!existing) return reply.code(404).send({ error: "connect_quotas_not_found" });

        await db.serviceAccountQuotaSnapshot.delete({ where: { id: existing.id } });
        return reply.send({ success: true });
    });
}
