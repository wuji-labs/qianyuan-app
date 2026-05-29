import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

const mocks = vi.hoisted(() => ({
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ concurrent: 'preserved' }),
  })),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));

import {
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
} from './sessionUsageLimitRecoveryControlRouter';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return {
    id: 'sess_1',
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
    ...overrides,
  } as RawSessionRecord;
}

function createMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machineId: 'machine-local',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      vendorSessionId: 'thread-1',
    }),
    ...overrides,
  };
}

function createUsageLimitIssue(overrides: Partial<{
  resetAtMs: number | null;
  retryAfterMs: number | null;
}> = {}) {
  const resetAtMs = overrides.resetAtMs === undefined ? 1_700_000_060_000 : overrides.resetAtMs;
  const retryAfterMs = overrides.retryAfterMs === undefined ? null : overrides.retryAfterMs;
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    providerTurnId: 'turn-1',
    occurredAt: 1_700_000_000_000,
    usageLimit: {
      v: 1,
      resetAtMs,
      retryAfterMs,
      quotaScope: 'account',
      recoverability: 'wait',
    },
  } as const;
}

const ctx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

describe('sessionUsageLimitRecoveryControlRouter', () => {
  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
  });

  it('arms inactive local wait-resume from the latest usage-limit issue without live session RPC', async () => {
    const callLiveSessionRpc = vi.fn();

    await expect(routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue(),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    })).resolves.toMatchObject({
      ok: true,
      recovery: {
        status: 'waiting',
      },
      metadata: {
        concurrent: 'preserved',
        sessionUsageLimitRecoveryV1: {
          status: 'waiting',
          issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
          resetAtMs: 1_700_000_060_000,
          nextCheckAtMs: 1_700_000_060_000,
          selectedAuth: { kind: 'native' },
        },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('arms inactive local wait-resume from retry-after timing when no reset timestamp exists', async () => {
    const callLiveSessionRpc = vi.fn();

    await expect(routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createUsageLimitIssue({
          resetAtMs: null,
          retryAfterMs: 90_000,
        }),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', remember: true },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    })).resolves.toMatchObject({
      ok: true,
      recovery: {
        status: 'waiting',
      },
      metadata: {
        sessionUsageLimitRecoveryV1: {
          status: 'waiting',
          issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
          resetAtMs: null,
          nextCheckAtMs: 1_700_000_090_000,
          selectedAuth: { kind: 'native' },
        },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('clears inactive local wait-resume metadata without live session RPC', async () => {
    const recovery = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
    };
    const callLiveSessionRpc = vi.fn();

    await expect(routeSessionUsageLimitRecoveryWaitResumeCancel({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ sessionUsageLimitRecoveryV1: recovery }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', issueFingerprint: null },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    })).resolves.toEqual({
      ok: true,
      recovery: { status: 'cancelled' },
      metadata: { concurrent: 'preserved' },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('returns a stable provider-unsupported result for inactive check-now without a provider adapter', async () => {
    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => null),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_usage_limit_recovery_control_provider_unsupported',
      error: 'session_usage_limit_recovery_control_provider_unsupported',
    });
  });

  it('uses the request provider for inactive check-now when session metadata is stale', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resolveAdapter = vi.fn(async (agentId) => (
      agentId === 'codex' ? { checkNow } : null
    ));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    })).resolves.toEqual({ ok: true, status: 'ready' });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(checkNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      }),
    }));
  });

  it('resumes an inactive local session when check-now returns ready', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      status: 'ready',
      metadata: {
        machineId: 'machine-local',
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'cancelled',
          issueFingerprint: 'usage-limit:claude:turn-1:1:2',
          armedAtMs: 1,
          resetAtMs: 2,
          nextCheckAtMs: 2,
          attemptCount: 1,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
        },
      },
    }));

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession(),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    })).resolves.toMatchObject({
      ok: true,
      status: 'resumed',
    });

    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({ status: 'cancelled' }),
      }),
    }));
  });

  it('rate-limits repeated inactive check-now probes before calling the provider adapter again', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resolveAdapter = vi.fn(async () => ({ checkNow }));
    const params = {
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_rate_limited',
      rawSession: createRawSession({ id: 'sess_rate_limited' }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain' as const,
      request: { sessionId: 'sess_rate_limited', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter,
    };

    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toEqual({ ok: true, status: 'ready' });
    await expect(routeSessionUsageLimitRecoveryCheckNow(params)).resolves.toEqual({
      ok: false,
      errorCode: 'probe_rate_limited',
      error: 'probe_rate_limited',
      retryAfterMs: expect.any(Number),
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('keeps active wait-resume enable on live session RPC when supported', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    await expect(routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({ active: true }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1' },
      callLiveSessionRpc,
      resolveAdapter: vi.fn(),
    })).resolves.toEqual({ ok: true, recovery: { status: 'waiting' } });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });
});
