import { ConnectedServiceIdSchema, type SessionContinuationRecoveryIdentityV1 } from '@happier-dev/protocol';

import { createSessionContinuationRecoveryController } from '../continuation/sessionContinuationRecovery';
import { listMatchingRuntimeAuthRecoveryIntents } from '../runtimeAuth/matchRuntimeAuthRecoveryIntent';
import { buildRuntimeAuthRecoveryKey } from '../runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import type { ProviderOutcomeProofKind } from './providerOutcomeProof';

/**
 * Session-metadata persistence boundary for the continuation recovery state
 * (matches the controller's store contract in sessionContinuationRecovery).
 */
type ContinuationRecoveryStore = Readonly<{
  read: (sessionId: string) => Promise<unknown | null> | unknown | null;
  write: (sessionId: string, state: unknown) => Promise<void> | void;
}>;

type RuntimeAuthRecoveryForProviderActivityProof = Readonly<{
  readForSession: (sessionId: string) => ReadonlyArray<RuntimeAuthRecoveryIntent>;
  markProviderOutcomeProofByKey: (input: Readonly<{
    recoveryKey: string;
    proofKind: ProviderOutcomeProofKind;
  }>) => Promise<unknown>;
}>;

type UsageLimitRecoveryForProviderActivityProof = Readonly<{
  markProviderOutcomeProofForSession: (input: Readonly<{
    sessionId: string;
    proofKind: ProviderOutcomeProofKind;
    serviceId: string;
    profileId?: string | null;
    groupId?: string | null;
  }>) => Promise<unknown>;
}>;

export type ConnectedServiceProviderActivityProofRecorder = (input: Readonly<{
  sessionId: string;
  recoveryIdentities?: readonly SessionContinuationRecoveryIdentityV1[];
}>) => Promise<void>;

/**
 * REV-1: gate for treating a turn-lifecycle event as `provider_activity` proof.
 * `assistant_message_end` is also emitted by failTurn / ACP turn_failed markers;
 * a FAILED turn (the usage-limit interruption itself) must not clear the very
 * recovery intents it just armed. A missing terminal status (legacy producers)
 * keeps the completed-turn behavior.
 */
export function isProviderActivityTurnLifecycleEvent(
  event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
  terminalStatus?: 'completed' | 'failed',
): boolean {
  if (event === 'task_started') return true;
  return event === 'assistant_message_end' && terminalStatus !== 'failed';
}

/**
 * The `provider_activity` proof PRODUCER (closed outcome-proof union,
 * providerOutcomeProof.ts). Turn-lifecycle provider activity (task_started /
 * assistant_message_end) that matches a recovery identity clears the matching
 * runtime-auth and usage-limit intents directly.
 *
 * RD-REC-2: clearing must NOT require a continuation attempt sitting in
 * `awaiting_provider_activity`. Recoveries with no live attempt (idle session,
 * suppressed replay, `resumePromptMode: off`, provider_context_unavailable)
 * still produce real provider work; the attempt row is presentation, the
 * activity is the proof. The continuation controller is still informed so any
 * awaiting attempt settles, but its observation count no longer gates the
 * scheduler clears.
 */
export function createConnectedServiceProviderActivityProofRecorder(params: Readonly<{
  nowMs?: () => number;
  providerActivityTimeoutMs: number;
  continuationStore: ContinuationRecoveryStore;
  runtimeAuthRecovery?: RuntimeAuthRecoveryForProviderActivityProof | null;
  usageLimitRecovery?: UsageLimitRecoveryForProviderActivityProof | null;
  logDebug?: (message: string, error: unknown) => void;
}>): ConnectedServiceProviderActivityProofRecorder {
  const controller = createSessionContinuationRecoveryController({
    nowMs: params.nowMs ?? (() => Date.now()),
    providerActivityTimeoutMs: params.providerActivityTimeoutMs,
    store: params.continuationStore,
  });

  const clearMatchingRuntimeAuthIntents = async (input: Readonly<{
    sessionId: string;
    recoveryIdentity: SessionContinuationRecoveryIdentityV1;
    serviceId: ReturnType<typeof ConnectedServiceIdSchema.parse>;
  }>): Promise<void> => {
    if (!params.runtimeAuthRecovery) return;
    const serviceId = input.serviceId;
    const intents = params.runtimeAuthRecovery.readForSession(input.sessionId);
    const matches = listMatchingRuntimeAuthRecoveryIntents(intents, {
      serviceId,
      groupId: input.recoveryIdentity.groupId ?? null,
      profileId: input.recoveryIdentity.profileId ?? null,
    });
    await Promise.all(matches.map(async (intent) => {
      await params.runtimeAuthRecovery?.markProviderOutcomeProofByKey({
        recoveryKey: buildRuntimeAuthRecoveryKey({
          sessionId: intent.sessionId,
          serviceId: intent.serviceId,
          profileId: intent.profileId,
          groupId: intent.groupId,
        }),
        proofKind: 'provider_activity',
      });
    }));
  };

  return async (input) => {
    const identities = input.recoveryIdentities ?? [];
    if (identities.length === 0) {
      await controller.recordProviderActivity({ sessionId: input.sessionId });
      return;
    }
    for (const recoveryIdentity of identities) {
      // Settle any continuation attempt awaiting this identity's activity. This
      // result deliberately does NOT gate the scheduler clears below.
      await controller.recordProviderActivity({ sessionId: input.sessionId, recoveryIdentity });
      const serviceId = ConnectedServiceIdSchema.safeParse(recoveryIdentity.serviceId);
      if (!serviceId.success) {
        params.logDebug?.(
          '[DAEMON RUN] Skipping connected-service provider-activity proof for invalid service id (non-fatal)',
          serviceId.error,
        );
        continue;
      }
      await clearMatchingRuntimeAuthIntents({
        sessionId: input.sessionId,
        recoveryIdentity,
        serviceId: serviceId.data,
      }).catch((error) => {
        params.logDebug?.('[DAEMON RUN] Failed to clear runtime-auth recovery after connected-service provider activity (non-fatal)', error);
      });
      await params.usageLimitRecovery?.markProviderOutcomeProofForSession({
        sessionId: input.sessionId,
        proofKind: 'provider_activity',
        serviceId: serviceId.data,
        profileId: recoveryIdentity.profileId ?? null,
        groupId: recoveryIdentity.groupId ?? null,
      }).catch((error) => {
        params.logDebug?.('[DAEMON RUN] Failed to clear usage-limit recovery after connected-service provider activity (non-fatal)', error);
      });
    }
  };
}
