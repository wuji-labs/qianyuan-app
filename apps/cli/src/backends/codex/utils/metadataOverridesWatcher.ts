import { delayUnref } from '@/utils/time';

export async function runMetadataOverridesWatcherLoop(args: Readonly<{
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal | undefined;
  waitForMetadataUpdate: (signal?: AbortSignal) => Promise<boolean>;
  onUpdate: () => void | Promise<void>;
  abortedBackoffMs?: number;
}>): Promise<void> {
  const abortedBackoffMs =
    typeof args.abortedBackoffMs === 'number' && Number.isFinite(args.abortedBackoffMs) && args.abortedBackoffMs > 0
      ? Math.floor(args.abortedBackoffMs)
      : 25;

  while (!args.shouldExit()) {
    const signal = args.getAbortSignal();
    let didUpdate = false;
    try {
      didUpdate = await args.waitForMetadataUpdate(signal);
    } catch {
      await delayUnref(abortedBackoffMs);
      continue;
    }
    if (!didUpdate) {
      // Avoid a hot loop when waitForMetadataUpdate resolves immediately for an already-aborted signal.
      if (signal?.aborted) {
        await delayUnref(abortedBackoffMs);
      }
      continue;
    }
    try {
      await args.onUpdate();
    } catch {
      await delayUnref(abortedBackoffMs);
    }
  }
}
