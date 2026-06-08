import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import {
  materializeClaudeCodeNativeAuth,
  materializeClaudeSubscriptionNativeAuthHome,
} from './materializeClaudeCodeNativeAuth';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

describe('materializeClaudeCodeNativeAuth', () => {
  beforeEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('materializes direct and group Claude subscription homes through one helper with equivalent required auth artifacts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const profileClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-profile-'));
    const groupClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-group-'));
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'work-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account-id',
        providerEmail: 'user@example.test',
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
          },
        },
      },
    });

    const profile = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir: profileClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'work-profile',
      },
    });
    const group = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir: groupClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'work-profile',
        fallbackProfileId: 'fallback-profile',
        generation: 7,
      },
    });

    expect(profile.env).toEqual({
      CLAUDE_CONFIG_DIR: profileClaudeConfigDir,
    });
    expect(group.env).toEqual({
      CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
    });

    const profileCredential = JSON.parse(await readFile(join(profileClaudeConfigDir, '.credentials.json'), 'utf8'));
    const groupCredential = JSON.parse(await readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'));
    expect(groupCredential).toEqual(profileCredential);
    expect(groupCredential.claudeAiOauth).toMatchObject({
      accessToken: 'selected-access-placeholder',
      refreshToken: 'selected-refresh-placeholder',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      subscriptionType: 'max',
      rateLimitTier: 'max_20x',
    });
    await expect(readFile(join(profileClaudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
    await expect(readFile(join(groupClaudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');

    expect(profile.identityDiagnostic).toMatchObject({
      serviceId: 'claude-subscription',
      selectionKind: 'profile',
      profileId: 'work-profile',
      targetRootKind: 'profile_home',
      credentialHealthStatus: 'ok',
      hasProviderAccountId: true,
      hasProviderEmail: true,
    });
    expect(group.identityDiagnostic).toMatchObject({
      serviceId: 'claude-subscription',
      selectionKind: 'group',
      groupId: 'claude-team',
      activeProfileId: 'work-profile',
      targetRootKind: 'group_home',
      credentialHealthStatus: 'ok',
      hasProviderAccountId: true,
      hasProviderEmail: true,
    });
    expect(JSON.stringify(profile.identityDiagnostic)).not.toContain('selected-access-placeholder');
    expect(JSON.stringify(group.identityDiagnostic)).not.toContain('selected-refresh-placeholder');
  });

  it('writes native credentials and returns only CLAUDE_CONFIG_DIR for healthy OAuth records', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

    expect(result).toEqual({
      status: 'materialized',
      env: {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
      diagnostics: [],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
    const credentialFile = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credentialFile.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    expect(credentialFile.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(credentialFile.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);
    expect(result.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
  });

  it('materializes Claude subscription homes as self-contained copies and imports source session files', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-'));
    const sourceSettingsDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-settings-'));
    const sourceProjectsDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-source-projects-'));
    await writeFile(join(sourceSettingsDir, 'settings.json'), '{"theme":"source"}\n');
    await mkdir(join(sourceProjectsDir, 'repo-a'), { recursive: true });
    await writeFile(join(sourceProjectsDir, 'repo-a', 'resume-123.jsonl'), '{"type":"session"}\n');
    await symlink(join(sourceSettingsDir, 'settings.json'), join(sourceClaudeConfigDir, 'settings.json'));
    await symlink(sourceProjectsDir, join(sourceClaudeConfigDir, 'projects'));

    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-'));
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record,
      targetClaudeConfigDir: claudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'oauth',
        fallbackProfileId: 'fallback',
        generation: 3,
      },
    });

    expect(result.status).toBe('materialized');
    await expect(readFile(join(claudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
    expect((await lstat(join(claudeConfigDir, 'settings.json'))).isSymbolicLink()).toBe(false);
    await expect(readFile(join(claudeConfigDir, 'projects', 'repo-a', 'resume-123.jsonl'), 'utf8')).resolves.toBe('{"type":"session"}\n');
    expect((await lstat(join(claudeConfigDir, 'projects'))).isSymbolicLink()).toBe(false);
    expect(result.identityDiagnostic).toMatchObject({
      selectionKind: 'group',
      groupId: 'claude-team',
      activeProfileId: 'oauth',
      targetRootKind: 'group_home',
    });
  });

  it('returns a safe reconnect diagnostic and does not write partial credentials when scopes are insufficient', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-secret-placeholder',
        refreshToken: 'refresh-secret-placeholder',
        idToken: null,
        scope: 'user:profile user:inference',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

    expect(result.status).toBe('diagnostic');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'claude_subscription_missing_claude_code_scope',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        reason: 'missing_required_scope',
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
    await expect(lstat(join(claudeConfigDir, '.credentials.json'))).rejects.toThrow();
  });

  it('returns a safe blocking diagnostic when credential file materialization fails', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const blockingPath = join(parentDir, 'not-a-directory');
    await writeFile(blockingPath, 'file blocks nested config dir');
    const claudeConfigDir = join(blockingPath, 'claude-config');
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-secret-placeholder',
        refreshToken: 'refresh-secret-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeClaudeCodeNativeAuth({ record, claudeConfigDir });

    expect(result.status).toBe('diagnostic');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: claudeConfigDir });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'claude_subscription_native_auth_materialization_failed',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        reason: 'credential_file_write_failed',
        severity: 'blocking',
      }),
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret-placeholder');
  });
});
