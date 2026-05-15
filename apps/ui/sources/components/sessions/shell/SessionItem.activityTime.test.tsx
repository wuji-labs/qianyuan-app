import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import type { Settings } from '@/sync/domains/settings/settings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionSpy = vi.hoisted(() => vi.fn(() => null));
const useSessionListRowRenderableSpy = vi.hoisted(() => vi.fn(() => null));
const useSessionStatusSpy = vi.hoisted(() => vi.fn(() => mockSessionStatus));
const AvatarMock = 'Avatar' as unknown as React.ComponentType<{
    id?: string;
    size?: number;
    monochrome?: boolean;
    hasUnreadMessages?: boolean;
}>;
const AgentIconMock = 'AgentIcon' as unknown as React.ComponentType<{
    agentId?: string;
    size?: number;
    testID?: string;
    color?: string;
}>;
let platformOs: 'ios' | 'android' | 'web' = 'web';
let isTabletDevice = false;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: 'TextInput',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (value: any) => value[platformOs] ?? value.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useHasUnreadMessages: () => mockHasUnreadMessages,
            useProfile: useProfileSpy,
            useSession: useSessionSpy,
            useSessionListRowRenderable: useSessionListRowRenderableSpy,
            useSessionListActivityTimeLabel: () => '1m',
            useSessionListAttentionState: () => mockListAttentionState ?? (
                mockSessionStatus.state === 'waiting' ? 'quiet' : mockSessionStatus.state
            ),
            useSetting: (key: keyof Settings | string) => {
                if (key === 'sessionListNarrowWorkingIndicatorStyle') {
                    return mockNarrowWorkingIndicatorStyle;
                }
                if (key === 'avatarStyle') {
                    return mockAvatarStyle;
                }
                if (key === 'sessionListIdentityDisplay') {
                    return mockSessionListIdentityDisplay;
                }
                if (key === 'sessionListActiveColorModeV1') {
                    return mockSessionListActiveColorMode;
                }
                return undefined;
            },
        });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: (flavor: string | null | undefined) => flavor === 'claude' ? 'claude' : null,
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => isTabletDevice,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
    sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: useSessionStatusSpy,
}));

type MockSessionStatus = Readonly<{
    state: 'thinking' | 'waiting' | 'permission_required' | 'action_required';
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing: boolean;
}>;

const defaultSessionStatus: MockSessionStatus = {
    state: 'thinking',
    isConnected: true,
    statusText: 'working on it',
    shouldShowStatus: true,
    statusColor: '#07f',
    statusDotColor: '#0f0',
    isPulsing: false,
};

let mockSessionStatus: MockSessionStatus = {
    ...defaultSessionStatus,
};
let mockListAttentionState: 'quiet' | 'unread' | 'pending' | 'ready' | 'failed' | 'thinking' | null = null;
let mockHasUnreadMessages = false;
let mockNarrowWorkingIndicatorStyle: 'spinner' | 'pulse' = 'spinner';
let mockAvatarStyle = 'meshGradientColumns';
let mockSessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' = 'avatar';
let mockSessionListActiveColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive' = 'activityAndAttention';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

function createSession(
    id: string,
    metadata: ReturnType<typeof createSessionFixture>['metadata'] = null,
) {
    return createSessionFixture({
        id,
        active: true,
        activeAt: 1,
        createdAt: 1,
        updatedAt: 1,
        metadata,
        presence: 'online',
    });
}

function findRowContentStyle(screen: Awaited<ReturnType<typeof renderScreen>>, sessionId: string): Record<string, unknown> {
    const row = screen.findByTestId(`session-list-item-${sessionId}`);
    const children = row?.children ?? [];
    const content = children.find((child: unknown) => {
        if (!child || typeof child !== 'object' || !('props' in child)) return false;
        const style = flattenStyle((child as { props: { style?: unknown } }).props.style);
        return style.flex === 1;
    }) as { props: { style?: unknown } } | undefined;
    return flattenStyle(content?.props.style);
}

function findSessionTitleText(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.findAllByType('Text').find((node) => node.props.children === title);
}

function styleEntries(style: unknown): unknown[] {
    return Array.isArray(style) ? style : [style];
}

