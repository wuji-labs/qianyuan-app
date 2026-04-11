import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: '100%',
        maxWidth: 420,
        alignSelf: 'center',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 24,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    iconContainer: {
        width: 52,
        height: 52,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    title: {
        textAlign: 'center',
        fontSize: 19,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        textAlign: 'center',
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    actionButton: {
        width: 240,
        marginTop: 4,
    },
}));

export type SessionEmptyStateCardProps = Readonly<{
    title: string;
    subtitle: string;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    actionLabel?: string;
    onPressAction?: () => void;
    testID?: string;
}>;

export function SessionEmptyStateCard(props: SessionEmptyStateCardProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View testID={props.testID ?? 'session-empty-state-card'} style={styles.card}>
            <View testID="session-empty-state-icon" style={styles.iconContainer}>
                <Ionicons name={props.iconName} size={24} color={theme.colors.text} />
            </View>
            <Text style={styles.title}>{props.title}</Text>
            <Text style={styles.subtitle}>{props.subtitle}</Text>
            {props.actionLabel && props.onPressAction ? (
                <View style={styles.actionButton}>
                    <RoundButton
                        testID="session-empty-state-action"
                        title={props.actionLabel}
                        onPress={props.onPressAction}
                        size="normal"
                    />
                </View>
            ) : null}
        </View>
    );
}
