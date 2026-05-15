import { t } from '@/text';

import type { SessionListRenderableSession } from '../sessionListRenderable';
import type { SessionListViewItem } from '../sessionListViewData';
import {
    normalizeSessionListAttentionPromotionMode,
    type SessionListAttentionPromotionMode,
    type SessionListAttentionPromotionReason,
} from './sessionListAttentionPromotionTypes';

export const ATTENTION_PROMOTION_GROUP_KEY_V1 = 'attention-promotion-v1';

export type SessionListAttentionPromotionOptions = Readonly<{
    mode: SessionListAttentionPromotionMode;
    activeSessionKey?: string | null;
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
}>;

export type SessionListAttentionPromotionResult = Readonly<{
    attentionItems: SessionListViewItem[];
    remainder: SessionListViewItem[];
    promotedCount: number;
}>;

type SessionItem = Extract<SessionListViewItem, { type: 'session' }>;

type PromotionCandidate = Readonly<{
    item: SessionItem;
    key: string;
    reason: SessionListAttentionPromotionReason;
    timestamp: number;
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

function createAttentionSessionItem(candidate: PromotionCandidate): SessionItem {
    return {
        ...candidate.item,
        pinned: false,
        groupKey: ATTENTION_PROMOTION_GROUP_KEY_V1,
        groupKind: 'attention',
        attentionPromotionReason: candidate.reason,
        variant: 'default',
    };
}

function createWithinGroupAttentionSessionItem(candidate: PromotionCandidate): SessionItem {
    return {
        ...candidate.item,
        attentionPromotionReason: candidate.reason,
        session: candidate.item.session.keepVisibleWhenInactive === true
            ? candidate.item.session
            : {
                ...candidate.item.session,
                keepVisibleWhenInactive: true,
            },
    };
}

function comparePromotionCandidates(left: PromotionCandidate, right: PromotionCandidate): number {
    const priorityDelta = REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason];
    if (priorityDelta !== 0) return priorityDelta;
    if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
    if (left.originalIndex !== right.originalIndex) return left.originalIndex - right.originalIndex;
    return left.key.localeCompare(right.key);
}

function resolvePromotionCandidate(
    item: SessionItem,
    originalIndex: number,
    retainedKeys: ReadonlySet<string>,
): PromotionCandidate | null {
    const key = normalizeSessionKey(item.serverId, item.session?.id);
    if (!key) return null;
    const reason = resolvePromotionReason(item.session);
    if (!reason && !retainedKeys.has(key)) return null;
    if (item.pinned === true || item.groupKind === 'pinned') return null;
    if (item.session.archivedAt != null) return null;
    if (!reason && isWorkingSession(item.session)) return null;

    const resolvedReason = reason ?? 'ready';
    return {
        item,
        key,
        reason: resolvedReason,
        timestamp: resolvePromotionTimestamp(item.session, resolvedReason),
        originalIndex,
    };
}

export function buildSessionListAttentionPromotion(
    source: ReadonlyArray<SessionListViewItem>,
    options: SessionListAttentionPromotionOptions | undefined,
): SessionListAttentionPromotionResult | null {
    if (normalizeSessionListAttentionPromotionMode(options?.mode) !== 'global' || !options || source.length === 0) {
        return null;
    }

    const retainedKeys = normalizeRetainedKeys(options);
    const promoted: PromotionCandidate[] = [];
    const promotedKeySet = new Set<string>();

    source.forEach((item, originalIndex) => {
        if (item.type !== 'session') return;
        const candidate = resolvePromotionCandidate(item, originalIndex, retainedKeys);
        if (!candidate) return;
        promoted.push(candidate);
        promotedKeySet.add(candidate.key);
    });

    if (promoted.length === 0) {
        return null;
    }

    promoted.sort(comparePromotionCandidates);

    const remainder = source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionKey(item.serverId, item.session?.id);
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

type SessionRunEntry = Readonly<{
    item: SessionItem;
    originalIndex: number;
}>;

function reorderSessionRunWithinGroup(
    entries: ReadonlyArray<SessionRunEntry>,
    retainedKeys: ReadonlySet<string>,
): Readonly<{
    items: SessionListViewItem[];
    changed: boolean;
}> {
    const candidates = new Map<SessionItem, PromotionCandidate>();
    for (const entry of entries) {
        const candidate = resolvePromotionCandidate(entry.item, entry.originalIndex, retainedKeys);
        if (candidate) candidates.set(entry.item, candidate);
    }

    if (candidates.size === 0) {
        return {
            items: entries.map((entry) => entry.item),
            changed: false,
        };
    }

    const promoted = [...candidates.values()].sort(comparePromotionCandidates);
    const remainder = entries
        .map((entry) => entry.item)
        .filter((item) => !candidates.has(item));
    const items = [
        ...promoted.map(createWithinGroupAttentionSessionItem),
        ...remainder,
    ];
    const original = entries.map((entry) => entry.item);
    const changed = items.length !== original.length || items.some((item, index) => item !== original[index]);
    return { items, changed };
}

export function applySessionListAttentionPromotionWithinGroups(
    source: ReadonlyArray<SessionListViewItem>,
    options: SessionListAttentionPromotionOptions | undefined,
): SessionListViewItem[] {
    if (normalizeSessionListAttentionPromotionMode(options?.mode) !== 'withinGroups' || !options || source.length === 0) {
        return source as SessionListViewItem[];
    }

    const retainedKeys = normalizeRetainedKeys(options);
    const out: SessionListViewItem[] = [];
    let run: SessionRunEntry[] = [];
    let changed = false;

    const flushRun = () => {
        if (run.length === 0) return;
        const reordered = reorderSessionRunWithinGroup(run, retainedKeys);
        out.push(...reordered.items);
        changed = changed || reordered.changed;
        run = [];
    };

    source.forEach((item, originalIndex) => {
        if (item.type === 'session') {
            run.push({ item, originalIndex });
            return;
        }
        flushRun();
        out.push(item);
    });
    flushRun();

    return changed ? out : source as SessionListViewItem[];
}

export function applySessionListAttentionPromotion(
    source: ReadonlyArray<SessionListViewItem>,
    options: SessionListAttentionPromotionOptions | undefined,
): SessionListViewItem[] {
    if (normalizeSessionListAttentionPromotionMode(options?.mode) === 'withinGroups') {
        return applySessionListAttentionPromotionWithinGroups(source, options);
    }
    const result = buildSessionListAttentionPromotion(source, options);
    if (!result) return source as SessionListViewItem[];
    return [...result.attentionItems, ...result.remainder];
}

export { normalizeSessionListAttentionPromotionMode };
export type { SessionListAttentionPromotionMode, SessionListAttentionPromotionReason };
