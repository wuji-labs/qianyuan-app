import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { encrypt } from '../encryption';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';

describe('handleSessionNewMessageUpdate', () => {
  it('logs invalid content envelope shapes without leaking string contents', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const debug = vi.fn();

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { foo: 'bar', secret: 'SUPER_SECRET_VALUE' },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug,
      debugLargeJson: () => void 0,
    });

    expect(debug).toHaveBeenCalled();
    const calls = JSON.stringify(debug.mock.calls);
    expect(calls).toContain('secret');
    expect(calls).not.toContain('SUPER_SECRET_VALUE');
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(false);
  });

  it('explicit owed catch-up replays a user row whose id was already observed but never delivered', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const receivedMessageIds = new Set<string>(['m6']);
    const update = {
      id: 'catchup-m6',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm6',
          seq: 6,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '/context' } } },
          localId: 'local-6',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds,
      allowReprocessReceivedMessageIds: true,
      lastObservedMessageSeq: 6,
      lastObservedUserMessageSeq: 5,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
  });

  it('without reprocess authorization an already-observed id stays deduped', () => {
    const pendingMessages: any[] = [];
    const update = {
      id: 'u-dup',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm6',
          seq: 6,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'dup' } } },
          localId: 'local-6',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(['m6']),
      lastObservedMessageSeq: 6,
      lastObservedUserMessageSeq: 5,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
  });

  it('delivers legacy string user prompts to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'hello legacy' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello legacy');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('applies the agent-queue delivery gate to legacy string user prompts', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const shouldDeliverUserMessageToAgentQueue = vi.fn(() => false);

    const update = {
      id: 'catchup-1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: { t: 'plain', v: { role: 'user', content: 'stale legacy prompt' } },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      shouldDeliverUserMessageToAgentQueue,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(shouldDeliverUserMessageToAgentQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: { type: 'text', text: 'stale legacy prompt' },
      }),
      update,
    );
    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('delivers legacy ciphertext string content envelopes to the agent queue', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);

    const rawBody = {
      role: 'user',
      content: { type: 'text', text: 'hello encrypted' },
    };
    const ciphertextBytes = encrypt(encryptionKey, 'legacy', rawBody);
    const ciphertext = Buffer.from(ciphertextBytes).toString('base64');

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          // Legacy server/client shape: `content` was just ciphertext.
          content: ciphertext,
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey,
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello encrypted');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not drop user prompts when agent-queue echo suppression is set but no callback is attached', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: null,
      pendingMessages,
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content?.type).toBe('text');
    expect(pendingMessages[0]?.content?.text).toBe('hello');
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  it('does not redeliver deterministic daemon-initial-prompt user messages already sent by this agent process', () => {
    const pendingMessages: any[] = [];
    const emitted: any[] = [];
    const pendingMessageCallback = (msg: any) => pendingMessages.push(msg);
    const localId = 'daemon-initial-prompt:sess_1';

    const update = {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'daemon initial prompt' },
              localId,
              meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
            },
          },
          localId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;

    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => true,
      hasAgentQueueEchoSuppressedLocalId: () => true,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback,
      pendingMessages: [],
      emit: (event, payload) => emitted.push({ event, payload }),
      debug: () => void 0,
      debugLargeJson: () => void 0,
    });

    expect(pendingMessages).toHaveLength(0);
    expect(emitted.some((e: any) => e.event === 'user-message')).toBe(true);
  });

  function buildUserMessageUpdate(content: unknown, seq: number | null = 5): Update {
    return {
      id: 'u-delivered',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 'sess_1',
        message: {
          id: `m-delivered-${String(seq)}`,
          seq,
          content: { t: 'plain', v: content },
          localId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    } as unknown as Update;
  }

  function runWithDeliveredHook(update: Update, overrides: Partial<Parameters<typeof handleSessionNewMessageUpdate>[0]> = {}) {
    const delivered: number[] = [];
    handleSessionNewMessageUpdate({
      update,
      sessionId: 'sess_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      receivedMessageIds: new Set<string>(),
      lastObservedMessageSeq: 0,
      lastObservedUserMessageSeq: 0,
      hasSelfEchoSuppressedLocalId: () => false,
      hasAgentQueueEchoSuppressedLocalId: () => false,
      markAgentQueueEchoSuppressedLocalId: () => void 0,
      hasPendingQueueMaterializedLocalId: () => false,
      deleteMaterializedLocalId: () => void 0,
      pendingMessageCallback: () => void 0,
      pendingMessages: [],
      onUserMessageDeliveredToAgentQueue: (seq) => delivered.push(seq),
      emit: () => void 0,
      debug: () => void 0,
      debugLargeJson: () => void 0,
      ...overrides,
    });
    return delivered;
  }

  describe('onUserMessageDeliveredToAgentQueue (owed-delivery watermark, A-F2/D15b)', () => {
    it('reports the seq when a structured user message is delivered to the agent queue', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, 7),
      );
      expect(delivered).toEqual([7]);
    });

    it('reports the seq when a coerced legacy user prompt is delivered to the agent queue', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: 'hello legacy' }, 9),
      );
      expect(delivered).toEqual([9]);
    });

    it('does not report when delivery to the agent queue is suppressed', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, 7),
        { shouldDeliverUserMessageToAgentQueue: () => false },
      );
      expect(delivered).toEqual([]);
    });

    it('does not report when the message has no usable seq', () => {
      const delivered = runWithDeliveredHook(
        buildUserMessageUpdate({ role: 'user', content: { type: 'text', text: 'hi' } }, null),
      );
      expect(delivered).toEqual([]);
    });

    it('reports the seq for an agent-queue echo of a locally delivered prompt (daemon initial prompt / RPC send)', () => {
      const update = {
        id: 'u-echo',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-echo-1',
            seq: 11,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' }, localId: 'local-1' } },
            localId: 'local-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
      const delivered = runWithDeliveredHook(update, {
        hasAgentQueueEchoSuppressedLocalId: () => true,
      });
      expect(delivered).toEqual([11]);
    });

    it('does not report for a self-echo CLI transcript write (never handed to the agent loop)', () => {
      const update = {
        id: 'u-cli-echo',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 'sess_1',
          message: {
            id: 'm-cli-1',
            seq: 12,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' }, localId: 'cli-1', meta: { source: 'cli' } } },
            localId: 'cli-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      } as unknown as Update;
      const delivered = runWithDeliveredHook(update, {
        hasSelfEchoSuppressedLocalId: () => true,
      });
      expect(delivered).toEqual([]);
    });
  });
});
