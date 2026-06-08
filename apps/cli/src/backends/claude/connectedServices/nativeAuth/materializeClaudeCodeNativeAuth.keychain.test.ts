import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './claudeCodeCredentialScopes';
import { resolveClaudeCodeMacOsKeychainServiceName } from './claudeCodeMacOsKeychain';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const { spawnSyncSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncSpy,
  };
});

function buildClaudeOauthRecord() {
  return buildConnectedServiceCredentialRecord({
    now: REALISTIC_ISSUED_AT_MS,
    serviceId: 'claude-subscription',
    profileId: 'oauth-profile',
    kind: 'oauth',
    expiresAt: REALISTIC_EXPIRES_AT_MS,
    oauth: {
      accessToken: 'selected-access-placeholder',
      refreshToken: 'selected-refresh-placeholder',
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

describe('materializeClaudeSubscriptionNativeAuthHome macOS keychain integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    spawnSyncSpy.mockReset();
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('writes the final target home credential into the matching macOS keychain service after atomic replace', async () => {
    spawnSyncSpy.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      error: undefined,
      pid: 1,
      output: ['', '', ''],
      signal: null,
    });
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { materializeClaudeSubscriptionNativeAuthHome } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-target-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record: buildClaudeOauthRecord(),
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth-profile',
      },
    });

    expect(result.status).toBe('materialized');
    expect(spawnSyncSpy).toHaveBeenCalledWith(
      'security',
      [
        'add-generic-password',
        '-U',
        '-a',
        expect.any(String),
        '-s',
        resolveClaudeCodeMacOsKeychainServiceName({
          claudeConfigDir: targetClaudeConfigDir,
          homeDir,
        }),
        '-w',
      ],
      expect.objectContaining({
        encoding: 'utf8',
        input: expect.stringContaining('selected-access-placeholder'),
      }),
    );
  });

  it('fails closed with a blocking diagnostic when the macOS keychain write fails after materialization', async () => {
    spawnSyncSpy.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'keychain write failed',
      error: undefined,
      pid: 1,
      output: ['', '', ''],
      signal: null,
    });
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const { materializeClaudeSubscriptionNativeAuthHome } = await import('./materializeClaudeCodeNativeAuth');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-source-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-target-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');

    const result = await materializeClaudeSubscriptionNativeAuthHome({
      record: buildClaudeOauthRecord(),
      targetClaudeConfigDir,
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      accountSettings: null,
      sessionDirectory: null,
      selectionDescriptor: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'oauth-profile',
      },
    });

    expect(result.status).toBe('diagnostic');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: targetClaudeConfigDir });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'claude_subscription_native_auth_keychain_write_failed',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        reason: 'keychain_write_failed',
      }),
    ]);
  });
});
