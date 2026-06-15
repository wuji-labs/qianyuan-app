import { isSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { isSessionFullContentConsumerActive } from '@/sync/domains/session/realtime/sessionRealtimeVisibility';
import {
    readMountedSessionRealtimeScmConsumerScopes,
    resolveSessionRealtimeScmScopeForMountedConsumers,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

export type SessionLiveConsumption = Readonly<{
    isVisible: boolean;
    isFullContentConsumer: boolean;
}>;

function getVoiceBoundTargetSessionIds(): string[] {
    return voiceSessionBindingStore
        .getState()
        .list()
        .map((binding) => binding.targetSessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0);
}

/**
 * Single source of truth for "is this session a live-content consumer right now?".
 *
 * Assembles the same 8-reason fan-out the realtime router consumes (visibility, explicit
 * transcript consumers, voice primary/tracked/readback/bound targets, SCM same-session /
 * same-project scope) so the catch-up policy gate and realtime routing can never diverge.
 *
 * Read it at decision time (the visibility signal is a now-decision, not an enqueue-decision).
 */
export function resolveSessionLiveConsumption(
    sessionId: string,
    sourceServerId?: string | null,
): SessionLiveConsumption {
    const visible = isSessionVisible(sessionId, sourceServerId);
    const voiceTarget = useVoiceTargetStore.getState();
    const scmMountedScopes = readMountedSessionRealtimeScmConsumerScopes();
    const isFullContentConsumer = isSessionFullContentConsumerActive({
        sessionId,
        isVisible: visible,
        explicitTranscriptConsumerSessionIds: readMountedSessionRealtimeTranscriptConsumerSessionIds(sourceServerId),
        voicePrimaryActionSessionId: voiceTarget.primaryActionSessionId,
        voiceTrackedSessionIds: voiceTarget.trackedSessionIds,
        voiceReadbackSessionIds: voiceTarget.lastFocusedSessionId ? [voiceTarget.lastFocusedSessionId] : [],
        voiceBoundTargetSessionIds: getVoiceBoundTargetSessionIds(),
        sessionScmScope: scmMountedScopes.length > 0
            ? resolveSessionRealtimeScmScopeForMountedConsumers(storage.getState(), sessionId, scmMountedScopes)
            : null,
        scmMountedScopes,
    });
    return { isVisible: visible, isFullContentConsumer };
}
