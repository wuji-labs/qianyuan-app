import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { createDaemonControlApp, startDaemonControlServer } from './controlServer';

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
          event: 'assistant_message_end',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        result: { ok: true },
      });
      expect(handleConnectedServiceTurnLifecycle).toHaveBeenCalledWith({
        sessionId: 'sess_1',
        event: 'assistant_message_end',
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
});
