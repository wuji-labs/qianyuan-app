import * as React from 'react';

/**
 * Returns the current time as a millisecond timestamp, ticking at the configured interval.
 *
 * Use for relative-time displays (e.g. "5m ago") that should update without depending on
 * unrelated state changes. The hook owns its own setInterval so consumers can use it as a
 * stable, reactive `nowMs` source instead of capturing `Date.now()` once per render.
 *
 * Default interval: 60_000 ms (one minute) — matches RelativeTimeText's display granularity.
 */
export function useNowMs(intervalMs: number = 60_000): number {
    const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
    React.useEffect(() => {
        const id = setInterval(() => {
            setNowMs(Date.now());
        }, intervalMs);
        return () => {
            clearInterval(id);
        };
    }, [intervalMs]);
    return nowMs;
}
