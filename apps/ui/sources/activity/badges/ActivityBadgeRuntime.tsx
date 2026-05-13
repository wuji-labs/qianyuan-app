import * as React from 'react';

import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { resolveActivityAttentionSessions } from '@/activity/attention/activityAttentionSessions';
import {
    getStorage,
    useFriendRequests,
    useLocalSettings,
} from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildActivityBadgeState } from './buildActivityBadgeState';
import { applyExpoNativeBadgeState } from './channels/applyExpoNativeBadgeState';
import { applyTauriBadgeState } from './channels/applyTauriBadgeState';

type ServerBadgeSnapshot = Readonly<{
    count: number;
    serverGeneration: number;
    serverId: string;
}>;

type ActivityBadgeSessionOptions = Readonly<{
    showUnread: boolean;
    showPendingPermissionRequests: boolean;
    showPendingUserActionRequests: boolean;
}>;

type LocalActivityBadgeSnapshot = Readonly<{
    count: number;
    hasLocalBadgeSource: boolean;
    isDataReady: boolean;
    showNonNumericDot: boolean;
}>;

async function fetchServerBadgeCount(): Promise<number | null> {
    try {
        const response = await serverFetch('/v1/account/activity/badge-snapshot', {
            method: 'GET',
        }, { retry: 'none' });
        if (!response.ok) return null;
        const json = await response.json();
        const badgeCount = (json as { badgeCount?: unknown } | null | undefined)?.badgeCount;
        return typeof badgeCount === 'number' && Number.isInteger(badgeCount) && badgeCount >= 0 ? badgeCount : null;
    } catch {
        return null;
    }
}

function canUseServerBadgeSnapshot(options: ActivityBadgeSessionOptions): boolean {
    return options.showUnread
        && options.showPendingPermissionRequests
        && options.showPendingUserActionRequests;
}

function useLocalActivityBadgeSnapshot(params: Readonly<{
    badgesEnabled: boolean;
    friendRequestCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions: ActivityBadgeSessionOptions;
}>): LocalActivityBadgeSnapshot {
    return getStorage()(useShallow((state) => {
        const sessions = Object.values(state.sessions);
        const sessionRows = Object.values(state.sessionListRenderables);
        const hasLocalBadgeSource = sessions.length > 0 || sessionRows.length > 0;

        if (!params.badgesEnabled) {
            return {
                count: 0,
                hasLocalBadgeSource,
                isDataReady: state.isDataReady,
                showNonNumericDot: false,
            };
        }

        const badgeSessions = resolveActivityAttentionSessions({
            sessions,
            sessionRows,
        });
        const badgeState = buildActivityBadgeState({
            sessions: badgeSessions,
            numericInboxCount: params.friendRequestCount,
            hasNonNumericInboxAttention: params.hasNonNumericInboxAttention,
            sessionOptions: params.sessionOptions,
        });

        return {
            count: badgeState.count,
            hasLocalBadgeSource,
            isDataReady: state.isDataReady,
            showNonNumericDot: badgeState.showNonNumericDot,
        };
    }));
}

export function ActivityBadgeRuntime(): React.ReactElement | null {
    const friendRequests = useFriendRequests();
    const localSettings = useLocalSettings();
    const activeServer = useActiveServerSnapshot();
    const { updateAvailable } = useUpdates();
    const { hasUnread: changelogHasUnread } = useChangelog();
    const isTauriDesktopHost = isTauriDesktop();
    const shouldApplyBadgeRuntime = isTauriDesktopHost || Platform.OS !== 'web';
    const [serverBadgeSnapshot, setServerBadgeSnapshot] = React.useState<ServerBadgeSnapshot | null>(null);

    const sessionOptions = React.useMemo<ActivityBadgeSessionOptions>(() => ({
        showUnread: localSettings.activityBadgeShowUnread !== false,
        showPendingPermissionRequests:
            localSettings.activityBadgeShowPendingPermissionRequests !== false,
        showPendingUserActionRequests:
            localSettings.activityBadgeShowPendingUserActionRequests !== false,
    }), [
        localSettings.activityBadgeShowPendingPermissionRequests,
        localSettings.activityBadgeShowPendingUserActionRequests,
        localSettings.activityBadgeShowUnread,
    ]);

    const badgesEnabled = localSettings.activityBadgesEnabled !== false;
    const serverSnapshotAllowed = badgesEnabled && canUseServerBadgeSnapshot(sessionOptions);
    const localBadgeSnapshot = useLocalActivityBadgeSnapshot({
        badgesEnabled,
        friendRequestCount:
            localSettings.activityBadgeShowFriendRequestsInboxCount === false
                ? 0
                : friendRequests.length,
        hasNonNumericInboxAttention:
            localSettings.activityBadgeShowDesktopNonNumericDot !== false &&
            (updateAvailable || changelogHasUnread),
        sessionOptions,
    });

    React.useEffect(() => {
        if (!shouldApplyBadgeRuntime || !serverSnapshotAllowed || !activeServer.serverId || !activeServer.serverUrl) {
            setServerBadgeSnapshot(null);
            return;
        }

        let cancelled = false;
        setServerBadgeSnapshot(null);
        void fetchServerBadgeCount().then((count) => {
            if (cancelled || count === null) return;
            setServerBadgeSnapshot({
                count,
                serverGeneration: activeServer.generation,
                serverId: activeServer.serverId,
            });
        });

        return () => {
            cancelled = true;
        };
    }, [
        activeServer.generation,
        activeServer.serverId,
        activeServer.serverUrl,
        serverSnapshotAllowed,
        shouldApplyBadgeRuntime,
    ]);

    const localBadgeState = React.useMemo(() => ({
        count: localBadgeSnapshot.count,
        showNonNumericDot: localBadgeSnapshot.showNonNumericDot,
    }), [
        localBadgeSnapshot.count,
        localBadgeSnapshot.showNonNumericDot,
    ]);

    const badgeState = React.useMemo(() => {
        if (!badgesEnabled) return localBadgeState;
        if (localBadgeSnapshot.isDataReady || localBadgeSnapshot.hasLocalBadgeSource) return localBadgeState;
        if (
            serverSnapshotAllowed
            && serverBadgeSnapshot
            && serverBadgeSnapshot.serverGeneration === activeServer.generation
            && serverBadgeSnapshot.serverId === activeServer.serverId
        ) {
            return { count: serverBadgeSnapshot.count, showNonNumericDot: false };
        }
        return null;
    }, [
        activeServer.generation,
        activeServer.serverId,
        badgesEnabled,
        localBadgeState,
        localBadgeSnapshot.hasLocalBadgeSource,
        localBadgeSnapshot.isDataReady,
        serverBadgeSnapshot,
        serverSnapshotAllowed,
    ]);

    const badgeCount = badgeState?.count;
    const showNonNumericDot = badgeState?.showNonNumericDot;

    React.useEffect(() => {
        if (badgeCount === undefined || showNonNumericDot === undefined) return;
        const nextBadgeState = {
            count: badgeCount,
            showNonNumericDot,
        };
        if (isTauriDesktopHost) {
            fireAndForget(applyTauriBadgeState(nextBadgeState), {
                tag: 'ActivityBadgeRuntime.applyTauriBadgeState',
            });
            return;
        }

        if (Platform.OS === 'web') return;

        fireAndForget(applyExpoNativeBadgeState(nextBadgeState), {
            tag: 'ActivityBadgeRuntime.applyExpoNativeBadgeState',
        });
    }, [badgeCount, isTauriDesktopHost, showNonNumericDot]);

    return null;
}
