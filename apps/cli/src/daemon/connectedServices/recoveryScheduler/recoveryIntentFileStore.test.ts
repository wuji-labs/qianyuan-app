import { mkdtemp, readFile, rename as renameMock, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const renameControl = vi.hoisted(() => ({
  callCount: 0,
  firstBlocked: null as null | (() => void),
  releaseFirst: null as null | (() => void),
  secondStarted: null as null | (() => void),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const actualRename = actual.rename;

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      renameControl.callCount += 1;
      if (renameControl.callCount === 1) {
        renameControl.firstBlocked?.();
        await new Promise<void>((resolve) => {
          renameControl.releaseFirst = resolve;
        });
      }
      if (renameControl.callCount === 2) {
        renameControl.secondStarted?.();
      }
      await actualRename(from, to);
    }),
  };
});

import { createRecoveryIntentFileStore } from './recoveryIntentFileStore';

describe('createRecoveryIntentFileStore', () => {
  it('serializes concurrent writes so older snapshots cannot overwrite newer intents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    const filePath = join(dir, 'runtime-auth.json');
    const store = createRecoveryIntentFileStore(filePath);

    const firstBlocked = new Promise<void>((resolve) => {
      renameControl.firstBlocked = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      renameControl.secondStarted = resolve;
    });

    const first = store.write('session-a', { status: 'waiting', attempt: 1 });
    await firstBlocked;

    const second = store.write('session-b', { status: 'waiting', attempt: 2 });
    await Promise.race([
      secondStarted,
      new Promise((resolve) => setTimeout(resolve, 25)),
    ]);
    renameControl.releaseFirst?.();

    await Promise.all([first, second]);

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      intentsBySessionId: {
        'session-a': { status: 'waiting', attempt: 1 },
        'session-b': { status: 'waiting', attempt: 2 },
      },
    });
    expect(renameMock).toHaveBeenCalledTimes(2);

    await rm(dir, { recursive: true, force: true });
  });

  it('removes cleared recovery intents from the persisted snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    const filePath = join(dir, 'runtime-auth.json');
    const store = createRecoveryIntentFileStore(filePath);

    await store.write('session-a', { status: 'waiting', attempt: 1 });
    await store.write('session-b', { status: 'waiting', attempt: 2 });
    await store.remove?.('session-a');

    expect(store.read('session-a')).toBeNull();
    expect(store.read('session-b')).toEqual({ status: 'waiting', attempt: 2 });

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      intentsBySessionId: {
        'session-b': { status: 'waiting', attempt: 2 },
      },
    });

    await rm(dir, { recursive: true, force: true });
  });

  it('prunes matching recovery intents in one persisted snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    const filePath = join(dir, 'runtime-auth.json');
    const store = createRecoveryIntentFileStore(filePath);

    await store.write('active-session', { status: 'waiting', attempt: 1 });
    await store.write('old-terminal-session', { status: 'cancelled', terminalAtMs: 1_000 });
    await store.write('fresh-terminal-session', { status: 'exhausted', terminalAtMs: 9_500 });

    await expect(store.prune?.(({ value }) => (
      typeof value === 'object'
      && value !== null
      && 'terminalAtMs' in value
      && typeof value.terminalAtMs === 'number'
      && value.terminalAtMs < 5_000
    ))).resolves.toEqual(['old-terminal-session']);

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      intentsBySessionId: {
        'active-session': { status: 'waiting', attempt: 1 },
        'fresh-terminal-session': { status: 'exhausted', terminalAtMs: 9_500 },
      },
    });

    await rm(dir, { recursive: true, force: true });
  });
});
