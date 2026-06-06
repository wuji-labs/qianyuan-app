import { describe, expect, it, vi } from 'vitest';

type ContinuationModule = Readonly<{
  isContinuationRecoveryAwaitingProviderActivityStatus: (status: string) => boolean;
  createSessionContinuationRecoveryController: (deps: {
    nowMs: () => number;
    providerActivityTimeoutMs?: number;
    store: {
      read: (sessionId: string) => Promise<unknown | null> | unknown | null;
      write: (sessionId: string, state: unknown) => Promise<void> | void;
    };
  }) => {
    beginAttempt: (input: {
      sessionId: string;
      attemptId: string;
      failureAtMs: number;
      resumePromptMode: 'standard' | 'off';
      continuationRequired?: boolean;
    }) => Promise<unknown>;
    resolveAttempt: (input: {
      sessionId: string;
      attemptId: string;
      failureAtMs: number;
      resumePromptMode: 'standard' | 'off';
      continuationRequired?: boolean;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: () => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
    }) => Promise<{ status: string }>;
    resolvePendingAttempts: (input: {
      sessionId: string;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: (input: { failureAtMs: number }) => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
    }) => Promise<{ resolved: Array<{ attemptId: string; status: string }> }>;
    recordProviderActivity: (input: { sessionId: string }) => Promise<{ observed: number }>;
    expireProviderActivityWaits: (input: { sessionId: string }) => Promise<{ expired: number }>;
  };
}>;

async function loadContinuationModule(): Promise<ContinuationModule> {
  const modulePath = './sessionContinuationRecovery';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  expect(typeof (mod as Partial<ContinuationModule> | null)?.createSessionContinuationRecoveryController).toBe('function');
  expect(typeof (mod as Partial<ContinuationModule> | null)?.isContinuationRecoveryAwaitingProviderActivityStatus).toBe('function');
  return mod as ContinuationModule;
}

function createStore() {
  const stored = new Map<string, unknown>();
  return {
    read: (sessionId: string) => stored.get(sessionId) ?? null,
    write: (sessionId: string, state: unknown) => {
      stored.set(sessionId, state);
    },
    stored,
  };
}

