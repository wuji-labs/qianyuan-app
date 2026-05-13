import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
    storage,
} from '@/sync/domains/state/storage';
import {
    deriveActivityAttentionFlags,
    resolveActivityAttentionSessions,
} from '@/activity/attention/activityAttentionSessions';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { deriveSessionListMeaningfulActivityAt } from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';
import type { SessionPending } from '@/sync/store/domains/pending';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type {
    PetCompanionActivitySession,
    PetCompanionActivityModel,
    PetCompanionSessionSignals,
} from './petCompanionActivityTypes';

function selectCompanionSessionId(sessions: readonly PetCompanionActivitySession[]): string | null {
    return sessions.find((session) => session.active)?.id ?? sessions[0]?.id ?? null;
}

function hasMessageFailure(message: Message): boolean {
    if (message.kind !== 'tool-call') return false;
    if (message.tool.state === 'error') return true;
    return message.children.some(hasMessageFailure);
}

function normalizeMessageSubtitleText(value: string | null | undefined): string | null {
    const text = value?.replace(/\s+/g, ' ').trim() ?? '';
    return text.length > 0 ? text : null;
}

function resolveMessageSubtitle(message: Message): string | null {
    switch (message.kind) {
        case 'agent-text':
            return normalizeMessageSubtitleText(message.text);
        case 'user-text':
            return normalizeMessageSubtitleText(message.displayText ?? message.text);
        case 'tool-call':
            return (
                normalizeMessageSubtitleText(message.tool.description)
                ?? normalizeMessageSubtitleText(message.tool.name)
            );
        case 'agent-event':
            return null;
    }
}

function resolveLatestCommittedMessageSubtitle(transcript: SessionMessages | undefined): string | null {
    const messageIdsOldestFirst = transcript?.messageIdsOldestFirst ?? [];
    for (let index = messageIdsOldestFirst.length - 1; index >= 0; index -= 1) {
        const messageId = messageIdsOldestFirst[index];
        if (!messageId) continue;
        const message = transcript?.messagesById?.[messageId] ?? transcript?.messagesMap?.[messageId];
        if (!message) continue;
        const subtitle = resolveMessageSubtitle(message);
        if (subtitle) return subtitle;
    }
    return null;
}

function isHydratedSession(session: PetCompanionActivitySession): session is Session {
    return 'agentState' in session;
}

function sortSessionsByUpdatedAtDescending<T extends Readonly<{ updatedAt: number }>>(values: Record<string, T>): T[] {
    return Object.values(values).sort((a, b) => b.updatedAt - a.updatedAt);
}

function createRenderableActivitySignature(session: SessionListRenderableSession): string {
    return JSON.stringify({
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingCount: session.pendingCount ?? null,
        lastViewedSessionSeq: session.lastViewedSessionSeq ?? null,
        metadata: session.metadata
            ? {
                name: session.metadata.name ?? null,
                path: session.metadata.path,
                homeDir: session.metadata.homeDir ?? null,
                host: session.metadata.host ?? null,
                machineId: session.metadata.machineId ?? null,
                flavor: session.metadata.flavor ?? null,
                directSessionV1: session.metadata.directSessionV1 ?? null,
                readStateV1: session.metadata.readStateV1
                    ? {
                        sessionSeq: session.metadata.readStateV1.sessionSeq,
                        pendingActivityAt: session.metadata.readStateV1.pendingActivityAt,
                    }
                    : null,
                hiddenSystemSession: session.metadata.hiddenSystemSession === true,
            }
            : null,
        thinking: session.thinking,
        presence: session.presence,
        latestTurnStatus: session.latestTurnStatus ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner ?? null,
        accessLevel: session.accessLevel ?? null,
        canApprovePermissions: session.canApprovePermissions ?? null,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests ?? null,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests ?? null,
        hasUnreadMessages: session.hasUnreadMessages ?? null,
        keepVisibleWhenInactive: session.keepVisibleWhenInactive === true,
        metadataUnavailable: session.metadataUnavailable === true,
    });
}

