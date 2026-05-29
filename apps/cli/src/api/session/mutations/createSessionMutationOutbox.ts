import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { isAuthenticationError } from '@/api/client/httpStatusError';

import {
    resolveSessionMutationMaxAgeMs,
    resolveSessionMutationMaxAttempts,
    resolveSessionMutationRetryDelayMs,
} from './sessionMutationBackoff';
import {
    appendSessionMutationDeadLetters,
    createSessionMutationDeadLetterEntry,
    loadSessionMutationOutbox,
    parseQueuedSessionMutation,
    saveSessionMutationOutbox,
} from './sessionMutationPersistence';
import { deliverSessionTurnMutation, type UnsupportedSessionTurnMutationDiagnostic } from './deliverSessionTurnMutation';
import { deliverSessionEndMutation } from './deliverSessionEndMutation';
import type {
    QueuedSessionMutation,
    SessionEndMutationV1,
    SessionTurnMutationV1,
} from './sessionMutationTypes';
import type { SessionMutationDeadLetterEntry } from './sessionMutationPersistence';

export type SessionMutationSocket = {
    connected?: boolean;
    emit: (event: string, ...args: unknown[]) => unknown;
    emitWithAck: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => SessionMutationSocket;
};

export type SessionMutationOutbox = Readonly<{
    enqueueSessionTurn(mutation: SessionTurnMutationV1): Promise<void>;
    enqueueSessionEnd(mutation: SessionEndMutationV1): Promise<void>;
    flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
    close(): Promise<void>;
}>;

type CreateSessionMutationOutboxParams = Readonly<{
    token: string;
    sessionId: string;
    getSocket: () => SessionMutationSocket;
    requestReconnect: (reason: string) => void;
}>;

const loggedUnsupportedSessionTurnMutationDiagnostics = new Set<string>();

