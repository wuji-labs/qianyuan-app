import { describe, expect, it } from 'vitest';

import {
  evaluatePredictiveSoftSwitchPolicy,
  evaluatePredictiveSoftSwitchSessionApplyPolicy,
} from './predictiveSoftSwitchPolicy';

describe('evaluatePredictiveSoftSwitchPolicy', () => {
  it('suppresses live-session predictive soft-threshold switching for restart-only providers', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      context: 'live_session',
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'unsupported',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    });
  });

  it('allows pre-spawn soft-threshold switching for restart-only providers (RD-QUO-10)', () => {
    // Before a spawn there is no live runtime that would need a hot apply or a
    // restart — the new process simply materializes the freshly selected member.
    expect(evaluatePredictiveSoftSwitchPolicy({
      context: 'pre_spawn',
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'unsupported',
    })).toEqual({ status: 'allow' });
  });

  it('suppresses predictive soft-threshold switching while a turn is in flight', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      context: 'live_session',
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });

  it('keeps hard usage-limit switching enabled even when predictive soft switching is disabled', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      context: 'live_session',
      reason: 'usage_limit',
      predictiveSoftSwitchMode: 'unsupported',
      turnState: { inFlight: true },
    })).toEqual({ status: 'allow' });
  });
});

describe('evaluatePredictiveSoftSwitchSessionApplyPolicy', () => {
  it('suppresses predictive soft-threshold session application when only restart-style application is available', () => {
    expect(evaluatePredictiveSoftSwitchSessionApplyPolicy({
      reason: 'soft_threshold',
      sessionId: 'session-1',
      applyMode: 'restart_resume',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_hot_apply_required',
    });
    expect(evaluatePredictiveSoftSwitchSessionApplyPolicy({
      reason: 'soft_threshold',
      sessionId: 'session-1',
      applyMode: 'spawn_next_turn',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_hot_apply_required',
    });
  });

  it('allows predictive soft-threshold session application when the result is hot-apply or sessionless', () => {
    expect(evaluatePredictiveSoftSwitchSessionApplyPolicy({
      reason: 'soft_threshold',
      sessionId: 'session-1',
      applyMode: 'hot_apply',
    })).toEqual({ status: 'allow' });
    expect(evaluatePredictiveSoftSwitchSessionApplyPolicy({
      reason: 'soft_threshold',
      applyMode: 'restart_resume',
    })).toEqual({ status: 'allow' });
  });
});
