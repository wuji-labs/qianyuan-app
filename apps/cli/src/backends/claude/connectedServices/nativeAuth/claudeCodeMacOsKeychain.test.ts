import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncSpy, spawnSyncSpy } = vi.hoisted(() => ({
  execFileSyncSpy: vi.fn(),
  spawnSyncSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncSpy,
    spawnSync: spawnSyncSpy,
  };
});

import {
  readClaudeCodeMacOsKeychainCredential,
  resolveClaudeCodeMacOsKeychainServiceName,
  writeClaudeCodeMacOsKeychainCredential,
} from './claudeCodeMacOsKeychain';

describe('claudeCodeMacOsKeychain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    execFileSyncSpy.mockReset();
    spawnSyncSpy.mockReset();
  });

  it('uses the unsuffixed service for the default Claude config dir and a hashed suffix for custom dirs', () => {
    expect(
      resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: '/Users/tester/.claude',
        homeDir: '/Users/tester',
      }),
    ).toBe('Claude Code-credentials');

    expect(
      resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: '/tmp/custom-claude-home',
        homeDir: '/Users/tester',
      }),
    ).toBe('Claude Code-credentials-e161167c');
  });

  it('writes the credential JSON to the derived macOS keychain service without putting secrets in argv', async () => {
    spawnSyncSpy.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      error: undefined,
      pid: 1,
      output: ['', '', ''],
      signal: null,
    });

    await writeClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      'security',
      [
        'add-generic-password',
        '-U',
        '-a',
        'tester',
        '-s',
        'Claude Code-credentials-e161167c',
        '-w',
      ],
      expect.objectContaining({
        encoding: 'utf8',
        input: `${JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-placeholder',
            refreshToken: 'refresh-placeholder',
            expiresAt: 123,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        })}\n${JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-placeholder',
            refreshToken: 'refresh-placeholder',
            expiresAt: 123,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        })}\n`,
      }),
    );
    expect(spawnSyncSpy.mock.calls[0]?.[1]).not.toContain('access-placeholder');
    expect(spawnSyncSpy.mock.calls[0]?.[1]).not.toContain('refresh-placeholder');
  });

  it('reads and parses the derived macOS keychain credential payload', async () => {
    execFileSyncSpy.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: 123,
          scopes: ['user:profile', 'user:sessions:claude_code'],
        },
      }),
    );

    await expect(
      readClaudeCodeMacOsKeychainCredential({
        claudeConfigDir: '/tmp/custom-claude-home',
        homeDir: '/Users/tester',
      }),
    ).resolves.toEqual({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        expiresAt: 123,
        scopes: ['user:profile', 'user:sessions:claude_code'],
      },
    });

    expect(execFileSyncSpy).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials-e161167c', '-w'],
      expect.objectContaining({
        encoding: 'utf8',
      }),
    );
  });
});
