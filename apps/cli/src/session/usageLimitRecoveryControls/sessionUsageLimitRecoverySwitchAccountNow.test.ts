import { describe, expect, it, vi } from 'vitest';
import {
  SessionUsageLimitRecoveryOperationResultV1Schema,
  type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { routeSessionUsageLimitRecoverySwitchAccountNow } from './sessionUsageLimitRecoverySwitchAccountNow';

function createUsageLimitIssue(
  patch: Partial<SessionRuntimeIssueV1> = {},
): SessionRuntimeIssueV1 {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    occurredAt: 1_000,
    provider: 'codex',
    usageLimit: {
      v: 1,
      resetAtMs: 10_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'switch_account',
      connectedService: {
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'happier',
      },
    },
    ...patch,
  };
}

function createRawSession(issue: SessionRuntimeIssueV1 | null): RawSessionRecord {
  return {
    id: 'session-1',
    lastRuntimeIssue: issue,
  } as unknown as RawSessionRecord;
}

function createLocalSwitchAccountParams(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    metadata: {
      machineId: 'machine-current',
      host: 'leeroy-mbp',
      homeDir: '/Users/leeroy',
    },
    currentMachineId: 'machine-current',
    currentMachineHost: 'leeroy-mbp',
    currentMachineHomeDir: '/Users/leeroy',
    ...patch,
  };
}

