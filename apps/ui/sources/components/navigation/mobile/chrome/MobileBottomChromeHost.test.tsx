import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { motionTokens } from '@/components/ui/motion/motionTokens';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathState = vi.hoisted(() => ({
    pathname: '/',
}));
const searchParamsState = vi.hoisted(() => ({
    mobileSurface: undefined as string | string[] | undefined,
    serverId: undefined as string | string[] | undefined,
}));
const authState = vi.hoisted(() => ({
    isAuthenticated: true,
}));
const tabState = vi.hoisted(() => ({
    setActiveTab: vi.fn(async () => {}),
}));
const settingsState = vi.hoisted(() => ({
    mobileWorkspaceExperienceV1: undefined as 'classic' | 'cockpit' | undefined,
    sessionLastMobileSurfaceBySessionId: null as Record<string, string> | null,
    embeddedTerminalDockLocation: 'sidebar' as string | null,
}));
const storageListeners = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const deviceTypeState = vi.hoisted(() => ({
    value: 'phone' as 'phone' | 'tablet' | 'desktop',
}));
const featureState = vi.hoisted(() => ({
    terminalEmbeddedPtyEnabled: true,
}));
const storageMutators = vi.hoisted(() => ({
    setSessionLastMobileSurfaceBySessionId: vi.fn(),
}));
const routerState = vi.hoisted(() => ({
    replace: vi.fn(),
}));

const expoRouterMock = createExpoRouterMock({
    pathname: () => pathState.pathname,
    params: () => ({
        mobileSurface: searchParamsState.mobileSurface,
        serverId: searchParamsState.serverId,
    }),
    router: {
        replace: (value: unknown) => routerState.replace(value),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Animated: {
            Value: class {
                _value: number;
                constructor(value: number) {
                    this._value = value;
                }
                setValue(value: number) {
                    this._value = value;
                }
                interpolate(config: Record<string, unknown>) {
                    return { __type: 'interpolate', value: this._value, config };
                }
            },
            timing: vi.fn(() => ({
                start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
            })),
            View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
        },
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => tabState,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'terminal.embeddedPty') {
            return featureState.terminalEmbeddedPtyEnabled;
        }
        return false;
    },
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/components/ui/navigation/TabBar', () => ({
    TabBar: (props: Record<string, unknown>) => React.createElement('TabBar', props),
}));

vi.mock('./bars/SessionCockpitTabBar', () => ({
    SessionCockpitTabBar: (props: Record<string, unknown>) => React.createElement('SessionCockpitTabBar', props),
}));

const storageMock = createStorageModuleStub({
    useLocalSetting: (key: string) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => readSettingValue(key),
        () => readSettingValue(key),
    ),
    useLocalSettingMutable: (key: string) => {
        if (key === 'sessionLastMobileSurfaceBySessionId') {
            return [
                settingsState.sessionLastMobileSurfaceBySessionId,
                (value: Record<string, string> | null) => {
                    settingsState.sessionLastMobileSurfaceBySessionId = value;
                    storageMutators.setSessionLastMobileSurfaceBySessionId(value);
                    notifyStorageListeners();
                },
            ];
        }
        return [null, vi.fn()];
    },
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

function readSettingValue(key: string): unknown {
    if (key === 'mobileWorkspaceExperienceV1') {
        return settingsState.mobileWorkspaceExperienceV1;
    }
    if (key === 'sessionLastMobileSurfaceBySessionId') {
        return settingsState.sessionLastMobileSurfaceBySessionId;
    }
    if (key === 'embeddedTerminalDockLocation') {
        return settingsState.embeddedTerminalDockLocation;
    }
    return null;
}

function notifyStorageListeners(): void {
    for (const listener of storageListeners.listeners) {
        listener();
    }
}

describe('MobileBottomChromeHost', () => {
    afterEach(() => {
        routerState.replace.mockReset();
        tabState.setActiveTab.mockReset();
        storageMutators.setSessionLastMobileSurfaceBySessionId.mockReset();
        storageListeners.listeners.clear();
        pathState.pathname = '/';
        searchParamsState.mobileSurface = undefined;
        searchParamsState.serverId = undefined;
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = undefined;
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
    });

    it('does not duplicate the root phone tab bar owned by MainView', async () => {
        pathState.pathname = '/';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
    });

    it('renders the main app tab bar on authenticated routed main surfaces', async () => {
        pathState.pathname = '/settings';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        expect(bar.props.activeTab).toBe('settings');
    });

    it('routes main app tab presses before tab persistence settles', async () => {
        pathState.pathname = '/settings';
        let resolvePersistence: () => void = () => {};
        const persistence = new Promise<void>((resolve) => {
            resolvePersistence = resolve;
        });
        tabState.setActiveTab.mockReturnValueOnce(persistence);

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void bar.props.onTabPress('sessions');
        });

        try {
            expect(tabState.setActiveTab).toHaveBeenCalledWith('sessions');
            expect(routerState.replace).toHaveBeenCalledWith('/');
        } finally {
            resolvePersistence();
            await act(async () => {
                await Promise.resolve();
            });
        }
    });

    it('does not render chrome on desktop', async () => {
        pathState.pathname = '/';
        deviceTypeState.value = 'desktop';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('renders the session cockpit bar by default on phone session routes', async () => {
        pathState.pathname = '/session/session-1/files';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.activeSurface).toBe('browse');
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('hides session cockpit chrome when classic mode is explicitly selected', async () => {
        pathState.pathname = '/session/session-1/files';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('persists selected session cockpit surface and preserves server scope before navigating', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.serverId = 'server-a';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('git');
        });

        expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
            'session-1': 'git',
        });
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-a');
    });

    it('hides session cockpit chrome after switching to classic', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/files';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);

            await act(async () => {
                settingsState.mobileWorkspaceExperienceV1 = 'classic';
                notifyStorageListeners();
            });
            await act(async () => {
                vi.advanceTimersByTime(motionTokens.durationMs.fast);
            });

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
