import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData, ACPProvider } from '../sessionMessageTypes';
import { createStreamedTranscriptWriter } from './createStreamedTranscriptWriter';
import type { StreamedTranscriptWriterSession } from './types';

async function settleCommittedSnapshot(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createStreamedTranscriptWriter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats locally persisted queued commits as durable even when delivery is deferred', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const enqueueAgentMessageCommitted = vi.fn(
      async (
        _provider: ACPProvider,
        _body: ACPMessageData,
        _opts: { localId: string; meta?: Record<string, unknown> },
      ) => ({ persisted: true as const, delivered: false }),
    );
    const session: StreamedTranscriptWriterSession = { enqueueAgentMessageCommitted };

    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('Queued durable snapshot');
    const summary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'Queued durable snapshot' },
      expect.objectContaining({ localId: 'segment-1' }),
    );
    expect(summary.assistantRoot.didDurablyFlush).toBe(true);
    expect(summary.segments[0]).toMatchObject({
      didDurablyFlush: true,
      lastCommittedState: 'complete',
    });
  });
});
