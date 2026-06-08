import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceContinuationReplayPlan } from './resolveConnectedServiceContinuationReplayPlan';

describe('resolveConnectedServiceContinuationReplayPlan', () => {
  it('retries the original user message when provider activity never started, even if the daemon-local queue is idle', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      inFlight: false,
      hasProviderActivityThisTurn: false,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'retry_original_user_message',
    });
  });

  it('retries the original user message when the interrupted turn has no provider activity yet', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      inFlight: true,
      hasProviderActivityThisTurn: false,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'retry_original_user_message',
    });
  });

  it('uses a continuation prompt for a completed provider turn even after the daemon-local queue goes idle', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      inFlight: false,
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });

  it('uses a continuation prompt when the interrupted turn already had provider activity', () => {
    expect(resolveConnectedServiceContinuationReplayPlan({
      inFlight: true,
      hasProviderActivityThisTurn: true,
    })).toEqual({
      continuationRequired: true,
      replayMode: 'continuation_prompt',
    });
  });
});
