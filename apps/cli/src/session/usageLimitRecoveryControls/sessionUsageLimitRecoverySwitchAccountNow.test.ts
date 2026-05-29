import { describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

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
    });

    expect(result).toEqual({ ok: true, status: 'waiting' });
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
    });

    expect(result).toEqual({ ok: true, status: 'exhausted' });
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
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
      error: 'session_usage_limit_recovery_control_issue_mismatch',
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
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_switch_unavailable',
      error: 'session_usage_limit_recovery_control_switch_unavailable',
    });
    expect(notifyRuntimeAuthFailure).not.toHaveBeenCalled();
  });
});
