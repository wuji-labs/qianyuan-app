import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from './createClaudeConnectedServiceRuntimeAuthAdapter';
import { CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY } from './claudeRuntimeAuthSharedGroupSurfaceMetadata';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { writeClaudeCodeCredentialsFile } from './nativeAuth/claudeCodeCredentialFile';

const FUTURE_EXPIRES_AT_MS = Date.now() + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

describe('createClaudeConnectedServiceRuntimeAuthAdapter', () => {
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

  it('does not treat healthy Claude subscription native credentials as runtime account adoption proof', async () => {
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
      status: 'unavailable',
      retryable: true,
      reason: 'claude_code_runtime_account_adoption_unproven',
      errorClassification: {
        missingScopes: [],
      },
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

  it('does not advertise Claude subscription runtime config rewrites as provider hot-apply', async () => {
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-group-config-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'new-access-placeholder',
        refreshToken: 'new-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const selection = {
      record,
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
      targetMaterializedRoot: runtimeClaudeConfigDir,
      [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir,
        runtimeMaterializedRoot: runtimeClaudeConfigDir,
        sourceClaudeConfigDir: runtimeClaudeConfigDir,
      },
    };

    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    expect(adapter.canHotApply({ target: { agentId: 'claude' }, selection })).toEqual({
      supported: false,
      recovery: 'restart_rematerialize',
    });
    await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection })).resolves.toEqual({
      applied: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_rematerialize',
    });
  });

  it('does not treat probe-backed Claude group runtime config rewrite as live account adoption proof', async () => {
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-source-'));
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-group-config-'));
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
      claudeConfigDir: runtimeClaudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
        },
      },
    });

    await expect(createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
        targetMaterializedRoot: runtimeClaudeConfigDir,
        [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: {
          mode: 'shared_group_auth_surface',
          runtimeClaudeConfigDir,
          runtimeMaterializedRoot: runtimeClaudeConfigDir,
          sourceClaudeConfigDir,
        },
      },
    })).resolves.toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'claude_code_runtime_account_adoption_unproven',
      errorClassification: {
        missingScopes: [],
      },
    });
  });
});
