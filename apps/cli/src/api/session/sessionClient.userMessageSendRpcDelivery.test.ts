import { describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, flushApiSessionClientMessageCommitQueue, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

import { ApiSessionClient } from './sessionClient';

describe('ApiSessionClient session.userMessage.send delivery', () => {
  it('delivers the prompt to the agent queue eagerly and suppresses later transcript echo updates', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    // Simulate the daemon/UI invoking the session-scoped RPC handler, which calls the internal enqueue.
    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.type).toBe('text');
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
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
    });

    expect(received).toHaveLength(1);
  });

  it('does not wait for daemon lifecycle notification before delivering the prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const received: any[] = [];
    const slowLifecycleNotify = vi.fn(() => new Promise<void>(() => {}));

    (client as any).notifyDaemonConnectedServiceTurnLifecycle = slowLifecycleNotify;
    client.onUserMessage((msg) => received.push(msg));

    void (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(slowLifecycleNotify).toHaveBeenCalledWith('prompt_or_steer');
    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });

  it('does not deliver a retried same-localId prompt to the agent queue twice', async () => {
    const committedPayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true, id: 'm1', seq: committedPayloads.length, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(committedPayloads).toHaveLength(2);
    expect(committedPayloads.map((payload) => payload?.localId)).toEqual(['l1', 'l1']);
  });

  it('continues delivering prompts without localId or with distinct localIds', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'first',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'second',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'third',
      localId: 'l3',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    (client as any).enqueueSessionUserMessage({
      text: 'fourth',
      localId: 'l4',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received.map((message) => message?.content?.text)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(new Set(received.map((message) => message?.localId)).size).toBe(4);
  });

  it('defaults session.userMessage.send meta source/sentFrom to ui when missing', async () => {
    let lastMessagePayload: any = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          lastMessagePayload = payload;
        }
        return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { permissionMode: 'yolo' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(lastMessagePayload?.sid).toBe('s1');
    expect(lastMessagePayload?.localId).toBe('l1');
    expect(lastMessagePayload?.message?.t).toBe('plain');
    expect(lastMessagePayload?.message?.v?.meta?.source).toBe('ui');
    expect(lastMessagePayload?.message?.v?.meta?.sentFrom).toBe('ui');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: lastMessagePayload.message,
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });
});
