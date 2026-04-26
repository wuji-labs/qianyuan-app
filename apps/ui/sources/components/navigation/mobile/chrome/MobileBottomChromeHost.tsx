import * as React from 'react';
import { View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { useTabState } from '@/hooks/ui/useTabState';
import { TabBar, type TabType } from '@/components/ui/navigation/TabBar';

type MobileBottomChromeHostProps = Readonly<{
    children: React.ReactNode;
}>;

type TabRouteHref = Parameters<typeof router.replace>[0];

const TAB_ROUTES = {
    inbox: '/inbox',
    sessions: '/',
    friends: '/friends',
    settings: '/settings',
} satisfies Record<TabType, TabRouteHref>;

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
    },
    content: {
        flex: 1,
        minHeight: 0,
    },
}));

export function resolveMobileBottomChromeActiveTab(pathname: string): TabType | null {
    if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'settings';
    if (pathname === '/inbox' || pathname.startsWith('/inbox/')) return 'inbox';
    if (pathname === '/friends' || pathname.startsWith('/friends/')) return 'friends';
    return null;
}

export const MobileBottomChromeHost = React.memo(function MobileBottomChromeHost(props: MobileBottomChromeHostProps) {
    const pathname = usePathname();
    const activeTab = resolveMobileBottomChromeActiveTab(pathname);
    const { setActiveTab } = useTabState();

    const handleTabPress = React.useCallback(async (tab: TabType) => {
        if (tab !== 'settings') {
            await setActiveTab(tab);
        }
        router.replace(TAB_ROUTES[tab]);
    }, [setActiveTab]);

    if (!activeTab) {
        return <>{props.children}</>;
    }

    return (
        <View style={styles.container}>
            <View style={styles.content}>
                {props.children}
            </View>
            <TabBar activeTab={activeTab} onTabPress={handleTabPress} />
        </View>
    );
});
