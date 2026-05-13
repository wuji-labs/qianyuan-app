import { useShallow } from 'zustand/react/shallow';

import { getStorage } from '@/sync/domains/state/storageStore';
import {
    resolveMachineTargetForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';

export function useSessionMachineTarget(sessionId: string): { machineId: string; basePath: string } | null {
    return getStorage()(
        useShallow((state) =>
            resolveMachineTargetForSessionFromState(state as SessionMachineTargetState, sessionId)
        )
    );
}
