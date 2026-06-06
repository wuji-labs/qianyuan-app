import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  verifyClaudeCodeNativeAuth,
} from './verifyClaudeCodeNativeAuth';
import {
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './claudeCodeCredentialFile';

const NOW_MS = Date.parse('2026-06-06T12:00:00.000Z');
const FUTURE_EXPIRES_AT_MS = NOW_MS + 60 * 60 * 1000;
const PAST_EXPIRES_AT_MS = NOW_MS - 60 * 60 * 1000;

describe('verifyClaudeCodeNativeAuth', () => {
  it('verifies an isolated Claude config dir with native Claude Code credentials', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).toEqual({
      status: 'ok',
      missingScopes: [],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
  });

  it('rejects an already-expired credential as a usability gate', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: PAST_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS });

    expect(result.status).toBe('expired');
    expect(result.missingScopes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-placeholder');
  });

  it('does not reject a credential whose expiry is unknown (null)', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    await writeFile(
      credentialPath,
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      })}\n`,
    );

    expect(await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).toEqual({
      status: 'ok',
      missingScopes: [],
      credentialPath,
    });
  });

  it('fails closed when the credentials file is missing', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    expect((await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).status).toBe(
      'missing_credentials_file',
    );
  });

  it('fails closed when the credential shape is unsupported', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    await writeFile(credentialPath, `${JSON.stringify({ unexpected: true })}\n`);

    expect((await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS })).status).toBe(
      'unsupported_shape',
    );
  });

  it('fails closed without exposing credential values when the file is missing required scope', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-verify-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile'],
        },
      },
    });

    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: NOW_MS });

    expect(result).toEqual({
      status: 'missing_required_scope',
      missingScopes: ['user:sessions:claude_code'],
      credentialPath: join(claudeConfigDir, '.credentials.json'),
    });
    expect(JSON.stringify(result)).not.toContain('secret-placeholder');
    expect(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')).toContain('secret-placeholder');
  });
});
