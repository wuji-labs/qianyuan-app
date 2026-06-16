import { resolve } from 'node:path';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import {
  readConnectedServiceChildSelectionsFromEnv,
} from '../../connectedServiceChildEnvironment';
import { resolveConnectedServiceGroupHomeDir } from '../../homes/resolveConnectedServiceHomeDir';
import type {
  ConnectedServicePredictiveSoftSwitchLiveSessionRequirement,
} from '../../credentials/lifecycleTypes';
import type { CatalogAgentId } from '@/backends/types';

type PredictiveSoftSwitchReason =
  | 'usage_limit'
  | 'soft_threshold'
  | 'same_provider_account_exhausted'
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
	        | 'predictive_soft_switch_turn_in_flight'
	        | 'predictive_soft_switch_shared_group_auth_surface_required'
	        | 'predictive_soft_switch_session_not_tracked';
    }>;

export type PredictiveSoftSwitchSessionApplyDecision =
  | Readonly<{ status: 'allow' }>
  | Readonly<{
      status: 'suppress';
      reason: 'predictive_soft_switch_hot_apply_required';
    }>;

type PredictiveSoftSwitchContext = 'pre_spawn' | 'live_session';

function pathEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  return leftTrimmed.length > 0 && rightTrimmed.length > 0 && resolve(leftTrimmed) === resolve(rightTrimmed);
}

export function evaluatePredictiveSoftSwitchLiveSessionRequirement(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  requirement?: ConnectedServicePredictiveSoftSwitchLiveSessionRequirement | null;
  activeServerDir: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  env?: Pick<NodeJS.ProcessEnv, string> | null;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  const requirement = input.requirement ?? { kind: 'none' as const };
  if (requirement.kind === 'none') return { status: 'allow' };

  if (requirement.kind === 'shared_group_auth_surface') {
    if (!requirement.serviceIds.includes(input.serviceId)) {
      return {
        status: 'suppress',
        reason: 'predictive_soft_switch_shared_group_auth_surface_required',
      };
    }
    const selection = readConnectedServiceChildSelectionsFromEnv(input.env ?? {})
      .find((candidate) => candidate.serviceId === input.serviceId);
    if (
      selection?.kind !== 'group'
      || selection.groupId !== input.groupId
      || selection.activeProfileId !== input.activeProfileId
    ) {
      return {
        status: 'suppress',
        reason: 'predictive_soft_switch_shared_group_auth_surface_required',
      };
    }

    const expectedBase = resolveConnectedServiceGroupHomeDir({
      activeServerDir: input.activeServerDir,
      serviceId: input.serviceId,
      groupId: input.groupId,
      agentId: input.agentId,
    });
    const expectedAuthSurface = requirement.authEnvSubpath && requirement.authEnvSubpath.length > 0
      ? resolve(expectedBase, ...requirement.authEnvSubpath)
      : expectedBase;
    const actualAuthSurface = typeof requirement.authEnvKey === 'string'
      ? input.env?.[requirement.authEnvKey]
      : null;
    if (!pathEquals(actualAuthSurface, expectedAuthSurface)) {
      return {
        status: 'suppress',
        reason: 'predictive_soft_switch_shared_group_auth_surface_required',
      };
    }
  }

  return { status: 'allow' };
}

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

export function evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  hasTrackedRuntime: boolean;
}>): PredictiveSoftSwitchPolicyDecision {
  if (input.reason !== 'soft_threshold') return { status: 'allow' };
  if (input.hasTrackedRuntime) return { status: 'allow' };
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_session_not_tracked',
  };
}

export function evaluatePredictiveSoftSwitchSessionApplyPolicy(input: Readonly<{
  reason: PredictiveSoftSwitchReason;
  sessionId?: string | null;
  applyMode?: PredictiveSoftSwitchSessionApplyMode | null;
}>): PredictiveSoftSwitchSessionApplyDecision {
  if (input.reason !== 'soft_threshold' && input.reason !== 'same_provider_account_exhausted') return { status: 'allow' };
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) return { status: 'allow' };
  if (input.applyMode === undefined || input.applyMode === null || input.applyMode === 'hot_apply') {
    return { status: 'allow' };
  }
  return {
    status: 'suppress',
    reason: 'predictive_soft_switch_hot_apply_required',
  };
}
