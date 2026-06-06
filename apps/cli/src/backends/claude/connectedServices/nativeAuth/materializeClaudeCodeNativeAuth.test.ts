import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import { materializeClaudeCodeNativeAuth } from './materializeClaudeCodeNativeAuth';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;

describe('materializeClaudeCodeNativeAuth', () => {
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
      env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      diagnostics: [],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
    const credentialFile = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credentialFile.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    expect(credentialFile.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(credentialFile.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);
    expect(result.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
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
