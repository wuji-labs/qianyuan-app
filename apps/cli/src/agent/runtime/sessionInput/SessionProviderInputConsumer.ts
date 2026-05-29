import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import type {
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
  PendingMaterializationReconcileWhenEmpty,
  PendingMaterializationResult,
  SessionProviderInputConsumer,
} from './types';

const DEFAULT_MAX_POP_PER_WAKE = 25;

export class PendingQueueMaterializationAuthError extends Error {
  constructor() {
    super('Pending queue materialization stopped after supervisor authentication failure');
    this.name = 'PendingQueueMaterializationAuthError';
  }
}

export interface SessionProviderInputConsumerSession {
  materializeNextPendingMessageSafely?: ((opts?: {
    reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
  }) => Promise<PendingMaterializationResult>) | undefined;
  popPendingMessage: () => Promise<boolean>;
  shouldAttemptPendingMaterialization?: (() => boolean) | undefined;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => unknown | Promise<unknown>) | undefined;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
}

export interface SessionProviderInputConsumerOptions<Mode, Message> {
  messageQueue: MessageQueue2<Mode, Message>;
  session: SessionProviderInputConsumerSession;
  onMetadataUpdate?: (() => void | Promise<void>) | null | undefined;
  refreshMetadataBeforeWait?: boolean | undefined;
  reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty | undefined;
  idleWakePollIntervalMs?: number | undefined;
}

type WakeWinner = { kind: 'queue'; hasMessages: boolean } | { kind: 'meta'; ok: boolean } | { kind: 'idle' };

export function createSessionProviderInputConsumer<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): SessionProviderInputConsumer<Mode, Message> {
  return {
    async waitForNextInput(waitOpts) {
      return await waitForNextInput({ ...opts, abortSignal: waitOpts.abortSignal });
    },
    async drainPending(drainOpts) {
      return await drainPendingMessages({ session: opts.session, ...(drainOpts ?? {}) });
    },
  };
}

export function createSessionProviderPendingDrainAdapter(
  session: SessionProviderInputConsumerSession,
): Pick<SessionProviderInputConsumer<never, never>, 'drainPending'> {
  return {
    async drainPending(drainOpts) {
      return await drainPendingMessages({ session, ...(drainOpts ?? {}) });
    },
  };
}