function findWorkingSpinner(screen: Awaited<ReturnType<typeof renderScreen>>, sessionId: string) {
    return screen.findByTestId(`session-row-attention-indicator-spinner-${sessionId}`);
}

describe('SessionItem activity time', () => {
    beforeEach(() => {
        mockSessionStatus = {
            ...defaultSessionStatus,
        };
        mockListAttentionState = null;
        mockHasUnreadMessages = false;
        mockNarrowWorkingIndicatorStyle = 'spinner';
        mockAvatarStyle = 'meshGradientColumns';
        mockSessionListIdentityDisplay = 'avatar';
        mockSessionListActiveColorMode = 'activityAndAttention';
        platformOs = 'web';
        isTabletDevice = false;
        useProfileSpy.mockClear();
        useSessionSpy.mockClear();
        useSessionListRowRenderableSpy.mockClear();
        useSessionStatusSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the meaningful activity timestamp instead of the raw session updatedAt', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_1')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders one working indicator in very compact mode without working status text', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_active')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_active')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_active-trailing')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_active-trailing-working')).toBeTruthy();
        const spinner = findWorkingSpinner(screen, 'sess_compact_active-trailing');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
            borderColor: lightTheme.colors.text.tertiary,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('working on it');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('renders the configured pulsing dot in very compact mode when selected', async () => {
        mockNarrowWorkingIndicatorStyle = 'pulse';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_active_dot')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_active_dot')).toBeNull();
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_active_dot-trailing-working')).toBeTruthy();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        const dots = screen.findAllByType('StatusDot');
        expect(dots).toHaveLength(1);
        expect(dots[0]?.props.isPulsing).toBe(true);
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('uses a tighter fixed row height in very compact mode', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_height')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_height')?.props.style);
        expect(rowStyle.height).toBe(34);
        expect(rowStyle.paddingHorizontal).toBe(8);

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_height')).toBeNull();
    });

    it('renders an 18px micro avatar in very compact web rows', async () => {
        platformOs = 'web';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_avatar_web')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_avatar_web')?.props.style);
        expect(rowStyle.height).toBe(34);
        expect(screen.findAllByType(AvatarMock)[0].props).toMatchObject({
            id: 'avatar',
            size: 18,
        });
        expect(findRowContentStyle(screen, 'sess_compact_avatar_web').marginLeft).toBe(8);
    });

    it('uses a 20px micro avatar for very compact native phone rows', async () => {
        platformOs = 'ios';
        isTabletDevice = false;
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_avatar_phone')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_avatar_phone')?.props.style);
        expect(rowStyle.height).toBe(42);
        expect(screen.findAllByType(AvatarMock)[0].props.size).toBe(20);
        expect(findRowContentStyle(screen, 'sess_compact_avatar_phone').marginLeft).toBe(8);
    });

    it('renders the selected agent logo in the same narrow identity slot', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_narrow', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findAllByType(AvatarMock)).toHaveLength(0);
        expect(screen.findAllByType(AgentIconMock)[0].props).toMatchObject({
            agentId: 'claude',
            size: 14,
            testID: 'session-list-agent-logo-sess_agent_logo_narrow',
        });
        expect(findRowContentStyle(screen, 'sess_agent_logo_narrow').marginLeft).toBe(8);
    });

    it('passes the resolved title color to agent logos for quiet active rows', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'quiet';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_quiet', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        const titleStyleEntries = styleEntries(findSessionTitleText(screen, 'Session')?.props.style);
        const explicitTitleColorStyle = titleStyleEntries[titleStyleEntries.length - 1] as { color?: unknown } | undefined;
        expect(titleStyle.color).toBe(lightTheme.colors.text.secondary);
        expect(explicitTitleColorStyle).toMatchObject({ color: titleStyle.color });
        expect(screen.findAllByType(AgentIconMock)[0].props.color).toBe(explicitTitleColorStyle?.color);
    });

    it('can use the active title color for all active connected session rows', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        mockSessionListActiveColorMode = 'allActive';
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'quiet';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_all_active', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.primary);
        expect(screen.findAllByType(AgentIconMock)[0].props.color).toBe(titleStyle.color);
    });

    it('can keep working rows secondary when only attention rows use active color', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        mockSessionListActiveColorMode = 'attentionOnly';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_attention_only', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.secondary);
        expect(screen.findAllByType(AgentIconMock)[0].props.color).toBe(titleStyle.color);
    });

    it('hides the session list identity slot across row densities when identity display is none', async () => {
        mockSessionListIdentityDisplay = 'none';
        const { SessionItem } = await import('./SessionItem');

        const detailed = await renderScreen(
            <SessionItem
                session={createSession('sess_avatar_none_detailed')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );
        expect(detailed.findAllByType(AvatarMock)).toHaveLength(0);
        expect(detailed.findAllByType(AgentIconMock)).toHaveLength(0);

        standardCleanup();

        const cozy = await renderScreen(
            <SessionItem
                session={createSession('sess_avatar_none_cozy')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={false}
            />,
        );
        expect(cozy.findAllByType(AvatarMock)).toHaveLength(0);
        expect(cozy.findAllByType(AgentIconMock)).toHaveLength(0);

        standardCleanup();

        const narrow = await renderScreen(
            <SessionItem
                session={createSession('sess_avatar_none_narrow')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );
        expect(narrow.findAllByType(AvatarMock)).toHaveLength(0);
        expect(narrow.findAllByType(AgentIconMock)).toHaveLength(0);
        expect(findRowContentStyle(narrow, 'sess_avatar_none_narrow').marginLeft).toBe(0);
    });

    it('keeps very compact web rows dense for the sidebar surface', async () => {
        platformOs = 'web';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_web')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_web')?.props.style);
        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);

        expect(rowStyle.height).toBe(34);
        expect(titleStyle.fontSize).toBe(12);
        expect(titleStyle.lineHeight).toBe(16);
    });

    it('uses readable title metrics for very compact native phone rows', async () => {
        platformOs = 'ios';
        isTabletDevice = false;
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_phone')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_phone')?.props.style);
        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);

        expect(rowStyle.height).toBe(42);
        expect(titleStyle.fontSize).toBe(14);
        expect(titleStyle.lineHeight).toBe(18);
    });

    it('renders meaningful working status with canonical row indicator and themed text', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_status_pill')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );

        expect(screen.findByTestId('session-list-status-pill-sess_status_pill')).toBeNull();
        expect(screen.findByTestId('session-list-status-subtitle-sess_status_pill-working')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_status_pill-secondary-working')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_status_pill-working')?.props.children).toBe('working on it');
        const spinner = findWorkingSpinner(screen, 'sess_status_pill-secondary');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'working on it');
        const flat = flattenStyle(statusText?.props.style);
        expect(flat.color).not.toBe('#07f');
        expect(flat.fontSize).toBe(12);
        expect(flat.lineHeight).toBe(16);
        expect(screen.getTextContent()).toContain('working on it');
    });

    it('renders the configured pulsing dot for working status subtitles outside very compact mode', async () => {
        mockNarrowWorkingIndicatorStyle = 'pulse';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_status_pill_dot')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );

        expect(screen.findByTestId('session-list-attention-indicator-sess_status_pill_dot-secondary-working')).toBeTruthy();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        const statusDots = screen.findAllByType('StatusDot');
        expect(statusDots).toHaveLength(1);
        expect(statusDots[0]?.props.isPulsing).toBe(true);
    });

    it('uses canonical list attention for ready row presentation', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'ready';

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_ready')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );

        expect(screen.findByTestId('session-list-status-subtitle-sess_ready-ready')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_ready-secondary-ready')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_ready-ready')?.props.children).toBe('status.readyForReview');
        expect(screen.getTextContent()).not.toContain('online');
    });

    it('does not show the legacy avatar unread badge for canonical ready rows', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'ready';
        mockHasUnreadMessages = true;

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_ready_avatar')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );

        expect(screen.findByTestId('session-list-status-subtitle-sess_ready_avatar-ready')).toBeTruthy();
        expect(screen.findAllByType(AvatarMock)[0].props.hasUnreadMessages).toBe(false);
    });

    it('renders canonical ready attention beside the trailing time in very compact mode', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'ready';

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_ready')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_ready')).toBeNull();
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_ready-trailing-ready')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders canonical failed attention beside the trailing time in very compact mode', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'failed';

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_failed')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_failed')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_failed-trailing')?.props.accessibilityLabel).toBe('status.error');
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_failed-trailing-failed')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders canonical failed attention as a themed status subtitle outside very compact mode', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'failed';

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_failed_status')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );

        expect(screen.findByTestId('session-list-status-subtitle-sess_failed_status-failed')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_failed_status-secondary-failed')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_failed_status-failed')?.props.children).toBe('status.error');
        expect(screen.getTextContent()).not.toContain('online');
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'status.error');
        expect(flattenStyle(statusText?.props.style).color).not.toBe('#34C759');
    });

    it('does not render a subtitle in very compact mode for quiet online sessions', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_quiet')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_quiet')).toBeNull();
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders a distinct accessible permission indicator in very compact mode', async () => {
        mockSessionStatus = {
            state: 'permission_required',
            isConnected: true,
            statusText: 'permission required',
            shouldShowStatus: true,
            statusColor: '#f90',
            statusDotColor: '#f90',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_permission')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_permission')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_permission-trailing')?.props.accessibilityLabel).toBe('permission required');
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_permission-trailing-permission_required')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('permission required');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('passes list-row pending approval flags to session status when the store renderable is stale', async () => {
        const staleStoreRenderable = {
            ...createSession('sess_overlay_permission'),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };
        useSessionListRowRenderableSpy.mockReturnValue(staleStoreRenderable);

        const { SessionItem } = await import('./SessionItem');

        const listSession = {
            ...createSession('sess_overlay_permission'),
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        };

        await renderScreen(
            <SessionItem
                session={listSession}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(useSessionStatusSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'sess_overlay_permission',
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
            }),
            expect.objectContaining({
                subscribeToSession: false,
                subscribeToTranscript: false,
            }),
        );
    });

    it('renders a distinct accessible action indicator in very compact mode', async () => {
        mockSessionStatus = {
            state: 'action_required',
            isConnected: true,
            statusText: 'action required',
            shouldShowStatus: true,
            statusColor: '#f90',
            statusDotColor: '#f90',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_action')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_action')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_action-trailing')?.props.accessibilityLabel).toBe('action required');
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_action-trailing-action_required')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('action required');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('keeps the selected row background when a session is selected', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_selected')}
                serverId="server_a"
                pinned={false}
                selected={true}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_selected')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
    });

    it('uses the row-specific renderable selector and currentUserId prop without subscribing to profile or full session state', async () => {
        const { SessionItem } = await import('./SessionItem');

        await renderScreen(
            <SessionItem
                session={createSession('sess_row_state')}
                currentUserId="u1"
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(useSessionListRowRenderableSpy).toHaveBeenCalledWith('sess_row_state');
        expect(useSessionStatusSpy).toHaveBeenCalledWith(expect.any(Object), {
            subscribeToSession: false,
            subscribeToTranscript: false,
        });
        expect(useSessionSpy).not.toHaveBeenCalled();
        expect(useProfileSpy).not.toHaveBeenCalled();
    });

    it('renders inactive online session avatars in monochrome', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_inactive_online'),
                    active: false,
                    presence: 'online',
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findAllByType(AvatarMock)[0].props.monochrome).toBe(true);
    });

    it('uses start-side overflow ellipsis for path subtitles on web without reordering the path', async () => {
        platformOs = 'web';
        const { SessionItem } = await import('./SessionItem');
        const sessionPath = '~/Documents/Development/happier/remote-dev';

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_path_web')}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const outerSubtitle = screen.root.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return String(node.type) === 'Text'
                && node.props.numberOfLines === 1
                && style.writingDirection === 'rtl';
        })[0];
        const innerSubtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === sessionPath,
        )[0];

        expect(screen.getTextContent()).toContain(sessionPath);
        expect(outerSubtitle).toBeTruthy();
        expect(innerSubtitle).toBeTruthy();
        expect(flattenStyle(outerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });
        expect(flattenStyle(innerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for path subtitles outside web', async () => {
        platformOs = 'ios';
        const { SessionItem } = await import('./SessionItem');
        const sessionPath = '~/Documents/Development/happier/remote-dev';

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_path_native')}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const subtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === sessionPath
            && node.props.numberOfLines === 1,
        )[0];

        expect(subtitle?.props.ellipsizeMode).toBe('head');
    });
});
