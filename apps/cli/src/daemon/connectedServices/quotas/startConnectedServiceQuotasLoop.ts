export type ConnectedServiceQuotasLoopHandle = Readonly<{
  stop: () => void;
  pause: () => void;
  resume: () => void;
}>;

export function startConnectedServiceQuotasLoop(params: Readonly<{
  enabled: boolean;
  tickMs: number;
  tickJitterMs?: number;
  random?: () => number;
  coordinator: Readonly<{ tickOnce: () => Promise<void> }>;
  onTickError: (error: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}>): ConnectedServiceQuotasLoopHandle | null {
  if (!params.enabled) return null;

  const tickMs = Math.max(1, Math.trunc(params.tickMs));
  const tickJitterMs =
    typeof params.tickJitterMs === 'number' && Number.isFinite(params.tickJitterMs)
      ? Math.max(0, Math.trunc(params.tickJitterMs))
      : 0;
  const random = params.random ?? Math.random;
  const computeDelayMs = (): number => {
    if (tickJitterMs <= 0) return tickMs;
    const raw = random();
    const normalized = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    return tickMs + Math.trunc(normalized * tickJitterMs);
  };
  const setIntervalImpl = params.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    params.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));
  const setTimeoutImpl = params.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl =
    params.clearTimeoutFn ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

  let stopped = false;
  let inFlight = false;
  let paused = false;
  if (tickJitterMs > 0 || params.setTimeoutFn || params.clearTimeoutFn) {
    let timeoutHandle: unknown = null;
    const scheduleNext = (): void => {
      if (stopped) return;
      timeoutHandle = setTimeoutImpl(runTick, computeDelayMs());
      (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
    };
    const finishTick = (): void => {
      inFlight = false;
      scheduleNext();
    };
    const runTick = (): void => {
      timeoutHandle = null;
      if (stopped) return;
      if (inFlight || paused) {
        scheduleNext();
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          await params.coordinator.tickOnce();
        } catch (error) {
          params.onTickError(error);
        } finally {
          finishTick();
        }
      })();
    };
    scheduleNext();

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (timeoutHandle !== null) {
          clearTimeoutImpl(timeoutHandle);
          timeoutHandle = null;
        }
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
    };
  }

  const intervalHandle = setIntervalImpl(() => {
    if (stopped || inFlight) return;
    if (paused) return;
    inFlight = true;
    void (async () => {
      try {
        await params.coordinator.tickOnce();
      } catch (error) {
        params.onTickError(error);
      } finally {
        inFlight = false;
      }
    })();
  }, tickMs);
  (intervalHandle as unknown as { unref?: () => void })?.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(intervalHandle);
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
}
