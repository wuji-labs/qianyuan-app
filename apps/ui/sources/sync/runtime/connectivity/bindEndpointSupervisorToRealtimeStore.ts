import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

import { storage } from '@/sync/domains/state/storageStore';
import type { PauseController } from '@/utils/timing/pauseController';

import { bindManagedConnectionStateToRealtimeStore } from './bindManagedConnectionStateToRealtimeStore';

export function bindEndpointSupervisorToRealtimeStore(params: Readonly<{
    supervisor: ManagedEndpointSupervisor;
    pause?: PauseController;
    pauseReason?: string;
    onEndpointOnline?: () => void;
}>): () => void {
    return bindManagedConnectionStateToRealtimeStore({
        subscribe: (listener) => params.supervisor.subscribe(listener),
        setEndpointConnectivity: (snapshot) => {
            storage.getState().setEndpointConnectivity(snapshot);
        },
        pause: params.pause,
        onOnline: params.onEndpointOnline,
    });
}
