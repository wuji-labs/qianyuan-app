import { getPersistenceStorage } from './persistence';
import { sessionViewportStorageKey } from './sessionLocalStateKeys';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * Durable per-session transcript viewport anchors (N2b.1, identity-first):
 * the durable unit is the anchor IDENTITY (messageId + seq + intra-item
 * offset); the raw bottom-distance (`offsetY`) survives only as degraded
 * fallback metadata for anchors that cannot be resolved at all.
 *
 * Records are keyed by sessionId under a server-account-scoped storage key,
 * so forked sessions and other accounts never inherit an anchor. Absence of
 * a record means live-tail intent (live-tail DELETES the record — this is how
 * "live-tail beats stale anchor" survives app restarts).
 */

export const MAX_PERSISTED_SESSION_VIEWPORTS = 100;

export type PersistedSessionViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type PersistedSessionViewportAnchorV1 = Readonly<{
    kind: PersistedSessionViewportAnchorKind;
    messageId: string;
    seq: number | null;
    itemId: string;
    itemOffsetPx: number;
    capturedAtMs: number;
}>;

export type PersistedSessionViewportV1 = Readonly<{
    isPinned: boolean;
    anchor: PersistedSessionViewportAnchorV1 | null;
    /** Raw distance from the bottom in px — degraded fallback metadata only. */
    offsetY: number;
    lastUpdatedAt: number;
}>;

export type PersistedSessionViewportsBySessionId = Record<string, PersistedSessionViewportV1>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isAnchorKind(value: unknown): value is PersistedSessionViewportAnchorKind {
    return value === 'message' || value === 'toolGroup' || value === 'item';
}

function sanitizeAnchor(value: unknown): PersistedSessionViewportAnchorV1 | null {
    if (!isRecord(value)) return null;
    if (!isAnchorKind(value.kind)) return null;
    // Identity-first: an anchor without a message identity is not durable.
    const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : '';
    if (!messageId) return null;
    const itemId = typeof value.itemId === 'string' ? value.itemId.trim() : '';
    if (!itemId) return null;
    const itemOffsetPx = readFiniteNumber(value.itemOffsetPx);
    if (itemOffsetPx === null) return null;
    const capturedAtMs = readFiniteNumber(value.capturedAtMs);
    if (capturedAtMs === null || capturedAtMs < 0) return null;
    // An unknown seq degrades to null without dropping the identity anchor.
    const seq = readFiniteNumber(value.seq);
    return {
        kind: value.kind,
        messageId,
        seq,
        itemId,
        itemOffsetPx,
        capturedAtMs,
    };
}

function sanitizeViewport(value: unknown): PersistedSessionViewportV1 | null {
    if (!isRecord(value)) return null;
    if (typeof value.isPinned !== 'boolean') return null;
    const offsetY = readFiniteNumber(value.offsetY);
    if (offsetY === null) return null;
    const lastUpdatedAt = readFiniteNumber(value.lastUpdatedAt);
    if (lastUpdatedAt === null) return null;
    return {
        isPinned: value.isPinned,
        anchor: sanitizeAnchor(value.anchor),
        offsetY,
        lastUpdatedAt,
    };
}

function sanitizeViewports(input: unknown): PersistedSessionViewportsBySessionId {
    if (!isRecord(input)) return {};
    const output: PersistedSessionViewportsBySessionId = {};
    for (const [sessionId, rawViewport] of Object.entries(input)) {
        if (!sessionId.trim()) continue;
        const viewport = sanitizeViewport(rawViewport);
        if (viewport) {
            output[sessionId] = viewport;
        }
    }
    return output;
}

function capByRecency(viewports: PersistedSessionViewportsBySessionId): PersistedSessionViewportsBySessionId {
    const entries = Object.entries(viewports);
    if (entries.length <= MAX_PERSISTED_SESSION_VIEWPORTS) return viewports;
    entries.sort((a, b) => b[1].lastUpdatedAt - a[1].lastUpdatedAt);
    return Object.fromEntries(entries.slice(0, MAX_PERSISTED_SESSION_VIEWPORTS));
}

function save(viewports: PersistedSessionViewportsBySessionId, scope?: ServerAccountScope | null): void {
    const key = sessionViewportStorageKey(scope);
    if (Object.keys(viewports).length === 0) {
        getPersistenceStorage().delete(key);
        return;
    }
    getPersistenceStorage().set(key, JSON.stringify(viewports));
}

export function loadPersistedSessionViewports(
    scope?: ServerAccountScope | null,
): PersistedSessionViewportsBySessionId {
    const raw = getPersistenceStorage().getString(sessionViewportStorageKey(scope));
    if (!raw) return {};
    try {
        return sanitizeViewports(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function readPersistedSessionViewport(
    sessionId: string,
    scope?: ServerAccountScope | null,
): PersistedSessionViewportV1 | null {
    if (!sessionId.trim()) return null;
    return loadPersistedSessionViewports(scope)[sessionId] ?? null;
}

export function upsertPersistedSessionViewport(
    sessionId: string,
    viewport: PersistedSessionViewportV1,
    scope?: ServerAccountScope | null,
): void {
    if (!sessionId.trim()) return;
    const sanitized = sanitizeViewport(viewport);
    if (!sanitized) return;
    const viewports = loadPersistedSessionViewports(scope);
    viewports[sessionId] = sanitized;
    save(capByRecency(viewports), scope);
}

export function deletePersistedSessionViewport(
    sessionId: string,
    scope?: ServerAccountScope | null,
): void {
    if (!sessionId.trim()) return;
    const viewports = loadPersistedSessionViewports(scope);
    if (!(sessionId in viewports)) return;
    delete viewports[sessionId];
    save(viewports, scope);
}

export function clearPersistedSessionViewports(scope?: ServerAccountScope | null): void {
    getPersistenceStorage().delete(sessionViewportStorageKey(scope));
}
