import type { SessionContinuationReplayModeV1 } from '@happier-dev/protocol';

export type ConnectedServiceContinuationReplayPlan = Readonly<{
  continuationRequired?: boolean;
  replayMode: SessionContinuationReplayModeV1;
}>;

export function resolveConnectedServiceContinuationReplayPlan(input: Readonly<{
  inFlight: boolean;
  hasProviderActivityThisTurn: boolean;
}>): ConnectedServiceContinuationReplayPlan {
  // The daemon-local deferral queue is best-effort state. If provider activity
  // never started before the failure, a restart-resume recovery must validate the
  // new provider context by retrying the original user message even when the
  // queue no longer thinks the turn is in flight.
  if (!input.hasProviderActivityThisTurn) {
    return {
      continuationRequired: true,
      replayMode: 'retry_original_user_message',
    };
  }
  return {
    continuationRequired: true,
    replayMode: 'continuation_prompt',
  };
}
