import { describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceMaterializationIdentityV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import { createCodexConnectedServiceRuntimeAuthAdapter } from '@/backends/codex/connectedServices/createCodexConnectedServiceRuntimeAuthAdapter';
import { resolveCodexConnectedServiceSwitchContinuity } from '@/backends/codex/connectedServices/resolveCodexConnectedServiceSwitchContinuity';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceSessionAuthSwitchLockRegistry, createConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createSessionContinuationRecoveryController } from '../continuation/sessionContinuationRecovery';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';
import { switchSessionConnectedServiceAuth, type SwitchSessionConnectedServiceAuthInput } from './switchSessionConnectedServiceAuth';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess_1',
    pid: 123,
    spawnOptions: {
      directory: '/tmp/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'old-profile' },
        },
      },
    },
    ...overrides,
  };
}

function group(overrides: Partial<ConnectedServiceAuthGroupV1> = {}): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'anthropic',
    groupId: 'work',
    displayName: 'Work',
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
    activeProfileId: 'group-active',
    generation: 4,
    state: { v: 1 },
    members: [
      {
        v: 1,
        serviceId: 'anthropic',
        groupId: 'work',
        profileId: 'group-active',
        priority: 100,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function bindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      anthropic: { source: 'connected', selection: 'profile', profileId },
    },
  };
}

const materializationIdentity = {
  v: 1,
  id: 'csm_switch_1',
  createdAtMs: 123,
} as const;

function expectMaterializationIdentity(value: unknown) {
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(value);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error('Expected connected-service materialization identity');
  }
  expect(parsed.data.id).toMatch(/^csm_[a-f0-9]{32}$/);
  return parsed.data;
}

function codexBindings(profileId: string): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      'openai-codex': { source: 'connected', selection: 'profile', profileId },
    },
  };
}

function multiServiceBindings(input: Readonly<{
  anthropicProfileId: string;
  claudeSubscriptionProfileId: string;
}>): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      anthropic: { source: 'connected', selection: 'profile', profileId: input.anthropicProfileId },
      'claude-subscription': {
        source: 'connected',
        selection: 'profile',
        profileId: input.claudeSubscriptionProfileId,
      },
    },
  };
}

function createCore() {
  return createConnectedServiceSessionAuthSwitchCore({
    locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
  });
}

function createContinuationStore() {
  const stored = new Map<string, unknown>();
  return {
    read: (sessionId: string) => stored.get(sessionId) ?? null,
    write: (sessionId: string, state: unknown) => {
      stored.set(sessionId, state);
    },
    stored,
  };
}

