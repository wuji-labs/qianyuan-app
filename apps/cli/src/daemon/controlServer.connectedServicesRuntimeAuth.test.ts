import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { createDaemonControlApp, startDaemonControlServer } from './controlServer';
import { buildRuntimeAuthRecoveryKey } from './connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryDiagnostic,
} from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import type { ConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/types';

describe('createDaemonControlApp connected-service runtime auth handling', () => {
  it('dispatches manual session auth switches to the daemon handler', async () => {
    const handleSessionConnectedServiceAuthSwitch = vi.fn(async () => ({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
      warnings: [],
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleSessionConnectedServiceAuthSwitch,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/session/switch',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          agentId: 'claude',
          bindings: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          rematerializeServiceId: 'anthropic',
          expectedGroupGenerationByServiceId: { anthropic: 4 },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          ok: true,
          action: 'restart_requested',
          normalizedBindings: {
            v: 1,
            bindingsByServiceId: {
              anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          continuityByServiceId: { anthropic: 'restart_rematerialize' },
          warnings: [],
        },
      });
      expect(handleSessionConnectedServiceAuthSwitch).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
        rematerializeServiceId: 'anthropic',
        expectedGroupGenerationByServiceId: { anthropic: 4 },
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches reported provider runtime auth failure kinds to the daemon handler', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'capacity',
            limitCategory: 'capacity',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        },
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'capacity',
          serviceId: 'openai-codex',
          limitCategory: 'capacity',
          groupId: 'main',
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('does NOT clear the recovery intent for credential_refreshed without provider-outcome proof', async () => {
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'credential_refreshed',
      restartRequested: true,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      });
      // No deterministic provider-outcome proof => recovery stays pending.
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does NOT clear the recovery intent for a generic ok:true switch result without proof', async () => {
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        ok: true,
        action: 'restart_requested',
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            ok: true,
            action: 'restart_requested',
          },
        },
      });
      // No deterministic provider-outcome proof => recovery stays pending.
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('clears the matching runtime-auth recovery key when account adoption is verified', async () => {
    const cancel = vi.fn(async () => ({ status: 'cancelled' }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { cancel, cancelByKey, markSucceededByKey },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(markSucceededByKey).toHaveBeenCalledWith(buildRuntimeAuthRecoveryKey({
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
      }));
      expect(cancel).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('actually clears the recovery intent on proven success via a real scheduler (unbound-method regression)', async () => {
    // Regression for the unbound-method bug: controlServer used to extract
    // `scheduler.markSucceededByKey` into a local and call it, losing `this`, so
    // `markSucceededByKey` threw "Cannot read properties of undefined (reading
    // 'readByKey')" — swallowed by `.catch` — and the intent was never cleared.
    // This drives a REAL scheduler instance end-to-end through the control server.
    const recoveryClassification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } as ConnectedServiceRuntimeFailureClassification;
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      // Inner recover never runs in this flow; the control-server success branch
      // clears the pre-armed intent directly.
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    // Arm a waiting recovery intent that the success branch must clear.
    await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: recoveryClassification,
      error: new Error('timeout of 5000ms exceeded'),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
    });
    expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).not.toBeNull();

    // Proven success: switch with verified account adoption.
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: recoveryClassification,
        },
      });

      expect(response.statusCode).toBe(200);
      // The intent is actually gone, proving markSucceededByKey ran without
      // throwing the unbound-method error.
      expect(runtimeAuthRecoveryScheduler.readByKey(recoveryKey)).toBeNull();
      expect(diagnostics.map((event) => event.event)).toContain('runtime_auth_recovery_success');
    } finally {
      await app.close();
    }
  });

  it('returns a typed recovery failure when runtime auth handling throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_handler_failed',
          errorCode: 'unexpected_error',
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth failure handler failed',
        expect.objectContaining({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          kind: 'usage_limit',
        }),
      );
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('preserves generation apply failure results when recovery scheduling fails', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'post_switch_verification_failed',
      },
    }));
    const enqueueApplyFailure = vi.fn(async () => {
      throw new Error('intent store unavailable');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'post_switch_verification_failed',
          },
        },
      });
      expect(enqueueApplyFailure).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    } finally {
      debugSpy.mockRestore();
      await app.close();
    }
  });

  it('returns scheduled runtime-auth recovery diagnostics with retry metadata', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'hot_apply_failed',
      },
    }));
    const enqueueApplyFailure = vi.fn(async () => ({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 1_700_000_100_000,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: 'recovery_retry_scheduled',
          recovery: {
            status: 'scheduled',
            retryable: true,
            nextRetryAtMs: 1_700_000_100_000,
          },
          uxDiagnostic: {
            code: 'recovery_retry_scheduled',
            failurePhase: 'runtime_auth_recovery',
            source: 'runtime_auth_recovery',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            retryable: true,
            diagnostics: {
              runtimeFailureKind: 'usage_limit',
              classificationSource: 'structured_provider_error',
              nextRetryAtMs: 1_700_000_100_000,
            },
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
      expectedStatus: 'recovery_dead_lettered',
    },
    {
      name: 'cancelled',
      recovery: {
        status: 'cancelled',
        retryable: false,
      },
      expectedStatus: 'recovery_cancelled',
    },
    {
      name: 'terminal non-retry',
      recovery: {
        status: 'terminal_non_retry',
        retryable: false,
      },
      expectedStatus: 'recovery_terminal',
    },
  ])('surfaces terminal apply-failure recovery scheduling results: $name', async ({
    recovery,
    expectedStatus,
  }) => {
    const originalResult = {
      status: 'switch_attempted',
      result: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 2,
        errorCode: 'hot_apply_failed',
      },
    };
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => originalResult);
    const enqueueApplyFailure = vi.fn(async () => recovery);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueApplyFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery,
          originalResult,
          terminal: true,
        },
      });
      expect(response.json().result.status).not.toBe('switch_attempted');
      expect(response.json().result.status).not.toBe('recovery_retry_scheduled');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      expect(enqueueApplyFailure).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
      expectedStatus: 'recovery_dead_lettered',
    },
    {
      name: 'cancelled',
      recovery: {
        status: 'cancelled',
        retryable: false,
      },
      expectedStatus: 'recovery_cancelled',
    },
    {
      name: 'terminal non-retry',
      recovery: {
        status: 'terminal_non_retry',
        retryable: false,
      },
      expectedStatus: 'recovery_terminal',
    },
  ])('surfaces terminal handler-failure recovery scheduling results: $name', async ({
    recovery,
    expectedStatus,
  }) => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const enqueueHandlerFailure = vi.fn(async () => recovery);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueHandlerFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 1,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery,
          terminal: true,
        },
      });
      expect(response.json().result.status).not.toBe('recovery_handler_failed');
      expect(response.json().result.status).not.toBe('recovery_retry_scheduled');
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      expect(enqueueHandlerFailure).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it.each([
    {
      name: 'exhausted',
      prepare: async (input: Readonly<{
        scheduler: RuntimeAuthRecoveryScheduler;
        sessionId: string;
        classification: ConnectedServiceRuntimeFailureClassification;
        applyFailure: unknown;
      }>) => {
        await input.scheduler.enqueueApplyFailure({
          sessionId: input.sessionId,
          switchesThisTurn: 1,
          classification: input.classification,
          result: input.applyFailure,
        });
        await expect(input.scheduler.wake({ sessionId: input.sessionId, reason: 'manual' }))
          .resolves.toEqual({ status: 'exhausted' });
      },
      expectedStatus: 'recovery_dead_lettered',
      expectedRecoveryStatus: 'exhausted',
      expectedDeadLetterEvents: 1,
    },
    {
      name: 'cancelled',
      prepare: async (input: Readonly<{
        scheduler: RuntimeAuthRecoveryScheduler;
        sessionId: string;
        classification: ConnectedServiceRuntimeFailureClassification;
        applyFailure: unknown;
      }>) => {
        await input.scheduler.enqueueApplyFailure({
          sessionId: input.sessionId,
          switchesThisTurn: 1,
          classification: input.classification,
          result: input.applyFailure,
        });
        await input.scheduler.cancelByKey(buildRuntimeAuthRecoveryKey({
          sessionId: input.sessionId,
          serviceId: input.classification.serviceId,
          profileId: input.classification.profileId,
          groupId: input.classification.groupId,
        }));
      },
      expectedStatus: 'recovery_cancelled',
      expectedRecoveryStatus: 'cancelled',
      expectedDeadLetterEvents: 0,
    },
  ])('does not re-emit a terminal transcript event for an already $name recovery', async ({
    prepare,
    expectedStatus,
    expectedRecoveryStatus,
    expectedDeadLetterEvents,
  }) => {
    const sessionId = 'sess_1';
    const classification = {
      kind: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    } satisfies ConnectedServiceRuntimeFailureClassification;
    const applyFailure = {
      status: 'generation_apply_failed',
      errorCode: 'hot_apply_failed',
      diagnostics: {
        underlyingError: 'timeout of 5000ms exceeded',
      },
    };
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => applyFailure,
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    await prepare({ scheduler, sessionId, classification, applyFailure });

    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: applyFailure,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: scheduler,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId,
          switchesThisTurn: 2,
          classification,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        ok: true,
        result: {
          status: expectedStatus,
          recovery: {
            status: expectedRecoveryStatus,
            retryable: false,
          },
          originalResult: {
            status: 'switch_attempted',
            result: applyFailure,
          },
          terminal: true,
        },
      });
      expect(body.result).not.toHaveProperty('transcriptEvent');
      expect(diagnostics.filter((event) => (
        event.event === 'runtime_auth_recovery_dead_letter' && event.transcriptEvent
      ))).toHaveLength(expectedDeadLetterEvents);
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns typed handler failures when handler recovery scheduling also fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('switch coordinator crashed');
    });
    const enqueueHandlerFailure = vi.fn(async () => {
      throw new Error('intent store unavailable');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { enqueueHandlerFailure },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'recovery_handler_failed',
          errorCode: 'unexpected_error',
        },
      });
      expect(enqueueHandlerFailure).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('sanitizes raw handler error messages before logging runtime auth diagnostics', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => {
      throw new Error('refresh failed Bearer raw-secret-token accessToken=raw-access-token');
    });
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('raw-secret-token');
      expect(logged).not.toContain('raw-access-token');
      expect(logged).toContain('[REDACTED]');
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('dispatches reported in-band quota snapshots to the daemon handler', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-quota-snapshot',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { status: 'recorded' },
      });
      expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        snapshot: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'primary',
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches session turn lifecycle events to the daemon handler', async () => {
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({ ok: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceTurnLifecycle,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-turn-lifecycle',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          event: 'task_started',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { ok: true },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'task_started',
      });
    } finally {
      await app.close();
    }
  });

  it('dispatches Codex ChatGPT refresh bridge requests to the daemon handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_123',
          chatgptPlanType: 'plus',
        },
      });
      expect(response.json().result).not.toHaveProperty('refreshToken');
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        },
        chatgptPlanType: 'plus',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects Codex ChatGPT refresh bridge payloads with invalid group ids before they reach the handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          selection: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: '../escape',
            activeProfileId: 'backup',
            fallbackProfileId: 'work',
            generation: 7,
          },
          chatgptPlanType: 'plus',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(handleCodexChatGptAuthTokensRefresh).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('startDaemonControlServer connected-service runtime wiring', () => {
  it('wires reported runtime auth failures to the production control server handler', async () => {
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: null,
        reason: 'usage_limit',
      },
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-runtime-auth/failure`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: null,
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'reconnect_profile',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: null,
            reason: 'usage_limit',
          },
        },
      });
      expect(handleConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'usage_limit',
          serviceId: 'openai-codex',
        }),
      });
    } finally {
      await server.stop();
    }
  });

  it('wires reported quota snapshots to the production control server handler', async () => {
    const handleConnectedServiceQuotaSnapshot = vi.fn(async () => ({
      status: 'recorded',
      groupRuntimeStateRecorded: true,
      quotaStateRecorded: true,
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceQuotaSnapshot,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-quota-snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          serviceId: 'openai-codex',
          snapshot: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'primary',
            fetchedAt: 1_000,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: null,
            meters: [],
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          status: 'recorded',
          groupRuntimeStateRecorded: true,
          quotaStateRecorded: true,
        },
      });
      expect(handleConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        snapshot: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'primary',
        }),
      });
    } finally {
      await server.stop();
    }
  });

  it('wires connected-service turn lifecycle events to the production control server handler', async () => {
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({
      status: 'recorded',
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceTurnLifecycle,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-turn-lifecycle`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          event: 'turn_cancelled',
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({
        ok: true,
        result: {
          status: 'recorded',
        },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'turn_cancelled',
      });
    } finally {
      await server.stop();
    }
  });

  it('wires Codex ChatGPT refresh bridge requests to the production control server handler', async () => {
    const handleCodexChatGptAuthTokensRefresh = vi.fn(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: null,
    }));
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleCodexChatGptAuthTokensRefresh,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-happier-daemon-token': 'token',
        },
        body: JSON.stringify({
          sessionId: 'sess_1',
          selection: {
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'work',
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        result: {
          accessToken: 'fresh-access',
          chatgptAccountId: 'acct_123',
          chatgptPlanType: null,
        },
      });
      expect(handleCodexChatGptAuthTokensRefresh).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'work',
        },
        chatgptPlanType: null,
      });
    } finally {
      await server.stop();
    }
  });

  it('defers runtime-auth recovery without running the handler while the daemon is shutting down', async () => {
    // Daemon-lifecycle guard: during shutdown the handler must NOT run (no switch/restart/
    // continuation), must NOT enqueue, must NOT clear the recovery intent, and must NOT emit
    // an account-switch success. The recovery intent is deferred (left for a future daemon).
    const handleConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    }));
    const markSucceededByKey = vi.fn(async () => ({ status: 'succeeded' }));
    const cancelByKey = vi.fn(async () => ({ status: 'cancelled' }));
    const enqueueHandlerFailure = vi.fn(async () => ({ status: 'scheduled', retryable: true }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine',
      stopSession: async () => false,
      spawnSession: async () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'token',
      handleConnectedServiceRuntimeAuthFailure,
      runtimeAuthRecoveryScheduler: { markSucceededByKey, cancelByKey, enqueueHandlerFailure },
      isShuttingDown: () => true,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-runtime-auth/failure',
        headers: { 'x-happier-daemon-token': 'token' },
        payload: {
          sessionId: 'sess_1',
          switchesThisTurn: 0,
          classification: {
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'main',
            resetsAtMs: null,
            planType: null,
            rateLimits: null,
            source: 'structured_provider_error',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: {
          status: 'daemon_lifecycle_unavailable',
          reason: 'recovery_deferred_shutdown',
        },
      });
      // The handler never ran, nothing was enqueued, and recovery was neither cleared nor terminated.
      expect(handleConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(enqueueHandlerFailure).not.toHaveBeenCalled();
      expect(markSucceededByKey).not.toHaveBeenCalled();
      expect(cancelByKey).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
