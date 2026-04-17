import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { Credentials } from '@/persistence';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { encodeBase64 } from '@/api/encryption';
import { resolveVendorResumeIdForExistingSession } from '@/daemon/spawn/resolveVendorResumeIdForExistingSession';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

export type ExistingSessionAttachContext = Readonly<{
  ok: true;
  attachPayload: SessionAttachFilePayload;
  vendorResumeId: string | null;
  sessionPath: string | null;
}>;

export type ExistingSessionAttachContextFailureReason =
  | 'missingSessionId'
  | 'missingToken'
  | 'notAuthenticated'
  | 'fetchFailed'
  | 'sessionNotFound'
  | 'missingCredentials'
  | 'invalidEncryptionKey';

export type ExistingSessionAttachContextFailure = Readonly<{
  ok: false;
  reason: ExistingSessionAttachContextFailureReason;
}>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveExistingSessionPath(params: Readonly<{
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  credentials: Credentials | null;
}>): string | null {
  const metadata = resolveSessionStoredContentEncryptionMode(params.rawSession) === 'plain'
    ? tryParseJsonRecord(typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '')
    : params.credentials
      ? tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession })
      : null;
  const path = typeof metadata?.path === 'string' ? metadata.path.trim() : '';
  return path || null;
}

function buildExistingSessionAttachContext(params: Readonly<{
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  agent: unknown;
  credentials: Credentials | null;
}>): ExistingSessionAttachContext | ExistingSessionAttachContextFailure {
  const sessionPath = resolveExistingSessionPath({
    rawSession: params.rawSession,
    credentials: params.credentials,
  });
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return {
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: resolveVendorResumeIdForExistingSession({
        agent: params.agent,
        credentials: params.credentials,
        rawSession: params.rawSession,
      }),
      sessionPath,
    };
  }

  if (!params.credentials) return { ok: false, reason: 'missingCredentials' };

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  if (ctx.encryptionKey.length !== 32) return { ok: false, reason: 'invalidEncryptionKey' };

  return {
    ok: true,
    attachPayload: {
      v: 2,
      encryptionMode: 'e2ee',
      encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
      encryptionVariant: ctx.encryptionVariant,
    },
    vendorResumeId: resolveVendorResumeIdForExistingSession({
      agent: params.agent,
      credentials: params.credentials,
      rawSession: params.rawSession,
    }),
    sessionPath,
  };
}

export async function resolveExistingSessionAttachContext(_params: Readonly<{
  token: string;
  sessionId: string;
  agent: unknown;
  credentials: Credentials | null;
}>): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> {
  const token = normalizeString(_params.token);
  const sessionId = normalizeString(_params.sessionId);
  if (!sessionId) return { ok: false, reason: 'missingSessionId' };
  if (!token) return { ok: false, reason: 'missingToken' };

  try {
    const raw = await fetchSessionByIdCompat({ token, sessionId });
    if (!raw) return { ok: false, reason: 'sessionNotFound' };

    return buildExistingSessionAttachContext({
      rawSession: raw,
      agent: _params.agent,
      credentials: _params.credentials,
    });
  } catch (error) {
    if (isAuthenticationError(error)) return { ok: false, reason: 'notAuthenticated' };
    return { ok: false, reason: 'fetchFailed' };
  }
}