function createQueuedSessionTurn(mutation: SessionTurnMutationV1): QueuedSessionMutation {
    const now = Date.now();
    return {
        kind: 'session_turn',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function createQueuedSessionEnd(mutation: SessionEndMutationV1): QueuedSessionMutation {
    const now = Date.now();
    return {
        kind: 'session_end',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

function resolveUnsupportedDiagnosticKey(diagnostic: UnsupportedSessionTurnMutationDiagnostic): string {
    return [
        diagnostic.serverOrigin,
        diagnostic.sessionId,
        diagnostic.socket.transport,
        diagnostic.socket.evidence,
        diagnostic.http.transport,
        diagnostic.http.evidence,
        diagnostic.http.status,
    ].join(':');
}

function logUnsupportedSessionTurnMutationDiagnostic(diagnostic: UnsupportedSessionTurnMutationDiagnostic): void {
    const key = resolveUnsupportedDiagnosticKey(diagnostic);
    if (loggedUnsupportedSessionTurnMutationDiagnostics.has(key)) return;
    loggedUnsupportedSessionTurnMutationDiagnostics.add(key);
    logger.debug('[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued', diagnostic);
}

type SessionMutationDeliveryOutcome =
    | Readonly<{ status: 'delivered'; path: 'socket' | 'http' | 'legacy_socket_proof' }>
    | Readonly<{
        status: 'retryable';
        reason: string;
        httpStatus?: number;
    }>
    | Readonly<{
        status: 'unsupported_capability';
        reason: string;
        diagnostic?: unknown;
    }>
    | Readonly<{
        status: 'permanent_invalid_payload';
        reason: string;
        diagnostic?: unknown;
    }>;

function mergeQueuedSessionMutations(
    earlier: readonly QueuedSessionMutation[],
    later: readonly QueuedSessionMutation[],
): QueuedSessionMutation[] {
    const merged = [...earlier];
    for (const mutation of later) {
        const existingIndex = merged.findIndex((queued) => queued.mutationId === mutation.mutationId);
        if (existingIndex >= 0) {
            merged[existingIndex] = mutation;
        } else {
            merged.push(mutation);
        }
    }
    return merged;
}

function readQueuedMutationObservedAt(mutation: QueuedSessionMutation): number {
    const observedAt = mutation.payload.observedAt;
    return Number.isFinite(observedAt) ? observedAt : mutation.createdAt;
}

function pruneSessionEndsSupersededByLaterTurnBegins(
    queued: readonly QueuedSessionMutation[],
): QueuedSessionMutation[] {
    let latestTurnBeginObservedAt = -Infinity;
    for (const mutation of queued) {
        if (mutation.kind !== 'session_turn' || mutation.payload.action !== 'begin') continue;
        latestTurnBeginObservedAt = Math.max(latestTurnBeginObservedAt, readQueuedMutationObservedAt(mutation));
    }
    if (!Number.isFinite(latestTurnBeginObservedAt)) return [...queued];
    return queued.filter((mutation) => (
        mutation.kind !== 'session_end'
        || readQueuedMutationObservedAt(mutation) >= latestTurnBeginObservedAt
    ));
}

export function createSessionMutationOutbox(params: CreateSessionMutationOutboxParams): SessionMutationOutbox {
    let closed = false;
    let mutations: QueuedSessionMutation[] = [];
    let inFlightMutations: QueuedSessionMutation[] = [];
    let flushInFlight: Promise<void> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const ready = loadSessionMutationOutbox(params.sessionId)
        .then((loaded) => {
            mutations = pruneSessionEndsSupersededByLaterTurnBegins(loaded);
        })
        .catch((error) => {
            logger.debug('[API] Failed to load durable session mutation outbox', {
                sessionId: params.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });

    async function persist(): Promise<void> {
        await saveSessionMutationOutbox(
            params.sessionId,
            pruneSessionEndsSupersededByLaterTurnBegins(
                mergeQueuedSessionMutations(inFlightMutations, mutations),
            ),
        );
    }

    function clearRetryTimer(): void {
        if (!retryTimer) return;
        clearTimeout(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry(): void {
        if (closed || retryTimer || mutations.length === 0) return;
        const now = Date.now();
        const nextAttemptAt = Math.min(...mutations.map((mutation) => mutation.nextAttemptAt || now));
        const delayMs = Math.max(0, nextAttemptAt - now);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void flush('timer');
        }, delayMs);
        retryTimer.unref?.();
    }

    async function deliver(mutation: QueuedSessionMutation): Promise<SessionMutationDeliveryOutcome> {
        const parsedMutation = parseQueuedSessionMutation(mutation, params.sessionId);
        if (!parsedMutation.ok) {
            return {
                status: 'permanent_invalid_payload',
                reason: parsedMutation.deadLetter.reason,
                diagnostic: parsedMutation.deadLetter.diagnostic,
            };
        }
        if (mutation.kind === 'session_turn') {
            const result = await deliverSessionTurnMutation({
                token: params.token,
                socket: params.getSocket(),
                mutation: mutation.payload,
            });
            if (result.status === 'unsupported_capability') {
                logUnsupportedSessionTurnMutationDiagnostic(result.diagnostic);
            }
            return result;
        }
        return await deliverSessionEndMutation({
            token: params.token,
            socket: params.getSocket(),
            mutation: mutation.payload,
        });
    }

    function shouldDeadLetterFailedMutation(mutation: QueuedSessionMutation, now: number): boolean {
        const maxAgeMs = resolveSessionMutationMaxAgeMs();
        return (
            mutation.attempts >= resolveSessionMutationMaxAttempts()
            || (maxAgeMs > 0 && now - mutation.createdAt >= maxAgeMs)
        );
    }

    function createDeliveryDiagnostic(outcome: Exclude<SessionMutationDeliveryOutcome, { status: 'delivered' }>): Record<string, unknown> {
        return {
            deliveryStatus: outcome.status,
            reason: outcome.reason,
            ...('httpStatus' in outcome && outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
            ...('diagnostic' in outcome && outcome.diagnostic ? { deliveryDiagnostic: outcome.diagnostic } : {}),
        };
    }

    function resolveTurnDependencyKey(mutation: QueuedSessionMutation): string | null {
        if (mutation.kind !== 'session_turn') return null;
        const turnId = mutation.payload.turnId;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    function deadLetterDependentMutations(params: Readonly<{
        batch: readonly QueuedSessionMutation[];
        startIndex: number;
        failedMutation: QueuedSessionMutation;
        deadLetters: SessionMutationDeadLetterEntry[];
    }>): number {
        const failedDependencyKey = resolveTurnDependencyKey(params.failedMutation);
        if (!failedDependencyKey) return params.startIndex;
        let index = params.startIndex;
        while (index < params.batch.length) {
            const candidate = params.batch[index];
            if (resolveTurnDependencyKey(candidate) !== failedDependencyKey) break;
            params.deadLetters.push(createSessionMutationDeadLetterEntry({
                sessionId: params.failedMutation.payload.sessionId,
                mutation: candidate,
                reason: 'blocked_by_dead_lettered_dependency',
                dependencyMutationId: params.failedMutation.mutationId,
            }));
            index += 1;
        }
        return index;
    }

    async function flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void> {
        await ready;
        if (closed && reason !== 'flush') return;
        if (flushInFlight) {
            await flushInFlight;
            if (reason !== 'timer') {
                await flush(reason);
            }
            return;
        }
        flushInFlight = (async () => {
            clearRetryTimer();
            const now = Date.now();
            let didChange = false;
            let shouldRequestReconnect = false;
            const remaining: QueuedSessionMutation[] = [];
            const prunedMutations = pruneSessionEndsSupersededByLaterTurnBegins(mutations);
            if (prunedMutations.length !== mutations.length) {
                mutations = prunedMutations;
                didChange = true;
            }
            const batch = mutations;
            mutations = [];
            inFlightMutations = batch;
            const deadLetters: SessionMutationDeadLetterEntry[] = [];
            for (let index = 0; index < batch.length; index += 1) {
                const mutation = batch[index];
                if (reason !== 'flush' && mutation.nextAttemptAt > now) {
                    remaining.push(mutation);
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    break;
                }
                const parsedMutation = parseQueuedSessionMutation(mutation, params.sessionId);
                if (!parsedMutation.ok) {
                    deadLetters.push(parsedMutation.deadLetter);
                    const nextIndex = deadLetterDependentMutations({
                        batch,
                        startIndex: index + 1,
                        failedMutation: mutation,
                        deadLetters,
                    });
                    inFlightMutations = batch.slice(nextIndex);
                    index = nextIndex - 1;
                    didChange = true;
                    continue;
                }
                try {
                    const outcome = await deliver(mutation);
                    if (outcome.status === 'delivered') {
                        didChange = true;
                        inFlightMutations = batch.slice(index + 1);
                        continue;
                    }
                    if (outcome.status === 'permanent_invalid_payload') {
                        deadLetters.push(createSessionMutationDeadLetterEntry({
                            sessionId: params.sessionId,
                            mutation,
                            reason: outcome.reason,
                            diagnostic: createDeliveryDiagnostic(outcome),
                        }));
                        const nextIndex = deadLetterDependentMutations({
                            batch,
                            startIndex: index + 1,
                            failedMutation: mutation,
                            deadLetters,
                        });
                        inFlightMutations = batch.slice(nextIndex);
                        index = nextIndex - 1;
                        didChange = true;
                        continue;
                    }
                    const attempts = mutation.attempts + 1;
                    const failedMutation = {
                        ...mutation,
                        attempts,
                        nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(attempts),
                    } as QueuedSessionMutation;
                    if (shouldDeadLetterFailedMutation(failedMutation, Date.now())) {
                        deadLetters.push(createSessionMutationDeadLetterEntry({
                            sessionId: params.sessionId,
                            mutation: failedMutation,
                            reason: 'retry_exhausted',
                            diagnostic: createDeliveryDiagnostic(outcome),
                        }));
                        const nextIndex = deadLetterDependentMutations({
                            batch,
                            startIndex: index + 1,
                            failedMutation,
                            deadLetters,
                        });
                        inFlightMutations = batch.slice(nextIndex);
                        index = nextIndex - 1;
                        didChange = true;
                        continue;
                    }
                    remaining.push(failedMutation);
                    remaining.push(...batch.slice(index + 1));
                    inFlightMutations = [];
                    didChange = true;
                    shouldRequestReconnect = true;
                    break;
                } catch (error) {
                    if (isAuthenticationError(error)) {
                        remaining.push({
                            ...mutation,
                            nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(mutation.attempts + 1),
                        } as QueuedSessionMutation);
                        remaining.push(...batch.slice(index + 1));
                        inFlightMutations = [];
                        didChange = true;
                        break;
                    }
                    logger.debug('[API] Durable session mutation delivery failed', {
                        sessionId: params.sessionId,
                        mutationKind: mutation.kind,
                        mutationId: mutation.mutationId,
                        error: serializeAxiosErrorForLog(error),
                    });
                }

                const attempts = mutation.attempts + 1;
                const failedMutation = {
                    ...mutation,
                    attempts,
                    nextAttemptAt: Date.now() + resolveSessionMutationRetryDelayMs(attempts),
                } as QueuedSessionMutation;
                if (shouldDeadLetterFailedMutation(failedMutation, Date.now())) {
                    deadLetters.push(createSessionMutationDeadLetterEntry({
                        sessionId: params.sessionId,
                        mutation: failedMutation,
                        reason: 'retry_exhausted',
                        diagnostic: {
                            deliveryStatus: 'retryable',
                            reason: 'delivery_exception',
                        },
                    }));
                    const nextIndex = deadLetterDependentMutations({
                        batch,
                        startIndex: index + 1,
                        failedMutation,
                        deadLetters,
                    });
                    inFlightMutations = batch.slice(nextIndex);
                    index = nextIndex - 1;
                    didChange = true;
                    continue;
                }
                remaining.push(failedMutation);
                remaining.push(...batch.slice(index + 1));
                inFlightMutations = [];
                didChange = true;
                shouldRequestReconnect = true;
                break;
            }
            mutations = mergeQueuedSessionMutations(remaining, mutations);
            inFlightMutations = [];
            if (didChange) {
                await appendSessionMutationDeadLetters(params.sessionId, deadLetters);
                await persist();
            }
            if (!closed && mutations.length > 0) {
                if (shouldRequestReconnect) {
                    params.requestReconnect(reason);
                }
                scheduleRetry();
            }
        })().finally(() => {
            flushInFlight = null;
        });
        await flushInFlight;
    }

    async function enqueue(mutation: QueuedSessionMutation): Promise<void> {
        await ready;
        if (closed) return;
        const existingIndex = mutations.findIndex((queued) => queued.mutationId === mutation.mutationId);
        if (existingIndex >= 0) {
            mutations[existingIndex] = mutation;
        } else {
            mutations.push(mutation);
        }
        mutations = pruneSessionEndsSupersededByLaterTurnBegins(mutations);
        await persist();
        void flush('enqueue').catch((error) => {
            logger.debug('[API] Durable session mutation enqueue flush failed', {
                sessionId: params.sessionId,
                mutationKind: mutation.kind,
                mutationId: mutation.mutationId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    void ready.then(() => flush('startup')).catch(() => {});

    return {
        async enqueueSessionTurn(mutation) {
            await enqueue(createQueuedSessionTurn(mutation));
        },
        async enqueueSessionEnd(mutation) {
            await enqueue(createQueuedSessionEnd(mutation));
        },
        flush,
        async close() {
            closed = true;
            clearRetryTimer();
            await ready;
            await flush('flush');
            clearRetryTimer();
            await persist();
        },
    };
}
