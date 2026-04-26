import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#ffffff',
                surfaceHigh: '#f8f8f8',
                surfaceHighest: '#eeeeee',
                textSecondary: '#6c6c70',
                accent: {
                    blue: '#007aff',
                    green: '#34c759',
                    orange: '#ff9500',
                    yellow: '#ffcc00',
                    red: '#ff3b30',
                    indigo: '#5856d6',
                    purple: '#af52de',
                },
            },
        },
    });
});

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('LinearGradient', props, props.children),
}));

vi.mock('@shopify/react-native-skia', () => {
    throw new Error('AvatarMeshGradient must not import Skia on web');
});

describe('AvatarMeshGradient', () => {
    it('renders without relying on Skia or CanvasKit', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const screen = await renderScreen(<AvatarMeshGradient id="session-1" size={48} />);

        expect(screen.findAllByTestId('avatar-generated-meshGradient').length).toBeGreaterThan(0);
    });

    it('renders distinct web mesh backgrounds for distinct session identities', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const first = await renderScreen(<AvatarMeshGradient id="session-1" size={48} />);
        const second = await renderScreen(<AvatarMeshGradient id="session-2" size={48} />);

        const firstRoot = first.findAllByTestId('avatar-generated-meshGradient')[0];
        const secondRoot = second.findAllByTestId('avatar-generated-meshGradient')[0];

        expect(firstRoot.props.style.backgroundImage).toBeTypeOf('string');
        expect(secondRoot.props.style.backgroundImage).toBeTypeOf('string');
        expect(secondRoot.props.style.backgroundImage).not.toBe(firstRoot.props.style.backgroundImage);
    });
});
