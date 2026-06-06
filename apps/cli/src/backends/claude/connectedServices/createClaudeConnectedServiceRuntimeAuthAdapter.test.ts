import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from './createClaudeConnectedServiceRuntimeAuthAdapter';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { writeClaudeCodeCredentialsFile } from './nativeAuth/claudeCodeCredentialFile';

const FUTURE_EXPIRES_AT_MS = Date.now() + 60 * 60 * 1000;

describe('createClaudeConnectedServiceRuntimeAuthAdapter', () => {
  it('verifies healthy Claude subscription OAuth records by native credential health', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
        },
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
    });

    expect(result).toEqual({
      status: 'verified',
      providerAccountId: 'provider-account',
      reason: 'claude_code_native_credentials_file_healthy',
    });
  });

  it('fails closed when the materialized Claude native credential file is already expired', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: Date.now() - 60 * 60 * 1000,
          scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
        },
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'expired',
      errorClassification: {
        missingScopes: [],
      },
    });
  });

  it('fails closed when the materialized Claude native credential file is missing', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'missing_credentials_file',
      errorClassification: {
        missingScopes: [],
      },
    });
  });

  it('fails closed when the selected Claude subscription OAuth record cannot materialize native auth', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: 'user:profile user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: { record },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'missing_required_scope',
      errorClassification: {
        missingScopes: ['user:sessions:claude_code'],
      },
    });
  });
});
