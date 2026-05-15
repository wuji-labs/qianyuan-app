import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { SessionWorkStatePopover } from './SessionWorkStatePopover';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const mock = createModalModuleMock();
    return {
        ...mock.module,
        Modal: {
            ...mock.module.Modal,
            confirm,
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (key === 'session.workState.goal.budgetProgress' && params?.used && params?.budget) {
                return `${params.used} / ${params.budget}`;
            }
            return `${key}:${params?.title ?? ''}`;
        },
    });
});

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props, props.open ? (
        typeof props.children === 'function' ? props.children({ maxHeight: 360 }) : props.children
    ) : null),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
}));

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: Record<string, unknown> & {
        content: () => React.ReactNode;
        onRequestClose: () => void | Promise<void>;
    }) => React.createElement(
        'AgentInputContentPopover',
        { testID: props.testID, onRequestClose: props.onRequestClose },
        props.content(),
    ),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('ScrollView', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join(' ');
    const record = value as { children?: unknown };
    return collectText(record.children);
}

describe('SessionWorkStatePopover', () => {
    it('marks the primary work-state item as selected in the grouped snapshot list', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'opencode',
                    updatedAt: 10,
                    primaryItemId: 'todo:active',
                    items: [
                        { id: 'todo:pending', kind: 'todo', origin: 'vendor', status: 'pending', title: 'Draft implementation', updatedAt: 8 },
                        { id: 'todo:active', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 9 },
                        { id: 'todo:done', kind: 'todo', origin: 'vendor', status: 'complete', title: 'Read plan', updatedAt: 7 },
                    ],
                }}
                editableGoal={false}
                onRequestClose={vi.fn()}
            />);
        });

        const activeRow = tree?.root.findByProps({ testID: 'session-work-state-item-todo-active' });
        const pendingRow = tree?.root.findByProps({ testID: 'session-work-state-item-todo-pending' });
        const doneGroup = tree?.root.findByProps({ testID: 'session-work-state-group-done' });

        expect(activeRow?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
        expect(pendingRow?.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
        expect(doneGroup).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('renders work-state todos with the same checklist semantics as transcript todos', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'opencode',
                    updatedAt: 10,
                    primaryItemId: 'todo:active',
                    items: [
                        { id: 'todo:done', kind: 'todo', origin: 'vendor', status: 'complete', title: 'Read plan', updatedAt: 7 },
                        { id: 'todo:active', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 9 },
                        { id: 'todo:pending', kind: 'todo', origin: 'vendor', status: 'pending', title: 'Draft implementation', updatedAt: 8 },
                    ],
                }}
                editableGoal={false}
                onRequestClose={vi.fn()}
            />);
        });

        const text = collectText(tree?.toJSON());
        expect(text).toContain('☑ Read plan');
        expect(text).toContain('☐ Run focused tests');
        expect(text).toContain('☐ Draft implementation');

        act(() => tree?.unmount());
    });

    it('keeps dirty goal edits when outside close is cancelled', async () => {
        confirm.mockResolvedValueOnce(false);
        const onRequestClose = vi.fn();
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={onRequestClose}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        const editButton = tree?.root.findByProps({ testID: 'session-goal-edit-button' });
        await act(async () => {
            await editButton?.props.onPress();
        });
        const input = tree?.root.findByProps({ testID: 'session-goal-objective-input' });
        const popover = tree?.root.findByProps({ testID: 'session-work-state-popover-surface' });
        act(() => {
            input?.props.onChangeText('Ship better goals');
        });
        await act(async () => {
            await popover?.props.onRequestClose();
        });

        expect(confirm).toHaveBeenCalled();
        expect(onRequestClose).not.toHaveBeenCalled();

        act(() => tree?.unmount());
    });

    it('keeps an existing goal in read mode until the user edits it', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(() => tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        const editButton = tree?.root.findByProps({ testID: 'session-goal-edit-button' });
        await act(async () => {
            await editButton?.props.onPress();
        });
        expect(tree?.root.findByProps({ testID: 'session-goal-objective-input' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-cancel-edit-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-save-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('does not duplicate an editable goal in the grouped work-state list', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10 },
                        { id: 'todo:active', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run focused tests', updatedAt: 9 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(() => tree?.root.findByProps({ testID: 'session-work-state-item-goal-codex' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-work-state-item-todo-active' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('does not expose pause or clear actions before a goal exists', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={null}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-save-button' })).toBeTruthy();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(() => tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toThrow();

        act(() => tree?.unmount());
    });

    it('shows complete goals as complete and hides pause controls', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(collectText(tree?.toJSON())).toContain('session.workState.goal.statusComplete:');
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('shows budget-limited goals precisely and hides pause controls', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        {
                            id: 'goal:codex',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'blocked',
                            statusReason: 'budgetLimited',
                            title: 'Ship goals',
                            updatedAt: 10,
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(collectText(tree?.toJSON())).toContain('session.workState.goal.statusBudgetLimited:');
        expect(() => tree?.root.findByProps({ testID: 'session-goal-pause-resume-button' })).toThrow();
        expect(tree?.root.findByProps({ testID: 'session-goal-clear-button' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-edit-button' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('reactivates complete goals when saving an edit', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Ship goals', updatedAt: 10 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-objective-input' }).props.onChangeText('Ship goals again');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).toHaveBeenCalledWith({
            objective: 'Ship goals again',
            status: 'active',
            resumeInactiveWithInitialGoal: false,
        });

        act(() => tree?.unmount());
    });

    it('validates token budget edits before saving', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10, tokenBudget: 1000, tokensUsed: 250 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        act(() => {
            tree?.root.findByProps({ testID: 'session-goal-budget-input' }).props.onChangeText('0');
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).not.toHaveBeenCalled();
        expect(tree?.root.findByProps({ testID: 'session-goal-budget-error' })).toBeTruthy();

        act(() => tree?.unmount());
    });

    it('renders goal budget progress with the shared token usage ring', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        {
                            id: 'goal:codex',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'active',
                            title: 'Ship goals',
                            updatedAt: 10,
                            tokenBudget: 1000,
                            tokensUsed: 250,
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-token-usage' })).toBeTruthy();
        expect(tree?.root.findByProps({ testID: 'session-goal-token-usage-value' }).props.children).toBe('25%');
        expect(tree?.root.findByProps({ testID: 'session-goal-budget-summary' }).props.children).toBe('250 / 1k');

        act(() => tree?.unmount());
    });

    it('shows the no-budget state when a goal has no token budget', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        {
                            id: 'goal:codex',
                            kind: 'goal',
                            origin: 'vendor',
                            status: 'active',
                            title: 'Ship goals',
                            updatedAt: 10,
                            tokensUsed: 250,
                        },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={vi.fn()}
                onClearGoal={vi.fn()}
            />);
        });

        expect(tree?.root.findByProps({ testID: 'session-goal-budget-summary' }).props.children)
            .toBe('session.workState.goal.noTokenBudget:');
        expect(() => tree?.root.findByProps({ testID: 'session-goal-token-usage' })).toThrow();

        act(() => tree?.unmount());
    });

    it('clears an existing token budget when no limit is selected', async () => {
        const anchorRef = { current: null } as React.RefObject<any>;
        const onSetGoal = vi.fn().mockResolvedValue({ ok: true });

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SessionWorkStatePopover
                open
                anchorRef={anchorRef}
                snapshot={{
                    v: 1,
                    backendId: 'codex',
                    updatedAt: 10,
                    primaryItemId: 'goal:codex',
                    items: [
                        { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship goals', updatedAt: 10, tokenBudget: 1000, tokensUsed: 250 },
                    ],
                }}
                editableGoal
                onRequestClose={vi.fn()}
                onSetGoal={onSetGoal}
                onClearGoal={vi.fn()}
            />);
        });

        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-edit-button' }).props.onPress();
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-budget-no-limit-button' }).props.onPress();
        });
        await act(async () => {
            await tree?.root.findByProps({ testID: 'session-goal-save-button' }).props.onPress();
        });

        expect(onSetGoal).toHaveBeenCalledWith({
            objective: 'Ship goals',
            tokenBudget: null,
            resumeInactiveWithInitialGoal: false,
        });

        act(() => tree?.unmount());
    });
});
