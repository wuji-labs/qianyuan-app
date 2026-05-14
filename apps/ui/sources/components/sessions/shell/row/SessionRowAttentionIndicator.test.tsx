import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    useAnimatedStyle: () => ({ opacity: 1 }),
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
}));

describe('SessionRowAttentionIndicator', () => {
    it('uses a static dot for compact working indicators on web instead of an animated ActivityIndicator', async () => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');

        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="session-a"
                attentionState="working"
                workingMode="spinner"
            />,
        );

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        expect(screen.findByTestId('session-row-attention-indicator-dot-session-a')).toBeTruthy();
    });
});
