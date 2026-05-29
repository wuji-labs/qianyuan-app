import { describe, expect, it, vi } from 'vitest';

import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';

describe('publishOrphanedStartupSessionEnds', () => {
  it('prefers durable session-end mutation publishing when available', () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };

    publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'sess-orphaned-6480',
          pid: 6480,
        },
      ],
      now: () => 123456789,
    });

    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalledWith({
      sid: 'sess-orphaned-6480',
      time: 123456789,
      exit: {
        observedBy: 'daemon',
        pid: 6480,
        reason: 'process-missing',
        code: null,
        signal: null,
      },
    });
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
  });

  it('preserves the durable publisher method receiver', () => {
    const apiMachine = {
      receivedSessionIds: [] as string[],
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation(payload: { sid: string }) {
        this.receivedSessionIds.push(payload.sid);
      },
    };

    publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'sess-orphaned-bound',
          pid: 7777,
        },
      ],
      now: () => 987654321,
    });

    expect(apiMachine.receivedSessionIds).toEqual(['sess-orphaned-bound']);
  });

  it('reports dead daemon-owned startup markers as process-missing session-end events', () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'sess-orphaned-6480',
          pid: 6480,
        },
      ],
      now: () => 123456789,
    });

    expect(apiMachine.emitSessionEnd).toHaveBeenCalledWith({
      sid: 'sess-orphaned-6480',
      time: 123456789,
      exit: {
        observedBy: 'daemon',
        pid: 6480,
        reason: 'process-missing',
        code: null,
        signal: null,
      },
    });
  });
});
