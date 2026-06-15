import { describe, expect, it, vi } from 'vitest';

import { createPollingDirectSessionFollowLease } from './createPollingDirectSessionFollowLease';

describe('createPollingDirectSessionFollowLease', () => {
  it('emits the cursor used for the transcript read with pushed updates', async () => {
    const readAfterTranscript = vi.fn()
      .mockResolvedValueOnce({
        items: [],
        nextCursor: 'cursor-1',
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'direct-msg-2',
            createdAtMs: 2,
            raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
          },
        ],
        nextCursor: 'cursor-2',
        truncated: false,
      });
    const listener = vi.fn();

    const lease = await createPollingDirectSessionFollowLease({
      readAfterTranscript,
      env: { HAPPIER_DIRECT_SESSIONS_FOLLOW_POLL_MS: '1000' },
    });
    expect(lease.subscribeToTranscriptUpdates).toEqual(expect.any(Function));
    if (!lease.subscribeToTranscriptUpdates) {
      throw new Error('expected transcript subscription support');
    }
    const unsubscribe = lease.subscribeToTranscriptUpdates(listener);

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });

    expect(readAfterTranscript).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cursor: 'tail',
    }));
    expect(readAfterTranscript).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: 'cursor-1',
    }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
    }));

    unsubscribe();
    lease.release();
  });
});
