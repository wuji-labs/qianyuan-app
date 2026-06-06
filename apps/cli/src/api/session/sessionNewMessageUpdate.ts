import { decodeBase64, decrypt } from '../encryption';
import type {
    Update,
    UserMessage,
} from '../types';
import { SessionMessageContentSchema, UserMessageSchema } from '../types';
import { coerceSessionUserPromptV1 } from '@happier-dev/protocol';
import { summarizeValueShapeForLog } from '@/diagnostics/eventShapeForLog';

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasPendingMessageLocalId(messages: readonly UserMessage[], localId: string | null): boolean {
    if (!localId) return false;
    return messages.some((message) => message.localId === localId);
}

function isDeterministicDaemonInitialPromptLocalId(localId: string | null, sessionId: string): boolean {
    return localId === `daemon-initial-prompt:${sessionId}`;
}

export function handleSessionNewMessageUpdate(params: {
    update: Update;
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    receivedMessageIds: Set<string>;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
    hasSelfEchoSuppressedLocalId: (localId: string) => boolean;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    hasPendingQueueMaterializedLocalId: (localId: string) => boolean;
    deleteMaterializedLocalId: (localId: string) => void;
    pendingMessageCallback: ((message: UserMessage) => void) | null;
    pendingMessages: UserMessage[];
    shouldDeliverUserMessageToAgentQueue?: (message: UserMessage, update: Update) => boolean;
    onObservedMessage?: (message: {
        body: unknown;
        seq: number | null;
        localId: string | null;
        sidechainId: string | null;
        createdAt: number | null;
    }) => void;
    emit: (event: 'user-message' | 'message', payload: unknown) => void;
    debug: (message: string, data?: unknown) => void;
    debugLargeJson: (message: string, data: unknown) => void;
}): {
    handled: boolean;
    lastObservedMessageSeq: number;
    lastObservedUserMessageSeq: number;
} {
    if (params.update.body?.t !== 'new-message') {
        return {
            handled: false,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }
    if (params.update.body.sid !== params.sessionId) {
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const parsedContent = SessionMessageContentSchema.safeParse((params.update.body as any).message?.content);
    if (!parsedContent.success) {
        const rawContent = (params.update.body as any).message?.content;
        params.debug('[SOCKET] [UPDATE] Ignoring new-message with invalid content envelope', {
            issues: parsedContent.error.issues.map((i) => ({
                code: i.code,
                path: i.path,
                expected: 'expected' in i ? (i as any).expected : undefined,
                received: 'received' in i ? (i as any).received : undefined,
            })),
            contentShape: summarizeValueShapeForLog(rawContent),
        });
        return {
            handled: true,
            lastObservedMessageSeq: params.lastObservedMessageSeq,
            lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
        };
    }

    const messageId = params.update.body.message.id;
    if (typeof messageId === 'string' && messageId.length > 0) {
        if (params.receivedMessageIds.has(messageId)) {
            return {
                handled: true,
                lastObservedMessageSeq: params.lastObservedMessageSeq,
                lastObservedUserMessageSeq: params.lastObservedUserMessageSeq,
            };
        }
        params.receivedMessageIds.add(messageId);
    }

    let nextLastObservedMessageSeq = params.lastObservedMessageSeq;
    let nextLastObservedUserMessageSeq = params.lastObservedUserMessageSeq;
    const msgSeq = params.update.body.message.seq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
        nextLastObservedMessageSeq = Math.max(nextLastObservedMessageSeq, msgSeq);
    }

    const localId = readNonEmptyString(params.update.body.message.localId);
    const isSelfEchoSuppressedLocalId = Boolean(localId && params.hasSelfEchoSuppressedLocalId(localId));
    const isAgentQueueEchoSuppressedLocalId = Boolean(localId && params.hasAgentQueueEchoSuppressedLocalId(localId));
    const isPendingQueueMaterializedLocalId = Boolean(localId && params.hasPendingQueueMaterializedLocalId(localId));
    if (localId && (isSelfEchoSuppressedLocalId || isPendingQueueMaterializedLocalId)) {
        // We observed the broadcast for a message we materialized; cancel any recovery path.
        params.deleteMaterializedLocalId(localId);
    }

    let body: unknown;
    if (parsedContent.data.t === 'plain') {
        body = parsedContent.data.v;
    } else {
        try {
            body = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(parsedContent.data.c));
        } catch (error) {
            params.debug('[SOCKET] [UPDATE] Failed to decrypt new-message payload', {
                error,
                messageId: typeof messageId === 'string' ? messageId : null,
                localId,
                msgSeq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
            });
            return {
                handled: true,
                lastObservedMessageSeq: nextLastObservedMessageSeq,
                lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
            };
        }
    }
    const bodyWithLocalId =
        params.update.body.message.localId === undefined
            ? body
            : {
                ...(body as any),
                localId: params.update.body.message.localId,
            };
    const transportCreatedAt =
        typeof params.update.createdAt === 'number' && Number.isFinite(params.update.createdAt)
            ? params.update.createdAt
            : undefined;
    const bodyWithTransportFields = {
        ...(bodyWithLocalId as any),
        // Attach server timestamps so downstream consumers can make clock-safe decisions.
        ...(transportCreatedAt === undefined ? {} : { createdAt: transportCreatedAt }),
    };

    params.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithTransportFields);
    params.onObservedMessage?.({
        body: bodyWithTransportFields,
        seq: typeof msgSeq === 'number' && Number.isFinite(msgSeq) ? msgSeq : null,
        localId,
        sidechainId: typeof params.update.body.message.sidechainId === 'string' ? params.update.body.message.sidechainId : null,
        createdAt: transportCreatedAt ?? null,
    });

    // Try to parse as user message first.
    const userResult = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (userResult.success) {
        const sentFrom = userResult.data.meta?.sentFrom;
        const source = userResult.data.meta?.source;
        const agentQueueLocalId = localId ?? readNonEmptyString(userResult.data.localId);
        const isAgentQueueEchoSuppressedForDelivery = Boolean(
            agentQueueLocalId && params.hasAgentQueueEchoSuppressedLocalId(agentQueueLocalId),
        );
        const isAlreadyPendingAgentQueueMessage = hasPendingMessageLocalId(params.pendingMessages, agentQueueLocalId);
        const isDeterministicDaemonInitialPrompt =
            source === 'daemon-initial-prompt'
            && isDeterministicDaemonInitialPromptLocalId(agentQueueLocalId, params.sessionId);
        const isSelfEchoSuppressedCliWrite =
            isSelfEchoSuppressedLocalId && source === 'cli';
        const shouldRespectAgentQueueEchoSuppression = Boolean(params.pendingMessageCallback) || isAlreadyPendingAgentQueueMessage;
        const isEffectivelyAgentQueueEchoSuppressedLocalId =
            shouldRespectAgentQueueEchoSuppression
            && isAgentQueueEchoSuppressedForDelivery;
        const shouldDeliverToAgentQueue =
            !isEffectivelyAgentQueueEchoSuppressedLocalId
            && !isAlreadyPendingAgentQueueMessage
            && !isSelfEchoSuppressedCliWrite
            && (params.shouldDeliverUserMessageToAgentQueue?.(userResult.data, params.update) ?? true);
        if (shouldDeliverToAgentQueue) {
            if (params.pendingMessageCallback) {
                params.pendingMessageCallback(userResult.data);
            } else {
                params.pendingMessages.push(userResult.data);
            }
            if (agentQueueLocalId) {
                params.markAgentQueueEchoSuppressedLocalId(agentQueueLocalId);
            }
        } else {
            params.debug('[SOCKET] [UPDATE] Skipped user-message delivery to agent queue', {
                source: source ?? null,
                sentFrom: sentFrom ?? null,
                localId,
                agentQueueLocalId,
                isSelfEchoSuppressedLocalId,
                isAgentQueueEchoSuppressedLocalId,
                isAgentQueueEchoSuppressedForDelivery,
                isAlreadyPendingAgentQueueMessage,
                isPendingQueueMaterializedLocalId,
                isSelfEchoSuppressedCliWrite,
                shouldRespectAgentQueueEchoSuppression,
                isDeterministicDaemonInitialPrompt,
            });
        }
        if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
            nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
        }
        params.emit('user-message', userResult.data);
    } else {
        const coerced = coerceSessionUserPromptV1(bodyWithTransportFields);
        if (coerced) {
            const candidate = {
                role: 'user' as const,
                content: { type: 'text' as const, text: coerced.text },
                createdAt: (bodyWithTransportFields as any).createdAt,
                localId: (bodyWithTransportFields as any).localId,
                localKey: (bodyWithTransportFields as any).localKey,
                meta: (bodyWithTransportFields as any).meta,
            };
            const parsedCandidate = UserMessageSchema.safeParse(candidate);
            if (parsedCandidate.success) {
                const agentQueueLocalId = localId ?? readNonEmptyString(parsedCandidate.data.localId);
                const isAlreadyPendingAgentQueueMessage = hasPendingMessageLocalId(params.pendingMessages, agentQueueLocalId);
                const isAgentQueueEchoSuppressedForDelivery = Boolean(
                    agentQueueLocalId && params.hasAgentQueueEchoSuppressedLocalId(agentQueueLocalId),
                );
                const parsedSource = parsedCandidate.data.meta?.source;
                const isDeterministicDaemonInitialPrompt =
                    parsedSource === 'daemon-initial-prompt'
                    && isDeterministicDaemonInitialPromptLocalId(agentQueueLocalId, params.sessionId);
                const shouldDeliverToAgentQueue =
                    !isAlreadyPendingAgentQueueMessage
                    && !isAgentQueueEchoSuppressedForDelivery
                    && (params.shouldDeliverUserMessageToAgentQueue?.(parsedCandidate.data, params.update) ?? true);
                if (shouldDeliverToAgentQueue) {
                    if (params.pendingMessageCallback) {
                        params.pendingMessageCallback(parsedCandidate.data);
                    } else {
                        params.pendingMessages.push(parsedCandidate.data);
                    }
                    if (agentQueueLocalId) {
                        params.markAgentQueueEchoSuppressedLocalId(agentQueueLocalId);
                    }
                } else {
                    params.debug('[SOCKET] [UPDATE] Skipped coerced user-message delivery to agent queue', {
                        localId,
                        agentQueueLocalId,
                        isAlreadyPendingAgentQueueMessage,
                        isAgentQueueEchoSuppressedForDelivery,
                        source: parsedCandidate.data.meta?.source ?? null,
                        sentFrom: parsedCandidate.data.meta?.sentFrom ?? null,
                    });
                }
                if (typeof msgSeq === 'number' && Number.isFinite(msgSeq)) {
                    nextLastObservedUserMessageSeq = Math.max(nextLastObservedUserMessageSeq, msgSeq);
                }
                params.emit('user-message', parsedCandidate.data);
                return {
                    handled: true,
                    lastObservedMessageSeq: nextLastObservedMessageSeq,
                    lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
                };
            }
        }

        const rawRole = (bodyWithTransportFields as any)?.role;
        if (rawRole === 'user') {
            params.debug('[SOCKET] [UPDATE] Dropping user prompt delivery: unable to coerce into a UserMessage', {
                issues: userResult.error.issues.map((i) => ({
                    code: i.code,
                    path: i.path,
                    expected: 'expected' in i ? (i as any).expected : undefined,
                    received: 'received' in i ? (i as any).received : undefined,
                })),
                bodyShape: summarizeValueShapeForLog(bodyWithTransportFields),
            });
        }
        params.emit('message', bodyWithTransportFields);
    }

    return {
        handled: true,
        lastObservedMessageSeq: nextLastObservedMessageSeq,
        lastObservedUserMessageSeq: nextLastObservedUserMessageSeq,
    };
}
