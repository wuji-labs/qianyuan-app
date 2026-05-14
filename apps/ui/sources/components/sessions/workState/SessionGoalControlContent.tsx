import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { SessionWorkStateItem } from './sessionWorkStateTypes';

export function SessionGoalControlContent(props: Readonly<{
    goal: SessionWorkStateItem | null;
    draftObjective: string;
    onDraftObjectiveChange: (value: string) => void;
    onSave: () => void;
    onPause: () => void;
    onResume: () => void;
    onClear: () => void;
    busy?: boolean;
}>) {
    const { theme } = useUnistyles();
    const isPaused = props.goal?.status === 'paused';
    const [editing, setEditing] = React.useState(!props.goal);

    React.useEffect(() => {
        setEditing(!props.goal);
    }, [props.goal?.id]);

    const statusText = isPaused ? t('session.workState.badge.goalPaused') : t('session.workState.group.active');
    const canSave = props.draftObjective.trim().length > 0 && !props.busy;

    return (
        <View style={styles.root}>
            <View style={styles.header}>
                <View style={styles.heading}>
                    <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                        {t('session.workState.goal.title')}
                    </Text>
                    {props.goal ? (
                        <View style={[
                            styles.statusPill,
                            { backgroundColor: theme.colors.surface.selected },
                        ]}>
                            <Text style={[styles.statusText, { color: theme.colors.text.secondary }]}>
                                {statusText}
                            </Text>
                        </View>
                    ) : null}
                </View>
                {props.goal && !editing ? (
                    <Pressable
                        testID="session-goal-edit-button"
                        accessibilityRole="button"
                        onPress={() => setEditing(true)}
                        disabled={props.busy}
                        style={styles.compactButton}
                    >
                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                            {t('common.edit')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
            {editing ? (
                <TextInput
                    testID="session-goal-objective-input"
                    value={props.draftObjective}
                    onChangeText={props.onDraftObjectiveChange}
                    multiline
                    placeholder={t('session.workState.goal.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[
                        styles.input,
                        {
                            color: theme.colors.text.primary,
                            borderColor: theme.colors.border.default,
                            backgroundColor: theme.colors.surface.inset,
                        },
                    ]}
                />
            ) : props.goal ? (
                <View style={[
                    styles.goalReadout,
                    { backgroundColor: theme.colors.surface.inset },
                ]}>
                    <Text style={[styles.goalReadoutText, { color: theme.colors.text.primary }]} numberOfLines={4}>
                        {props.goal.title}
                    </Text>
                </View>
            ) : null}
            <View style={styles.actions}>
                {editing ? (
                    <Pressable
                        testID="session-goal-save-button"
                        accessibilityRole="button"
                        onPress={props.onSave}
                        disabled={!canSave}
                        style={({ pressed }) => [
                            styles.primaryButton,
                            {
                                backgroundColor: theme.colors.button.primary.background,
                                opacity: !canSave ? 0.42 : (pressed ? 0.88 : 1),
                            },
                        ]}
                    >
                        <Text style={[styles.actionText, { color: theme.colors.button.primary.tint }]}>
                            {props.goal ? t('common.save') : t('session.workState.goal.set')}
                        </Text>
                    </Pressable>
                ) : null}
                {props.goal ? (
                    <View style={styles.secondaryActions}>
                        <Pressable
                            testID="session-goal-pause-resume-button"
                            accessibilityRole="button"
                            onPress={isPaused ? props.onResume : props.onPause}
                            disabled={props.busy}
                            style={styles.secondaryButton}
                        >
                            <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                {isPaused ? t('session.workState.goal.resume') : t('session.workState.goal.pause')}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID="session-goal-clear-button"
                            accessibilityRole="button"
                            onPress={props.onClear}
                            disabled={props.busy}
                            style={styles.secondaryButton}
                        >
                            <Text style={[styles.secondaryActionText, { color: theme.colors.state.danger.foreground }]}>
                                {t('session.workState.goal.clear')}
                            </Text>
                        </Pressable>
                    </View>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 12,
        minWidth: 280,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    title: {
        fontSize: 14,
        fontWeight: '700',
    },
    statusPill: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '700',
    },
    compactButton: {
        minHeight: 34,
        paddingHorizontal: 4,
        justifyContent: 'center',
    },
    goalReadout: {
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 9,
    },
    goalReadoutText: {
        fontSize: 14,
        fontWeight: '600',
    },
    input: {
        height: 104,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        textAlignVertical: 'top',
        fontSize: 14,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        minHeight: 36,
    },
    primaryButton: {
        minHeight: 36,
        minWidth: 92,
        borderRadius: 9,
        paddingHorizontal: 14,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryActions: {
        marginLeft: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    secondaryButton: {
        minHeight: 34,
        justifyContent: 'center',
    },
    actionText: {
        fontSize: 12,
        fontWeight: '700',
    },
    secondaryActionText: {
        fontSize: 12,
        fontWeight: '700',
    },
}));