describe('switchSessionConnectedServiceAuth', () => {
  it('rejects a missing session without mutating or restarting', async () => {
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'anthropic', profiles: [] }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_missing',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_not_found',
    });

    expect(restartSession).not.toHaveBeenCalled();
  });

  it('updates inactive session bindings without requesting a restart', async () => {
    const restartSession = vi.fn();
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: bindings('old-profile'),
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        vendorResumeId: 'vendor-inactive-1',
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession,
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any)).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: bindings('new-profile'),
    });

    expect(persistSessionBindings).toHaveBeenCalledWith({
      sessionId: 'sess_inactive',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      sessionId: 'sess_inactive',
      serviceId: 'anthropic',
      previous: expect.objectContaining({ profileId: 'old-profile' }),
      next: expect.objectContaining({ profileId: 'new-profile' }),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      vendorResumeId: 'vendor-inactive-1',
    }));
    expect(restartSession).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('threads the inactive session cwd and persisted session-file hint into the continuity check', async () => {
    // Regression: the inactive-switch continuity check ran with tracked=null, so the daemon adapter
    // (which derives cwd/target root from tracked.spawnOptions) starved the shared-state reachability
    // proof and fail-closed a genuinely-resumable inactive session. The switch must forward the
    // inactive session's cwd + persisted session-file hint so the adapter can reconstruct the target
    // and prove reachability from source.
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: bindings('old-profile'),
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        vendorResumeId: 'vendor-inactive-1',
        cwd: '/tmp/inactive-repo',
        candidatePersistedSessionFile: '/tmp/inactive-repo/.pi/agent/sessions/--tmp-inactive-repo--/s.jsonl',
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession: vi.fn(),
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any)).resolves.toMatchObject({ ok: true, action: 'metadata_updated' });

    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      tracked: null,
      sessionId: 'sess_inactive',
      cwd: '/tmp/inactive-repo',
      candidatePersistedSessionFile: '/tmp/inactive-repo/.pi/agent/sessions/--tmp-inactive-repo--/s.jsonl',
    }));
  });

  it('rejects inactive session switches when provider state sharing is required', async () => {
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'codex',
        connectedServices: codexBindings('old-codex-profile'),
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ tracked, sessionId, previous, next }) => {
        expect(tracked).toBeNull();
        expect(sessionId).toBe('sess_inactive_codex');
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'old-codex-profile',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'new-codex-profile',
        }));
        return {
          mode: 'unsupported',
          errorCode: 'provider_state_sharing_required',
        };
      },
      restartSession: async () => {
        throw new Error('Inactive sessions should not restart');
      },
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_inactive_codex',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_state_sharing_required',
      serviceId: 'openai-codex',
      diagnostics: {
        failurePhase: 'continuity',
      },
    });

    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalledTimes(1);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive_codex', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'restart_requested',
      errorCode: 'provider_state_sharing_required',
      partialState: null,
    }));
  });

  it('validates a profile, updates tracked spawn options, restarts, and emits one manual switch event', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      } as TrackedSession['spawnOptions'] & {
        connectedServiceMaterializationIdentityV1: typeof materializationIdentity;
      },
    });
    const calls: string[] = [];
    const persistSessionBindings = vi.fn(async () => {
      calls.push('persist');
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
      expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
        ?.connectedServiceMaterializationIdentityV1).toEqual(materializationIdentity);
    });
    const restartSession = vi.fn(async () => {
      calls.push('restart');
      expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('new-profile'),
    });

    expect(calls).toEqual(['persist', 'restart']);
    expect(persistSessionBindings).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledTimes(2);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      partialState: null,
      errorCode: null,
    }));
  });

  it('rematerializes an active session with a generated identity when the selected profile binding is unchanged after reconnect', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();
    const restartSession = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'old-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ previous, next }) => {
        expect(previous).toEqual(expect.objectContaining({
          serviceId: 'anthropic',
          profileId: 'old-profile',
        }));
        expect(next).toEqual(expect.objectContaining({
          serviceId: 'anthropic',
          profileId: 'old-profile',
        }));
        return { mode: 'restart_rematerialize' };
      },
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('old-profile'),
        rematerializeServiceId: 'anthropic',
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('old-profile'),
      continuityByServiceId: { anthropic: 'restart_rematerialize' },
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    const persistedIdentity = expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
      ?.connectedServiceMaterializationIdentityV1).toEqual(persistedIdentity);
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      partialState: null,
      errorCode: null,
    }));
  });

  it('generates a materialization identity before restarting an active native session into connected auth', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        resume: 'spawn-resume-1',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'native' },
            'claude-subscription': { source: 'native' },
          },
        },
      },
    });
    const persistSessionBindings = vi.fn();
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.connectedServices).toEqual(multiServiceBindings({
        anthropicProfileId: 'anthropic-new',
        claudeSubscriptionProfileId: 'subscription-new',
      }));
      expectMaterializationIdentity(
        (tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
          ?.connectedServiceMaterializationIdentityV1,
      );
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async ({ serviceId }) => ({
          serviceId,
          profiles: [
            {
              profileId: serviceId === 'anthropic' ? 'anthropic-new' : 'subscription-new',
              status: 'connected',
            },
          ],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ connectedServiceMaterializationIdentityV1, vendorResumeId }) => {
        expectMaterializationIdentity(connectedServiceMaterializationIdentityV1);
        expect(vendorResumeId).toBe('spawn-resume-1');
        return { mode: 'restart_rematerialize' };
      },
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'anthropic-new',
          claudeSubscriptionProfileId: 'subscription-new',
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: multiServiceBindings({
        anthropicProfileId: 'anthropic-new',
        claudeSubscriptionProfileId: 'subscription-new',
      }),
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
        'claude-subscription': 'restart_rematerialize',
      },
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    const persistedIdentity = expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect((tracked.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown } | undefined)
      ?.connectedServiceMaterializationIdentityV1).toEqual(persistedIdentity);
    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('persists a generated materialization identity when updating an inactive native session into connected auth', async () => {
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [],
      resolveInactiveSession: async () => ({
        agentId: 'claude',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'native' },
          },
        },
      }),
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ connectedServiceMaterializationIdentityV1 }) => {
        expectMaterializationIdentity(connectedServiceMaterializationIdentityV1);
        return { mode: 'restart_rematerialize' };
      },
      restartSession: async () => {
        throw new Error('Inactive sessions should not restart');
      },
      hotApply: async () => {
        throw new Error('Inactive sessions should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      persistSessionBindings,
      request: {
        sessionId: 'sess_inactive',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'metadata_updated',
      normalizedBindings: bindings('new-profile'),
    });

    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expectMaterializationIdentity(
      persistSessionBindings.mock.calls[0]?.[0]?.connectedServiceMaterializationIdentityV1,
    );
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_inactive', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: null,
      toProfileId: 'new-profile',
      reason: 'manual',
    }));
  });

  it('rejects retryable-refresh profiles as disconnected during manual auth switch validation', async () => {
    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [trackedSession()],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'refresh_failed_retryable' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => {
        throw new Error('Disconnected profiles should not resolve continuity');
      },
      restartSession: async () => {
        throw new Error('Disconnected profiles should not restart');
      },
      hotApply: async () => {
        throw new Error('Disconnected profiles should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'profile_disconnected',
      serviceId: 'anthropic',
    });
  });

  it('returns action-required for reconnect-required profile selection', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'needs_reauth' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => {
        throw new Error('Reconnect-required profiles should not resolve continuity');
      },
      restartSession,
      hotApply: async () => {
        throw new Error('Reconnect-required profiles should not hot-apply');
      },
      registerHotApplyTargets: () => {},
      emitSessionEvent: vi.fn(),
      persistSessionBindings: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'profile_action_required',
      serviceId: 'anthropic',
      diagnostics: {
        failurePhase: 'normalization',
        actionRequired: {
          kind: 'reconnect_profile',
          profileId: 'new-profile',
        },
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not restart when persisting the accepted binding fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      persistSessionBindings: async () => {
        throw new Error('metadata unavailable');
      },
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as any)).resolves.toEqual({
      ok: false,
      errorCode: 'metadata_update_failed',
      diagnostics: {
        failurePhase: 'metadata',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('treats an omitted previously connected service as a native switch', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'anthropic', profileId: 'old-profile' },
          ]),
        },
      },
    });
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.connectedServices).toEqual({
        v: 1,
        bindingsByServiceId: {},
      });
      expect(tracked.spawnOptions?.environmentVariables).toBeUndefined();
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ next }) => {
        expect(next).toMatchObject({
          source: 'native',
          selection: 'native',
          serviceId: 'anthropic',
        });
        return { mode: 'restart_rematerialize' };
      },
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {},
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {},
      },
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      fromProfileId: 'old-profile',
      toProfileId: null,
      reason: 'manual',
    }));
  });

  it('rejects connected-service bindings unsupported by the target agent before profile lookup', async () => {
    const tracked = trackedSession();
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profiles: [{ profileId: 'codex-profile', status: 'connected' as const }],
    }));
    const resolveContinuity = vi.fn(async () => ({ mode: 'restart_rematerialize' as const }));
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles,
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-profile',
            },
          },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_service',
      serviceId: 'openai-codex',
    });

    expect(listConnectedServiceProfiles).not.toHaveBeenCalled();
    expect(resolveContinuity).not.toHaveBeenCalled();
    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      errorCode: 'unsupported_service',
    }));
  });

  it('resolves group active profile under the lock and rejects stale expected generations before mutation', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'anthropic', profiles: [] }),
        getConnectedServiceAuthGroup: async () => group({ generation: 5 }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {},
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        expectedGroupGenerationByServiceId: { anthropic: 4 },
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'stale-ui-profile',
            },
          },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'group_generation_conflict',
      serviceId: 'anthropic',
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('writes authoritative group metadata into child-selection env when switching into a group', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
      },
    });
    const restartSession = vi.fn(async () => {
      expect(tracked.spawnOptions?.environmentVariables).toEqual({
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'anthropic',
            groupId: 'work',
            activeProfileId: 'group-active',
            fallbackProfileId: 'fallback-profile',
            generation: 9,
          },
        ]),
      });
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [
            { profileId: 'group-active', status: 'connected' },
            { profileId: 'fallback-profile', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          generation: 9,
          members: [
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'group-active',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'fallback-profile',
              priority: 90,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'fallback-profile',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('rejects a needs-reauth fallback profile before mutating group session state', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [
            { profileId: 'group-active', status: 'connected' },
            { profileId: 'fallback-profile', status: 'needs_reauth' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => group({
          activeProfileId: 'group-active',
          members: [
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'group-active',
              priority: 100,
              enabled: true,
              state: {},
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'anthropic',
              groupId: 'work',
              profileId: 'fallback-profile',
              priority: 200,
              enabled: true,
              state: {},
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        }),
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession,
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'group',
              groupId: 'work',
              profileId: 'fallback-profile',
            },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'profile_action_required',
      serviceId: 'anthropic',
      diagnostics: {
        actionRequired: {
          kind: 'reconnect_profile',
          profileId: 'fallback-profile',
          healthStatus: 'needs_reauth',
        },
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('abandons a stale group generation before persisting, hot-applying, restarting, or continuing', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const restartSession = vi.fn();
    const continueAfterRuntimeAuthSwitch = vi.fn();
    let generationCurrent = true;

    const switchInput = {
      core: createCore(),
      skipCoreLock: true,
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => {
        generationCurrent = false;
        return { mode: 'hot_apply' };
      },
      isExpectedGroupGenerationCurrent: () => generationCurrent,
      restartSession,
      hotApply,
      continueAfterRuntimeAuthSwitch,
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      persistSessionBindings,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
        expectedGroupGenerationByServiceId: { anthropic: 4 },
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      isExpectedGroupGenerationCurrent: () => boolean;
    }>;

    await expect(switchSessionConnectedServiceAuth(switchInput)).resolves.toEqual({
      ok: false,
      errorCode: 'group_generation_conflict',
      serviceId: 'anthropic',
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(persistSessionBindings).not.toHaveBeenCalled();
    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).not.toHaveBeenCalled();
  });

  it('does not mutate when provider continuity is unsupported', async () => {
    const tracked = trackedSession();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_state_sharing_required',
      }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_state_sharing_required',
      serviceId: 'anthropic',
      diagnostics: {
        failurePhase: 'continuity',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('fails closed when PI continuity cannot prove resume reachability', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' },
          },
        },
      },
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({
        mode: 'unsupported',
        errorCode: 'provider_session_state_unavailable_for_resume',
      }),
      restartSession: async () => {
        throw new Error('restart should not run');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'pi',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new-profile' },
          },
        },
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_session_state_unavailable_for_resume',
      serviceId: 'openai-codex',
      diagnostics: {
        failurePhase: 'continuity',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' },
      },
    });
  });

  it('returns restart failure diagnostics when a switch cannot restart the active session', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => {
        throw new Error('restart failed');
      },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      persistSessionBindings,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'restart_failed',
      diagnostics: {
        failurePhase: 'restart',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: expect.objectContaining({ v: 1 }),
    }));
    expect(persistSessionBindings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('old-profile'),
    }));
  });

  it('re-registers quota and refresh targets after hot apply without restart', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const registerHotApplyTargets = vi.fn();
    const calls: string[] = [];

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => {
        calls.push('hotApply');
        return { ok: true };
      },
      persistSessionBindings: async () => {
        calls.push('persist');
      },
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(restartSession).not.toHaveBeenCalled();
    expect(calls).toEqual(['persist', 'hotApply']);
    expect(registerHotApplyTargets).toHaveBeenCalledWith(tracked);
  });

  it('invokes post-switch recovery after hot apply', async () => {
    const tracked = trackedSession();
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({ ok: true as const }));
    const input = {
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      recoverAfterRuntimeAuthSwitch: typeof recoverAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(recoverAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      tracked,
      serviceIds: new Set(['anthropic']),
      normalizedBindings: bindings('new-profile'),
    }));
  });

  it('runs durable continuation recovery after a successful restart recovery', async () => {
    const tracked = trackedSession();
    const store = createContinuationStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });
    const sentPrompts: string[] = [];
    const emitSessionEvent = vi.fn();
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
      serviceIds: ReadonlySet<string>;
    }) => {
      await controller.beginAttempt({
        sessionId: context.sessionId,
        attemptId: context.attemptId,
        failureAtMs: 1_000,
        resumePromptMode: 'standard',
      });
      await controller.resolveAttempt({
        sessionId: context.sessionId,
        attemptId: context.attemptId,
        failureAtMs: 1_000,
        resumePromptMode: 'standard',
        exactProviderContextAvailable: true,
        hasUserMessageAfterFailure: () => false,
        sendContinuationPrompt: ({ prompt }) => {
          sentPrompts.push(prompt);
        },
      });
    });
    const input = {
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' as const }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch: vi.fn(async () => ({ ok: true as const })),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as SwitchSessionConnectedServiceAuthInput & Readonly<{
      continueAfterRuntimeAuthSwitch: typeof continueAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      action: 'restart_requested',
      serviceIds: new Set(['anthropic']),
    }));
    expect(sentPrompts).toHaveLength(1);
    const persisted = store.stored.get('sess_1');
    const attemptsById =
      persisted && typeof persisted === 'object' && !Array.isArray(persisted)
        ? (persisted as { attemptsById?: Record<string, { status?: string }> }).attemptsById
        : null;
    expect(Object.keys(attemptsById ?? {})).toEqual([expect.stringContaining('anthropic')]);
    expect(Object.values(attemptsById ?? {})[0]).toMatchObject({ status: 'sent' });
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: true,
      action: 'restart_requested',
      partialState: null,
      errorCode: null,
    }));
  });

  it('continues the interrupted turn in place exactly once after a hot-apply (K2 mid-turn-limit contract)', async () => {
    // K2 LOCKED contract: when a usage limit interrupts an in-flight turn and the
    // switch HOT-APPLIES, the SAME turn must re-continue in place automatically,
    // exactly once, with no respawn. We assert the continuation handler runs with
    // action:'hot_applied' and the continuation prompt is sent exactly once when the
    // user has NOT supplied newer input (no newer input ⇒ auto re-continue).
    const tracked = trackedSession();
    const store = createContinuationStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });
    const sentPrompts: string[] = [];
    const restartSession = vi.fn();
    const continueAfterRuntimeAuthSwitch = vi.fn(async (context: {
      sessionId: string;
      attemptId: string;
      action: 'hot_applied' | 'restart_requested';
      serviceIds: ReadonlySet<string>;
    }) => {
      await controller.beginAttempt({
        sessionId: context.sessionId,
        attemptId: context.attemptId,
        failureAtMs: 1_000,
        resumePromptMode: 'standard',
      });
      if (context.action === 'restart_requested') return;
      await controller.resolveAttempt({
        sessionId: context.sessionId,
        attemptId: context.attemptId,
        failureAtMs: 1_000,
        resumePromptMode: 'standard',
        exactProviderContextAvailable: true,
        hasUserMessageAfterFailure: async () => false,
        sendContinuationPrompt: ({ prompt }) => {
          sentPrompts.push(prompt);
        },
      });
    });
    const input = {
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession,
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch: vi.fn(async () => ({ ok: true as const })),
      continueAfterRuntimeAuthSwitch,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } as SwitchSessionConnectedServiceAuthInput & Readonly<{
      continueAfterRuntimeAuthSwitch: typeof continueAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    // Hot-apply continues in place — no respawn.
    expect(restartSession).not.toHaveBeenCalled();
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledTimes(1);
    expect(continueAfterRuntimeAuthSwitch).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hot_applied',
      serviceIds: new Set(['anthropic']),
    }));
    // Exactly once.
    expect(sentPrompts).toHaveLength(1);
  });

  it('returns typed partial result when post-switch recovery fails', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();
    const recoverAfterRuntimeAuthSwitch = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'recover_failed',
    }));
    const input = {
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' as const }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true as const }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      recoverAfterRuntimeAuthSwitch,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      recoverAfterRuntimeAuthSwitch: typeof recoverAfterRuntimeAuthSwitch;
    }>;

    await expect(switchSessionConnectedServiceAuth(input)).resolves.toMatchObject({
      ok: false,
      errorCode: 'hot_apply_succeeded_but_recovery_failed',
      diagnostics: {
        failurePhase: 'post_switch_recovery',
        partialState: 'runtime_auth_applied',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch_attempt',
      ok: false,
      action: 'hot_applied',
      partialState: 'runtime_auth_applied',
      errorCode: 'hot_apply_succeeded_but_recovery_failed',
    }));
  });

  it('threads hot-apply mode into emitted manual switch events', async () => {
    const tracked = trackedSession();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'connected_service_account_switch',
      serviceId: 'anthropic',
      mode: 'hot_apply',
    }));
  });

  it('emits provider state-sharing degraded diagnostics when restarting after a switch', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: bindings('old-profile'),
        materializationDiagnostics: [
          {
            code: 'state_symlink_unavailable',
            providerId: 'claude',
            serviceId: 'anthropic',
            requestedStateMode: 'shared',
            effectiveStateMode: 'isolated',
          },
        ],
      } as TrackedSession['spawnOptions'] & {
        materializationDiagnostics?: ReadonlyArray<{
          code: string;
          providerId: string;
          serviceId?: string;
          requestedStateMode?: string;
          effectiveStateMode?: string;
        }>;
      },
    });
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
    });

    expect(emitSessionEvent).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      type: 'provider_state_sharing_degraded',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      code: 'state_symlink_unavailable',
    }));
  });

  it('does not hot-apply live runtime auth when metadata persistence fails', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn();
    const hotApply = vi.fn(async () => ({ ok: true as const }));
    const registerHotApplyTargets = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply,
      persistSessionBindings: async () => {
        throw new Error('metadata unavailable');
      },
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'metadata_update_failed',
      diagnostics: {
        failurePhase: 'metadata',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).not.toHaveBeenCalled();
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('hot-applies Codex manual switches with the materialized runtime auth selection', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: codexBindings('old-codex-profile'),
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'openai-codex', profileId: 'old-codex-profile' },
          ]),
        },
      },
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'new-codex-profile',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const binding = { source: 'connected', selection: 'profile', profileId: 'new-codex-profile' } as const;
    const client = { request: vi.fn(async () => ({ ok: true })) };
    const invalidateTransports = vi.fn(async () => {});
    const runtimeAuthSelection = {
      serviceId: 'openai-codex',
      binding,
      profileId: 'new-codex-profile',
      record,
      client,
      invalidateTransports,
    };
    type RuntimeAuthSelectionContinuityInput =
      Parameters<SwitchSessionConnectedServiceAuthInput['resolveContinuity']>[0]
      & Readonly<{ runtimeAuthSelection?: unknown }>;
    const materializeRuntimeAuthSelection = vi.fn(async () => runtimeAuthSelection);
    const hotApply = createSessionConnectedServiceAuthHotApply({
      resolveRuntimeAuthAdapter: async () => createCodexConnectedServiceRuntimeAuthAdapter(),
    });
    const registerHotApplyTargets = vi.fn();
    const switchInput = {
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'new-codex-profile', status: 'connected' as const }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      materializeRuntimeAuthSelection,
      resolveContinuity: async (input: RuntimeAuthSelectionContinuityInput) => {
        expect(input.runtimeAuthSelection).toBe(runtimeAuthSelection);
        const continuity = await resolveCodexConnectedServiceSwitchContinuity({
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceId: input.serviceId,
          previousBinding: input.previous,
          nextBinding: input.next,
          fromBindings: input.previousBindings,
          toBindings: input.normalizedBindings,
          runtimeAuthSelection: input.runtimeAuthSelection,
        });
        if (continuity.mode === 'hot_apply') return { mode: 'hot_apply' };
        throw new Error(`Expected hot_apply continuity, got ${continuity.mode}`);
      },
      restartSession: vi.fn(),
      hotApply,
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets,
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: codexBindings('new-codex-profile'),
      },
    } satisfies SwitchSessionConnectedServiceAuthInput & Readonly<{
      materializeRuntimeAuthSelection: () => Promise<typeof runtimeAuthSelection>;
    }>;

    await expect(switchSessionConnectedServiceAuth(switchInput)).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(materializeRuntimeAuthSelection).toHaveBeenCalledOnce();
    expect(switchInput.restartSession).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledWith('account/login/start', {
      chatgptAuthTokens: {
        accessToken: 'access',
        idToken: 'id',
        chatgptAccountId: 'acct',
      },
    });
    expect(invalidateTransports).toHaveBeenCalledOnce();
    expect(registerHotApplyTargets).toHaveBeenCalledWith(expect.objectContaining({
      spawnOptions: expect.objectContaining({
        environmentVariables: expect.objectContaining({
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            { kind: 'profile', serviceId: 'openai-codex', profileId: 'new-codex-profile' },
          ]),
        }),
      }),
    }));
  });

  it('ignores implicit native defaults for unrelated Codex services when computing changed bindings', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: { v: 1, bindingsByServiceId: {} },
      },
    });
    const resolveContinuity = vi.fn(async ({ serviceId }) => {
      if (serviceId === 'openai-codex') return { mode: 'hot_apply' as const };
      return { mode: 'unsupported' as const, errorCode: 'unsupported_service' as const };
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'happier', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity,
      restartSession: vi.fn(),
      hotApply: async () => ({ ok: true }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'codex',
        bindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'happier' },
            openai: { source: 'native' },
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'hot_applied',
      continuityByServiceId: { 'openai-codex': 'hot_apply' },
    });

    expect(resolveContinuity).toHaveBeenCalledOnce();
    expect(resolveContinuity).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
    }));
  });

  it('restarts when hot apply fails before applying any runtime auth changes', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({ ok: false, errorCode: 'hot_apply_failed' }),
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
      connectedServiceMaterializationIdentityV1: expect.objectContaining({ v: 1 }),
    }));
    expect(persistSessionBindings).toHaveBeenCalledTimes(1);
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restarts when hot apply adapter is unavailable before any runtime auth changes', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({ ok: false, errorCode: 'hot_apply_unavailable' }),
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restarts when hot apply throws before applying any runtime auth changes', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => {
        throw new Error('runtime auth adapter failure');
      },
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
  });

  it('restarts without rollback when hot apply reports restart recovery', async () => {
    const tracked = trackedSession();
    const restartSession = vi.fn(async () => {});
    const registerHotApplyTargets = vi.fn();
    const persistSessionBindings = vi.fn();
    const emitSessionEvent = vi.fn();

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession,
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_restart_required',
        serviceId: 'anthropic',
        serviceResultsByServiceId: {
          anthropic: { status: 'failed', errorCode: 'hot_apply_restart_required' },
        },
      }),
      persistSessionBindings,
      registerHotApplyTargets,
      emitSessionEvent,
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      normalizedBindings: bindings('new-profile'),
      continuityByServiceId: {
        anthropic: 'restart_rematerialize',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('new-profile'));
    expect(persistSessionBindings).toHaveBeenCalledOnce();
    expect(persistSessionBindings).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      normalizedBindings: bindings('new-profile'),
    }));
    expect(restartSession).toHaveBeenCalledWith(tracked);
    expect(registerHotApplyTargets).not.toHaveBeenCalled();
    expect(emitSessionEvent).toHaveBeenCalled();
  });

  it('returns rollback-failed when persisted rollback fails after hot apply failure', async () => {
    const tracked = trackedSession();
    const persistSessionBindings = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('metadata rollback unavailable'));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'anthropic',
          profiles: [{ profileId: 'new-profile', status: 'connected' }],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          openai: { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      persistSessionBindings,
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: bindings('new-profile'),
      },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'bindings_rollback_failed',
      diagnostics: {
        failurePhase: 'rollback',
        partialState: 'metadata_may_reference_new_binding',
      },
    });

    expect(tracked.spawnOptions?.connectedServices).toEqual(bindings('old-profile'));
  });

  it('restarts instead of hot applying when any changed service requires restart continuity', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: multiServiceBindings({
          anthropicProfileId: 'old-anthropic',
          claudeSubscriptionProfileId: 'old-claude-subscription',
        }),
      },
    });
    const restartSession = vi.fn(async () => {});
    const hotApply = vi.fn(async () => ({ ok: true as const }));

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async ({ serviceId }) => ({
          serviceId,
          profiles: [
            { profileId: 'new-anthropic', status: 'connected' },
            { profileId: 'new-claude-subscription', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async ({ serviceId }) => (
        serviceId === 'anthropic'
          ? { mode: 'hot_apply' }
          : { mode: 'restart_rematerialize' }
      ),
      restartSession,
      hotApply,
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'new-anthropic',
          claudeSubscriptionProfileId: 'new-claude-subscription',
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      action: 'restart_requested',
      continuityByServiceId: {
        anthropic: 'hot_apply',
        'claude-subscription': 'restart_rematerialize',
      },
    });

    expect(hotApply).not.toHaveBeenCalled();
    expect(restartSession).toHaveBeenCalledWith(tracked);
  });

  it('returns per-service hot-apply results when multi-service apply partially succeeds', async () => {
    const tracked = trackedSession({
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: multiServiceBindings({
          anthropicProfileId: 'old-anthropic',
          claudeSubscriptionProfileId: 'old-claude-subscription',
        }),
      },
    });

    await expect(switchSessionConnectedServiceAuth({
      core: createCore(),
      getChildren: () => [tracked],
      api: {
        listConnectedServiceProfiles: async ({ serviceId }) => ({
          serviceId,
          profiles: [
            { profileId: 'new-anthropic', status: 'connected' },
            { profileId: 'new-claude-subscription', status: 'connected' },
          ],
        }),
        getConnectedServiceAuthGroup: async () => null,
      },
      resolveContinuity: async () => ({ mode: 'hot_apply' }),
      restartSession: vi.fn(),
      hotApply: async () => ({
        ok: false,
        errorCode: 'hot_apply_failed',
        serviceId: 'claude-subscription',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          'claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      }),
      persistSessionBindings: vi.fn(),
      registerHotApplyTargets: vi.fn(),
      emitSessionEvent: vi.fn(),
      request: {
        sessionId: 'sess_1',
        agentId: 'claude',
        bindings: multiServiceBindings({
          anthropicProfileId: 'new-anthropic',
          claudeSubscriptionProfileId: 'new-claude-subscription',
        }),
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'hot_apply_failed',
      serviceId: 'claude-subscription',
      continuityByServiceId: {
        anthropic: 'hot_apply',
        'claude-subscription': 'hot_apply',
      },
      diagnostics: {
        failurePhase: 'hot_apply',
        partialState: 'runtime_auth_partially_applied',
        serviceResultsByServiceId: {
          anthropic: { status: 'applied' },
          'claude-subscription': { status: 'failed', errorCode: 'hot_apply_failed' },
        },
      },
    });
  });
});
