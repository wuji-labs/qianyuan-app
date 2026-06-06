import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import {
  SessionUsageLimitRecoveryOperationResultV1Schema,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';
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

function createTemporaryThrottleIssue() {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'provider_temporary_throttle',
    source: 'provider_status_error',
    provider: 'codex',
    providerTurnId: 'turn-throttle',
    occurredAt: 1_700_000_000_000,
    sanitizedPreview: 'Provider is temporarily limiting requests',
    temporaryThrottle: {
      v: 1,
      retryAfterMs: 30_000,
      recoverability: 'retry',
    },
  } as const;
}

const ctx = {
  encryptionKey: new Uint8Array(32).fill(1),
  encryptionVariant: 'legacy' as const,
};

function parseOperationResult(value: unknown): SessionUsageLimitRecoveryOperationResultV1 {
  const parsed = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Expected SessionUsageLimitRecoveryOperationResultV1: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function lastMetadataUpdaterResult(input: Record<string, unknown>): Record<string, unknown> {
  const call = mocks.updateSessionMetadataWithRetry.mock.calls.at(-1)?.[0];
  if (!call) throw new Error('Expected updateSessionMetadataWithRetry to be called');
  return call.updater(input);
}

describe('sessionUsageLimitRecoveryControlRouter', () => {
  beforeEach(() => {
    mocks.updateSessionMetadataWithRetry.mockClear();
  });

  it('arms inactive local wait-resume from the latest usage-limit issue without live session RPC', async () => {
    const callLiveSessionRpc = vi.fn();

    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(lastMetadataUpdaterResult({ concurrent: 'preserved' })).toMatchObject({
      concurrent: 'preserved',
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:1700000060000',
        resetAtMs: 1_700_000_060_000,
        nextCheckAtMs: 1_700_000_060_000,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('arms inactive local wait-resume from retry-after timing when no reset timestamp exists', async () => {
    const callLiveSessionRpc = vi.fn();

    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(lastMetadataUpdaterResult({})).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        status: 'waiting',
        issueFingerprint: 'usage-limit:codex:turn-1:1700000000000:no-reset',
        resetAtMs: null,
        nextCheckAtMs: 1_700_000_090_000,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('routes temporary-throttle retry-now to the daemon-lifetime throttle scheduler', async () => {
    const callLiveSessionRpc = vi.fn();
    const retryTemporaryThrottleNow = vi.fn(async () => ({ status: 'resumed' }));
    const resolveAdapter = vi.fn();

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      rawSession: createRawSession({
        active: true,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: createTemporaryThrottleIssue(),
      }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_1', provider: 'codex' },
      callLiveSessionRpc,
      resolveAdapter,
      retryTemporaryThrottleNow,
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });
    expect(retryTemporaryThrottleNow).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
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

    const result = await routeSessionUsageLimitRecoveryWaitResumeCancel({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
    });
    expect(lastMetadataUpdaterResult({ concurrent: 'preserved', sessionUsageLimitRecoveryV1: recovery }))
      .toEqual({ concurrent: 'preserved' });

    expect(callLiveSessionRpc).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
  });

  it('returns a schema-valid inactive result when wait-resume cannot derive a recovery issue', async () => {
    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      rawSession: createRawSession({ id: 'sess_inactive' }),
      metadata: createMetadata(),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_inactive', remember: true },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'inactive',
      sessionId: 'sess_inactive',
      errorCode: 'session_usage_limit_recovery_control_inactive',
    });
  });

  it('returns a stable provider-unsupported result for inactive check-now without a provider adapter', async () => {
    const result = await routeSessionUsageLimitRecoveryCheckNow({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'session_usage_limit_recovery_control_provider_unsupported',
    });
  });

  it('uses the request provider for inactive check-now when session metadata is stale', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const resolveAdapter = vi.fn(async (agentId) => (
      agentId === 'codex' ? { checkNow } : null
    ));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_1',
    });

    expect(resolveAdapter).toHaveBeenCalledWith('codex');
    expect(checkNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      }),
    }));
  });

  it('accepts inactive check-now on a re-registered daemon when host and home still match', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_same_machine',
      rawSession: createRawSession({
        id: 'sess_stale_same_machine',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'leeroy-mbp',
        homeDir: '/Users/leeroy',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: '/Users/leeroy/',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_same_machine', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_stale_same_machine',
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('accepts inactive check-now on a re-registered Windows daemon when host case and home separators drift', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_windows_machine',
      rawSession: createRawSession({
        id: 'sess_stale_windows_machine',
        path: 'C:\\Users\\Leeroy\\workspace\\repo',
        machineId: 'machine-before-restart',
      }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'LEEROY-MBP.local',
        homeDir: 'C:\\Users\\Leeroy\\',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: 'c:/users/leeroy',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_windows_machine', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_stale_windows_machine',
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('rejects inactive check-now on a stale machine id when the current daemon home differs', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_home_mismatch',
      rawSession: createRawSession({ id: 'sess_stale_home_mismatch', machineId: 'machine-before-restart' }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'leeroy-mbp',
        homeDir: '/Users/leeroy',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'leeroy-mbp',
      currentMachineHomeDir: '/Users/other',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_home_mismatch', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_stale_home_mismatch',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
  });

  it('rejects inactive check-now on a stale machine id when the current daemon host differs', async () => {
    const checkNow = vi.fn(async () => ({ ok: true, status: 'ready' }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_stale_host_mismatch',
      rawSession: createRawSession({ id: 'sess_stale_host_mismatch', machineId: 'machine-before-restart' }),
      metadata: createMetadata({
        machineId: 'machine-before-restart',
        host: 'old-host',
        homeDir: '/Users/leeroy',
      }),
      currentMachineId: 'machine-after-restart',
      currentMachineHost: 'new-host',
      currentMachineHomeDir: '/Users/leeroy',
      ctx,
      mode: 'plain',
      request: { sessionId: 'sess_stale_host_mismatch', provider: 'codex' },
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_stale_host_mismatch',
      errorCode: 'session_usage_limit_recovery_control_remote_unavailable',
    });

    expect(checkNow).not.toHaveBeenCalled();
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

    const result = await routeSessionUsageLimitRecoveryCheckNow({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });

    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      metadata: expect.objectContaining({
        sessionUsageLimitRecoveryV1: expect.objectContaining({ status: 'cancelled' }),
      }),
    }));
  });

  it('resumes an inactive local session when check-now normalizes to ready', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'ready',
      },
      metadata: {
        machineId: 'machine-local',
      },
    }));

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_nested_ready',
      rawSession: createRawSession({ id: 'sess_nested_ready' }),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_nested_ready',
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledTimes(1);
  });

  it('does not surface ready when inactive check-now cannot resume the local session', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => false);
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

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_resume_failed',
      rawSession: createRawSession({ id: 'sess_resume_failed' }),
      metadata: createMetadata({ agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' } }),
      currentMachineId: 'machine-local',
      ctx,
      mode: 'plain',
      callLiveSessionRpc: vi.fn(),
      resolveAdapter: vi.fn(async () => ({ checkNow })),
      resumeInactiveSessionWhenReady,
    });

    expect(parseOperationResult(result)).toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess_resume_failed',
      errorCode: 'session_usage_limit_recovery_resume_failed',
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledTimes(1);
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

    expect(parseOperationResult(await routeSessionUsageLimitRecoveryCheckNow(params))).toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_rate_limited',
    });
    expect(parseOperationResult(await routeSessionUsageLimitRecoveryCheckNow(params))).toEqual({
      ok: false,
      status: 'rate_limited',
      sessionId: 'sess_rate_limited',
      errorCode: 'probe_rate_limited',
      retryAfterMs: expect.any(Number),
    });

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('keeps active wait-resume enable on live session RPC when supported', async () => {
    const callLiveSessionRpc = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    const result = await routeSessionUsageLimitRecoveryWaitResumeEnable({
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
    });

    expect(parseOperationResult(result)).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });

    expect(callLiveSessionRpc).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });
});
