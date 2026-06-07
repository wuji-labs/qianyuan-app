import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    message?: PendingQueueMaterializedMessage | null;
    pendingQueueState?: KnownPendingQueueState;
};

type PendingQueueWriteBody = Readonly<
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole }
>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; pendingQueueState?: KnownPendingQueueState }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState }
    | { ok: false };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; pendingQueueState?: KnownPendingQueueState }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState };

type PendingMaterializeAckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

type PendingMaterializePayload = Readonly<{ sid: string; pendingVersion?: number }>;

function readPendingMaterializePayload(payload: unknown): PendingMaterializePayload {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid pending queue materialize payload');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sid !== 'string') {
        throw new Error('Invalid pending queue materialize session id');
    }
    const pendingVersion = record.pendingVersion;
    return {
        sid: record.sid,
        ...(typeof pendingVersion === 'number' && Number.isSafeInteger(pendingVersion) && pendingVersion >= 0
            ? { pendingVersion }
            : {}),
    };
}

function createPendingMaterializeAckSocket(socket: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== 'pending-materialize-next') {
                throw new Error(`Unexpected pending queue socket ACK event: ${event}`);
            }
            return await target.emitWithAck('pending-materialize-next', readPendingMaterializePayload(payload));
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function parseMaterializedMessageTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
}

function parseMaterializedMessage(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : null;
    const seq = typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
        ? record.seq
        : null;
    if (seq === null) return null;
    const localId = typeof record.localId === 'string' && record.localId.length > 0
        ? record.localId
        : null;
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
    };
}

function readMaterializedMessageFromAck(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    return parseMaterializedMessage(record.message) ?? parseMaterializedMessage(record);
}

function readMaterializedLocalIdFromAck(value: unknown, message: PendingQueueMaterializedMessage | null): string | null {
    if (message?.localId) return message.localId;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.localId === 'string' && record.localId.length > 0) return record.localId;
    const nested = record.message;
    if (!nested || typeof nested !== 'object') return null;
    const nestedLocalId = (nested as Record<string, unknown>).localId;
    return typeof nestedLocalId === 'string' && nestedLocalId.length > 0 ? nestedLocalId : null;
}

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
        const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}/pending`, {
            headers: { Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        return pending
            .map((row: unknown) => {
                if (!row || typeof row !== 'object') return null;
                const localId = (row as Record<string, unknown>).localId;
                return typeof localId === 'string' ? localId : null;
            })
            .filter((value: string | null): value is string => typeof value === 'string' && value.length > 0);
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function discardPendingQueueV2Messages(params: {
    token: string;
    sessionId: string;
    localIds: string[];
    reason: 'switch_to_local' | 'manual';
}): Promise<number> {
    let discarded = 0;
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    for (const localId of params.localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: { Authorization: `Bearer ${params.token}` }, timeout: 10_000 },
            );
            discarded += 1;
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            throw error;
        }
    }
    return discarded;
}

export async function enqueuePendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    body: PendingQueueWriteBody;
}): Promise<void> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        params.body,
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    knownPendingVersion?: number;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.knownPendingVersion === 'number' ? { pendingVersion: params.knownPendingVersion } : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object') return { ok: false };
        if (rawAck.ok !== true) return { ok: false };
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) {
            return { ok: true, didMaterialize: false, ...(pendingQueueState ? { pendingQueueState } : {}) };
        }
        const message = readMaterializedMessageFromAck(rawAck);
        const localId = readMaterializedLocalIdFromAck(rawAck, message);
        const didWrite = rawAck.didWrite === true;
        return { ok: true, didMaterialize: true, localId, didWrite, message, ...(pendingQueueState ? { pendingQueueState } : {}) };
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        return { ok: false };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        {},
        {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending queue materialize response');
    }
    if (data.ok !== true) {
        throw new Error(`Pending queue materialize failed: ${typeof data.error === 'string' ? data.error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    if (data.didMaterialize !== true) {
        return { ok: true, didMaterialize: false, ...(pendingQueueState ? { pendingQueueState } : {}) };
    }
    const message = readMaterializedMessageFromAck(data);
    const localId = readMaterializedLocalIdFromAck(data, message);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    return {
        ok: true,
        didMaterialize: true,
        localId,
        didWrite,
        message,
        ...(pendingQueueState ? { pendingQueueState } : {}),
    };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueMaterializeNextResult> {
    // Strict by default: callers that want best-effort suppression must do so explicitly.
    const res = await tryMaterializeNextViaHttp(params);
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
    };
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket?: Socket<ServerToClientEvents, ClientToServerEvents> | null;
    knownPendingVersion?: number;
}): Promise<PendingQueueMaterializeNextResult> {
    // Strict by default: callers that want best-effort suppression must do so explicitly.
    const socketRes = params.socket?.connected === true
        ? await tryMaterializeNextViaSocket({
            socket: params.socket,
            sessionId: params.sessionId,
            knownPendingVersion: params.knownPendingVersion,
        })
        : ({ ok: false } as const);
    const res = socketRes.ok ? socketRes : await tryMaterializeNextViaHttp({ token: params.token, sessionId: params.sessionId });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
    };
}