function createPetCompanionSessionListRenderableSelector(): (
    state: ReturnType<typeof storage.getState>,
) => SessionListRenderableSession[] {
    let cachedById = new Map<string, Readonly<{
        signature: string;
        value: SessionListRenderableSession;
    }>>();
    let cachedResult: SessionListRenderableSession[] = [];
    let cachedResultSignature = '';

    return (state) => {
        const rows = sortSessionsByUpdatedAtDescending(state.sessionListRenderables ?? {});
        const nextById = new Map<string, Readonly<{
            signature: string;
            value: SessionListRenderableSession;
        }>>();
        const nextRows: SessionListRenderableSession[] = [];
        const resultSignatureParts: string[] = [];

        for (const row of rows) {
            const signature = createRenderableActivitySignature(row);
            const cached = cachedById.get(row.id);
            const value = cached?.signature === signature ? cached.value : row;
            nextById.set(row.id, { signature, value });
            nextRows.push(value);
            resultSignatureParts.push(`${row.id}:${signature}`);
        }

        const resultSignature = resultSignatureParts.join('|');
        cachedById = nextById;
        if (resultSignature === cachedResultSignature) {
            return cachedResult;
        }

        cachedResult = nextRows;
        cachedResultSignature = resultSignature;
        return cachedResult;
    };
}

function usePetCompanionSessionListRenderables(): SessionListRenderableSession[] {
    const selector = React.useMemo(() => createPetCompanionSessionListRenderableSelector(), []);
    return storage(
        useShallow(selector),
    );
}

function usePetCompanionFallbackSessions(rowSessionIds: readonly string[]): Session[] {
    return storage(
        useShallow((state) => {
            if (!state.isDataReady) return [];
            const rowSessionIdSet = new Set(rowSessionIds);
            return sortSessionsByUpdatedAtDescending(state.sessions)
                .filter((session) => !rowSessionIdSet.has(session.id));
        }),
    );
}

function resolveRenderableLastMessageSubtitle(session: SessionListRenderableSession): string | null {
    return normalizeMessageSubtitleText(session.metadata?.summaryText);
}

type PetCompanionSignalState = Readonly<{
    sessionMessages: Readonly<Record<string, SessionMessages | undefined>>;
    sessionPending: Readonly<Record<string, SessionPending | undefined>>;
}>;

function createMessageActivitySignature(message: Message): string {
    switch (message.kind) {
        case 'agent-text':
        case 'user-text':
            return `${message.kind}:${message.id}:${message.createdAt}`;
        case 'agent-event':
            return `${message.kind}:${message.id}:${message.createdAt}`;
        case 'tool-call':
            return [
                message.kind,
                message.id,
                message.createdAt,
                message.tool.id,
                message.tool.state,
                message.tool.createdAt,
                message.tool.startedAt ?? null,
                message.tool.completedAt ?? null,
                ...message.children.map(createMessageActivitySignature),
            ].join(':');
    }
}

function createTranscriptActivitySignature(transcript: SessionMessages | undefined): string {
    if (!transcript) return 'missing';
    const messageIds = transcript.messageIdsOldestFirst ?? [];
    const messages = messageIds.flatMap((messageId) => {
        const message = transcript.messagesById?.[messageId] ?? transcript.messagesMap?.[messageId];
        if (!message || message.kind !== 'tool-call') return [];
        return [createMessageActivitySignature(message)];
    });
    return JSON.stringify({
        messages,
        latestThinkingMessageId: transcript.latestThinkingMessageId ?? null,
        latestReadyEventSeq: transcript.latestReadyEventSeq ?? null,
        latestReadyEventAt: transcript.latestReadyEventAt ?? null,
        isLoaded: transcript.isLoaded === true,
    });
}

function createPetCompanionTranscriptsSelector(sessionIds: readonly string[]): (
    state: ReturnType<typeof storage.getState>,
) => Array<SessionMessages | undefined> {
    let cachedBySessionId = new Map<string, Readonly<{
        signature: string;
        value: SessionMessages | undefined;
    }>>();
    let cachedResult: Array<SessionMessages | undefined> = [];
    let cachedResultSignature = '';

    return (state) => {
        const nextBySessionId = new Map<string, Readonly<{
            signature: string;
            value: SessionMessages | undefined;
        }>>();
        const nextTranscripts: Array<SessionMessages | undefined> = [];
        const resultSignatureParts: string[] = [];

        for (const sessionId of sessionIds) {
            const transcript = state.sessionMessages?.[sessionId];
            const signature = createTranscriptActivitySignature(transcript);
            const cached = cachedBySessionId.get(sessionId);
            const value = cached?.signature === signature ? cached.value : transcript;
            nextBySessionId.set(sessionId, { signature, value });
            nextTranscripts.push(value);
            resultSignatureParts.push(`${sessionId}:${signature}`);
        }

        const resultSignature = resultSignatureParts.join('|');
        cachedBySessionId = nextBySessionId;
        if (resultSignature === cachedResultSignature) {
            return cachedResult;
        }

        cachedResult = nextTranscripts;
        cachedResultSignature = resultSignature;
        return cachedResult;
    };
}

