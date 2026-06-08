import { readFile } from 'node:fs/promises';

import {
  parseClaudeCodeCredentialFile,
  resolveClaudeCodeCredentialsFilePath,
} from './claudeCodeCredentialFile';
import { readClaudeCodeMacOsKeychainCredential } from './claudeCodeMacOsKeychain';
import { findMissingClaudeCodeCredentialScopes } from './claudeCodeCredentialScopes';

export type ClaudeCodeNativeAuthVerificationResult = Readonly<{
  status:
    | 'ok'
    | 'missing_credentials_file'
    | 'unsupported_shape'
    | 'missing_access_token'
    | 'missing_refresh_token'
    | 'missing_required_scope'
    | 'expired';
  missingScopes: readonly string[];
  credentialPath: string;
}>;

/**
 * Verifies that a materialized Claude Code `.credentials.json` is plausibly usable,
 * not merely well-formed. Shape/presence/scope checks alone let a stale-but-structurally-valid
 * credential pass; this is the gap that allowed a superseded token to be treated as healthy at
 * spawn and at the `credential_refreshed` success boundary. We add a deterministic expiry-vs-now
 * gate so an already-expired credential fails closed. A null/unknown expiry is NOT treated as
 * expired here (it cannot be proven stale, and the refresh coordinator handles unknown-expiry
 * separately); coercing unknown expiry to "expired" would falsely reject valid credentials.
 */
export async function verifyClaudeCodeNativeAuth(params: Readonly<{
  claudeConfigDir: string;
  now?: number;
}>): Promise<ClaudeCodeNativeAuthVerificationResult> {
  const credentialPath = resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(credentialPath, 'utf8'));
  } catch {
    return { status: 'missing_credentials_file', missingScopes: [], credentialPath };
  }

  const parsed = parseClaudeCodeCredentialFile(raw);
  if (parsed.status !== 'ok') {
    return { status: 'unsupported_shape', missingScopes: [], credentialPath };
  }
  if (!parsed.hasAccessToken) {
    return { status: 'missing_access_token', missingScopes: [], credentialPath };
  }
  if (!parsed.hasRefreshToken) {
    return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
  }
  const missingScopes = findMissingClaudeCodeCredentialScopes(parsed.scopes);
  if (missingScopes.length > 0) {
    return { status: 'missing_required_scope', missingScopes, credentialPath };
  }
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? params.now : Date.now();
  if (typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt) && parsed.expiresAt <= now) {
    return { status: 'expired', missingScopes: [], credentialPath };
  }
  if (process.platform === 'darwin') {
    const keychainPayload = await readClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: params.claudeConfigDir,
    });
    const keychainParsed = parseClaudeCodeCredentialFile(keychainPayload);
    if (keychainParsed.status !== 'ok') {
      return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
    }
    if (!keychainParsed.hasAccessToken) {
      return { status: 'missing_access_token', missingScopes: [], credentialPath };
    }
    if (!keychainParsed.hasRefreshToken) {
      return { status: 'missing_refresh_token', missingScopes: [], credentialPath };
    }
    const missingKeychainScopes = findMissingClaudeCodeCredentialScopes(keychainParsed.scopes);
    if (missingKeychainScopes.length > 0) {
      return {
        status: 'missing_required_scope',
        missingScopes: missingKeychainScopes,
        credentialPath,
      };
    }
    if (
      typeof keychainParsed.expiresAt === 'number'
      && Number.isFinite(keychainParsed.expiresAt)
      && keychainParsed.expiresAt <= now
    ) {
      return { status: 'expired', missingScopes: [], credentialPath };
    }
  }
  return { status: 'ok', missingScopes: [], credentialPath };
}
