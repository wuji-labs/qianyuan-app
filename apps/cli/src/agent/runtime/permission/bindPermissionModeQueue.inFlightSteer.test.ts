import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from './bindPermissionModeQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';

function createSessionHarness() {
  let handler: ((message: any) => void) | null = null;
  let metadataSnapshot: any = null;
  const session = {
    onUserMessage: (fn: (message: any) => void) => {
      handler = fn;
    },
    getMetadataSnapshot: () => metadataSnapshot,
    refreshSessionSnapshotFromServerBestEffort: vi.fn(async () => {}),
    updateMetadata: vi.fn(async (updater: (m: any) => any) => {
      metadataSnapshot = updater(metadataSnapshot ?? {});
    }),
  };
  return {
    session,
    setMetadataSnapshot: (next: any) => {
      metadataSnapshot = next;
    },
    emitUserMessage: (message: any) => {
      if (!handler) throw new Error('onUserMessage handler not registered');
      handler(message);
    },
  };
}

function createQueue() {
  // MessageQueue2 already implements push + pushIsolateAndClear.
  const queue = new MessageQueue2<{ permissionMode: any }, PermissionModeQueuedPrompt>((mode) => mode.permissionMode);
  const spyPush = vi.spyOn(queue, 'push');
  const spyIsolate = vi.spyOn(queue, 'pushIsolateAndClear');
  return { queue, spyPush, spyIsolate };
}

describe('registerPermissionModeMessageQueueBinding (in-flight steer)', () => {
  it('queues messages normally when no steer controller is provided', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
    });

    emitUserMessage({ content: { text: 'hello' }, meta: {} });
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', localId: null }),
      { permissionMode: 'default' },
    );
  });

  it('steers a message during an in-flight turn and does not queue it when steer succeeds', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});
    const isTurnInFlight = vi.fn(() => true);
    const supportsInFlightSteer = vi.fn(() => true);

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight,
        supportsInFlightSteer,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('steer me');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('prefixes replaySeedV1 when steering and consumes it exactly once', async () => {
    const { session, emitUserMessage, setMetadataSnapshot } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    setMetadataSnapshot({
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'sess_parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, localId: 'local-1', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('SEED\n\nsteer me');
    expect(spyPush).not.toHaveBeenCalled();

    const finalMeta = session.getMetadataSnapshot();
    expect(finalMeta?.replaySeedV1?.seedText).toBe('');
    expect(finalMeta?.replaySeedV1?.appliedToLocalId).toBe('local-1');
  });

  it('falls back to queueing when steering fails', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {
      throw new Error('steer failed');
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'queue me', localId: null }),
      { permissionMode: 'default' },
    );
  });

  it('does not leak unhandledRejection when fallback queueing throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const { session, emitUserMessage } = createSessionHarness();
      const { queue, spyPush } = createQueue();

      spyPush.mockImplementation(() => {
        throw new Error('queue push failed');
      });

      const steerText = vi.fn(async () => {
        throw new Error('steer failed');
      });

      registerPermissionModeMessageQueueBinding({
        session,
        queue,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => {},
        inFlightSteer: {
          isTurnInFlight: () => true,
          supportsInFlightSteer: () => true,
          steerText,
        },
      } as any);

      emitUserMessage({ content: { text: 'fallback should not crash' }, meta: {} });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('serializes steering so multiple in-flight messages do not overlap', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let currentInFlight = 0;
    let maxInFlight = 0;
    let resolveFirstGate: () => void = () => {
      throw new Error('firstGate resolver not initialized');
    };
    const firstGate = new Promise<void>((resolve) => {
      resolveFirstGate = () => resolve();
    });

    const steerText = vi.fn(async (text: string) => {
      currentInFlight += 1;
      maxInFlight = Math.max(maxInFlight, currentInFlight);
      try {
        if (text === 'first') {
          await firstGate;
        }
        await Promise.resolve();
      } finally {
        currentInFlight -= 1;
      }
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'first' }, meta: {} });
    emitUserMessage({ content: { text: 'second' }, meta: {} });

    // Allow the async steer tasks to start.
    await Promise.resolve();

    resolveFirstGate();
    await Promise.resolve();
    await Promise.resolve();

    expect(maxInFlight).toBe(1);
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('does not steer when the message changes permission mode (it must be queued)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      {
        text: 'mode change',
        localId: null,
        meta: { permissionMode: 'read-only' },
      },
      { permissionMode: 'read-only' },
    );
  });

  it('does not steer /clear (it must be isolated+clearing)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/clear' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/clear', localId: null }),
      { permissionMode: 'default' },
    );
  });

  it('does not steer /compact (it must be handled by the main loop)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/compact' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/compact', localId: null }),
      { permissionMode: 'default' },
    );
  });
});

describe('registerPermissionModeMessageQueueBinding (in-flight config-delta apply, lane Q)', () => {
  it('applies the permission-mode delta in-flight then steers the text when the controller supports it', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const calls: string[] = [];
    const steerText = vi.fn(async () => {
      calls.push('steerText');
    });
    const applyConfigDeltaInFlight = vi.fn(async (delta: { permissionMode: string }) => {
      calls.push(`applyConfig:${delta.permissionMode}`);
      return { status: 'applied' } as const;
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change steer' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual(['applyConfig:read-only', 'steerText']);
    expect(steerText).toHaveBeenCalledWith('mode change steer');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('steers the text when the config apply reports scheduled_in_turn', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight: vi.fn(async () => ({ status: 'scheduled_in_turn' } as const)),
      },
    } as any);

    emitUserMessage({ content: { text: 'scheduled mode steer' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('scheduled mode steer');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('falls back to the queue (legacy behavior) when the config apply reports unsupported', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    let agentState: any = {};
    (session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight: vi.fn(async () => ({ status: 'unsupported', reason: 'no_window' } as const)),
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'mode change' }),
      { permissionMode: 'read-only' },
    );
    // Not a bounce: the steer was never accepted, so no unsafe_window corrective publish.
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBeUndefined();
  });

  it('falls back to the queue when the config apply throws', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight: vi.fn(async () => {
          throw new Error('apply transport failed');
        }),
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'mode change' }),
      { permissionMode: 'read-only' },
    );
  });

  it('never routes special commands through the config-apply capability', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});
    const applyConfigDeltaInFlight = vi.fn(async () => ({ status: 'applied' } as const));

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    emitUserMessage({ content: { text: '/clear' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(applyConfigDeltaInFlight).not.toHaveBeenCalled();
    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalled();
  });

  it('does not call the capability for messages without a mode change', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});
    const applyConfigDeltaInFlight = vi.fn(async () => ({ status: 'applied' } as const));

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    emitUserMessage({ content: { text: 'plain steer' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(applyConfigDeltaInFlight).not.toHaveBeenCalled();
    expect(steerText).toHaveBeenCalledWith('plain steer');
    expect(spyPush).not.toHaveBeenCalled();
  });
});

describe('registerPermissionModeMessageQueueBinding (steer-bounce corrective publish, lane P)', () => {
  it('publishes unsafe_window to agentState when a steer the runner accepted bounces back to the queue', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    let agentState: any = {};
    (session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };
    const { queue, spyPush } = createQueue();

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {
          throw new Error('steer transport failed');
        }),
      },
    });

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spyPush).toHaveBeenCalled();
    expect(agentState.capabilities?.inFlightSteerAvailable).toBe(false);
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(typeof agentState.capabilities?.inFlightSteerStateAt).toBe('number');
  });
});
