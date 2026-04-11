import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

const mockNavigateToSession = vi.fn();
let capturedSectionListProps: any | null = null;
const mockSessions = vi.hoisted(() => ({
    all: [] as any[],
    hideInactiveSessions: false,
    pinnedSessionKeysV1: [] as string[],
}));

vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        SectionList: ({ sections, renderItem, renderSectionHeader, keyExtractor, contentContainerStyle, ...rest }: any) => {
            capturedSectionListProps = { sections, renderItem, renderSectionHeader, keyExtractor, contentContainerStyle, ...rest };
            return React.createElement(
                'SectionList',
                { sections, contentContainerStyle, ...rest },
                sections.flatMap((section: any) => {
                    const sectionNodes = [];
                    if (renderSectionHeader) {
                        sectionNodes.push(
                            React.createElement(
                                React.Fragment,
                                { key: `${section.key}:header` },
                                renderSectionHeader({ section }),
                            ),
                        );
                    }
                    for (const [index, item] of section.data.entries()) {
                        sectionNodes.push(
                            React.createElement(
                                React.Fragment,
                                { key: keyExtractor?.(item, index) ?? `${section.key}:${index}` },
                                renderItem({ item, index, section }),
                            ),
                        );
                    }
                    return sectionNodes;
                }),
            );
        },
    });
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props, null),
}));
vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => mockNavigateToSession,
}));
vi.mock('@/sync/ops', () => ({
    sessionUnarchiveWithServerScope: vi.fn(async () => ({ success: true, archivedAt: null })),
}));
vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {},
            machines: {},
        }),
    },
    useAllSessions: () => mockSessions.all,
    useSetting: (key: string) => {
        if (key === 'hideInactiveSessions') return mockSessions.hideInactiveSessions;
        if (key === 'pinnedSessionKeysV1') return mockSessions.pinnedSessionKeysV1;
        return null;
    },
}));

describe('Archived sessions route', () => {
    beforeEach(() => {
        mockNavigateToSession.mockReset();
        capturedSectionListProps = null;
        mockSessions.hideInactiveSessions = false;
        mockSessions.pinnedSessionKeysV1 = [];
        mockSessions.all = [];
    });

    it('shows inactive sessions before archived sessions only when hide inactive sessions is enabled', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.all = [
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
            },
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const content = screen.getTextContent();

        expect(content).toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).toContain('sessionInfo.archivedSessions');
        expect(content.indexOf('settingsFeatures.hiddenInactiveSessionsSectionTitle')).toBeLessThan(
            content.indexOf('sessionInfo.archivedSessions'),
        );
        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionSubtitle');
        expect(content).toContain('Inactive Session');
    });

    it('does not show inactive sessions when hide inactive sessions is disabled', async () => {
        mockSessions.hideInactiveSessions = false;
        mockSessions.all = [
            {
                id: 'archived-1',
                active: false,
                archivedAt: 123,
                updatedAt: 20,
                metadata: { name: 'Archived Session', path: '/tmp/archived' },
            },
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);
        const content = screen.getTextContent();

        expect(content).toContain('sessionInfo.archivedSessions');
        expect(content).not.toContain('settingsFeatures.hiddenInactiveSessionsSectionTitle');
        expect(content).not.toContain('Inactive Session');
    });

    it('stops wheel propagation on web so the archived sessions page can scroll inside the shell', async () => {
        mockSessions.hideInactiveSessions = true;
        mockSessions.all = [
            {
                id: 'inactive-1',
                active: false,
                archivedAt: null,
                updatedAt: 10,
                metadata: { name: 'Inactive Session', path: '/tmp/inactive' },
                serverId: 'server-1',
            },
        ];

        const Screen = (await import('@/app/(app)/session/archived')).default;
        const screen = await renderScreen(<Screen />);

        expect(screen.root).toBeTruthy();
        expect(typeof capturedSectionListProps?.onWheel).toBe('function');

        const stopPropagation = vi.fn();
        capturedSectionListProps?.onWheel?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });
});