async function waitForNextInput<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message> & { abortSignal: AbortSignal },
): Promise<MessageBatch<Mode, Message> | null> {
  const idleWakePollIntervalMs = opts.idleWakePollIntervalMs ?? configuration.pendingQueueIdleWakePollIntervalMs;

  while (true) {
    if (opts.abortSignal.aborted) {
      return null;
    }

    const existingBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
    if (existingBatch) {
      await callMetadataUpdate(opts.onMetadataUpdate);
      if (opts.abortSignal.aborted) {
        return null;
      }
      return existingBatch;
    }

    await materializePendingMessage(opts);

    const materializedBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
    if (materializedBatch) {
      await callMetadataUpdate(opts.onMetadataUpdate);
      if (opts.abortSignal.aborted) {
        return null;
      }
      return materializedBatch;
    }

    if (opts.refreshMetadataBeforeWait) {
      await callMetadataUpdate(opts.onMetadataUpdate);
      if (opts.abortSignal.aborted) {
        return null;
      }
      const refreshedBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
      if (refreshedBatch) {
        return refreshedBatch;
      }
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) {
      controller.abort();
    }

    try {
      const winner = await waitForWakeSignal({
        messageQueue: opts.messageQueue,
        waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
        controller,
        idleWakePollIntervalMs,
      });

      if (winner.kind === 'meta' && !winner.ok) {
        controller.abort('sessionProviderInputConsumer-meta-false');

        await Promise.resolve();

        const queuedAfterMetadataFailure = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
        if (queuedAfterMetadataFailure) {
          return queuedAfterMetadataFailure;
        }

        if (idleWakePollIntervalMs <= 0) {
          return null;
        }

        await waitForIdleFallback({ abortSignal: opts.abortSignal, idleWakePollIntervalMs });

        if (opts.abortSignal.aborted) {
          return null;
        }

        await callMetadataUpdate(opts.onMetadataUpdate);
        continue;
      }

      controller.abort('sessionProviderInputConsumer');

      if (winner.kind === 'queue') {
        if (!winner.hasMessages) {
          return null;
        }
        await callMetadataUpdate(opts.onMetadataUpdate);
        if (opts.abortSignal.aborted) {
          return null;
        }
        return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
      }

      if (winner.kind === 'idle') {
        await callMetadataUpdate(opts.onMetadataUpdate);
        continue;
      }

      if (winner.kind === 'meta') {
        await callMetadataUpdate(opts.onMetadataUpdate);
      }
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

async function collectQueuedBatch<Mode, Message>(
  messageQueue: MessageQueue2<Mode, Message>,
  abortSignal: AbortSignal,
): Promise<MessageBatch<Mode, Message> | null> {
  if (messageQueue.size() <= 0) {
    return null;
  }
  return await messageQueue.waitForMessagesAndGetAsString(abortSignal);
}

async function materializePendingMessage<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): Promise<void> {
  if (!(opts.session.shouldAttemptPendingMaterialization?.() ?? true)) {
    await opts.session.reconcilePendingQueueState?.({ force: true });
  }

  if (!(opts.session.shouldAttemptPendingMaterialization?.() ?? true)) {
    return;
  }

  const safeMaterialize = opts.session.materializeNextPendingMessageSafely;
  if (safeMaterialize) {
    const result = await safeMaterialize({ reconcileWhenEmpty: opts.reconcileWhenEmpty ?? 'force' });
    if (result.type === 'materialized') {
      // The transcript update path owns queue delivery; do not synthesize a provider batch from the pending payload.
      return;
    }
    if (result.type === 'deferred' && result.reason === 'supervisor_auth_failed') {
      throw new PendingQueueMaterializationAuthError();
    }
    return;
  }
  await opts.session.popPendingMessage();
}

async function drainPendingMessages(
  opts: DrainPendingOptions & { session: SessionProviderInputConsumerSession },
): Promise<DrainPendingResult> {
  const maxPopPerWake = Math.max(1, Math.trunc(opts.maxPopPerWake ?? DEFAULT_MAX_POP_PER_WAKE));
  let materialized = 0;

  for (let i = 0; i < maxPopPerWake; i += 1) {
    try {
      if (opts.abortSignal?.aborted) {
        return { materialized, stoppedReason: 'aborted' };
      }
      if (opts.shouldContinue && !opts.shouldContinue()) {
        return { materialized, stoppedReason: 'drain_disallowed' };
      }

      const canMaterialize = opts.session.shouldAttemptPendingMaterialization?.() ?? true;
      if (!canMaterialize) {
        await opts.session.reconcilePendingQueueState?.({ force: true });
        if (opts.abortSignal?.aborted) {
          return { materialized, stoppedReason: 'aborted' };
        }
        if (!(opts.session.shouldAttemptPendingMaterialization?.() ?? true)) {
          return { materialized, stoppedReason: 'materialization_blocked' };
        }
      }

      const result = await materializeNextPendingForDrain(opts.session, opts);
      if (result === 'materialized') {
        materialized += 1;
        continue;
      }
      return { materialized, stoppedReason: result };
    } catch (error) {
      return { materialized, stoppedReason: readDrainErrorStoppedReason(error, opts) };
    }
  }

  return { materialized, stoppedReason: 'max_pop_per_wake' };
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions,
): Promise<Exclude<DrainPendingResult['stoppedReason'], 'aborted' | 'drain_disallowed' | 'materialization_blocked' | 'max_pop_per_wake'> | 'materialized'> {
  const safeMaterialize = session.materializeNextPendingMessageSafely;
  if (safeMaterialize) {
    try {
      const result = await safeMaterialize({ reconcileWhenEmpty: 'force' });
      if (result.type === 'materialized') {
        return 'materialized';
      }
      if (result.type === 'deferred') {
        if (result.reason === 'supervisor_auth_failed') {
          logTerminalAuthDrainStop(opts, null);
          return 'auth_failure';
        }
        return 'deferred';
      }
      return 'no_pending';
    } catch (error) {
      return readDrainErrorStoppedReason(error, opts);
    }
  }

  try {
    const didPop = await session.popPendingMessage();
    return didPop ? 'materialized' : 'no_pending';
  } catch (error) {
    return readDrainErrorStoppedReason(error, opts);
  }
}

function readDrainErrorStoppedReason(error: unknown, opts: DrainPendingOptions): 'auth_failure' | 'error' {
  const terminalAuthStatus = readAuthenticationStatus(error);
  if (terminalAuthStatus !== null) {
    logTerminalAuthDrainStop(opts, terminalAuthStatus);
    return 'auth_failure';
  }
  return 'error';
}

function logTerminalAuthDrainStop(opts: DrainPendingOptions, status: 401 | 403 | null): void {
  logger.debug(`${opts.logPrefix ?? '[INPUT-CONSUMER]'} Stopping pending queue drain after terminal auth failure`, {
    ...(status !== null ? { status } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

async function waitForWakeSignal<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  controller: AbortController;
  idleWakePollIntervalMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    .waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  const metaWait = opts.waitForMetadataUpdate(opts.controller.signal).then((ok) => ({ kind: 'meta' as const, ok }));
  const idleWait =
    opts.idleWakePollIntervalMs > 0
      ? new Promise<{ kind: 'idle' }>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: 'idle' as const }), opts.idleWakePollIntervalMs);
          timer.unref?.();
          opts.controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
            },
            { once: true },
          );
        })
      : null;

  return await Promise.race([queueWait, metaWait, ...(idleWait ? [idleWait] : [])]);
}

async function waitForIdleFallback(opts: { abortSignal: AbortSignal; idleWakePollIntervalMs: number }): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.abortSignal.removeEventListener('abort', onFallbackAbort);
      resolve();
    };

    const onFallbackAbort = () => finish();

    timer = setTimeout(finish, opts.idleWakePollIntervalMs);
    timer.unref?.();
    opts.abortSignal.addEventListener('abort', onFallbackAbort, { once: true });

    if (opts.abortSignal.aborted) {
      finish();
    }
  });
}

async function callMetadataUpdate(onMetadataUpdate: (() => void | Promise<void>) | null | undefined): Promise<void> {
  try {
    await onMetadataUpdate?.();
  } catch {
    // Non-fatal: metadata reconciliation should not break the message loop.
  }
}
