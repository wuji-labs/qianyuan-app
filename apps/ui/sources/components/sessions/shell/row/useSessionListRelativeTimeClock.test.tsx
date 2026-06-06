import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import {
    useSessionListRelativeTimeClock,
    useSessionListRuntimeFreshnessClock,
} from './useSessionListRelativeTimeClock';

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

describe('session list row clocks', () => {
    it('does not tick the relative-time clock while the session-list surface is inactive', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        const hook = await renderHook(
            ({ enabled }: { enabled: boolean }) => useSessionListRelativeTimeClock(enabled),
            { initialProps: { enabled: false } },
        );

        expect(hook.getCurrent()).toBe(1_000);

        vi.setSystemTime(61_000);
        await flushHookEffects({ advanceTimersMs: 60_000, cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(1_000);

        await hook.rerender({ enabled: true });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(121_000);

        await hook.unmount();
    });

    it('does not schedule runtime-freshness wakeups while the session-list surface is inactive', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        const hook = await renderHook(
            ({ enabled, nextAtMs }: { enabled: boolean; nextAtMs: number | null }) =>
                useSessionListRuntimeFreshnessClock(nextAtMs, enabled),
            { initialProps: { enabled: false, nextAtMs: 1_500 } },
        );

        expect(hook.getCurrent()).toBe(1_000);

        vi.setSystemTime(1_500);
        await flushHookEffects({ advanceTimersMs: 500, cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(1_000);

        await hook.rerender({ enabled: true, nextAtMs: 2_000 });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(2_000);

        vi.setSystemTime(2_000);
        await flushHookEffects({ advanceTimersMs: 500, cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toBe(2_000);

        await hook.unmount();
    });
});
