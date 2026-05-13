import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { groupSessionWorkStateItems } from './sessionWorkStatePresentation';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from './sessionWorkStateTypes';

function WorkStateGroup(props: Readonly<{
    title: string;
    items: readonly SessionWorkStateItem[];
    primaryItemId?: string | null;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    if (props.items.length === 0) return null;
    return (
        <View testID={props.testID} style={styles.group}>
            <Text style={[styles.groupTitle, { color: theme.colors.text.secondary }]}>{props.title}</Text>
            {props.items.map((item) => {
                const selected = item.id === props.primaryItemId;
                return (
                    <View
                        key={item.id}
                        testID={`session-work-state-item-${item.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
                        accessibilityState={{ selected }}
                        style={[
                            styles.row,
                            {
                                borderColor: selected ? theme.colors.accent.blue : theme.colors.border.default,
                                backgroundColor: selected ? theme.colors.surface.selected : undefined,
                            },
                        ]}
                    >
                        <Text numberOfLines={2} style={[styles.itemTitle, { color: theme.colors.text.primary }]}>
                            {item.title}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
}

export function SessionTaskListContent(props: Readonly<{
    snapshot: SessionWorkStateSnapshot | null;
    primaryItemId?: string | null;
}>) {
    const groups = groupSessionWorkStateItems(props.snapshot);
    return (
        <View style={styles.root}>
            <WorkStateGroup title={t('session.workState.group.active')} items={groups.active} primaryItemId={props.primaryItemId} testID="session-work-state-group-active" />
            <WorkStateGroup title={t('session.workState.group.pending')} items={groups.pending} primaryItemId={props.primaryItemId} testID="session-work-state-group-pending" />
            <WorkStateGroup title={t('session.workState.group.blockedPaused')} items={groups.blockedPaused} primaryItemId={props.primaryItemId} testID="session-work-state-group-blocked-paused" />
            <WorkStateGroup title={t('session.workState.group.done')} items={groups.done} primaryItemId={props.primaryItemId} testID="session-work-state-group-done" />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 10,
    },
    group: {
        gap: 6,
    },
    groupTitle: {
        fontSize: 11,
        fontWeight: '700',
    },
    row: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 3,
    },
    itemTitle: {
        fontSize: 13,
        fontWeight: '600',
    },
}));
