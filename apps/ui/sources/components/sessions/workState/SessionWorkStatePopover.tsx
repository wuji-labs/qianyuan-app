import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { Modal } from '@/modal';
import { t } from '@/text';

import { SessionGoalControlContent } from './SessionGoalControlContent';
import { resolvePrimarySessionWorkStateItem } from './sessionWorkStatePresentation';
import { SessionTaskListContent } from './SessionTaskListContent';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from './sessionWorkStateTypes';

type OperationResult = { ok: true } | { ok: false; error: string };

function findGoal(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    return snapshot?.items.find((item) => item.kind === 'goal') ?? null;
}

export function SessionWorkStatePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    snapshot: SessionWorkStateSnapshot | null;
    editableGoal: boolean;
    onRequestClose: () => void;
    onSetGoal?: (request: Readonly<{ objective?: string; status?: 'active' | 'paused' | 'complete' }>) => Promise<OperationResult>;
    onClearGoal?: () => Promise<OperationResult>;
}>) {
    const goal = findGoal(props.snapshot);
    const primary = resolvePrimarySessionWorkStateItem(props.snapshot);
    const [draftObjective, setDraftObjective] = React.useState(goal?.title ?? '');
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        if (!props.open) return;
        setDraftObjective(goal?.title ?? '');
    }, [goal?.title, props.open]);

    const dirty = draftObjective.trim() !== (goal?.title ?? '').trim();

    const requestClose = React.useCallback(async () => {
        if (dirty) {
            const discard = await Modal.confirm(
                t('session.workState.dirtyCloseTitle'),
                t('session.workState.dirtyCloseBody'),
                { confirmText: t('common.discard'), destructive: true },
            );
            if (!discard) return;
        }
        props.onRequestClose();
    }, [dirty, props]);

    const runGoalMutation = React.useCallback(async (request: Readonly<{ objective?: string; status?: 'active' | 'paused' | 'complete' }>) => {
        if (!props.onSetGoal) return;
        setBusy(true);
        try {
            const result = await props.onSetGoal(request);
            if (result.ok) props.onRequestClose();
            else Modal.alert(t('common.error'), result.error);
        } finally {
            setBusy(false);
        }
    }, [props]);

    const clearGoal = React.useCallback(async () => {
        if (!props.onClearGoal) return;
        const confirmed = await Modal.confirm(
            t('session.workState.goal.clearTitle'),
            t('session.workState.goal.clearBody'),
            { confirmText: t('session.workState.goal.clear'), destructive: true },
        );
        if (!confirmed) return;
        setBusy(true);
        try {
            const result = await props.onClearGoal();
            if (result.ok) props.onRequestClose();
            else Modal.alert(t('common.error'), result.error);
        } finally {
            setBusy(false);
        }
    }, [props]);

    return (
        <AgentInputContentPopover
            open={props.open}
            anchorRef={props.anchorRef}
            onRequestClose={requestClose}
            maxWidthCap={460}
            maxHeightCap={520}
            testID="session-work-state-popover-surface"
            content={() => (
                <View
                    testID="session-work-state-popover"
                    style={styles.content}
                >
                    {props.editableGoal && (goal || primary?.kind === 'goal' || !primary) ? (
                        <SessionGoalControlContent
                            goal={goal}
                            draftObjective={draftObjective}
                            onDraftObjectiveChange={setDraftObjective}
                            onSave={() => {
                                const objective = draftObjective.trim();
                                if (objective) void runGoalMutation({ objective });
                            }}
                            onPause={() => { void runGoalMutation({ status: 'paused' }); }}
                            onResume={() => { void runGoalMutation({ status: 'active' }); }}
                            onClear={clearGoal}
                            busy={busy}
                        />
                    ) : null}
                    <SessionTaskListContent snapshot={props.snapshot} primaryItemId={primary?.id ?? null} />
                </View>
            )}
        />
    );
}

const styles = StyleSheet.create(() => ({
    content: {
        gap: 14,
        padding: 2,
    },
}));
