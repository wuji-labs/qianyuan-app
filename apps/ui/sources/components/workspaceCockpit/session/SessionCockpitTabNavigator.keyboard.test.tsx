import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const navigatorState = vi.hoisted(() => ({
    screenOptions: null as null | Record<string, unknown>,
    navigationContainerLinking: null as null | Record<string, unknown>,
}));

vi.mock('@react-navigation/native', () => ({
    NavigationContainer: ({ children, linking }: { children?: React.ReactNode; linking?: Record<string, unknown> }) => {
        navigatorState.navigationContainerLinking = linking ?? null;
        return React.createElement('NavigationContainer', { linking }, children);
    },
    NavigationIndependentTree: ({ children }: { children?: React.ReactNode }) =>
        React.createElement('NavigationIndependentTree', null, children),
}));

vi.mock('@react-navigation/bottom-tabs', () => ({
    createBottomTabNavigator: () => ({
        Navigator: ({ children, screenOptions }: { children?: React.ReactNode; screenOptions?: Record<string, unknown> }) => {
            navigatorState.screenOptions = screenOptions ?? null;
            return React.createElement('BottomTabNavigator', { screenOptions }, children);
        },
        Screen: ({ children, name }: { children?: (props: { navigation: { navigate: () => void } }) => React.ReactNode; name: string }) =>
            React.createElement('BottomTabScreen', { name }, typeof children === 'function'
                ? children({ navigation: { navigate: () => {} } })
                : children),
    }),
}));

vi.mock('./SessionCockpitSurfaceScreen', () => ({
    SessionCockpitSurfaceScreen: (props: Record<string, unknown>) =>
        React.createElement('SessionCockpitSurfaceScreen', props),
}));

vi.mock('./SessionCockpitSurfaceNavigation', () => ({
    SessionCockpitSurfaceNavigationProvider: ({ children }: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, children),
}));

vi.mock('./SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegister: () => () => () => {},
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => null,
    useLocalSettingMutable: () => [null, () => {}],
}));

describe('SessionCockpitTabNavigator keyboard behavior', () => {
    it('does not ask the native tab navigator to hide tab chrome during keyboard transitions', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        expect(navigatorState.screenOptions?.tabBarHideOnKeyboard).toBe(false);
        expect(navigatorState.navigationContainerLinking).toEqual({ enabled: false, prefixes: [] });
    });
});
