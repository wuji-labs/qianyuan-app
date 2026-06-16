import { describe, expect, it } from 'vitest';

import {
  evaluatePredictiveSoftSwitchLiveSessionRequirement,
  evaluatePredictiveSoftSwitchPolicy,
  evaluatePredictiveSoftSwitchSessionApplyPolicy,
  evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy,
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

  it('also requires hot apply for live same-provider-account exhaustion fanout', () => {
    expect(evaluatePredictiveSoftSwitchSessionApplyPolicy({
      reason: 'same_provider_account_exhausted',
      sessionId: 'session-1',
      applyMode: 'restart_resume',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_hot_apply_required',
    });
    expect(evaluatePredictiveSoftSwitchSessionApplyPolicy({
      reason: 'same_provider_account_exhausted',
      sessionId: 'session-1',
      applyMode: 'hot_apply',
    })).toEqual({ status: 'allow' });
  });
});

describe('evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy', () => {
  it('suppresses soft-threshold live switching when the daemon cannot prove the tracked runtime', () => {
    expect(evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy({
      reason: 'soft_threshold',
      hasTrackedRuntime: false,
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_session_not_tracked',
    });
  });

  it('does not block non-predictive hard recovery when the tracked runtime is absent', () => {
    expect(evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy({
      reason: 'usage_limit',
      hasTrackedRuntime: false,
    })).toEqual({ status: 'allow' });
  });
});

describe('evaluatePredictiveSoftSwitchLiveSessionRequirement', () => {
  const requirement = {
    kind: 'shared_group_auth_surface' as const,
    serviceIds: ['claude-subscription'] as const,
    authEnvKey: 'CLAUDE_CONFIG_DIR',
    authEnvSubpath: ['claude-config'] as const,
  };

  it('allows Claude live predictive switching only when the runtime uses the shared group auth surface', () => {
    const activeServerDir = '/tmp/happier-server';
    const sharedConfigDir = [
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'main',
      'claude',
      'claude-config',
    ].join('/');

    expect(evaluatePredictiveSoftSwitchLiveSessionRequirement({
      reason: 'soft_threshold',
      requirement,
      activeServerDir,
      agentId: 'claude',
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'primary',
      env: {
        CLAUDE_CONFIG_DIR: sharedConfigDir,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'main',
          activeProfileId: 'primary',
          fallbackProfileId: 'primary',
          generation: 7,
        }]),
      },
    })).toEqual({ status: 'allow' });
  });

  it('suppresses supported live predictive switching when the session is not on the shared group auth surface', () => {
    expect(evaluatePredictiveSoftSwitchLiveSessionRequirement({
      reason: 'soft_threshold',
      requirement,
      activeServerDir: '/tmp/happier-server',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'primary',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/happier-server/daemon/connected-services/homes/claude-subscription/primary/claude/claude-config',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'primary',
        }]),
      },
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_shared_group_auth_surface_required',
    });
  });
});
