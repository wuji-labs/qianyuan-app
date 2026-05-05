import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { SidebarCollapseIcon } from './SidebarIcons';
import { SidebarLogoButton } from './SidebarLogoButton';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type CollapsedSidebarViewProps = Readonly<{
    focusModeActive?: boolean;
    onExitFocusMode?: () => void;
    onRequestExpand?: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.divider,
        paddingTop: 16,
        paddingHorizontal: 8,
        gap: 12,
    },
    button: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
        borderRadius: 8,
    },
    logoButton: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
    },
}));

export const CollapsedSidebarView = React.memo((props: CollapsedSidebarViewProps) => {
    const { focusModeActive = false, onExitFocusMode, onRequestExpand } = props;
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const router = useRouter();
    const { theme } = useUnistyles();

    const handleExpand = React.useCallback(() => {
        if (onRequestExpand) {
            onRequestExpand();
            return;
        }
        setSidebarCollapsed(false);
    }, [onRequestExpand, setSidebarCollapsed]);

    const handleHome = React.useCallback(() => {
        if (focusModeActive) {
            onExitFocusMode?.();
        }
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) {
            fireAndForget(result, { tag: 'CollapsedSidebarView.nav.home' });
        }
    }, [focusModeActive, onExitFocusMode, router]);

    return (
        <View style={styles.container}>
            <SidebarLogoButton
                testID="collapsed-sidebar-home-button"
                onPress={handleHome}
                style={styles.logoButton}
            />
            {Platform.OS === 'web' ? (
                <Pressable
                    testID="sidebar-expand-button"
                    onPress={handleExpand}
                    style={styles.button}
                    accessibilityRole="button"
                >
                    <SidebarCollapseIcon color={theme.colors.header.tint} />
                </Pressable>
            ) : null}
        </View>
    );
});
