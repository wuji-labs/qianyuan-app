import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionFolderHeaderItem } from './sessionFolderShellTypes';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 4,
        backgroundColor: theme.colors.background.canvas,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    crumbRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    crumbText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    separator: {
        color: theme.colors.text.tertiary,
    },
    clearButton: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        backgroundColor: theme.colors.surface.base,
    },
}));

export function SessionFolderScopeBreadcrumb(props: Readonly<{
    breadcrumbs: readonly SessionFolderHeaderItem[];
    onClear: () => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    if (props.breadcrumbs.length === 0) return null;

    return (
        <View style={styles.container} testID="session-folder-breadcrumb">
            <View style={styles.crumbRow}>
                <Text style={styles.crumbText} numberOfLines={1}>
                    {t('sessionsList.folders')}
                </Text>
                {props.breadcrumbs.map((folder) => (
                    <React.Fragment key={folder.folderId}>
                        <Text style={[styles.crumbText, styles.separator]}>/</Text>
                        <Text style={styles.crumbText} numberOfLines={1}>{folder.title}</Text>
                    </React.Fragment>
                ))}
            </View>
            <Pressable
                testID="session-folder-clear-focus"
                style={styles.clearButton}
                accessibilityRole="button"
                accessibilityLabel={t('sessionsList.clearFolderFocus')}
                onPress={props.onClear}
                hitSlop={8}
            >
                <Ionicons name="close" size={14} color={theme.colors.text.secondary} />
            </Pressable>
        </View>
    );
}
