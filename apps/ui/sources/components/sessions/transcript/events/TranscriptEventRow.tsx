import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { AgentEvent } from '@/sync/typesRaw';
import { t } from '@/text';

const EVENT_ICON_SIZE = 18;
const EVENT_SPINNER_SIZE = 20;
const EVENT_ICON_CONTAINER_SIZE = 20;

function formatLimitReachedTime(timestamp: number): string {
    try {
        const date = new Date(timestamp * 1000);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return t('message.unknownTime');
    }
}

export const TranscriptEventRow = React.memo(function TranscriptEventRow(props: {
    event: AgentEvent;
}) {
    const { theme } = useUnistyles();
    let iconName: React.ComponentProps<typeof Ionicons>['name'] = 'information-circle-outline';
    let text = t('message.unknownEvent');
    let isLoading = false;
    let testID: string | undefined;

    if (props.event.type === 'switch') {
        iconName = 'swap-horizontal-outline';
        text = t('message.switchedToMode', { mode: props.event.mode });
    } else if (props.event.type === 'message') {
        iconName = 'information-circle-outline';
        text = props.event.message;
    } else if (props.event.type === 'context-compaction') {
        testID = `transcript-event-context-compaction-${props.event.phase}`;
        if (props.event.phase === 'started' || props.event.phase === 'progress') {
            isLoading = true;
            text = t('message.contextCompactionStarted');
        } else if (props.event.phase === 'failed') {
            iconName = 'warning-outline';
            text = t('message.contextCompactionFailed');
        } else if (props.event.phase === 'cancelled') {
            iconName = 'close-circle-outline';
            text = t('message.contextCompactionCancelled');
        } else {
            iconName = 'checkmark-circle-outline';
            text = t('message.contextCompactionCompleted');
        }
    } else if (props.event.type === 'limit-reached') {
        iconName = 'warning-outline';
        text = t('message.usageLimitUntil', { time: formatLimitReachedTime(props.event.endsAt) });
    }

    return (
        <View style={styles.container} testID={testID}>
            <View style={styles.row}>
                <View style={styles.iconContainer}>
                    {isLoading ? (
                        <ActivityIndicator size={EVENT_SPINNER_SIZE} color={theme.colors.textSecondary} />
                    ) : (
                        <Ionicons name={iconName} size={EVENT_ICON_SIZE} color={theme.colors.textSecondary} />
                    )}
                </View>
                <Text selectable style={styles.text}>
                    {text}
                </Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 16,
        paddingBottom: 22,
        alignSelf: 'stretch',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    iconContainer: {
        width: EVENT_ICON_CONTAINER_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    text: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
        flexShrink: 1,
    },
}));