describe('session continuation recovery', () => {
  it('identifies statuses that need provider-activity timeout scheduling', async () => {
    const { isContinuationRecoveryAwaitingProviderActivityStatus } = await loadContinuationModule();

    expect(isContinuationRecoveryAwaitingProviderActivityStatus('awaiting_provider_activity')).toBe(true);
    expect(isContinuationRecoveryAwaitingProviderActivityStatus('already_awaiting_provider_activity')).toBe(true);
    expect(isContinuationRecoveryAwaitingProviderActivityStatus('provider_activity_timeout')).toBe(false);
    expect(isContinuationRecoveryAwaitingProviderActivityStatus('provider_activity_observed')).toBe(false);
  });

  it('sends one continuation per persisted session attempt across controller instances', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sentPrompts: string[] = [];
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await first.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
    });
    await expect(first.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    const second = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });
    await expect(second.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'already_awaiting_provider_activity' });

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain('continue');
  });

  it('preserves idempotency through async metadata stores', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const stored = new Map<string, unknown>();
    const store = {
      read: async (sessionId: string) => stored.get(sessionId) ?? null,
      write: async (sessionId: string, state: unknown) => {
        stored.set(sessionId, state);
      },
    };
    const sentPrompts: string[] = [];
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(first.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    const second = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });
    await expect(second.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'already_awaiting_provider_activity' });

    expect(sentPrompts).toHaveLength(1);
  });

  it('marks awaiting continuation recovered only after provider activity is observed', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    await expect(controller.recordProviderActivity({ sessionId: 'session-1' }))
      .resolves.toEqual({ observed: 1 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'provider_activity_observed',
        },
      },
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'already_observed_provider_activity' });
  });

  it('expires awaiting provider activity after the bounded proof window', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    let now = 2_000;
    const controller = createSessionContinuationRecoveryController({
      nowMs: () => now,
      providerActivityTimeoutMs: 5_000,
      store,
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    now = 6_999;
    await expect(controller.expireProviderActivityWaits({ sessionId: 'session-1' }))
      .resolves.toEqual({ expired: 0 });

    now = 7_000;
    await expect(controller.expireProviderActivityWaits({ sessionId: 'session-1' }))
      .resolves.toEqual({ expired: 1 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'provider_activity_timeout',
          errorCode: 'provider_activity_timeout',
        },
      },
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'provider_activity_timeout' });
  });

  it('resolves persisted pending attempts once provider context is available', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sentPrompts: string[] = [];
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await first.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
    });

    const second = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });
    await expect(second.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({
      resolved: [{ attemptId: 'generation-1:restart-1', status: 'awaiting_provider_activity' }],
    });

    expect(sentPrompts).toHaveLength(1);
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
        },
      },
    });
  });

  it('retries a persisted sending attempt with the same deterministic handoff id after restart replay', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    store.stored.set('session-1', {
      v: 1,
      attemptsById: {
        'generation-1:restart-1': {
          v: 1,
          attemptId: 'generation-1:restart-1',
          status: 'sending',
          failureAtMs: 1_000,
          updatedAtMs: 2_000,
          resumePromptMode: 'standard',
        },
      },
    });
    const sentPrompts: Array<{ prompt: string; localId: string }> = [];
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt, localId }) => {
        sentPrompts.push({ prompt, localId });
      },
    })).resolves.toEqual({
      resolved: [{ attemptId: 'generation-1:restart-1', status: 'awaiting_provider_activity' }],
    });

    expect(sentPrompts).toEqual([
      {
        prompt: expect.stringContaining('continue'),
        localId: expect.stringMatching(/^connected-service-continuation:/),
      },
    ]);
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
          sentAtMs: 3_000,
        },
      },
    });
  });

  it('finalizes a persisted sending attempt only when handoff evidence was recorded', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    store.stored.set('session-1', {
      v: 1,
      attemptsById: {
        'generation-1:restart-1': {
          v: 1,
          attemptId: 'generation-1:restart-1',
          status: 'sending',
          failureAtMs: 1_000,
          updatedAtMs: 2_000,
          sentAtMs: 2_500,
          resumePromptMode: 'standard',
        },
      },
    });
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({
      resolved: [{ attemptId: 'generation-1:restart-1', status: 'already_awaiting_provider_activity' }],
    });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
          sentAtMs: 2_500,
        },
      },
    });
  });

  it('does not resend when an interleaved resolver sees the first resolver in sending state', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });
    const second = createSessionContinuationRecoveryController({ nowMs: () => 2_500, store });
    const attemptedLocalIds: string[] = [];
    const deliveredPrompts: string[] = [];
    const deliveredLocalIds = new Set<string>();
    const deliverOnce = ({ prompt, localId }: { prompt: string; localId: string }) => {
      attemptedLocalIds.push(localId);
      if (deliveredLocalIds.has(localId)) return;
      deliveredLocalIds.add(localId);
      deliveredPrompts.push(prompt);
    };

    await first.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: async (handoff) => {
        deliverOnce(handoff);
        await expect(second.resolvePendingAttempts({
          sessionId: 'session-1',
          exactProviderContextAvailable: true,
          hasUserMessageAfterFailure: () => false,
          sendContinuationPrompt: deliverOnce,
        })).resolves.toEqual({
          resolved: [{ attemptId: 'generation-1:restart-1', status: 'awaiting_provider_activity' }],
        });
      },
    });

    expect(attemptedLocalIds).toHaveLength(2);
    expect(new Set(attemptedLocalIds).size).toBe(1);
    expect(deliveredPrompts).toHaveLength(1);
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
          sentAtMs: expect.any(Number),
        },
      },
    });
  });

  it('suppresses continuation when newer user input exists after the failure', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => true,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'suppressed_newer_user_input' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
  });

  it('suppresses continuation when the switch did not interrupt active provider work', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      continuationRequired: false,
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'suppressed_no_interrupted_turn' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'suppressed_no_interrupted_turn',
        },
      },
    });
  });

  it('marks retry required without sending when provider context is unavailable or prompts are off', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: false,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'retry_required' });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-2',
      failureAtMs: 1_500,
      resumePromptMode: 'off',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'retry_required' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
  });

  it('marks retry required when sending the continuation prompt fails', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: async () => {
        throw new Error('provider transport closed');
      },
    })).resolves.toEqual({ status: 'retry_required' });

    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'retry_required',
          errorCode: 'continuation_prompt_failed',
        },
      },
    });
  });
});
