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
    return (
        <View style={styles.root}>
            <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                {t('session.workState.goal.title')}
            </Text>
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
            <View style={styles.actions}>
                <Pressable testID="session-goal-save-button" onPress={props.onSave} disabled={props.busy}>
                    <Text style={[styles.actionText, { color: theme.colors.text.primary }]}>
                        {props.goal ? t('common.save') : t('session.workState.goal.set')}
                    </Text>
                </Pressable>
                {props.goal ? (
                    <>
                        <Pressable testID="session-goal-pause-resume-button" onPress={isPaused ? props.onResume : props.onPause} disabled={props.busy}>
                            <Text style={[styles.actionText, { color: theme.colors.text.secondary }]}>
                                {isPaused ? t('session.workState.goal.resume') : t('session.workState.goal.pause')}
                            </Text>
                        </Pressable>
                        <Pressable testID="session-goal-clear-button" onPress={props.onClear} disabled={props.busy}>
                            <Text style={[styles.actionText, { color: theme.colors.state.danger.foreground }]}>
                                {t('session.workState.goal.clear')}
                            </Text>
                        </Pressable>
                    </>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 10,
        minWidth: 280,
    },
    title: {
        fontSize: 13,
        fontWeight: '700',
    },
    input: {
        minHeight: 84,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 7,
        paddingHorizontal: 10,
        paddingVertical: 8,
        textAlignVertical: 'top',
        fontSize: 13,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    actionText: {
        fontSize: 12,
        fontWeight: '700',
    },
}));
