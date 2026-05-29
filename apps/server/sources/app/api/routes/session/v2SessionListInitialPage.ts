import type { Prisma } from "@prisma/client";

import {
    createV2SessionListPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";
import {
    getV2SessionListEffectiveActivityAt,
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    type V2SessionListRowCompat,
} from "./v2SessionListRows";

type V2SessionListInitialPageParams = Readonly<{
    userId: string;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
    pinnedSessionIds: readonly string[];
    pinnedRowsLimit?: number;
    includeAttentionRows: boolean;
    attentionRowsLimit?: number;
}>;

export const DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT = 100;
export const DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT = 100;

function readNumberField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasActivityAfter(row: V2SessionListRowCompat, timestamp: number | null): boolean {
    return timestamp !== null && getV2SessionListEffectiveActivityAt(row).getTime() > timestamp;
}

function hasUnreadReadyEvent(row: V2SessionListRowCompat): boolean {
    const latestReadyEventSeq = readNumberField(row, "latestReadyEventSeq");
    if (latestReadyEventSeq === null) return false;
    return latestReadyEventSeq > (row.lastViewedSessionSeq ?? 0);
}

function hasPrimarySessionFailure(row: V2SessionListRowCompat): boolean {
    if (parseStoredSessionLatestTurnStatus(row.latestTurnStatus) !== "failed") return false;
    const issue = parseStoredSessionRuntimeIssue(row.lastRuntimeIssue);
    if (issue?.v !== 1 || issue.scope !== "primary_session" || issue.status !== "failed") return false;
    const occurredAt = issue.occurredAt ?? readNumberField(row, "latestTurnStatusObservedAt");
    return !hasActivityAfter(row, occurredAt);
}

function isDurableAttentionRow(row: V2SessionListRowCompat): boolean {
    return row.pendingPermissionRequestCount > 0
        || row.pendingUserActionRequestCount > 0
        || hasPrimarySessionFailure(row)
        || hasUnreadReadyEvent(row);
}

function createAttentionRowsWhere(): Prisma.SessionWhereInput {
    return {
        archivedAt: null,
        AND: [{
            OR: [
                { latestTurnStatus: "failed" },
                { latestReadyEventSeq: { not: null } },
                { pendingPermissionRequestCount: { gt: 0 } },
                { pendingUserActionRequestCount: { gt: 0 } },
            ],
        }],
    };
}

function mergeInitialRows(params: Readonly<{
    pinnedSessionIds: readonly string[];
    pinnedRows: ReadonlyArray<V2SessionListRowCompat>;
    attentionRows: ReadonlyArray<V2SessionListRowCompat>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
}>): V2SessionListRowCompat[] {
    const pinnedRowsById = new Map(params.pinnedRows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const rows: V2SessionListRowCompat[] = [];
    const appendRow = (row: V2SessionListRowCompat | undefined): void => {
        if (!row || seen.has(row.id)) return;
        seen.add(row.id);
        rows.push(row);
    };

    for (const sessionId of params.pinnedSessionIds) {
        appendRow(pinnedRowsById.get(sessionId));
    }
    for (const row of params.attentionRows) {
        if (isDurableAttentionRow(row)) appendRow(row);
    }
    for (const row of params.pageRows) {
        appendRow(row);
    }
    return rows;
}

export async function createV2SessionListInitialPage(params: V2SessionListInitialPageParams) {
    const attentionRowsLimit = params.attentionRowsLimit ?? DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT;
    const pinnedRowsLimit = params.pinnedRowsLimit ?? DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT;
    const pinnedSessionIds = params.pinnedSessionIds.slice(0, pinnedRowsLimit);
    const [pinnedRows, attentionRows] = await Promise.all([
        pinnedSessionIds.length > 0
            ? findV2SessionListRows({
                userId: params.userId,
                where: { archivedAt: null, id: { in: [...pinnedSessionIds] } },
                orderBy: { id: "desc" },
                take: pinnedSessionIds.length,
            })
            : Promise.resolve([]),
        params.includeAttentionRows
            ? findV2SessionListRows({
                userId: params.userId,
                where: createAttentionRowsWhere(),
                orderBy: V2_SESSION_LIST_ORDER_BY,
                take: attentionRowsLimit,
            })
            : Promise.resolve([]),
    ]);
    const page = createV2SessionListPage({
        rows: params.pageRows,
        userId: params.userId,
        limit: params.limit,
    });
    const pageRows = params.pageRows.slice(0, params.limit);
    const mergedRows = mergeInitialRows({
        pinnedSessionIds,
        pinnedRows,
        attentionRows,
        pageRows,
    });

    return {
        ...page,
        sessions: mapV2SessionListRows({ rows: mergedRows, userId: params.userId }),
    };
}
