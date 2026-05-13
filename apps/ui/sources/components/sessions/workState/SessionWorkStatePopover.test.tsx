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
    return createTextModuleMock({ translate: (key, params) => `${key}:${params?.title ?? ''}` });
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

        expect(activeRow?.props.accessibilityState).toEqual({ selected: true });
        expect(pendingRow?.props.accessibilityState).toEqual({ selected: false });
        expect(doneGroup).toBeTruthy();

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
});
