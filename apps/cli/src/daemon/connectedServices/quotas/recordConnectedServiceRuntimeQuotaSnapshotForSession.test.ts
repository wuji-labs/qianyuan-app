import { describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './recordConnectedServiceRuntimeQuotaSnapshotForSession';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: '/tmp/home/.happier',
    happyLibDir: '/tmp/home/.happier/lib',
    happyToolsDir: '/tmp/home/.happier/tools',
    ...overrides,
  };
}

describe('recordConnectedServiceRuntimeQuotaSnapshotForSession', () => {
  it('records group session snapshots into connected quota persistence and candidate runtime state', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: null,
          limit: null,
          unit: 'unknown' as const,
          utilizationPct: 99,
          resetsAt: null,
          status: 'ok' as const,
          details: {},
        },
      ],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(quotaCoordinator.recordInBandQuotaSnapshot).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot,
    });
    expect(runtimeQuotaSnapshots.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'main',
      capturedAtMs: 1_000,
    }).get('primary')?.quotaSnapshot).toMatchObject({
      effectiveMeterId: 'primary',
      effectiveRemainingPercent: 1,
    });
  });

  it('uses webhook metadata bindings for group quota state when tracked spawn options no longer carry them', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
    };
    const publishQuotaRef = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_native_codex',
      planLabel: 'pro',
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          environmentVariables: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'primary',
              fallbackProfileId: 'primary',
              generation: 7,
            }]),
          },
        },
        happySessionMetadataFromLocalWebhook: metadata({
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        }),
      }],
      quotaCoordinator,
      publishQuotaRef,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
    expect(publishQuotaRef).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
    });
    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      providerAccountId: 'acct_native_codex',
      accountLabel: null,
      observedAtMs: 1_000,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: 7,
    });
  });

  it('records group runtime state before durable quota persistence completes', async () => {
    let releasePersistence: () => void = () => {};
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releasePersistence = resolve;
        });
        return { status: 'persisted' as const };
      }),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: null,
          limit: null,
          unit: 'unknown' as const,
          utilizationPct: 50,
          remainingPct: 50,
          resetsAt: null,
          status: 'ok' as const,
          details: {},
        },
      ],
    };

    const promise = recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    });

    await Promise.resolve();
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);

    releasePersistence();
    await expect(promise).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });
  });

  it('keeps runtime state when durable quota persistence fails', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => {
        throw new Error('server write failed');
      }),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: false });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
  });

  it('reports quota state as not recorded when durable quota persistence is deferred', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'deferred_unknown_mode' as const })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: false });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
  });

  it('reports quota state as recorded when durable quota persistence is queued', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });
  });

  it('records native selections through the in-band quota path without group runtime state', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
    };
    const publishQuotaRef = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'acct:abc123',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_native_codex',
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'native',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      publishQuotaRef,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    expect(quotaCoordinator.recordInBandQuotaSnapshot).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'acct:abc123',
      snapshot,
    });
    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: null,
      profileId: 'acct:abc123',
      providerAccountId: 'acct_native_codex',
      accountLabel: null,
      observedAtMs: 1_000,
      source: 'runtime_quota_snapshot',
      proofStrength: 'exact',
      groupGeneration: null,
    });
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'acct:abc123',
    })).toBeNull();
    expect(publishQuotaRef).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'acct:abc123',
    });
  });

  it('fans out exact same-account exhaustion from a connected group snapshot with live account proof', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
      recordAccountExhaustionAndFanout: vi.fn(async () => ({
        status: 'recorded' as const,
        fanoutCandidates: 1,
        fanoutRequests: 1,
      })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_live_codex',
      planLabel: 'pro',
      accountLabel: 'live@example.test',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: null,
          limit: null,
          unit: 'unknown' as const,
          utilizationPct: 100,
          remainingPct: 0,
          resetsAt: 10_000,
          status: 'ok' as const,
          limitCategory: 'usage_limit' as const,
          details: {},
        },
      ],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
          environmentVariables: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'primary',
              fallbackProfileId: 'backup',
              generation: 7,
            }]),
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      providerAccountId: 'acct_live_codex',
      proofStrength: 'exact',
      groupGeneration: 7,
    }));
    expect(quotaCoordinator.recordAccountExhaustionAndFanout).toHaveBeenCalledWith({
      sourceSessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      exhaustedProfileId: 'primary',
      providerAccountId: 'acct_live_codex',
      resetAtMs: 10_000,
      reason: 'usage_limit',
    });
  });

  it('does not record same-account identity or fanout for a group snapshot without active generation proof', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
      recordAccountExhaustionAndFanout: vi.fn(async () => ({
        status: 'recorded' as const,
        fanoutCandidates: 1,
        fanoutRequests: 1,
      })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'primary',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_live_codex',
      planLabel: 'pro',
      accountLabel: 'live@example.test',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: null,
          limit: null,
          unit: 'unknown' as const,
          utilizationPct: 100,
          remainingPct: 0,
          resetsAt: 10_000,
          status: 'ok' as const,
          limitCategory: 'usage_limit' as const,
          details: {},
        },
      ],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toBe(snapshot);
    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).not.toHaveBeenCalled();
    expect(quotaCoordinator.recordAccountExhaustionAndFanout).not.toHaveBeenCalled();
  });

  it('does not record same-account identity or fanout when live group env names a different active profile', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
      recordAccountExhaustionAndFanout: vi.fn(async () => ({
        status: 'recorded' as const,
        fanoutCandidates: 1,
        fanoutRequests: 1,
      })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'fresh-member',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_live_codex',
      planLabel: 'pro',
      accountLabel: 'live@example.test',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: null,
          limit: null,
          unit: 'unknown' as const,
          utilizationPct: 100,
          remainingPct: 0,
          resetsAt: 10_000,
          status: 'ok' as const,
          limitCategory: 'usage_limit' as const,
          details: {},
        },
      ],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'fresh-member',
                groupId: 'main',
              },
            },
          },
          environmentVariables: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'stale-member',
              fallbackProfileId: 'fresh-member',
              generation: 7,
            }]),
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
    })).toBe(snapshot);
    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).not.toHaveBeenCalled();
    expect(quotaCoordinator.recordAccountExhaustionAndFanout).not.toHaveBeenCalled();
  });

  it('does not emit quota proof or account identity when a direct profile snapshot names a different profile', async () => {
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'unexpected-profile',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_live_codex',
      planLabel: 'pro',
      accountLabel: 'live@example.test',
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: 10,
          limit: 100,
          unit: 'requests' as const,
          utilizationPct: 10,
          remainingPct: 90,
          resetsAt: 10_000,
          status: 'ok' as const,
          limitCategory: 'usage_limit' as const,
          details: {},
        },
      ],
    };
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
      computeQuotaSnapshotMaterialFingerprint: vi.fn(() => 'quota-fingerprint'),
      resolveQuotaProbeFreshProof: vi.fn(() => ({
        status: 'proof' as const,
        proofKind: 'quota_probe_fresh' as const,
      })),
    };
    const recordProviderOutcomeProof = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'selected-profile',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      recordProviderOutcomeProof,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    expect(quotaCoordinator.resolveQuotaProbeFreshProof).not.toHaveBeenCalled();
    expect(recordProviderOutcomeProof).not.toHaveBeenCalled();
    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).not.toHaveBeenCalled();
  });

  it('emits central quota_probe_fresh proof for a fresh matching group runtime snapshot without account proof', async () => {
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'fresh-member',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      planLabel: 'pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'primary',
          label: 'Primary',
          used: 10,
          limit: 100,
          unit: 'requests' as const,
          utilizationPct: 10,
          remainingPct: 90,
          resetsAt: 10_000,
          status: 'ok' as const,
          limitCategory: 'usage_limit' as const,
          details: {},
        },
      ],
    };
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
      recordRuntimeAccountIdentityFromSnapshot: vi.fn(),
      computeQuotaSnapshotMaterialFingerprint: vi.fn(() => 'quota-fingerprint'),
      resolveQuotaProbeFreshProof: vi.fn(() => ({
        status: 'proof' as const,
        proofKind: 'quota_probe_fresh' as const,
      })),
    };
    const recordProviderOutcomeProof = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'fresh-member',
                groupId: 'main',
              },
            },
          },
          environmentVariables: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'openai-codex',
              groupId: 'main',
              activeProfileId: 'fresh-member',
              fallbackProfileId: 'old-member',
              generation: 9,
            }]),
          },
        },
      }],
      quotaCoordinator,
      recordProviderOutcomeProof,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded: true });

    expect(quotaCoordinator.resolveQuotaProbeFreshProof).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'fresh-member',
      groupId: 'main',
      expectedGroupGeneration: 9,
      currentGroupGeneration: 9,
      expectedMaterialFingerprint: null,
      snapshotMaterialFingerprint: 'quota-fingerprint',
      snapshot,
    });
    expect(recordProviderOutcomeProof).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'fresh-member',
      groupId: 'main',
      proofKind: 'quota_probe_fresh',
    });
    expect(quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot).not.toHaveBeenCalled();
  });

  it('records runtime quota snapshots even when the session has no connected-service selection', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };
    const publishQuotaRef = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'claude',
      planLabel: 'max',
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      quotaCoordinator,
      publishQuotaRef,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'claude-subscription',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: true });

    expect(quotaCoordinator.recordInBandQuotaSnapshot).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
      snapshot,
    });
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
    })).toBeNull();
    expect(publishQuotaRef).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      serviceId: 'claude-subscription',
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('does not publish quota refs when durable quota persistence is unavailable', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'deferred_unknown_mode' as const })),
    };
    const publishQuotaRef = vi.fn(async () => {});
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'acct:abc123',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'codex',
      activeAccountId: 'acct_native_codex',
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
        },
      }],
      quotaCoordinator,
      publishQuotaRef,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded: false });

    expect(publishQuotaRef).not.toHaveBeenCalled();
  });

  it('rejects snapshots whose embedded service id does not match the reported service id', async () => {
    const quotaCoordinator = {
      recordInBandQuotaSnapshot: vi.fn(async () => ({ status: 'persisted' as const })),
    };
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const snapshot = {
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
      fetchedAt: 1_000,
      staleAfterMs: 300_000,
      providerId: 'claude',
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    await expect(recordConnectedServiceRuntimeQuotaSnapshotForSession({
      getChildren: () => [{
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                profileId: 'primary',
                groupId: 'main',
              },
            },
          },
        },
      }],
      quotaCoordinator,
      runtimeQuotaSnapshots,
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      snapshot,
    })).resolves.toEqual({ status: 'service_id_mismatch' });

    expect(quotaCoordinator.recordInBandQuotaSnapshot).not.toHaveBeenCalled();
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
    })).toBeNull();
  });
});
