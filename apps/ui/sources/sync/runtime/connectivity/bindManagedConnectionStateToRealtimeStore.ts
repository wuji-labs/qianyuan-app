import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

import type { EndpointConnectivitySnapshot } from '@/sync/store/domains/realtime';
import type { PauseController } from '@/utils/timing/pauseController';

import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';

export type ManagedConnectionStateSubscription = (
    listener: (state: ManagedConnectionState) => void,
) => () => void;

export function mapManagedConnectionStateToEndpointConnectivitySnapshot(
    state: ManagedConnectionState,
): EndpointConnectivitySnapshot {
    return {
        status: state.phase,
        reason: state.reason,
        attempt: state.attempt,
        nextRetryAt: state.nextRetryAt,
        lastConnectedAt: state.lastConnectedAt,
        lastDisconnectedAt: state.lastDisconnectedAt,
        lastErrorMessage: sanitizeEndpointErrorMessage(state.lastErrorMessage),
    };
}

function isOfflineLikeManagedConnectionState(state: ManagedConnectionState): boolean {
    return state.phase === 'offline' || state.phase === 'auth_failed' || state.phase === 'shutting_down';
}

export function bindManagedConnectionStateToRealtimeStore(params: Readonly<{
    subscribe: ManagedConnectionStateSubscription;
    setEndpointConnectivity: (snapshot: EndpointConnectivitySnapshot) => void;
    pause?: PauseController;
    onOnline?: () => void;
}>): () => void {
    const pause = params.pause;
    const onOnline = params.onOnline;
    let sawOfflineLike = false;

    return params.subscribe((state) => {
        if (pause) {
            if (state.phase === 'online') {
                pause.resume();
            } else {
                pause.pause();
            }
        }

        if (isOfflineLikeManagedConnectionState(state)) {
            sawOfflineLike = true;
        } else if (state.phase === 'online' && sawOfflineLike) {
            sawOfflineLike = false;
            try {
                onOnline?.();
            } catch {
                // ignore listener failures; store updates must continue
            }
        }

        params.setEndpointConnectivity(mapManagedConnectionStateToEndpointConnectivitySnapshot(state));
    });
}
