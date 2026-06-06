import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import {
  surfaceClaudeConnectedServiceRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from './surfaceClaudeRuntimeIssues';

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
}));

function createScheduledRuntimeAuthRecoveryReport(input: Readonly<{ includeTranscriptEvent?: boolean }> = {}) {
  const diagnostic = {
    code: 'recovery_retry_scheduled',
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: 'claude-subscription',
    profileId: 'claude-main',
    groupId: 'team-pool',
    retryable: true,
    suggestedActions: [],
    diagnostics: { runtimeFailureKind: 'usage_limit' },
  };
  const transcriptEvent = {
    type: 'connected-service-runtime-auth-recovery',
    status: 'retry_scheduled',
    serviceId: 'claude-subscription',
    profileId: 'claude-main',
    groupId: 'team-pool',
    nextRetryAtMs: 1_700_000_100_000,
    terminal: false,
    diagnostic,
  };
  return {
    ok: true,
    result: {
      status: 'recovery_retry_scheduled',
      recovery: {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 1_700_000_100_000,
      },
      uxDiagnostic: diagnostic,
      ...(input.includeTranscriptEvent === false ? {} : { transcriptEvent }),
    },
  };
}

function installClaudeSelectionEnv(): string | undefined {
  const previous = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
    kind: 'group',
    serviceId: 'claude-subscription',
    groupId: 'team-pool',
    activeProfileId: 'claude-main',
    fallbackProfileId: 'claude-backup',
    generation: 4,
  }]);
  return previous;
}

function restoreClaudeSelectionEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    return;
  }
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previous;
}

describe('surfaceClaudeRuntimeIssues runtime-auth projection', () => {
  afterEach(() => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({});
  });

  it('commits daemon typed runtime-auth recovery projection for Claude auth failures', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const failTurn = vi.fn(async () => undefined);
    try {
      await surfaceClaudeConnectedServiceRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, { status: 401, message: 'OAuth token has expired' }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'auth_error',
          source: 'auth_error',
          provider: 'claude',
          sanitizedPreview: expect.any(String),
        }),
      });
      expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'claude-subscription',
        diagnostic: expect.objectContaining({
          source: 'runtime_auth_recovery',
          failurePhase: 'runtime_auth_recovery',
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('commits daemon typed runtime-auth recovery projection for Claude usage-limit issues', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn: vi.fn(async () => {}) },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'daily_tokens',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'connected-service-runtime-auth-recovery',
        status: 'retry_scheduled',
        serviceId: 'claude-subscription',
        diagnostic: expect.objectContaining({
          source: 'runtime_auth_recovery',
          failurePhase: 'runtime_auth_recovery',
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('emits a generic recovery message when the daemon report has a typed diagnostic but no transcript event', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport({ includeTranscriptEvent: false }),
    );
    const sendSessionEvent = vi.fn();
    const failTurn = vi.fn(async () => undefined);
    try {
      await surfaceClaudeConnectedServiceRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, { status: 401, message: 'OAuth token has expired' }, '[claude-test]');

      expect(sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: expect.stringContaining('retry scheduled'),
      });
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });
});
