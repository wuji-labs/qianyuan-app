import type {
    SessionWorkStateItem,
    SessionWorkStateKind,
    SessionWorkStateOrigin,
    SessionWorkStateSnapshot,
    SessionWorkStateStatus,
} from './sessionWorkStateTypes';

const VALID_KINDS: ReadonlySet<string> = new Set(['goal', 'task', 'todo']);
const VALID_ORIGINS: ReadonlySet<string> = new Set(['vendor', 'happier', 'derived']);
const VALID_STATUSES: ReadonlySet<string> = new Set([
    'pending',
    'active',
    'paused',
    'blocked',
    'complete',
    'cancelled',
    'unknown',
]);

type WorkStateBadgeTranslationKey =
    | 'session.workState.badge.goal'
    | 'session.workState.badge.goalPaused'
    | 'session.workState.badge.goalBlocked'
    | 'session.workState.badge.goalComplete'
    | 'session.workState.badge.item';

type Translate = (key: WorkStateBadgeTranslationKey, params?: { title: string }) => string;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readItem(value: unknown): SessionWorkStateItem | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const id = readString(raw.id);
    const title = readString(raw.title);
    const updatedAt = readNumber(raw.updatedAt);
    const kind = readString(raw.kind);
    const origin = readString(raw.origin);
    const status = readString(raw.status);
    if (!id || !title || updatedAt === null || !kind || !origin || !status) return null;
    if (!VALID_KINDS.has(kind) || !VALID_ORIGINS.has(origin) || !VALID_STATUSES.has(status)) return null;

    return {
        id,
        kind: kind as SessionWorkStateKind,
        origin: origin as SessionWorkStateOrigin,
        status: status as SessionWorkStateStatus,
        title,
        updatedAt,
        ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
        ...(typeof raw.backendId === 'string' ? { backendId: raw.backendId } : {}),
        ...(typeof raw.agentId === 'string' ? { agentId: raw.agentId } : {}),
        ...(typeof raw.vendorRef === 'string' ? { vendorRef: raw.vendorRef } : {}),
        ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}),
        ...(typeof raw.priority === 'string' ? { priority: raw.priority } : {}),
        ...(typeof raw.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget) ? { tokenBudget: raw.tokenBudget } : {}),
        ...(raw.tokenBudget === null ? { tokenBudget: null } : {}),
        ...(typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed) ? { tokensUsed: raw.tokensUsed } : {}),
        ...(typeof raw.timeUsedSeconds === 'number' && Number.isFinite(raw.timeUsedSeconds) ? { timeUsedSeconds: raw.timeUsedSeconds } : {}),
    };
}

function readCanonicalSnapshot(value: unknown): SessionWorkStateSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (raw.v !== 1) return null;
    const backendId = readString(raw.backendId);
    const updatedAt = readNumber(raw.updatedAt);
    if (!backendId || updatedAt === null || !Array.isArray(raw.items)) return null;
    const items = raw.items.map(readItem);
    if (items.some((item) => item === null)) return null;

    return {
        v: 1,
        backendId,
        updatedAt,
        items: items as SessionWorkStateItem[],
        ...(typeof raw.agentId === 'string' ? { agentId: raw.agentId } : {}),
        ...(typeof raw.primaryItemId === 'string' || raw.primaryItemId === null ? { primaryItemId: raw.primaryItemId } : {}),
    };
}

function readLegacyGoalSnapshot(metadata: Record<string, unknown>): SessionWorkStateSnapshot | null {
    const rawGoal = metadata.sessionGoalV1 ?? metadata.codexGoalV1;
    if (!rawGoal || typeof rawGoal !== 'object' || Array.isArray(rawGoal)) return null;
    const raw = rawGoal as Record<string, unknown>;
    const title = readString(raw.objective) ?? readString(raw.title);
    if (!title) return null;
    const rawStatus = readString(raw.status);
    const status: SessionWorkStateStatus = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus as SessionWorkStateStatus : 'active';
    const updatedAt = readNumber(raw.updatedAt) ?? Date.now();
    const backendId = readString(metadata.flavor) ?? 'codex';
    return {
        v: 1,
        backendId,
        updatedAt,
        primaryItemId: 'goal:legacy',
        items: [{
            id: 'goal:legacy',
            kind: 'goal',
            origin: 'vendor',
            status,
            title,
            updatedAt,
            ...(typeof raw.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget) ? { tokenBudget: raw.tokenBudget } : {}),
            ...(typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed) ? { tokensUsed: raw.tokensUsed } : {}),
            ...(typeof raw.timeUsedSeconds === 'number' && Number.isFinite(raw.timeUsedSeconds) ? { timeUsedSeconds: raw.timeUsedSeconds } : {}),
        }],
    };
}

export function readSessionWorkStateFromMetadata(metadata: unknown): SessionWorkStateSnapshot | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = metadata as Record<string, unknown>;
    return readCanonicalSnapshot(raw.sessionWorkStateV1) ?? readLegacyGoalSnapshot(raw);
}

function firstItem(snapshot: SessionWorkStateSnapshot | null, predicate: (item: SessionWorkStateItem) => boolean): SessionWorkStateItem | null {
    return snapshot?.items.find(predicate) ?? null;
}

export function resolvePrimarySessionWorkStateItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    if (!snapshot || snapshot.items.length === 0) return null;
    const primaryId = typeof snapshot.primaryItemId === 'string' ? snapshot.primaryItemId : null;
    if (primaryId) {
        const primary = snapshot.items.find((item) => item.id === primaryId);
        if (primary) return primary;
    }
    return firstItem(snapshot, (item) => item.kind === 'task' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.kind === 'todo' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.kind === 'goal' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.status === 'blocked')
        ?? firstItem(snapshot, (item) => item.status === 'paused')
        ?? firstItem(snapshot, (item) => item.status === 'pending')
        ?? snapshot.items[0] ?? null;
}

export function formatSessionWorkStateBadgeLabel(item: SessionWorkStateItem | null, translate: Translate): string | null {
    if (!item) return null;
    if (item.kind === 'goal') {
        if (item.status === 'paused') return translate('session.workState.badge.goalPaused');
        if (item.status === 'blocked') return translate('session.workState.badge.goalBlocked');
        if (item.status === 'complete') return translate('session.workState.badge.goalComplete');
        return translate('session.workState.badge.goal', { title: item.title });
    }
    return translate('session.workState.badge.item', { title: item.title });
}

export function resolveSessionWorkStateBadgeTone(item: SessionWorkStateItem | null): 'neutral' | 'active' | 'paused' | 'warning' | 'complete' {
    if (!item) return 'neutral';
    if (item.status === 'active') return 'active';
    if (item.status === 'paused') return 'paused';
    if (item.status === 'blocked') return 'warning';
    if (item.status === 'complete' || item.status === 'cancelled') return 'complete';
    return 'neutral';
}

export function groupSessionWorkStateItems(snapshot: SessionWorkStateSnapshot | null): Readonly<{
    active: readonly SessionWorkStateItem[];
    pending: readonly SessionWorkStateItem[];
    blockedPaused: readonly SessionWorkStateItem[];
    done: readonly SessionWorkStateItem[];
}> {
    const items = snapshot?.items ?? [];
    return {
        active: items.filter((item) => item.status === 'active'),
        pending: items.filter((item) => item.status === 'pending'),
        blockedPaused: items.filter((item) => item.status === 'blocked' || item.status === 'paused'),
        done: items.filter((item) => item.status === 'complete' || item.status === 'cancelled'),
    };
}
