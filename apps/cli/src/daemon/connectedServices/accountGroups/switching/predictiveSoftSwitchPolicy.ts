type PredictiveSoftSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed';

type PredictiveSoftSwitchCapability = 'supported' | 'unsupported';

type PredictiveSoftSwitchTurnState = Readonly<{
  inFlight: boolean;
}>;

type PredictiveSoftSwitchSessionApplyMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

export type PredictiveSoftSwitchPolicyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason:
        | 'predictive_soft_switch_restart_required'
        | 'predictive_soft_switch_turn_in_flight';
	    }>;

export type PredictiveSoftSwitchSessionApplyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason: 'predictive_soft_switch_hot_apply_required';
    }>;

type PredictiveSoftSwitchContext = 'pre_spawn' | 'live_session';

export function evaluatePredictiveSoftSwitchPolicy(input: Readonly<{
  context: PredictiveSoftSwitchContext;
  reason: PredictiveSoftSwitchReason;
  predictiveSoftSwitchMode: PredictiveSoftSwitchCapability;
  turnState?: PredictiveSoftSwitchTurnState | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  // RD-QUO-10: the restart-required suppression only applies to LIVE sessions —
  // applying a predictive switch there would force a hot apply or a restart. At
  // pre-spawn time there is no live runtime: the new process materializes the
  // freshly selected member, so restart-only providers may still rotate below
  // the soft threshold (plan-6 pre-turn contract).
  if (input.context === 'live_session' && input.predictiveSoftSwitchMode !== 'supported') {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    };
  }
  if (input.turnState?.inFlight === true) {
    return {
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    };
  }
  return { status: 'allow' };
}

export function evaluatePredictiveSoftSwitchSessionApplyPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  sessionId?: string | null;
  applyMode?: PredictiveSoftSwitchSessionApplyMode | null;
}>): PredictiveSoftSwitchSessionApplyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) return { status: 'allow' };
  if (input.applyMode === undefined || input.applyMode === null || input.applyMode === 'hot_apply') {
    return { status: 'allow' };
  }
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_hot_apply_required',
  };
}
