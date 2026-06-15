import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useInboxHasContent } from '@/hooks/inbox/useInboxHasContent';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { Text } from '@/components/ui/text/Text';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useFriendRequests, useSetting } from '@/sync/domains/state/storage';
import type { TabType } from './tabTypes';
import { resolveTabBarTabs } from './resolveTabBarTabs';


export type { TabType };

interface TabBarProps {
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
}

const styles = StyleSheet.create((theme) => ({
    innerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tab: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 50,
        flexShrink: 1,
    },
    tabContent: {
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    activePill: {
        position: 'absolute',
        top: -5,
        bottom: -5,
        left: -12,
        right: -12,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.ripple,
    },
    label: {
        fontSize: 10,
        marginTop: 3,
        ...Typography.default(),
    },
    labelActive: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.text.secondary,
    },
}));

export const TabBar = React.memo(({ activeTab, onTabPress }: TabBarProps) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const friendsEnabled = useFriendsEnabled();
    const friendRequests = useFriendRequests();
    const inboxEnabled = useInboxAvailable();
    const inboxHasContent = useInboxHasContent();
    const friendsBadgeEnabled = useSetting('tabBarFriendsBadgeEnabled');
    const inboxBadgeEnabled = useSetting('tabBarInboxBadgeEnabled');
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));

    const tabs: { key: TabType; icon: any; label: string }[] = React.useMemo(() => {
        const tabKeys = resolveTabBarTabs({ inboxEnabled, friendsEnabled });
        return tabKeys.map((key) => {
            switch (key) {
                case 'inbox':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 27.png'), label: t('tabs.inbox') };
                case 'friends':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 28.png'), label: t('tabs.friends') };
                case 'settings':
                    return { key, icon: require('@/assets/images/brutalist/Brutalism 9.png'), label: t('tabs.settings') };
                case 'sessions':
                default:
                    return { key: 'sessions', icon: require('@/assets/images/brutalist/Brutalism 15.png'), label: t('tabs.sessions') };
            }
        });
    }, [friendsEnabled, inboxEnabled]);

    return (
        <FloatingTabBarSurface bottomInset={insets.bottom}>
            <View style={[styles.innerContainer, { gap: metrics.rowGap }]}>
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.key;

                    return (
                        <Pressable
                            key={tab.key}
                            testID={`tabbar-tab-${tab.key}`}
                            style={[styles.tab, { paddingVertical: metrics.tabPaddingVertical, paddingHorizontal: metrics.tabPaddingHorizontal }]}
                            onPress={() => onTabPress(tab.key)}
                            hitSlop={8}
                        >
                            <View style={styles.tabContent}>
                                {isActive && !metrics.showLabels ? <View pointerEvents="none" style={styles.activePill} /> : null}
                                <Image
                                    source={tab.icon}
                                    contentFit="contain"
                                    style={[{ width: metrics.iconSize, height: metrics.iconSize }]}
                                    tintColor={isActive ? theme.colors.text.primary : theme.colors.text.secondary}
                                />
                                {tab.key === 'friends' && friendsBadgeEnabled && friendRequests.length > 0 && (
                                    <TabBadge variant="count" value={friendRequests.length} />
                                )}
                                {tab.key === 'inbox' && inboxBadgeEnabled && inboxHasContent && (
                                    <TabBadge variant="dot" />
                                )}
                            </View>
                            {metrics.showLabels ? (
                                <Text style={[
                                    styles.label,
                                    isActive ? styles.labelActive : styles.labelInactive
                                ]}>
                                    {tab.label}
                                </Text>
                            ) : null}
                        </Pressable>
                    );
                })}
            </View>
        </FloatingTabBarSurface>
    );
});
