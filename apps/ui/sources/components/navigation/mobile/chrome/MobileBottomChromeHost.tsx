import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { router as expoRouter, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { SessionCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/SessionCockpitTabBar';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    resolveSessionCockpitRouteFromPathname,
    resolveSessionRoutePathForSurface,
    type SessionMobileSurface,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { TabBar, type TabType } from '@/components/ui/navigation/TabBar';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useTabState } from '@/hooks/ui/useTabState';
import { useLocalSetting, useLocalSettingMutable, useSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

type TabRouteHref = Parameters<typeof expoRouter.replace>[0];

const TAB_ROUTES = {
    inbox: '/inbox',
    sessions: '/',
    friends: '/friends',
    settings: '/settings',
} satisfies Record<TabType, TabRouteHref>;

export function resolveMobileBottomChromeActiveTab(pathname: string): TabType | null {
    if (pathname === '/') return 'sessions';
    if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
    if (pathname === '/inbox' || pathname.startsWith('/inbox/')) return 'inbox';
    if (pathname === '/friends' || pathname.startsWith('/friends/')) return 'friends';
    return null;
}

function normalizeRouteParam(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    if (Array.isArray(value)) {
        return normalizeRouteParam(value[0]);
    }
    return null;
}

type BottomChromeItem = Readonly<{
    key: string;
    signature: string;
    node: React.ReactElement;
}>;

const BOTTOM_CHROME_TRANSITION_TRANSLATE_Y = 10;

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost() {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<{ mobileSurface?: string | string[]; serverId?: string | string[] }>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const keyboardHeightPx = useKeyboardHeight();
    const reduceMotion = useReducedMotionPreference();
    const { setActiveTab } = useTabState();
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const sessionLastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const [, setSessionLastMobileSurfaceBySessionId] = useLocalSettingMutable('sessionLastMobileSurfaceBySessionId');
    const cockpitRegistration = useSessionCockpitChromeRegistration();
    const activeTab = auth.isAuthenticated === true && typeof pathname === 'string'
        ? resolveMobileBottomChromeActiveTab(pathname)
        : null;
    const softwareKeyboardVisible = deviceType === 'phone' && keyboardHeightPx > 0;
    const sessionRouteMatch = React.useMemo(() => {
        const match = /^\/session\/([^/?#]+?)(?:\/|$)/.exec(typeof pathname === 'string' ? pathname : '');
        return match?.[1] ? decodeURIComponent(match[1]) : null;
    }, [pathname]);
    const serverId = normalizeRouteParam(params.serverId);
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const terminalAvailability = useSessionTerminalAvailability({
        sessionId: sessionRouteMatch ?? undefined,
        serverId,
    });
    const cockpitRoute = React.useMemo(() => {
        if (!sessionRouteMatch) return null;
        return resolveSessionCockpitRouteFromPathname(
            pathname,
            sessionLastMobileSurfaceBySessionId?.[sessionRouteMatch] ?? null,
            terminalAvailability.sidebarTabAvailable,
            explicitMobileSurfaceHint,
        );
    }, [
        explicitMobileSurfaceHint,
        pathname,
        sessionLastMobileSurfaceBySessionId,
        sessionRouteMatch,
        terminalAvailability.sidebarTabAvailable,
    ]);

    const handleTabPress = React.useCallback((tab: TabType) => {
        const targetRoute = TAB_ROUTES[tab];
        if (activeTab === tab) {
            return;
        }

        router.replace(targetRoute);
        if (tab !== 'settings') {
            fireAndForget(setActiveTab(tab));
        }
    }, [activeTab, router, setActiveTab]);

    const persistSessionSurface = React.useCallback((sessionId: string, surface: SessionMobileSurface) => {
        setSessionLastMobileSurfaceBySessionId({
            ...(sessionLastMobileSurfaceBySessionId ?? {}),
            [sessionId]: surface,
        });
    }, [sessionLastMobileSurfaceBySessionId, setSessionLastMobileSurfaceBySessionId]);

    const handleCockpitSurfacePress = React.useCallback((surface: SessionMobileSurface) => {
        if (!cockpitRoute) return;

        const matchingRegistration =
            cockpitRegistration?.sessionId === cockpitRoute.sessionId
                ? cockpitRegistration
                : null;
        if (matchingRegistration) {
            matchingRegistration.switchSurface(surface);
            return;
        }

        persistSessionSurface(cockpitRoute.sessionId, surface);
        router.replace(resolveSessionRoutePathForSurface(cockpitRoute.sessionId, surface, { serverId }));
    }, [cockpitRegistration, cockpitRoute, persistSessionSurface, router, serverId]);

    const resolvedChrome = React.useMemo((): BottomChromeItem | null => {
        if (softwareKeyboardVisible || deviceType !== 'phone') {
            return null;
        }

        if (activeTab) {
            return {
                key: 'mainAppTabs',
                signature: `mainAppTabs:${activeTab}`,
                node: <TabBar activeTab={activeTab} onTabPress={handleTabPress} />,
            };
        }

        if (
            cockpitRoute
            && isMobileWorkspaceCockpitEnabled({ deviceType, mobileWorkspaceExperience })
        ) {
            const matchingRegistration =
                cockpitRegistration?.sessionId === cockpitRoute.sessionId
                    ? cockpitRegistration
                    : null;
            const activeSurface = matchingRegistration?.activeSurface ?? cockpitRoute.surface;
            const terminalTabAvailable = matchingRegistration?.terminalTabAvailable ?? terminalAvailability.sidebarTabAvailable;

            return {
                key: `sessionCockpitTabs:${cockpitRoute.sessionId}`,
                signature: `sessionCockpitTabs:${cockpitRoute.sessionId}:${activeSurface}:${terminalTabAvailable ? 'terminal' : 'no-terminal'}`,
                node: (
                    <SessionCockpitTabBar
                        sessionId={cockpitRoute.sessionId}
                        activeSurface={activeSurface}
                        terminalTabAvailable={terminalTabAvailable}
                        onSurfacePress={handleCockpitSurfacePress}
                    />
                ),
            };
        }

        return null;
    }, [
        activeTab,
        cockpitRegistration,
        cockpitRoute,
        deviceType,
        handleCockpitSurfacePress,
        handleTabPress,
        mobileWorkspaceExperience,
        softwareKeyboardVisible,
        terminalAvailability.sidebarTabAvailable,
    ]);

    const [renderedChrome, setRenderedChrome] = React.useState<Readonly<{
        current: BottomChromeItem | null;
        previous: BottomChromeItem | null;
    }>>({
        current: resolvedChrome,
        previous: null,
    });
    const renderedChromeRef = React.useRef(renderedChrome);
    const progress = React.useRef(new Animated.Value(1)).current;
    const activeAnimationRef = React.useRef<Animated.CompositeAnimation | null>(null);

    const setRenderedChromeState = React.useCallback((nextChrome: typeof renderedChrome) => {
        renderedChromeRef.current = nextChrome;
        setRenderedChrome(nextChrome);
    }, []);

    const stopChromeAnimation = React.useCallback(() => {
        activeAnimationRef.current?.stop();
        activeAnimationRef.current = null;
        (progress as Animated.Value & { stopAnimation?: () => void }).stopAnimation?.();
    }, [progress]);

    React.useLayoutEffect(() => {
        const currentRenderedChrome = renderedChromeRef.current.current;

        if (!resolvedChrome) {
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: null, previous: null });
            return;
        }

        if (!currentRenderedChrome) {
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        if (currentRenderedChrome.key === resolvedChrome.key) {
            if (currentRenderedChrome.signature === resolvedChrome.signature) {
                return;
            }
            stopChromeAnimation();
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        stopChromeAnimation();
        setRenderedChromeState({
            current: resolvedChrome,
            previous: currentRenderedChrome,
        });

        if (reduceMotion) {
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
            return;
        }

        progress.setValue(0);
        const animation = Animated.timing(progress, {
            toValue: 1,
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.emphasized,
            useNativeDriver: Platform.OS !== 'web',
        });
        activeAnimationRef.current = animation;
        animation.start(({ finished }) => {
            if (activeAnimationRef.current !== animation) {
                return;
            }
            activeAnimationRef.current = null;
            if (!finished) {
                return;
            }
            progress.setValue(1);
            setRenderedChromeState({ current: resolvedChrome, previous: null });
        });
    }, [progress, reduceMotion, resolvedChrome, setRenderedChromeState, stopChromeAnimation]);

    React.useLayoutEffect(() => () => {
        stopChromeAnimation();
    }, [stopChromeAnimation]);

    if (!renderedChrome.current) {
        return null;
    }

    const currentStyle = {
        opacity: progress,
        transform: [
            {
                translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [BOTTOM_CHROME_TRANSITION_TRANSLATE_Y, 0],
                }),
            },
        ],
    } as const;
    const previousStyle = {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        opacity: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
        }),
        transform: [
            {
                translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, BOTTOM_CHROME_TRANSITION_TRANSLATE_Y],
                }),
            },
        ],
    } as const;

    return (
        <View style={{ position: 'relative' }}>
            <Animated.View style={currentStyle}>
                {renderedChrome.current.node}
            </Animated.View>
            {renderedChrome.previous ? (
                <Animated.View pointerEvents="none" style={previousStyle}>
                    {renderedChrome.previous.node}
                </Animated.View>
            ) : null}
        </View>
    );
});
