import { describe, expect, it, vi } from 'vitest';

import { RuntimeAuthRecoveryScheduler } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from '../runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import { createConnectedServiceProviderActivityProofRecorder } from './providerActivityProofRecorder';

function createInMemoryContinuationStore(initial?: Readonly<Record<string, unknown>>) {
  const bySessionId = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    read: (sessionId: string) => bySessionId.get(sessionId) ?? null,
    write: (sessionId: string, state: unknown) => {
      bySessionId.set(sessionId, state);
    },
    snapshot: (sessionId: string) => bySessionId.get(sessionId) ?? null,
  };
}

function createSeededRuntimeAuthScheduler() {
  const scheduler = new RuntimeAuthRecoveryScheduler({
    nowMs: () => 1_000,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    jitterMs: () => 0,
    recover: async () => ({ status: 'credential_refreshed' }),
  });
  return scheduler;
}

const classification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'main',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
} as const;

const groupIdentity = {
  serviceId: 'openai-codex',
  selectionKind: 'group',
  groupId: 'main',
  profileId: 'primary',
} as const;

describe('createConnectedServiceProviderActivityProofRecorder', () => {
  it('clears an identity-matching runtime-auth intent on provider activity even when NO continuation attempt exists (RD-REC-2)', async () => {
    const scheduler = createSeededRuntimeAuthScheduler();
    await scheduler.beginClassifiedFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting' });

    const recorder = createConnectedServiceProviderActivityProofRecorder({
      nowMs: () => 2_000,
      providerActivityTimeoutMs: 60_000,
      continuationStore: createInMemoryContinuationStore(),
      runtimeAuthRecovery: scheduler,
    });

    // Idle session / suppressed replay / resumePromptMode:off: there is no
    // continuation attempt in `awaiting_provider_activity`. Real provider work
    // matching the recovery identity is still provider-outcome proof.
    await recorder({ sessionId: 'sess_1', recoveryIdentities: [groupIdentity] });

    expect(scheduler.readByKey(recoveryKey)).toBeNull();
  });

  it('does NOT clear intents for a non-matching recovery identity', async () => {
    const scheduler = createSeededRuntimeAuthScheduler();
    await scheduler.beginClassifiedFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification,
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });

    const recorder = createConnectedServiceProviderActivityProofRecorder({
      nowMs: () => 2_000,
      providerActivityTimeoutMs: 60_000,
      continuationStore: createInMemoryContinuationStore(),
      runtimeAuthRecovery: scheduler,
    });

    await recorder({
      sessionId: 'sess_1',
      recoveryIdentities: [{
        serviceId: 'anthropic',
        selectionKind: 'group',
        groupId: 'other',
      }],
    });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting' });
  });

  it('still settles a continuation attempt awaiting provider activity for the identity', async () => {
    const store = createInMemoryContinuationStore({
      sess_1: {
        v: 1,
        attemptsById: {
          attempt_1: {
            v: 1,
            attemptId: 'attempt_1',
            status: 'awaiting_provider_activity',
            failureAtMs: 500,
            updatedAtMs: 900,
            sentAtMs: 900,
            resumePromptMode: 'standard',
            recoveryIdentity: groupIdentity,
          },
        },
      },
    });
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      nowMs: () => 2_000,
      providerActivityTimeoutMs: 60_000,
      continuationStore: store,
    });

    await recorder({ sessionId: 'sess_1', recoveryIdentities: [groupIdentity] });

    expect(store.snapshot('sess_1')).toMatchObject({
      attemptsById: {
        attempt_1: { status: 'provider_activity_observed' },
      },
    });
  });

  it('forwards provider_activity proof to the usage-limit recovery owner per identity without requiring an attempt', async () => {
    const markProviderOutcomeProofForSession = vi.fn(async () => null);
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      nowMs: () => 2_000,
      providerActivityTimeoutMs: 60_000,
      continuationStore: createInMemoryContinuationStore(),
      usageLimitRecovery: { markProviderOutcomeProofForSession },
    });

    await recorder({ sessionId: 'sess_1', recoveryIdentities: [groupIdentity] });

    expect(markProviderOutcomeProofForSession).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
  });

  it('records unscoped provider activity when no recovery identities are bound', async () => {
    const store = createInMemoryContinuationStore({
      sess_1: {
        v: 1,
        attemptsById: {
          attempt_1: {
            v: 1,
            attemptId: 'attempt_1',
            status: 'awaiting_provider_activity',
            failureAtMs: 500,
            updatedAtMs: 900,
            sentAtMs: 900,
            resumePromptMode: 'standard',
          },
        },
      },
    });
    const markProviderOutcomeProofForSession = vi.fn(async () => null);
    const recorder = createConnectedServiceProviderActivityProofRecorder({
      nowMs: () => 2_000,
      providerActivityTimeoutMs: 60_000,
      continuationStore: store,
      usageLimitRecovery: { markProviderOutcomeProofForSession },
    });

    await recorder({ sessionId: 'sess_1' });

    expect(store.snapshot('sess_1')).toMatchObject({
      attemptsById: {
        attempt_1: { status: 'provider_activity_observed' },
      },
    });
    // No identity => no scoped scheduler clears (identity-matching is the guard).
    expect(markProviderOutcomeProofForSession).not.toHaveBeenCalled();
  });
});

describe('isProviderActivityTurnLifecycleEvent', () => {
  it('treats task_started and completed assistant_message_end as provider activity (REV-1)', async () => {
    const { isProviderActivityTurnLifecycleEvent } = await import('./providerActivityProofRecorder');
    expect(isProviderActivityTurnLifecycleEvent('task_started')).toBe(true);
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end')).toBe(true);
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end', 'completed')).toBe(true);
  });

  it('rejects FAILED-turn terminal events and non-activity events as proof (REV-1)', async () => {
    const { isProviderActivityTurnLifecycleEvent } = await import('./providerActivityProofRecorder');
    // failTurn emits assistant_message_end too; a failed turn proves nothing recovered.
    expect(isProviderActivityTurnLifecycleEvent('assistant_message_end', 'failed')).toBe(false);
    expect(isProviderActivityTurnLifecycleEvent('prompt_or_steer')).toBe(false);
    expect(isProviderActivityTurnLifecycleEvent('turn_cancelled')).toBe(false);
  });
});
