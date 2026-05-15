import { t } from '@/text';

import type { SessionListIndexItem } from '../sessionListIndex';
import { resolveSessionRowForIndexItem, type ResolveSessionListIndexRow } from '../sessionListIndexSessionRows';
import type { SessionListRenderableSession } from '../sessionListRenderable';
import {
    ATTENTION_PROMOTION_GROUP_KEY_V1,
    normalizeSessionListAttentionPromotionMode,
    type SessionListAttentionPromotionOptions,
    type SessionListAttentionPromotionReason,
} from './sessionListAttentionPromotion';

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

type PromotionCandidate = Readonly<{
    item: SessionIndexItem;
    key: string;
    row: SessionListRenderableSession;
    reason: SessionListAttentionPromotionReason;
    timestamp: number;
    originalIndex: number;
}>;

type SessionRunEntry = Readonly<{
    item: SessionIndexItem;
    originalIndex: number;
}>;

const REASON_PRIORITY: Readonly<Record<SessionListAttentionPromotionReason, number>> = {
    action_required: 0,
    permission_required: 1,
    failed: 2,
    ready: 3,
};

function normalizeSessionKey(serverIdRaw: unknown, sessionIdRaw: unknown): string | null {
    const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isActiveBlockerSession(session: SessionListRenderableSession): boolean {
    return session.active === true && session.presence === 'online';
}

function isWorkingSession(session: SessionListRenderableSession): boolean {
    return session.latestTurnStatus === 'in_progress'
        || session.thinking === true
        || normalizeTimestamp(session.optimisticThinkingAt, 0) > 0
        || normalizeTimestamp(session.thinkingGraceUntil, 0) > Date.now();
}

function isReadyAfterReadCursor(session: SessionListRenderableSession): boolean {
    const readySeq = normalizeSeq(session.latestReadyEventSeq);
    if (readySeq == null) return false;
    return readySeq > (normalizeSeq(session.lastViewedSessionSeq) ?? 0);
}

function isPrimarySessionFailure(session: SessionListRenderableSession): boolean {
    const issue = session.lastRuntimeIssue;
    return session.latestTurnStatus === 'failed'
        && issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed';
}

function resolvePromotionReason(session: SessionListRenderableSession): SessionListAttentionPromotionReason | null {
    if (isActiveBlockerSession(session) && session.hasPendingUserActionRequests === true) {
        return 'action_required';
    }
    if (isActiveBlockerSession(session) && session.hasPendingPermissionRequests === true) {
        return 'permission_required';
    }
    if (isWorkingSession(session)) {
        return null;
    }
    if (isPrimarySessionFailure(session)) {
        return 'failed';
    }
    if (isReadyAfterReadCursor(session)) {
        return 'ready';
    }
    return null;
}

function resolvePromotionTimestamp(
    session: SessionListRenderableSession,
    reason: SessionListAttentionPromotionReason,
): number {
    if (reason === 'failed') {
        return normalizeTimestamp(session.lastRuntimeIssue?.occurredAt, session.updatedAt);
    }
    if (reason === 'ready') {
        return normalizeTimestamp(session.latestReadyEventAt, session.updatedAt);
    }
    return normalizeTimestamp(session.updatedAt, session.createdAt);
}

function normalizeRetainedKeys(options: SessionListAttentionPromotionOptions): ReadonlySet<string> {
    const retained = options.retainSessionKeys;
    if (!retained) return new Set();
    if (retained instanceof Set) return retained;
    return new Set(retained);
}

function createAttentionSessionItem(candidate: PromotionCandidate): SessionIndexItem {
    return {
        ...candidate.item,
        pinned: false,
        groupKey: ATTENTION_PROMOTION_GROUP_KEY_V1,
        groupKind: 'attention',
        keepVisibleWhenInactive: true,
        attentionPromotionReason: candidate.reason,
        variant: 'default',
    };
}

function createWithinGroupAttentionSessionItem(candidate: PromotionCandidate): SessionIndexItem {
    return {
        ...candidate.item,
        keepVisibleWhenInactive: true,
        attentionPromotionReason: candidate.reason,
    };
}

function comparePromotionCandidates(left: PromotionCandidate, right: PromotionCandidate): number {
    const priorityDelta = REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason];
    if (priorityDelta !== 0) return priorityDelta;
    if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
    if (left.originalIndex !== right.originalIndex) return left.originalIndex - right.originalIndex;
    return left.key.localeCompare(right.key);
}