function createPendingActivitySignature(pending: SessionPending | undefined): string {
    if (!pending) return 'missing';
    return JSON.stringify({
        messages: pending.messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            deliveryStatus: message.deliveryStatus ?? null,
            pendingDecryptFailure: message.pendingDecryptFailure?.kind ?? null,
        })),
        discarded: pending.discarded.map((message) => ({
            id: message.id,
            createdAt: message.createdAt,
            discardedAt: message.discardedAt,
            discardedReason: message.discardedReason,
        })),
        isLoaded: pending.isLoaded === true,
    });
}

function createPetCompanionPendingSelector(sessionIds: readonly string[]): (
    state: ReturnType<typeof storage.getState>,
) => Array<SessionPending | undefined> {
    let cachedBySessionId = new Map<string, Readonly<{
        signature: string;
        value: SessionPending | undefined;
    }>>();
    let cachedResult: Array<SessionPending | undefined> = [];
    let cachedResultSignature = '';

    return (state) => {
        const nextBySessionId = new Map<string, Readonly<{
            signature: string;
            value: SessionPending | undefined;
        }>>();
        const nextPendingRows: Array<SessionPending | undefined> = [];
        const resultSignatureParts: string[] = [];

        for (const sessionId of sessionIds) {
            const pending = state.sessionPending?.[sessionId];
            const signature = createPendingActivitySignature(pending);
            const cached = cachedBySessionId.get(sessionId);
            const value = cached?.signature === signature ? cached.value : pending;
            nextBySessionId.set(sessionId, { signature, value });
            nextPendingRows.push(value);
            resultSignatureParts.push(`${sessionId}:${signature}`);
        }

        const resultSignature = resultSignatureParts.join('|');
        cachedBySessionId = nextBySessionId;
        if (resultSignature === cachedResultSignature) {
            return cachedResult;
        }

        cachedResult = nextPendingRows;
        cachedResultSignature = resultSignature;
        return cachedResult;
    };
}

function usePetCompanionSignalState(sessionIds: readonly string[]): PetCompanionSignalState {
    const transcriptsSelector = React.useMemo(
        () => createPetCompanionTranscriptsSelector(sessionIds),
        [sessionIds],
    );
    const pendingSelector = React.useMemo(
        () => createPetCompanionPendingSelector(sessionIds),
        [sessionIds],
    );
    const transcripts = storage(
        useShallow(transcriptsSelector),
    );
    const pendingRows = storage(
        useShallow(pendingSelector),
    );

    return React.useMemo(() => {
        const sessionMessages: Record<string, SessionMessages | undefined> = {};
        const sessionPending: Record<string, SessionPending | undefined> = {};

        for (let index = 0; index < sessionIds.length; index += 1) {
            const sessionId = sessionIds[index];
            if (!sessionId) continue;
            sessionMessages[sessionId] = transcripts[index];
            sessionPending[sessionId] = pendingRows[index];
        }

        return { sessionMessages, sessionPending };
    }, [pendingRows, sessionIds, transcripts]);
}

