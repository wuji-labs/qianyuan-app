import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    });
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/session/activeViewingSession', () => ({
    getActiveViewingSessionId: () => null,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('../channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification: vi.fn(async () => 'notif-1'),
}));

vi.mock('../channels/sendTauriLocalNotification', () => ({
    sendTauriLocalNotification: vi.fn(async () => true),
}));

describe('ActivityLocalNotificationRuntime local settings subscriptions', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        getStorage().getState().applyLocalSettings({
            localNotificationsEnabled: true,
            localNotificationsShowReady: true,
            localNotificationsShowReadyMessageText: true,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: true,
            activityBadgeShowUnread: true,
        });
    });

    afterEach(async () => {
        getStorage().setState(initialStorageState, true);
        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
        vi.clearAllMocks();
    });

    it('does not rerender for local setting writes unrelated to local notifications', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        let updateCount = 0;

        const screen = await renderScreen(
            <React.Profiler
                id="activity-local-notification-runtime"
                onRender={(_id, phase) => {
                    if (phase === 'update') updateCount += 1;
                }}
            >
                <ActivityLocalNotificationRuntime />
            </React.Profiler>,
        );

        const updatesBeforeUnrelatedLocalSettingWrite = updateCount;

        await act(async () => {
            getStorage().getState().applyLocalSettings({ activityBadgeShowUnread: false });
        });

        expect(updateCount).toBe(updatesBeforeUnrelatedLocalSettingWrite);

        await act(async () => {
            screen.tree.unmount();
        });
    });
});
