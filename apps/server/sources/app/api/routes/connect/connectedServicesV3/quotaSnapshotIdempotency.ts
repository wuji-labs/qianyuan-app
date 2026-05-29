import type { Prisma } from "@prisma/client";

import { quotaSnapshotStaleWriteRejectedCounter } from "@/app/monitoring/metrics2";
import { db } from "@/storage/db";
import { isPrismaErrorCode } from "@/storage/prisma";

type QuotaSnapshotRouteVersion = "v2" | "v3";

type QuotaSnapshotStatus = "ok" | "unavailable" | "estimated" | "error";

type PersistQuotaSnapshotParams = Readonly<{
    route: QuotaSnapshotRouteVersion;
    accountId: string;
    vendor: string;
    profileId: string;
    snapshot: Uint8Array<ArrayBuffer>;
    status: QuotaSnapshotStatus;
    fetchedAtMs: number;
    staleAfterMs: number;
    metadata: Prisma.InputJsonValue;
}>;

type ExistingQuotaSnapshotRow = Readonly<{
    id: string;
    fetchedAt: Date | null;
    metadata: unknown;
    updatedAt: Date;
}>;

const MAX_IDEMPOTENT_WRITE_ATTEMPTS = 3;

type ConditionalWriteMode = "guardUpdatedAt" | "forceIfStillNewer";

export function readQuotaSnapshotMaterialFingerprint(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const value = (metadata as Record<string, unknown>).materialFingerprint;
    return typeof value === "string" && value.length > 0 ? value : null;
}

export function hasQuotaSnapshotRefreshRequest(metadata: unknown): boolean {
    return !!metadata
        && typeof metadata === "object"
        && !Array.isArray(metadata)
        && Object.prototype.hasOwnProperty.call(metadata, "refreshRequestedAt");
}

function readQuotaSnapshotRefreshRequestedAt(metadata: unknown): number | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const value = (metadata as Record<string, unknown>).refreshRequestedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function preserveRefreshRequestedAt(metadata: Prisma.InputJsonValue, refreshRequestedAt: number): Prisma.InputJsonValue {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return { refreshRequestedAt };
    }
    return { ...(metadata as Prisma.InputJsonObject), refreshRequestedAt };
}

function recordStaleWriteRejected(route: QuotaSnapshotRouteVersion): void {
    quotaSnapshotStaleWriteRejectedCounter.inc({ route });
}

function buildSnapshotData(params: PersistQuotaSnapshotParams) {
    return {
        updatedAt: new Date(),
        snapshot: params.snapshot,
        status: params.status,
        fetchedAt: new Date(params.fetchedAtMs),
        staleAfterMs: params.staleAfterMs,
        metadata: params.metadata,
    };
}

async function createQuotaSnapshot(params: PersistQuotaSnapshotParams): Promise<"created" | "raced"> {
    try {
        await db.serviceAccountQuotaSnapshot.create({
            data: {
                accountId: params.accountId,
                vendor: params.vendor,
                profileId: params.profileId,
                snapshot: params.snapshot,
                status: params.status,
                fetchedAt: new Date(params.fetchedAtMs),
                staleAfterMs: params.staleAfterMs,
                metadata: params.metadata,
            },
        });
        return "created";
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) return "raced";
        throw error;
    }
}

async function writeLegacyQuotaSnapshot(params: PersistQuotaSnapshotParams): Promise<void> {
    await db.serviceAccountQuotaSnapshot.upsert({
        where: { accountId_vendor_profileId: { accountId: params.accountId, vendor: params.vendor, profileId: params.profileId } },
        update: buildSnapshotData(params),
        create: {
            accountId: params.accountId,
            vendor: params.vendor,
            profileId: params.profileId,
            snapshot: params.snapshot,
            status: params.status,
            fetchedAt: new Date(params.fetchedAtMs),
            staleAfterMs: params.staleAfterMs,
            metadata: params.metadata,
        },
    });
}

async function updateNewerSnapshot(
    params: PersistQuotaSnapshotParams,
    existing: ExistingQuotaSnapshotRow,
    mode: ConditionalWriteMode,
): Promise<"updated" | "missed"> {
    const refreshRequestedAt = readQuotaSnapshotRefreshRequestedAt(existing.metadata);
    const shouldPreserveRefreshRequest = refreshRequestedAt !== null && params.fetchedAtMs < refreshRequestedAt;
    const update = await db.serviceAccountQuotaSnapshot.updateMany({
        where: {
            id: existing.id,
            ...(mode === "guardUpdatedAt" ? { updatedAt: existing.updatedAt } : {}),
            OR: [
                { fetchedAt: null },
                { fetchedAt: { lt: new Date(params.fetchedAtMs) } },
            ],
        },
        data: {
            ...buildSnapshotData(params),
            ...(shouldPreserveRefreshRequest
                ? { metadata: preserveRefreshRequestedAt(params.metadata, refreshRequestedAt) }
                : {}),
        },
    });
    return update.count > 0 ? "updated" : "missed";
}

