import * as React from 'react';
import { Animated, Platform } from 'react-native';
import { router as expoRouter, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useTabState } from '@/hooks/ui/useTabState';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { TabBar, type TabType } from '@/components/ui/navigation/TabBar';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SessionCockpitTabBar } from './bars/SessionCockpitTabBar';
import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

type TabRouteHref = Parameters<typeof expoRouter.replace>[0];

const TAB_ROUTES = {
    inbox: '/inbox',
    sessions: '/',
    friends: '/friends',
    settings: '/settings',
} satisfies Record<TabType, TabRouteHref>;

export function resolveMobileBottomChromeActiveTab(pathname: string): TabType | null {
    if (pathname === '/') return null;
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

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost() {
    const pathname = usePathname();
    const router = useRouter();
    const params = useGlobalSearchParams<{ mobileSurface?: string | string[]; serverId?: string | string[] }>();
    const auth = useAuth();
    const deviceType = useDeviceType();
    const reduceMotion = useReducedMotionPreference();
    const { setActiveTab } = useTabState();
    const mobileWorkspaceExperience = useLocalSetting('mobileWorkspaceExperienceV1');
    const sessionLastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const [, setSessionLastMobileSurfaceBySessionId] = useLocalSettingMutable('sessionLastMobileSurfaceBySessionId');
    const terminalEmbeddedPtyEnabled = useFeatureEnabled('terminal.embeddedPty');
    const dockLocationRaw = useLocalSetting('embeddedTerminalDockLocation');
    const dockLocation = deviceType === 'phone' ? 'sidebar' : dockLocationRaw;
    const sessionTerminalTabAvailable = terminalEmbeddedPtyEnabled && dockLocation === 'sidebar';
    const explicitMobileSurfaceHint = normalizeRouteParam(params.mobileSurface);
    const serverId = normalizeRouteParam(params.serverId);

    const model = resolveMobileBottomChromeModel({
        isAuthenticated: auth.isAuthenticated,
        pathname,
        mobileWorkspaceExperience,
        sessionLastMobileSurfaceBySessionId,
        sessionTerminalTabAvailable,
        explicitMobileSurfaceHint,
    });

    const handleTabPress = React.useCallback((tab: TabType) => {
        router.replace(TAB_ROUTES[tab]);
        if (tab !== 'settings') {
            fireAndForget(setActiveTab(tab));
        }
    }, [router, setActiveTab]);

    const resolvedChrome = React.useMemo((): Readonly<{
        key: string;
        signature: string;
        node: React.ReactElement;
    }> | null => {
        if (model.kind === 'mainAppTabs') {
            if (deviceType !== 'phone') {
                return null;
            }
            return {
                key: 'mainAppTabs',
                signature: `mainAppTabs:${model.activeTab}`,
                node: <TabBar activeTab={model.activeTab} onTabPress={handleTabPress} />,
            };
        }

        if (
            model.kind === 'sessionCockpit'
            && isMobileWorkspaceCockpitEnabled({
                deviceType,
                mobileWorkspaceExperience,
            })
        ) {
            return {
                key: `session:${model.sessionId}`,
                signature: `session:${model.sessionId}:${model.surface}:${model.terminalTabAvailable ? 'terminal' : 'no-terminal'}:${serverId ?? ''}`,
                node: (
                    <SessionCockpitTabBar
                        sessionId={model.sessionId}
                        activeSurface={model.surface}
                        terminalTabAvailable={model.terminalTabAvailable}
                        onSurfacePress={(surface) => {
                            setSessionLastMobileSurfaceBySessionId({
                                ...(sessionLastMobileSurfaceBySessionId ?? {}),
                                [model.sessionId]: surface,
                            });
                            router.replace(resolveSessionRoutePathForSurface(model.sessionId, surface, { serverId }));
                        }}
                    />
                ),
            };
        }

        return null;
    }, [
        deviceType,
        handleTabPress,
        mobileWorkspaceExperience,
        model,
        router,
        serverId,
        sessionLastMobileSurfaceBySessionId,
        setSessionLastMobileSurfaceBySessionId,
    ]);
    const [renderedChrome, setRenderedChrome] = React.useState(resolvedChrome);
    const progress = React.useRef(new Animated.Value(resolvedChrome ? 1 : 0)).current;
    const transitionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        if (transitionTimeoutRef.current) {
            clearTimeout(transitionTimeoutRef.current);
            transitionTimeoutRef.current = null;
        }

        if (reduceMotion) {
            setRenderedChrome(resolvedChrome);
            progress.setValue(resolvedChrome ? 1 : 0);
            return;
        }

        if ((renderedChrome?.key ?? null) === (resolvedChrome?.key ?? null)) {
            if ((renderedChrome?.signature ?? null) !== (resolvedChrome?.signature ?? null)) {
                setRenderedChrome(resolvedChrome);
            }
            return;
        }

        const animateIn = (nextChrome: typeof resolvedChrome) => {
            setRenderedChrome(nextChrome);
            if (!nextChrome) {
                progress.setValue(0);
                return;
            }
            progress.setValue(0);
            Animated.timing(progress, {
                toValue: 1,
                duration: motionTokens.durationMs.base,
                easing: motionTokens.easing.emphasized,
                useNativeDriver: Platform.OS !== 'web',
            }).start();
        };

        if (!renderedChrome) {
            animateIn(resolvedChrome);
            return;
        }

        Animated.timing(progress, {
            toValue: 0,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        }).start();

        transitionTimeoutRef.current = setTimeout(() => {
            transitionTimeoutRef.current = null;
            animateIn(resolvedChrome);
        }, motionTokens.durationMs.fast);

        return () => {
            if (transitionTimeoutRef.current) {
                clearTimeout(transitionTimeoutRef.current);
                transitionTimeoutRef.current = null;
            }
        };
    }, [progress, reduceMotion, renderedChrome, resolvedChrome]);

    const chromeToRender =
        (renderedChrome?.key ?? null) === (resolvedChrome?.key ?? null)
            ? (resolvedChrome ?? renderedChrome)
            : renderedChrome;

    if (!chromeToRender) {
        return null;
    }

    const animatedStyle = {
        opacity: progress,
        transform: [
            {
                translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [10, 0],
                }),
            },
            {
                scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.99, 1],
                }),
            },
        ],
    } as const;

    return (
        <Animated.View style={animatedStyle}>
            {chromeToRender.node}
        </Animated.View>
    );
});
