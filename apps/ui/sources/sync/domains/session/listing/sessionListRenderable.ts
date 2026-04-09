import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import {
    derivePendingRequestFlagsFromAgentState,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { resolveSessionProjectGroupingKeyParts } from './sessionListProjectGroupingKeys';

export { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/pending/listPendingSessionRequests';

export interface SessionListRenderableMetadata {
    name?: string;
    summaryText?: string | null;
    path: string;
    homeDir?: string | null;
    host?: string | null;
    machineId?: string | null;
    flavor?: string | null;
    directSessionV1?: {
        v: 1;
        providerId?: string;
    } | null;
    hiddenSystemSession?: boolean;
}

export interface SessionListRenderableSession {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    archivedAt?: number | null;
    pendingVersion?: number;
    pendingCount?: number;
    metadataVersion: number;
    agentStateVersion: number;
    metadata: SessionListRenderableMetadata | null;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number;
    optimisticThinkingAt?: number | null;
    thinkingGraceUntil?: number | null;
    owner?: string;
    accessLevel?: 'view' | 'edit' | 'admin';
    canApprovePermissions?: boolean;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    keepVisibleWhenInactive?: boolean;
}

type DirectSessionRenderableMetadata = NonNullable<SessionListRenderableMetadata['directSessionV1']>;

export function buildSessionListRenderableMetadata(metadata: Metadata | null | undefined): SessionListRenderableMetadata | null {
    if (!metadata) return null;
    const directSessionV1 = (() : DirectSessionRenderableMetadata | null => {
        const candidate = metadata.directSessionV1;
        if (!candidate || typeof candidate !== 'object') return null;
        if (!('v' in candidate) || candidate.v !== 1) return null;
        return {
            v: 1,
            ...('providerId' in candidate && typeof candidate.providerId === 'string'
                ? { providerId: candidate.providerId }
                : {}),
        };
    })();
    return {
        name: typeof metadata.name === 'string' ? metadata.name : undefined,
        summaryText: typeof metadata.summary?.text === 'string' ? metadata.summary.text : null,
        path: typeof metadata.path === 'string' ? metadata.path : '',
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
        flavor: typeof metadata.flavor === 'string' ? metadata.flavor : null,
        directSessionV1,
        hiddenSystemSession: metadata.systemSessionV1?.hidden === true,
    };
}

export function buildSessionListRenderableFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionListRenderableSession {
    const pending = derivePendingRequestFlagsFromSession(session, messages);
    return {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        metadata: buildSessionListRenderableMetadata(session.metadata),
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        presence: session.presence,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner,
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
    };
}

export function preserveSessionListRenderableTransientState(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    return {
        ...next,
        keepVisibleWhenInactive: previous?.keepVisibleWhenInactive === true,
    };
}

export function didSessionListRenderableStructuralFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;

    return false;
}

export function didSessionListRenderableProjectGroupingFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    const prevParts = resolveSessionProjectGroupingKeyParts(prevMeta ?? null);
    const nextParts = resolveSessionProjectGroupingKeyParts(nextMeta ?? null);

    if (prevParts.pathKey !== nextParts.pathKey) return true;
    if (prevParts.machineGroupId !== nextParts.machineGroupId) return true;

    return false;
}