async function updateDuplicateSnapshotMetadata(
    params: PersistQuotaSnapshotParams,
    existing: ExistingQuotaSnapshotRow,
    mode: ConditionalWriteMode,
): Promise<"updated" | "noop" | "missed"> {
    const incomingFetchedAt = new Date(params.fetchedAtMs);
    const existingFetchedAtMs = existing.fetchedAt?.getTime() ?? null;
    const refreshRequestedAt = readQuotaSnapshotRefreshRequestedAt(existing.metadata);
    const hasRefreshRequest = refreshRequestedAt !== null;
    const isNewer = existingFetchedAtMs === null || params.fetchedAtMs > existingFetchedAtMs;
    const satisfiesRefreshRequest = refreshRequestedAt === null || params.fetchedAtMs >= refreshRequestedAt;

    if (!isNewer && (!hasRefreshRequest || !satisfiesRefreshRequest)) return "noop";

    const update = await db.serviceAccountQuotaSnapshot.updateMany({
        where: {
            id: existing.id,
            ...(mode === "guardUpdatedAt" ? { updatedAt: existing.updatedAt } : {}),
            ...(existing.fetchedAt ? { fetchedAt: existing.fetchedAt } : { fetchedAt: null }),
            ...(isNewer
                ? {
                    OR: [
                        { fetchedAt: null },
                        { fetchedAt: { lt: incomingFetchedAt } },
                    ],
                }
                : {}),
        },
        data: {
            updatedAt: new Date(),
            metadata: hasRefreshRequest && !satisfiesRefreshRequest
                ? preserveRefreshRequestedAt(params.metadata, refreshRequestedAt)
                : params.metadata,
            ...(isNewer
                ? {
                    snapshot: params.snapshot,
                    status: params.status,
                    fetchedAt: incomingFetchedAt,
                    staleAfterMs: params.staleAfterMs,
                }
                : {}),
        },
    });

    return update.count > 0 ? "updated" : "missed";
}

async function findQuotaSnapshot(
    where: Readonly<{ accountId_vendor_profileId: Readonly<{ accountId: string; vendor: string; profileId: string }> }>,
): Promise<ExistingQuotaSnapshotRow | null> {
    return await db.serviceAccountQuotaSnapshot.findUnique({
        where,
        select: { id: true, fetchedAt: true, metadata: true, updatedAt: true },
    });
}

async function writeAfterContention(
    params: PersistQuotaSnapshotParams,
    where: Readonly<{ accountId_vendor_profileId: Readonly<{ accountId: string; vendor: string; profileId: string }> }>,
): Promise<"written" | "stale"> {
    const existing = await findQuotaSnapshot(where);
    if (!existing) {
        const created = await createQuotaSnapshot(params);
        return created === "created" ? "written" : "stale";
    }

    const existingFingerprint = readQuotaSnapshotMaterialFingerprint(existing.metadata);
    const result = existingFingerprint === readQuotaSnapshotMaterialFingerprint(params.metadata)
        ? await updateDuplicateSnapshotMetadata(params, existing, "forceIfStillNewer")
        : await updateNewerSnapshot(params, existing, "forceIfStillNewer");

    return result === "missed" ? "stale" : "written";
}

export async function persistQuotaSnapshotWithIdempotency(params: PersistQuotaSnapshotParams): Promise<void> {
    const incomingFingerprint = readQuotaSnapshotMaterialFingerprint(params.metadata);
    if (!incomingFingerprint) {
        await writeLegacyQuotaSnapshot(params);
        return;
    }

    const where = { accountId_vendor_profileId: { accountId: params.accountId, vendor: params.vendor, profileId: params.profileId } };

    for (let attempt = 0; attempt < MAX_IDEMPOTENT_WRITE_ATTEMPTS; attempt += 1) {
        const existing = await findQuotaSnapshot(where);

        if (!existing) {
            const created = await createQuotaSnapshot(params);
            if (created === "created") return;
            continue;
        }

        const existingFingerprint = readQuotaSnapshotMaterialFingerprint(existing.metadata);
        if (existingFingerprint === incomingFingerprint) {
            const result = await updateDuplicateSnapshotMetadata(params, existing, "guardUpdatedAt");
            if (result !== "missed") return;
            continue;
        }

        const result = await updateNewerSnapshot(params, existing, "guardUpdatedAt");
        if (result !== "missed") return;
    }

    const contentedWrite = await writeAfterContention(params, where);
    if (contentedWrite === "written") return;

    recordStaleWriteRejected(params.route);
}
