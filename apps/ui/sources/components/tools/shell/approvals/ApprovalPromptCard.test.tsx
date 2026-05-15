import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeSpy = vi.fn(async () => ({ ok: true as const, result: {} }));
const createDefaultActionExecutorSpy = vi.fn((_opts?: unknown) => ({ execute: executeSpy }));
const sessionAllowSpy = vi.fn(async (..._args: unknown[]) => {});
const sessionDenySpy = vi.fn(async (..._args: unknown[]) => {});
const routerPushSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => createDefaultActionExecutorSpy(opts),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => 'server-from-session',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: unknown[]) => sessionAllowSpy(...args),
    sessionDeny: (...args: unknown[]) => sessionDenySpy(...args),
}));

function approvalRequest(): ApprovalRequestV1 {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'session_agent' as const, sessionId: 'session-1' },
        requestedSurface: 'session_agent',
        actionId: 'session.list',
        actionArgs: {},
        summary: 'List sessions before continuing',
        preview: { summary: 'Agent wants to inspect active sessions' },
    };
}

describe('ApprovalPromptCard', () => {
    it('renders the action approval summary in inline chrome', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');

        const screen = await renderScreen(
            <ApprovalPromptCard
                chrome="inline"
                artifact={{ id: 'approval-1', header: { serverId: 'server-1' } } as any}
                approval={approvalRequest()}
                sessionId="session-1"
                canApprove={true}
            />,
        );

        expect(screen.findByTestId('approval-prompt-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('List sessions before continuing');
        expect(screen.getTextContent()).toContain('Agent wants to inspect active sessions');
    });

    it('opens the originating transcript tool when a location is available', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
        routerPushSpy.mockClear();

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={{ id: 'approval-1', header: { serverId: 'server-1' } } as any}
                approval={approvalRequest()}
                sessionId="session-1"
                canApprove={true}
                location={{ kind: 'top', messageId: 'tool:tool-1', seq: 10 }}
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('approval-prompt-view-tool');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1?jumpSeq=10');
    });

    it('approves through approval.request.decide using the default action executor', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
        executeSpy.mockClear();
        createDefaultActionExecutorSpy.mockClear();
        sessionAllowSpy.mockClear();
        sessionDenySpy.mockClear();

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={{ id: 'approval-1', header: { serverId: 'server-1' } } as any}
                approval={approvalRequest()}
                sessionId="session-1"
                canApprove={true}
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('approval-prompt-approve');
        });

        expect(createDefaultActionExecutorSpy).toHaveBeenCalled();
        expect(executeSpy).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'approval-1', decision: 'approve' },
            expect.objectContaining({ surface: 'ui_button', serverId: 'server-1' }),
        );
        expect(sessionAllowSpy).not.toHaveBeenCalled();
        expect(sessionDenySpy).not.toHaveBeenCalled();
    });

    it('rejects through approval.request.decide using the default action executor', async () => {
        const { ApprovalPromptCard } = await import('./ApprovalPromptCard');
        executeSpy.mockClear();
        sessionAllowSpy.mockClear();
        sessionDenySpy.mockClear();

        const screen = await renderScreen(
            <ApprovalPromptCard
                artifact={{ id: 'approval-1', header: {} } as any}
                approval={approvalRequest()}
                sessionId="session-1"
                canApprove={true}
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('approval-prompt-reject');
        });

        expect(executeSpy).toHaveBeenCalledWith(
            'approval.request.decide',
            { artifactId: 'approval-1', decision: 'reject' },
            expect.objectContaining({ surface: 'ui_button', serverId: 'server-from-session' }),
        );
        expect(sessionAllowSpy).not.toHaveBeenCalled();
        expect(sessionDenySpy).not.toHaveBeenCalled();
    });
});
