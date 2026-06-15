import * as React from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import {
    useVisibleSessionListPaneState,
    type VisibleSessionListViewDataOptions,
} from '@/hooks/session/useVisibleSessionListViewData';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { HiddenInactiveSessionsEmptyState } from '@/components/sessions/guidance/HiddenInactiveSessionsEmptyState';
import { SessionsListContent } from '@/components/sessions/shell/SessionsList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readSessionIdFromPathname } from '@/components/sessions/shell/readSessionIdFromPathname';
import {
    resolvePhoneRootSessionListSurfaceDataActive,
    resolveSessionListSurfaceOwnership,
    SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: theme.colors.background.canvas,
    },
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
}));

type SessionsListWrapperProps = Readonly<{
    pathname?: string;
    surfaceRoutePathname?: string;
}>;

type SessionsListPaneState = ReturnType<typeof useVisibleSessionListPaneState>;

const EMPTY_SESSIONS_LIST_PANE_STATE: SessionsListPaneState = Object.freeze({
    sessionListViewData: null,
    visibleSessionCount: 0,
    hasHiddenInactiveSessions: false,
});

export const SessionsListWrapper = React.memo((props: SessionsListWrapperProps) => {
    if (props.pathname !== undefined) {
        return (
            <RouteBoundSessionsListWrapperContent
                pathname={props.pathname}
                surfaceRoutePathname={props.surfaceRoutePathname}
            />
        );
    }
    return <RouteBoundSessionsListWrapperContent />;
});

const RouteBoundSessionsListWrapperContent = React.memo((props: SessionsListWrapperProps) => {
    const routePathname = usePathname();
    return (
        <SessionsListWrapperContent
            pathname={props.pathname ?? routePathname}
            surfaceRoutePathname={props.surfaceRoutePathname ?? routePathname}
        />
    );
});

const ActiveSessionsListPaneStateSubscriber = React.memo((props: Readonly<{
    storageKind: Parameters<typeof useVisibleSessionListPaneState>[0];
    options: VisibleSessionListViewDataOptions;
    onPaneState: (paneState: SessionsListPaneState) => void;
}>) => {
    const paneState = useVisibleSessionListPaneState(props.storageKind, props.options);

    React.useLayoutEffect(() => {
        props.onPaneState(paneState);
    }, [paneState, props.onPaneState]);

    return null;
});

const SessionsListWrapperContent = React.memo((props: { pathname: string; surfaceRoutePathname: string }) => {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const { directSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const pathname = props.pathname;
    const surfaceRoutePathname = props.surfaceRoutePathname;
    const retainedPaneStateRef = React.useRef<Readonly<{
        storageKind: typeof storageKind;
        sessionListViewData: SessionListViewItem[] | null;
        activeSessionId: string | null;
    }> | null>(null);
    const paneStateStorageKindRef = React.useRef<typeof storageKind | null>(null);
    const surfaceOwnership = React.useMemo(
        () => resolveSessionListSurfaceOwnership({
            ownerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
            interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
            visible: true,
            dataActive: isFocused && resolvePhoneRootSessionListSurfaceDataActive(surfaceRoutePathname),
        }),
        [isFocused, surfaceRoutePathname],
    );
    const routeActiveSessionId = React.useMemo(() => readSessionIdFromPathname(pathname), [pathname]);
    const foregroundRouteSessionId = React.useMemo(
        () => readSessionIdFromPathname(surfaceRoutePathname),
        [surfaceRoutePathname],
    );
    const [paneState, setPaneState] = React.useState<SessionsListPaneState>(EMPTY_SESSIONS_LIST_PANE_STATE);
    const handlePaneState = React.useCallback((nextPaneState: SessionsListPaneState) => {
        paneStateStorageKindRef.current = storageKind;
        setPaneState((currentPaneState) => (currentPaneState === nextPaneState ? currentPaneState : nextPaneState));
    }, [storageKind]);
    React.useEffect(() => {
        if (surfaceOwnership.dataActive) return;
        retainedPaneStateRef.current = {
            storageKind: paneStateStorageKindRef.current ?? storageKind,
            sessionListViewData: paneState.sessionListViewData,
            activeSessionId: foregroundRouteSessionId,
        };
    }, [foregroundRouteSessionId, paneState.sessionListViewData, storageKind, surfaceOwnership.dataActive]);
    const retainedPaneStateForActivation = surfaceOwnership.dataActive
        && retainedPaneStateRef.current?.storageKind === storageKind
        ? retainedPaneStateRef.current
        : null;
    const paneStateOptions = React.useMemo<VisibleSessionListViewDataOptions>(() => {
        const retainedSessionListViewData = retainedPaneStateForActivation?.sessionListViewData ?? null;
        return {
            activeSessionId: routeActiveSessionId ?? retainedPaneStateForActivation?.activeSessionId ?? null,
            ...(retainedSessionListViewData
                ? { retainedSessionListViewData }
                : {}),
            sessionListSurfaceDataActive: true,
        };
    }, [retainedPaneStateForActivation, routeActiveSessionId]);
    React.useEffect(() => {
        if (!surfaceOwnership.dataActive) return;
        retainedPaneStateRef.current = null;
    }, [paneStateOptions, surfaceOwnership.dataActive]);
    const { sessionListViewData, visibleSessionCount, hasHiddenInactiveSessions } = paneState;
    const styles = stylesheet;
    const storageChrome = (
        <SessionsListStorageChrome
            directSessionsEnabled={directSessionsEnabled}
            storageKind={storageKind}
            onSelectStorageKind={setStorageKind}
        />
    );
    const sessionListContent = React.useMemo(
        () => (
            <SessionsListContent
                storageKind={storageKind}
                data={sessionListViewData}
                pathname={pathname}
                surfaceOwnership={surfaceOwnership}
            />
        ),
        [pathname, sessionListViewData, storageKind, surfaceOwnership],
    );

    if (!surfaceOwnership.visible) {
        return <View style={styles.container} />;
    }

    let content: React.ReactNode;
    if (sessionListViewData === null) {
        content = (
            <View style={styles.container}>
                {storageChrome}
                <View style={styles.loadingContainerWrapper}>
                    <View style={styles.loadingContainer}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                </View>
            </View>
        );
    } else if (visibleSessionCount === 0) {
        content = (
            <View style={styles.container}>
                {storageChrome}
                <View style={styles.emptyStateContainer}>
                    <View style={styles.emptyStateContentContainer}>
                        {hasHiddenInactiveSessions ? (
                            <HiddenInactiveSessionsEmptyState />
                        ) : (
                            <SessionGettingStartedGuidance variant="phone" />
                        )}
                    </View>
                </View>
            </View>
        );
    } else {
        content = (
            <View style={styles.container}>
                {storageChrome}
                {sessionListContent}
            </View>
        );
    }

    return (
        <>
            {surfaceOwnership.dataActive ? (
                <ActiveSessionsListPaneStateSubscriber
                    storageKind={storageKind}
                    options={paneStateOptions}
                    onPaneState={handlePaneState}
                />
            ) : null}
            {content}
        </>
    );
});
