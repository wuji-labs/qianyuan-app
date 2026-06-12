import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

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

let supervisorPhase = 'online';

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
    getState: () => ({ phase: supervisorPhase }),
  }),
}));

const catchUpMock = vi.fn(async (_opts?: unknown) => {});

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: (opts: unknown) => catchUpMock(opts),
}));

const fetchSnapshotMock = vi.fn();
const materializeNextMock = vi.fn();

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: (...args: unknown[]) => fetchSnapshotMock(...args),
  };
});

async function createClient(sessionOverrides: Record<string, unknown>) {
  vi.resetModules();
  sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  const { ApiSessionClient } = await import('./sessionClient');
  const client = new ApiSessionClient('tok', {
    ...createPlainSessionFixture({ id: 's1' }),
    ...sessionOverrides,
  } as any);
  return client;
}

describe('ApiSessionClient pending-queue turn-end drain', () => {
  beforeEach(() => {
    catchUpMock.mockReset();
    catchUpMock.mockResolvedValue(undefined);
    fetchSnapshotMock.mockReset();
    fetchSnapshotMock.mockResolvedValue({});
    materializeNextMock.mockReset();
    materializeNextMock.mockRejectedValue(new Error('not stubbed'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks pending materialization while the snapshot reports an in-progress turn', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('canonical turn completion clears a stale in-progress snapshot status and unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('canonical turn cancellation also unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.cancelTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('wakes pending consumers on turn completion (metadata-updated)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    let woke = 0;
    client.on('metadata-updated', () => {
      woke += 1;
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(woke).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a stale-empty pending count on turn completion (lost-nudge recovery)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    fetchSnapshotMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSnapshotMock).toHaveBeenCalled();
  });

  it('replays owed user transcript rows at turn end (missed-broadcast recovery)', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 0 }));
  });

  it('still materializes while the session socket supervisor is reconnecting (HTTP fallback transport)', async () => {
    supervisorPhase = 'connecting';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      materializeNextMock.mockResolvedValue({ didMaterialize: false });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result.type).not.toBe('deferred');
      expect(materializeNextMock).toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('defers materialization while the supervisor is auth_failed', async () => {
    supervisorPhase = 'auth_failed';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result).toEqual({ type: 'deferred', reason: 'supervisor_auth_failed' });
      expect(materializeNextMock).not.toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('self-heals a stale in-progress snapshot status with no canonical active turn during materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    // No canonical turn ever began locally (e.g. respawned runner); the server has
    // since completed the turn, so a refresh must clear the stale block and let the
    // materialize attempt reach the server within the same wake.
    fetchSnapshotMock.mockResolvedValue({ latestTurnStatus: 'completed' });
    materializeNextMock.mockResolvedValue({ didMaterialize: false });

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await client.materializeNextPendingMessageSafely();
    expect(fetchSnapshotMock).toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalled();
  });
});
