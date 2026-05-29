import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { HttpStatusError } from '@/api/client/httpStatusError';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';

import { createSessionProviderInputConsumer } from './SessionProviderInputConsumer';
import type { DrainPendingOptions, DrainPendingResult } from './types';

type TestMode = { id: string };
type ConsumerWithDrain = ReturnType<typeof createSessionProviderInputConsumer<TestMode, string>> & {
  drainPending?: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
};

function createDrainConsumer(
  session: Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]['session'],
): ConsumerWithDrain {
  return createSessionProviderInputConsumer({
    messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
    session,
  }) as ConsumerWithDrain;
}

describe('SessionProviderInputConsumer drainPending', () => {
  it('uses safe pending materialization before legacy pop fallback', async () => {
    const popPendingMessage = vi.fn(async () => false);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({
        type: 'materialized',
        localId: 'local-safe',
        seq: 7,
        content: null,
      })
      .mockResolvedValueOnce({ type: 'no_pending' });

    const consumer = createDrainConsumer({
      popPendingMessage,
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-safe' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('reconciles before stopping when materialization is disallowed', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ reason: 'test-disallowed' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('returns an error result when reconciliation fails during drain', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => {
      throw new Error('reconcile failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ reason: 'test-reconcile-error' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('stops after terminal auth failure without throwing', async () => {
    const popPendingMessage = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(popPendingMessage).toHaveBeenCalledTimes(1);
  });
});

describe('SessionProviderInputConsumer waitForNextInput', () => {
  it('does not safe-materialize pending messages while materialization is disallowed', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'blocked-local',
        seq: 1,
        content: null,
      });
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingQueueState,
        waitForMetadataUpdate: async () => false,
      },
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toBeNull();
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();
  });
});
