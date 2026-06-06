import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('commitConnectedServiceAccountSwitchSessionEvent', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('commits manual profile switches without requiring a group id', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-1',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-1', seq: 2, localId: 'local-1', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'anthropic',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
      },
    });

    expect(getSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-1$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-1\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch:anthropic:direct:/),
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                groupId: null,
                fromProfileId: 'old-profile',
                toProfileId: 'new-profile',
                reason: 'manual',
              }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    );
  });

  it('persists resolved profile labels on connected-service account switch transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-labels',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-labels', seq: 2, localId: 'local-labels', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-labels',
      listConnectedServiceProfiles: async () => ({
        serviceId: 'claude-subscription',
        profiles: [
          {
            profileId: 'batiplus',
            displayName: 'leeroy',
            status: 'connected',
            providerEmail: 'leeroy@example.test',
          },
        ],
      }),
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'claude-subscription',
        groupId: 'claude',
        fromProfileId: 'batiplus',
        toProfileId: 'batiplus',
        reason: 'manual',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-labels\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                fromProfileId: 'batiplus',
                toProfileId: 'batiplus',
                fromProfileLabel: 'leeroy',
                toProfileLabel: 'leeroy',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits connected-service account switch attempt diagnostics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'failed',
        outcomeAction: 'none',
        errorCode: 'post_switch_verification_failed',
        diagnostic: {
          code: 'post_switch_verification_failed',
          failurePhase: 'post_switch_verification',
          source: 'manual_auth_switch',
          serviceId: 'openai-codex',
          retryable: false,
          suggestedActions: ['reconnect_profile'],
        },
        groupGeneration: 7,
        sessionAdoption: 'failed',
        partialState: 'runtime_auth_partially_applied',
        verificationByServiceId: {
          'openai-codex': {
            status: 'weakly_verified',
            reason: 'provider_account_email_verified_without_account_id',
            providerAccountId: 'must-not-persist',
          },
        },
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch-attempt:/),
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: false,
                action: 'hot_applied',
                attemptedContinuityMode: 'hot_apply',
                outcome: 'failed',
                outcomeAction: 'none',
                errorCode: 'post_switch_verification_failed',
                diagnostic: {
                  code: 'post_switch_verification_failed',
                  failurePhase: 'post_switch_verification',
                  source: 'manual_auth_switch',
                  serviceId: 'openai-codex',
                  retryable: false,
                  suggestedActions: ['reconnect_profile'],
                },
                groupGeneration: 7,
                sessionAdoption: 'failed',
                partialState: 'runtime_auth_partially_applied',
                verificationByServiceId: {
                  'openai-codex': {
                    status: 'weakly_verified',
                    reason: 'provider_account_email_verified_without_account_id',
                  },
                },
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits provider state-sharing degraded diagnostics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-degraded',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-degraded', seq: 2, localId: 'local-degraded', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-degraded',
      event: {
        type: 'provider_state_sharing_degraded',
        serviceId: 'anthropic',
        requestedStateMode: 'shared',
        effectiveStateMode: 'isolated',
        code: 'state_symlink_unavailable',
        entryName: 'sessions/--Users-alice-work-project--',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-degraded\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^provider-state-sharing-degraded:anthropic:/),
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'provider-state-sharing-degraded',
                serviceId: 'anthropic',
                requestedStateMode: 'shared',
                effectiveStateMode: 'isolated',
                code: 'state_symlink_unavailable',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
    const [, postedBody] = postSpy.mock.calls[0]!;
    expect(JSON.stringify(postedBody)).not.toContain('Users-alice-work-project');
    expect(JSON.stringify(postedBody)).not.toContain('entryName');
  });

  it('commits preventive soft-threshold switches as transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-2',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-2', seq: 2, localId: 'local-2', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-2',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        generation: 4,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-2\/messages$/),
      expect.objectContaining({
        localId: 'connected-service-account-switch:openai-codex:codex-main:4',
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'soft_threshold',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits the actual switch mode from runtime auth events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-hot',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-hot', seq: 2, localId: 'local-hot', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-hot',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'manual',
        mode: 'hot_apply',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-hot\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                mode: 'hot_apply',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits pre-turn auth-group soft-threshold switch coordinator events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-3',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-3', seq: 2, localId: 'local-3', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-3',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        fromGeneration: 3,
        toGeneration: 4,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-3\/messages$/),
      expect.objectContaining({
        localId: 'connected-service-account-switch:openai-codex:codex-main:4',
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'soft_threshold',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits auth-disabled switch coordinator events as auth-expired transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-4',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-4', seq: 2, localId: 'local-4', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-4',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'disabled',
        toProfileId: 'backup',
        reason: 'account_disabled',
        fromGeneration: 7,
        toGeneration: 8,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-4\/messages$/),
      expect.objectContaining({
        localId: 'connected-service-account-switch:openai-codex:codex-main:8',
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                fromProfileId: 'disabled',
                toProfileId: 'backup',
                reason: 'auth_expired',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits active-turn deferral observability events to transcript', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-deferral',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-deferral', seq: 2, localId: 'local-deferral', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-deferral',
      event: {
        type: 'connected_service_account_switch_deferred',
        policy: 'defer_until_turn_boundary',
        awaitingBoundary: true,
        timeoutMs: 60_000,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-deferral\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch-deferral:defer_until_turn_boundary:/),
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-deferral',
                policy: 'defer_until_turn_boundary',
                awaitingBoundary: true,
                timeoutMs: 60_000,
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });
});
