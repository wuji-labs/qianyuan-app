import { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const nativeHookState = vi.hoisted(() => ({
    keyboardHandlers: null as null | {
        onEnd?: (event: { height: number; progress: number }) => void;
        onMove?: (event: { height: number; progress: number }) => void;
        onStart?: (event: { height: number; progress: number }) => void;
    },
    keyboardListeners: new Map<string, (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void>(),
    windowHeight: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Keyboard: {
            addListener: (eventName: string, listener: (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void) => {
                nativeHookState.keyboardListeners.set(eventName, listener);
                return {
                    remove: () => {
                        nativeHookState.keyboardListeners.delete(eventName);
                    },
                };
            },
        },
        Platform: {
            OS: 'android',
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) =>
                options.android ?? options.native ?? options.default ?? options.ios ?? options.web,
        },
        useWindowDimensions: () => ({
            width: 390,
            height: nativeHookState.windowHeight,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (handlers: NonNullable<typeof nativeHookState.keyboardHandlers>) => {
        nativeHookState.keyboardHandlers = handlers;
    },
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        runOnJS: (callback: (...args: readonly unknown[]) => void) => callback,
        useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
    };
});

describe('useComposerKeyboardLayout native', () => {
    beforeEach(() => {
        standardCleanup();
        nativeHookState.keyboardHandlers = null;
        nativeHookState.keyboardListeners.clear();
        nativeHookState.windowHeight = 800;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not subtract the measured composer height from available panel height', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(200);
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(680);
    });

    it('caps available panel height to the measured scaffold container', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            availablePanelMaxHeight: 420,
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(420);
    });

    it('uses the measured scaffold height as the viewport for native sheet composers', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 44,
            safeAreaBottom: 34,
        }));
        const layout = hook.getCurrent() as ReturnType<typeof hook.getCurrent> & {
            setScaffoldMeasuredHeight: (height: number) => void;
        };

        expect(layout.setScaffoldMeasuredHeight).toBeTypeOf('function');

        act(() => {
            layout.setScaffoldMeasuredHeight(758);
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(724);

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 335, progress: 1 });
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(423);
    });

    it('updates available panel height when the keyboard settles', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);
    });

    it('normalizes keyboard lift relative to the layout below the scaffold', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(620);

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);
    });

    it('keeps the composer at rest during zero-progress keyboard start frames', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 20,
        }));

        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 300, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(20);
    });

    it('notifies React bridge subscribers when the keyboard settles', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeAvailablePanelHeight?.((height) => {
            heights.push(height);
        });

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        unsubscribe?.();
        expect(heights.at(-1)).toBe(400);
    });

    it('keeps public inset height current during normal keyboard movement', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 240, progress: 0.8 });
        });

        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(240);
        expect(hook.getCurrent().listBottomInset.value).toBe(240);
    });

    it('notifies list bottom inset subscribers during moving keyboard frames', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        const unsubscribe = hook.getCurrent().subscribeListBottomInset?.((height) => {
            heights.push(height);
        });

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 300, progress: 1 });
        });

        unsubscribe?.();
        expect(heights.at(-1)).toBe(360);
    });

    it('publishes measured composer height as the initial list bottom inset before keyboard frames arrive', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeListBottomInset?.((height) => {
            heights.push(height);
        });

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(125);
        });

        unsubscribe?.();
        expect(hook.getCurrent().listBottomInset.value).toBe(125);
        expect(heights.at(-1)).toBe(125);
    });

    it('notifies available panel subscribers during moving keyboard frames', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeAvailablePanelHeight?.((height) => {
            heights.push(height);
        });

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 300, progress: 1 });
        });

        unsubscribe?.();
        expect(heights.at(-1)).toBe(400);
    });

    it('uses Android native keyboard final-frame events when worklet frames do not arrive', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: { height: 300 },
            });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(300);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(300);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(700);
    });

    it('uses Android final-frame screenY when event height under-reports the visible keyboard top', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: {
                    height: 300,
                    screenY: 470,
                },
            });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(330);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(330);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(370);
    });

    it('uses the latest viewport height for Android final-frame screenY after resize', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        nativeHookState.windowHeight = 900;
        await hook.rerender();

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: {
                    height: 300,
                    screenY: 500,
                },
            });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(400);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(400);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);
    });

    it('marks the scaffold-relative keyboard height helper as a worklet', () => {
        const source = readFileSync(new URL('./useComposerKeyboardLayout.native.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/function resolveKeyboardHeightWithinScaffold[^{]*{\s*['"]worklet['"];/);
    });

    it('rests after modal-owned keyboard events when suppression clears', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(
            ({ keyboardLiftSuppressed }: { keyboardLiftSuppressed: boolean }) => useComposerKeyboardLayout({
                headerHeight: 100,
                keyboardLiftSuppressed,
                safeAreaBottom: 20,
            }),
            { initialProps: { keyboardLiftSuppressed: true } },
        );

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(120);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().bottomInset.value).toBe(20);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);

        await hook.rerender({ keyboardLiftSuppressed: false });

        expect(hook.getCurrent().bottomInset.value).toBe(20);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(680);
    });

    it('retains the previous keyboard lift while a composer overlay transfers focus', async () => {
        vi.useFakeTimers();
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        const retention = hook.getCurrent() as unknown as {
            retainKeyboardLift?: () => () => void;
        };
        expect(retention.retainKeyboardLift).toBeTypeOf('function');
        const release = retention.retainKeyboardLift?.();

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);
        vi.useRealTimers();
    });

    it('holds the retained lift across a zero-height keyboard hide without a deferred drop', async () => {
        vi.useFakeTimers();
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        const release = hook.getCurrent().retainKeyboardLift?.();

        // A full keyboard hide while the overlay owns the lift retains the previous lift so
        // focus can transfer without the composer collapsing.
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);

        // There must be NO deferred correction: letting any pending timers run must not drop
        // the lift on its own. The lift is held until the overlay explicitly releases it.
        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);

        // Releasing the overlay then settles the lift in one clean step.
        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
        vi.useRealTimers();
    });

    it('follows decreasing keyboard frames while a composer overlay owns the keyboard lift', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        const release = hook.getCurrent().retainKeyboardLift?.();

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 180, progress: 0.6 });
        });

        // A non-zero decreasing frame must follow the keyboard down, not ratchet to its
        // previous peak. Retention only holds the lift across a full keyboard hide (height 0).
        expect(hook.getCurrent().bottomInset.value).toBe(100);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(100);
        expect(hook.getCurrent().listBottomInset.value).toBe(240);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(100);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(100);
        expect(hook.getCurrent().listBottomInset.value).toBe(240);
    });
});