function resolvePromotionCandidate(params: Readonly<{
    item: SessionIndexItem;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    resolveSessionRow: ResolveSessionListIndexRow;
}>): PromotionCandidate | null {
    const key = normalizeSessionKey(params.item.serverId, params.item.sessionId);
    if (!key) return null;
    const row = resolveSessionRowForIndexItem(params.item, params.resolveSessionRow);
    if (!row) return null;
    const reason = resolvePromotionReason(row);
    if (!reason && !params.retainedKeys.has(key)) return null;
    if (params.item.pinned === true || params.item.groupKind === 'pinned') return null;
    if (row.archivedAt != null) return null;
    if (!reason && isWorkingSession(row)) return null;

    const resolvedReason = reason ?? 'ready';
    return {
        item: params.item,
        key,
        row,
        reason: resolvedReason,
        timestamp: resolvePromotionTimestamp(row, resolvedReason),
        originalIndex: params.originalIndex,
    };
}

export type SessionListIndexAttentionPromotionResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

export function buildSessionListIndexAttentionPromotion(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPromotionOptions | undefined;
    resolveSessionRow: ResolveSessionListIndexRow;
}>): SessionListIndexAttentionPromotionResult | null {
    if (normalizeSessionListAttentionPromotionMode(params.options?.mode) !== 'global' || !params.options || params.source.length === 0) {
        return null;
    }

    const retainedKeys = normalizeRetainedKeys(params.options);
    const promoted: PromotionCandidate[] = [];
    const promotedKeySet = new Set<string>();

    params.source.forEach((item, originalIndex) => {
        if (item.type !== 'session') return;
        const candidate = resolvePromotionCandidate({
            item,
            originalIndex,
            retainedKeys,
            resolveSessionRow: params.resolveSessionRow,
        });
        if (!candidate) return;
        promoted.push(candidate);
        promotedKeySet.add(candidate.key);
    });

    if (promoted.length === 0) {
        return null;
    }

    promoted.sort(comparePromotionCandidates);

    const remainder = params.source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionKey(item.serverId, item.sessionId);
        return !key || !promotedKeySet.has(key);
    });

    return {
        attentionItems: [{
            type: 'header',
            title: t('sessionsList.attentionSectionTitle'),
            headerKind: 'attention',
            groupKey: ATTENTION_PROMOTION_GROUP_KEY_V1,
        }, ...promoted.map(createAttentionSessionItem)],
        remainder,
        promotedCount: promoted.length,
    };
}

function reorderSessionRunWithinGroup(params: Readonly<{
    entries: ReadonlyArray<SessionRunEntry>;
    retainedKeys: ReadonlySet<string>;
    resolveSessionRow: ResolveSessionListIndexRow;
}>): Readonly<{
    items: SessionListIndexItem[];
    changed: boolean;
}> {
    const candidates = new Map<SessionIndexItem, PromotionCandidate>();
    for (const entry of params.entries) {
        const candidate = resolvePromotionCandidate({
            item: entry.item,
            originalIndex: entry.originalIndex,
            retainedKeys: params.retainedKeys,
            resolveSessionRow: params.resolveSessionRow,
        });
        if (candidate) candidates.set(entry.item, candidate);
    }

    if (candidates.size === 0) {
        return {
            items: params.entries.map((entry) => entry.item),
            changed: false,
        };
    }

    const promoted = [...candidates.values()].sort(comparePromotionCandidates);
    const remainder = params.entries
        .map((entry) => entry.item)
        .filter((item) => !candidates.has(item));
    const items = [
        ...promoted.map(createWithinGroupAttentionSessionItem),
        ...remainder,
    ];
    const original = params.entries.map((entry) => entry.item);
    const changed = items.length !== original.length || items.some((item, index) => item !== original[index]);
    return { items, changed };
}

export function applySessionListIndexAttentionPromotionWithinGroups(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPromotionOptions | undefined;
    resolveSessionRow: ResolveSessionListIndexRow;
}>): SessionListIndexItem[] {
    if (normalizeSessionListAttentionPromotionMode(params.options?.mode) !== 'withinGroups' || !params.options || params.source.length === 0) {
        return params.source as SessionListIndexItem[];
    }

    const retainedKeys = normalizeRetainedKeys(params.options);
    const out: SessionListIndexItem[] = [];
    let run: SessionRunEntry[] = [];
    let changed = false;

    const flushRun = () => {
        if (run.length === 0) return;
        const reordered = reorderSessionRunWithinGroup({
            entries: run,
            retainedKeys,
            resolveSessionRow: params.resolveSessionRow,
        });
        out.push(...reordered.items);
        changed = changed || reordered.changed;
        run = [];
    };

    params.source.forEach((item, originalIndex) => {
        if (item.type === 'session') {
            run.push({ item, originalIndex });
            return;
        }
        flushRun();
        out.push(item);
    });
    flushRun();

    return changed ? out : params.source as SessionListIndexItem[];
}
