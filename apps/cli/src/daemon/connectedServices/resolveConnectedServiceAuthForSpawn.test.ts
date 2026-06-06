import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from './descriptors/connectedAccountDescriptors';
import {
  ConnectedServiceSpawnCredentialRefreshError,
  ConnectedServiceSpawnMaterializationError,
  resolveConnectedServiceAuthForSpawn,
} from './resolveConnectedServiceAuthForSpawn';
import { resolveClaudeCodeCredentialsFilePath } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';

async function readClaudeCodeNativeCredential(claudeConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8')) as Record<string, unknown>;
}

describe('resolveConnectedServiceAuthForSpawn', () => {
  it('uses a preflight-refreshed expired Claude OAuth credential for materialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const expiredExpiresAt = now - 1_000;
    const refreshedExpiresAt = now + 3_600_000;
    const expiredRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: expiredExpiresAt,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: refreshedExpiresAt,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: expiredRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: refreshedRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: refreshedExpiresAt,
        expiryAgeMs: now - refreshedExpiresAt,
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: expiredExpiresAt },
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    expect(connectedServiceAuth?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'fresh-access',
        refreshToken: 'rotated-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('fails before spawning when materialized Claude native OAuth is expired and cannot be refreshed', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const expiredRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: expiredRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now - 1_000 },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'claude-subscription',
      profileId: 'work',
      diagnostic: expect.objectContaining({
        status: 'refresh_failed',
        category: 'provider_401',
        serviceId: 'claude-subscription',
        profileId: 'work',
      }),
    } satisfies Partial<ConnectedServiceSpawnCredentialRefreshError>);
  });

  it('uses a preflight-refreshed near-expiry OAuth credential for materialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const nearExpiryExpiresAt = now + 30_000;
    const refreshedExpiresAt = now + 3_600_000;
    const nearExpiryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: nearExpiryExpiresAt,
      oauth: {
        accessToken: 'near-expiry-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: refreshedExpiresAt,
      oauth: {
        accessToken: 'near-expiry-fresh-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: nearExpiryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: refreshedRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: refreshedExpiresAt,
        expiryAgeMs: now - refreshedExpiresAt,
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: nearExpiryExpiresAt },
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    expect(connectedServiceAuth?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'near-expiry-fresh-access',
        refreshToken: 'rotated-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('blocks known reconnect-required credentials before spawn preflight expiry shortcuts', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const futureRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'stale-but-not-expiring-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: futureRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refreshed' as const,
      credential: futureRecord,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refreshed' as const,
        expiresAt: futureRecord.expiresAt,
        expiryAgeMs: now - (futureRecord.expiresAt ?? now),
        refreshWindowMs: 60_000,
      },
    }));
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
      })),
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: futureRecord.expiresAt },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'claude-subscription',
      profileId: 'work',
      diagnostic: {
        status: 'refresh_failed',
        category: 'invalid_grant',
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).not.toHaveBeenCalled();
  });

  it('fails closed before spawning Claude when OAuth materialization cannot write native credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const missingScopeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: missingScopeRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: missingScopeRecord.expiresAt },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnMaterializationError',
      agentId: 'claude',
      diagnostics: [
        expect.objectContaining({
          code: 'claude_subscription_missing_claude_code_scope',
          severity: 'blocking',
          serviceId: 'claude-subscription',
        }),
      ],
    });
  });

  it('switches a group binding when credential health marks the active profile reconnect-required', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'primary-stale-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof primaryRecord | typeof backupRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['backup', seal(backupRecord)],
    ]);

    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'openai-codex' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: now + 3_600_000,
        },
      };
    });
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'not_needed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'backup',
        reason: 'spawn_preflight' as const,
        status: 'not_needed' as const,
        expiresAt: backupRecord.expiresAt,
        expiryAgeMs: now - (backupRecord.expiresAt ?? now),
        refreshWindowMs: 60_000,
      },
    }));
    const api = {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'needs_reauth' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      })),
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'not_needed' })),
        switchAfterClassifiedFailure,
      },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }));
    expect(getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('returns a typed reconnect-required preflight error when central refresh cannot recover an expired credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const expiredExpiresAt = now - 1_000;
    const expiredRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: expiredExpiresAt,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: expiredRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'work',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: expiredExpiresAt,
        expiryAgeMs: now - expiredExpiresAt,
        refreshWindowMs: 60_000,
      },
    }));

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: expiredExpiresAt },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
  });

  it('switches a group binding after the active profile permanently fails spawn preflight refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'primary-expired-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;

    const seal = (payload: typeof primaryRecord | typeof backupRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['backup', seal(backupRecord)],
    ]);

    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'openai-codex' as const,
        profileId: 'primary',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'provider_401' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'observed_generation' as const,
      activeProfileId: 'primary',
      generation: 7,
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'openai-codex' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
        },
      };
    });

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn, switchAfterClassifiedFailure },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
    });
    expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }));
    expect(getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('surfaces the group fallback status when active credential refresh fails but the group cannot switch', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'leeroy-acct',
        providerEmail: null,
      },
    });
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: activeRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'leeroy',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'switch_reason_disabled' as const,
      generation: 3,
    }));
    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'claude-subscription',
        groupId: 'claude',
        displayName: null,
        activeProfileId: 'leeroy',
        generation: 3,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: false,
            accountChanged: true,
            refreshFailure: false,
          },
        },
        state: { v: 1 },
        members: [{
          v: 1,
          serviceId: 'claude-subscription',
          groupId: 'claude',
          profileId: 'leeroy',
          enabled: true,
          priority: 100,
          state: { v: 1 },
          createdAt: 1,
          updatedAt: 1,
        }],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'leeroy-acct', expiresAt: now - 1_000 },
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'leeroy',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(),
        switchAfterClassifiedFailure,
      },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnGroupSwitchUnavailableError',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'leeroy',
      status: 'switch_reason_disabled',
    });
  });

  it('keeps the real group switch coordinator bound when default auto fallback handles spawn preflight refresh failure', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof primaryRecord | typeof backupRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['backup', seal(backupRecord)],
    ]);

    let activeProfileId = 'primary';
    let generation = 7;
    const groupMembers = () => [
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: { v: 1 as const },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'backup',
        enabled: true,
        priority: 2,
        state: { v: 1 as const },
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    const groupPolicy = {
      v: 1 as const,
      strategy: 'priority' as const,
      autoSwitch: true,
    };
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      displayName: null,
      activeProfileId,
      generation,
      policy: groupPolicy,
      state: { v: 1 as const },
      members: groupMembers(),
      createdAt: 1,
      updatedAt: 1,
    }));
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async () => await getConnectedServiceAuthGroup());
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async (params: { activeProfileId: string }) => {
      activeProfileId = params.activeProfileId;
      generation += 1;
      return await getConnectedServiceAuthGroup();
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
        },
      };
    });
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile,
      updateConnectedServiceAuthGroupRuntimeState,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]['api'],
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      restartSession: async () => {},
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'primary',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: coordinator,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
    }));
    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'backup',
    }));
    expect(connectedServiceAuth?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('continues group fallback when the first switched Claude profile cannot materialize native auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const narrowRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'narrow-acct',
        providerEmail: null,
      },
    });
    const healthyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'healthy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'healthy-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof primaryRecord | typeof narrowRecord | typeof healthyRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['narrow', seal(narrowRecord)],
      ['healthy', seal(healthyRecord)],
    ]);

    let activeProfileId = 'primary';
    let generation = 7;
    const credentialHealthByProfileId = new Map<string, 'connected' | 'needs_reauth'>([
      ['primary', 'connected'],
      ['narrow', 'connected'],
      ['healthy', 'connected'],
    ]);
    const memberStatesByProfileId = new Map<string, unknown>([
      ['primary', { v: 1 as const }],
      ['narrow', { v: 1 as const }],
      ['healthy', { v: 1 as const }],
    ]);
    const groupMembers = () => [
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'primary',
        enabled: true,
        priority: 1,
        state: memberStatesByProfileId.get('primary') as { v: 1 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'narrow',
        enabled: true,
        priority: 2,
        state: memberStatesByProfileId.get('narrow') as { v: 1 },
        createdAt: 2,
        updatedAt: 2,
      },
      {
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        profileId: 'healthy',
        enabled: true,
        priority: 3,
        state: memberStatesByProfileId.get('healthy') as { v: 1 },
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const groupPolicy = {
      v: 1 as const,
      strategy: 'priority' as const,
      autoSwitch: true,
      switchOn: {
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: true,
      },
    };
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      displayName: null,
      activeProfileId,
      generation,
      policy: groupPolicy,
      state: { v: 1 as const },
      members: groupMembers(),
      createdAt: 1,
      updatedAt: 1,
    }));
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async (params: {
      memberStates: ReadonlyArray<Readonly<{ profileId: string; state: unknown }>>;
    }) => {
      for (const memberState of params.memberStates) {
        memberStatesByProfileId.set(memberState.profileId, memberState.state);
      }
      return await getConnectedServiceAuthGroup();
    });
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async (params: { activeProfileId: string }) => {
      activeProfileId = params.activeProfileId;
      generation += 1;
      return await getConnectedServiceAuthGroup();
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
        },
      };
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async (params: {
      profileId: string;
      health: { status: 'connected' | 'needs_reauth' };
    }) => {
      credentialHealthByProfileId.set(params.profileId, params.health.status);
    });
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'claude-subscription' as const,
      profiles: [
        { profileId: 'primary', status: credentialHealthByProfileId.get('primary') ?? 'connected' },
        { profileId: 'narrow', status: credentialHealthByProfileId.get('narrow') ?? 'connected' },
        { profileId: 'healthy', status: credentialHealthByProfileId.get('healthy') ?? 'connected' },
      ],
    }));
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile,
      updateConnectedServiceAuthGroupRuntimeState,
      updateConnectedServiceCredentialHealth,
      listConnectedServiceProfiles,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]['api'],
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      restartSession: async () => {},
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async (params: { profileId: string }) => {
      if (params.profileId === 'primary') {
        credentialHealthByProfileId.set('primary', 'needs_reauth');
      }
      return {
        status: params.profileId === 'primary' ? 'refresh_failed' as const : 'not_needed' as const,
        credential: null,
        diagnostic: {
          serviceId: 'claude-subscription' as const,
          profileId: params.profileId,
          reason: 'spawn_preflight' as const,
          status: params.profileId === 'primary' ? 'refresh_failed' as const : 'not_needed' as const,
          ...(params.profileId === 'primary' ? { category: 'invalid_grant' as const } : {}),
          expiresAt: params.profileId === 'primary' ? now - 1_000 : null,
          expiryAgeMs: params.profileId === 'primary' ? 1_000 : null,
          refreshWindowMs: 60_000,
        },
      };
    });

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: coordinator,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenNthCalledWith(1, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'narrow',
    }));
    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenNthCalledWith(2, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'healthy',
    }));
    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      memberStates: [expect.objectContaining({ profileId: 'narrow' })],
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      health: expect.objectContaining({
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(connectedServiceAuth?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('continues materialization-failure group fallback through multiple unusable Claude profiles', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const narrowRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:profile',
        tokenType: 'Bearer',
        providerAccountId: 'narrow-acct',
        providerEmail: null,
      },
    });
    const healthyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'healthy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'healthy-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacySecret = credentials.encryption.secret;
    const seal = (payload: typeof primaryRecord | typeof narrowRecord | typeof healthyRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['primary', seal(primaryRecord)],
      ['narrow', seal(narrowRecord)],
      ['healthy', seal(healthyRecord)],
    ]);

    const activeProfiles = ['narrow', 'healthy'];
    const switchAfterClassifiedFailure = vi.fn(async () => {
      const next = activeProfiles.shift();
      return {
        status: next ? 'switched' as const : 'no_candidate' as const,
        activeProfileId: next ?? null,
        generation: next === 'narrow' ? 8 : 9,
      };
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1 as const,
          strategy: 'priority' as const,
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 as const },
        members: [
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 as const },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'main',
            profileId: 'narrow',
            enabled: true,
            priority: 2,
            state: { v: 1 as const },
            createdAt: 2,
            updatedAt: 2,
          },
          {
            v: 1 as const,
            serviceId: 'claude-subscription' as const,
            groupId: 'main',
            profileId: 'healthy',
            enabled: true,
            priority: 3,
            state: { v: 1 as const },
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      })),
      updateConnectedServiceCredentialHealth,
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = ciphertextByProfileId.get(params.profileId);
        if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth' as const,
            providerEmail: null,
            providerAccountId: `${params.profileId}-acct`,
            expiresAt: null,
          },
        };
      }),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchAfterClassifiedFailure,
        switchBeforeTurn: vi.fn(async () => ({ status: 'no_candidate', activeProfileId: null })),
      },
    });

    expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(1, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }));
    expect(switchAfterClassifiedFailure).toHaveBeenNthCalledWith(2, expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'main',
      reason: 'refresh_failed',
      observedProfileId: 'narrow',
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'primary',
      health: expect.objectContaining({
        status: 'needs_reauth',
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      health: expect.objectContaining({
        status: 'needs_reauth',
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('switches a Claude group when the active middle-priority member has a permanent preflight refresh failure', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const now = 1_000_000;

    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'leeroy-expired-access',
        refreshToken: 'leeroy-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'leeroy-acct',
        providerEmail: null,
      },
    });
    const fallbackRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'batiplus',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'batiplus-access',
        refreshToken: 'batiplus-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'batiplus-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const seal = (payload: typeof activeRecord | typeof fallbackRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByProfileId = new Map([
      ['leeroy', seal(activeRecord)],
      ['batiplus', seal(fallbackRecord)],
    ]);

    let activeProfileId = 'leeroy';
    let generation = 3;
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'claude',
      displayName: null,
      activeProfileId,
      generation,
      policy: {
        v: 1 as const,
        strategy: 'priority' as const,
        autoSwitch: true,
        switchOn: {
          usageLimit: true,
          authExpired: true,
          accountChanged: true,
          refreshFailure: false,
        },
      },
      state: { v: 1 as const },
      members: [
        {
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'claude',
          profileId: 'batiplus',
          enabled: true,
          priority: 100,
          state: { v: 1 as const },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'claude',
          profileId: 'leeroy',
          enabled: true,
          priority: 100,
          state: {
            v: 1 as const,
            lastFailureKind: 'refresh_failed',
            lastObservedAtMs: now - 500,
          },
          createdAt: 2,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'claude',
          profileId: 'leeroy_batiplus',
          enabled: true,
          priority: 100,
          state: { v: 1 as const },
          createdAt: 3,
          updatedAt: 3,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }));
    const updateConnectedServiceAuthGroupRuntimeState = vi.fn(async () => await getConnectedServiceAuthGroup());
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async (params: { activeProfileId: string }) => {
      activeProfileId = params.activeProfileId;
      generation += 1;
      return await getConnectedServiceAuthGroup();
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (params.serviceId !== 'claude-subscription' || !ciphertext) return null;
      return {
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: `${params.profileId}-acct`,
          expiresAt: params.profileId === 'leeroy' ? now - 1_000 : null,
        },
      };
    });
    const api = {
      getConnectedServiceAuthGroup,
      updateConnectedServiceAuthGroupActiveProfile,
      updateConnectedServiceAuthGroupRuntimeState,
      getConnectedServiceCredentialSealed,
    } as unknown as ApiClient;
    const coordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
      api: api as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]['api'],
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      restartSession: async () => {},
    });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(async () => ({
      status: 'refresh_failed' as const,
      credential: null,
      diagnostic: {
        serviceId: 'claude-subscription' as const,
        profileId: 'leeroy',
        reason: 'spawn_preflight' as const,
        status: 'refresh_failed' as const,
        category: 'invalid_grant' as const,
        expiresAt: now - 1_000,
        expiryAgeMs: 1_000,
        refreshWindowMs: 60_000,
      },
    }));

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
            profileId: 'leeroy',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: coordinator,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    });

    expect(updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'claude',
    }));
    expect(updateConnectedServiceAuthGroupActiveProfile).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'batiplus',
    }));
    expect(connectedServiceAuth?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(connectedServiceAuth?.env.CLAUDE_CONFIG_DIR).toBeTypeOf('string');
    const credential = await readClaudeCodeNativeCredential(connectedServiceAuth!.env.CLAUDE_CONFIG_DIR!);
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'batiplus-access',
        refreshToken: 'batiplus-refresh',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
  });

  it('fetches, decrypts, and materializes auth for a spawn', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
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

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'work') return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    });

    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth!.env.CODEX_HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home'),
    );
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('access');
  });

  it('resolves group bindings through the server active profile and materializes the group home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceAuthGroup: async (params: { serviceId: string; groupId: string }) => {
        expect(params).toEqual({ serviceId: 'openai-codex', groupId: 'main' });
        return {
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          generation: 7,
          policy: { v: 1, strategy: 'priority' },
        };
      },
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'backup') return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'backup-acct', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'fallback',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    });

    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth!.env.CODEX_HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', 'codex', 'codex-home'),
    );
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('rejects group bindings when the current server group has no active profile instead of using the UI fallback', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: null,
        generation: 7,
        policy: { v: 1, strategy: 'priority' },
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'stale-ui-fallback',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    })).rejects.toThrow(/active profile/i);

    expect((api as unknown as { getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn> }).getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('switches exhausted group active profile before materializing spawn auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const backupCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async () => ({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      displayName: null,
      activeProfileId: 'backup',
      generation: 8,
      policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
      state: { v: 1 },
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'primary',
          enabled: true,
          priority: 1,
          state: { v: 1, quotaExhaustedUntilMs: 5_000 },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'backup',
          enabled: true,
          priority: 2,
          state: { v: 1 },
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }));
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1, quotaExhaustedUntilMs: 5_000 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      updateConnectedServiceAuthGroupActiveProfile,
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex') return null;
        const ciphertextByProfileId = {
          primary: primaryCiphertext,
          backup: backupCiphertext,
        } as const;
        const sealedCiphertext = ciphertextByProfileId[profileId as keyof typeof ciphertextByProfileId];
        if (!sealedCiphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolveWithCoordinator = resolveConnectedServiceAuthForSpawn as unknown as (
      params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
        authGroupSwitchCoordinator: Readonly<{
          switchBeforeTurn: typeof switchBeforeTurn;
        }>;
        sessionId: string;
      },
    ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

    const connectedServiceAuth = await resolveWithCoordinator({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn },
    });

    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'usage_limit',
    });
    expect(updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('delegates stale group quota probing to the pre-turn coordinator before materializing spawn auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: 'primary-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'primary-acct',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(18) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const backupCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 8,
    }));
    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        displayName: null,
        activeProfileId: 'primary',
        generation: 7,
        policy: {
          v: 1,
          strategy: 'least_limited',
          autoSwitch: true,
          probeIfSnapshotOlderThanMs: 60_000,
          preTurnProbeMode: 'when_stale',
          preTurnProbeOrder: 'current_first_then_candidates',
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      }),
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex') return null;
        const ciphertextByProfileId = {
          primary: primaryCiphertext,
          backup: backupCiphertext,
        } as const;
        const sealedCiphertext = ciphertextByProfileId[profileId as keyof typeof ciphertextByProfileId];
        if (!sealedCiphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `${profileId}-acct`, expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolveWithCoordinator = resolveConnectedServiceAuthForSpawn as unknown as (
      params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
        authGroupSwitchCoordinator: Readonly<{
          switchBeforeTurn: typeof switchBeforeTurn;
        }>;
        sessionId: string;
      },
    ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

    const connectedServiceAuth = await resolveWithCoordinator({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000_000,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: { switchBeforeTurn },
    });

    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'main',
      reason: 'soft_threshold',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('keeps the direct API active-profile fallback bound when no switch coordinator is injected', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(10) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const legacyEncryption = credentials.encryption;
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacyEncryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    });

    class BoundFallbackApi {
      readonly credential = { token: 'happy-token' };
      updateRequest: Readonly<{
        serviceId: string;
        groupId: string;
        activeProfileId: string;
        expectedGeneration?: number;
      }> | null = null;

      async getConnectedServiceAuthGroup() {
        return {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          displayName: null,
          activeProfileId: 'primary',
          generation: 7,
          policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
          state: { v: 1 },
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'main',
              profileId: 'primary',
              enabled: true,
              priority: 1,
              state: { v: 1, quotaExhaustedUntilMs: 5_000 },
              createdAt: 1,
              updatedAt: 1,
            },
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'main',
              profileId: 'backup',
              enabled: true,
              priority: 2,
              state: { v: 1 },
              createdAt: 2,
              updatedAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        };
      }

      async updateConnectedServiceAuthGroupActiveProfile(params: Readonly<{
        serviceId: string;
        groupId: string;
        activeProfileId: string;
        expectedGeneration?: number;
      }>) {
        if (this.credential.token !== 'happy-token') {
          throw new Error('api method receiver was not preserved');
        }
        this.updateRequest = params;
        return {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          displayName: null,
          activeProfileId: params.activeProfileId,
          generation: 8,
          policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
          state: { v: 1 },
          members: [],
          createdAt: 1,
          updatedAt: 2,
        };
      }

      async getConnectedServiceCredentialSealed(params: { serviceId: string; profileId: string }) {
        if (params.serviceId !== 'openai-codex' || params.profileId !== 'backup') return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: { kind: 'oauth' as const, providerEmail: null, providerAccountId: 'backup-acct', expiresAt: null },
        };
      }
    }

    const api = new BoundFallbackApi();
    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api: api as unknown as ApiClient,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
    });

    expect(api.updateRequest).toMatchObject({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 7,
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });
});