function parseOperationResult(value: unknown): SessionUsageLimitRecoveryOperationResultV1 {
  const parsed = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Expected SessionUsageLimitRecoveryOperationResultV1: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

describe('routeSessionUsageLimitRecoverySwitchAccountNow', () => {
  it('replays the latest switchable usage-limit issue through runtime auth recovery', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched' },
      },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      request: { sessionId: 'session-1', provider: 'codex' },
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'session-1',
    });
    expect(notifyRuntimeAuthFailure).toHaveBeenCalledWith({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'happier',
        resetsAtMs: 10_000,
      }),
    });
  });

  it('maps no eligible group member to exhausted', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'no_eligible_member' },
      },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'exhausted',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_no_eligible_member',
    });
  });

  it('fails closed when runtime auth recovery returns a malformed success envelope', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: null,
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'malformed_response',
      sessionId: 'session-1',
      errorCode: 'malformed_session_usage_limit_recovery_operation_result',
    });
  });

  it('preserves runtime auth recovery diagnostics when retry is scheduled', async () => {
    const uxDiagnostic = {
      code: 'recovery_retry_scheduled',
      failurePhase: 'runtime_auth_recovery',
      source: 'usage_limit_recovery',
      retryable: true,
      diagnostics: { reason: 'generation_apply_failed' },
      suggestedActions: [],
    };
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        uxDiagnostic,
      },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'session-1',
      uxDiagnostic,
    });
  });

  it('preserves diagnostics from failed runtime auth recovery envelopes', async () => {
    const uxDiagnostic = {
      code: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      source: 'usage_limit_recovery',
      serviceId: 'openai-codex',
      retryable: false,
      suggestedActions: ['resume_current_account'],
    };
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: false,
      errorCode: 'provider_session_state_unavailable_for_resume',
      uxDiagnostic,
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-1',
      errorCode: 'provider_session_state_unavailable_for_resume',
      uxDiagnostic,
    });
  });

  it.each([
    [
      'observed generation',
      { ok: true, result: { status: 'switch_attempted', result: { status: 'observed_generation' } } },
      { ok: true, status: 'switch_observed', sessionId: 'session-1' },
    ],
    [
      'credential refresh',
      { ok: true, result: { status: 'switch_attempted', result: { status: 'credential_refreshed' } } },
      { ok: true, status: 'switch_applied', sessionId: 'session-1' },
    ],
    [
      'direct switched result',
      { ok: true, result: { status: 'switched' } },
      { ok: true, status: 'switch_applied', sessionId: 'session-1' },
    ],
    [
      'direct observed result',
      { ok: true, result: { status: 'observed_generation' } },
      { ok: true, status: 'switch_observed', sessionId: 'session-1' },
    ],
    [
      'direct no eligible member',
      { ok: true, result: { status: 'no_eligible_member' } },
      {
        ok: false,
        status: 'exhausted',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_control_no_eligible_member',
      },
    ],
    [
      'generation apply failure',
      { ok: true, result: { status: 'generation_apply_failed' } },
      {
        ok: false,
        status: 'generation_apply_failed',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_control_switch_failed',
      },
    ],
    [
      'selection mismatch',
      { ok: true, result: { status: 'selection_mismatch' } },
      {
        ok: false,
        status: 'group_conflict',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
      },
    ],
    [
      'unsupported switch coordinator',
      { ok: true, result: { status: 'switch_coordinator_unavailable' } },
      {
        ok: false,
        status: 'unsupported',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_control_switch_unavailable',
      },
    ],
    [
      'session not found',
      { ok: true, result: { status: 'session_not_found' } },
      {
        ok: false,
        status: 'not_found',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_session_not_found',
      },
    ],
    [
      'not classified',
      { ok: true, result: { status: 'not_classified' } },
      {
        ok: false,
        status: 'inactive',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_inactive',
      },
    ],
    [
      'rate limited failure',
      { ok: false, errorCode: 'session_usage_limit_recovery_rate_limited', retryAfterMs: 1_500 },
      {
        ok: false,
        status: 'rate_limited',
        sessionId: 'session-1',
        errorCode: 'session_usage_limit_recovery_rate_limited',
        retryAfterMs: 1_500,
      },
    ],
  ] as const)('emits schema-valid operation result for %s', async (_name, runtimeAuthResponse, expected) => {
    const notifyRuntimeAuthFailure = vi.fn(async () => runtimeAuthResponse);

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual(expected);
  });

  it('rejects provider mismatches before notifying runtime auth recovery', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      request: { sessionId: 'session-1', provider: 'claude' },
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'group_conflict',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
    });
    expect(notifyRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('rejects usage-limit issues without connected-service group switch context', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue({
        usageLimit: {
          v: 1,
          resetAtMs: 10_000,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      })),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_switch_unavailable',
    });
    expect(notifyRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('allows stale machine replacement for switch account when host and home prove same machine locality', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: {
        ...createRawSession(createUsageLimitIssue()),
        machineId: 'machine-stale',
      } as unknown as RawSessionRecord,
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams({
        metadata: {
          machineId: 'machine-stale',
          host: 'LEEROY-MBP.local',
          homeDir: 'C:\\Users\\Leeroy\\',
        },
        currentMachineId: 'machine-current',
        currentMachineHost: 'leeroy-mbp',
        currentMachineHomeDir: 'c:/users/leeroy',
      }),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'session-1',
    });
    expect(notifyRuntimeAuthFailure).toHaveBeenCalledOnce();
  });

  it('rejects switch account recovery before notifying runtime auth when stale machine locality mismatches', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched' } },
    }));

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: {
        ...createRawSession(createUsageLimitIssue()),
        machineId: 'machine-stale',
      } as unknown as RawSessionRecord,
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams({
        metadata: {
          machineId: 'machine-stale',
          host: 'leeroy-mbp',
          homeDir: '/Users/other',
        },
        currentMachineId: 'machine-current',
        currentMachineHost: 'leeroy-mbp',
        currentMachineHomeDir: '/Users/leeroy',
      }),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });
    expect(notifyRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('maps thrown runtime auth recovery failures to a schema-valid generation-apply failure', async () => {
    const notifyRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('daemon rejected switch');
    });

    const result = await routeSessionUsageLimitRecoverySwitchAccountNow({
      sessionId: 'session-1',
      rawSession: createRawSession(createUsageLimitIssue()),
      notifyRuntimeAuthFailure,
      ...createLocalSwitchAccountParams(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'generation_apply_failed',
      sessionId: 'session-1',
      errorCode: 'session_usage_limit_recovery_control_switch_failed',
    });
  });
});
