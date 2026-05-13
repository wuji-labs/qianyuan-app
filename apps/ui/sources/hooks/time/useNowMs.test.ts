import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

import { useNowMs } from './useNowMs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNowMs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Pin the wall clock so initial value is deterministic.
        vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns the current Date.now() on mount', async () => {
        const expected = Date.now();
        const hook = await renderHook(() => useNowMs());
        expect(hook.getCurrent()).toBe(expected);
    });

    it('ticks at the configured interval (default 60_000ms)', async () => {
        const hook = await renderHook(() => useNowMs());
        const initial = hook.getCurrent();

        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(hook.getCurrent()).toBe(initial + 60_000);

        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(hook.getCurrent()).toBe(initial + 120_000);
    });

    it('respects a custom intervalMs argument', async () => {
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        // No tick yet — interval has not elapsed.
        expect(hook.getCurrent()).toBe(initial);

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(hook.getCurrent()).toBe(initial + 1_000);
    });

    it('rebinds the interval when intervalMs changes (cleans up the previous timer)', async () => {
        const hook = await renderHook(({ interval }: { interval: number }) => useNowMs(interval), {
            initialProps: { interval: 60_000 },
        });
        const initial = hook.getCurrent();

        await hook.rerender({ interval: 1_000 });

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(hook.getCurrent()).toBe(initial + 1_000);
    });

    it('cleans up the interval on unmount (no further ticks fire)', async () => {
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        await hook.unmount();

        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });

        // After unmount the captured value never advances because the interval was cleared.
        expect(hook.getCurrent()).toBe(initial);
    });
});
