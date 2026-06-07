import { describe, expect, it, vi } from 'vitest';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { retryOriginalCommittedUserMessageWithDeps } from './retryOriginalCommittedUserMessage';

describe('retryOriginalCommittedUserMessageWithDeps', () => {
  it('replays the original committed user text with the retry local id instead of reusing the original message id', async () => {
    const resolveTransportContext = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      // Boundary fixture: retryOriginalCommittedUserMessage does not inspect the
      // raw session, but the shared transport context carries it for other callers.
      rawSession: {} as RawSessionRecord,
      ctx: {
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    }));
    const fetchOriginalUserText = vi.fn(async () => ({
      text: 'original prompt',
      localId: 'original-committed-local-id',
      createdAt: 900,
      permissionMode: 'yolo',
      model: 'claude-sonnet',
    }));
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'connected-service-original-retry:abc123',
      waited: false,
    }));

    await retryOriginalCommittedUserMessageWithDeps(
      {
        resolveTransportContext,
        fetchOriginalUserText,
        sendMessage,
      },
      {
        credentials: { token: 'token', secret: new Uint8Array(32) } as any,
        sessionId: 'session-1',
        failureAtMs: 1_000,
        localId: 'connected-service-original-retry:abc123',
      },
    );

    expect(sendMessage).toHaveBeenCalledWith({
      credentials: { token: 'token', secret: expect.any(Uint8Array) },
      idOrPrefix: 'session-1',
      message: 'original prompt',
      localId: 'connected-service-original-retry:abc123',
      wait: false,
      timeoutMs: 1,
      permissionModeOverride: 'yolo',
      modelOverride: 'claude-sonnet',
    });
  });
});