function buildSessionSignalsBySessionId(
    state: PetCompanionSignalState,
    sessions: readonly PetCompanionActivitySession[],
    sessionListRenderables: readonly SessionListRenderableSession[],
): Record<string, PetCompanionSessionSignals> {
    const signalsBySessionId: Record<string, PetCompanionSessionSignals> = {};
    const sessionMessages = state.sessionMessages ?? {};
    const sessionPending = state.sessionPending ?? {};
    const renderableById = new Map(sessionListRenderables.map((session) => [session.id, session]));

    for (const session of sessions) {
        const transcript = sessionMessages[session.id];
        const pending = sessionPending[session.id];
        const renderable = renderableById.get(session.id);
        const messages = Object.values(transcript?.messagesById ?? {});
        const attentionFlags = deriveActivityAttentionFlags(session, {
            showPendingPermissionRequests: false,
            showPendingUserActionRequests: false,
            showQueuedUserInput: false,
        });
        const latestCommittedMessageId =
            transcript?.messageIdsOldestFirst?.length
                ? transcript.messageIdsOldestFirst[transcript.messageIdsOldestFirst.length - 1] ?? null
                : null;
        const latestCommittedMessageCreatedAt =
            latestCommittedMessageId != null
                ? transcript?.messagesById?.[latestCommittedMessageId]?.createdAt ?? null
                : null;

        let latestPendingMessageCreatedAt: number | null = null;
        for (const pendingMessage of pending?.messages ?? []) {
            const createdAt = pendingMessage?.createdAt;
            if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
            latestPendingMessageCreatedAt =
                latestPendingMessageCreatedAt == null ? createdAt : Math.max(latestPendingMessageCreatedAt, createdAt);
        }
        const pendingRequestFlags = isHydratedSession(session)
            ? derivePendingRequestFlagsFromSession(session, messages)
            : {
                hasPendingPermissionRequests: deriveActivityAttentionFlags(session, {
                    showUnread: false,
                    showPendingUserActionRequests: false,
                    showQueuedUserInput: false,
                }).hasPendingPermissionRequests,
                hasPendingUserActionRequests: deriveActivityAttentionFlags(session, {
                    showUnread: false,
                    showPendingPermissionRequests: false,
                    showQueuedUserInput: false,
                }).hasPendingUserActionRequests,
            };

        signalsBySessionId[session.id] = {
            hasFailure: messages.some(hasMessageFailure),
            hasPendingPermissionRequests: pendingRequestFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: pendingRequestFlags.hasPendingUserActionRequests,
            hasUnreadMessages: attentionFlags.hasUnread,
            latestThinkingActivityAtMs: transcript?.latestThinkingMessageActivityAtMs ?? null,
            latestMeaningfulActivityAtMs: deriveSessionListMeaningfulActivityAt({
                sessionCreatedAt: session.createdAt,
                latestCommittedMessageCreatedAt,
                latestThinkingActivityAt: transcript?.latestThinkingMessageActivityAtMs ?? null,
                latestPendingMessageCreatedAt,
            }),
            lastMessageSubtitle: resolveLatestCommittedMessageSubtitle(transcript)
                ?? (renderable ? resolveRenderableLastMessageSubtitle(renderable) : null)
                ?? (!isHydratedSession(session) ? resolveRenderableLastMessageSubtitle(session) : null),
            pendingMessageCount: pending?.messages?.length ?? 0,
        };
    }

    return signalsBySessionId;
}

export function usePetCompanionActivityModel(input?: Readonly<{
    dismissedTrayItemKeys?: ReadonlySet<string>;
}>): PetCompanionActivityModel {
    const sessionListRenderables = usePetCompanionSessionListRenderables();
    const rowSessionIds = React.useMemo(
        () => sessionListRenderables.map((session) => session.id),
        [sessionListRenderables],
    );
    const fallbackSessions = usePetCompanionFallbackSessions(rowSessionIds);
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const activitySessions = React.useMemo(
        () => resolveActivityAttentionSessions({
            sessions: fallbackSessions,
            sessionRows: sessionListRenderables,
        }),
        [fallbackSessions, sessionListRenderables],
    );
    const signalSessionIds = React.useMemo(
        () => activitySessions.map((session) => session.id),
        [activitySessions],
    );
    const selectedSessionId = React.useMemo(() => selectCompanionSessionId(activitySessions), [activitySessions]);
    const dismissedTrayItemKeys = input?.dismissedTrayItemKeys;
    const signalState = usePetCompanionSignalState(signalSessionIds);
    const signalsBySessionId = React.useMemo(
        () => buildSessionSignalsBySessionId(signalState, activitySessions, sessionListRenderables),
        [signalState, activitySessions, sessionListRenderables],
    );

    const model = React.useMemo(() => buildPetCompanionActivityModel({
        sessions: activitySessions,
        selectedSessionId,
        signalsBySessionId,
        dismissedTrayItemKeys,
        nowMs,
    }), [activitySessions, dismissedTrayItemKeys, nowMs, selectedSessionId, signalsBySessionId]);

    React.useEffect(() => {
        let nextExpiryAtMs: number | null = null;
        for (const item of model.trayItems) {
            if (typeof item.expiresAtMs !== 'number' || !Number.isFinite(item.expiresAtMs)) continue;
            if (item.expiresAtMs <= nowMs) continue;
            nextExpiryAtMs = nextExpiryAtMs === null ? item.expiresAtMs : Math.min(nextExpiryAtMs, item.expiresAtMs);
        }
        if (nextExpiryAtMs === null) return undefined;
        const delayMs = Math.max(1, nextExpiryAtMs - nowMs + 1);
        const timeout = setTimeout(() => {
            setNowMs(Date.now());
        }, delayMs);
        return () => clearTimeout(timeout);
    }, [model.trayItems, nowMs]);

    return model;
}
