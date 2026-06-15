import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const friendRequestsState = vi.hoisted(() => ({
    items: [] as Array<{ id: string }>,
}));

const inboxState = vi.hoisted(() => ({
    hasContent: false,
}));

const badgeSettingsState = vi.hoisted(() => ({
    friends: true,
    inbox: true,
}));

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return {
            ...actual,
            useFriendRequests: (() => friendRequestsState.items) as typeof import('@/sync/domains/state/storage').useFriendRequests,
            useSetting: ((key: string) => {
                if (key === 'tabBarFriendsBadgeEnabled') return badgeSettingsState.friends;
                if (key === 'tabBarInboxBadgeEnabled') return badgeSettingsState.inbox;
                if (key === 'tabBarShowLabels') return true;
                if (key === 'tabBarSize') return 'regular';
                return undefined;
            }) as typeof import('@/sync/domains/state/storage').useSetting,
        };
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => inboxState.hasContent,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

function hasTextChild(node: renderer.ReactTestInstance, value: string) {
    return node.findAllByType('Text' as never).some((child) => String(child.props.children) === value);
}

function hasIndicatorDot(node: renderer.ReactTestInstance) {
    return node.findAll((child) => {
        if (String(child.type) !== 'View') return false;
        const style = child.props?.style ?? {};
        return style.width === 6 && style.height === 6;
    }).length > 0;
}

describe('TabBar', () => {
    beforeEach(() => {
        friendRequestsState.items = [];
        inboxState.hasContent = false;
        badgeSettingsState.friends = true;
        badgeSettingsState.inbox = true;
    });

    it('hides tab badges when disabled in settings', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        badgeSettingsState.friends = false;
        badgeSettingsState.inbox = false;
        const { TabBar } = await import('./TabBar');

        const tree = (await renderScreen(<TabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree.findAll((node) => typeof node.props?.onPress === 'function');
        const allTextNodes = tree.findAllByType('Text' as never);
        expect(tabs.some((tab) => hasIndicatorDot(tab))).toBe(false);
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(false);
    });

    it('shows friend request counts on the friends tab and a dot for inbox content', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        const { TabBar } = await import('./TabBar');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<TabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree!.findAll((node) => typeof node.props?.onPress === 'function');
        const inboxTab = tabs.find((tab) => hasIndicatorDot(tab));
        const allTextNodes = tree!.findAllByType('Text' as never);

        expect(inboxTab).toBeTruthy();
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(true);
        expect(hasIndicatorDot(inboxTab!)).toBe(true);
        expect(hasTextChild(inboxTab!, '2')).toBe(false);
    });
});
