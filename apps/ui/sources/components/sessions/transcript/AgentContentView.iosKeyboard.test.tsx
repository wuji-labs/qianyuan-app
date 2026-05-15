import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Keyboard: {
                addListener: () => ({ remove: () => {} }),
                dismiss: vi.fn(),
            },
            Platform: {
                OS: 'ios',
                select: <T,>(values: { ios?: T; native?: T; default?: T }) =>
                    values.ios ?? values.native ?? values.default,
            },
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
        });
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (
        props: Record<string, unknown> & { children?: React.ReactNode },
    ) => React.createElement('KeyboardAvoidingView', props, props.children),
}));

describe('AgentContentView (iOS keyboard)', () => {
    it('translates the transcript host instead of reserving stale bottom padding', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        const { tree } = await renderScreen(
            <AgentContentView
                content={<React.Fragment>content</React.Fragment>}
                input={<React.Fragment>input</React.Fragment>}
                placeholder={<React.Fragment>placeholder</React.Fragment>}
            />,
        );

        const keyboardHost = tree.root.findByProps({ testID: 'agent-content-keyboard-host' });
        expect(keyboardHost.props.behavior).toBe('translate-with-padding');
        expect(keyboardHost.props.keyboardVerticalOffset).toBe(0);
    });
});
