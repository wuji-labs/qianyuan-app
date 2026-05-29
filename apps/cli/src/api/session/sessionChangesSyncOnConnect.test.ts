import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const fetchChanges = vi.fn();
const readLastChangesCursor = vi.fn(async () => 0);
const writeLastChangesCursor = vi.fn(async () => {});

vi.mock('../changes', () => ({ fetchChanges }));
vi.mock('@/persistence', () => ({ readLastChangesCursor, writeLastChangesCursor }));

describe('runSessionChangesSyncOnConnect', () => {
  beforeEach(() => {
    fetchChanges.mockReset();
    readLastChangesCursor.mockReset();
    readLastChangesCursor.mockResolvedValue(0);
    writeLastChangesCursor.mockReset();
  });

  it('applies pending count/version hints from relevant /v2/changes session entries', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const applyPendingQueueState = vi.fn();
    const syncSessionSnapshotFromServer = vi.fn(async () => {});

    fetchChanges.mockResolvedValueOnce({
      status: 'ok',
      response: {
        changes: [
          {
            cursor: 1,
            kind: 'session',
            entityId: 's1',
            changedAt: 100,
            hint: { pendingCount: 4, pendingVersion: 12 },
          },
        ],
        nextCursor: 1,
      },
    });

    await runSessionChangesSyncOnConnect({
      reason: 'connect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      catchUpSessionMessages: async () => {},
      syncSessionSnapshotFromServer,
      applyPendingQueueState,
      onDebug: () => {},
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    expect(applyPendingQueueState).toHaveBeenCalledWith({ known: true, pendingCount: 4, pendingVersion: 12 });
    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
    expect(writeLastChangesCursor).toHaveBeenCalledWith('account-1', 1);
  });

  it('redacts reconnect catch-up diagnostics', async () => {
    const { runSessionChangesSyncOnConnect } = await import('./sessionChangesSyncOnConnect');
    const onDebug = vi.fn();

    fetchChanges.mockResolvedValueOnce({
      status: 'cursor-gone',
      currentCursor: 8,
    });

    await runSessionChangesSyncOnConnect({
      reason: 'reconnect',
      token: 'tok',
      sessionId: 's1',
      lastObservedMessageSeq: 0,
      getAccountId: async () => 'account-1',
      catchUpSessionMessages: async () => {
        throw new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
          method: 'get',
          url: 'https://api.example.test/v1/sessions/s1/messages?token=QUERY_SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
          data: { access_token: 'BODY_SECRET' },
        });
      },
      syncSessionSnapshotFromServer: vi.fn(async () => {}),
      onDebug,
    } satisfies Parameters<typeof runSessionChangesSyncOnConnect>[0]);

    const payload = JSON.stringify(onDebug.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('https://api.example.test/v1/sessions/s1/messages');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });
});
