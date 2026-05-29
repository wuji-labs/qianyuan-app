import axios from 'axios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { configuration } from '@/configuration';

import type { SessionEndMutationV1 } from './sessionMutationTypes';

type SessionEndSocket = {
    connected?: boolean;
    emit: (event: string, payload: unknown) => unknown;
};

export type SessionEndMutationDeliveryResult =
    | Readonly<{ status: 'delivered'; path: 'http' | 'legacy_socket_proof' }>
    | Readonly<{ status: 'retryable'; reason: 'session_end_http_unavailable' }>
    | Readonly<{
        status: 'unsupported_capability';
        reason: 'session_end_http_unsupported_without_legacy_proof';
    }>;

function isUnsupportedHttpError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const directStatus = (error as { status?: unknown }).status;
    if (directStatus === 404 || directStatus === 405 || directStatus === 501) return true;
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_BAD_REQUEST' || code === 'ERR_BAD_RESPONSE') {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string' && /\b(404|405|501)\b/.test(message)) return true;
    }
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return false;
    const status = (response as { status?: unknown }).status;
    return status === 404 || status === 405 || status === 501;
}

function isInactiveSessionRecord(value: unknown, sessionId: string): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.id === sessionId && record.active === false;
}

function readInactiveSessionProof(body: unknown, sessionId: string): boolean {
    if (!body || typeof body !== 'object') return false;
    const record = body as Record<string, unknown>;
    if (isInactiveSessionRecord(record.session, sessionId)) return true;
    const sessions = record.sessions;
    return Array.isArray(sessions) && sessions.some((session) => isInactiveSessionRecord(session, sessionId));
}

async function fetchSessionEndProof(params: Readonly<{
    serverUrl: string;
    token: string;
    sessionId: string;
}>): Promise<boolean> {
    const headers = { Authorization: `Bearer ${params.token}` };
    const urls = [
        `${params.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`,
        `${params.serverUrl}/v1/sessions`,
    ];
    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                headers,
                timeout: 10_000,
            });
            if (readInactiveSessionProof(response?.data, params.sessionId)) {
                return true;
            }
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
        }
    }
    return false;
}

export async function deliverSessionEndMutation(params: Readonly<{
    token: string;
    socket: SessionEndSocket;
    mutation: SessionEndMutationV1;
}>): Promise<SessionEndMutationDeliveryResult> {
    let emittedLegacySessionEnd = false;
    if (params.socket.connected === true) {
        // Compatibility fanout only. Durable session-end delivery is confirmed by HTTP below.
        params.socket.emit('session-end', {
            sid: params.mutation.sessionId,
            time: params.mutation.observedAt,
            ...(params.mutation.exit !== undefined ? { exit: params.mutation.exit } : {}),
        });
        emittedLegacySessionEnd = true;
    }

    const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
    try {
        const response = await axios.post(
            `${serverUrl}/v1/sessions/${encodeURIComponent(params.mutation.sessionId)}/end`,
            { time: params.mutation.observedAt },
            {
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10_000,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (data && (
            data.ok === false
            || data.result === 'error'
            || data.success === false
        )) {
            return { status: 'retryable', reason: 'session_end_http_unavailable' };
        }
        return { status: 'delivered', path: 'http' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        if (emittedLegacySessionEnd && isUnsupportedHttpError(error)) {
            const delivered = await fetchSessionEndProof({
                serverUrl,
                token: params.token,
                sessionId: params.mutation.sessionId,
            });
            if (delivered) return { status: 'delivered', path: 'legacy_socket_proof' };
            return {
                status: 'unsupported_capability',
                reason: 'session_end_http_unsupported_without_legacy_proof',
            };
        }
        return { status: 'retryable', reason: 'session_end_http_unavailable' };
    }
}
