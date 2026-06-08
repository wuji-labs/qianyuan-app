import type { ConnectedServiceId, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { listMatchingRuntimeAuthRecoveryIntents } from '../runtimeAuth/matchRuntimeAuthRecoveryIntent';

export type ConnectedServiceRecoverySoftSwitchGuardInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  reason: 'soft_threshold' | 'usage_limit';
}>;

export type ConnectedServiceRecoverySoftSwitchGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress'; reason: string }>;

type RuntimeAuthRecoveryReader = Readonly<{
  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent>;
}>;

type UsageLimitRecoveryReader = Readonly<{
  read(sessionId: string): SessionUsageLimitRecoveryV1 | null;
}>;

export const QUOTA_SOFT_SWITCH_SUPPRESSED_RECOVERY_PENDING_REASON =
  'quota_soft_switch_suppressed_recovery_pending';

function isPendingRuntimeAuthRecovery(intent: RuntimeAuthRecoveryIntent | null): boolean {
  return intent?.status === 'waiting'
    || intent?.status === 'checking';
}

function hasPendingRuntimeAuthRecovery(input: Readonly<{
  runtimeAuthRecovery: RuntimeAuthRecoveryReader | null | undefined;
  target: ConnectedServiceRecoverySoftSwitchGuardInput;
}>): boolean {
  if (!input.runtimeAuthRecovery) return false;
  const intents = input.runtimeAuthRecovery.readForSession(input.target.sessionId);
  return listMatchingRuntimeAuthRecoveryIntents(intents, {
    serviceId: input.target.serviceId,
    groupId: input.target.groupId,
    profileId: input.target.activeProfileId,
  }).some((intent) => isPendingRuntimeAuthRecovery(intent));
}

function isPendingUsageLimitRecovery(intent: SessionUsageLimitRecoveryV1 | null): boolean {
  return intent?.status === 'armed' || intent?.status === 'waiting' || intent?.status === 'checking';
}

function usageLimitRecoveryMatchesTarget(input: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  target: ConnectedServiceRecoverySoftSwitchGuardInput;
}>): boolean {
  const selectedAuth = input.intent.selectedAuth;
  if (selectedAuth.kind !== 'group') return false;
  return selectedAuth.serviceId === input.target.serviceId
    && selectedAuth.groupId === input.target.groupId
    && selectedAuth.profileId === input.target.activeProfileId;
}

function hasPendingUsageLimitRecovery(input: Readonly<{
  usageLimitRecovery: UsageLimitRecoveryReader | null | undefined;
  target: ConnectedServiceRecoverySoftSwitchGuardInput;
}>): boolean {
  const intent = input.usageLimitRecovery?.read(input.target.sessionId) ?? null;
  return Boolean(
    intent
    && isPendingUsageLimitRecovery(intent)
    && usageLimitRecoveryMatchesTarget({ intent, target: input.target }),
  );
}

export function createConnectedServiceRecoverySwitchGuard(deps: Readonly<{
  runtimeAuthRecovery?: RuntimeAuthRecoveryReader | null;
  usageLimitRecovery?: UsageLimitRecoveryReader | null;
}>): (input: ConnectedServiceRecoverySoftSwitchGuardInput) => Promise<ConnectedServiceRecoverySoftSwitchGuardResult> {
  return async (input) => {
    if (
      hasPendingRuntimeAuthRecovery({ runtimeAuthRecovery: deps.runtimeAuthRecovery, target: input })
      || hasPendingUsageLimitRecovery({ usageLimitRecovery: deps.usageLimitRecovery, target: input })
    ) {
      return {
        status: 'suppress',
        reason: QUOTA_SOFT_SWITCH_SUPPRESSED_RECOVERY_PENDING_REASON,
      };
    }
    return { status: 'allow' };
  };
}
