import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DurableRecoveryStore } from './DurableBackoffRecoveryScheduler';

type RecoveryIntentFileSnapshot = Readonly<{
  v: 1;
  intentsBySessionId: Readonly<Record<string, unknown>>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function normalizeSnapshot(value: unknown): RecoveryIntentFileSnapshot | null {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.intentsBySessionId)) return null;
  return {
    v: 1,
    intentsBySessionId: value.intentsBySessionId,
  };
}

async function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600).catch(() => {});
}

export function createRecoveryIntentFileStore<TIntent>(
  filePath: string,
): DurableRecoveryStore<TIntent> {
  let loaded = false;
  let persistSequence = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  const intentsBySessionId = new Map<string, unknown>();

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      if (!existsSync(filePath)) return;
      const parsed = normalizeSnapshot(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
      if (!parsed) return;
      for (const [sessionId, intent] of Object.entries(parsed.intentsBySessionId)) {
        if (sessionId.trim().length === 0) continue;
        intentsBySessionId.set(sessionId, intent);
      }
    } catch {
      intentsBySessionId.clear();
    }
  };

  const persist = async (): Promise<void> => {
    persistSequence += 1;
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${persistSequence}.tmp`;
    const snapshot: RecoveryIntentFileSnapshot = {
      v: 1,
      intentsBySessionId: Object.fromEntries(intentsBySessionId.entries()),
    };
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(tmpPath, filePath);
      await bestEffortChmod0600(filePath);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  };

  const enqueuePersist = async (): Promise<void> => {
    const run = writeQueue.catch(() => undefined).then(persist);
    writeQueue = run.catch(() => undefined);
    await run;
  };

  return {
    read: (sessionId) => {
      load();
      return intentsBySessionId.get(sessionId) ?? null;
    },
    readAll: () => {
      load();
      return Array.from(intentsBySessionId.entries());
    },
    write: async (sessionId, intent) => {
      load();
      intentsBySessionId.set(sessionId, intent);
      await enqueuePersist();
    },
    remove: async (sessionId) => {
      load();
      intentsBySessionId.delete(sessionId);
      await enqueuePersist();
    },
    prune: async (predicate) => {
      load();
      const prunedSessionIds: string[] = [];
      for (const [sessionId, value] of intentsBySessionId.entries()) {
        if (!predicate({ recoveryKey: sessionId, value })) continue;
        intentsBySessionId.delete(sessionId);
        prunedSessionIds.push(sessionId);
      }
      if (prunedSessionIds.length > 0) {
        await enqueuePersist();
      }
      return prunedSessionIds;
    },
  };
}
