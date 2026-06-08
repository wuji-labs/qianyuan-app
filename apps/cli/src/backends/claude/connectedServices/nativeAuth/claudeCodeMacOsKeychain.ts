import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import type { ClaudeCodeNativeCredentialPayload } from './claudeCodeCredentialFile';

const DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

function resolveDefaultClaudeConfigDir(homeDir: string): string {
  return resolve(join(homeDir, '.claude'));
}

export function resolveClaudeCodeMacOsKeychainServiceName(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
}>): string {
  const resolvedClaudeConfigDir = resolve(params.claudeConfigDir);
  const resolvedHomeDir = resolve(String(params.homeDir ?? homedir()));
  if (resolvedClaudeConfigDir === resolveDefaultClaudeConfigDir(resolvedHomeDir)) {
    return DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE;
  }
  const suffix = createHash('sha256').update(resolvedClaudeConfigDir).digest('hex').slice(0, 8);
  return `${DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE}-${suffix}`;
}

function buildKeychainPayloadInput(payload: ClaudeCodeNativeCredentialPayload): string {
  const serialized = JSON.stringify(payload);
  // The macOS security CLI prompts for both the secret and a confirmation retype
  // when using `-w` interactively; piping the value twice keeps the write stable
  // in non-interactive agent execution as well.
  return `${serialized}\n${serialized}\n`;
}

function buildKeychainWriteError(stderr: string, status: number | null): Error {
  const detail = stderr.trim();
  return new Error(
    detail.length > 0
      ? `claude_code_keychain_write_failed:${detail}`
      : `claude_code_keychain_write_failed:status_${status ?? 'unknown'}`,
  );
}

export async function writeClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  payload: ClaudeCodeNativeCredentialPayload;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<void> {
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  const username = String(params.username ?? userInfo().username).trim();
  const result = spawnSync(
    'security',
    ['add-generic-password', '-U', '-a', username, '-s', serviceName, '-w'],
    {
      encoding: 'utf8',
      input: buildKeychainPayloadInput(params.payload),
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw buildKeychainWriteError(String(result.stderr ?? ''), result.status);
  }
}

export async function readClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
}>): Promise<ClaudeCodeNativeCredentialPayload | null> {
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', serviceName, '-w'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw.trim()) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as ClaudeCodeNativeCredentialPayload : null;
  } catch {
    return null;
  }
}
