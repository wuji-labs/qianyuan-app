import { describe, expect, it, vi } from 'vitest';

import { reportConnectedServiceRuntimeAuthFailureToDaemon } from './reportConnectedServiceRuntimeAuthFailureToDaemon';
import {
  readRuntimeAuthFailureReportOutboxItems,
} from './reportOutbox/runtimeAuthFailureReportOutbox';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const classifiedFailure = {
  kind: 'auth_expired',
  serviceId: 'openai-codex',
  profileId: 'work',
  groupId: 'codex-group',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'stable_provider_message',
} as const;

describe('reportConnectedServiceRuntimeAuthFailureToDaemon', () => {
  it('preserves typed recovery diagnostics returned by the daemon', async () => {
    const uxDiagnostic = {
      code: 'recovery_retry_scheduled',
      failurePhase: 'runtime_auth_recovery',
      source: 'runtime_auth_recovery',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
      retryable: true,
      suggestedActions: ['retry'],
      diagnostics: {
        runtimeFailureKind: 'usage_limit',
        nextRetryAtMs: 1_700_000_100_000,
      },
    };
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        recovery: {
          status: 'scheduled',
          retryable: true,
          nextRetryAtMs: 1_700_000_100_000,
        },
        uxDiagnostic,
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
      notify,
    })).resolves.toMatchObject({
      handled: true,
      statusCode: 'recovery_retry_scheduled',
      statusMessage: expect.stringContaining('retry scheduled'),
      uxDiagnostic,
      projection: {
        handled: true,
        statusCode: 'recovery_retry_scheduled',
        nextRetryAtMs: 1_700_000_100_000,
        terminal: false,
        uxDiagnostic,
      },
    });
  });

  it('returns the daemon report and resolved status message when recovery is actionable', async () => {
    const classification = {
      kind: 'auth_expired',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'credential_refreshed',
        restartRequested: true,
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 2,
      classification,
      notify,
    })).resolves.toMatchObject({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      },
      statusCode: 'credential_refreshed_restart_requested',
      statusMessage: expect.stringContaining('refreshed'),
    });
    expect(notify).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      switchesThisTurn: 2,
      classification,
    }, {
      timeoutMs: 120_000,
    });
  });

  it('uses a runtime-auth-specific daemon timeout so quota probing and switch application can finish', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    }));

    await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      },
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.any(Object), {
      timeoutMs: 120_000,
    });
  });

  it('treats typed generation apply failures as handled recovery reports', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'provider_session_state_unavailable_for_resume',
        },
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      },
      notify,
    })).resolves.toMatchObject({
      handled: true,
      report: {
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'provider_session_state_unavailable_for_resume',
          },
        },
      },
      statusCode: 'switch_attempted_generation_apply_failed',
      statusMessage: expect.stringContaining('provider_session_state_unavailable_for_resume'),
    });
  });

  it('surfaces degraded temporary-throttle recovery as a handled manual-retry projection', async () => {
    const notify = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'temporary_retry_unavailable',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
        retryAfterMs: 45_000,
        reason: 'manual_retry_required',
      },
    }));

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: {
        kind: 'provider_temporary_throttle',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      },
      notify,
    })).resolves.toMatchObject({
      handled: true,
      statusCode: 'temporary_retry_manual_retry_required',
      statusMessage: expect.stringContaining('manual'),
      projection: {
        handled: true,
        statusCode: 'temporary_retry_manual_retry_required',
        statusMessage: expect.stringContaining('retry'),
      },
    });
  });

  it('logs and returns an unhandled result when daemon notification fails', async () => {
    const debug = vi.fn();
    const error = new Error('daemon unavailable');

    await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: { kind: 'unknown' },
      notify: vi.fn(async () => {
        throw error;
      }),
      logger: { debug },
      logPrefix: '[test]',
    })).resolves.toEqual({
      handled: false,
      report: null,
      statusCode: null,
      statusMessage: null,
    });
    expect(debug).toHaveBeenCalledWith(
      '[test] Failed to report connected-service runtime auth failure to daemon (non-fatal)',
      error,
    );
  });

  it('enqueues a sanitized outbox report when daemon notification fails', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-helper-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 2,
        classification: {
          ...classifiedFailure,
          accessToken: 'secret-access-token',
          env: { OPENAI_API_KEY: 'secret-env-value' },
          rawProviderPayload: { body: 'raw-provider-body' },
        },
        notify: vi.fn(async () => {
          throw new Error('daemon unavailable');
        }),
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: null,
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_1',
        switchesThisTurn: 2,
        classification: classifiedFailure,
        attemptCount: 1,
      });
      expect(JSON.stringify(items[0])).not.toContain('secret-access-token');
      expect(JSON.stringify(items[0])).not.toContain('secret-env-value');
      expect(JSON.stringify(items[0])).not.toContain('raw-provider-body');
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('enqueues a sanitized outbox report when daemon returns an unhandled local-control error', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-unhandled-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          error: 'No daemon running, no state file found',
        })),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          error: 'No daemon running, no state file found',
        },
      });

      const items = await readRuntimeAuthFailureReportOutboxItems({ outboxDir });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
      });
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('does not enqueue when daemon returns an accepted report that is not a local-control error', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-accepted-unprojected-');
    try {
      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          ok: true,
          result: {
            status: 'accepted_unprojected_test_status',
          },
        })),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      })).resolves.toMatchObject({
        handled: false,
        report: {
          ok: true,
          result: {
            status: 'accepted_unprojected_test_status',
          },
        },
      });

      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('removes a matching outbox report when daemon notification succeeds and is handled', async () => {
    const outboxDir = await createTempDir('happier-runtime-auth-report-outbox-clear-');
    try {
      await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => {
          throw new Error('daemon unavailable');
        }),
        logger: { debug: vi.fn() },
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_000,
      });
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(1);

      await expect(reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: 'sess_1',
        switchesThisTurn: 1,
        classification: classifiedFailure,
        notify: vi.fn(async () => ({
          ok: true,
          result: {
            status: 'credential_refreshed',
            restartRequested: true,
          },
        })),
        reportOutboxDir: outboxDir,
        nowMs: () => 1_700_000_000_100,
      })).resolves.toMatchObject({
        handled: true,
        statusCode: 'credential_refreshed_restart_requested',
      });

      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });
});
