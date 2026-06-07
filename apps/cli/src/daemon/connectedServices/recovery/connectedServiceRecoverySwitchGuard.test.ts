import { describe, expect, it, vi } from 'vitest';

import type { UsageLimitRecoveryIntent } from '../usageLimitRecovery/UsageLimitRecoveryScheduler';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from '../runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import { createConnectedServiceRecoverySwitchGuard } from './connectedServiceRecoverySwitchGuard';

const SERVICE_ID = 'openai-codex' as const;

function runtimeAuthIntent(input: Readonly<{
  sessionId: string;
  serviceId: typeof SERVICE_ID;
  profileId: string | null;
  groupId: string | null;
  status?: RuntimeAuthRecoveryIntent['status'];
}>): RuntimeAuthRecoveryIntent {
  return {
    v: 1,
    sessionId: input.sessionId,
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    status: input.status ?? 'waiting',
    armedAtMs: 1_000,
    nextRetryAtMs: 2_000,
    attemptCount: 0,
    maxAttempts: 5,
    switchesThisTurn: 1,
    classification: {
      kind: 'usage_limit',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
      recoveryAction: { kind: 'quota_recovery_required' },
    },
    failurePhase: 'handler',
    failureReason: 'usage_limit',
    lastError: 'usage limit',
    lastErrorClassification: null,
    terminalAtMs: null,
  };
}

function usageLimitIntent(input: Readonly<{
  status?: UsageLimitRecoveryIntent['status'];
  serviceId: typeof SERVICE_ID;
  groupId: string;
  profileId: string;
}>): UsageLimitRecoveryIntent {
  return {
    v: 1,
    issueFingerprint: 'usage-limit:test',
    status: input.status ?? 'waiting',
    armedAtMs: 1_000,
    resetAtMs: 3_000,
    nextCheckAtMs: 3_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    selectedAuth: {
      kind: 'group',
      serviceId: input.serviceId,
      groupId: input.groupId,
      profileId: input.profileId,
    },
  };
}

describe('createConnectedServiceRecoverySwitchGuard', () => {
  it('suppresses a quota soft switch when a matching runtime-auth recovery is pending', async () => {
    const key = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      profileId: 'active',
      groupId: 'team',
    });
    const runtimeAuthRecovery = {
      readByKey: vi.fn((recoveryKey: string) => recoveryKey === key
        ? runtimeAuthIntent({
          sessionId: 'session-1',
          serviceId: SERVICE_ID,
          profileId: 'active',
          groupId: 'team',
        })
        : null),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery,
      usageLimitRecovery: null,
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'quota_soft_switch_suppressed_recovery_pending',
    });
    expect(runtimeAuthRecovery.readByKey).toHaveBeenCalledWith(key);
  });

  it('suppresses a quota soft switch when a matching usage-limit recovery is waiting', async () => {
    const runtimeAuthRecovery = { readByKey: vi.fn(() => null) };
    const usageLimitRecovery = {
      read: vi.fn(() => usageLimitIntent({
        serviceId: SERVICE_ID,
        groupId: 'team',
        profileId: 'active',
      })),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery,
      usageLimitRecovery,
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'quota_soft_switch_suppressed_recovery_pending',
    });
    expect(usageLimitRecovery.read).toHaveBeenCalledWith('session-1');
  });

  it('allows a quota soft switch when pending recovery belongs to another identity', async () => {
    const runtimeAuthRecovery = { readByKey: vi.fn(() => null) };
    const usageLimitRecovery = {
      read: vi.fn(() => usageLimitIntent({
        serviceId: SERVICE_ID,
        groupId: 'other-team',
        profileId: 'active',
      })),
    };
    const guard = createConnectedServiceRecoverySwitchGuard({
      runtimeAuthRecovery,
      usageLimitRecovery,
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({ status: 'allow' });
  });
});
