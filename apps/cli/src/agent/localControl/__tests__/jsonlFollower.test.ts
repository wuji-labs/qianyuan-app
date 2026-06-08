import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlFollower } from '../jsonlFollower';
import { DEFAULT_JSONL_FOLLOW_POLICY, resolveJsonlFollowPollDelayMs } from '../jsonlFollowPolicy';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 10;
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await delay(intervalMs);
    }
  }
}

describe('JsonlFollower', () => {
  it('starts only one fallback timeout when started concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-start-once-'));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(filePath, '');

    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      startAtEnd: true,
      onJson: () => {},
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await Promise.all([follower.start(), follower.start()]);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not emit ENOENT errors while waiting for file creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-missing-'));
    const filePath = join(root, 'rollout.jsonl');

    const received: unknown[] = [];
    const errors: Array<NodeJS.ErrnoException | unknown> = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
      onError: (error: unknown) => errors.push(error),
    });
    await follower.start();

    try {
      await writeFile(filePath, '{"created":true}\n');
      await waitFor(() => {
        expect(received).toEqual([{ created: true }]);
      });
      expect(errors).toEqual([]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('buffers partial last line until newline is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '');

    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
    });
    await follower.start();

    try {
      await appendFile(filePath, '{"a":1}');
      await delay(30);
      expect(received).toEqual([]);

      await appendFile(filePath, '\n');
      await waitFor(() => {
        expect(received).toEqual([{ a: 1 }]);
      });
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can start at end and only emit newly appended lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-end-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '{"old":1}\n');

    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      startAtEnd: true,
      onJson: (value: unknown) => {
        received.push(value);
      },
    });
    await follower.start();

    try {
      await delay(30);
      expect(received).toEqual([]);

      await appendFile(filePath, '{"new":2}\n');
      await waitFor(() => {
        expect(received).toEqual([{ new: 2 }]);
      });
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can start from an explicit byte offset and catch later appended lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-offset-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '{"old":1}\n');
    const startOffsetBytes = (await stat(filePath)).size;
    await appendFile(filePath, '{"new":2}\n');

    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      startOffsetBytes,
      onJson: (value: unknown) => {
        received.push(value);
      },
    });
    await follower.start();

    try {
      await waitFor(() => {
        expect(received).toEqual([{ new: 2 }]);
      });

      await appendFile(filePath, '{"later":3}\n');
      await follower.drainNow();
      expect(received).toEqual([{ new: 2 }, { later: 3 }]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves multi-byte UTF-8 characters that are split across reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-utf8-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '');

    const received: unknown[] = [];
    const errors: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
      onError: (error: unknown) => errors.push(error),
    });
    await follower.start();

    try {
      const prefix = Buffer.from('{"t":"', 'utf8');
      const emoji = Buffer.from('💩', 'utf8');
      const suffix = Buffer.from('"}\n', 'utf8');

      await appendFile(filePath, prefix);
      await appendFile(filePath, emoji.subarray(0, 2));
      await delay(30);

      await appendFile(filePath, emoji.subarray(2));
      await appendFile(filePath, suffix);

      await waitFor(() => {
        expect(received).toEqual([{ t: '💩' }]);
      }, { timeoutMs: 500 });
      expect(errors).toEqual([]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('queues a follow-up drain when drainNow is requested during an active drain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-queued-drain-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '{"a":1}\n');

    const releaseFirstJsonRef: { current?: () => void } = {};
    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: async (value: unknown) => {
        received.push(value);
        if ((value as { a?: number }).a === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstJsonRef.current = resolve;
          });
        }
      },
    });

    try {
      const firstDrain = follower.drainNow();
      await waitFor(() => {
        expect(received).toEqual([{ a: 1 }]);
        expect(releaseFirstJsonRef.current).toBeTypeOf('function');
      });

      await appendFile(filePath, '{"b":2}\n');
      const queuedDrain = follower.drainNow();
      await delay(20);
      expect(received).toEqual([{ a: 1 }]);

      const releaseFirstJson = releaseFirstJsonRef.current;
      if (!releaseFirstJson) throw new Error('Expected first JSON release callback to be registered');
      releaseFirstJson();
      await Promise.all([firstDrain, queuedDrain]);

      expect(received).toEqual([{ a: 1 }, { b: 2 }]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resets offset when the file is replaced with a same-size inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-replaced-'));
    const filePath = join(root, 'rollout.jsonl');
    const replacementPath = join(root, 'replacement.jsonl');

    await writeFile(filePath, '{"a":1}\n');

    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
    });

    try {
      await follower.drainNow();
      expect(received).toEqual([{ a: 1 }]);

      await writeFile(replacementPath, '{"b":2}\n');
      await rename(replacementPath, filePath);
      await follower.drainNow();

      expect(received).toEqual([{ a: 1 }, { b: 2 }]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses named adaptive fallback policy instead of a steady fixed interval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-policy-'));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(filePath, '');

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      pollPolicy: {
        activeBurstPollIntervalMs: 11,
        activeBurstDurationMs: 0,
        activeFallbackPollIntervalMs: 37,
        idleFallbackPollIntervalMs: 83,
        missingFileRetryIntervalMs: 19,
      },
      onJson: () => {},
    });

    try {
      await follower.start();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 37);
    } finally {
      await follower.stop().catch(() => {});
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes the complete JsonlFollowPolicyV1 defaults', () => {
    expect(DEFAULT_JSONL_FOLLOW_POLICY).toEqual({
      activeBurstPollIntervalMs: 250,
      activeBurstDurationMs: 5_000,
      activeFallbackPollIntervalMs: 1_000,
      idleFallbackPollIntervalMs: 5_000,
      missingFileRetryIntervalMs: 1_000,
      sidechainCompletionGraceMs: 2_000,
      maxActiveFollowersPerSession: 64,
      maxIdleFollowersPerSession: 128,
      maxClosedFollowerRecordsPerSession: 256,
      maxBufferedSidechainRows: 1_000,
      maxBufferedSidechainBytes: 1_048_576,
      maxDrainRowsPerTick: 1_000,
      maxDrainBytesPerTick: 262_144,
    });
  });

  it('resolves active fallback before idle fallback after quiet drains', () => {
    const policy = {
      ...DEFAULT_JSONL_FOLLOW_POLICY,
      activeBurstDurationMs: 0,
      activeFallbackPollIntervalMs: 37,
      idleFallbackPollIntervalMs: 83,
    };

    expect(resolveJsonlFollowPollDelayMs(policy, {
      mode: 'active',
      elapsedActiveMs: 1,
      idlePolls: 1,
      lastDrainHadActivity: false,
      lastDrainHadError: false,
      fileMissing: false,
    })).toBe(37);

    expect(resolveJsonlFollowPollDelayMs(policy, {
      mode: 'active',
      elapsedActiveMs: 1,
      idlePolls: 2,
      lastDrainHadActivity: false,
      lastDrainHadError: false,
      fileMissing: false,
    })).toBe(83);
  });
});
